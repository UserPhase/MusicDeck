//! # SQLite Connection Pool & WAL Initialization (`db`)
//!
//! Complete Rust port of `server/src/db/database.ts` and `server/src/db/file-permissions.ts`
//! backed by `sqlx::SqlitePool`.
//!
//! ## Connection Lifecycle & Pragma Enforcement
//! 1. **Pre-Connection Filesystem Hardening**:
//!    - For persistent databases (`path != ":memory:"`), [`DbPool::connect`] invokes
//!      [`prepare_database_path`] before opening any SQLite handle, guaranteeing a
//!      `0700` parent directory and a `0600` regular file (rejecting symlinks).
//! 2. **Per-Connection Pragma Configuration**:
//!    - Every connection in [`sqlx::SqlitePool`] is configured with:
//!      - `PRAGMA journal_mode = WAL;` (for file-backed databases; `MEMORY` for `:memory:`)
//!      - `PRAGMA synchronous = NORMAL;` (configurable to `FULL` via [`DbPoolOptions`])
//!      - `PRAGMA foreign_keys = ON;`
//!      - `PRAGMA busy_timeout = 5000;` (5-second lock wait timeout)
//! 3. **Post-Open WAL Verification & Sidecar Hardening**:
//!    - Immediately after pool creation, [`DbPool::connect_with_options`] queries
//!      `PRAGMA journal_mode;` to verify that WAL mode is active (failing fast with
//!      [`DbError::WalNotSupported`] if the volume rejected WAL) and re-runs
//!      [`protect_database_files`] to lock down newly created `-wal` and `-shm` sidecars.

pub mod migrations;
pub mod migrations_sql;
pub mod permissions;

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Row, SqlitePool};
use thiserror::Error;

pub use migrations::{
    AppliedMigration, BCRYPT_PASSWORD_COST, BackfillReport, LATEST_SCHEMA_VERSION, Migration,
    MigrationKind, MigrationReport, SeedReport, backfill_connection_scope,
    backfill_library_identities, create_id, list_applied_migrations, migrations_registry,
    open_database, run_migrations, seed_initial_data,
};
pub use permissions::{
    DIR_MODE_PRIVATE, FILE_MODE_PRIVATE, GROUP_OTHER_MASK, SQLITE_SIDECAR_SUFFIXES,
    prepare_database_path, protect_database_file, protect_database_files,
};

/// Default SQLite busy timeout (`5,000` ms) matching `server/src/db/database.ts`.
pub const DEFAULT_BUSY_TIMEOUT_MS: u64 = 5_000;

/// Default maximum connections in the asynchronous SQLite pool.
pub const DEFAULT_MAX_CONNECTIONS: u32 = 8;

/// Error taxonomy for SQLite initialization, permission enforcement, and query execution.
#[derive(Debug, Error)]
pub enum DbError {
    /// Filesystem I/O failure while preparing or inspecting database files.
    #[error("Database filesystem I/O error at '{path}': {source}")]
    Io {
        /// Path that triggered the I/O error.
        path: PathBuf,
        /// Underlying OS I/O error.
        #[source]
        source: std::io::Error,
    },

    /// Database or sidecar path pointed to a symbolic link or non-regular file.
    #[error("SQLite data files must be regular files, not symbolic links ('{path}')")]
    UnsafeFileType {
        /// Offending symlink or special file path.
        path: PathBuf,
    },

    /// Invalid or empty database file path.
    #[error("Invalid database path: {0}")]
    InvalidPath(String),

    /// SQLite volume could not enable Write-Ahead Logging (`journal_mode = WAL`).
    #[error(
        "Could not enable SQLite WAL mode (current mode: {mode}). Use a writable local volume for MUSICDECK_DB_PATH."
    )]
    WalNotSupported {
        /// Journal mode reported by SQLite instead of `"wal"`.
        mode: String,
    },

    /// Another process held a lock that prevented a clean `wal_checkpoint(TRUNCATE)`.
    #[error(
        "Another SQLite connection prevented the recovery checkpoint. Stop other MusicDeck instances before restoring."
    )]
    CheckpointBusy,

    /// Underlying `sqlx` connection or query error.
    #[error("SQLite error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Configurable `PRAGMA synchronous` durability level.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum SynchronousMode {
    /// `PRAGMA synchronous = NORMAL;` — recommended for high-concurrency WAL streaming workloads.
    #[default]
    Normal,
    /// `PRAGMA synchronous = FULL;` — maximum commit durability on every transaction.
    Full,
}

impl SynchronousMode {
    const fn to_sqlx(self) -> SqliteSynchronous {
        match self {
            Self::Normal => SqliteSynchronous::Normal,
            Self::Full => SqliteSynchronous::Full,
        }
    }

    const fn as_pragma_sql(self) -> &'static str {
        match self {
            Self::Normal => "PRAGMA synchronous = NORMAL;",
            Self::Full => "PRAGMA synchronous = FULL;",
        }
    }
}

/// Tuning parameters for [`DbPool`] initialization.
#[derive(Debug, Clone)]
pub struct DbPoolOptions {
    /// Maximum number of concurrent connections in the pool.
    pub max_connections: u32,
    /// Minimum number of idle connections maintained by the pool.
    pub min_connections: u32,
    /// Lock wait timeout in milliseconds (`PRAGMA busy_timeout`).
    pub busy_timeout_ms: u64,
    /// `PRAGMA synchronous` setting (`NORMAL` by default).
    pub synchronous: SynchronousMode,
}

impl Default for DbPoolOptions {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_CONNECTIONS,
            min_connections: 1,
            busy_timeout_ms: DEFAULT_BUSY_TIMEOUT_MS,
            synchronous: SynchronousMode::Normal,
        }
    }
}

/// Thread-safe, cheaply cloneable wrapper around [`sqlx::SqlitePool`] with enforced
/// WAL mode, relational integrity (`foreign_keys = ON`), and `0600`/`0700` file permissions.
#[derive(Debug, Clone)]
pub struct DbPool {
    pool: SqlitePool,
    database_path: Option<PathBuf>,
}

impl DbPool {
    /// Opens a persistent SQLite database at `path` (or an in-memory database when `path`
    /// is `":memory:"`) using default [`DbPoolOptions`].
    pub async fn connect(path: &Path) -> Result<Self, DbError> {
        Self::connect_with_options(path, DbPoolOptions::default()).await
    }

    /// Convenience helper opening a SQLite database from a string path.
    pub async fn connect_file(path: &str, _read_only: bool) -> Result<Self, DbError> {
        Self::connect(Path::new(path)).await
    }

    /// Opens an isolated in-memory SQLite database (`sqlite::memory:`) with `foreign_keys = ON`
    /// and `busy_timeout = 5000`.
    pub async fn connect_memory() -> Result<Self, DbError> {
        Self::connect_with_options(Path::new(":memory:"), DbPoolOptions::default()).await
    }

    /// Opens a SQLite connection pool at `path` with custom [`DbPoolOptions`], enforcing
    /// pre-connection directory/file permissions, per-connection PRAGMAs, WAL verification,
    /// and post-open sidecar hardening.
    pub async fn connect_with_options(
        path: &Path,
        options: DbPoolOptions,
    ) -> Result<Self, DbError> {
        let raw_path = path.to_string_lossy();
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(DbError::InvalidPath(String::from(
                "MUSICDECK_DB_PATH must not be empty",
            )));
        }

        let is_persistent = trimmed != ":memory:";
        let resolved_path = if is_persistent {
            prepare_database_path(path)?;
            Some(path.to_path_buf())
        } else {
            None
        };

        let connect_options = if is_persistent {
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(options.synchronous.to_sqlx())
                .busy_timeout(Duration::from_millis(options.busy_timeout_ms))
        } else {
            SqliteConnectOptions::from_str("sqlite::memory:")?
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Memory)
                .synchronous(options.synchronous.to_sqlx())
                .busy_timeout(Duration::from_millis(options.busy_timeout_ms))
        };

        let busy_timeout_ms = options.busy_timeout_ms;
        let sync_pragma = options.synchronous.as_pragma_sql();
        let max_conns = if is_persistent {
            options.max_connections.max(1)
        } else {
            // A shared in-memory database across tests must keep a single connection alive
            // so the ephemeral schema is not dropped between queries.
            1
        };

        let pool = SqlitePoolOptions::new()
            .max_connections(max_conns)
            .min_connections(options.min_connections.min(max_conns))
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    sqlx::query("PRAGMA foreign_keys = ON;")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query(&format!("PRAGMA busy_timeout = {busy_timeout_ms};"))
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query(sync_pragma).execute(&mut *conn).await?;
                    if is_persistent {
                        sqlx::query("PRAGMA journal_mode = WAL;")
                            .execute(&mut *conn)
                            .await?;
                    }
                    Ok(())
                })
            })
            .connect_with(connect_options)
            .await?;

        if let Some(ref db_file) = resolved_path {
            let mode_row = sqlx::query("PRAGMA journal_mode;")
                .fetch_one(&pool)
                .await?;
            let current_mode: String = mode_row.try_get(0)?;
            if !current_mode.eq_ignore_ascii_case("wal") {
                pool.close().await;
                return Err(DbError::WalNotSupported { mode: current_mode });
            }

            if let Err(err) = protect_database_files(db_file) {
                pool.close().await;
                return Err(err);
            }
        }

        Ok(Self {
            pool,
            database_path: resolved_path,
        })
    }

    /// Returns a reference to the underlying [`sqlx::SqlitePool`].
    #[must_use]
    pub const fn inner(&self) -> &SqlitePool {
        &self.pool
    }

    /// Returns the persistent database file path if backed by disk, or `None` for `:memory:`.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.database_path.as_deref()
    }

    /// Executes a lightweight `SELECT 1;` connectivity probe for `/api/health`.
    pub async fn ping(&self) -> Result<(), DbError> {
        let row = sqlx::query("SELECT 1;").fetch_one(&self.pool).await?;
        let val: i32 = row.try_get(0)?;
        debug_assert_eq!(val, 1);
        Ok(())
    }

    /// Queries the active `PRAGMA journal_mode;` string (`"wal"` or `"memory"`).
    pub async fn journal_mode(&self) -> Result<String, DbError> {
        let row = sqlx::query("PRAGMA journal_mode;")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.try_get(0)?)
    }

    /// Performs a `PRAGMA wal_checkpoint(TRUNCATE);` and closes all pooled connections,
    /// matching `closeRuntimeDatabase()` in `server/src/main.ts`.
    pub async fn checkpoint_and_close(&self) -> Result<(), DbError> {
        if self.database_path.is_some() {
            let rows = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
                .fetch_all(&self.pool)
                .await?;
            for row in rows {
                let busy: i64 = row.try_get(0).unwrap_or(0);
                if busy != 0 {
                    return Err(DbError::CheckpointBusy);
                }
            }
        }
        self.pool.close().await;
        Ok(())
    }

    /// Gracefully closes all connections in the pool.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_db_path() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("musicdeck-db-test-{}", Uuid::new_v4()));
        let db_path = root.join("private-data").join("musicdeck.sqlite");
        (root, db_path)
    }

    #[tokio::test]
    async fn opens_persistent_wal_database_and_enforces_pragmas_and_permissions() {
        let (root, db_path) = temp_db_path();

        let db = DbPool::connect(&db_path)
            .await
            .expect("open persistent WAL database");

        assert_eq!(
            db.journal_mode().await.expect("query journal mode"),
            "wal"
        );

        sqlx::query("CREATE TABLE permission_fixture (value TEXT NOT NULL);")
            .execute(db.inner())
            .await
            .expect("create table");
        sqlx::query("INSERT INTO permission_fixture (value) VALUES (?);")
            .bind("fixture-value")
            .execute(db.inner())
            .await
            .expect("insert row");

        protect_database_files(&db_path).expect("protect database and sidecar files");

        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let dir_mode = std::fs::metadata(db_path.parent().unwrap())
                .expect("dir stat")
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700);

            let file_mode = std::fs::metadata(&db_path).expect("file stat").mode() & 0o777;
            assert_eq!(file_mode, 0o600);
        }

        db.checkpoint_and_close()
            .await
            .expect("checkpoint and close");

        // Reopen and verify data durability
        let reopened = DbPool::connect(&db_path).await.expect("reopen database");
        let row = sqlx::query("SELECT value FROM permission_fixture;")
            .fetch_one(reopened.inner())
            .await
            .expect("select row");
        let stored: String = row.try_get(0).expect("extract column");
        assert_eq!(stored, "fixture-value");
        reopened.close().await;

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn supports_in_memory_database_and_rejects_empty_paths() {
        let mem_db = DbPool::connect_memory().await.expect("open memory pool");
        assert!(mem_db.ping().await.is_ok());
        assert_eq!(
            mem_db.journal_mode().await.expect("journal mode"),
            "memory"
        );
        mem_db.close().await;

        let empty_err = DbPool::connect(Path::new("   ")).await.unwrap_err();
        assert!(matches!(empty_err, DbError::InvalidPath(_)));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_database_files() {
        use std::os::unix::fs::symlink;

        let (root, db_path) = temp_db_path();
        std::fs::create_dir_all(db_path.parent().unwrap()).expect("create parent");
        let target = root.join("target.sqlite");
        std::fs::write(&target, b"").expect("write target");
        symlink(&target, &db_path).expect("create symlink");

        let err = protect_database_file(&db_path).unwrap_err();
        assert!(matches!(err, DbError::UnsafeFileType { .. }));

        let _ = std::fs::remove_dir_all(&root);
    }
}
