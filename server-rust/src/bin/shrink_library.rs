//! # Standalone Library Storage Optimizer CLI (`shrink_library`)
//!
//! Ports `server/src/scripts/shrink-library.ts`:
//! - Parses `--apply` and `--all-flac` flags via `clap::Parser`.
//! - Connects to the configured SQLite database and executes [`shrink_spotdl_library`].
//! - Triggers a library rescan on the active upstream provider (`Navidrome` or `Jellyfin`)
//!   when one or more `.flac` files were converted to `.mp3`.
//! - Outputs a formatted JSON report (`mode: "applied" | "dry-run"`, `scannedFlacs`,
//!   `eligibleFlacs`, `unverifiedFlacs`, `converted`, `skippedExistingMp3`, `bytesSaved`, `failures`)
//!   and exits with code `1` if any conversion or rescan error occurred.

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use serde_json::json;

use musicdeck_server::audio::{ShrinkOptions, shrink_spotdl_library};
use musicdeck_server::config::AppConfig;
use musicdeck_server::db::DbPool;

/// Command-line flags for the MusicDeck library storage optimizer (`shrink_library`).
#[derive(Debug, Parser)]
#[command(
    name = "shrink_library",
    about = "Transcode spotDL-imported FLAC files to 320 kbps MP3 while preserving metadata and artwork"
)]
struct CliArgs {
    /// Convert eligible FLAC files in-place (defaults to read-only dry-run inventory).
    #[arg(long = "apply", default_value_t = false)]
    apply: bool,

    /// Include all FLAC files under the music root even without spotDL database/marker provenance.
    #[arg(long = "all-flac", default_value_t = false)]
    all_flac: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = CliArgs::parse();

    let config = match AppConfig::load() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::FAILURE;
        }
    };

    let db = match DbPool::connect_file(config.database_path(), false).await {
        Ok(pool) => pool,
        Err(err) => {
            eprintln!(
                "Failed to open database at '{}': {err}",
                config.database_path()
            );
            return ExitCode::FAILURE;
        }
    };

    let mut options = ShrinkOptions::new(
        PathBuf::from(&config.music_root),
        config.spotify_import_subdir.clone(),
        Some(db.clone()),
    );
    options.apply = args.apply;
    options.include_all_flacs = args.all_flac;

    let outcome = shrink_spotdl_library(&options).await;
    db.close().await;

    match outcome {
        Ok(result) => {
            let mode = if args.apply { "applied" } else { "dry-run" };
            let report = json!({
                "mode": mode,
                "scannedFlacs": result.scanned_flacs,
                "eligibleFlacs": result.eligible_flacs,
                "unverifiedFlacs": result.unverified_flacs,
                "converted": result.converted,
                "skippedExistingMp3": result.skipped_existing_mp3,
                "bytesSaved": result.bytes_saved,
                "failures": result.failures,
                "rescanError": result.rescan_error,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_else(|_| String::from("{}"))
            );
            if !result.failures.is_empty() || result.rescan_error.is_some() {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}
