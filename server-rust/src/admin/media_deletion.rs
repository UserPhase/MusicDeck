//! # Physical Media Deletion & Directory Hygiene Pipeline (`admin::media_deletion`)
//!
//! Ports `server/src/routes/admin-media-routes.ts`:
//! - [`is_path_within_root`]: Rejects sibling directories (e.g., `/music-backup`), parent
//!   traversal (`..`), and the root directory itself
//! - [`verified_audio_path`]: Verifies both lexical and canonical physical (`canonicalize`)
//!   containment inside `root_dir`, checks `is_supported_audio_file`, and rejects symlinks
//! - [`remove_empty_parents`] and [`remove_album_directory_if_safe`]: Best-effort cleanup of
//!   empty album/artist directories and non-audio sidecar files after track/album deletion

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::audio::{SUPPORTED_AUDIO_EXTENSIONS, is_supported_audio_file};

/// Structured error returned during media path verification or file deletion.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MediaPathError {
    pub status: u16,
    pub message: String,
}

impl MediaPathError {
    /// Creates a new [`MediaPathError`].
    #[must_use]
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

/// Returns `true` if `file_path` is strictly nested inside `root_dir` (never equal to `root_dir`
/// and containing no `..` parent traversal components).
#[must_use]
pub fn is_path_within_root(file_path: &Path, root_dir: &Path) -> bool {
    if file_path == root_dir {
        return false;
    }
    let Ok(rel) = file_path.strip_prefix(root_dir) else {
        return false;
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    rel.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Verifies that `metadata_path` resolves to a regular, non-symlink supported audio file
/// strictly inside `root_dir`.
pub async fn verified_audio_path(
    metadata_path: &str,
    root_dir: &Path,
) -> Result<PathBuf, MediaPathError> {
    let candidate = if Path::new(metadata_path).is_absolute() {
        PathBuf::from(metadata_path)
    } else {
        root_dir.join(metadata_path)
    };

    for comp in candidate.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(MediaPathError::new(
                400,
                "Track path is outside the music library",
            ));
        }
    }

    if !is_supported_audio_file(&candidate) {
        return Err(MediaPathError::new(
            400,
            "Unsupported audio container for server deletion",
        ));
    }

    let real_root = tokio::fs::canonicalize(root_dir).await.map_err(|_| {
        MediaPathError::new(
            400,
            "Track path is outside the music library or is not a regular file",
        )
    })?;

    let sym_meta = match tokio::fs::symlink_metadata(&candidate).await {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(MediaPathError::new(404, "Track file not found on disk"));
        }
        Err(_) => {
            return Err(MediaPathError::new(
                400,
                "Track path is outside the music library or is not a regular file",
            ));
        }
    };

    if !sym_meta.is_file() || sym_meta.file_type().is_symlink() {
        return Err(MediaPathError::new(
            400,
            "Track path is outside the music library or is not a regular file",
        ));
    }

    let real_file = tokio::fs::canonicalize(&candidate).await.map_err(|_| {
        MediaPathError::new(
            400,
            "Track path is outside the music library or is not a regular file",
        )
    })?;

    if !is_path_within_root(&real_file, &real_root) {
        return Err(MediaPathError::new(
            400,
            "Track path is outside the music library or is not a regular file",
        ));
    }

    Ok(real_file)
}

/// Best-effort removal of empty ancestor directories up to (but never including) `root_dir`.
pub async fn remove_empty_parents(file_path: &Path, root_dir: &Path) {
    let Ok(real_root) = tokio::fs::canonicalize(root_dir).await else {
        return;
    };
    let mut current_opt = file_path.parent().map(Path::to_path_buf);
    while let Some(dir) = current_opt {
        if !is_path_within_root(&dir, &real_root) {
            break;
        }
        if tokio::fs::remove_dir(&dir).await.is_err() {
            break;
        }
        current_opt = dir.parent().map(Path::to_path_buf);
    }
}

/// Removes an album directory and its non-audio sidecar files (`cover.jpg`, `.lrc`, etc.)
/// after all album tracks have been deleted, provided the directory is at least 2 levels
/// below `root_dir` (`<root>/<artist>/<album>`) and contains no remaining audio files.
pub async fn remove_album_directory_if_safe(file_paths: &[PathBuf], root_dir: &Path) {
    let Ok(real_root) = tokio::fs::canonicalize(root_dir).await else {
        return;
    };

    let dirs: HashSet<PathBuf> = file_paths
        .iter()
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .collect();
    if dirs.len() != 1 {
        return;
    }
    let album_dir = dirs.into_iter().next().unwrap();
    if !is_path_within_root(&album_dir, &real_root) {
        return;
    }

    let Ok(rel) = album_dir.strip_prefix(&real_root) else {
        return;
    };
    if rel.components().count() < 2 {
        return;
    }

    let Ok(sym_meta) = tokio::fs::symlink_metadata(&album_dir).await else {
        return;
    };
    if !sym_meta.is_dir() || sym_meta.file_type().is_symlink() {
        return;
    }

    let Ok(mut rd) = tokio::fs::read_dir(&album_dir).await else {
        return;
    };
    let extra_audio = ["aac", "wma", "aiff", "alac", "ape"];
    let mut sidecars = Vec::new();

    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(ft) = entry.file_type().await else {
            return;
        };
        if !ft.is_file() {
            return;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if SUPPORTED_AUDIO_EXTENSIONS.contains(&ext.as_str())
            || extra_audio.contains(&ext.as_str())
        {
            return;
        }
        sidecars.push(path);
    }

    for sc in sidecars {
        let _ = tokio::fs::remove_file(sc).await;
    }
    let _ = tokio::fs::remove_dir(&album_dir).await;
}
