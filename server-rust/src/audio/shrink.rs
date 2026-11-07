//! # Library Storage Optimizer & Provenance-Verified FLAC-to-MP3 Transcoder (`audio::shrink`)
//!
//! Ports `server/src/domain/library-shrink.ts`:
//! - [`ShrinkOptions`], [`ShrinkFailure`], and [`ShrinkResult`]
//! - [`shrink_spotdl_library`]:
//!   - Walks `music_root` without following symlinks, collecting `.flac` files and `.m3u`/`.m3u8` manifests
//!   - Verifies spotDL provenance via `acquisition_jobs` (`source_provider = 'spotdl' AND status = 'completed'`)
//!     or legacy `spimp_*/musicdeck-source.spotdl` marker files (unless `include_all_flacs == true`)
//!   - Transcodes eligible `.flac` files to `320 kbps` MP3 (`libmp3lame`, `-id3v2_version 3`,
//!     preserving attached cover art and metadata) into a sibling temporary file
//!   - Verifies the output is smaller than the source and the source `.flac` did not change during transcoding
//!   - Exclusively links (`hard_link`) the destination `.mp3`, atomically updates `.m3u`/`.m3u8` manifests,
//!     and removes the original `.flac`

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::db::DbPool;
use crate::tasks::{DefaultProcessRunner, ProcessOptions, ProcessRunner};

/// Individual file conversion failure recorded during [`shrink_spotdl_library`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkFailure {
    pub path: String,
    pub reason: String,
}

/// Summary report returned by [`shrink_spotdl_library`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkResult {
    pub scanned_flacs: usize,
    pub eligible_flacs: usize,
    pub unverified_flacs: usize,
    pub converted: usize,
    pub skipped_existing_mp3: usize,
    pub bytes_saved: u64,
    pub failures: Vec<ShrinkFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rescan_error: Option<String>,
}

/// Configuration options for [`shrink_spotdl_library`].
#[derive(Clone)]
pub struct ShrinkOptions {
    pub music_root: PathBuf,
    pub import_subdir: String,
    pub db: Option<DbPool>,
    pub ffmpeg_path: String,
    pub apply: bool,
    pub include_all_flacs: bool,
    pub runner: Arc<dyn ProcessRunner>,
}

impl std::fmt::Debug for ShrinkOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShrinkOptions")
            .field("music_root", &self.music_root)
            .field("import_subdir", &self.import_subdir)
            .field("apply", &self.apply)
            .field("include_all_flacs", &self.include_all_flacs)
            .finish()
    }
}

impl ShrinkOptions {
    /// Creates default [`ShrinkOptions`] for `music_root` and `import_subdir`.
    #[must_use]
    pub fn new(
        music_root: PathBuf,
        import_subdir: impl Into<String>,
        db: Option<DbPool>,
    ) -> Self {
        Self {
            music_root,
            import_subdir: import_subdir.into(),
            db,
            ffmpeg_path: std::env::var("FFMPEG_PATH").unwrap_or_else(|_| String::from("ffmpeg")),
            apply: false,
            include_all_flacs: false,
            runner: Arc::new(DefaultProcessRunner::new()),
        }
    }
}

fn normalize_path_key(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}

fn within_root(file_path: &Path, root: &Path) -> bool {
    file_path.starts_with(root) && file_path != root
}

/// Builds the exact FFmpeg command-line arguments for converting a source `.flac` to a `320k` ID3v2.3 `.mp3`.
#[must_use]
pub fn ffmpeg_shrink_args(source: &Path, output: &Path) -> Vec<String> {
    vec![
        String::from("-nostdin"),
        String::from("-hide_banner"),
        String::from("-loglevel"),
        String::from("error"),
        String::from("-n"),
        String::from("-i"),
        source.to_string_lossy().into_owned(),
        String::from("-map"),
        String::from("0:a:0"),
        String::from("-map"),
        String::from("0:v?"),
        String::from("-codec:a"),
        String::from("libmp3lame"),
        String::from("-b:a"),
        String::from("320k"),
        String::from("-codec:v"),
        String::from("copy"),
        String::from("-disposition:v"),
        String::from("attached_pic"),
        String::from("-map_metadata"),
        String::from("0"),
        String::from("-id3v2_version"),
        String::from("3"),
        String::from("-f"),
        String::from("mp3"),
        output.to_string_lossy().into_owned(),
    ]
}

async fn walk_library(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut flacs = Vec::new();
    let mut manifests = Vec::new();
    let mut pending = vec![root.to_path_buf()];

    while let Some(dir) = pending.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                pending.push(path);
            } else if ft.is_file() {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ext == "flac" {
                    flacs.push(path);
                } else if ext == "m3u" || ext == "m3u8" {
                    manifests.push(path);
                }
            }
        }
    }

    flacs.sort();
    manifests.sort();
    (flacs, manifests)
}

async fn recorded_spotdl_paths(db: Option<&DbPool>, root: &Path) -> HashSet<String> {
    let mut recorded = HashSet::new();
    let Some(pool) = db else {
        return recorded;
    };

    let rows = sqlx::query(
        "SELECT files_json FROM acquisition_jobs WHERE source_provider = 'spotdl' AND status = 'completed'",
    )
    .fetch_all(pool.inner())
    .await
    .unwrap_or_default();

    for row in rows {
        let Ok(files_str) = row.try_get::<String, _>("files_json") else {
            continue;
        };
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&files_str) else {
            continue;
        };
        for item in items {
            let status = item.get("status").and_then(Value::as_str);
            let rel_path = item.get("path").and_then(Value::as_str);
            let (Some("imported"), Some(rel_path)) = (status, rel_path) else {
                continue;
            };
            let resolved = root.join(rel_path);
            if within_root(&resolved, root)
                && resolved
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("flac"))
            {
                recorded.insert(normalize_path_key(&resolved));
            }
        }
    }

    recorded
}

async fn is_legacy_spotdl_import(file_path: &Path, root: &Path, import_subdir: &str) -> bool {
    let import_root = root.join(import_subdir);
    if !within_root(&import_root, root) {
        return false;
    }
    let Ok(rel) = file_path.strip_prefix(&import_root) else {
        return false;
    };
    let mut comps = rel.components();
    let Some(first) = comps.next().and_then(|c| c.as_os_str().to_str()) else {
        return false;
    };
    if !first.starts_with("spimp_") || comps.next().is_none() {
        return false;
    }
    let marker = import_root.join(first).join("musicdeck-source.spotdl");
    tokio::fs::symlink_metadata(&marker)
        .await
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}

/// Atomically rewrites `.m3u` / `.m3u8` playlist manifest references from `source` (`.flac`) to `destination` (`.mp3`).
pub async fn rewrite_manifest_references(
    manifests: &[PathBuf],
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let source_key = normalize_path_key(source);

    for manifest in manifests {
        let Ok(original) = tokio::fs::read_to_string(manifest).await else {
            continue;
        };
        let Some(manifest_dir) = manifest.parent() else {
            continue;
        };

        let mut changed = false;
        let mut updated_lines = Vec::new();
        for line in original.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                updated_lines.push(line.to_owned());
                continue;
            }
            let candidate_path = Path::new(trimmed);
            let resolved = if candidate_path.is_absolute() {
                candidate_path.to_path_buf()
            } else {
                manifest_dir.join(trimmed)
            };
            if normalize_path_key(&resolved) != source_key {
                updated_lines.push(line.to_owned());
                continue;
            }

            changed = true;
            if candidate_path.is_absolute() {
                updated_lines.push(destination.to_string_lossy().into_owned());
            } else if let Ok(rel_dest) = destination.strip_prefix(manifest_dir) {
                updated_lines.push(rel_dest.to_string_lossy().replace('\\', "/"));
            } else {
                updated_lines.push(destination.to_string_lossy().into_owned());
            }
        }

        if !changed {
            continue;
        }

        let mut new_content = updated_lines.join("\n");
        if original.ends_with('\n') {
            new_content.push('\n');
        }

        let temp_manifest = manifest.with_extension(format!(
            "musicdeck-shrink-{}.tmp",
            Uuid::new_v4().simple()
        ));
        tokio::fs::write(&temp_manifest, new_content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&temp_manifest, manifest)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Scans `options.music_root` for eligible `.flac` files and optionally converts them to `320 kbps` `.mp3`.
pub async fn shrink_spotdl_library(options: &ShrinkOptions) -> Result<ShrinkResult, String> {
    let real_root = std::fs::canonicalize(&options.music_root)
        .map_err(|e| format!("Could not resolve music root: {e}"))?;

    let (flacs, manifests) = walk_library(&real_root).await;
    let recorded = recorded_spotdl_paths(options.db.as_ref(), &real_root).await;

    let mut eligible = Vec::new();
    for flac in &flacs {
        let is_eligible = options.include_all_flacs
            || recorded.contains(&normalize_path_key(flac))
            || is_legacy_spotdl_import(flac, &real_root, &options.import_subdir).await;
        if is_eligible {
            eligible.push(flac.clone());
        }
    }

    let mut result = ShrinkResult {
        scanned_flacs: flacs.len(),
        eligible_flacs: eligible.len(),
        unverified_flacs: flacs.len().saturating_sub(eligible.len()),
        converted: 0,
        skipped_existing_mp3: 0,
        bytes_saved: 0,
        failures: Vec::new(),
        rescan_error: None,
    };

    if !options.apply {
        return Ok(result);
    }

    for source in eligible {
        let destination = source.with_extension("mp3");
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            result.skipped_existing_mp3 += 1;
            continue;
        }

        let parent = source
            .parent()
            .unwrap_or(&real_root);
        let stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let temp_mp3 = parent.join(format!(
            ".{stem}.musicdeck-{}.mp3",
            Uuid::new_v4().simple()
        ));

        let conv_outcome: Result<u64, String> = async {
            let before_meta = tokio::fs::symlink_metadata(&source)
                .await
                .map_err(|_| String::from("Source is not a regular file"))?;
            if !before_meta.is_file() || before_meta.file_type().is_symlink() {
                return Err(String::from("Source is not a regular file"));
            }
            let before_size = before_meta.len();
            let before_modified = before_meta.modified().ok();

            let args = ffmpeg_shrink_args(&source, &temp_mp3);
            let proc_res = options
                .runner
                .run(&options.ffmpeg_path, &args, ProcessOptions::default())
                .await
                .map_err(|e| e.to_string())?;

            if proc_res.exit_code != Some(0) {
                return Err(format!(
                    "ffmpeg exited {:?}: {}",
                    proc_res.exit_code,
                    proc_res.stderr.trim()
                ));
            }

            let out_meta = tokio::fs::symlink_metadata(&temp_mp3)
                .await
                .map_err(|_| String::from("ffmpeg did not produce a valid MP3 file"))?;
            if !out_meta.is_file() || out_meta.file_type().is_symlink() || out_meta.len() == 0 {
                return Err(String::from("ffmpeg did not produce a valid MP3 file"));
            }
            if out_meta.len() >= before_size {
                return Err(String::from("MP3 is not smaller than the source FLAC"));
            }

            let after_meta = tokio::fs::symlink_metadata(&source)
                .await
                .map_err(|_| String::from("Source FLAC disappeared during conversion"))?;
            if after_meta.len() != before_size || after_meta.modified().ok() != before_modified {
                return Err(String::from("Source FLAC changed during conversion"));
            }

            tokio::fs::hard_link(&temp_mp3, &destination)
                .await
                .map_err(|e| format!("Could not link destination MP3: {e}"))?;
            rewrite_manifest_references(&manifests, &source, &destination).await?;
            tokio::fs::remove_file(&source)
                .await
                .map_err(|e| format!("Could not remove source FLAC: {e}"))?;

            Ok(before_size - out_meta.len())
        }
        .await;

        let _ = tokio::fs::remove_file(&temp_mp3).await;

        match conv_outcome {
            Ok(saved) => {
                result.converted += 1;
                result.bytes_saved += saved;
            }
            Err(reason) => {
                result.failures.push(ShrinkFailure {
                    path: source.to_string_lossy().into_owned(),
                    reason,
                });
            }
        }
    }

    Ok(result)
}
