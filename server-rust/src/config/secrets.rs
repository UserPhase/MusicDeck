//! # Secret Resolution Primitives (`config::secrets`)
//!
//! Replicates and hardens the Docker/Swarm/Kubernetes `<KEY>_FILE` secret loading
//! semantics from `server/src/config.ts`.
//!
//! ## Resolution Precedence
//! For any credential variable `KEY` (such as `MUSICDECK_SESSION_SECRET`,
//! `NAVIDROME_PASSWORD`, `JELLYFIN_API_KEY`, or `MUSICDECK_ADMIN_PASSWORD`):
//! 1. Check whether `<KEY>_FILE` is set and non-empty in the environment source.
//! 2. If `<KEY>_FILE` is defined, read the target file from disk, strip trailing
//!    CR/LF newlines and surrounding whitespace, and return its content, overriding
//!    any plain `<KEY>` environment variable.
//! 3. If `<KEY>_FILE` is defined but the file is missing, is a directory, or cannot
//!    be read, emit a structured `tracing::warn!` diagnostic and return
//!    [`ConfigError::UnreadableSecretFile`].
//! 4. Otherwise, fall back to the direct `<KEY>` environment variable or the caller's
//!    default fallback string.

use std::path::{Path, PathBuf};

use crate::config::{ConfigError, EnvSource};

/// Maximum permitted size (64 KiB) for a secret file loaded via `<KEY>_FILE`.
/// Prevents accidental memory exhaustion if an operator points `<KEY>_FILE` at a media file.
pub const MAX_SECRET_FILE_BYTES: u64 = 64 * 1024;

/// Synchronous secret resolver that checks `<key>_FILE` before `<key>`.
pub fn resolve_secret_with_env<E: EnvSource>(
    env: &E,
    key: &str,
    fallback: &str,
) -> Result<String, ConfigError> {
    let file_env_key = format!("{key}_FILE");
    if let Some(raw_path) = env.get_var(&file_env_key) {
        let trimmed_path = raw_path.trim();
        if !trimmed_path.is_empty() {
            return resolve_secret_from_file(&file_env_key, Path::new(trimmed_path));
        }
    }

    Ok(env
        .get_var(key)
        .filter(|val| !val.is_empty())
        .unwrap_or_else(|| fallback.to_owned()))
}

/// Reads a secret value from `path` on disk, validating file metadata and stripping
/// trailing newline characters (`\r` and `\n`).
pub fn resolve_secret_from_file(env_var: &str, path: &Path) -> Result<String, ConfigError> {
    let metadata = std::fs::metadata(path).map_err(|source| {
        tracing::warn!(
            variable = env_var,
            path = %path.display(),
            error = %source,
            "Configured secret file is missing or inaccessible"
        );
        ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source,
        }
    })?;

    if !metadata.is_file() {
        let err = std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "secret path does not point to a regular file",
        );
        tracing::warn!(
            variable = env_var,
            path = %path.display(),
            "Configured secret path is not a regular file"
        );
        return Err(ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source: err,
        });
    }

    if metadata.len() > MAX_SECRET_FILE_BYTES {
        let err = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("secret file exceeds {MAX_SECRET_FILE_BYTES} byte limit"),
        );
        return Err(ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source: err,
        });
    }

    let raw_contents = std::fs::read_to_string(path).map_err(|source| {
        tracing::warn!(
            variable = env_var,
            path = %path.display(),
            error = %source,
            "Failed to read secret file contents"
        );
        ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source,
        }
    })?;

    let normalized = raw_contents.trim_end_matches(['\r', '\n']).trim().to_owned();
    if normalized.is_empty() {
        return Err(ConfigError::EmptySecretFile {
            variable: env_var.to_owned(),
            path: PathBuf::from(path),
        });
    }

    Ok(normalized)
}

/// Asynchronous counterpart to [`resolve_secret_from_file`] backed by `tokio::fs`
/// for non-blocking initialization or runtime credential reloads.
pub async fn resolve_secret_from_file_async(
    env_var: &str,
    path: &Path,
) -> Result<String, ConfigError> {
    let metadata = tokio::fs::metadata(path).await.map_err(|source| {
        tracing::warn!(
            variable = env_var,
            path = %path.display(),
            error = %source,
            "Configured secret file is missing or inaccessible (async)"
        );
        ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source,
        }
    })?;

    if !metadata.is_file() || metadata.len() > MAX_SECRET_FILE_BYTES {
        let err = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret path must be a regular file under 64 KiB",
        );
        return Err(ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source: err,
        });
    }

    let raw_contents = tokio::fs::read_to_string(path).await.map_err(|source| {
        ConfigError::UnreadableSecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
            source,
        }
    })?;

    let normalized = raw_contents.trim_end_matches(['\r', '\n']).trim().to_owned();
    if normalized.is_empty() {
        return Err(ConfigError::EmptySecretFile {
            variable: env_var.to_owned(),
            path: path.to_path_buf(),
        });
    }

    Ok(normalized)
}
