//! # Lead-In/Lead-Out Silence Detection & Gapless Trim Bounds (`audio::silence`)
//!
//! Ports `server/src/domain/silence-analysis.ts`:
//! - [`DEFAULT_SILENCE_THRESHOLD_DB`] (`-35.0 dB`) and [`DEFAULT_MIN_SILENCE_SECONDS`] (`0.5 s`)
//! - [`SilenceParameters`], [`SilenceInterval`], [`SilenceTrimBounds`], [`SilenceAnalysisRow`]
//! - [`parse_silence_intervals`]: Extracts `silence_start` and `silence_end` pairs from
//!   FFmpeg `silencedetect` stderr output (supporting open-ended final intervals)
//! - [`parse_duration_seconds`]: Parses `Duration: HH:MM:SS.ms` from FFmpeg stderr
//! - [`derive_trim_bounds`]: Computes leading silence (`first.start <= 0.05s`) and trailing
//!   silence (`last.end == None` or `duration - last.end <= 0.25s`), ignoring mid-track musical pauses
//! - [`SilenceAnalysisService`]: Persists analysis in `track_silence_analysis` and
//!   `track_silence_analysis_profiles`

use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::db::DbPool;
use crate::tasks::{DefaultProcessRunner, ProcessOptions, ProcessRunner};

/// Default silence detection noise threshold (`-35.0 dB`).
pub const DEFAULT_SILENCE_THRESHOLD_DB: f64 = -35.0;
/// Default minimum silence duration in seconds (`0.5 s`).
pub const DEFAULT_MIN_SILENCE_SECONDS: f64 = 0.5;

/// Validated parameters for FFmpeg `silencedetect`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceParameters {
    pub threshold_db: f64,
    pub min_silence_seconds: f64,
}

impl Default for SilenceParameters {
    fn default() -> Self {
        Self {
            threshold_db: DEFAULT_SILENCE_THRESHOLD_DB,
            min_silence_seconds: DEFAULT_MIN_SILENCE_SECONDS,
        }
    }
}

impl SilenceParameters {
    /// Validates and constructs [`SilenceParameters`] (`threshold_db` in `[-100, 0]`, `min_silence_seconds` in `(0, 30]`).
    pub fn validate(
        threshold_db: Option<f64>,
        min_silence_seconds: Option<f64>,
    ) -> Result<Self, String> {
        let t_db = threshold_db.unwrap_or(DEFAULT_SILENCE_THRESHOLD_DB);
        let min_s = min_silence_seconds.unwrap_or(DEFAULT_MIN_SILENCE_SECONDS);
        if !t_db.is_finite()
            || !(-100.0..=0.0).contains(&t_db)
            || !min_s.is_finite()
            || min_s <= 0.0
            || min_s > 30.0
        {
            return Err(String::from("Invalid silence analysis settings"));
        }
        Ok(Self {
            threshold_db: t_db,
            min_silence_seconds: min_s,
        })
    }
}

/// Detected silence interval (`[start, end]`) in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceInterval {
    pub start: f64,
    pub end: Option<f64>,
}

/// Derived leading and trailing dead-air trim bounds in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceTrimBounds {
    pub leading_silence_seconds: f64,
    pub trailing_silence_seconds: f64,
}

/// Persisted track silence analysis record (`SilenceAnalysisRow`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceAnalysisRow {
    pub track_id: String,
    /// `"completed" | "failed" | "unavailable"`.
    pub status: String,
    pub leading_silence_seconds: Option<f64>,
    pub trailing_silence_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub threshold_db: f64,
    pub min_silence_seconds: f64,
    pub error_message: Option<String>,
    pub analyzed_at: String,
    pub updated_at: String,
}

/// Parses FFmpeg `silencedetect` stderr output into ordered [`SilenceInterval`] pairs.
#[must_use]
pub fn parse_silence_intervals(stderr: &str) -> Vec<SilenceInterval> {
    let start_re = Regex::new(r"silence_start:\s*(-?\d+(?:\.\d+)?)").expect("valid regex");
    let end_re = Regex::new(r"silence_end:\s*(-?\d+(?:\.\d+)?)").expect("valid regex");

    let starts: Vec<f64> = start_re
        .captures_iter(stderr)
        .filter_map(|cap| cap.get(1)?.as_str().parse::<f64>().ok())
        .collect();
    let ends: Vec<f64> = end_re
        .captures_iter(stderr)
        .filter_map(|cap| cap.get(1)?.as_str().parse::<f64>().ok())
        .collect();

    starts
        .into_iter()
        .enumerate()
        .map(|(idx, start)| SilenceInterval {
            start,
            end: ends.get(idx).copied(),
        })
        .collect()
}

/// Parses the `Duration: HH:MM:SS.ms` line emitted by FFmpeg on stderr.
#[must_use]
pub fn parse_duration_seconds(stderr: &str) -> Option<f64> {
    let re = Regex::new(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)").expect("valid regex");
    let caps = re.captures(stderr)?;
    let hours = caps.get(1)?.as_str().parse::<f64>().ok()?;
    let minutes = caps.get(2)?.as_str().parse::<f64>().ok()?;
    let seconds = caps.get(3)?.as_str().parse::<f64>().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Derives leading and trailing silence durations from `intervals` and `duration_seconds`.
///
/// Only silence touching the track start (`first.start <= 0.05s`) or track end
/// (`last.end == None` or `duration - last.end <= 0.25s`) counts as trimmable dead air.
#[must_use]
pub fn derive_trim_bounds(
    intervals: &[SilenceInterval],
    duration_seconds: Option<f64>,
) -> SilenceTrimBounds {
    let mut leading_silence_seconds = 0.0_f64;
    let mut trailing_silence_seconds = 0.0_f64;

    if let Some(first) = intervals.first() {
        if first.start <= 0.05 {
            if let Some(end) = first.end {
                leading_silence_seconds = (end - first.start).max(0.0);
            }
        }
    }

    if let (Some(last), Some(dur)) = (intervals.last(), duration_seconds) {
        match last.end {
            None => {
                trailing_silence_seconds = (dur - last.start).max(0.0);
            }
            Some(end) if dur - end <= 0.25 => {
                trailing_silence_seconds = (dur - last.start).max(0.0);
            }
            _ => {}
        }
    }

    SilenceTrimBounds {
        leading_silence_seconds,
        trailing_silence_seconds,
    }
}

/// Service executing FFmpeg `silencedetect` and persisting trim bounds in SQLite.
#[derive(Clone)]
pub struct SilenceAnalysisService {
    db: Option<DbPool>,
    runner: Arc<dyn ProcessRunner>,
    ffmpeg_bin: String,
}

impl std::fmt::Debug for SilenceAnalysisService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SilenceAnalysisService")
            .field("ffmpeg_bin", &self.ffmpeg_bin)
            .finish()
    }
}

impl SilenceAnalysisService {
    /// Creates a new [`SilenceAnalysisService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            runner: Arc::new(DefaultProcessRunner::new()),
            ffmpeg_bin: std::env::var("FFMPEG_PATH").unwrap_or_else(|_| String::from("ffmpeg")),
        }
    }

    /// Creates a new [`SilenceAnalysisService`] with a custom [`ProcessRunner`].
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

    async fn revision(&self, track_id: &str) -> String {
        let Some(pool) = &self.db else {
            return String::new();
        };
        sqlx::query("SELECT content_revision FROM library_items WHERE id = ? AND type = 'track'")
            .bind(track_id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<String, _>("content_revision").ok())
            .unwrap_or_default()
    }

    /// Retrieves cached silence analysis for `track_id` (optionally scoped to specific `params`).
    pub async fn get_analysis(
        &self,
        track_id: &str,
        params: Option<SilenceParameters>,
    ) -> Option<SilenceAnalysisRow> {
        let pool = self.db.as_ref()?;
        if let Some(p) = params {
            let rev = self.revision(track_id).await;
            let row = sqlx::query(
                r"
                SELECT analysis_json FROM track_silence_analysis_profiles
                WHERE track_id = ? AND threshold_db = ? AND min_silence_seconds = ? AND revision = ?
                ",
            )
            .bind(track_id)
            .bind(p.threshold_db)
            .bind(p.min_silence_seconds)
            .bind(rev)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()?;
            let json_str: String = row.try_get("analysis_json").ok()?;
            return serde_json::from_str::<SilenceAnalysisRow>(&json_str).ok();
        }

        let row = sqlx::query("SELECT * FROM track_silence_analysis WHERE track_id = ?")
            .bind(track_id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()?;

        Some(SilenceAnalysisRow {
            track_id: row.try_get("track_id").ok()?,
            status: row.try_get("status").ok()?,
            leading_silence_seconds: row.try_get("leading_silence_seconds").ok(),
            trailing_silence_seconds: row.try_get("trailing_silence_seconds").ok(),
            duration_seconds: row.try_get("duration_seconds").ok(),
            threshold_db: row.try_get("threshold_db").unwrap_or(DEFAULT_SILENCE_THRESHOLD_DB),
            min_silence_seconds: row
                .try_get("min_silence_seconds")
                .unwrap_or(DEFAULT_MIN_SILENCE_SECONDS),
            error_message: row.try_get("error_message").ok(),
            analyzed_at: row.try_get("analyzed_at").unwrap_or_default(),
            updated_at: row.try_get("updated_at").unwrap_or_default(),
        })
    }

    /// Analyzes a local audio file on disk for lead-in/lead-out silence and persists the result.
    pub async fn analyze_file(
        &self,
        track_id: &str,
        file_path: &Path,
        params: SilenceParameters,
    ) -> SilenceAnalysisRow {
        let now = Utc::now().to_rfc3339();
        let rev = self.revision(track_id).await;

        let filter = format!(
            "silencedetect=noise={}dB:d={}",
            params.threshold_db, params.min_silence_seconds
        );
        let args = vec![
            String::from("-nostdin"),
            String::from("-hide_banner"),
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

        let outcome = self
            .runner
            .run(
                &self.ffmpeg_bin,
                &args,
                ProcessOptions {
                    timeout_ms: Some(60_000),
                    ..ProcessOptions::default()
                },
            )
            .await;

        let row = match outcome {
            Ok(res) if res.exit_code == Some(0) => {
                let dur = parse_duration_seconds(&res.stderr);
                let intervals = parse_silence_intervals(&res.stderr);
                let bounds = derive_trim_bounds(&intervals, dur);
                SilenceAnalysisRow {
                    track_id: track_id.to_owned(),
                    status: String::from("completed"),
                    leading_silence_seconds: Some(bounds.leading_silence_seconds),
                    trailing_silence_seconds: Some(bounds.trailing_silence_seconds),
                    duration_seconds: dur,
                    threshold_db: params.threshold_db,
                    min_silence_seconds: params.min_silence_seconds,
                    error_message: None,
                    analyzed_at: now.clone(),
                    updated_at: now,
                }
            }
            Ok(_) => SilenceAnalysisRow {
                track_id: track_id.to_owned(),
                status: String::from("failed"),
                leading_silence_seconds: None,
                trailing_silence_seconds: None,
                duration_seconds: None,
                threshold_db: params.threshold_db,
                min_silence_seconds: params.min_silence_seconds,
                error_message: Some(String::from("FFmpeg silence analysis failed")),
                analyzed_at: now.clone(),
                updated_at: now,
            },
            Err(err) => SilenceAnalysisRow {
                track_id: track_id.to_owned(),
                status: String::from("failed"),
                leading_silence_seconds: None,
                trailing_silence_seconds: None,
                duration_seconds: None,
                threshold_db: params.threshold_db,
                min_silence_seconds: params.min_silence_seconds,
                error_message: Some(err.to_string()),
                analyzed_at: now.clone(),
                updated_at: now,
            },
        };

        self.persist_row(&row, &rev).await;
        row
    }

    async fn persist_row(&self, row: &SilenceAnalysisRow, revision: &str) {
        let Some(pool) = &self.db else {
            return;
        };
        let _ = sqlx::query(
            r"
            INSERT INTO track_silence_analysis (
                track_id, status, leading_silence_seconds, trailing_silence_seconds,
                duration_seconds, threshold_db, min_silence_seconds, error_message,
                analyzed_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(track_id) DO UPDATE SET
                status = excluded.status,
                leading_silence_seconds = excluded.leading_silence_seconds,
                trailing_silence_seconds = excluded.trailing_silence_seconds,
                duration_seconds = excluded.duration_seconds,
                threshold_db = excluded.threshold_db,
                min_silence_seconds = excluded.min_silence_seconds,
                error_message = excluded.error_message,
                analyzed_at = excluded.analyzed_at,
                updated_at = excluded.updated_at
            ",
        )
        .bind(&row.track_id)
        .bind(&row.status)
        .bind(row.leading_silence_seconds)
        .bind(row.trailing_silence_seconds)
        .bind(row.duration_seconds)
        .bind(row.threshold_db)
        .bind(row.min_silence_seconds)
        .bind(&row.error_message)
        .bind(&row.analyzed_at)
        .bind(&row.updated_at)
        .execute(pool.inner())
        .await;

        let json_str = serde_json::to_string(row).unwrap_or_default();
        let _ = sqlx::query(
            r"
            INSERT OR REPLACE INTO track_silence_analysis_profiles (
                track_id, threshold_db, min_silence_seconds, revision, analysis_json
            )
            VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(&row.track_id)
        .bind(row.threshold_db)
        .bind(row.min_silence_seconds)
        .bind(revision)
        .bind(json_str)
        .execute(pool.inner())
        .await;
    }
}
