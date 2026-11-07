//! # Schema Migration Engine, Seeding & Legacy Backfills (`db::migrations`)
//!
//! Complete Rust port of `server/src/db/migrations.ts`.
//!
//! ## Key Capabilities
//! 1. **50-Step Sequential Migration Engine ([`run_migrations`])**:
//!    - Maintains the `schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
//!      ledger table.
//!    - Supports full initialization (`up_to = None`) and targeted version roll-forward
//!      (`up_to = Some(target_version)`) for testing legacy database upgrade paths.
//!    - Wraps every individual migration step in an atomic SQLite transaction (`BEGIN` /
//!      `COMMIT` / `ROLLBACK`), re-checking `schema_migrations` inside the write lock.
//!    - Handles both declarative multi-statement SQL migrations (1..=38, 40..=50) and
//!      procedural data-transforming migrations (migration 39: `upgrade-legacy-smart-playlist-projection`).
//! 2. **Transactional Initial Seeding ([`seed_initial_data`])**:
//!    - Seeds `roles` (`admin`, `user`) and the primary `backend_connections` row matching
//!      `config.backend` (`navidrome` or `jellyfin`).
//!    - Scrubs legacy plaintext Navidrome credentials from `backend_connections.config_json`
//!      when environment credentials are active.
//!    - Hashes `MUSICDECK_ADMIN_PASSWORD` with `bcrypt` (cost = 12) on Tokio's blocking pool
//!      to bootstrap the initial master administrator when `users` is empty.
//! 3. **Idempotent Legacy Backfills ([`backfill_connection_scope`], [`backfill_library_identities`])**:
//!    - Remaps placeholder `'env-navidrome'` connection references to the active primary
//!      connection ID across `favorites`, `recently_played`, `playlist_ownership`, and `playlists`.
//!    - Assigns stable `md_<24-char nanoid>` library identities in `library_items` and
//!      `library_item_sources` inside a single atomic transaction.

use std::collections::HashSet;

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, Row, SqliteConnection};

use crate::config::{AppConfig, MusicBackendKind};
use crate::db::migrations_sql::{RAW_MIGRATIONS, SMART_PLAYLIST_ACTIVITY_SCHEMA_BASE};
use crate::db::{DbError, DbPool, protect_database_files};

/// Total number of sequential migrations defined in the MusicDeck schema registry.
pub const LATEST_SCHEMA_VERSION: u32 = 50;

/// Bcrypt work factor (`12`) matching `PASSWORD_COST` in `server/src/auth/passwords.ts`.
pub const BCRYPT_PASSWORD_COST: u32 = 12;

/// Generates a prefixed 24-character URL-safe NanoID (`<prefix>_<24 chars>`),
/// matching `createId(prefix)` in `server/src/utils/ids.ts`.
#[must_use]
pub fn create_id(prefix: &str) -> String {
    format!("{prefix}_{}", nanoid!(24))
}

/// Execution payload for a single migration step.
#[derive(Debug, Clone, Copy)]
pub enum MigrationKind {
    /// Declarative SQL script executed within the migration transaction.
    Sql(&'static str),
    /// Procedural migration 39 (`upgrade-legacy-smart-playlist-projection`).
    UpgradeSmartPlaylistProjectionV39,
}

/// Metadata and execution hook for a single schema migration step.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Monotonically increasing migration version identifier (`1..=50`).
    pub id: u32,
    /// Descriptive kebab-case migration slug stored in `schema_migrations.name`.
    pub name: &'static str,
    /// SQL or procedural migration implementation.
    pub kind: MigrationKind,
}

/// Record stored in the `schema_migrations` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedMigration {
    /// Migration version ID.
    pub id: u32,
    /// Migration slug name.
    pub name: String,
    /// ISO-8601 UTC timestamp when the migration was committed.
    pub applied_at: String,
}

/// Summary returned by [`run_migrations`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// Ordered list of migration IDs applied during this run.
    pub newly_applied: Vec<u32>,
    /// Total count of migrations recorded in `schema_migrations` after execution.
    pub total_applied: usize,
    /// Optional target ceiling version requested by the caller.
    pub target_version: Option<u32>,
}

/// Summary returned by [`seed_initial_data`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    /// Whether a new default `backend_connections` row was inserted.
    pub seeded_backend_connection: bool,
    /// Number of legacy `backend_connections` rows scrubbed of plaintext credentials.
    pub scrubbed_legacy_connections: usize,
    /// Whether the initial master administrator user was created.
    pub created_initial_admin: bool,
    /// Total number of rows in `users` after seeding.
    pub total_users: i64,
}

/// Summary returned by [`backfill_connection_scope`] and [`backfill_library_identities`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReport {
    /// Primary enabled backend connection ID used for backfilling (if any).
    pub primary_connection_id: Option<String>,
    /// Number of rows updated during connection scope backfilling.
    pub connection_scope_rows_updated: u64,
    /// Number of `favorites` rows rewritten to `md_` track IDs.
    pub favorites_rewritten: u64,
    /// Number of `recently_played` rows rewritten to `md_` track IDs.
    pub recently_played_rewritten: u64,
    /// Number of `playlist_items` rows populated with `library_track_id`.
    pub playlist_items_backfilled: u64,
}

/// Returns the ordered registry of all 50 MusicDeck schema migrations.
#[must_use]
pub fn migrations_registry() -> Vec<Migration> {
    RAW_MIGRATIONS
        .iter()
        .map(|&(id, name, sql_opt)| {
            let kind = match (id, sql_opt) {
                (39, None) => MigrationKind::UpgradeSmartPlaylistProjectionV39,
                (_, Some(sql)) => MigrationKind::Sql(sql),
                _ => MigrationKind::Sql(""),
            };
            Migration { id, name, kind }
        })
        .collect()
}

/// Queries all currently applied migrations from `schema_migrations` ordered by `id ASC`.
pub async fn list_applied_migrations(pool: &DbPool) -> Result<Vec<AppliedMigration>, DbError> {
    sqlx::query(
        r"
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        ",
    )
    .execute(pool.inner())
    .await?;

    let rows = sqlx::query("SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC;")
        .fetch_all(pool.inner())
        .await?;

    let mut applied = Vec::with_capacity(rows.len());
    for row in rows {
        let id_i64: i64 = row.try_get("id")?;
        applied.push(AppliedMigration {
            id: u32::try_from(id_i64).unwrap_or(0),
            name: row.try_get("name")?,
            applied_at: row.try_get("applied_at")?,
        });
    }
    Ok(applied)
}

/// Executes all unapplied migrations up to `up_to` (or all 50 migrations when `up_to` is `None`),
/// wrapping each individual migration in an atomic SQLite transaction.
pub async fn run_migrations(
    pool: &DbPool,
    up_to: Option<u32>,
) -> Result<MigrationReport, DbError> {
    let existing = list_applied_migrations(pool).await?;
    let mut applied_ids: HashSet<u32> = existing.iter().map(|m| m.id).collect();
    let ceiling = up_to.unwrap_or(u32::MAX);
    let mut newly_applied = Vec::new();

    for migration in migrations_registry() {
        if migration.id > ceiling {
            break;
        }
        if applied_ids.contains(&migration.id) {
            continue;
        }

        let mut conn = pool.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        // Re-check inside the transaction write lock in case another process migrated concurrently.
        let already_exists = sqlx::query("SELECT 1 FROM schema_migrations WHERE id = ?;")
            .bind(i64::from(migration.id))
            .fetch_optional(&mut *tx)
            .await?
            .is_some();

        if !already_exists {
            match migration.kind {
                MigrationKind::Sql(sql_script) => {
                    sqlx::raw_sql(sql_script).execute(&mut *tx).await?;
                }
                MigrationKind::UpgradeSmartPlaylistProjectionV39 => {
                    apply_migration_39(&mut tx).await?;
                }
            }

            let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            sqlx::query(
                "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?);",
            )
            .bind(i64::from(migration.id))
            .bind(migration.name)
            .bind(now_iso)
            .execute(&mut *tx)
            .await?;

            newly_applied.push(migration.id);
        }

        tx.commit().await?;
        applied_ids.insert(migration.id);
    }

    Ok(MigrationReport {
        newly_applied,
        total_applied: applied_ids.len(),
        target_version: up_to,
    })
}

/// Procedural implementation of Migration 39 (`upgrade-legacy-smart-playlist-projection`).
///
/// Upgrades databases that applied an early revision of Migration 33 by splitting inline
/// `track_json` payloads into `smart_playlist_track_payloads`, normalizing multi-genre
/// values into `smart_playlist_genres` (separated by `\u{001f}`), and rebuilding
/// `smart_playlist_activity`.
async fn apply_migration_39(conn: &mut SqliteConnection) -> Result<(), DbError> {
    sqlx::raw_sql(
        r"
        CREATE TABLE IF NOT EXISTS smart_playlist_track_payloads (
          track_id TEXT PRIMARY KEY REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
          track_json TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS smart_playlist_genres (
          track_id TEXT NOT NULL REFERENCES smart_playlist_tracks(id) ON DELETE CASCADE,
          genre TEXT NOT NULL,
          PRIMARY KEY(track_id, genre)
        ) WITHOUT ROWID;
        ",
    )
    .execute(&mut *conn)
    .await?;

    let table_info = sqlx::query("PRAGMA table_info(smart_playlist_tracks);")
        .fetch_all(&mut *conn)
        .await?;
    let has_legacy_track_json = table_info.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|col| col == "track_json")
    });

    if has_legacy_track_json {
        sqlx::raw_sql(
            r"
            INSERT INTO smart_playlist_track_payloads(track_id, track_json)
              SELECT id, track_json FROM smart_playlist_tracks WHERE 1
              ON CONFLICT(track_id) DO NOTHING;
            ALTER TABLE smart_playlist_tracks DROP COLUMN track_json;
            ",
        )
        .execute(&mut *conn)
        .await?;
    }

    let track_rows = sqlx::query(
        r"
        SELECT t.id, t.genre, p.track_json
        FROM smart_playlist_tracks t
        LEFT JOIN smart_playlist_track_payloads p ON p.track_id = t.id;
        ",
    )
    .fetch_all(&mut *conn)
    .await?;

    for row in track_rows {
        let track_id: String = row.try_get("id")?;
        let existing_genre: Option<String> = row.try_get("genre")?;
        let track_json: Option<String> = row.try_get("track_json")?;

        let mut genres: Vec<String> = existing_genre
            .as_deref()
            .map(|g| {
                g.split('\u{001f}')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();

        if let Some(raw_json) = track_json
            && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw_json)
            && let Some(Value::Array(arr)) = map.get("genres")
        {
            genres = arr
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect();
        }

        for genre in &genres {
            sqlx::query(
                "INSERT OR IGNORE INTO smart_playlist_genres(track_id, genre) VALUES (?, ?);",
            )
            .bind(&track_id)
            .bind(genre)
            .execute(&mut *conn)
            .await?;
        }

        let joined_genres = if genres.is_empty() {
            None
        } else {
            Some(genres.join("\u{001f}"))
        };

        sqlx::query("UPDATE smart_playlist_tracks SET genre = ? WHERE id = ?;")
            .bind(joined_genres)
            .bind(&track_id)
            .execute(&mut *conn)
            .await?;
    }

    let rebuild_sql = format!(
        "DROP INDEX IF EXISTS smart_tracks_year;\nCREATE INDEX smart_tracks_year ON smart_playlist_tracks(year, genre, id);\n{SMART_PLAYLIST_ACTIVITY_SCHEMA_BASE}"
    );
    sqlx::raw_sql(&rebuild_sql).execute(&mut *conn).await?;

    Ok(())
}

/// Seeds initial roles (`admin`, `user`), primary backend connection configuration,
/// and the bootstrap master administrator account when `users` is empty.
pub async fn seed_initial_data(pool: &DbPool, config: &AppConfig) -> Result<SeedReport, DbError> {
    sqlx::query("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?);")
        .bind("admin")
        .bind("Full server administrator")
        .execute(pool.inner())
        .await?;

    sqlx::query("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?);")
        .bind("user")
        .bind("Standard MusicDeck user")
        .execute(pool.inner())
        .await?;

    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (seed_type, seed_name, seed_url) = match config.backend {
        MusicBackendKind::Jellyfin => ("jellyfin", "Jellyfin", config.jellyfin.url.as_str()),
        MusicBackendKind::Navidrome => ("navidrome", "Navidrome", config.navidrome.url.as_str()),
    };

    let backend_count_row =
        sqlx::query("SELECT COUNT(*) AS count FROM backend_connections WHERE type = ?;")
            .bind(seed_type)
            .fetch_one(pool.inner())
            .await?;
    let backend_count: i64 = backend_count_row.try_get("count")?;

    let mut seeded_backend_connection = false;
    if backend_count == 0 {
        let config_json = json!({
            "url": seed_url,
            "credentials": "environment",
        })
        .to_string();

        sqlx::query(
            r"
            INSERT INTO backend_connections
              (id, type, name, config_json, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?);
            ",
        )
        .bind(create_id("backend"))
        .bind(seed_type)
        .bind(seed_name)
        .bind(config_json)
        .bind(&now_iso)
        .bind(&now_iso)
        .execute(pool.inner())
        .await?;
        seeded_backend_connection = true;
    }

    let mut scrubbed_legacy_connections = 0usize;
    if !config.navidrome.username.is_empty() && !config.navidrome.password.is_empty() {
        let rows =
            sqlx::query("SELECT id, config_json FROM backend_connections WHERE type = 'navidrome';")
                .fetch_all(pool.inner())
                .await?;

        for row in rows {
            let conn_id: String = row.try_get("id")?;
            let raw_json: String = row.try_get("config_json")?;
            if let Ok(Value::Object(mut parsed)) = serde_json::from_str::<Value>(&raw_json)
                && (parsed.contains_key("username") || parsed.contains_key("password"))
            {
                parsed.remove("username");
                parsed.remove("password");
                parsed.insert(
                    String::from("credentials"),
                    Value::String(String::from("environment")),
                );
                let updated_json = Value::Object(parsed).to_string();
                sqlx::query(
                    "UPDATE backend_connections SET config_json = ?, updated_at = ? WHERE id = ?;",
                )
                .bind(updated_json)
                .bind(&now_iso)
                .bind(conn_id)
                .execute(pool.inner())
                .await?;
                scrubbed_legacy_connections += 1;
            }
        }
    }

    let user_count_row = sqlx::query("SELECT COUNT(*) AS count FROM users;")
        .fetch_one(pool.inner())
        .await?;
    let mut total_users: i64 = user_count_row.try_get("count")?;

    let mut created_initial_admin = false;
    if total_users == 0 && !config.auth.first_admin.password.is_empty() {
        let raw_password = config.auth.first_admin.password.clone();
        let password_hash = tokio::task::spawn_blocking(move || {
            bcrypt::hash(raw_password, BCRYPT_PASSWORD_COST)
        })
        .await
        .map_err(|err| {
            DbError::InvalidPath(format!("Password hashing worker panicked: {err}"))
        })?
        .map_err(|err| DbError::InvalidPath(format!("Password hashing failed: {err}")))?;

        let has_is_master = table_has_column(pool.inner(), "users", "is_master").await?;
        if has_is_master {
            sqlx::query(
                r"
                INSERT INTO users
                  (id, username, password_hash, display_name, role, disabled, is_master, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'admin', 0, 1, ?, ?);
                ",
            )
            .bind(create_id("user"))
            .bind(&config.auth.first_admin.username)
            .bind(password_hash)
            .bind(&config.auth.first_admin.username)
            .bind(&now_iso)
            .bind(&now_iso)
            .execute(pool.inner())
            .await?;
        } else {
            sqlx::query(
                r"
                INSERT INTO users
                  (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'admin', 0, ?, ?);
                ",
            )
            .bind(create_id("user"))
            .bind(&config.auth.first_admin.username)
            .bind(password_hash)
            .bind(&config.auth.first_admin.username)
            .bind(&now_iso)
            .bind(&now_iso)
            .execute(pool.inner())
            .await?;
        }

        created_initial_admin = true;
        total_users = 1;
    }

    Ok(SeedReport {
        seeded_backend_connection,
        scrubbed_legacy_connections,
        created_initial_admin,
        total_users,
    })
}

/// Remaps placeholder `'env-navidrome'` connection references created in Migration 3/4
/// to the current primary enabled backend connection ID.
pub async fn backfill_connection_scope(pool: &DbPool) -> Result<BackfillReport, DbError> {
    let mut report = BackfillReport::default();

    let has_migration_3 = sqlx::query("SELECT id FROM schema_migrations WHERE id = 3;")
        .fetch_optional(pool.inner())
        .await?
        .is_some();

    if !has_migration_3 {
        return Ok(report);
    }

    let Some(primary_id) = fetch_primary_connection_id(pool).await? else {
        return Ok(report);
    };
    report.primary_connection_id = Some(primary_id.clone());

    if table_has_column(pool.inner(), "favorites", "connection_id").await? {
        let res = sqlx::query(
            "UPDATE favorites SET connection_id = ? WHERE connection_id = 'env-navidrome';",
        )
        .bind(&primary_id)
        .execute(pool.inner())
        .await?;
        report.connection_scope_rows_updated += res.rows_affected();
    }

    if table_has_column(pool.inner(), "recently_played", "connection_id").await? {
        let res = sqlx::query(
            "UPDATE recently_played SET connection_id = ? WHERE connection_id = 'env-navidrome';",
        )
        .bind(&primary_id)
        .execute(pool.inner())
        .await?;
        report.connection_scope_rows_updated += res.rows_affected();
    }

    if table_exists(pool.inner(), "playlist_ownership").await? {
        let res = sqlx::query(
            "UPDATE playlist_ownership SET connection_id = ? WHERE connection_id = 'env-navidrome';",
        )
        .bind(&primary_id)
        .execute(pool.inner())
        .await?;
        report.connection_scope_rows_updated += res.rows_affected();
    }

    if table_exists(pool.inner(), "playlists").await? {
        let res = sqlx::query(
            "UPDATE playlists SET source_connection_id = ? WHERE source_connection_id = 'env-navidrome';",
        )
        .bind(&primary_id)
        .execute(pool.inner())
        .await?;
        report.connection_scope_rows_updated += res.rows_affected();
    }

    Ok(report)
}

/// Creates stable `md_<nanoid>` MusicDeck library identities for legacy provider-scoped
/// track references in `favorites`, `recently_played`, and `playlist_items` within a
/// single atomic SQLite transaction.
pub async fn backfill_library_identities(pool: &DbPool) -> Result<BackfillReport, DbError> {
    let mut report = BackfillReport::default();

    let has_migration_5 = sqlx::query("SELECT id FROM schema_migrations WHERE id = 5;")
        .fetch_optional(pool.inner())
        .await?
        .is_some();

    if !has_migration_5 {
        return Ok(report);
    }

    let Some(primary_id) = fetch_primary_connection_id(pool).await? else {
        return Ok(report);
    };
    report.primary_connection_id = Some(primary_id.clone());

    let has_item_type =
        table_has_column(pool.inner(), "library_item_sources", "item_type").await?;
    let has_external_track_json =
        table_has_column(pool.inner(), "playlist_items", "external_track_json").await?;

    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;
    let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // 1. Backfill `favorites`
    let favorite_rows = sqlx::query("SELECT user_id, track_id FROM favorites;")
        .fetch_all(&mut *tx)
        .await?;
    for row in favorite_rows {
        let user_id: String = row.try_get("user_id")?;
        let track_id: String = row.try_get("track_id")?;
        if track_id.starts_with("md_") {
            continue;
        }
        let md_id = ensure_track_id(
            &mut tx,
            &primary_id,
            &track_id,
            &now_iso,
            has_item_type,
        )
        .await?;
        let res = sqlx::query(
            "UPDATE favorites SET track_id = ? WHERE user_id = ? AND track_id = ?;",
        )
        .bind(&md_id)
        .bind(&user_id)
        .bind(&track_id)
        .execute(&mut *tx)
        .await?;
        report.favorites_rewritten += res.rows_affected();
    }

    // 2. Backfill `recently_played`
    let recent_rows = sqlx::query("SELECT id, track_id FROM recently_played;")
        .fetch_all(&mut *tx)
        .await?;
    for row in recent_rows {
        let row_id: String = row.try_get("id")?;
        let track_id: String = row.try_get("track_id")?;
        if track_id.starts_with("md_") {
            continue;
        }
        let md_id = ensure_track_id(
            &mut tx,
            &primary_id,
            &track_id,
            &now_iso,
            has_item_type,
        )
        .await?;
        let res = sqlx::query("UPDATE recently_played SET track_id = ? WHERE id = ?;")
            .bind(&md_id)
            .bind(&row_id)
            .execute(&mut *tx)
            .await?;
        report.recently_played_rewritten += res.rows_affected();
    }

    // 3. Backfill `playlist_items.library_track_id`
    let items_query = if has_external_track_json {
        "SELECT id, connection_id, provider_track_id FROM playlist_items WHERE library_track_id IS NULL AND external_track_json IS NULL;"
    } else {
        "SELECT id, connection_id, provider_track_id FROM playlist_items WHERE library_track_id IS NULL;"
    };
    let item_rows = sqlx::query(items_query).fetch_all(&mut *tx).await?;
    for row in item_rows {
        let item_id: String = row.try_get("id")?;
        let connection_id: String = row.try_get("connection_id")?;
        let provider_track_id: String = row.try_get("provider_track_id")?;
        let md_id = ensure_track_id(
            &mut tx,
            &connection_id,
            &provider_track_id,
            &now_iso,
            has_item_type,
        )
        .await?;
        let res = sqlx::query("UPDATE playlist_items SET library_track_id = ? WHERE id = ?;")
            .bind(&md_id)
            .bind(&item_id)
            .execute(&mut *tx)
            .await?;
        report.playlist_items_backfilled += res.rows_affected();
    }

    tx.commit().await?;
    Ok(report)
}

/// Complete database opening and initialization pipeline matching `openDatabase(config)`
/// in `server/src/db/database.ts`.
pub async fn open_database(config: &AppConfig) -> Result<DbPool, DbError> {
    let db_path = std::path::Path::new(config.database_path());
    let pool = DbPool::connect(db_path).await?;

    if let Err(err) = async {
        run_migrations(&pool, None).await?;
        seed_initial_data(&pool, config).await?;
        backfill_connection_scope(&pool).await?;
        backfill_library_identities(&pool).await?;
        if config.database.is_persistent() {
            protect_database_files(db_path)?;
        }
        Ok::<(), DbError>(())
    }
    .await
    {
        pool.close().await;
        return Err(err);
    }

    Ok(pool)
}

async fn ensure_track_id(
    tx: &mut SqliteConnection,
    connection_id: &str,
    provider_track_id: &str,
    now_iso: &str,
    has_item_type: bool,
) -> Result<String, DbError> {
    let existing = if has_item_type {
        sqlx::query(
            r"
            SELECT library_item_id AS id FROM library_item_sources
            WHERE connection_id = ? AND provider_item_id = ? AND item_type = 'track';
            ",
        )
        .bind(connection_id)
        .bind(provider_track_id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query(
            r"
            SELECT library_item_id AS id FROM library_item_sources
            WHERE connection_id = ? AND provider_item_id = ?;
            ",
        )
        .bind(connection_id)
        .bind(provider_track_id)
        .fetch_optional(&mut *tx)
        .await?
    };

    if let Some(row) = existing {
        return Ok(row.try_get("id")?);
    }

    let new_id = create_id("md");
    sqlx::query("INSERT INTO library_items (id, type, created_at, updated_at) VALUES (?, 'track', ?, ?);")
        .bind(&new_id)
        .bind(now_iso)
        .bind(now_iso)
        .execute(&mut *tx)
        .await?;

    if has_item_type {
        sqlx::query(
            r"
            INSERT INTO library_item_sources
              (library_item_id, item_type, connection_id, provider_item_id, created_at)
            VALUES (?, 'track', ?, ?, ?);
            ",
        )
        .bind(&new_id)
        .bind(connection_id)
        .bind(provider_track_id)
        .bind(now_iso)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r"
            INSERT INTO library_item_sources
              (library_item_id, connection_id, provider_item_id, created_at)
            VALUES (?, ?, ?, ?);
            ",
        )
        .bind(&new_id)
        .bind(connection_id)
        .bind(provider_track_id)
        .bind(now_iso)
        .execute(&mut *tx)
        .await?;
    }

    Ok(new_id)
}

async fn fetch_primary_connection_id(pool: &DbPool) -> Result<Option<String>, DbError> {
    let row = sqlx::query(
        "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1;",
    )
    .fetch_optional(pool.inner())
    .await?;

    row.map(|r| r.try_get("id").map_err(DbError::from))
        .transpose()
}

async fn table_exists(pool: &sqlx::SqlitePool, table_name: &str) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
    )
    .bind(table_name)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

async fn table_has_column(
    pool: &sqlx::SqlitePool,
    table_name: &str,
    column_name: &str,
) -> Result<bool, DbError> {
    let query = format!("PRAGMA table_info({table_name});");
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    Ok(rows.iter().any(|r| {
        r.try_get::<String, _>("name")
            .is_ok_and(|name| name == column_name)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn applies_partial_and_full_50_migrations_and_backfills_identities() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");

        // 1. Roll forward to migration 3 (connection-scoped user data)
        let partial = run_migrations(&pool, Some(3))
            .await
            .expect("migrate up to v3");
        assert_eq!(partial.newly_applied, vec![1, 2, 3]);
        assert_eq!(partial.total_applied, 3);

        // 2. Seed initial admin and primary connection, then insert legacy favorite/recent rows
        let mut cfg = AppConfig::default();
        cfg.database.database_path = String::from(":memory:");
        cfg.auth.first_admin.password = String::from("admin-secret-password");
        let seed = seed_initial_data(&pool, &cfg).await.expect("seed data");
        assert!(seed.seeded_backend_connection);
        assert!(seed.created_initial_admin);

        let user_row = sqlx::query("SELECT id FROM users LIMIT 1;")
            .fetch_one(pool.inner())
            .await
            .expect("fetch user");
        let user_id: String = user_row.try_get("id").expect("user id");

        sqlx::query(
            "INSERT INTO favorites (user_id, connection_id, track_id, created_at) VALUES (?, 'env-navidrome', 'nav-track-1', '2026-01-01T00:00:00Z');",
        )
        .bind(&user_id)
        .execute(pool.inner())
        .await
        .expect("insert legacy favorite");

        let scope_report = backfill_connection_scope(&pool)
            .await
            .expect("backfill scope at v3");
        assert_eq!(scope_report.connection_scope_rows_updated, 1);

        // 3. Roll forward through all 50 migrations
        let full = run_migrations(&pool, None)
            .await
            .expect("migrate up to v50");
        assert_eq!(full.total_applied, 50);

        // 4. Run library identity backfill and verify 'nav-track-1' is mapped to 'md_...'
        let id_report = backfill_library_identities(&pool)
            .await
            .expect("backfill identities");
        assert_eq!(id_report.favorites_rewritten, 1);

        let fav_row = sqlx::query("SELECT track_id FROM favorites WHERE user_id = ?;")
            .bind(&user_id)
            .fetch_one(pool.inner())
            .await
            .expect("fetch migrated favorite");
        let md_track_id: String = fav_row.try_get("track_id").expect("track_id");
        assert!(md_track_id.starts_with("md_"));

        pool.close().await;
    }
}
