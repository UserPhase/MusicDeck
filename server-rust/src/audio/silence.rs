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
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use super::ffmpeg::{AUDIO_INPUT_FORMATS, Ffmpeg};

use crate::catalog::{CandidateSource, SourceResolver};
use crate::db::{DbPool, begin_sqlite_write};
use crate::error::ServerError;
use crate::providers::{MEDIA_BODY_IDLE_TIMEOUT, MEDIA_HEADER_BUDGET};
use crate::streaming::http::bounded_media_body;
use crate::tasks::{DefaultProcessRunner, ProcessError, ProcessOptions, ProcessRunner};

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
    let start_re =
        Regex::new(r"silence_start:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)").expect("valid regex");
    let end_re =
        Regex::new(r"silence_end:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)").expect("valid regex");

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
    ffmpeg: Ffmpeg,
    slots: Arc<Semaphore>,
}

impl std::fmt::Debug for SilenceAnalysisService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SilenceAnalysisService")
            .field("ffmpeg", &self.ffmpeg)
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
            ffmpeg: Ffmpeg::from_env("silencedetect"),
            slots: Arc::new(Semaphore::new(2)),
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
            ffmpeg: Ffmpeg::configured("silencedetect", ffmpeg_bin.into()),
            slots: Arc::new(Semaphore::new(2)),
        }
    }

    /// Gets a cached profile for the current content revision. With no parameters, read the latest.
    pub async fn get_analysis(
        &self,
        track_id: &str,
        params: Option<SilenceParameters>,
    ) -> Result<Option<SilenceAnalysisRow>, ServerError> {
        let pool = self.db.as_ref().ok_or_else(silence_unavailable)?;
        let json = sqlx::query_scalar::<_, String>(
            "SELECT p.analysis_json FROM track_silence_analysis_profiles p
             JOIN library_items i ON i.id = p.track_id AND i.content_revision = p.revision
             JOIN track_silence_analysis a ON a.track_id = p.track_id
             WHERE p.track_id = ? AND i.type = 'track'
               AND p.threshold_db = COALESCE(?, a.threshold_db)
               AND p.min_silence_seconds = COALESCE(?, a.min_silence_seconds)",
        )
        .bind(track_id)
        .bind(params.map(|p| p.threshold_db))
        .bind(params.map(|p| p.min_silence_seconds))
        .fetch_optional(pool.inner())
        .await
        .map_err(silence_storage_error)?;
        json.map(|value| serde_json::from_str(&value).map_err(silence_storage_error))
            .transpose()
    }

    pub(crate) async fn analyze_track(
        &self,
        resolver: &SourceResolver,
        track_id: &str,
        params: SilenceParameters,
        force: bool,
        admission_wait: Duration,
    ) -> Result<(SilenceAnalysisRow, bool), ServerError> {
        if !force {
            if let Some(saved) = self.get_analysis(track_id, Some(params)).await? {
                if saved.status == "completed" {
                    return Ok((saved, true));
                }
            }
        }
        let pool = self.db.as_ref().ok_or_else(silence_unavailable)?;
        let revision = sqlx::query_scalar::<_, String>(
            "SELECT content_revision FROM library_items WHERE id = ? AND type = 'track'",
        )
        .bind(track_id)
        .fetch_optional(pool.inner())
        .await
        .map_err(silence_storage_error)?
        .ok_or_else(|| ServerError::NotFound("Library track not found".into()))?;

        let _permit = tokio::time::timeout(admission_wait, self.slots.acquire())
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| {
                ServerError::ServiceUnavailable(
                    "Silence analysis is busy. Try again shortly.".into(),
                )
            })?;
        let sources = resolver
            .try_candidate_sources(track_id, None)
            .await
            .map_err(|_| silence_unavailable())?;
        if sources.is_empty() {
            return Ok((unavailable_audio(track_id, params), false));
        }

        // A matching cache entry never requires FFmpeg. For new work, check the
        // decoder before fetching audio or opening a temporary file.
        let ffmpeg = self
            .ffmpeg
            .resolve(self.runner.as_ref())
            .await
            .map_err(ServerError::ServiceUnavailable)?;
        let (dir, path) =
            match tokio::time::timeout(Duration::from_secs(45), stage_audio(sources, track_id))
                .await
            {
                Ok(Ok(input)) => input,
                Ok(Err(StageError::Storage)) => {
                    return Err(ServerError::ServiceUnavailable(
                        "Could not stage audio for silence analysis".into(),
                    ));
                }
                Ok(Err(StageError::Audio)) => {
                    return Ok((unavailable_audio(track_id, params), false));
                }
                Err(_) => {
                    return Ok((
                        analysis_failure(
                            track_id,
                            params,
                            "unavailable",
                            "Timed out reading original library audio",
                        ),
                        false,
                    ));
                }
            };
        let row = self.decode_file(ffmpeg, track_id, &path, params).await?;
        drop(dir);
        if row.status == "completed" {
            self.persist_row(pool, &row, &revision).await?;
            tracing::debug!(%track_id, "Track silence analysis completed");
        }
        Ok((row, false))
    }

    async fn decode_file(
        &self,
        ffmpeg: &str,
        track_id: &str,
        file_path: &Path,
        params: SilenceParameters,
    ) -> Result<SilenceAnalysisRow, ServerError> {
        let now = Utc::now().to_rfc3339();

        let filter = format!(
            "silencedetect=noise={}dB:d={}",
            params.threshold_db, params.min_silence_seconds
        );
        let args = vec![
            String::from("-nostdin"),
            String::from("-hide_banner"),
            String::from("-nostats"),
            String::from("-xerror"),
            String::from("-protocol_whitelist"),
            String::from("file,pipe"),
            String::from("-format_whitelist"),
            AUDIO_INPUT_FORMATS.into(),
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
                ffmpeg,
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
            Ok(res) => {
                tracing::warn!(%track_id, exit_code = ?res.exit_code, "FFmpeg could not decode audio for silence analysis");
                analysis_failure(
                    track_id,
                    params,
                    "failed",
                    "FFmpeg could not decode the library audio",
                )
            }
            Err(error @ ProcessError::SpawnFailed { .. }) => {
                tracing::warn!(%track_id, %error, "FFmpeg silence analysis could not start");
                return Err(ServerError::ServiceUnavailable(
                    "FFmpeg stopped being runnable. Check the server executable and FFMPEG_PATH, then restart MusicDeck.".into(),
                ));
            }
            Err(error) => {
                tracing::warn!(%track_id, %error, "FFmpeg silence analysis could not run");
                analysis_failure(
                    track_id,
                    params,
                    "failed",
                    "FFmpeg silence analysis could not run. Check the server logs and FFmpeg installation.",
                )
            }
        };
        Ok(row)
    }

    async fn persist_row(
        &self,
        pool: &DbPool,
        row: &SilenceAnalysisRow,
        revision: &str,
    ) -> Result<(), ServerError> {
        let mut tx = begin_sqlite_write(
            pool.inner(),
            "UPDATE track_silence_analysis SET status = status WHERE 0",
        )
        .await
        .map_err(silence_storage_error)?;
        let latest = sqlx::query_scalar::<_, String>(
            "SELECT content_revision FROM library_items WHERE id = ?",
        )
        .bind(&row.track_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(silence_storage_error)?;
        if latest.as_deref() != Some(revision) {
            return Err(ServerError::Conflict(
                "Track changed during silence analysis. Try again.".into(),
            ));
        }
        sqlx::query(
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
        .execute(&mut *tx)
        .await
        .map_err(silence_storage_error)?;

        let json_str = serde_json::to_string(row).map_err(silence_storage_error)?;
        sqlx::query(
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
        .execute(&mut *tx)
        .await
        .map_err(silence_storage_error)?;
        tx.commit().await.map_err(silence_storage_error)
    }
}

fn unavailable_audio(track_id: &str, params: SilenceParameters) -> SilenceAnalysisRow {
    analysis_failure(
        track_id,
        params,
        "unavailable",
        "Original library audio could not be read for silence analysis",
    )
}

fn analysis_failure(
    track_id: &str,
    params: SilenceParameters,
    status: &str,
    message: &str,
) -> SilenceAnalysisRow {
    tracing::warn!(%track_id, %status, %message, "Track silence analysis did not complete");
    let now = Utc::now().to_rfc3339();
    SilenceAnalysisRow {
        track_id: track_id.into(),
        status: status.into(),
        leading_silence_seconds: None,
        trailing_silence_seconds: None,
        duration_seconds: None,
        threshold_db: params.threshold_db,
        min_silence_seconds: params.min_silence_seconds,
        error_message: Some(message.into()),
        analyzed_at: now.clone(),
        updated_at: now,
    }
}

pub(crate) fn silence_storage_error(error: impl std::fmt::Display) -> ServerError {
    tracing::warn!(%error, "Silence analysis database operation failed");
    silence_unavailable()
}

pub(crate) fn silence_unavailable() -> ServerError {
    ServerError::ServiceUnavailable("Silence analysis storage is unavailable".into())
}

pub(super) enum StageError {
    Audio,
    Storage,
}

pub(super) async fn stage_audio(
    candidates: Vec<CandidateSource>,
    track_id: &str,
) -> Result<(tempfile::TempDir, std::path::PathBuf), StageError> {
    for candidate in candidates.into_iter().take(3) {
        let response = tokio::time::timeout(
            MEDIA_HEADER_BUDGET,
            candidate.provider.provider.fetch_stream(
                &candidate.source.provider_item_id,
                None,
                None,
                None,
            ),
        )
        .await;
        let Ok(Ok(stream)) = response else {
            tracing::debug!(%track_id, connection_id = %candidate.source.connection_id, "Audio analysis source did not return audio");
            continue;
        };
        let max = super::MAX_LOUDNESS_INPUT_BYTES;
        let length = stream.response.content_length();
        if stream.status != http::StatusCode::OK
            || stream.headers.contains_key(http::header::CONTENT_RANGE)
            || length.is_some_and(|length| length == 0 || length > max)
        {
            tracing::debug!(%track_id, status = %stream.status, ?length, "Audio analysis source returned unusable audio");
            continue;
        }

        let dir = tempfile::tempdir().map_err(|error| {
            tracing::warn!(%track_id, %error, "Could not create audio analysis staging directory");
            StageError::Storage
        })?;
        let path = dir.path().join("audio");
        let mut file = tokio::fs::File::create(&path).await.map_err(|error| {
            tracing::warn!(%track_id, %error, "Could not create audio analysis input");
            StageError::Storage
        })?;
        let mut body = bounded_media_body(
            Box::pin(stream.response.bytes_stream()),
            max,
            length,
            None,
            MEDIA_BODY_IDLE_TIMEOUT,
        );
        let mut bytes = 0;
        let mut complete = true;
        while let Some(chunk) = body.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    tracing::debug!(%track_id, %error, "Audio analysis source ended before staging completed");
                    complete = false;
                    break;
                }
            };
            file.write_all(&chunk).await.map_err(|error| {
                tracing::warn!(%track_id, %error, "Could not write audio analysis input");
                StageError::Storage
            })?;
            bytes += chunk.len();
        }
        file.flush().await.map_err(|error| {
            tracing::warn!(%track_id, %error, "Could not flush audio analysis input");
            StageError::Storage
        })?;
        drop(file);
        if complete && bytes > 0 {
            return Ok((dir, path));
        }
    }
    Err(StageError::Audio)
}
