//! Restartable filesystem rollback. Failed recovery retains its journal and staging data.

use super::{RecoveryError, RecoveryJournal, SystemRecoveryPaths};
use crate::config::{durable_json, sync_directory};
use std::path::{Path, PathBuf};

fn failure(message: &str, error: impl std::fmt::Display) -> RecoveryError {
    RecoveryError::new(
        format!("{message}: {error}. Recovery files were retained."),
        500,
    )
}

fn metadata(path: &Path) -> Result<Option<std::fs::Metadata>, RecoveryError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(RecoveryError::new(
            "Symbolic links are not permitted in recovery paths; recovery files were retained.",
            500,
        )),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure("Could not inspect recovery path", error)),
    }
}

fn remove_file(path: &Path) -> Result<(), RecoveryError> {
    if let Some(info) = metadata(path)? {
        if !info.is_file() {
            return Err(RecoveryError::new(
                "Expected a regular recovery file; recovery files were retained.",
                500,
            ));
        }
        std::fs::remove_file(path)
            .map_err(|error| failure("Could not remove replaced file", error))?;
    }
    Ok(())
}

fn stage_snapshot(stage: &Path, name: &str) -> Result<PathBuf, RecoveryError> {
    let original = stage.join(name);
    if !metadata(&original)?.is_some_and(|info| info.is_file()) {
        return Err(RecoveryError::new(
            format!(
                "Original snapshot {name} is missing or invalid; recovery files were retained."
            ),
            500,
        ));
    }
    // Keep the source snapshot until the rollback journal is durable. Another
    // interruption can retry from the same bytes without trusting the live file.
    let replacement = stage.join(format!("rollback-{name}"));
    remove_file(&replacement)?;
    std::fs::copy(original, &replacement)
        .and_then(|_| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&replacement)?
                .sync_all()
        })
        .map_err(|error| failure("Could not stage the original file", error))?;
    Ok(replacement)
}

fn install_snapshot(replacement: &Path, live: &Path) -> Result<(), RecoveryError> {
    remove_file(live)?;
    std::fs::rename(replacement, live)
        .map_err(|error| failure("Could not restore original file", error))
}

fn remove_artwork(path: &Path) -> Result<(), RecoveryError> {
    if let Some(info) = metadata(path)? {
        if !info.is_dir() {
            return Err(RecoveryError::new(
                "Artwork recovery path is not a directory; recovery files were retained.",
                500,
            ));
        }
        std::fs::remove_dir_all(path)
            .map_err(|error| failure("Could not remove replacement artwork", error))?;
    }
    Ok(())
}

pub(super) fn recover(
    database_path: &str,
    restore_database_file: bool,
) -> Result<bool, RecoveryError> {
    recover_inner(database_path, restore_database_file, true)
}

/// Restore config/artwork even if SQL rollback failed; keep all remaining recovery data.
pub(super) fn restore_files(database_path: &str) -> Result<bool, RecoveryError> {
    recover_inner(database_path, false, false)
}

fn recover_inner(
    database_path: &str,
    restore_database_file: bool,
    finish: bool,
) -> Result<bool, RecoveryError> {
    if database_path == ":memory:" {
        return Ok(false);
    }
    let paths = SystemRecoveryPaths::from_database_path(database_path);
    let journal_file = paths.recovery.join("journal.json");
    let Some(info) = metadata(&journal_file)? else {
        return Ok(false);
    };
    if !info.is_file() || info.len() > 16_384 {
        return Err(RecoveryError::new(
            "Invalid recovery journal; refusing to start with mixed recovery state.",
            500,
        ));
    }
    let raw = std::fs::read_to_string(&journal_file)
        .map_err(|error| failure("Could not read recovery journal", error))?;
    let mut journal: RecoveryJournal =
        serde_json::from_str(&raw).map_err(|error| failure("Invalid recovery journal", error))?;
    if journal.version != 1
        || !matches!(
            journal.phase.as_str(),
            "installing" | "committed" | "rolled-back"
        )
        || journal.id.len() != 36
        || uuid::Uuid::parse_str(&journal.id).is_err()
    {
        return Err(RecoveryError::new(
            "Invalid recovery journal; refusing to start with mixed recovery state.",
            500,
        ));
    }
    let stage = paths.recovery.join(&journal.id);
    let stage_info = metadata(&stage)?;
    if stage_info.as_ref().is_some_and(|info| !info.is_dir())
        || (journal.phase == "installing" && stage_info.is_none())
    {
        return Err(RecoveryError::new(
            "Recovery staging directory is missing or invalid; recovery files were retained.",
            500,
        ));
    }
    if journal.phase == "installing" {
        // At startup there are no open SQLite handles. Live rollback uses SQL instead.
        if restore_database_file {
            let replacement = stage_snapshot(&stage, "old-database.sqlite")?;
            for suffix in ["-wal", "-shm", "-journal"] {
                remove_file(&PathBuf::from(format!(
                    "{}{suffix}",
                    paths.database.display()
                )))?;
            }
            install_snapshot(&replacement, &paths.database)?;
        }
        if journal.had_config {
            let replacement = stage_snapshot(&stage, "old-config.json")?;
            install_snapshot(&replacement, &paths.configuration)?;
        } else {
            remove_file(&paths.configuration)?;
        }
        if journal.replace_artwork {
            let old_artwork = stage.join("old-artwork");
            if let Some(info) = metadata(&old_artwork)? {
                if !info.is_dir() {
                    return Err(RecoveryError::new(
                        "Original artwork snapshot is not a directory; recovery files were retained.",
                        500,
                    ));
                }
                remove_artwork(&paths.artwork)?;
                std::fs::rename(&old_artwork, &paths.artwork).map_err(|error| {
                    failure("Could not restore original artwork directory", error)
                })?;
            } else if !journal.had_artwork {
                remove_artwork(&paths.artwork)?;
            } else if !metadata(&paths.artwork)?.is_some_and(|info| info.is_dir()) {
                return Err(RecoveryError::new(
                    "Original artwork and rollback snapshot are both missing; recovery files were retained.",
                    500,
                ));
            }
        }
        sync_directory(&paths.root)
            .map_err(|error| failure("Could not flush recovered files", error))?;
        sync_directory(&stage)
            .map_err(|error| failure("Could not flush recovery staging", error))?;
        if !finish {
            return Ok(true);
        }
        // A crash during cleanup can now resume without requiring the old copies again.
        journal.phase = "rolled-back".into();
        durable_json(&journal_file, &journal)
            .map_err(|error| failure("Could not commit rollback journal", error))?;
    }
    if !finish {
        return Ok(true);
    }
    let committed = journal.phase == "committed";
    let status = serde_json::json!({
        "state": if committed { "complete" } else { "failed" },
        "message": if committed { "Restore was committed; startup finished recovery cleanup." }
            else { "Interrupted restore rolled back. Original database, configuration, and artwork were recovered." },
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    durable_json(&paths.recovery.join("status.json"), &status)
        .map_err(|error| failure("Could not write recovery status", error))?;
    if metadata(&stage)?.is_some() {
        std::fs::remove_dir_all(&stage)
            .map_err(|error| failure("Could not clean recovery staging", error))?;
    }
    std::fs::remove_file(&journal_file)
        .map_err(|error| failure("Could not remove completed recovery journal", error))?;
    sync_directory(&paths.recovery)
        .map_err(|error| failure("Could not flush recovery cleanup", error))?;
    Ok(true)
}

#[cfg(test)]
mod tests;
