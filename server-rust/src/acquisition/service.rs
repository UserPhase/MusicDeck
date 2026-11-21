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
use tokio::sync::broadcast;

use super::input::{AcquisitionKind, AcquisitionResult, ValidatedTarget};
use super::playlist_files::{
    AcquisitionLibrary, cleanup_staging, navidrome_path, publish_staged_track, staging_path,
};
use super::repository::download_manifest;
use crate::acquisition::spotdl::{
    AcquisitionProgress, SpotDLDownloaderAdapter, TrackImportRequest, scan_downloaded_audio_files,
};
use crate::config::AppConfig;
use crate::db::DbPool;
use crate::providers::BackendRegistry;
use crate::registry::SourceCandidate;
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
    #[error("Could not queue acquisition: {0}")]
    Storage(String),
}

impl AcquisitionJobError {
    /// Canonical error code (`"ACQUISITION_NOT_FOUND"` or `"ACQUISITION_NOT_RETRYABLE"`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "ACQUISITION_NOT_FOUND",
            Self::NotRetryable => "ACQUISITION_NOT_RETRYABLE",
            Self::Storage(_) => "ACQUISITION_STORAGE_ERROR",
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
    Partial,
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
            Self::Partial => "partial",
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
            "partial" => Self::Partial,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// True when the job linked to an existing library file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reused: bool,
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
    pub expected_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_count: Option<usize>,
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
    // The HTTP handler supplies the owner from the authenticated session.
    #[serde(skip_deserializing)]
    pub user_id: String,
    #[serde(default)]
    pub candidate: Option<SourceCandidate>,
    #[serde(default)]
    pub candidate_id: Option<String>,
    #[serde(default)]
    pub result: Option<AcquisitionResult>,
    #[serde(default)]
    pub albums: Vec<AcquisitionResult>,
    pub query: Option<String>,
    pub source_url: Option<String>,
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
    library: Option<AcquisitionLibrary>,
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
            library: None,
        }
    }

    pub(crate) fn with_library(
        mut self,
        config: Arc<std::sync::RwLock<Arc<AppConfig>>>,
        providers: BackendRegistry,
    ) -> Self {
        self.library = Some(AcquisitionLibrary { config, providers });
        self
    }

    /// Subscribes to live [`AcquisitionEvent`] broadcasts.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AcquisitionEvent> {
        self.events_tx.subscribe()
    }

    /// Recovers interrupted acquisition jobs on startup by marking in-flight jobs `failed` (`SERVER_RESTARTED`).
    pub async fn recover_interrupted_jobs(&self) -> Result<(), sqlx::Error> {
        let Some(pool) = &self.db else {
            return Ok(());
        };
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r"
            UPDATE acquisition_jobs
            SET status = 'failed',
                stage = 'failed',
                error_code = 'SERVER_RESTARTED',
                error_message = 'Acquisition was interrupted by server restart',
                updated_at = ?,
                completed_at = ?
            WHERE status IN ('discovering', 'downloading', 'processing', 'importing')
               OR (status='queued' AND NOT EXISTS (SELECT 1 FROM background_tasks WHERE id=acquisition_jobs.active_task_id AND state='QUEUED'))
            ",
        )
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await?;
        Ok(())
    }

    fn map_row(row: &sqlx::sqlite::SqliteRow) -> Option<AcquisitionJob> {
        let optional_text = |name| row.try_get::<Option<String>, _>(name).ok().flatten();
        let optional_integer = |name| row.try_get::<Option<i64>, _>(name).ok().flatten();
        let status_str: String = row.try_get("status").ok()?;
        let status = AcquisitionJobStatus::parse(&status_str);
        let files_str = optional_text("files_json");

        let bytes_downloaded = row
            .try_get::<i64, _>("bytes_downloaded")
            .ok()
            .map(|n| n.max(0) as u64)
            .unwrap_or(0);
        let total_bytes = optional_integer("total_bytes").map(|n| n.max(0) as u64);
        let percent = row.try_get::<Option<f64>, _>("percent").ok().flatten();
        let stage = optional_text("stage");
        let speed_bytes_per_second =
            optional_integer("speed_bytes_per_second").map(|n| n.max(0) as u64);
        let auto_play = optional_integer("auto_play").map(|n| n != 0);

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

        let error_code = optional_text("error_code");
        let db_error_message = optional_text("error_message").filter(|s| !s.is_empty());
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
            source_provider: optional_text("source_provider"),
            source_candidate_id: optional_text("source_candidate_id"),
            requested_track_id: optional_text("requested_track_id"),
            requested_album_id: optional_text("requested_album_id"),
            expected_count: row
                .try_get::<Option<i64>, _>("expected_count")
                .ok()
                .flatten()
                .and_then(|n| usize::try_from(n).ok()),
            imported_count: row
                .try_get::<Option<i64>, _>("imported_count")
                .ok()
                .flatten()
                .and_then(|n| usize::try_from(n).ok()),
            requested_title: optional_text("requested_title"),
            requested_artist: optional_text("requested_artist"),
            container_id: optional_text("container_id"),
            auto_play,
            stage,
            speed_bytes_per_second,
            progress,
            files,
            error_code,
            error_message,
            created_at: row.try_get("created_at").unwrap_or_default(),
            updated_at: row.try_get("updated_at").unwrap_or_default(),
            completed_at: optional_text("completed_at"),
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
        let target = ValidatedTarget::resolve(&options)?;
        let input = serde_json::to_string(&target).map_err(|e| e.to_string())?;
        self.check_capacity_and_rate_limits(&options.user_id)
            .await
            .map_err(|e| format!("CAPACITY:{}", e.retry_after))?;
        let pool = self.db.as_ref().ok_or("Database is unavailable")?;
        let id = format!("acq_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();
        let result = options.result.as_ref();
        let candidate = options.candidate.as_ref();
        let catalog_id = result.and_then(|item| item.id.as_deref());
        let track_id = (target.kind == AcquisitionKind::Track)
            .then(|| options.track_id.as_deref().or(catalog_id))
            .flatten();
        let album_id = if target.kind == AcquisitionKind::Album || options.album_id.is_some() {
            options.album_id.as_deref().or(catalog_id)
        } else {
            None
        };
        let title = result
            .and_then(|item| item.title.as_deref())
            .or_else(|| candidate.and_then(|item| item.title.as_deref()));
        let artist = result
            .and_then(|item| item.artist.as_deref())
            .or_else(|| candidate.and_then(|item| item.artist.as_deref()));
        let candidate_id = options
            .candidate_id
            .as_deref()
            .or_else(|| candidate.map(|item| item.id.as_str()));

        let mut tx = pool
            .inner()
            .begin()
            .await
            .map_err(|e| format!("STORAGE:{e}"))?;
        sqlx::query(
            "INSERT INTO acquisition_jobs (
                id, user_id, status, source_provider, source_candidate_id, requested_track_id, requested_album_id,
                requested_title, requested_artist, container_id, auto_play, stage, created_at, updated_at
            ) VALUES (?, ?, 'queued', 'spotdl', ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        ).bind(&id).bind(&options.user_id).bind(candidate_id).bind(track_id).bind(album_id)
            .bind(title).bind(artist).bind(&options.container_id).bind(options.auto_play.unwrap_or(false))
            .bind(&now).bind(&now).execute(&mut *tx).await.map_err(|e| format!("STORAGE:{e}"))?;
        sqlx::query("INSERT INTO acquisition_job_inputs (job_id, input_json) VALUES (?, ?)")
            .bind(&id)
            .bind(input)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("STORAGE:{e}"))?;
        let task = if let Some(manager) = tasks {
            let task = manager
                .enqueue_on(
                    &mut tx,
                    TaskType::SpotdlDownload,
                    json!({ "kind": "acquisition", "jobId": id }),
                    &options.user_id,
                    None,
                )
                .await
                .map_err(|e| format!("STORAGE:{e}"))?;
            sqlx::query("UPDATE acquisition_jobs SET active_task_id = ? WHERE id = ?")
                .bind(&task.id)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("STORAGE:{e}"))?;
            Some(task)
        } else {
            None
        };
        let row = sqlx::query("SELECT * FROM acquisition_jobs WHERE id = ?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("STORAGE:{e}"))?;
        let job = Self::map_row(&row).ok_or("STORAGE:Could not read created acquisition")?;
        tx.commit().await.map_err(|e| format!("STORAGE:{e}"))?;
        let _ = self.events_tx.send(AcquisitionEvent {
            event: "job.created".into(),
            job: job.clone(),
        });
        if let (Some(manager), Some(task)) = (tasks, task) {
            manager.notify_committed(&task);
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
    pub async fn get_job(&self, id: &str, user_id: &str, is_admin: bool) -> Option<AcquisitionJob> {
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
        let pool = self
            .db
            .as_ref()
            .or_else(|| context.db())
            .ok_or(TaskError::NotFound)?;
        let job = self
            .get_job_from_pool(pool, id)
            .await
            .ok_or(TaskError::NotFound)?;
        match job.status {
            AcquisitionJobStatus::Cancelled => return Err(TaskError::Cancelled),
            AcquisitionJobStatus::Completed | AcquisitionJobStatus::Partial => return Ok(job),
            AcquisitionJobStatus::Failed => {
                return Err(TaskError::ExecutionFailed(
                    job.error_message
                        .unwrap_or_else(|| "Acquisition failed".into()),
                ));
            }
            _ => {}
        }
        let row = sqlx::query("UPDATE acquisition_jobs SET status='downloading', stage='downloading', active_task_id=?,
            updated_at=? WHERE id=? AND status='queued' AND (active_task_id IS NULL OR active_task_id=?)")
            .bind(context.task_id()).bind(Utc::now().to_rfc3339()).bind(id).bind(context.task_id())
            .execute(pool.inner()).await.map_err(task_db_error)?;
        if row.rows_affected() != 1 {
            return Err(TaskError::Conflict(
                "Acquisition is no longer queued for this task".into(),
            ));
        }
        let config = self.library.as_ref().map(|library| {
            library
                .config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        });
        let default_stage = config
            .as_ref()
            .map(|cfg| std::path::PathBuf::from(&cfg.acquisition_tmp_dir))
            .unwrap_or_else(|| std::env::temp_dir().join("musicdeck-acquisitions"));
        let attempt = format!("{id}-{}", context.task_id());
        let staging_dir = staging_path(output_dir.unwrap_or(&default_stage), &attempt);
        let result = match &staging_dir {
            Ok(stage) => {
                self.execute_media_job(pool, &job, context, downloader, stage, config.as_deref())
                    .await
            }
            Err(err) => Err(TaskError::ExecutionFailed(format!(
                "Could not open acquisition staging: {err}"
            ))),
        };
        if let Err(err) = &result {
            let cancelled =
                matches!(err, TaskError::Cancelled) || context.cancel_token().is_cancelled();
            let (status, code) = if cancelled {
                ("cancelled", "CANCELLED")
            } else {
                ("failed", "ACQUISITION_FAILED")
            };
            let now = Utc::now().to_rfc3339();
            sqlx::query("UPDATE acquisition_jobs SET status=?, stage=?, error_code=?, error_message=?, updated_at=?, completed_at=?
                WHERE id=? AND active_task_id=? AND status IN ('downloading','importing')")
                .bind(status).bind(status).bind(code).bind(err.to_string()).bind(&now).bind(&now)
                .bind(id).bind(context.task_id()).execute(pool.inner()).await.map_err(task_db_error)?;
            if let Ok(stage) = &staging_dir {
                if scan_downloaded_audio_files(stage)
                    .await
                    .is_ok_and(|files| files.is_empty())
                {
                    cleanup_staging(stage).await;
                }
            }
            self.emit_job(
                pool,
                id,
                if cancelled {
                    "job.cancelled"
                } else {
                    "job.failed"
                },
            )
            .await;
        }
        result?;
        self.get_job_from_pool(pool, id)
            .await
            .ok_or(TaskError::NotFound)
    }

    async fn execute_media_job(
        &self,
        pool: &DbPool,
        job: &AcquisitionJob,
        context: &TaskRunContext,
        downloader: &SpotDLDownloaderAdapter,
        stage: &Path,
        config: Option<&AppConfig>,
    ) -> Result<(), TaskError> {
        context.checkpoint().await?;
        let input: Option<String> =
            sqlx::query_scalar("SELECT input_json FROM acquisition_job_inputs WHERE job_id=?")
                .bind(&job.id)
                .fetch_optional(pool.inner())
                .await
                .map_err(task_db_error)?;
        let target = input
            .as_deref()
            .and_then(ValidatedTarget::decode_saved)
            .ok_or_else(|| {
                TaskError::Validation(
                    "Saved download target is unavailable. Submit the download again.".into(),
                )
            })?;
        let job_id = &job.id;
        let request = TrackImportRequest {
            output_directory: stage.to_path_buf(),
            playlist_m3u_name: Some(format!("musicdeck-{job_id}.m3u8")),
            operands: target.operands,
            ..Default::default()
        };
        tokio::fs::create_dir_all(stage)
            .await
            .map_err(task_db_error)?;
        if !tokio::fs::symlink_metadata(stage)
            .await
            .map_err(task_db_error)?
            .is_dir()
        {
            return Err(TaskError::Validation(
                "Acquisition staging must be a regular directory".into(),
            ));
        }
        let batch = download_manifest(context, downloader, &request, job_id, None).await?;
        let (library, config) = self.library.as_ref().zip(config).ok_or_else(|| {
            TaskError::ExecutionFailed("Shared Navidrome library is not configured".into())
        })?;
        let backend = library.providers.get_primary().map_err(task_db_error)?;
        if backend.provider_type != "navidrome" {
            return Err(TaskError::ExecutionFailed(
                "Downloads require Navidrome as the primary backend".into(),
            ));
        }
        let stage_root = tokio::fs::canonicalize(stage)
            .await
            .map_err(task_db_error)?;
        let music_root = tokio::fs::canonicalize(&config.music_root)
            .await
            .map_err(task_db_error)?;
        let expected = batch
            .expected_count
            .max(target.expected_count.unwrap_or(0))
            .max(batch.entries.len());
        let mut published = Vec::new();
        let mut failure = None;
        let tagger = downloader.tagger();
        for entry in batch.entries {
            context.checkpoint().await?;
            let Some(source) = entry.file_path.as_deref().map(std::path::PathBuf::from) else {
                failure = failure.or(entry.error);
                continue;
            };
            match publish_staged_track(&music_root, &stage_root, &source, &entry.source, &tagger)
                .await
            {
                Ok(publication) => published.push((source, publication, entry.source)),
                Err(err) => {
                    tracing::warn!(job_id, error = %err, "Could not publish downloaded audio");
                    failure.get_or_insert_with(|| {
                        format!("Could not publish downloaded audio: {err}")
                    });
                }
            }
        }
        if published.is_empty() {
            return Err(TaskError::ExecutionFailed(
                failure.unwrap_or_else(|| "No usable tracks were downloaded".into()),
            ));
        }

        context.checkpoint().await?;
        let phase = sqlx::query("UPDATE acquisition_jobs SET status='importing', stage='indexing', percent=85,
            expected_count=?, imported_count=0, updated_at=? WHERE id=? AND active_task_id=? AND status='downloading'")
            .bind(expected as i64).bind(Utc::now().to_rfc3339()).bind(job_id).bind(context.task_id())
            .execute(pool.inner()).await.map_err(task_db_error)?;
        if phase.rows_affected() != 1 {
            return Err(TaskError::Cancelled);
        }
        self.emit_job(pool, job_id, "job.updated").await;
        context
            .report(TaskProgressPatch {
                percent: Some(85.0),
                message: Some(Some("Indexing downloaded tracks in Navidrome".into())),
                ..Default::default()
            })
            .await;
        let cancel = context.cancel_token();
        tokio::select! {
            () = cancel.cancelled() => return Err(TaskError::Cancelled),
            scan = backend.provider.scan_library() => scan.map_err(|err| TaskError::ExecutionFailed(format!("Navidrome scan failed: {err}")))?,
        };
        let mut indexed = std::collections::HashSet::new();
        let mut files = Vec::new();
        for (staged, publication, source) in published {
            context.checkpoint().await?;
            let Some(path) = navidrome_path(&publication.path) else {
                failure.get_or_insert_with(|| {
                    "An imported path could not be read by Navidrome".into()
                });
                continue;
            };
            let lookup = tokio::select! {
                () = cancel.cancelled() => return Err(TaskError::Cancelled),
                result = backend.provider.find_imported_track(&music_root, &path, &source.title) => result,
            };
            match lookup {
                Ok(Some(track)) => {
                    let destination = music_root.join(&publication.path);
                    let size = tokio::fs::metadata(&destination)
                        .await
                        .map_err(task_db_error)?
                        .len();
                    if size == 0 {
                        failure.get_or_insert_with(|| "Published audio is empty".into());
                        continue;
                    }
                    indexed.insert(staged);
                    files.push(AcquiredFileRecord {
                        path: destination.to_string_lossy().into_owned(),
                        title: Some(source.title),
                        artist: Some(source.artist),
                        album: source.album,
                        size: Some(size),
                        provider_track_id: Some(track.provider_id),
                        connection_id: Some(backend.connection_id.clone()),
                        reused: publication.reused,
                        status: "imported".into(),
                    });
                }
                result => {
                    let message = match result {
                        Ok(None) => format!(
                            "Navidrome did not index {path}. Check the shared music mount and Report Real Path."
                        ),
                        Err(err) => format!("Could not resolve {path} in Navidrome: {err}"),
                        _ => unreachable!(),
                    };
                    tracing::warn!(job_id, %message, "Downloaded track could not be indexed");
                    failure.get_or_insert(message);
                }
            }
        }

        if files.is_empty() {
            return Err(TaskError::ExecutionFailed(
                failure.unwrap_or_else(|| "No downloaded tracks were indexed".into()),
            ));
        }
        context.checkpoint().await?;
        let count = files.len();
        let status = if count == expected {
            "completed"
        } else {
            "partial"
        };
        let error = (count != expected).then(|| {
            format!(
                "Imported {count} of {expected} tracks. {}",
                failure
                    .as_deref()
                    .unwrap_or("Some tracks were unavailable.")
            )
        });
        let files_json = serde_json::to_string(&files).map_err(task_db_error)?;
        let now = Utc::now().to_rfc3339();
        let mut tx = pool.inner().begin().await.map_err(task_db_error)?;
        let updated = sqlx::query("UPDATE acquisition_jobs SET status=?, stage=?, percent=100, files_json=?,
            imported_count=?, expected_count=?, error_message=?, updated_at=?, completed_at=?
            WHERE id=? AND active_task_id=? AND status='importing'
            AND EXISTS(SELECT 1 FROM background_tasks WHERE id=? AND state IN ('PROCESSING','PAUSED'))")
            .bind(status).bind(status).bind(&files_json).bind(count as i64).bind(expected as i64).bind(error)
            .bind(&now).bind(&now).bind(job_id).bind(context.task_id()).bind(context.task_id())
            .execute(&mut *tx).await.map_err(task_db_error)?;
        if updated.rows_affected() != 1 {
            return Err(TaskError::Cancelled);
        }
        if let Some(container) = &job.container_id {
            sqlx::query("INSERT INTO acquisition_containers (container_key, provider_id, job_id, status, files_json, created_at, updated_at)
                VALUES (?, 'spotdl', ?, ?, ?, ?, ?) ON CONFLICT(container_key) DO UPDATE SET job_id=excluded.job_id,
                status=excluded.status, files_json=excluded.files_json, updated_at=excluded.updated_at")
                .bind(container).bind(job_id).bind(if status == "completed" { "ready" } else { "partial" })
                .bind(&files_json).bind(&now).bind(&now).execute(&mut *tx).await.map_err(task_db_error)?;
        }
        tx.commit().await.map_err(task_db_error)?;
        if scan_downloaded_audio_files(&stage_root)
            .await
            .is_ok_and(|paths| paths.iter().all(|path| indexed.contains(path)))
        {
            cleanup_staging(stage).await;
        }
        self.emit_job(
            pool,
            job_id,
            if status == "completed" {
                "job.completed"
            } else {
                "job.partial"
            },
        )
        .await;
        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(count as u64),
                total_items: Some(Some(expected as u64)),
                message: Some(Some(format!("Imported {count} of {expected} tracks"))),
                ..Default::default()
            })
            .await;
        Ok(())
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

    async fn emit_job(&self, pool: &DbPool, id: &str, event: &str) {
        if let Some(job) = self.get_job_from_pool(pool, id).await {
            let _ = self.events_tx.send(AcquisitionEvent {
                event: event.into(),
                job,
            });
        }
    }

    /// Cancels the acquisition and its active task in the same transaction.
    pub async fn cancel_job(
        &self,
        id: &str,
        user_id: &str,
        is_admin: bool,
        tasks: &TaskManager,
    ) -> Result<bool, TaskError> {
        let pool = self.db.as_ref().ok_or(TaskError::NotFound)?;
        let mut tx = pool.inner().begin().await.map_err(task_db_error)?;
        let now = Utc::now().to_rfc3339();
        let row: Option<(Option<String>,)> = sqlx::query_as("UPDATE acquisition_jobs
            SET status='cancelled', stage='cancelled', error_code='CANCELLED', error_message='Cancelled by user',
                updated_at=?, completed_at=?
            WHERE id=? AND (user_id=? OR ?) AND status IN ('queued','discovering','downloading','processing','importing')
            RETURNING active_task_id")
            .bind(&now).bind(&now).bind(id).bind(user_id).bind(is_admin)
            .fetch_optional(&mut *tx).await.map_err(task_db_error)?;
        let Some((task_id,)) = row else {
            return Ok(false);
        };
        let cancelled = match task_id {
            Some(task_id) => tasks.cancel_on(&mut tx, &task_id).await?,
            None => None,
        };
        tx.commit().await.map_err(task_db_error)?;
        if let Some(task) = cancelled {
            tasks.notify_cancelled(&task);
        }
        self.emit_job(pool, id, "job.cancelled").await;
        Ok(true)
    }

    /// Atomically claims a retry and creates its new task.
    pub async fn retry_job(
        &self,
        id: &str,
        user_id: &str,
        is_admin: bool,
        tasks: &TaskManager,
    ) -> Result<AcquisitionJob, AcquisitionJobError> {
        let job = self
            .get_job(id, user_id, is_admin)
            .await
            .ok_or(AcquisitionJobError::NotFound)?;
        let pool = self.db.as_ref().ok_or(AcquisitionJobError::NotFound)?;
        let storage = |err: sqlx::Error| AcquisitionJobError::Storage(err.to_string());
        let saved: Option<String> =
            sqlx::query_scalar("SELECT input_json FROM acquisition_job_inputs WHERE job_id=?")
                .bind(id)
                .fetch_optional(pool.inner())
                .await
                .map_err(storage)?;
        if saved
            .as_deref()
            .and_then(ValidatedTarget::decode_saved)
            .is_none()
        {
            return Err(AcquisitionJobError::NotRetryable);
        }
        let mut tx = pool.inner().begin().await.map_err(storage)?;
        let now = Utc::now().to_rfc3339();
        let claimed = sqlx::query("UPDATE acquisition_jobs SET status='queued', stage='queued',
            error_code=NULL, error_message=NULL, completed_at=NULL, percent=0, updated_at=?, imported_count=0
            WHERE id=? AND user_id=? AND status IN ('failed','cancelled')
            AND EXISTS(SELECT 1 FROM acquisition_job_inputs WHERE job_id=?)")
            .bind(&now).bind(id).bind(&job.user_id).bind(id)
            .execute(&mut *tx).await.map_err(storage)?;
        if claimed.rows_affected() != 1 {
            return Err(AcquisitionJobError::NotRetryable);
        }
        let task = tasks
            .enqueue_on(
                &mut tx,
                TaskType::SpotdlDownload,
                json!({ "kind": "acquisition", "jobId": id }),
                &job.user_id,
                None,
            )
            .await
            .map_err(|err| AcquisitionJobError::Storage(err.to_string()))?;
        let row =
            sqlx::query("UPDATE acquisition_jobs SET active_task_id=? WHERE id=? RETURNING *")
                .bind(&task.id)
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .map_err(storage)?;
        let updated = Self::map_row(&row).ok_or(AcquisitionJobError::NotFound)?;
        tx.commit().await.map_err(storage)?;
        let _ = self.events_tx.send(AcquisitionEvent {
            event: "job.updated".into(),
            job: updated.clone(),
        });
        tasks.notify_committed(&task);
        Ok(updated)
    }
}

fn task_db_error(err: impl std::fmt::Display) -> TaskError {
    TaskError::ExecutionFailed(err.to_string())
}
