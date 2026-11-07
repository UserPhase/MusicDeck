//! # Automated Media Acquisition Coordinator & SSE Progress Broadcaster (`acquisition::service`)
//!
//! Ports:
//! - `server/src/domain/acquisition-limits.ts`:
//!   - [`AcquisitionLimits`] (`max_pending = 50`, `max_pending_per_user = 10`,
//!     `submissions_per_user = 20`, `submissions_global = 100`, `sse_per_user = 3`, `sse_global = 20`)
//!   - [`AcquisitionCapacityError`] (`429 Too Many Requests` with `Retry-After`)
//! - `server/src/domain/acquisition.ts`:
//!   - [`AcquisitionJobStatus`] (`queued | discovering | downloading | processing | importing | completed | failed | cancelled`)
//!   - [`AcquisitionJob`], [`AcquiredFileRecord`], [`AcquisitionCreateOptions`], [`AcquisitionJobError`]
//!   - [`AcquisitionService`]:
//!     - Persists jobs in `acquisition_jobs`
//!     - Enforces per-user and global pending job caps and sliding-window submission rate limits
//!     - Recovers interrupted (`discovering`, `downloading`, `processing`, `importing`) jobs on startup (`SERVER_RESTARTED`)
//!     - Broadcasts live `job.created`, `job.updated`, `job.progress`, `job.completed`, `job.failed`,
//!       and `job.cancelled` events via `tokio::sync::broadcast`

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use tokio::sync::{broadcast, mpsc};

use crate::acquisition::spotdl::{
    AcquisitionProgress, AcquisitionValidationError, SpotDLDownloaderAdapter, TrackImportRequest,
    canonical_manual_acquisition_url, canonical_spotify_url,
};
use crate::db::DbPool;
use crate::registry::SourceCandidate;
use crate::search::UnifiedSearchResult;
use crate::tasks::{TaskError, TaskManager, TaskProgressPatch, TaskRunContext, TaskType};

/// Capacity and rate-limiting thresholds for the acquisition subsystem (`DEFAULT_ACQUISITION_LIMITS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionLimits {
    pub max_pending: usize,
    pub max_pending_per_user: usize,
    pub submission_window_ms: i64,
    pub submissions_per_user: usize,
    pub submissions_global: usize,
    pub max_rate_entries: usize,
    pub retention_ms: i64,
    pub max_retained_jobs: i64,
    pub cleanup_interval_ms: u64,
    pub sse_per_user: usize,
    pub sse_global: usize,
}

impl Default for AcquisitionLimits {
    fn default() -> Self {
        Self {
            max_pending: 50,
            max_pending_per_user: 10,
            submission_window_ms: 60_000,
            submissions_per_user: 20,
            submissions_global: 100,
            max_rate_entries: 10_000,
            retention_ms: 7 * 24 * 60 * 60_000,
            max_retained_jobs: 1_000,
            cleanup_interval_ms: 60_000,
            sse_per_user: 3,
            sse_global: 20,
        }
    }
}

/// Error returned when pending acquisition queues or rate limits are saturated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Acquisition capacity temporarily unavailable; retry later")]
pub struct AcquisitionCapacityError {
    pub retry_after: u64,
}

impl AcquisitionCapacityError {
    /// Creates a new [`AcquisitionCapacityError`].
    #[must_use]
    pub const fn new(retry_after: u64) -> Self {
        Self { retry_after }
    }
}

/// Error returned when an acquisition job is missing or not in a retryable state.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AcquisitionJobError {
    #[error("Job not found")]
    NotFound,
    #[error("Only settled failed or cancelled jobs can be retried")]
    NotRetryable,
}

impl AcquisitionJobError {
    /// Canonical error code (`"ACQUISITION_NOT_FOUND"` or `"ACQUISITION_NOT_RETRYABLE"`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "ACQUISITION_NOT_FOUND",
            Self::NotRetryable => "ACQUISITION_NOT_RETRYABLE",
        }
    }
}

/// Lifecycle state of an [`AcquisitionJob`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcquisitionJobStatus {
    Queued,
    Discovering,
    Downloading,
    Processing,
    Importing,
    Completed,
    Failed,
    Cancelled,
}

impl AcquisitionJobStatus {
    /// Canonical lowercase string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Discovering => "discovering",
            Self::Downloading => "downloading",
            Self::Processing => "processing",
            Self::Importing => "importing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// Parses a string into an [`AcquisitionJobStatus`].
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "queued" => Self::Queued,
            "discovering" => Self::Discovering,
            "downloading" => Self::Downloading,
            "processing" => Self::Processing,
            "importing" => Self::Importing,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            _ => Self::Failed,
        }
    }

    /// Returns `true` if the job is currently pending or active.
    #[must_use]
    pub const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Discovering
                | Self::Downloading
                | Self::Processing
                | Self::Importing
        )
    }
}

/// File entry recorded inside [`AcquisitionJob::files`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquiredFileRecord {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub status: String,
}

/// Persisted acquisition job record (`AcquisitionJob`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionJob {
    pub id: String,
    pub user_id: String,
    pub status: AcquisitionJobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_candidate_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_play: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<AcquisitionProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<AcquiredFileRecord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// Input options for [`AcquisitionService::create_job`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionCreateOptions {
    pub user_id: String,
    #[serde(default)]
    pub candidate: Option<SourceCandidate>,
    #[serde(default)]
    pub candidate_id: Option<String>,
    #[serde(default)]
    pub result: Option<UnifiedSearchResult>,
    #[serde(default)]
    pub source_provider: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub container_id: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub spotify_track_url: Option<String>,
    #[serde(default)]
    pub spotify_url: Option<String>,
    #[serde(default)]
    pub auto_play: Option<bool>,
}

/// Real-time SSE event broadcast by [`AcquisitionService`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionEvent {
    pub event: String,
    pub job: AcquisitionJob,
}

fn safe_acquisition_failure(code: Option<&str>) -> &'static str {
    match code {
        Some("NO_CANDIDATES") => "No candidates found for requested recording",
        Some("NO_ACQUIREABLE_SOURCE") => "No acquireable source found for requested recording",
        Some("SERVER_RESTARTED") => "Acquisition was interrupted by server restart",
        Some("CANCELLED") => "Cancelled by user",
        _ => "Acquisition failed. Please retry or contact an administrator.",
    }
}

#[derive(Default)]
struct SubmissionRateWindow {
    global_timestamps: Vec<i64>,
    per_user_timestamps: HashMap<String, Vec<i64>>,
}

/// Service managing on-demand media acquisition jobs, SQLite persistence, and SSE broadcasting.
#[derive(Clone)]
pub struct AcquisitionService {
    db: Option<DbPool>,
    limits: AcquisitionLimits,
    rate_window: Arc<Mutex<SubmissionRateWindow>>,
    events_tx: broadcast::Sender<AcquisitionEvent>,
}

impl std::fmt::Debug for AcquisitionService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcquisitionService")
            .field("limits", &self.limits)
            .finish()
    }
}

impl AcquisitionService {
    /// Creates a new [`AcquisitionService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let (events_tx, _) = broadcast::channel(256);
        Self {
            db,
            limits: AcquisitionLimits::default(),
            rate_window: Arc::new(Mutex::new(SubmissionRateWindow::default())),
            events_tx,
        }
    }

    /// Subscribes to live [`AcquisitionEvent`] broadcasts.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AcquisitionEvent> {
        self.events_tx.subscribe()
    }

    /// Recovers interrupted acquisition jobs on startup by marking in-flight jobs `failed` (`SERVER_RESTARTED`).
    pub async fn recover_interrupted_jobs(&self) {
        let Some(pool) = &self.db else {
            return;
        };
        let now = Utc::now().to_rfc3339();
        let _ = sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'failed',
                error_code = 'SERVER_RESTARTED',
                error_message = 'Acquisition was interrupted by server restart',
                updated_at = ?,
                completed_at = ?
            WHERE status IN ('discovering', 'downloading', 'processing', 'importing')
            ",
        )
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await;
    }

    fn map_row(row: &sqlx::sqlite::SqliteRow) -> Option<AcquisitionJob> {
        let status_str: String = row.try_get("status").ok()?;
        let status = AcquisitionJobStatus::parse(&status_str);
        let files_str: Option<String> = row.try_get("files_json").ok();

        let bytes_downloaded = row
            .try_get::<i64, _>("bytes_downloaded")
            .ok()
            .map(|n| n.max(0) as u64)
            .unwrap_or(0);
        let total_bytes = row
            .try_get::<i64, _>("total_bytes")
            .ok()
            .map(|n| n.max(0) as u64);
        let percent = row.try_get::<f64, _>("percent").ok();
        let stage = row.try_get::<String, _>("stage").ok();
        let speed_bytes_per_second = row
            .try_get::<i64, _>("speed_bytes_per_second")
            .ok()
            .map(|n| n.max(0) as u64);
        let auto_play = row
            .try_get::<i64, _>("auto_play")
            .ok()
            .map(|n| n != 0);

        let progress = Some(AcquisitionProgress {
            bytes_downloaded: Some(bytes_downloaded),
            total_bytes,
            percent,
            speed_bytes_per_second,
            stage: stage.clone(),
            message: None,
        });
        let files = files_str
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str::<Vec<AcquiredFileRecord>>(&s).ok());

        let error_code: Option<String> = row.try_get("error_code").ok();
        let db_error_message: Option<String> = row
            .try_get::<String, _>("error_message")
            .ok()
            .filter(|s| !s.is_empty());
        let error_message = if status == AcquisitionJobStatus::Failed {
            Some(
                db_error_message
                    .unwrap_or_else(|| safe_acquisition_failure(error_code.as_deref()).to_owned()),
            )
        } else {
            db_error_message
        };

        Some(AcquisitionJob {
            id: row.try_get("id").ok()?,
            user_id: row.try_get("user_id").ok()?,
            status,
            source_provider: row.try_get("source_provider").ok(),
            source_candidate_id: row.try_get("source_candidate_id").ok(),
            requested_track_id: row.try_get("requested_track_id").ok(),
            requested_album_id: row.try_get("requested_album_id").ok(),
            requested_title: row.try_get("requested_title").ok(),
            requested_artist: row.try_get("requested_artist").ok(),
            container_id: row.try_get("container_id").ok(),
            auto_play,
            stage,
            speed_bytes_per_second,
            progress,
            files,
            error_code,
            error_message,
            created_at: row.try_get("created_at").unwrap_or_default(),
            updated_at: row.try_get("updated_at").unwrap_or_default(),
            completed_at: row.try_get("completed_at").ok(),
        })
    }

    async fn check_capacity_and_rate_limits(
        &self,
        user_id: &str,
    ) -> Result<(), AcquisitionCapacityError> {
        let Some(pool) = &self.db else {
            return Err(AcquisitionCapacityError::new(60));
        };

        let global_pending: i64 = sqlx::query(
            r"
            SELECT COUNT(*) AS n FROM acquisition_jobs
            WHERE status IN ('queued', 'discovering', 'downloading', 'processing', 'importing')
            ",
        )
        .fetch_one(pool.inner())
        .await
        .ok()
        .and_then(|r| r.try_get("n").ok())
        .unwrap_or(0);

        if (global_pending as usize) >= self.limits.max_pending {
            return Err(AcquisitionCapacityError::new(60));
        }

        let user_pending: i64 = sqlx::query(
            r"
            SELECT COUNT(*) AS n FROM acquisition_jobs
            WHERE user_id = ?
              AND status IN ('queued', 'discovering', 'downloading', 'processing', 'importing')
            ",
        )
        .bind(user_id)
        .fetch_one(pool.inner())
        .await
        .ok()
        .and_then(|r| r.try_get("n").ok())
        .unwrap_or(0);

        if (user_pending as usize) >= self.limits.max_pending_per_user {
            return Err(AcquisitionCapacityError::new(60));
        }

        let now_ms = Utc::now().timestamp_millis();
        let cutoff = now_ms - self.limits.submission_window_ms;

        if let Ok(mut guard) = self.rate_window.lock() {
            guard.global_timestamps.retain(|&ts| ts > cutoff);
            if guard.global_timestamps.len() >= self.limits.submissions_global {
                return Err(AcquisitionCapacityError::new(60));
            }
            let user_vec = guard
                .per_user_timestamps
                .entry(user_id.to_owned())
                .or_default();
            user_vec.retain(|&ts| ts > cutoff);
            if user_vec.len() >= self.limits.submissions_per_user {
                return Err(AcquisitionCapacityError::new(60));
            }
            user_vec.push(now_ms);
            guard.global_timestamps.push(now_ms);
        }

        Ok(())
    }

    /// Validates `options`, creates a new [`AcquisitionJob`] in `acquisition_jobs`, and enqueues it on `tasks`.
    pub async fn create_job(
        &self,
        options: AcquisitionCreateOptions,
        tasks: Option<&TaskManager>,
    ) -> Result<AcquisitionJob, String> {
        let has_target = options.candidate.is_some()
            || options.candidate_id.is_some()
            || options.result.is_some()
            || options.track_id.is_some()
            || options.album_id.is_some();
        if !has_target {
            return Err(AcquisitionValidationError.to_string());
        }

        if let Some(ref sp_url) = options.spotify_track_url {
            canonical_spotify_url(sp_url).map_err(|e| e.to_string())?;
        }
        if let Some(ref sp_url) = options.spotify_url {
            canonical_spotify_url(sp_url).map_err(|e| e.to_string())?;
        }

        self.check_capacity_and_rate_limits(&options.user_id)
            .await
            .map_err(|e| format!("CAPACITY:{}", e.retry_after))?;

        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| String::from("Database is unavailable"))?;

        let id = format!("acq_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();
        let source_provider = options
            .source_provider
            .or(options.provider_id)
            .or_else(|| options.candidate.as_ref().map(|c| c.provider.clone()))
            .or_else(|| Some(String::from("spotdl")));
        let source_candidate_id = options
            .candidate_id
            .or_else(|| options.candidate.as_ref().map(|c| c.id.clone()));
        let requested_track_id = options
            .track_id
            .or_else(|| options.result.as_ref().map(|r| r.id.clone()));
        let requested_album_id = options.album_id;
        let requested_title = options
            .result
            .as_ref()
            .map(|r| r.title.clone())
            .or_else(|| options.candidate.as_ref().and_then(|c| c.title.clone()));
        let requested_artist = options
            .result
            .as_ref()
            .and_then(|r| r.artist.clone())
            .or_else(|| options.candidate.as_ref().and_then(|c| c.artist.clone()));
        let auto_play_flag = i64::from(options.auto_play.unwrap_or(false));

        sqlx::query(
            r"
            INSERT INTO acquisition_jobs (
                id, user_id, status, source_provider, source_candidate_id,
                requested_track_id, requested_album_id, container_id,
                bytes_downloaded, total_bytes, percent, stage,
                speed_bytes_per_second, auto_play, files_json,
                created_at, updated_at
            )
            VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, 0, NULL, 0, 'queued', NULL, ?, '[]', ?, ?)
            ",
        )
        .bind(&id)
        .bind(&options.user_id)
        .bind(&source_provider)
        .bind(&source_candidate_id)
        .bind(&requested_track_id)
        .bind(&requested_album_id)
        .bind(&options.container_id)
        .bind(auto_play_flag)
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        let mut job = self
            .get_job(&id, &options.user_id, true)
            .await
            .ok_or_else(|| String::from("Failed to load created acquisition job"))?;
        job.requested_title = requested_title;
        job.requested_artist = requested_artist;
        job.auto_play = options.auto_play;

        let _ = self.events_tx.send(AcquisitionEvent {
            event: String::from("job.created"),
            job: job.clone(),
        });

        if let Some(tm) = tasks {
            let _ = tm
                .enqueue(
                    TaskType::SpotdlDownload,
                    json!({ "kind": "acquisition", "jobId": id }),
                    &options.user_id,
                    None,
                )
                .await;
        }

        Ok(job)
    }

    /// Lists acquisition jobs visible to `user_id` (`include_all` when admin and `scope != "mine"`).
    pub async fn list_jobs(&self, user_id: &str, include_all: bool) -> Vec<AcquisitionJob> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };

        let rows = if include_all {
            sqlx::query(
                "SELECT * FROM acquisition_jobs ORDER BY created_at DESC, rowid DESC LIMIT 200",
            )
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default()
        } else {
            sqlx::query(
                "SELECT * FROM acquisition_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200",
            )
            .bind(user_id)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default()
        };

        rows.iter().filter_map(Self::map_row).collect()
    }

    /// Retrieves a single acquisition job by ID if visible to `user_id` (`is_admin`).
    pub async fn get_job(
        &self,
        id: &str,
        user_id: &str,
        is_admin: bool,
    ) -> Option<AcquisitionJob> {
        let pool = self.db.as_ref()?;
        let row = if is_admin {
            sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
                .bind(id)
                .fetch_optional(pool.inner())
                .await
                .ok()
                .flatten()?
        } else {
            sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ? AND user_id = ?")
                .bind(id)
                .bind(user_id)
                .fetch_optional(pool.inner())
                .await
                .ok()
                .flatten()?
        };

        Self::map_row(&row)
    }

    /// Retrieves an acquisition job by `id` regardless of owner (used by background workers).
    pub async fn get_job_by_id(&self, id: &str) -> Option<AcquisitionJob> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()?;
        Self::map_row(&row)
    }

    /// Executes a queued acquisition job inside a [`TaskRunContext`] using `downloader`,
    /// persisting state transitions (`discovering` -> `downloading` -> `importing` -> `completed` / `failed`)
    /// to `acquisition_jobs` in SQLite.
    pub async fn run_managed_job(
        &self,
        id: &str,
        context: &TaskRunContext,
        downloader: &SpotDLDownloaderAdapter,
        output_dir: Option<&Path>,
    ) -> Result<AcquisitionJob, TaskError> {
        context.checkpoint().await?;

        let pool = self
            .db
            .as_ref()
            .or_else(|| context.db())
            .ok_or(TaskError::NotFound)?
            .clone();

        let row = sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(pool.inner())
            .await
            .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?
            .ok_or(TaskError::NotFound)?;

        let job = Self::map_row(&row).ok_or(TaskError::NotFound)?;

        if job.status == AcquisitionJobStatus::Cancelled {
            return Err(TaskError::Cancelled);
        }
        if job.status == AcquisitionJobStatus::Failed {
            let msg = job
                .error_message
                .unwrap_or_else(|| String::from("Acquisition job failed"));
            return Err(TaskError::ExecutionFailed(msg));
        }
        if job.status == AcquisitionJobStatus::Completed {
            context
                .report(TaskProgressPatch {
                    percent: Some(100.0),
                    items_processed: Some(1),
                    total_items: Some(Some(1)),
                    message: Some(Some(String::from("Import completed"))),
                    ..TaskProgressPatch::default()
                })
                .await;
            return Ok(job);
        }

        let staging_dir = output_dir
            .map(|p| p.join(id))
            .unwrap_or_else(|| std::env::temp_dir().join("musicdeck-acquisitions").join(id));

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'discovering',
                stage = 'discovering',
                updated_at = ?
            WHERE id = ?
            ",
        )
        .bind(&now)
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?;

        let raw_target = job
            .source_candidate_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                job.requested_track_id
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
            })
            .or_else(|| {
                job.requested_album_id
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
            });

        let Some(target) = raw_target else {
            let err_msg = "No candidates found for requested recording";
            self.fail_job_in_db(&pool, id, "NO_CANDIDATES", err_msg).await;
            return Err(TaskError::ExecutionFailed(err_msg.to_owned()));
        };

        let mut request = TrackImportRequest {
            output_directory: staging_dir.clone(),
            ..TrackImportRequest::default()
        };

        if let Ok(sp_url) = canonical_spotify_url(target) {
            request.spotify_track_url = Some(sp_url);
        } else if let Ok(manual_url) = canonical_manual_acquisition_url(target) {
            request.source_url = Some(manual_url);
        } else if target.contains("://")
            || target.starts_with("http:")
            || target.starts_with("https:")
            || target.starts_with("ftp:")
            || target.starts_with("file:")
            || target.starts_with("data:")
            || target.starts_with("spotify:")
        {
            request.source_url = Some(target.to_owned());
        } else {
            let sanitized_query: String = target
                .trim_start_matches(['-', '/', '\\', '.'])
                .replace(['|', ':'], " ")
                .trim()
                .to_owned();
            request.query = Some(sanitized_query);
        }

        context.checkpoint().await?;

        let dl_now = Utc::now().to_rfc3339();
        sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'downloading',
                stage = 'downloading',
                updated_at = ?
            WHERE id = ?
            ",
        )
        .bind(&dl_now)
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?;

        if let Some(updated) = self.get_job_from_pool(&pool, id).await {
            let _ = self.events_tx.send(AcquisitionEvent {
                event: String::from("job.updated"),
                job: updated,
            });
        }

        let (prog_tx, mut prog_rx) = mpsc::unbounded_channel::<AcquisitionProgress>();
        let prog_pool = pool.clone();
        let prog_ctx = context.clone();
        let prog_job_id = id.to_owned();
        let prog_events = self.events_tx.clone();

        let progress_worker = tokio::spawn(async move {
            while let Some(p) = prog_rx.recv().await {
                let ts = Utc::now().to_rfc3339();
                let bytes_dl = p.bytes_downloaded.unwrap_or(0) as i64;
                let total_b = p.total_bytes.map(|n| n as i64);
                let pct = p.percent.unwrap_or(0.0);
                let stage = p.stage.clone().unwrap_or_else(|| String::from("downloading"));
                let speed = p.speed_bytes_per_second.map(|n| n as i64);

                let _ = sqlx::query(
                    r"
                    UPDATE acquisition_jobs
                    SET bytes_downloaded = ?,
                        total_bytes = COALESCE(?, total_bytes),
                        percent = ?,
                        stage = ?,
                        speed_bytes_per_second = COALESCE(?, speed_bytes_per_second),
                        updated_at = ?
                    WHERE id = ?
                    ",
                )
                .bind(bytes_dl)
                .bind(total_b)
                .bind(pct)
                .bind(&stage)
                .bind(speed)
                .bind(&ts)
                .bind(&prog_job_id)
                .execute(prog_pool.inner())
                .await;

                prog_ctx
                    .report(TaskProgressPatch {
                        percent: p.percent,
                        speed_bytes_per_second: p.speed_bytes_per_second.map(|s| s as f64),
                        message: Some(p.message.clone().or(Some(stage))),
                        ..TaskProgressPatch::default()
                    })
                    .await;

                if let Ok(Some(r)) = sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
                    .bind(&prog_job_id)
                    .fetch_optional(prog_pool.inner())
                    .await
                {
                    if let Some(j) = Self::map_row(&r) {
                        let _ = prog_events.send(AcquisitionEvent {
                            event: String::from("job.progress"),
                            job: j,
                        });
                    }
                }
            }
        });

        let download_result = downloader
            .download(&request, move |prog| {
                let _ = prog_tx.send(prog);
            })
            .await;

        let _ = progress_worker.await;

        if context.cancel_token().is_cancelled() {
            let _ = tokio::fs::remove_dir_all(&staging_dir).await;
            let cancel_now = Utc::now().to_rfc3339();
            let _ = sqlx::query(
                r"
                UPDATE acquisition_jobs
                SET status = 'cancelled',
                    stage = 'cancelled',
                    error_code = 'CANCELLED',
                    error_message = 'Cancelled by user',
                    updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                ",
            )
            .bind(&cancel_now)
            .bind(&cancel_now)
            .bind(id)
            .execute(pool.inner())
            .await;
            return Err(TaskError::Cancelled);
        }

        let downloaded_paths = match download_result {
            Ok(paths) => paths,
            Err(err_msg) => {
                let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                self.fail_job_in_db(&pool, id, "ACQUISITION_FAILED", &err_msg)
                    .await;
                return Err(TaskError::ExecutionFailed(err_msg));
            }
        };

        context.checkpoint().await?;

        let mut files: Vec<AcquiredFileRecord> = Vec::new();
        for path in &downloaded_paths {
            let size = tokio::fs::metadata(path).await.ok().map(|m| m.len());
            files.push(AcquiredFileRecord {
                path: path.to_string_lossy().into_owned(),
                title: job.requested_title.clone(),
                artist: job.requested_artist.clone(),
                album: None,
                size,
                status: String::from("imported"),
            });
        }
        let files_json = serde_json::to_string(&files).unwrap_or_else(|_| String::from("[]"));
        let done_now = Utc::now().to_rfc3339();

        sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'completed',
                stage = 'completed',
                percent = 100.0,
                files_json = ?,
                error_code = NULL,
                error_message = NULL,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
            ",
        )
        .bind(&files_json)
        .bind(&done_now)
        .bind(&done_now)
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?;

        if let Some(ref container_key) = job.container_id {
            let provider_id = job
                .source_provider
                .as_deref()
                .unwrap_or("spotdl");
            let _ = sqlx::query(
                r"
                INSERT INTO acquisition_containers (
                    container_key, provider_id, job_id, status, files_json, created_at, updated_at
                )
                VALUES (?, ?, ?, 'ready', ?, ?, ?)
                ON CONFLICT(container_key) DO UPDATE SET
                    status = 'ready',
                    files_json = excluded.files_json,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(container_key)
            .bind(provider_id)
            .bind(id)
            .bind(&files_json)
            .bind(&done_now)
            .bind(&done_now)
            .execute(pool.inner())
            .await;
        }

        let _ = tokio::fs::remove_dir_all(&staging_dir).await;

        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(files.len() as u64),
                total_items: Some(Some(files.len() as u64)),
                message: Some(Some(String::from("Import completed"))),
                ..TaskProgressPatch::default()
            })
            .await;

        let completed = self
            .get_job_from_pool(&pool, id)
            .await
            .ok_or(TaskError::NotFound)?;

        let _ = self.events_tx.send(AcquisitionEvent {
            event: String::from("job.completed"),
            job: completed.clone(),
        });

        Ok(completed)
    }

    async fn get_job_from_pool(&self, pool: &DbPool, id: &str) -> Option<AcquisitionJob> {
        let row = sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()?;
        Self::map_row(&row)
    }

    async fn fail_job_in_db(&self, pool: &DbPool, id: &str, error_code: &str, error_message: &str) {
        let now = Utc::now().to_rfc3339();
        let _ = sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'failed',
                stage = 'failed',
                error_code = ?,
                error_message = ?,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
            ",
        )
        .bind(error_code)
        .bind(error_message)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(pool.inner())
        .await;

        if let Some(failed_job) = self.get_job_from_pool(pool, id).await {
            let _ = self.events_tx.send(AcquisitionEvent {
                event: String::from("job.failed"),
                job: failed_job,
            });
        }
    }

    /// Cancels an active acquisition job.
    pub async fn cancel_job(&self, id: &str, user_id: &str, is_admin: bool) -> bool {
        let Some(existing) = self.get_job(id, user_id, is_admin).await else {
            return false;
        };
        if !existing.status.is_active() {
            return false;
        }
        let Some(pool) = &self.db else {
            return false;
        };

        let now = Utc::now().to_rfc3339();
        let res = sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'cancelled',
                error_code = 'CANCELLED',
                error_message = 'Cancelled by user',
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
            ",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(pool.inner())
        .await;

        if res.is_ok_and(|r| r.rows_affected() > 0) {
            if let Some(updated) = self.get_job(id, user_id, true).await {
                let _ = self.events_tx.send(AcquisitionEvent {
                    event: String::from("job.cancelled"),
                    job: updated,
                });
            }
            true
        } else {
            false
        }
    }

    /// Retries a settled `failed` or `cancelled` acquisition job.
    pub async fn retry_job(
        &self,
        id: &str,
        user_id: &str,
        is_admin: bool,
    ) -> Result<AcquisitionJob, AcquisitionJobError> {
        let existing = self
            .get_job(id, user_id, is_admin)
            .await
            .ok_or(AcquisitionJobError::NotFound)?;

        if !matches!(
            existing.status,
            AcquisitionJobStatus::Failed | AcquisitionJobStatus::Cancelled
        ) {
            return Err(AcquisitionJobError::NotRetryable);
        }

        let Some(pool) = &self.db else {
            return Err(AcquisitionJobError::NotFound);
        };
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'queued',
                error_code = NULL,
                error_message = NULL,
                completed_at = NULL,
                updated_at = ?
            WHERE id = ?
            ",
        )
        .bind(&now)
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|_| AcquisitionJobError::NotFound)?;

        let updated = self
            .get_job(id, user_id, true)
            .await
            .ok_or(AcquisitionJobError::NotFound)?;

        let _ = self.events_tx.send(AcquisitionEvent {
            event: String::from("job.updated"),
            job: updated.clone(),
        });

        Ok(updated)
    }
}
