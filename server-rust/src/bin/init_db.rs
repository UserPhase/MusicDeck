//! # MusicDeck Database Initialization & Migration CLI (`init_db`)
//!
//! Standalone administrative CLI binary replacing `server/src/scripts/init-db.ts`
//! (`npm run db:init`).
//!
//! ## Usage Examples
//! - Standard initialization (runs all 50 migrations, seeds initial data, and runs backfills):
//!   `cargo run --bin init_db`
//! - Roll forward to a specific schema version for legacy upgrade testing:
//!   `cargo run --bin init_db -- --db-path ./data/test.sqlite --target-version 39`
//! - Inspect current migration status without mutating:
//!   `cargo run --bin init_db -- --status`

#![forbid(unsafe_code)]

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use musicdeck_server::config::AppConfig;
use musicdeck_server::db::migrations::{
    LATEST_SCHEMA_VERSION, backfill_connection_scope, backfill_library_identities,
    list_applied_migrations, migrations_registry, run_migrations, seed_initial_data,
};
use musicdeck_server::db::{DbError, DbPool, protect_database_files};
use serde::Serialize;
use sqlx::Row;

/// Command-line arguments for the `init_db` administrative utility.
#[derive(Debug, Parser)]
#[command(
    name = "init_db",
    version,
    about = "Initialize and migrate the MusicDeck SQLite database schema"
)]
pub struct InitDbArgs {
    /// Override the SQLite database file path (`MUSICDECK_DB_PATH`).
    #[arg(long = "db-path", env = "MUSICDECK_DB_PATH")]
    pub db_path: Option<String>,

    /// Apply migrations only up to this schema version (`1..=50`).
    #[arg(long = "target-version")]
    pub target_version: Option<u32>,

    /// Force execution of legacy connection-scope and library-identity backfills.
    #[arg(long = "force-backfill", default_value_t = false)]
    pub force_backfill: bool,

    /// Skip initial role, backend connection, and admin account seeding.
    #[arg(long = "skip-seed", default_value_t = false)]
    pub skip_seed: bool,

    /// Print current migration status without applying pending migrations.
    #[arg(long = "status", default_value_t = false)]
    pub status_only: bool,

    /// Emit machine-readable JSON output instead of human-readable lines.
    #[arg(long = "json", default_value_t = false)]
    pub json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliSummaryOutput {
    database_path: String,
    applied_migrations: usize,
    latest_available_version: u32,
    newly_applied: Vec<u32>,
    users: i64,
    backfill_executed: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = InitDbArgs::parse();

    match execute_cli(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("Database initialization failed: {err}");
            ExitCode::FAILURE
        }
    }
}

async fn execute_cli(args: InitDbArgs) -> Result<(), DbError> {
    let mut config = AppConfig::load().map_err(|err| DbError::InvalidPath(err.to_string()))?;
    if let Some(ref override_path) = args.db_path
        && !override_path.trim().is_empty()
    {
        config.database.database_path.clone_from(override_path);
    }

    let db_path_str = config.database_path().to_owned();
    let db_path = Path::new(&db_path_str);
    let pool = DbPool::connect(db_path).await?;

    let result = async {
        if args.status_only {
            let applied = list_applied_migrations(&pool).await?;
            let total_defined = migrations_registry().len();
            println!(
                "Database: {db_path_str} ({}/{} migrations applied)",
                applied.len(),
                total_defined
            );
            for item in &applied {
                println!("  [v{:02}] {} ({})", item.id, item.name, item.applied_at);
            }
            return Ok(());
        }

        let migration_report = run_migrations(&pool, args.target_version).await?;

        let should_seed_and_backfill =
            args.target_version.is_none_or(|v| v >= LATEST_SCHEMA_VERSION);

        if !args.skip_seed && (should_seed_and_backfill || args.target_version.unwrap_or(50) >= 1) {
            seed_initial_data(&pool, &config).await?;
        }

        let mut backfill_executed = false;
        if should_seed_and_backfill || args.force_backfill {
            backfill_connection_scope(&pool).await?;
            backfill_library_identities(&pool).await?;
            backfill_executed = true;
        }

        if config.database.is_persistent() {
            protect_database_files(db_path)?;
        }

        let user_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM users;")
            .fetch_one(pool.inner())
            .await?
            .try_get("count")?;

        if args.json {
            let summary = CliSummaryOutput {
                database_path: db_path_str.clone(),
                applied_migrations: migration_report.total_applied,
                latest_available_version: LATEST_SCHEMA_VERSION,
                newly_applied: migration_report.newly_applied,
                users: user_count,
                backfill_executed,
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&summary).unwrap_or_default()
            );
        } else {
            // Exact stdout contract matching `server/src/scripts/init-db.ts`
            println!("Database initialized at {db_path_str}");
            println!("Users: {user_count}");
            if user_count == 0 {
                println!(
                    "No users exist yet. Set MUSICDECK_ADMIN_PASSWORD and rerun db:init to create the first admin."
                );
            }
        }

        Ok(())
    }
    .await;

    pool.close().await;
    result
}
