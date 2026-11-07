//! # User Administration & Profile Persistence (`users`)
//!
//! Complete Rust port of `server/src/users/users.ts`.
//!
//! ## Core Invariants
//! 1. **Master Administrator Protection (`ensure_master_admin` & [`check_update_guard`])**:
//!    - Guarantees that whenever at least one `admin` exists, the oldest admin account
//!      carries `is_master = 1`.
//!    - Prevents any administrator from changing the master administrator's `role`,
//!      `disabled` status, `external_search_enabled`, or `external_playback_enabled` flags,
//!      or deleting the master account (`MASTER_ADMIN_PROTECTED`).
//!    - Prevents deputy administrators from resetting the master administrator's password.
//! 2. **Self-Lockout Prevention (`SELF_LOCKOUT`)**:
//!    - Administrators cannot delete, disable, or demote (`role = "user"`) their own account.
//! 3. **Transactional Session Invalidations**:
//!    - Whenever [`update_user`] modifies a user's `password` or sets `disabled = true`,
//!      [`revoke_user_sessions_tx`] executes inside the **same** SQLite transaction so
//!      a failure in session deletion rolls back the user update atomically.
//!    - Only after the transaction commits does the service notify [`SessionStore`]
//!      to evict cached sessions and broadcast a real-time SSE revocation event.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Row, SqliteConnection};
use thiserror::Error;

use crate::auth::{
    AuthError, SessionStore, SessionUser, UserRole, hash_password, revoke_user_sessions_tx,
};
use crate::avatars::avatar_url_for;
use crate::db::{DbPool, create_id};

/// Canonical public user model (`User`), identical to [`SessionUser`].
pub type User = SessionUser;

/// Fine-grained user permission flags managed by administrators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPermissionFlags {
    /// Account role (`admin` or `user`).
    pub role: UserRole,
    /// Whether the user account is disabled.
    pub disabled: bool,
    /// Whether the user is the protected master administrator.
    pub is_master_admin: bool,
    /// Whether the user may query external catalog providers.
    pub external_search_enabled: bool,
    /// Whether the user may play external preview streams.
    pub external_playback_enabled: bool,
}

/// Input payload for `POST /api/users` (`createUser`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserPayload {
    /// Unique login username (non-empty).
    pub username: String,
    /// Initial plaintext password ($\ge 8$ characters).
    pub password: String,
    /// Optional display name (defaults to `username`).
    pub display_name: Option<String>,
    /// Optional role (defaults to `UserRole::User`).
    pub role: Option<UserRole>,
}

/// Input payload for `PATCH /api/users/:userId` (`updateUser`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdatePayload {
    /// Updated display name.
    pub display_name: Option<String>,
    /// Updated preset avatar reference (`Some(Some("..."))` sets, `Some(None)` clears, `None` leaves unchanged).
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub avatar_ref: Option<Option<String>>,
    /// Updated account role (`admin` or `user`).
    pub role: Option<UserRole>,
    /// Updated disabled flag.
    pub disabled: Option<bool>,
    /// Updated external catalog search permission.
    pub external_search_enabled: Option<bool>,
    /// Updated external preview playback permission.
    pub external_playback_enabled: Option<bool>,
    /// Optional replacement password ($\ge 8$ characters).
    pub password: Option<String>,
}

/// Input payload for `PATCH /api/users/me` (`updateOwnProfile`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateOwnProfilePayload {
    /// Updated display name.
    pub display_name: Option<String>,
    /// Updated preset avatar reference.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub avatar_ref: Option<Option<String>>,
}

/// Raw database row including `password_hash` for internal authentication checks.
#[derive(Debug, Clone)]
pub struct StoredUserCredentials {
    /// User record ID.
    pub id: String,
    /// Username.
    pub username: String,
    /// Stored password hash (`$argon2id$...` or `$2b$...`).
    pub password_hash: String,
    /// Whether the account is disabled.
    pub disabled: bool,
    /// Public user projection.
    pub public_user: User,
}

/// Error taxonomy for user management and avatar operations.
#[derive(Debug, Error)]
pub enum UserError {
    /// Validation failure on request fields (`400 Bad Request`).
    #[error("{0}")]
    Validation(String),

    /// Invalid or oversized avatar image (`400 Bad Request`, `VALIDATION_ERROR`).
    #[error("{0}")]
    InvalidAvatar(String),

    /// Target user or avatar does not exist (`404 Not Found`).
    #[error("{0}")]
    NotFound(String),

    /// Username collision or constraint conflict (`409 Conflict`).
    #[error("{0}")]
    Conflict(String),

    /// Master admin or self-lockout guard violation (`403 Forbidden`).
    #[error("{message}")]
    GuardViolation {
        /// Machine-readable error code (`MASTER_ADMIN_PROTECTED` or `SELF_LOCKOUT`).
        code: &'static str,
        /// Human-readable explanation.
        message: String,
    },

    /// Password hashing error.
    #[error(transparent)]
    Auth(#[from] AuthError),

    /// Database error.
    #[error("User database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

const USER_WITH_ACTIVITY_SELECT: &str = r"
  SELECT users.*,
    (SELECT MAX(played_at) FROM recently_played WHERE recently_played.user_id = users.id) AS last_playback_at
  FROM users
";

/// Maps a `users` SQLite row into a public [`User`] struct.
pub fn to_public_user(row: &sqlx::sqlite::SqliteRow) -> Result<User, UserError> {
    let id: String = row.try_get("id")?;
    let avatar_updated_at: Option<String> = row.try_get("avatar_updated_at").ok().flatten();
    let avatar_url = avatar_url_for(&id, avatar_updated_at.as_deref());
    let role_str: String = row.try_get("role")?;

    let disabled_int: i64 = row.try_get("disabled").unwrap_or(0);
    let is_master_int: i64 = row.try_get("is_master").unwrap_or(0);
    let ext_search_int: Option<i64> = row.try_get("external_search_enabled").ok();
    let ext_playback_int: i64 = row.try_get("external_playback_enabled").unwrap_or(0);

    Ok(User {
        id,
        username: row.try_get("username")?,
        display_name: row.try_get("display_name")?,
        role: UserRole::parse_str(&role_str),
        avatar_ref: row
            .try_get::<Option<String>, _>("avatar_ref")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
        avatar_url,
        disabled: disabled_int != 0,
        is_master_admin: is_master_int != 0,
        external_search_enabled: ext_search_int.is_none_or(|v| v != 0),
        external_playback_enabled: ext_playback_int != 0,
        last_login_at: row
            .try_get::<Option<String>, _>("last_login_at")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
        last_playback_at: row
            .try_get::<Option<String>, _>("last_playback_at")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Fetches a user's stored credentials and public projection by `username`.
pub async fn get_user_by_username(
    pool: &DbPool,
    username: &str,
) -> Result<Option<StoredUserCredentials>, UserError> {
    let query = format!("{USER_WITH_ACTIVITY_SELECT} WHERE users.username = ?;");
    let row = sqlx::query(&query)
        .bind(username)
        .fetch_optional(pool.inner())
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let public_user = to_public_user(&row)?;
    Ok(Some(StoredUserCredentials {
        id: public_user.id.clone(),
        username: public_user.username.clone(),
        password_hash: row.try_get("password_hash")?,
        disabled: public_user.disabled,
        public_user,
    }))
}

/// Fetches a public [`User`] by `user_id`.
pub async fn get_user_by_id(pool: &DbPool, user_id: &str) -> Result<Option<User>, UserError> {
    let query = format!("{USER_WITH_ACTIVITY_SELECT} WHERE users.id = ?;");
    let row = sqlx::query(&query)
        .bind(user_id)
        .fetch_optional(pool.inner())
        .await?;

    row.as_ref().map(to_public_user).transpose()
}

/// Lists all users ordered by `username ASC`.
pub async fn list_users(pool: &DbPool) -> Result<Vec<User>, UserError> {
    let query = format!("{USER_WITH_ACTIVITY_SELECT} ORDER BY users.username ASC;");
    let rows = sqlx::query(&query).fetch_all(pool.inner()).await?;
    rows.iter().map(to_public_user).collect()
}

/// Ensures that the oldest administrator carries `is_master = 1` whenever no user
/// currently holds the master flag.
pub async fn ensure_master_admin_on_conn(conn: &mut SqliteConnection) -> Result<(), UserError> {
    sqlx::query(
        r"
        UPDATE users SET is_master = 1
        WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM users WHERE is_master = 1);
        ",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Updates `users.last_login_at` and returns the recorded ISO-8601 timestamp.
pub async fn record_login_on_conn(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> Result<String, UserError> {
    let logged_in_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?;")
        .bind(&logged_in_at)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    Ok(logged_in_at)
}

/// Creates a new user account, hashes their password with `Argon2id`, and ensures
/// the master administrator invariant holds.
pub async fn create_user(pool: &DbPool, input: CreateUserPayload) -> Result<User, UserError> {
    let username = input.username.trim();
    if username.is_empty() || input.password.chars().count() < 8 {
        return Err(UserError::Validation(String::from("Invalid user request")));
    }

    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(username);
    let role = input.role.unwrap_or(UserRole::User);
    let password_hash = hash_password(&input.password).await?;
    let id = create_id("user");
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    let insert_res = sqlx::query(
        r"
        INSERT INTO users
          (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?);
        ",
    )
    .bind(&id)
    .bind(username)
    .bind(&password_hash)
    .bind(display_name)
    .bind(role.as_str())
    .bind(&now_iso)
    .bind(&now_iso)
    .execute(&mut *tx)
    .await;

    if let Err(err) = insert_res {
        let _ = tx.rollback().await;
        return Err(UserError::Conflict(format!(
            "User could not be created: {err}"
        )));
    }

    ensure_master_admin_on_conn(&mut tx).await?;
    tx.commit().await?;

    get_user_by_id(pool, &id)
        .await?
        .ok_or_else(|| UserError::NotFound(String::from("User not found")))
}

/// Enforces master-admin and self-lockout guardrails prior to executing [`update_user`],
/// matching `getUpdateGuardError` in `server/src/routes/user-routes.ts`.
pub fn check_update_guard(
    actor: &User,
    target: &User,
    update: &UserUpdatePayload,
) -> Result<(), UserError> {
    if target.is_master_admin {
        let changes_protected = update.role.is_some_and(|r| r != target.role)
            || update.disabled.is_some_and(|d| d != target.disabled)
            || update
                .external_search_enabled
                .is_some_and(|s| s != target.external_search_enabled)
            || update
                .external_playback_enabled
                .is_some_and(|p| p != target.external_playback_enabled);

        if changes_protected {
            return Err(UserError::GuardViolation {
                code: "MASTER_ADMIN_PROTECTED",
                message: String::from(
                    "The master administrator's role, status, and permissions cannot be changed",
                ),
            });
        }

        if update.password.is_some() && actor.id != target.id {
            return Err(UserError::GuardViolation {
                code: "MASTER_ADMIN_PROTECTED",
                message: String::from(
                    "Only the master administrator can change their own password",
                ),
            });
        }
    }

    if actor.id == target.id
        && (update.disabled == Some(true) || update.role == Some(UserRole::User))
    {
        return Err(UserError::GuardViolation {
            code: "SELF_LOCKOUT",
            message: String::from("You cannot disable or demote your own account"),
        });
    }

    Ok(())
}

/// Enforces master-admin and self-lockout guardrails prior to deleting a user.
pub fn check_delete_guard(actor: &User, target: &User) -> Result<(), UserError> {
    if target.is_master_admin {
        return Err(UserError::GuardViolation {
            code: "MASTER_ADMIN_PROTECTED",
            message: String::from("The master administrator cannot be deleted"),
        });
    }

    if actor.id == target.id {
        return Err(UserError::GuardViolation {
            code: "SELF_LOCKOUT",
            message: String::from("You cannot delete your own account"),
        });
    }

    Ok(())
}

/// Updates a user account inside an atomic SQLite transaction, revoking active sessions
/// if the password changed or the account was disabled, and notifying [`SessionStore`]
/// after commit.
pub async fn update_user(
    pool: &DbPool,
    sessions: Option<&SessionStore>,
    user_id: &str,
    input: UserUpdatePayload,
) -> Result<Option<User>, UserError> {
    if let Some(ref dn) = input.display_name
        && dn.trim().is_empty()
    {
        return Err(UserError::Validation(String::from(
            "Invalid user update request",
        )));
    }
    if let Some(Some(ref av)) = input.avatar_ref
        && av.trim().is_empty()
    {
        return Err(UserError::Validation(String::from(
            "Invalid user update request",
        )));
    }
    if let Some(ref pw) = input.password
        && pw.chars().count() < 8
    {
        return Err(UserError::Validation(String::from(
            "Invalid user update request",
        )));
    }

    let new_password_hash = match input.password {
        Some(ref pw) => Some(hash_password(pw).await?),
        None => None,
    };

    let should_revoke_sessions = new_password_hash.is_some() || input.disabled == Some(true);
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    let existing_row = sqlx::query("SELECT * FROM users WHERE id = ?;")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;

    let Some(existing_row) = existing_row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let current_display_name: String = existing_row.try_get("display_name")?;
    let current_avatar_ref: Option<String> = existing_row.try_get("avatar_ref")?;
    let current_role: String = existing_row.try_get("role")?;
    let current_disabled: i64 = existing_row.try_get("disabled")?;
    let current_ext_search: i64 = existing_row
        .try_get("external_search_enabled")
        .unwrap_or(1);
    let current_ext_playback: i64 = existing_row
        .try_get("external_playback_enabled")
        .unwrap_or(0);
    let current_password_hash: String = existing_row.try_get("password_hash")?;

    let next_display_name = input.display_name.unwrap_or(current_display_name);
    let next_avatar_ref = match input.avatar_ref {
        Some(explicit) => explicit,
        None => current_avatar_ref,
    };
    let next_role = input
        .role
        .map_or(current_role, |r| r.as_str().to_owned());
    let next_disabled = input
        .disabled
        .map_or(current_disabled, i64::from);
    let next_ext_search = input
        .external_search_enabled
        .map_or(current_ext_search, i64::from);
    let next_ext_playback = input
        .external_playback_enabled
        .map_or(current_ext_playback, i64::from);
    let next_password_hash = new_password_hash.unwrap_or(current_password_hash);

    sqlx::query(
        r"
        UPDATE users
        SET display_name = ?,
            avatar_ref = ?,
            role = ?,
            disabled = ?,
            external_search_enabled = ?,
            external_playback_enabled = ?,
            password_hash = ?,
            updated_at = ?
        WHERE id = ?;
        ",
    )
    .bind(&next_display_name)
    .bind(&next_avatar_ref)
    .bind(&next_role)
    .bind(next_disabled)
    .bind(next_ext_search)
    .bind(next_ext_playback)
    .bind(&next_password_hash)
    .bind(&now_iso)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    if should_revoke_sessions {
        revoke_user_sessions_tx(&mut tx, user_id, None).await?;
    }

    ensure_master_admin_on_conn(&mut tx).await?;
    tx.commit().await?;

    if let Some(store) = sessions {
        if should_revoke_sessions {
            store.notify_user_sessions_revoked(user_id, None).await;
        } else {
            store.events().notify_changes();
        }
    }

    get_user_by_id(pool, user_id).await
}

/// Updates the authenticated user's own `display_name` and/or `avatar_ref`.
pub async fn update_own_profile(
    pool: &DbPool,
    user_id: &str,
    input: UpdateOwnProfilePayload,
) -> Result<Option<User>, UserError> {
    if let Some(ref dn) = input.display_name
        && dn.trim().is_empty()
    {
        return Err(UserError::Validation(String::from(
            "Invalid profile update request",
        )));
    }
    if let Some(Some(ref av)) = input.avatar_ref
        && av.trim().is_empty()
    {
        return Err(UserError::Validation(String::from(
            "Invalid profile update request",
        )));
    }

    let existing_row = sqlx::query("SELECT display_name, avatar_ref FROM users WHERE id = ?;")
        .bind(user_id)
        .fetch_optional(pool.inner())
        .await?;

    let Some(existing_row) = existing_row else {
        return Ok(None);
    };

    let current_display_name: String = existing_row.try_get("display_name")?;
    let current_avatar_ref: Option<String> = existing_row.try_get("avatar_ref")?;

    let next_display_name = input.display_name.unwrap_or(current_display_name);
    let next_avatar_ref = match input.avatar_ref {
        Some(explicit) => explicit,
        None => current_avatar_ref,
    };
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    sqlx::query("UPDATE users SET display_name = ?, avatar_ref = ?, updated_at = ? WHERE id = ?;")
        .bind(&next_display_name)
        .bind(&next_avatar_ref)
        .bind(&now_iso)
        .bind(user_id)
        .execute(pool.inner())
        .await?;

    get_user_by_id(pool, user_id).await
}

/// Deletes a user account from SQLite (cascading to sessions and user-owned records)
/// and notifies [`SessionStore`] subscribers after commit.
pub async fn delete_user(
    pool: &DbPool,
    sessions: Option<&SessionStore>,
    user_id: &str,
) -> Result<bool, UserError> {
    let res = sqlx::query("DELETE FROM users WHERE id = ?;")
        .bind(user_id)
        .execute(pool.inner())
        .await?;

    let deleted = res.rows_affected() > 0;
    if deleted && let Some(store) = sessions {
        store.notify_user_sessions_revoked(user_id, None).await;
    }

    Ok(deleted)
}
