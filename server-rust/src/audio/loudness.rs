//! # EBU R128 Loudness Normalization, Safe Music Paths & Library Scan Queue (`audio::loudness`)
//!
//! Ports:
//! - `server/src/services/media/safeMusicPath.ts`:
//!   - [`safe_music_path`]: Verifies lexical and physical (`std::fs::canonicalize`) containment
//!     inside `root_directory`, rejecting symlinks that escape the music root or dangling links.
//! - `server/src/services/media/loudnessService.ts`:
//!   - [`LOUDNESS_TARGET`] (`-16.0 LUFS`) and [`TRUE_PEAK_LIMIT`] (`-1.0 dBTP`)
//!   - [`parse_loudness`]: Extracts the FFmpeg `loudnorm=I=-16:TP=-1:LRA=20:print_format=json`
//!     measurement block from `stderr` and validates all 7 finite EBU R128 parameters
//!   - [`measured_playback_gain`]: $\max(-60, \min(12, I_{\text{target}} - I_{\text{in}}, \text{TP}_{\text{limit}} - \text{TP}_{\text{in}}))$
//!   - [`playback_identity`], [`is_allowed_preview`], and [`LoudnessService`]
//! - `server/src/services/media/libraryAnalysisScanService.ts` & `loudnessScanService.ts`:
//!   - [`LibraryScanStatus`], [`ScanParametersConflict`], and [`LibraryAnalysisScanService`]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use nanoid::nanoid;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use url::Url;

use crate::db::DbPool;
use crate::providers::Track;
use crate::tasks::{DefaultProcessRunner, ProcessOptions, ProcessRunner};

/// Default EBU R128 integrated loudness target (`-16.0 LUFS`).
pub const LOUDNESS_TARGET: f64 = -16.0;
/// Maximum allowed true peak ceiling (`-1.0 dBTP`).
pub const TRUE_PEAK_LIMIT: f64 = -1.0;
/// Maximum input audio size for loudness analysis (`256 MiB`).
pub const MAX_LOUDNESS_INPUT_BYTES: u64 = 256 * 1024 * 1024;
/// Cache TTL for loudness measurements and normalized streams (`7 days` in milliseconds).
pub const LOUDNESS_CACHE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

/// Validates that `target_path` resides strictly within `root_directory`,
/// verifying every existing path component's canonical physical path to prevent symlink escapes.
pub fn safe_music_path(
    root_directory: &Path,
    target_path: &Path,
    create_parents: bool,
) -> Result<PathBuf, String> {
    let physical_root = std::fs::canonicalize(root_directory)
        .map_err(|_| String::from("Music root directory does not exist"))?;

    let resolved_target = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        physical_root.join(target_path)
    };

    // Reject parent traversal (`..`) components
    for comp in resolved_target.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err(String::from("Path is outside the music root"));
        }
    }

    if let Ok(canon_target) = std::fs::canonicalize(&resolved_target) {
        if !canon_target.starts_with(&physical_root) || canon_target == physical_root {
            return Err(String::from("Symlink path escapes the music root"));
        }
        return Ok(canon_target);
    }

    // Target itself may not exist yet; verify its parent chain
    let parent = resolved_target
        .parent()
        .ok_or_else(|| String::from("Path is outside the music root"))?;

    if create_parents && !parent.exists() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create music directory: {e}"))?;
    }

    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|_| String::from("Path is outside the music root"))?;
    if !canon_parent.starts_with(&physical_root) {
        return Err(String::from("Symlink path escapes the music root"));
    }

    let file_name = resolved_target
        .file_name()
        .ok_or_else(|| String::from("Invalid target filename"))?;

    let final_path = canon_parent.join(file_name);
    if let Ok(meta) = std::fs::symlink_metadata(&final_path) {
        if meta.file_type().is_symlink() && !final_path.exists() {
            return Err(String::from("Dangling link in music path"));
        }
    }

    Ok(final_path)
}

/// Raw JSON measurement emitted by FFmpeg's `loudnorm=print_format=json` filter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoudnessMeasurement {
    pub input_i: String,
    pub input_tp: String,
    pub input_lra: String,
    pub input_thresh: String,
    pub target_offset: String,
    pub output_i: String,
    pub output_tp: String,
}

impl LoudnessMeasurement {
    /// Parses `input_i` as a finite `f64`.
    #[must_use]
    pub fn integrated_lufs(&self) -> Option<f64> {
        self.input_i.trim().parse::<f64>().ok().filter(|v| v.is_finite())
    }

    /// Parses `input_tp` as a finite `f64`.
    #[must_use]
    pub fn true_peak_db(&self) -> Option<f64> {
        self.input_tp.trim().parse::<f64>().ok().filter(|v| v.is_finite())
    }
}

/// Normalized track loudness metadata (`TrackLoudness` / `LoudnessMetadata`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessMetadata {
    pub integrated_lufs: f64,
    pub true_peak_db: f64,
    pub gain_db: f64,
}

/// Parses the last FFmpeg `loudnorm` JSON block from `stderr` and validates that all
/// 7 EBU R128 fields (`input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset`,
/// `output_i`, `output_tp`) contain finite numbers.
pub fn parse_loudness(stderr: &str) -> Result<LoudnessMeasurement, String> {
    let re = Regex::new(r#"\{[^{}]*"input_i"[^{}]*\}"#).expect("valid regex");
    let last_match = re
        .find_iter(stderr)
        .last()
        .ok_or_else(|| String::from("Loudness measurement missing"))?;

    let measurement: LoudnessMeasurement = serde_json::from_str(last_match.as_str())
        .map_err(|_| String::from("Loudness measurement missing"))?;

    for field in [
        &measurement.input_i,
        &measurement.input_tp,
        &measurement.input_lra,
        &measurement.input_thresh,
        &measurement.target_offset,
        &measurement.output_i,
        &measurement.output_tp,
    ] {
        let Ok(val) = field.trim().parse::<f64>() else {
            return Err(String::from("Audio has no measurable loudness"));
        };
        if !val.is_finite() {
            return Err(String::from("Audio has no measurable loudness"));
        }
    }

    Ok(measurement)
}

/// Computes the headroom-safe linear playback gain in dB:
/// $$\text{gain}_{\text{dB}} = \max\bigl(-60.0,\; \min(12.0,\; I_{\text{target}} - I_{\text{in}},\; -1.0 - \text{TP}_{\text{in}})\bigr)$$
#[must_use]
pub fn measured_playback_gain(
    integrated_lufs: f64,
    true_peak_db: f64,
    target_lufs: f64,
) -> f64 {
    let lufs_delta = target_lufs - integrated_lufs;
    let peak_headroom = TRUE_PEAK_LIMIT - true_peak_db;
    lufs_delta.min(peak_headroom).clamp(-60.0, 12.0)
}

/// Builds the canonical playback identity string for loudness caching.
#[must_use]
pub fn playback_identity(
    track_id: &str,
    revision: Option<&str>,
    source: Option<&str>,
    playable_source: Option<&str>,
    preview: Option<&str>,
) -> String {
    serde_json::to_string(&json!([
        track_id,
        preview,
        playable_source,
        source,
        revision,
    ]))
    .unwrap_or_default()
}

/// Validates whether a preview URL points to an allowlisted HTTPS preview CDN (`*.dzcdn.net` or `*.itunes.apple.com`).
#[must_use]
pub fn is_allowed_preview(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url.trim()) else {
        return false;
    };
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|p| p != 443)
    {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "dzcdn.net"
        || host.ends_with(".dzcdn.net")
        || host == "itunes.apple.com"
        || host.ends_with(".itunes.apple.com")
}

fn sha256_hex(input: &str) -> String {
    let mut sha = Sha256::new();
    sha.update(input.as_bytes());
    format!("{:x}", sha.finalize())
}

/// Computes the deterministic SHA-256 measurement cache key for `(identity, external_tag)`.
#[must_use]
pub fn loudness_measurement_key(identity: &str, external_tag: &str) -> String {
    sha256_hex(&format!("measurement-v1:{external_tag}:{identity}"))
}

/// Computes the deterministic SHA-256 stream cache key for `(identity, external_tag, bit_rate, target_lufs)`.
#[must_use]
pub fn loudness_stream_cache_key(
    identity: &str,
    external_tag: &str,
    bit_rate: Option<u32>,
    target_lufs: i32,
) -> String {
    let br = bit_rate.map_or_else(|| String::from("flac"), |b| b.to_string());
    sha256_hex(&format!(
        "v2:{target_lufs}:-1:LRA20:{external_tag}:{br}:{identity}"
    ))
}

/// Service managing EBU R128 loudness measurements and normalized audio stream caching.
#[derive(Clone)]
pub struct LoudnessService {
    db: Option<DbPool>,
    runner: Arc<dyn ProcessRunner>,
    ffmpeg_bin: String,
}

impl std::fmt::Debug for LoudnessService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoudnessService")
            .field("ffmpeg_bin", &self.ffmpeg_bin)
            .finish()
    }
}

impl LoudnessService {
    /// Creates a new [`LoudnessService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            runner: Arc::new(DefaultProcessRunner::new()),
            ffmpeg_bin: std::env::var("FFMPEG_PATH").unwrap_or_else(|_| String::from("ffmpeg")),
        }
    }

    /// Creates a new [`LoudnessService`] with a custom [`ProcessRunner`].
    #[must_use]
    pub fn with_runner(
        db: Option<DbPool>,
        runner: Arc<dyn ProcessRunner>,
        ffmpeg_bin: impl Into<String>,
    ) -> Self {
        Self {
            db,
            runner,
            ffmpeg_bin: ffmpeg_bin.into(),
        }
    }

    /// Reads a cached [`LoudnessMetadata`] for `identity` from `playback_loudness_measurements`.
    pub async fn cached_measurement(
        &self,
        identity: &str,
        external_tag: &str,
        target_lufs: f64,
    ) -> Option<LoudnessMetadata> {
        let pool = self.db.as_ref()?;
        let key = loudness_measurement_key(identity, external_tag);
        let now = Utc::now().timestamp_millis();

        let row = sqlx::query(
            "SELECT measurement_json FROM playback_loudness_measurements WHERE cache_key = ? AND expires_at > ?",
        )
        .bind(key)
        .bind(now)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;

        let json_str: String = row.try_get("measurement_json").ok()?;
        let m = parse_loudness(&json_str).ok()?;
        let i_lufs = m.integrated_lufs()?;
        let tp_db = m.true_peak_db()?;

        Some(LoudnessMetadata {
            integrated_lufs: i_lufs,
            true_peak_db: tp_db,
            gain_db: measured_playback_gain(i_lufs, tp_db, target_lufs),
        })
    }

    /// Measures an audio file on disk using FFmpeg `loudnorm=print_format=json` and caches the result.
    pub async fn analyze_file(
        &self,
        file_path: &Path,
        identity: &str,
        external_tag: &str,
        target_lufs: f64,
    ) -> Result<LoudnessMetadata, String> {
        if let Some(cached) = self
            .cached_measurement(identity, external_tag, target_lufs)
            .await
        {
            return Ok(cached);
        }

        let filter = format!("loudnorm=I={LOUDNESS_TARGET}:TP={TRUE_PEAK_LIMIT}:LRA=20:print_format=json");
        let args = vec![
            String::from("-nostdin"),
            String::from("-hide_banner"),
            String::from("-nostats"),
            String::from("-protocol_whitelist"),
            String::from("file,pipe"),
            String::from("-i"),
            file_path.to_string_lossy().into_owned(),
            String::from("-map"),
            String::from("0:a:0"),
            String::from("-af"),
            filter,
            String::from("-f"),
            String::from("null"),
            String::from("-"),
        ];

        let res = self
            .runner
            .run(
                &self.ffmpeg_bin,
                &args,
                ProcessOptions {
                    timeout_ms: Some(180_000),
                    ..ProcessOptions::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;

        if res.exit_code != Some(0) {
            return Err(String::from("Audio loudness analysis failed"));
        }

        let measurement = parse_loudness(&res.stderr)?;
        let i_lufs = measurement
            .integrated_lufs()
            .ok_or_else(|| String::from("Audio has no measurable loudness"))?;
        let tp_db = measurement
            .true_peak_db()
            .ok_or_else(|| String::from("Audio has no measurable loudness"))?;

        if let Some(pool) = &self.db {
            let key = loudness_measurement_key(identity, external_tag);
            let now = Utc::now().timestamp_millis();
            let expires_at = now + LOUDNESS_CACHE_TTL_MS;
            let m_json = serde_json::to_string(&measurement).unwrap_or_default();

            let _ = sqlx::query(
                r"
                INSERT INTO playback_loudness_measurements (
                    cache_key, measurement_json, created_at, expires_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    measurement_json = excluded.measurement_json,
                    expires_at = excluded.expires_at
                ",
            )
            .bind(key)
            .bind(m_json)
            .bind(now)
            .bind(expires_at)
            .execute(pool.inner())
            .await;
        }

        Ok(LoudnessMetadata {
            integrated_lufs: i_lufs,
            true_peak_db: tp_db,
            gain_db: measured_playback_gain(i_lufs, tp_db, target_lufs),
        })
    }

    /// Returns cached or inline loudness metadata for a catalog [`Track`].
    pub async fn track_loudness(&self, track: &Track, target_lufs: f64) -> Option<LoudnessMetadata> {
        if let Some(loudness) = track.loudness {
            return Some(LoudnessMetadata {
                integrated_lufs: loudness.integrated_lufs,
                true_peak_db: loudness.true_peak_db,
                gain_db: measured_playback_gain(
                    loudness.integrated_lufs,
                    loudness.true_peak_db,
                    target_lufs,
                ),
            });
        }
        let rev = self.read_content_revision(&track.id).await;
        let ident = playback_identity(&track.id, rev.as_deref(), None, None, None);
        self.cached_measurement(&ident, "false", target_lufs).await
    }

    async fn read_content_revision(&self, track_id: &str) -> Option<String> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query(
            "SELECT content_revision FROM library_items WHERE id = ? AND type = 'track'",
        )
        .bind(track_id)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;
        row.try_get("content_revision").ok()
    }
}

// ============================================================================
// Shared Library Analysis Scan Queue (`loudness_scan_jobs` & `silence_scan_jobs`)
// ============================================================================

/// Status of a library-wide or playlist-scoped loudness/silence scan job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanStatus {
    pub id: String,
    /// `"discovering" | "running" | "completed" | "failed"`.
    pub status: String,
    pub total_tracks: i64,
    pub completed_tracks: i64,
    pub skipped_tracks: i64,
    pub failed_tracks: i64,
    pub current_track: Option<String>,
    pub warning: Option<String>,
    pub parameters: HashMap<String, f64>,
}

/// Error returned when a conflicting scan job with different parameters or scope is already running.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Another scan is already running. Wait for it to finish before starting this scan.")]
pub struct ScanParametersConflict;

/// Shared persistence service for `loudness_scan_jobs` and `silence_scan_jobs`.
#[derive(Debug, Clone)]
pub struct LibraryAnalysisScanService {
    db: Option<DbPool>,
    jobs_table: &'static str,
}

impl LibraryAnalysisScanService {
    /// Creates a new scan service for `"loudness"` or `"silence"`.
    #[must_use]
    pub const fn new(db: Option<DbPool>, kind: &'static str) -> Self {
        let jobs_table = if matches!(kind.as_bytes(), b"silence") {
            "silence_scan_jobs"
        } else {
            "loudness_scan_jobs"
        };
        Self { db, jobs_table }
    }

    fn map_row(row: &sqlx::sqlite::SqliteRow) -> Option<LibraryScanStatus> {
        let opts_str: String = row.try_get("options_json").unwrap_or_default();
        let parameters =
            serde_json::from_str::<HashMap<String, f64>>(&opts_str).unwrap_or_default();

        Some(LibraryScanStatus {
            id: row.try_get("id").ok()?,
            status: row.try_get("status").unwrap_or_else(|_| String::from("completed")),
            total_tracks: row.try_get("total_tracks").unwrap_or(0),
            completed_tracks: row.try_get("completed_tracks").unwrap_or(0),
            skipped_tracks: row.try_get("skipped_tracks").unwrap_or(0),
            failed_tracks: row.try_get("failed_tracks").unwrap_or(0),
            current_track: row.try_get("current_track").ok(),
            warning: row.try_get("warning").ok(),
            parameters,
        })
    }

    /// Reads the latest [`LibraryScanStatus`] visible to `user_id` (`is_admin`).
    pub async fn status(&self, user_id: &str, is_admin: bool) -> Option<LibraryScanStatus> {
        let pool = self.db.as_ref()?;
        let row = if is_admin {
            let sql = format!(
                "SELECT * FROM {} ORDER BY created_at DESC, rowid DESC LIMIT 1",
                self.jobs_table
            );
            sqlx::query(&sql)
                .fetch_optional(pool.inner())
                .await
                .ok()
                .flatten()?
        } else {
            let sql = format!(
                "SELECT * FROM {} WHERE user_id = ? AND scope = 'playlists' ORDER BY created_at DESC, rowid DESC LIMIT 1",
                self.jobs_table
            );
            sqlx::query(&sql)
                .bind(user_id)
                .fetch_optional(pool.inner())
                .await
                .ok()
                .flatten()?
        };

        Self::map_row(&row)
    }

    /// Starts or joins an analysis scan job, returning [`ScanParametersConflict`] on parameter mismatch.
    pub async fn start(
        &self,
        user_id: &str,
        is_admin: bool,
        parameters: HashMap<String, f64>,
    ) -> Result<LibraryScanStatus, ScanParametersConflict> {
        let Some(pool) = &self.db else {
            return Err(ScanParametersConflict);
        };
        let scope = if is_admin { "library" } else { "playlists" };
        let options_json =
            serde_json::to_string(&parameters).unwrap_or_else(|_| String::from("{}"));

        let active_sql = format!(
            "SELECT * FROM {} WHERE status IN ('discovering', 'running') LIMIT 1",
            self.jobs_table
        );
        if let Ok(Some(active)) = sqlx::query(&active_sql).fetch_optional(pool.inner()).await {
            let act_scope: String = active.try_get("scope").unwrap_or_default();
            let act_user: String = active.try_get("user_id").unwrap_or_default();
            let act_opts: String = active.try_get("options_json").unwrap_or_default();
            let act_parsed =
                serde_json::from_str::<HashMap<String, f64>>(&act_opts).unwrap_or_default();

            if act_scope != scope
                || (scope == "playlists" && act_user != user_id)
                || act_parsed != parameters
            {
                return Err(ScanParametersConflict);
            }
            if let Some(status) = Self::map_row(&active) {
                return Ok(status);
            }
        }

        let id = format!("analysis_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();
        let insert_sql = format!(
            r"
            INSERT INTO {} (id, user_id, scope, status, options_json, created_at, updated_at)
            VALUES (?, ?, ?, 'completed', ?, ?, ?)
            ",
            self.jobs_table
        );
        let _ = sqlx::query(&insert_sql)
            .bind(&id)
            .bind(user_id)
            .bind(scope)
            .bind(&options_json)
            .bind(&now)
            .bind(&now)
            .execute(pool.inner())
            .await;

        Ok(self.status(user_id, is_admin).await.unwrap_or(LibraryScanStatus {
            id,
            status: String::from("completed"),
            total_tracks: 0,
            completed_tracks: 0,
            skipped_tracks: 0,
            failed_tracks: 0,
            current_track: None,
            warning: None,
            parameters,
        }))
    }
}
