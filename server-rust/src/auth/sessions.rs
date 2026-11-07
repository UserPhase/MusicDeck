//! # Stateful & Stateless Session Management (`auth::sessions`)
//!
//! Ports `server/src/auth/sessions.ts` and `server/src/users/users.ts` (user projection)
//! to Rust with dual SQLite persistence and an in-memory `Arc<RwLock<HashMap<String, CachedSession>>>`
//! read-through/write-through cache, plus JWT (`UserClaims`) token signing and verification.
//!
//! ## Session Lifecycle Rules
//! 1. **Persistent vs. Ephemeral TTL**:
//!    - When `remember_me == true` (default), sessions have a `30`-day TTL (`SESSION_DAYS`)
//!      and emit an HTTP `Expires` cookie attribute.
//!    - When `remember_me == false`, sessions have a `24`-hour TTL (`EPHEMERAL_SESSION_HOURS`)
//!      and omit the `Expires` cookie attribute so the browser discards the cookie at session end.
//! 2. **Sliding Expiration Window ([`SessionStore::refresh_session_if_remembered`])**:
//!    - Ephemeral sessions (`expires_at - created_at <= 24h + 60s`) are never extended.
//!    - Persistent sessions slide their `expires_at` forward to `now + 30 days` on `/api/auth/session`
//!      checks and update both SQLite and the in-memory cache.
//! 3. **Transactional Revocation ([`revoke_user_sessions_tx`])**:
//!    - Password changes, admin password resets, and account disables delete matching rows
//!      from `sessions` inside the caller's SQLite transaction, then invalidate the in-memory
//!      cache and broadcast a [`SessionEvent`] after commit.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use http::HeaderMap;
use http::header::{COOKIE, HeaderValue, SET_COOKIE};
use jsonwebtoken::{DecodingKey, EncodingKey, Header as JwtHeader, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use tokio::sync::RwLock;

use crate::auth::AuthError;
use crate::auth::events::{SessionEvent, SessionEventBus};
use crate::db::{DbPool, create_id};

/// Canonical session cookie name (`"musicdeck_session"`).
pub const SESSION_COOKIE: &str = "musicdeck_session";

/// Sliding TTL in days for persistent (`rememberMe = true`) sessions.
pub const SESSION_DAYS: i64 = 30;

/// Fixed TTL in hours for ephemeral (`rememberMe = false`) browser sessions.
pub const EPHEMERAL_SESSION_HOURS: i64 = 24;

/// Role assigned to a MusicDeck user account.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    /// Full server administrator.
    Admin,
    /// Standard listener/user account.
    #[default]
    User,
}

impl UserRole {
    /// Parses a database role string (`"admin"` or `"user"`).
    #[must_use]
    pub fn parse_str(raw: &str) -> Self {
        if raw.trim().eq_ignore_ascii_case("admin") {
            Self::Admin
        } else {
            Self::User
        }
    }

    /// Returns the canonical database string (`"admin"` or `"user"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::User => "user",
        }
    }
}

/// Public user projection matching `toPublicUser(row)` in `server/src/users/users.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    /// Stable user ID (`user_<24 chars>`).
    pub id: String,
    /// Unique login username.
    pub username: String,
    /// Display name shown in the UI.
    pub display_name: String,
    /// Account role (`admin` or `user`).
    pub role: UserRole,
    /// Optional preset avatar identifier.
    pub avatar_ref: Option<String>,
    /// Optional URL to a user-uploaded custom avatar image.
    pub avatar_url: Option<String>,
    /// Whether the user account is disabled.
    pub disabled: bool,
    /// Whether this user is the protected master administrator.
    pub is_master_admin: bool,
    /// Whether the user is allowed to query external catalog providers.
    pub external_search_enabled: bool,
    /// Whether the user is allowed to stream external preview audio.
    pub external_playback_enabled: bool,
    /// ISO-8601 timestamp of the most recent login.
    pub last_login_at: Option<String>,
    /// ISO-8601 timestamp of the most recent track playback.
    pub last_playback_at: Option<String>,
    /// ISO-8601 account creation timestamp.
    pub created_at: String,
    /// ISO-8601 account update timestamp.
    pub updated_at: String,
}

impl SessionUser {
    /// Returns `true` if this user holds the `admin` role.
    #[must_use]
    pub const fn is_admin(&self) -> bool {
        matches!(self.role, UserRole::Admin)
    }
}

/// Active session record stored in the `sessions` SQLite table and cached in memory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Unique session token ID (`session_<24 chars>`).
    pub id: String,
    /// Owning user ID.
    pub user_id: String,
    /// Session creation timestamp (UTC).
    pub created_at: DateTime<Utc>,
    /// Session expiration timestamp (UTC).
    pub expires_at: DateTime<Utc>,
    /// `true` when created with `rememberMe = true` (30-day sliding TTL).
    pub persistent: bool,
}

/// Signed JWT / stateless token claims (`UserClaims`) for Bearer token authentication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserClaims {
    /// Subject (`user.id`).
    pub sub: String,
    /// Backing session ID (`session.id`).
    pub sid: String,
    /// Role claim (`admin` or `user`).
    pub role: UserRole,
    /// Issued-at UNIX timestamp (seconds).
    pub iat: i64,
    /// Expiration UNIX timestamp (seconds).
    pub exp: i64,
}

#[derive(Debug, Clone)]
struct CachedSessionEntry {
    session: Session,
    user: SessionUser,
}

/// Thread-safe session manager combining SQLite durability with an in-memory
/// `Arc<RwLock<HashMap<String, CachedSessionEntry>>>` cache and [`SessionEventBus`].
#[derive(Debug, Clone)]
pub struct SessionStore {
    db: DbPool,
    cache: Arc<RwLock<HashMap<String, CachedSessionEntry>>>,
    events: SessionEventBus,
    jwt_secret: Arc<String>,
}

impl SessionStore {
    /// Creates a new [`SessionStore`] backed by `db` and `jwt_secret`.
    #[must_use]
    pub fn new(db: DbPool, jwt_secret: impl Into<String>) -> Self {
        Self {
            db,
            cache: Arc::new(RwLock::new(HashMap::new())),
            events: SessionEventBus::default(),
            jwt_secret: Arc::new(jwt_secret.into()),
        }
    }

    /// Returns a reference to the [`SessionEventBus`].
    #[must_use]
    pub const fn events(&self) -> &SessionEventBus {
        &self.events
    }

    /// Returns a reference to the underlying [`DbPool`].
    #[must_use]
    pub const fn db(&self) -> &DbPool {
        &self.db
    }

    /// Creates a new session in SQLite for `user_id` (`remember_me = true` -> 30d, `false` -> 24h).
    pub async fn create_session(
        &self,
        user_id: &str,
        remember_me: bool,
    ) -> Result<Session, AuthError> {
        let mut conn = self.db.inner().acquire().await?;
        create_session_on_conn(&mut conn, user_id, remember_me).await
    }

    /// Signs a stateless/hybrid JWT [`UserClaims`] token bound to `session` and `role`.
    pub fn sign_jwt(&self, session: &Session, role: UserRole) -> Result<String, AuthError> {
        let claims = UserClaims {
            sub: session.user_id.clone(),
            sid: session.id.clone(),
            role,
            iat: session.created_at.timestamp(),
            exp: session.expires_at.timestamp(),
        };
        encode(
            &JwtHeader::default(),
            &claims,
            &EncodingKey::from_secret(self.jwt_secret.as_bytes()),
        )
        .map_err(|err| AuthError::Crypto(format!("JWT signing failed: {err}")))
    }

    /// Verifies a signed JWT Bearer token and returns its [`UserClaims`].
    pub fn verify_jwt(&self, token: &str) -> Result<UserClaims, AuthError> {
        let token_data = decode::<UserClaims>(
            token,
            &DecodingKey::from_secret(self.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|err| AuthError::Unauthorized(format!("Invalid or expired token: {err}")))?;
        Ok(token_data.claims)
    }

    /// Resolves the active [`SessionUser`] for `session_id`, checking the in-memory cache
    /// and verifying against SQLite that the session has not expired and the user is not disabled.
    pub async fn get_session_user_by_id(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionUser>, AuthError> {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let now = Utc::now();
        let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let row = sqlx::query(
            r"
            SELECT
              users.*,
              sessions.created_at AS session_created_at,
              sessions.expires_at AS session_expires_at,
              (SELECT MAX(played_at) FROM recently_played WHERE recently_played.user_id = users.id) AS last_playback_at
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.id = ?
              AND sessions.expires_at > ?
              AND users.disabled = 0;
            ",
        )
        .bind(trimmed)
        .bind(&now_iso)
        .fetch_optional(self.db.inner())
        .await?;

        let Some(row) = row else {
            self.cache.write().await.remove(trimmed);
            return Ok(None);
        };

        let user = row_to_session_user(&row)?;
        let created_str: String = row.try_get("session_created_at")?;
        let expires_str: String = row.try_get("session_expires_at")?;
        let created_at = DateTime::parse_from_rfc3339(&created_str)
            .map_or(now, |dt| dt.with_timezone(&Utc));
        let expires_at = DateTime::parse_from_rfc3339(&expires_str)
            .map_or(now, |dt| dt.with_timezone(&Utc));
        let persistent = (expires_at - created_at) > Duration::hours(EPHEMERAL_SESSION_HOURS) + Duration::minutes(1);

        let session = Session {
            id: trimmed.to_owned(),
            user_id: user.id.clone(),
            created_at,
            expires_at,
            persistent,
        };

        self.cache.write().await.insert(
            trimmed.to_owned(),
            CachedSessionEntry {
                session,
                user: user.clone(),
            },
        );

        Ok(Some(user))
    }

    /// Extends `expires_at` by 30 days if `session_id` belongs to a persistent (`rememberMe = true`)
    /// session, returning the updated `Set-Cookie` header value when refreshed.
    ///
    /// Ephemeral 24-hour sessions are left untouched, matching `refreshSessionIfRemembered`
    /// in `server/src/auth/sessions.ts`.
    pub async fn refresh_session_if_remembered(
        &self,
        session_id: &str,
        secure_cookies: bool,
    ) -> Result<Option<HeaderValue>, AuthError> {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let row = sqlx::query("SELECT created_at, expires_at FROM sessions WHERE id = ?;")
            .bind(trimmed)
            .fetch_optional(self.db.inner())
            .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let created_str: String = row.try_get("created_at")?;
        let expires_str: String = row.try_get("expires_at")?;
        let Ok(created_dt) = DateTime::parse_from_rfc3339(&created_str) else {
            return Ok(None);
        };
        let Ok(expires_dt) = DateTime::parse_from_rfc3339(&expires_str) else {
            return Ok(None);
        };

        let ephemeral_threshold =
            Duration::hours(EPHEMERAL_SESSION_HOURS) + Duration::seconds(60);
        if (expires_dt - created_dt) <= ephemeral_threshold {
            return Ok(None);
        }

        let next_expires_at = Utc::now() + Duration::days(SESSION_DAYS);
        let next_expires_iso =
            next_expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        sqlx::query("UPDATE sessions SET expires_at = ? WHERE id = ?;")
            .bind(&next_expires_iso)
            .bind(trimmed)
            .execute(self.db.inner())
            .await?;

        if let Some(entry) = self.cache.write().await.get_mut(trimmed) {
            entry.session.expires_at = next_expires_at;
        }

        Ok(Some(format_set_session_cookie(
            trimmed,
            next_expires_at,
            secure_cookies,
            true,
        )))
    }

    /// Deletes a single session by ID from SQLite and the in-memory cache, then notifies
    /// [`SessionEventBus`] subscribers.
    pub async fn delete_session(&self, session_id: Option<&str>) -> Result<(), AuthError> {
        let Some(raw_id) = session_id else {
            return Ok(());
        };
        let trimmed = raw_id.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        sqlx::query("DELETE FROM sessions WHERE id = ?;")
            .bind(trimmed)
            .execute(self.db.inner())
            .await?;

        self.cache.write().await.remove(trimmed);
        self.events.publish(SessionEvent::SessionRevoked {
            session_id: trimmed.to_owned(),
        });
        Ok(())
    }

    /// Invalidates cached sessions for `user_id` (optionally preserving `except_session_id`)
    /// and broadcasts a [`SessionEvent::UserSessionsRevoked`] notification.
    ///
    /// Call this **after** the SQLite transaction running [`revoke_user_sessions_tx`] commits.
    pub async fn notify_user_sessions_revoked(
        &self,
        user_id: &str,
        except_session_id: Option<&str>,
    ) {
        {
            let mut guard = self.cache.write().await;
            guard.retain(|sid, entry| {
                entry.user.id != user_id || except_session_id == Some(sid.as_str())
            });
        }
        self.events.publish(SessionEvent::UserSessionsRevoked {
            user_id: user_id.to_owned(),
            except_session_id: except_session_id.map(str::to_owned),
        });
    }
}

/// Inserts a new row into `sessions` on an existing [`SqliteConnection`] or transaction.
pub async fn create_session_on_conn(
    conn: &mut SqliteConnection,
    user_id: &str,
    remember_me: bool,
) -> Result<Session, AuthError> {
    let id = create_id("session");
    let created_at = Utc::now();
    let ttl = if remember_me {
        Duration::days(SESSION_DAYS)
    } else {
        Duration::hours(EPHEMERAL_SESSION_HOURS)
    };
    let expires_at = created_at + ttl;

    let created_iso = created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let expires_iso = expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    sqlx::query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?);")
        .bind(&id)
        .bind(user_id)
        .bind(&created_iso)
        .bind(&expires_iso)
        .execute(&mut *conn)
        .await?;

    Ok(Session {
        id,
        user_id: user_id.to_owned(),
        created_at,
        expires_at,
        persistent: remember_me,
    })
}

/// Transactional helper deleting all sessions for `user_id` except an optional
/// `except_session_id`, matching `revokeUserSessions` in `server/src/auth/sessions.ts`.
pub async fn revoke_user_sessions_tx(
    conn: &mut SqliteConnection,
    user_id: &str,
    except_session_id: Option<&str>,
) -> Result<u64, AuthError> {
    let res = sqlx::query(
        "DELETE FROM sessions WHERE user_id = ? AND (? IS NULL OR id != ?);",
    )
    .bind(user_id)
    .bind(except_session_id)
    .bind(except_session_id)
    .execute(&mut *conn)
    .await?;

    Ok(res.rows_affected())
}

/// Maps a `users` SQLite row into a [`SessionUser`] matching `toPublicUser(row)`
/// in `server/src/users/users.ts`.
pub fn row_to_session_user(row: &sqlx::sqlite::SqliteRow) -> Result<SessionUser, AuthError> {
    let id: String = row.try_get("id")?;
    let avatar_updated_at: Option<String> = row.try_get("avatar_updated_at").ok().flatten();
    let avatar_url = avatar_updated_at
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|ts| format!("/api/users/{id}/avatar?v={ts}"));

    let role_str: String = row.try_get("role")?;
    let disabled_int: i64 = row.try_get("disabled").unwrap_or(0);
    let is_master_int: i64 = row.try_get("is_master").unwrap_or(0);
    let ext_search_int: Option<i64> = row.try_get("external_search_enabled").ok();
    let ext_playback_int: i64 = row.try_get("external_playback_enabled").unwrap_or(0);

    Ok(SessionUser {
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

/// Extracts the `musicdeck_session` cookie value from an HTTP [`HeaderMap`].
#[must_use]
pub fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    for cookie_header in headers.get_all(COOKIE) {
        let Ok(raw) = cookie_header.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            let trimmed = pair.trim();
            if let Some((name, value)) = trimmed.split_once('=')
                && name.trim() == SESSION_COOKIE
            {
                let v = value.trim();
                if !v.is_empty() {
                    return Some(v.to_owned());
                }
            }
        }
    }
    None
}

/// Formats a `Set-Cookie` [`HeaderValue`] for `musicdeck_session` matching `setSessionCookie`
/// in `server/src/auth/sessions.ts`.
#[must_use]
pub fn format_set_session_cookie(
    session_id: &str,
    expires_at: DateTime<Utc>,
    secure: bool,
    persistent: bool,
) -> HeaderValue {
    let mut parts = vec![
        format!("{SESSION_COOKIE}={session_id}"),
        String::from("Path=/"),
        String::from("HttpOnly"),
        String::from("SameSite=Lax"),
    ];
    if secure {
        parts.push(String::from("Secure"));
    }
    if persistent {
        parts.push(format!(
            "Expires={}",
            expires_at.format("%a, %d %b %Y %H:%M:%S GMT")
        ));
    }
    let joined = parts.join("; ");
    HeaderValue::from_str(&joined)
        .unwrap_or_else(|_| HeaderValue::from_static("musicdeck_session=; Path=/; HttpOnly"))
}

/// Formats a `Set-Cookie` [`HeaderValue`] that clears `musicdeck_session` in the browser.
#[must_use]
pub fn format_clear_session_cookie(secure: bool) -> HeaderValue {
    let mut parts = vec![
        format!("{SESSION_COOKIE}="),
        String::from("Path=/"),
        String::from("HttpOnly"),
        String::from("SameSite=Lax"),
        String::from("Max-Age=0"),
        String::from("Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
    ];
    if secure {
        parts.push(String::from("Secure"));
    }
    let joined = parts.join("; ");
    HeaderValue::from_str(&joined).unwrap_or_else(|_| {
        HeaderValue::from_static("musicdeck_session=; Path=/; HttpOnly; Max-Age=0")
    })
}

/// Helper to insert a `Set-Cookie` header onto a [`HeaderMap`].
pub fn append_set_cookie(headers: &mut HeaderMap, cookie_value: HeaderValue) {
    headers.append(SET_COOKIE, cookie_value);
}
