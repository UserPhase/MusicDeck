//! # Cooperative Priority Task Manager & SQLite Job Persistence (`tasks::manager`)
//!
//! Ports `server/src/services/TaskManager.ts`:
//! - [`TaskType`] (`SPOTDL_IMPORT`, `SPOTDL_DOWNLOAD`, `LIBRARY_SCAN`, `AUDIO_ANALYSIS`,
//!   `NEW_RELEASES_SCAN`, `SONIC_AUDIO_ANALYSIS`)
//! - [`TaskStatus`] (`QUEUED`, `PROCESSING`, `PAUSED`, `FINISHED`, `FAILED`, `CANCELLED`)
//! - [`TaskProgress`], [`Task`] (`ManagedTask`), [`TaskLogEntry`], [`TaskSchedule`], [`TaskMetrics`]
//! - [`TaskRunContext`] with cooperative `checkpoint()`, `report()`, `log()`, and [`CancellationToken`]
//! - [`TaskManager`] wrapped in `Arc<RwLock<TaskRegistry>>` with:
//!   - Startup crash recovery (`recover_interrupted_tasks`) marking orphaned `PROCESSING` jobs `FAILED`
//!   - Priority queue dispatch (`max_concurrent = 2`, `max_analysis_workers = 1`)
//!   - Active media stream preemption (`acquire_media_stream` -> [`MediaStreamGuard`])
//!   - 5-field cron validation (`validate_five_field_cron`) and schedule persistence
//!   - `tokio::sync::broadcast` real-time state & progress event bus

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use tokio::sync::{Mutex as AsyncMutex, Notify, broadcast};
use tokio_util::sync::CancellationToken;

use crate::db::DbPool;
use crate::domain::settings::{SCAN_SCHEDULE_SETTING_KEY, write_server_setting};
use crate::logger::redact_text;
use crate::routes::sample_process_rss_bytes;
use crate::tasks::scheduler::{CronValidation, validate_scan_schedule};

/// Maximum serialized JSON byte size for a task payload (`64 KiB`).
pub const MAX_TASK_PAYLOAD_BYTES: usize = 64 * 1024;
/// Maximum retained terminal (`FINISHED`, `FAILED`, `CANCELLED`) tasks in SQLite (`1,000`).
pub const MAX_TERMINAL_HISTORY: i64 = 1_000;
/// Maximum retained diagnostic log lines per task (`200`).
pub const MAX_LOGS_PER_TASK: i64 = 200;
/// Default tick interval (`500 ms`) for the background cron schedule evaluation worker.
pub const DEFAULT_CRON_TICK_INTERVAL_MS: u64 = 500;
/// Maximum catch-up window (`5 minutes`) evaluated after a delayed tick or transient DB lock.
const MAX_CRON_CATCHUP_MINUTES: i64 = 5;

/// Supported background task types (`TASK_TYPES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskType {
    #[serde(rename = "SPOTDL_IMPORT")]
    SpotdlImport,
    #[serde(rename = "SPOTDL_DOWNLOAD")]
    SpotdlDownload,
    #[serde(rename = "LIBRARY_SCAN")]
    LibraryScan,
    #[serde(rename = "AUDIO_ANALYSIS")]
    AudioAnalysis,
    #[serde(rename = "NEW_RELEASES_SCAN")]
    NewReleasesScan,
    #[serde(rename = "SONIC_AUDIO_ANALYSIS")]
    SonicAudioAnalysis,
}

impl TaskType {
    /// All supported task types.
    pub const ALL: [Self; 6] = [
        Self::SpotdlImport,
        Self::SpotdlDownload,
        Self::LibraryScan,
        Self::AudioAnalysis,
        Self::NewReleasesScan,
        Self::SonicAudioAnalysis,
    ];

    /// Canonical uppercase SQLite string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SpotdlImport => "SPOTDL_IMPORT",
            Self::SpotdlDownload => "SPOTDL_DOWNLOAD",
            Self::LibraryScan => "LIBRARY_SCAN",
            Self::AudioAnalysis => "AUDIO_ANALYSIS",
            Self::NewReleasesScan => "NEW_RELEASES_SCAN",
            Self::SonicAudioAnalysis => "SONIC_AUDIO_ANALYSIS",
        }
    }

    /// Parses a string into a [`TaskType`].
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "SPOTDL_IMPORT" => Some(Self::SpotdlImport),
            "SPOTDL_DOWNLOAD" => Some(Self::SpotdlDownload),
            "LIBRARY_SCAN" => Some(Self::LibraryScan),
            "AUDIO_ANALYSIS" => Some(Self::AudioAnalysis),
            "NEW_RELEASES_SCAN" => Some(Self::NewReleasesScan),
            "SONIC_AUDIO_ANALYSIS" => Some(Self::SonicAudioAnalysis),
            _ => None,
        }
    }

    /// Default scheduling priority (`0..=1000`).
    #[must_use]
    pub const fn default_priority(self) -> i32 {
        match self {
            Self::SpotdlImport | Self::SpotdlDownload => 300,
            Self::LibraryScan => 200,
            Self::AudioAnalysis => 100,
            Self::NewReleasesScan => 50,
            Self::SonicAudioAnalysis => 10,
        }
    }

    /// Returns `true` for CPU-intensive audio analysis tasks (`AUDIO_ANALYSIS`, `SONIC_AUDIO_ANALYSIS`).
    #[must_use]
    pub const fn is_analysis_task(self) -> bool {
        matches!(self, Self::AudioAnalysis | Self::SonicAudioAnalysis)
    }

    /// Returns `true` for background tasks that yield to active HTTP audio streams.
    #[must_use]
    pub const fn is_background_task(self) -> bool {
        self.is_analysis_task()
            || matches!(self, Self::LibraryScan | Self::NewReleasesScan)
    }
}

/// Lifecycle state of a [`Task`] (`TaskState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "QUEUED")]
    Queued,
    #[serde(rename = "PROCESSING")]
    Processing,
    #[serde(rename = "PAUSED")]
    Paused,
    #[serde(rename = "FINISHED")]
    Finished,
    #[serde(rename = "FAILED")]
    Failed,
    #[serde(rename = "CANCELLED")]
    Cancelled,
}

impl TaskStatus {
    /// Canonical uppercase SQLite string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "QUEUED",
            Self::Processing => "PROCESSING",
            Self::Paused => "PAUSED",
            Self::Finished => "FINISHED",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
        }
    }

    /// Parses a string into a [`TaskStatus`].
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "QUEUED" => Some(Self::Queued),
            "PROCESSING" => Some(Self::Processing),
            "PAUSED" => Some(Self::Paused),
            "FINISHED" => Some(Self::Finished),
            "FAILED" => Some(Self::Failed),
            "CANCELLED" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// Returns `true` if this state is terminal (`FINISHED`, `FAILED`, `CANCELLED`).
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Failed | Self::Cancelled)
    }
}

/// Quantitative progress telemetry for a [`Task`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub percent: f64,
    pub items_processed: u64,
    pub total_items: Option<u64>,
    pub memory_bytes: u64,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<f64>,
}

impl Default for TaskProgress {
    fn default() -> Self {
        Self {
            percent: 0.0,
            items_processed: 0,
            total_items: None,
            memory_bytes: sample_process_rss_bytes(),
            message: None,
            speed_bytes_per_second: None,
        }
    }
}

/// Partial update patch applied via [`TaskRunContext::report`].
#[derive(Debug, Clone, Default)]
pub struct TaskProgressPatch {
    pub percent: Option<f64>,
    pub items_processed: Option<u64>,
    pub total_items: Option<Option<u64>>,
    pub memory_bytes: Option<u64>,
    pub message: Option<Option<String>>,
    pub speed_bytes_per_second: Option<f64>,
}

/// Persisted background task record (`ManagedTask`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub state: TaskStatus,
    pub priority: i32,
    pub payload: Value,
    pub progress: TaskProgress,
    pub error: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl Task {
    /// Projects this task into its public admin JSON representation (omitting `payload`).
    #[must_use]
    pub fn to_public_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": self.task_type,
            "state": self.state,
            "priority": self.priority,
            "progress": self.progress,
            "error": self.error,
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        })
    }
}

/// Diagnostic log entry stored in `background_task_logs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogEntry {
    pub seq: i64,
    pub at: String,
    pub source: String,
    pub message: String,
}

/// Cron schedule record stored in `background_task_schedules`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSchedule {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub expression: String,
    pub enabled: bool,
}

/// Runtime worker and resource metrics returned by [`TaskManager::metrics`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetrics {
    pub memory_bytes: u64,
    pub free_memory_bytes: u64,
    pub total_memory_bytes: u64,
    pub load_per_core: f64,
    pub active_streams: usize,
    pub active_workers: usize,
    pub max_concurrent: usize,
    pub constrained: bool,
}

/// Structured errors returned by [`TaskManager`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TaskError {
    #[error("Background task not found")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Validation(String),
    #[error("Cancelled")]
    Cancelled,
    #[error("{0}")]
    ExecutionFailed(String),
}

/// Real-time event broadcast to admin SSE subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum TaskEvent {
    #[serde(rename = "task.state")]
    State(Task),
    #[serde(rename = "task.progress")]
    Progress(Task),
    #[serde(rename = "history.cleared")]
    HistoryCleared(Vec<String>),
}

/// Parsed and compiled 5-field UTC cron schedule (`minute hour day-of-month month day-of-week`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiveFieldCron {
    expression: String,
    minutes: u64,
    hours: u32,
    days_of_month: u32,
    months: u16,
    days_of_week: u8,
    dom_wildcard: bool,
    dow_wildcard: bool,
}

impl FiveFieldCron {
    /// Parses and validates a standard 5-field cron expression.
    pub fn parse(raw: &str) -> Result<Self, TaskError> {
        let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let fields: Vec<&str> = normalized.split(' ').collect();
        if fields.len() != 5 {
            return Err(TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            )));
        }

        let minutes = parse_cron_field_bits(fields[0], 0, 59, false).ok_or_else(|| {
            TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            ))
        })?;
        let hours = parse_cron_field_bits(fields[1], 0, 23, false).ok_or_else(|| {
            TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            ))
        })? as u32;
        let days_of_month = parse_cron_field_bits(fields[2], 1, 31, false).ok_or_else(|| {
            TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            ))
        })? as u32;
        let months = parse_cron_field_bits(fields[3], 1, 12, false).ok_or_else(|| {
            TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            ))
        })? as u16;
        let days_of_week = parse_cron_field_bits(fields[4], 0, 7, true).ok_or_else(|| {
            TaskError::Validation(String::from(
                "Schedule must be a valid five-field cron expression",
            ))
        })? as u8;
        let dom_wildcard = fields[2] == "*";
        let dow_wildcard = fields[4] == "*";

        Ok(Self {
            expression: normalized,
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
            dom_wildcard,
            dow_wildcard,
        })
    }

    /// Returns the normalized 5-field cron expression string.
    #[must_use]
    pub fn expression(&self) -> &str {
        &self.expression
    }

    /// Returns `true` if `dt` (in UTC) satisfies all 5 cron fields.
    #[must_use]
    pub fn matches_datetime(&self, dt: DateTime<Utc>) -> bool {
        let min_ok = (self.minutes & (1_u64 << dt.minute())) != 0;
        let hour_ok = (self.hours & (1_u32 << dt.hour())) != 0;
        let month_ok = (self.months & (1_u16 << dt.month())) != 0;
        if !min_ok || !hour_ok || !month_ok {
            return false;
        }

        let dom_ok = (self.days_of_month & (1_u32 << dt.day())) != 0;
        let dow = dt.weekday().num_days_from_sunday();
        let dow_ok = (self.days_of_week & (1_u8 << dow)) != 0;

        if !self.dom_wildcard && !self.dow_wildcard {
            dom_ok || dow_ok
        } else {
            dom_ok && dow_ok
        }
    }

    /// Computes the next UTC minute timestamp strictly after `after` that matches this schedule.
    #[must_use]
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let next_min_epoch = after.timestamp().div_euclid(60).saturating_add(1) * 60;
        let mut cursor = Utc.timestamp_opt(next_min_epoch, 0).single()?;
        // Search up to 4 years (covering leap years such as Feb 29).
        let max_timestamp = next_min_epoch + 4 * 366 * 24 * 3600;

        while cursor.timestamp() <= max_timestamp {
            if (self.months & (1_u16 << cursor.month())) == 0 {
                let (next_year, next_month) = if cursor.month() == 12 {
                    (cursor.year() + 1, 1)
                } else {
                    (cursor.year(), cursor.month() + 1)
                };
                cursor = Utc.with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0).single()?;
                continue;
            }

            let dom_ok = (self.days_of_month & (1_u32 << cursor.day())) != 0;
            let dow = cursor.weekday().num_days_from_sunday();
            let dow_ok = (self.days_of_week & (1_u8 << dow)) != 0;
            let day_ok = if !self.dom_wildcard && !self.dow_wildcard {
                dom_ok || dow_ok
            } else {
                dom_ok && dow_ok
            };

            if !day_ok {
                let next_day = cursor
                    .with_hour(0)?
                    .with_minute(0)?
                    .with_second(0)?
                    + chrono::Duration::days(1);
                cursor = next_day;
                continue;
            }

            if (self.hours & (1_u32 << cursor.hour())) == 0 {
                let next_hour = cursor.with_minute(0)?.with_second(0)? + chrono::Duration::hours(1);
                cursor = next_hour;
                continue;
            }

            if (self.minutes & (1_u64 << cursor.minute())) == 0 {
                cursor += chrono::Duration::minutes(1);
                continue;
            }

            return Some(cursor);
        }
        None
    }
}

/// Validates a standard 5-field cron expression (`minute hour day-of-month month day-of-week`).
pub fn validate_five_field_cron(raw: &str) -> Result<String, TaskError> {
    FiveFieldCron::parse(raw).map(|c| c.expression)
}

fn parse_cron_field_bits(
    field: &str,
    min_val: u32,
    max_val: u32,
    normalize_dow: bool,
) -> Option<u64> {
    if field.is_empty() {
        return None;
    }
    let mut mask = 0_u64;
    for part in field.split(',') {
        let (range_part, step_part) = match part.split_once('/') {
            Some((r, s)) => {
                let step = s.parse::<u32>().ok()?;
                if step == 0 || step > max_val {
                    return None;
                }
                (r, Some(step))
            }
            None => (part, None),
        };

        let (start, end) = if range_part == "*" {
            (min_val, max_val)
        } else if let Some((start_s, end_s)) = range_part.split_once('-') {
            let start = start_s.parse::<u32>().ok()?;
            let end = end_s.parse::<u32>().ok()?;
            if start < min_val || end > max_val || start > end {
                return None;
            }
            (start, end)
        } else {
            if step_part.is_some() {
                return None;
            }
            let val = range_part.parse::<u32>().ok()?;
            if val < min_val || val > max_val {
                return None;
            }
            (val, val)
        };

        let step = step_part.unwrap_or(1);
        let mut current = start;
        while current <= end {
            let bit = if normalize_dow && current == 7 {
                0
            } else {
                current
            };
            mask |= 1_u64 << bit;
            current = current.saturating_add(step);
        }
    }
    if mask == 0 {
        None
    } else {
        Some(mask)
    }
}

pub(crate) async fn upsert_schedule(
    conn: &mut SqliteConnection,
    task_type: TaskType,
    payload_json: &str,
    expression: &str,
    created_by: &str,
) -> Result<String, sqlx::Error> {
    sqlx::query_scalar(
        r"
        INSERT INTO background_task_schedules (
            id, task_type, payload_json, expression, enabled, created_by, updated_at
        )
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(task_type) DO UPDATE SET
            payload_json = excluded.payload_json,
            expression = excluded.expression,
            enabled = 1,
            created_by = excluded.created_by,
            updated_at = excluded.updated_at
        RETURNING id
        ",
    )
    .bind(format!("taskschedule_{}", nanoid!(16)))
    .bind(task_type.as_str())
    .bind(payload_json)
    .bind(expression)
    .bind(created_by)
    .bind(Utc::now().to_rfc3339())
    .fetch_one(conn)
    .await
}

pub(crate) async fn delete_schedule(
    conn: &mut SqliteConnection,
    task_type: TaskType,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM background_task_schedules WHERE task_type = ?")
        .bind(task_type.as_str())
        .execute(conn)
        .await?;
    Ok(())
}

fn schedule_db_error(err: sqlx::Error) -> TaskError {
    TaskError::ExecutionFailed(err.to_string())
}

async fn write_library_schedule_setting(
    conn: &mut SqliteConnection,
    expression: &str,
) -> Result<(), TaskError> {
    write_server_setting(
        conn,
        SCAN_SCHEDULE_SETTING_KEY,
        &json!(expression).to_string(),
        &Utc::now().to_rfc3339(),
    )
    .await
    .map_err(schedule_db_error)
}

fn serialize_task_payload(payload: &Value) -> Result<String, TaskError> {
    let serialized = serde_json::to_string(payload)
        .map_err(|_| TaskError::Validation(String::from("Task payload must be JSON serializable")))?;
    if serialized.is_empty() || serialized.len() > MAX_TASK_PAYLOAD_BYTES {
        return Err(TaskError::Validation(String::from(
            "Task payload must not exceed 64 KiB",
        )));
    }
    Ok(serialized)
}

/// Trait implemented by task worker runners (`LIBRARY_SCAN`, `NEW_RELEASES_SCAN`, `SONIC_AUDIO_ANALYSIS`, `SPOTDL_*`).
#[async_trait]
pub trait TaskDefinition: Send + Sync {
    /// Validates the JSON payload before enqueueing or scheduling.
    fn validate(&self, payload: &Value) -> bool;

    /// Executes the task cooperatively using `context`.
    async fn run(&self, payload: Value, context: TaskRunContext) -> Result<(), TaskError>;
}

#[derive(Clone)]
struct ActiveTaskHandle {
    cancel_token: CancellationToken,
    manual_pause: Arc<AtomicBool>,
    resource_pause: Arc<AtomicBool>,
    slot_held: Arc<AtomicBool>,
}

/// Execution context passed to [`TaskDefinition::run`].
#[derive(Clone)]
pub struct TaskRunContext {
    task_id: String,
    manager: TaskManager,
    handle: ActiveTaskHandle,
}

impl TaskRunContext {
    /// Returns the ID of the running task.
    #[must_use]
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// Returns a [`CancellationToken`] triggered when the task is cancelled or the server shuts down.
    #[must_use]
    pub fn cancel_token(&self) -> CancellationToken {
        self.handle.cancel_token.clone()
    }

    /// Returns `true` if the task is currently paused manually or due to resource/stream pressure.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.handle.manual_pause.load(Ordering::Acquire)
            || self.handle.resource_pause.load(Ordering::Acquire)
    }

    /// Returns `Err(TaskError::Cancelled)` if the cancellation token has been triggered.
    pub fn throw_if_cancelled(&self) -> Result<(), TaskError> {
        if self.handle.cancel_token.is_cancelled() {
            return Err(TaskError::Cancelled);
        }
        Ok(())
    }

    /// Reports quantitative progress (`percent` clamped to `0.0..=100.0`).
    pub async fn report(&self, patch: TaskProgressPatch) {
        self.manager.report_progress(&self.task_id, patch).await;
    }

    /// Appends a credential-redacted diagnostic log line (`"stdout"` or `"stderr"`).
    pub async fn log(&self, source: &str, message: &str) {
        self.manager.append_log(&self.task_id, source, message).await;
    }

    /// Cooperatively pauses execution when manually paused, while media is streaming,
    /// or when preempted by higher-priority tasks.
    pub async fn checkpoint(&self) -> Result<(), TaskError> {
        self.manager.checkpoint(&self.task_id, &self.handle).await
    }

    /// Returns a reference to the underlying [`TaskManager`].
    #[must_use]
    pub const fn manager(&self) -> &TaskManager {
        &self.manager
    }

    /// Returns a reference to the attached SQLite [`DbPool`], if any.
    #[must_use]
    pub fn db(&self) -> Option<&DbPool> {
        self.manager.db()
    }
}

/// RAII guard returned by [`TaskManager::acquire_media_stream`] that decrements the active stream count on drop.
pub struct MediaStreamGuard {
    manager: TaskManager,
    released: bool,
}

impl MediaStreamGuard {
    /// Explicitly releases the media stream guard early.
    pub fn release(mut self) {
        if !self.released {
            self.released = true;
            self.manager.release_media_stream();
        }
    }
}

impl Drop for MediaStreamGuard {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.manager.release_media_stream();
        }
    }
}

#[derive(Default)]
struct TaskRegistry {
    definitions: HashMap<TaskType, Arc<dyn TaskDefinition>>,
    active: HashMap<String, ActiveTaskHandle>,
}

#[derive(Default)]
struct CronEvalState {
    /// Maps `(schedule_id, normalized_expression)` to the last UTC minute slot (`epoch_sec / 60`) fired.
    last_fired_slot: HashMap<(String, String), i64>,
    /// Tracks the last evaluated UTC minute slot to detect backward clock skew or missed ticks.
    last_tick_slot: Option<i64>,
}

/// Thread-safe cooperative priority task scheduler backed by SQLite (`Arc<RwLock<TaskRegistry>>`).
#[derive(Clone)]
pub struct TaskManager {
    db: Option<DbPool>,
    registry: Arc<RwLock<TaskRegistry>>,
    active_slots: Arc<AtomicUsize>,
    media_streams: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
    pumping: Arc<AtomicBool>,
    scheduler_running: Arc<AtomicBool>,
    cron_tick_interval_ms: Arc<AtomicU64>,
    schedule_notify: Arc<Notify>,
    schedule_state: Arc<AsyncMutex<CronEvalState>>,
    max_concurrent: usize,
    #[allow(dead_code)]
    max_analysis_workers: usize,
    events_tx: broadcast::Sender<TaskEvent>,
}

impl std::fmt::Debug for TaskManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskManager")
            .field("active_slots", &self.active_slots.load(Ordering::Relaxed))
            .field("media_streams", &self.media_streams.load(Ordering::Relaxed))
            .field("max_concurrent", &self.max_concurrent)
            .finish()
    }
}

impl TaskManager {
    /// Creates a new [`TaskManager`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        let (events_tx, _) = broadcast::channel(256);
        let mgr = Self {
            db,
            registry: Arc::new(RwLock::new(TaskRegistry::default())),
            active_slots: Arc::new(AtomicUsize::new(0)),
            media_streams: Arc::new(AtomicUsize::new(0)),
            stopping: Arc::new(AtomicBool::new(false)),
            pumping: Arc::new(AtomicBool::new(false)),
            scheduler_running: Arc::new(AtomicBool::new(false)),
            cron_tick_interval_ms: Arc::new(AtomicU64::new(DEFAULT_CRON_TICK_INTERVAL_MS)),
            schedule_notify: Arc::new(Notify::new()),
            schedule_state: Arc::new(AsyncMutex::new(CronEvalState::default())),
            max_concurrent: 2,
            max_analysis_workers: 1,
            events_tx,
        };
        mgr.ensure_scheduler_running();
        mgr
    }

    /// Returns a reference to the attached [`DbPool`], if initialized.
    #[must_use]
    pub fn db(&self) -> Option<&DbPool> {
        self.db.as_ref()
    }

    /// Configures the periodic cron evaluation tick interval (`>= 10ms`) using a builder pattern.
    #[must_use]
    pub fn with_cron_tick_interval(self, interval: Duration) -> Self {
        self.set_cron_tick_interval(interval);
        self
    }

    /// Updates the periodic cron evaluation tick interval (`>= 10ms`) in place.
    pub fn set_cron_tick_interval(&self, interval: Duration) {
        let ms = u64::try_from(interval.as_millis())
            .unwrap_or(DEFAULT_CRON_TICK_INTERVAL_MS)
            .max(10);
        self.cron_tick_interval_ms.store(ms, Ordering::Release);
        self.schedule_notify.notify_one();
    }

    /// Starts the background Tokio cron evaluation worker loop if not already active.
    pub fn start_scheduler(&self) {
        self.ensure_scheduler_running();
        self.schedule_notify.notify_one();
    }

    fn ensure_scheduler_running(&self) {
        if self.stopping.load(Ordering::Acquire) || self.db.is_none() {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        if self
            .scheduler_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let mgr = self.clone();
            tokio::spawn(async move {
                mgr.run_cron_loop().await;
            });
        }
    }

    async fn run_cron_loop(&self) {
        while !self.stopping.load(Ordering::Acquire) {
            let _ = self.evaluate_schedules_at(Utc::now()).await;
            if self.stopping.load(Ordering::Acquire) {
                break;
            }
            let wait_ms = self.cron_tick_interval_ms.load(Ordering::Acquire).max(10);
            tokio::select! {
                () = self.schedule_notify.notified() => {},
                () = tokio::time::sleep(Duration::from_millis(wait_ms)) => {},
            }
        }
        self.scheduler_running.store(false, Ordering::Release);
    }

    /// Evaluates persisted cron schedules at the current UTC timestamp and dispatches due tasks.
    pub async fn tick_schedules(&self) -> usize {
        self.evaluate_schedules_at(Utc::now()).await
    }

    /// Evaluates all enabled cron schedules in `background_task_schedules` against `now` (UTC),
    /// recovering from clock skews and transient SQLite errors, and enqueues due tasks.
    pub async fn evaluate_schedules_at(&self, now: DateTime<Utc>) -> usize {
        if self.stopping.load(Ordering::Acquire) {
            return 0;
        }
        let Some(pool) = &self.db else {
            return 0;
        };

        let mut eval_guard = self.schedule_state.lock().await;
        let current_slot = now.timestamp().div_euclid(60);

        // Recover gracefully if the system clock stepped backwards (NTP or manual adjustment).
        if let Some(prev_slot) = eval_guard.last_tick_slot {
            if current_slot < prev_slot {
                tracing::warn!(
                    previous_slot = prev_slot,
                    current_slot = current_slot,
                    "Detected backward clock skew in cron scheduler; resetting future slot markers"
                );
                for fired_slot in eval_guard.last_fired_slot.values_mut() {
                    if *fired_slot > current_slot {
                        *fired_slot = current_slot - 1;
                    }
                }
            }
        }

        let rows = match sqlx::query(
            r"
            SELECT id, task_type, payload_json, expression, enabled, created_by
            FROM background_task_schedules
            WHERE enabled = 1
            ORDER BY task_type
            ",
        )
        .fetch_all(pool.inner())
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "Transient database error reading background_task_schedules; will retry on next tick"
                );
                return 0;
            }
        };

        let mut active_keys = HashSet::with_capacity(rows.len());
        let mut dispatched = 0_usize;

        for row in rows {
            if self.stopping.load(Ordering::Acquire) {
                break;
            }
            let (Ok(schedule_id), Ok(type_str), Ok(payload_str), Ok(expression), Ok(created_by)) = (
                row.try_get::<String, _>("id"),
                row.try_get::<String, _>("task_type"),
                row.try_get::<String, _>("payload_json"),
                row.try_get::<String, _>("expression"),
                row.try_get::<String, _>("created_by"),
            ) else {
                continue;
            };

            let Some(task_type) = TaskType::parse(&type_str) else {
                continue;
            };

            let cron = match FiveFieldCron::parse(&expression) {
                Ok(c) => c,
                Err(err) => {
                    tracing::error!(
                        schedule_id = %schedule_id,
                        expression = %expression,
                        error = %err,
                        "Disabling invalid persisted task schedule"
                    );
                    let _ = sqlx::query(
                        "UPDATE background_task_schedules SET enabled = 0 WHERE id = ?",
                    )
                    .bind(&schedule_id)
                    .execute(pool.inner())
                    .await;
                    continue;
                }
            };

            let key = (schedule_id.clone(), cron.expression().to_owned());
            active_keys.insert(key.clone());

            let start_slot = match eval_guard.last_fired_slot.get(&key).copied() {
                Some(last_slot) if last_slot >= current_slot => continue,
                Some(last_slot) => (last_slot + 1).max(current_slot - MAX_CRON_CATCHUP_MINUTES),
                None => current_slot,
            };

            let mut is_due = false;
            for slot in start_slot..=current_slot {
                if let Some(slot_dt) = Utc.timestamp_opt(slot * 60, 0).single() {
                    if cron.matches_datetime(slot_dt) {
                        is_due = true;
                        break;
                    }
                }
            }

            if !is_due {
                continue;
            }

            // Skip overlapping dispatch if the same task type is already active (`QUEUED`, `PROCESSING`, `PAUSED`).
            let active_check = sqlx::query(
                r"
                SELECT id FROM background_tasks
                WHERE type = ? AND state IN ('QUEUED', 'PROCESSING', 'PAUSED')
                LIMIT 1
                ",
            )
            .bind(task_type.as_str())
            .fetch_optional(pool.inner())
            .await;

            match active_check {
                Ok(Some(_)) => {
                    tracing::warn!(
                        schedule_id = %schedule_id,
                        task_type = task_type.as_str(),
                        "Scheduled background task skipped because the same task type is active"
                    );
                    eval_guard.last_fired_slot.insert(key, current_slot);
                    continue;
                }
                Err(err) => {
                    tracing::warn!(
                        schedule_id = %schedule_id,
                        error = %err,
                        "Transient database error checking active tasks for schedule; will retry"
                    );
                    continue;
                }
                Ok(None) => {}
            }

            let payload =
                serde_json::from_str::<Value>(&payload_str).unwrap_or_else(|_| json!({}));
            let owner = if created_by.trim().is_empty() {
                "system:scheduler"
            } else {
                created_by.trim()
            };

            match self.enqueue(task_type, payload, owner, None).await {
                Ok(_task) => {
                    eval_guard.last_fired_slot.insert(key, current_slot);
                    dispatched += 1;
                }
                Err(TaskError::ExecutionFailed(err)) => {
                    tracing::warn!(
                        schedule_id = %schedule_id,
                        task_type = task_type.as_str(),
                        error = %err,
                        "Transient database failure enqueueing scheduled task; will retry on next tick"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        schedule_id = %schedule_id,
                        task_type = task_type.as_str(),
                        error = %err,
                        "Scheduled background task could not be queued"
                    );
                    eval_guard.last_fired_slot.insert(key, current_slot);
                }
            }
        }

        eval_guard
            .last_fired_slot
            .retain(|k, _| active_keys.contains(k));
        eval_guard.last_tick_slot = Some(current_slot);
        dispatched
    }

    /// Ensures `background_tasks`, `background_task_logs`, and `background_task_schedules` exist in SQLite.
    pub async fn initialize_tables(&self) {
        let Some(pool) = &self.db else {
            return;
        };
        if let Err(err) = sqlx::raw_sql(
            r"
            CREATE TABLE IF NOT EXISTS background_tasks (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK (type IN ('LIBRARY_SCAN','NEW_RELEASES_SCAN','SONIC_AUDIO_ANALYSIS','SPOTDL_IMPORT','SPOTDL_DOWNLOAD')),
                state TEXT NOT NULL CHECK (state IN ('QUEUED','PROCESSING','PAUSED','FINISHED','FAILED','CANCELLED')),
                priority INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                progress_json TEXT NOT NULL,
                error TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS background_tasks_queue_idx
                ON background_tasks(state, priority DESC, created_at);
            CREATE TABLE IF NOT EXISTS background_task_logs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
                at TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS background_task_logs_task ON background_task_logs(task_id, seq);
            CREATE TABLE IF NOT EXISTS background_task_schedules (
                id TEXT PRIMARY KEY,
                task_type TEXT NOT NULL UNIQUE CHECK (task_type IN ('LIBRARY_SCAN','NEW_RELEASES_SCAN','SONIC_AUDIO_ANALYSIS','SPOTDL_IMPORT','SPOTDL_DOWNLOAD')),
                payload_json TEXT NOT NULL,
                expression TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
                created_by TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )
        .execute(pool.inner())
        .await
        {
            tracing::error!(error = %err, "Could not initialize background task tables");
        }
    }

    /// Recovers interrupted `PROCESSING` tasks after an unclean shutdown or server restart
    /// by transitioning them to `FAILED` (`"Task was interrupted by a server restart"`).
    pub async fn recover_interrupted_tasks(&self) {
        self.initialize_tables().await;
        let Some(pool) = &self.db else {
            return;
        };
        let now = Utc::now().to_rfc3339();
        let _ = sqlx::query(
            r"
            UPDATE background_tasks
            SET state = 'FAILED',
                error = 'Task was interrupted by a server restart',
                finished_at = ?,
                updated_at = ?
            WHERE state = 'PROCESSING'
            ",
        )
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await;
        if let Err(err) = self.restore_library_scan_schedule(pool).await {
            tracing::error!(error = %err, "Could not load the saved library scan schedule");
        }
        self.start_scheduler();
    }

    // Older databases may have a scan setting saved before the settings route
    // started writing the corresponding background task schedule.
    async fn restore_library_scan_schedule(&self, pool: &DbPool) -> Result<(), sqlx::Error> {
        let mut tx = pool.inner().begin().await?;
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT value FROM server_settings WHERE key = ? AND NOT EXISTS (
                SELECT 1 FROM background_task_schedules WHERE task_type = ?
            )",
        )
        .bind(SCAN_SCHEDULE_SETTING_KEY)
        .bind(TaskType::LibraryScan.as_str())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(stored) = stored {
            let raw = serde_json::from_str::<String>(&stored).unwrap_or(stored);
            match validate_scan_schedule(Some(&raw)) {
                CronValidation::Valid(Some(expression)) => {
                    upsert_schedule(
                        &mut tx,
                        TaskType::LibraryScan,
                        "{}",
                        &expression,
                        "system:scheduler",
                    )
                    .await?;
                }
                CronValidation::Invalid(err) => {
                    tracing::warn!(error = %err, "Ignoring an invalid saved library scan schedule");
                }
                CronValidation::Valid(None) => {}
            }
        }
        tx.commit().await
    }

    /// Registers a [`TaskDefinition`] runner for `task_type`.
    pub fn register(&self, task_type: TaskType, definition: Arc<dyn TaskDefinition>) {
        if let Ok(mut guard) = self.registry.write() {
            guard.definitions.insert(task_type, definition);
        }
        self.ensure_scheduler_running();
        self.spawn_pump();
    }

    /// Unregisters the runner for `task_type`.
    pub fn unregister(&self, task_type: TaskType) {
        if let Ok(mut guard) = self.registry.write() {
            guard.definitions.remove(&task_type);
        }
    }

    /// Subscribes to real-time [`TaskEvent`] broadcasts.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<TaskEvent> {
        self.events_tx.subscribe()
    }

    /// Increments the active HTTP media stream counter and pauses background tasks until dropped.
    #[must_use]
    pub fn acquire_media_stream(&self) -> MediaStreamGuard {
        self.media_streams.fetch_add(1, Ordering::AcqRel);
        self.refresh_resource_pauses_sync();
        MediaStreamGuard {
            manager: self.clone(),
            released: false,
        }
    }

    fn release_media_stream(&self) {
        let prev = self.media_streams.fetch_sub(1, Ordering::AcqRel);
        if prev <= 1 {
            self.refresh_resource_pauses_sync();
            self.spawn_pump();
        }
    }

    fn refresh_resource_pauses_sync(&self) {
        let streams = self.media_streams.load(Ordering::Acquire);
        if streams > 0 {
            if let Ok(guard) = self.registry.read() {
                for handle in guard.active.values() {
                    handle.resource_pause.store(true, Ordering::Release);
                }
            }
        } else if let Ok(guard) = self.registry.read() {
            for handle in guard.active.values() {
                handle.resource_pause.store(false, Ordering::Release);
            }
        }
    }

    fn map_row(row: &sqlx::sqlite::SqliteRow) -> Option<Task> {
        let type_str: String = row.try_get("type").ok()?;
        let task_type = TaskType::parse(&type_str)?;
        let state_str: String = row.try_get("state").ok()?;
        let state = TaskStatus::parse(&state_str)?;
        let payload_str: String = row.try_get("payload_json").unwrap_or_default();
        let progress_str: String = row.try_get("progress_json").unwrap_or_default();

        let payload = serde_json::from_str::<Value>(&payload_str).unwrap_or_else(|_| json!({}));
        let progress =
            serde_json::from_str::<TaskProgress>(&progress_str).unwrap_or_default();

        Some(Task {
            id: row.try_get("id").ok()?,
            task_type,
            state,
            priority: row.try_get("priority").unwrap_or(0),
            payload,
            progress,
            error: row.try_get("error").ok(),
            created_by: row.try_get("created_by").unwrap_or_default(),
            created_at: row.try_get("created_at").unwrap_or_default(),
            updated_at: row.try_get("updated_at").unwrap_or_default(),
            started_at: row.try_get("started_at").ok(),
            finished_at: row.try_get("finished_at").ok(),
        })
    }

    /// Fetches a task by ID.
    pub async fn get(&self, id: &str) -> Option<Task> {
        let pool = self.db.as_ref()?;
        let row = sqlx::query("SELECT * FROM background_tasks WHERE id = ?")
            .bind(id)
            .fetch_optional(pool.inner())
            .await
            .ok()
            .flatten()?;
        Self::map_row(&row)
    }

    async fn require_task(&self, id: &str) -> Result<Task, TaskError> {
        self.get(id).await.ok_or(TaskError::NotFound)
    }

    /// Finds an active (`QUEUED`, `PROCESSING`, `PAUSED`) task matching `task_type` and `payload`.
    pub async fn find_pending(&self, task_type: TaskType, payload: &Value) -> Option<Task> {
        let pool = self.db.as_ref()?;
        let payload_json = serialize_task_payload(payload).ok()?;
        let row = sqlx::query(
            r"
            SELECT * FROM background_tasks
            WHERE type = ? AND payload_json = ? AND state IN ('QUEUED', 'PROCESSING', 'PAUSED')
            ORDER BY created_at, rowid
            LIMIT 1
            ",
        )
        .bind(task_type.as_str())
        .bind(payload_json)
        .fetch_optional(pool.inner())
        .await
        .ok()
        .flatten()?;
        Self::map_row(&row)
    }

    /// Enqueues a new background task and triggers the worker pump.
    pub async fn enqueue(
        &self,
        task_type: TaskType,
        payload: Value,
        created_by: &str,
        priority: Option<i32>,
    ) -> Result<Task, TaskError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(TaskError::Conflict(String::from(
                "Task manager is shutting down",
            )));
        }
        let created_by = created_by.trim();
        if created_by.is_empty() {
            return Err(TaskError::Validation(String::from(
                "Task owner is required",
            )));
        }

        let priority = priority.unwrap_or_else(|| task_type.default_priority());
        if !(0..=1000).contains(&priority) {
            return Err(TaskError::Validation(String::from(
                "Priority must be an integer from 0 to 1000",
            )));
        }

        {
            let guard = self
                .registry
                .read()
                .map_err(|_| TaskError::Conflict(String::from("Lock poisoned")))?;
            let Some(def) = guard.definitions.get(&task_type) else {
                return Err(TaskError::Conflict(format!(
                    "No worker is registered for {}",
                    task_type.as_str()
                )));
            };
            if !def.validate(&payload) {
                return Err(TaskError::Validation(format!(
                    "Invalid {} task payload",
                    task_type.as_str()
                )));
            }
        }

        if task_type == TaskType::SonicAudioAnalysis
            && self.find_pending(task_type, &json!({})).await.is_some()
        {
            return Err(TaskError::Conflict(String::from(
                "Sonic analysis is already queued or running",
            )));
        }

        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| TaskError::Conflict(String::from("Database is unavailable")))?;

        let id = format!("task_{}", nanoid!(16));
        let now = Utc::now().to_rfc3339();
        let payload_json = serialize_task_payload(&payload)?;
        let progress = TaskProgress::default();
        let progress_json =
            serde_json::to_string(&progress).unwrap_or_else(|_| String::from("{}"));

        sqlx::query(
            r"
            INSERT INTO background_tasks (
                id, type, state, priority, payload_json, progress_json,
                created_by, created_at, updated_at
            )
            VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(&id)
        .bind(task_type.as_str())
        .bind(priority)
        .bind(payload_json)
        .bind(progress_json)
        .bind(created_by)
        .bind(&now)
        .bind(&now)
        .execute(pool.inner())
        .await
        .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?;

        let task = self.require_task(&id).await?;
        let _ = self.events_tx.send(TaskEvent::State(task.clone()));
        self.spawn_pump();
        Ok(task)
    }

    /// Lists tasks (`limit` in `1..=500`).
    pub async fn list(
        &self,
        limit: Option<usize>,
        include_terminal: bool,
    ) -> Result<Vec<Task>, TaskError> {
        let limit = limit.unwrap_or(100);
        if !(1..=500).contains(&limit) {
            return Err(TaskError::Validation(String::from(
                "Task list limit must be from 1 to 500",
            )));
        }
        let Some(pool) = &self.db else {
            return Ok(Vec::new());
        };

        let rows = if include_terminal {
            sqlx::query(
                "SELECT * FROM background_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?",
            )
            .bind(limit as i64)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default()
        } else {
            sqlx::query(
                r"
                SELECT * FROM background_tasks
                WHERE state IN ('QUEUED', 'PROCESSING', 'PAUSED')
                ORDER BY priority DESC, created_at, rowid
                LIMIT ?
                ",
            )
            .bind(limit as i64)
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default()
        };

        Ok(rows.iter().filter_map(Self::map_row).collect())
    }

    /// Returns current worker and memory telemetry.
    #[must_use]
    pub fn metrics(&self) -> TaskMetrics {
        let rss = sample_process_rss_bytes();
        TaskMetrics {
            memory_bytes: rss,
            free_memory_bytes: 1024 * 1024 * 1024,
            total_memory_bytes: 4 * 1024 * 1024 * 1024,
            load_per_core: 0.1,
            active_streams: self.media_streams.load(Ordering::Relaxed),
            active_workers: self.active_slots.load(Ordering::Relaxed),
            max_concurrent: self.max_concurrent,
            constrained: false,
        }
    }

    /// Returns the diagnostic logs (`background_task_logs`) for `id`.
    pub async fn diagnostics(&self, id: &str) -> Result<Vec<TaskLogEntry>, TaskError> {
        self.require_task(id).await?;
        let Some(pool) = &self.db else {
            return Ok(Vec::new());
        };
        let rows = sqlx::query(
            "SELECT seq, at, source, message FROM background_task_logs WHERE task_id = ? ORDER BY seq",
        )
        .bind(id)
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        Ok(rows
            .into_iter()
            .filter_map(|r| {
                Some(TaskLogEntry {
                    seq: r.try_get("seq").ok()?,
                    at: r.try_get("at").ok()?,
                    source: r.try_get("source").ok()?,
                    message: r.try_get("message").ok()?,
                })
            })
            .collect())
    }

    /// Deletes all terminal (`FINISHED`, `FAILED`, `CANCELLED`) tasks and broadcasts `history.cleared`.
    pub async fn clear_history(&self) -> Vec<String> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let rows = sqlx::query(
            "SELECT id FROM background_tasks WHERE state IN ('FINISHED', 'FAILED', 'CANCELLED')",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        let ids: Vec<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get("id").ok())
            .collect();

        let _ = sqlx::query(
            "DELETE FROM background_tasks WHERE state IN ('FINISHED', 'FAILED', 'CANCELLED')",
        )
        .execute(pool.inner())
        .await;

        let _ = self.events_tx.send(TaskEvent::HistoryCleared(ids.clone()));
        ids
    }

    /// Pauses a `QUEUED` or `PROCESSING` task.
    pub async fn pause(&self, id: &str) -> Result<Task, TaskError> {
        let task = self.require_task(id).await?;
        if task.state.is_terminal() {
            return Err(TaskError::Conflict(String::from(
                "Finished tasks cannot be paused",
            )));
        }

        let has_active = {
            let guard = self.registry.read().ok();
            guard.and_then(|g| g.active.get(id).cloned())
        };

        if let Some(handle) = has_active {
            handle.manual_pause.store(true, Ordering::Release);
        }
        self.update_task_fields(id, Some(TaskStatus::Paused), None, None, None, None, None)
            .await
    }

    /// Resumes a `PAUSED` task.
    pub async fn resume(&self, id: &str) -> Result<Task, TaskError> {
        let task = self.require_task(id).await?;
        if task.state.is_terminal() {
            return Err(TaskError::Conflict(String::from(
                "Finished tasks cannot be resumed",
            )));
        }

        let has_active = {
            let guard = self.registry.read().ok();
            guard.and_then(|g| g.active.get(id).cloned())
        };

        if let Some(handle) = has_active {
            handle.manual_pause.store(false, Ordering::Release);
            self.update_task_fields(
                id,
                Some(TaskStatus::Processing),
                None,
                None,
                None,
                None,
                None,
            )
            .await
        } else if task.state == TaskStatus::Paused {
            let updated = self
                .update_task_fields(id, Some(TaskStatus::Queued), None, None, None, None, None)
                .await?;
            self.spawn_pump();
            Ok(updated)
        } else {
            Ok(task)
        }
    }

    /// Cancels a non-terminal task, triggering its [`CancellationToken`].
    pub async fn cancel(&self, id: &str) -> Result<Task, TaskError> {
        let task = self.require_task(id).await?;
        if task.state.is_terminal() {
            return Err(TaskError::Conflict(String::from(
                "Finished tasks cannot be cancelled",
            )));
        }

        let has_active = {
            let guard = self.registry.read().ok();
            guard.and_then(|g| g.active.get(id).cloned())
        };

        if let Some(handle) = has_active {
            handle.cancel_token.cancel();
        }

        let now = Utc::now().to_rfc3339();
        let updated = self
            .update_task_fields(
                id,
                Some(TaskStatus::Cancelled),
                None,
                Some(Some(String::from("Cancelled"))),
                None,
                Some(Some(now)),
                None,
            )
            .await?;
        self.spawn_pump();
        Ok(updated)
    }

    /// Updates a non-terminal task's priority (`0..=1000`).
    pub async fn reprioritize(&self, id: &str, priority: i32) -> Result<Task, TaskError> {
        if !(0..=1000).contains(&priority) {
            return Err(TaskError::Validation(String::from(
                "Priority must be an integer from 0 to 1000",
            )));
        }
        let task = self.require_task(id).await?;
        if task.state.is_terminal() {
            return Err(TaskError::Conflict(String::from(
                "Finished tasks cannot be re-prioritized",
            )));
        }

        let updated = self
            .update_task_fields(id, None, Some(priority), None, None, None, None)
            .await?;
        self.spawn_pump();
        Ok(updated)
    }

    /// Configures a 5-field cron schedule for `task_type` in `background_task_schedules`.
    pub async fn set_schedule(
        &self,
        task_type: TaskType,
        payload: Value,
        expression: &str,
        created_by: &str,
    ) -> Result<TaskSchedule, TaskError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(TaskError::Conflict(String::from(
                "Task manager is shutting down",
            )));
        }
        {
            let guard = self
                .registry
                .read()
                .map_err(|_| TaskError::Conflict(String::from("Lock poisoned")))?;
            let Some(def) = guard.definitions.get(&task_type) else {
                return Err(TaskError::Conflict(format!(
                    "No worker is registered for {}",
                    task_type.as_str()
                )));
            };
            if !def.validate(&payload) {
                return Err(TaskError::Validation(format!(
                    "Invalid {} task payload",
                    task_type.as_str()
                )));
            }
        }

        let normalized = validate_five_field_cron(expression)?;
        let payload_json = serialize_task_payload(&payload)?;
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| TaskError::Conflict(String::from("Database is unavailable")))?;

        let mut tx = pool.inner().begin().await.map_err(schedule_db_error)?;
        let saved_id = upsert_schedule(&mut tx, task_type, &payload_json, &normalized, created_by)
            .await
            .map_err(schedule_db_error)?;
        if task_type == TaskType::LibraryScan {
            write_library_schedule_setting(&mut tx, &normalized).await?;
        }
        tx.commit().await.map_err(schedule_db_error)?;

        {
            let mut eval_guard = self.schedule_state.lock().await;
            eval_guard
                .last_fired_slot
                .retain(|(sid, _), _| sid != &saved_id);
        }

        self.ensure_scheduler_running();
        self.schedule_notify.notify_one();

        Ok(TaskSchedule {
            id: saved_id,
            task_type,
            expression: normalized,
            enabled: true,
        })
    }

    /// Removes the schedule for `task_type`.
    pub async fn remove_schedule(&self, task_type: TaskType) -> Result<(), TaskError> {
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| TaskError::Conflict(String::from("Database is unavailable")))?;
        let mut tx = pool.inner().begin().await.map_err(schedule_db_error)?;
        delete_schedule(&mut tx, task_type)
            .await
            .map_err(schedule_db_error)?;
        if task_type == TaskType::LibraryScan {
            write_library_schedule_setting(&mut tx, "").await?;
        }
        tx.commit().await.map_err(schedule_db_error)?;
        self.schedule_notify.notify_one();
        Ok(())
    }

    /// Lists all configured task schedules ordered by `task_type`.
    pub async fn list_schedules(&self) -> Vec<TaskSchedule> {
        let Some(pool) = &self.db else {
            return Vec::new();
        };
        let rows = sqlx::query(
            "SELECT id, task_type, expression, enabled FROM background_task_schedules ORDER BY task_type",
        )
        .fetch_all(pool.inner())
        .await
        .unwrap_or_default();

        rows.into_iter()
            .filter_map(|r| {
                let t_str: String = r.try_get("task_type").ok()?;
                Some(TaskSchedule {
                    id: r.try_get("id").ok()?,
                    task_type: TaskType::parse(&t_str)?,
                    expression: r.try_get("expression").ok()?,
                    enabled: r.try_get::<i64, _>("enabled").unwrap_or(0) != 0,
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_task_fields(
        &self,
        id: &str,
        next_state: Option<TaskStatus>,
        next_priority: Option<i32>,
        next_error: Option<Option<String>>,
        next_started_at: Option<Option<String>>,
        next_finished_at: Option<Option<String>>,
        next_progress: Option<TaskProgress>,
    ) -> Result<Task, TaskError> {
        let current = self.require_task(id).await?;
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| TaskError::Conflict(String::from("Database is unavailable")))?;

        let state = next_state.unwrap_or(current.state);
        let priority = next_priority.unwrap_or(current.priority);
        let error = next_error.unwrap_or(current.error.clone());
        let started_at = next_started_at.unwrap_or(current.started_at.clone());
        let finished_at = next_finished_at.unwrap_or(current.finished_at.clone());
        let progress = next_progress.unwrap_or_else(|| current.progress.clone());
        let progress_json =
            serde_json::to_string(&progress).unwrap_or_else(|_| String::from("{}"));
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r"
            UPDATE background_tasks
            SET state = ?,
                priority = ?,
                error = ?,
                started_at = ?,
                finished_at = ?,
                progress_json = ?,
                updated_at = ?
            WHERE id = ?
            ",
        )
        .bind(state.as_str())
        .bind(priority)
        .bind(error)
        .bind(started_at)
        .bind(finished_at)
        .bind(progress_json)
        .bind(&now)
        .bind(id)
        .execute(pool.inner())
        .await
        .map_err(|e| TaskError::ExecutionFailed(e.to_string()))?;

        let updated = self.require_task(id).await?;
        if next_state.is_some() && updated.state != current.state {
            let log_msg = match &updated.error {
                Some(err) => format!("{}: {err}", updated.state.as_str()),
                None => updated.state.as_str().to_owned(),
            };
            self.append_log(id, "state", &log_msg).await;
        }

        if (next_state.is_some() && updated.state != current.state)
            || (next_priority.is_some() && updated.priority != current.priority)
        {
            let _ = self.events_tx.send(TaskEvent::State(updated.clone()));
        }

        if state.is_terminal() {
            self.prune_history().await;
        }

        Ok(updated)
    }

    async fn report_progress(&self, id: &str, patch: TaskProgressPatch) {
        let Ok(task) = self.require_task(id).await else {
            return;
        };
        let prev_msg = task.progress.message.clone();
        let mut next = task.progress;

        if let Some(pct) = patch.percent {
            next.percent = if pct.is_finite() {
                pct.clamp(0.0, 100.0)
            } else {
                0.0
            };
        }
        if let Some(processed) = patch.items_processed {
            next.items_processed = processed;
        }
        if let Some(total) = patch.total_items {
            next.total_items = total;
        }
        next.memory_bytes = patch.memory_bytes.unwrap_or_else(sample_process_rss_bytes);
        if let Some(msg_opt) = patch.message {
            next.message = msg_opt.map(|m| m.chars().take(500).collect());
        }
        if let Some(speed) = patch.speed_bytes_per_second {
            next.speed_bytes_per_second = Some(if speed.is_finite() {
                speed.max(0.0)
            } else {
                0.0
            });
        }

        if let Ok(updated) = self
            .update_task_fields(id, None, None, None, None, None, Some(next.clone()))
            .await
        {
            if let Some(ref msg) = next.message {
                if Some(msg) != prev_msg.as_ref() {
                    self.append_log(id, "progress", msg).await;
                }
            }
            let _ = self.events_tx.send(TaskEvent::Progress(updated));
        }
    }

    async fn append_log(&self, id: &str, source: &str, message: &str) {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return;
        }
        let Some(pool) = &self.db else {
            return;
        };
        if self.get(id).await.is_none() {
            return;
        }

        let redacted: String = redact_text(trimmed).chars().take(2000).collect();
        let now = Utc::now().to_rfc3339();

        let _ = sqlx::query(
            "INSERT INTO background_task_logs (task_id, at, source, message) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(now)
        .bind(source)
        .bind(redacted)
        .execute(pool.inner())
        .await;

        let _ = sqlx::query(
            r"
            DELETE FROM background_task_logs
            WHERE task_id = ?
              AND seq NOT IN (
                  SELECT seq FROM background_task_logs
                  WHERE task_id = ?
                  ORDER BY seq DESC
                  LIMIT ?
              )
            ",
        )
        .bind(id)
        .bind(id)
        .bind(MAX_LOGS_PER_TASK)
        .execute(pool.inner())
        .await;
    }

    async fn prune_history(&self) {
        let Some(pool) = &self.db else {
            return;
        };
        let _ = sqlx::query(
            r"
            DELETE FROM background_tasks
            WHERE id IN (
                SELECT id FROM background_tasks
                WHERE state IN ('FINISHED', 'FAILED', 'CANCELLED')
                ORDER BY COALESCE(finished_at, updated_at) DESC, rowid DESC
                LIMIT -1 OFFSET ?
            )
            ",
        )
        .bind(MAX_TERMINAL_HISTORY)
        .execute(pool.inner())
        .await;
    }

    async fn is_blocked(&self, task_type: TaskType) -> bool {
        let streams = self.media_streams.load(Ordering::Acquire);
        if task_type.is_background_task() && streams > 0 {
            return true;
        }
        if task_type == TaskType::SonicAudioAnalysis {
            if let Some(pool) = &self.db {
                let spotdl_active = sqlx::query(
                    r"
                    SELECT 1 FROM background_tasks
                    WHERE type IN ('SPOTDL_IMPORT', 'SPOTDL_DOWNLOAD')
                      AND priority >= 200
                      AND state IN ('QUEUED', 'PROCESSING')
                    LIMIT 1
                    ",
                )
                .fetch_optional(pool.inner())
                .await
                .ok()
                .flatten()
                .is_some();
                if spotdl_active {
                    return true;
                }
            }
        }
        false
    }

    async fn checkpoint(&self, id: &str, handle: &ActiveTaskHandle) -> Result<(), TaskError> {
        if handle.cancel_token.is_cancelled() {
            return Err(TaskError::Cancelled);
        }
        let task = self.require_task(id).await?;
        let blocked = self.is_blocked(task.task_type).await;
        handle.resource_pause.store(blocked, Ordering::Release);

        while (handle.manual_pause.load(Ordering::Acquire)
            || handle.resource_pause.load(Ordering::Acquire))
            && !handle.cancel_token.is_cancelled()
        {
            if handle.slot_held.swap(false, Ordering::AcqRel) {
                self.active_slots.fetch_sub(1, Ordering::AcqRel);
            }
            if self.get(id).await.map(|t| t.state) != Some(TaskStatus::Paused) {
                let _ = self
                    .update_task_fields(id, Some(TaskStatus::Paused), None, None, None, None, None)
                    .await;
            }
            self.spawn_pump();
            tokio::select! {
                () = handle.cancel_token.cancelled() => return Err(TaskError::Cancelled),
                () = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
            let b = self.is_blocked(task.task_type).await;
            handle.resource_pause.store(b, Ordering::Release);
        }

        if handle.cancel_token.is_cancelled() {
            return Err(TaskError::Cancelled);
        }
        if !handle.slot_held.swap(true, Ordering::AcqRel) {
            self.active_slots.fetch_add(1, Ordering::AcqRel);
        }
        if self.get(id).await.map(|t| t.state) == Some(TaskStatus::Paused) {
            let _ = self
                .update_task_fields(
                    id,
                    Some(TaskStatus::Processing),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await;
        }
        Ok(())
    }

    fn spawn_pump(&self) {
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        let mgr = self.clone();
        tokio::spawn(async move {
            mgr.pump().await;
        });
    }

    async fn pump(&self) {
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        if self
            .pumping
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        if let Some(pool) = &self.db {
            let rows = sqlx::query(
                r"
                SELECT id, type FROM background_tasks
                WHERE state = 'QUEUED'
                ORDER BY priority DESC, created_at, rowid
                ",
            )
            .fetch_all(pool.inner())
            .await
            .unwrap_or_default();

            for row in rows {
                if self.active_slots.load(Ordering::Acquire) >= self.max_concurrent {
                    break;
                }
                let Ok(id) = row.try_get::<String, _>("id") else {
                    continue;
                };
                let Ok(type_str) = row.try_get::<String, _>("type") else {
                    continue;
                };
                let Some(task_type) = TaskType::parse(&type_str) else {
                    continue;
                };

                let def = {
                    let Ok(guard) = self.registry.read() else {
                        continue;
                    };
                    if guard.active.contains_key(&id) {
                        continue;
                    }
                    guard.definitions.get(&task_type).cloned()
                };
                let Some(def) = def else {
                    continue;
                };

                if self.is_blocked(task_type).await {
                    continue;
                }

                let Ok(task) = self.require_task(&id).await else {
                    continue;
                };
                self.start_task(task, def);
            }
        }

        self.pumping.store(false, Ordering::Release);
    }

    fn start_task(&self, task: Task, definition: Arc<dyn TaskDefinition>) {
        let handle = ActiveTaskHandle {
            cancel_token: CancellationToken::new(),
            manual_pause: Arc::new(AtomicBool::new(false)),
            resource_pause: Arc::new(AtomicBool::new(false)),
            slot_held: Arc::new(AtomicBool::new(true)),
        };
        self.active_slots.fetch_add(1, Ordering::AcqRel);

        if let Ok(mut guard) = self.registry.write() {
            guard.active.insert(task.id.clone(), handle.clone());
        }

        let mgr = self.clone();
        tokio::spawn(async move {
            let ctx = TaskRunContext {
                task_id: task.id.clone(),
                manager: mgr.clone(),
                handle: handle.clone(),
            };

            let started_at = task
                .started_at
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let _ = mgr
                .update_task_fields(
                    &task.id,
                    Some(TaskStatus::Processing),
                    None,
                    Some(None),
                    Some(Some(started_at)),
                    None,
                    None,
                )
                .await;

            let outcome = async {
                ctx.checkpoint().await?;
                definition.run(task.payload.clone(), ctx.clone()).await?;
                ctx.throw_if_cancelled()?;
                Ok::<(), TaskError>(())
            }
            .await;

            let now = Utc::now().to_rfc3339();
            match outcome {
                Ok(()) => {
                    if let Ok(curr) = mgr.require_task(&task.id).await {
                        let mut final_prog = curr.progress;
                        final_prog.percent = 100.0;
                        final_prog.memory_bytes = sample_process_rss_bytes();
                        let _ = mgr
                            .update_task_fields(
                                &task.id,
                                Some(TaskStatus::Finished),
                                None,
                                None,
                                None,
                                Some(Some(now)),
                                Some(final_prog),
                            )
                            .await;
                    }
                }
                Err(TaskError::Cancelled) => {
                    let _ = mgr
                        .update_task_fields(
                            &task.id,
                            Some(TaskStatus::Cancelled),
                            None,
                            Some(Some(String::from("Cancelled"))),
                            None,
                            Some(Some(now)),
                            None,
                        )
                        .await;
                }
                Err(_) if handle.cancel_token.is_cancelled() => {
                    let _ = mgr
                        .update_task_fields(
                            &task.id,
                            Some(TaskStatus::Cancelled),
                            None,
                            Some(Some(String::from("Cancelled"))),
                            None,
                            Some(Some(now)),
                            None,
                        )
                        .await;
                }
                Err(err) => {
                    let err_msg = err.to_string();
                    tracing::error!(
                        task_id = %task.id,
                        task_type = task.task_type.as_str(),
                        error = %err_msg,
                        "Background task failed"
                    );
                    if let Err(persist_error) = mgr
                        .update_task_fields(
                            &task.id,
                            Some(TaskStatus::Failed),
                            None,
                            Some(Some(err_msg.clone())),
                            None,
                            Some(Some(now)),
                            None,
                        )
                        .await
                    {
                        tracing::error!(
                            task_id = %task.id,
                            error = %persist_error,
                            original_error = %err_msg,
                            "Could not persist failed task state"
                        );
                    }
                }
            }

            if handle.slot_held.swap(false, Ordering::AcqRel) {
                mgr.active_slots.fetch_sub(1, Ordering::AcqRel);
            }
            if let Ok(mut guard) = mgr.registry.write() {
                guard.active.remove(&task.id);
            }
            mgr.spawn_pump();
        });
    }

    /// Waits until task `id` reaches a terminal state (`FINISHED`, `FAILED`, `CANCELLED`),
    /// returning `Err(TaskError::NotFound)` if `id` does not exist.
    pub async fn wait_for_settlement(
        &self,
        id: &str,
        timeout: Duration,
    ) -> Result<Task, TaskError> {
        let initial = self.require_task(id).await?;
        if initial.state.is_terminal() {
            return Ok(initial);
        }
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let curr = self.require_task(id).await?;
            if curr.state.is_terminal() {
                return Ok(curr);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(curr);
            }
            tokio::select! {
                _ = rx.recv() => {},
                () = tokio::time::sleep(Duration::from_millis(15)) => {},
            }
        }
    }

    /// Gracefully stops the task manager and cancels all active workers and cron timers.
    pub fn close(&self) {
        self.stopping.store(true, Ordering::Release);
        self.schedule_notify.notify_waiters();
        if let Ok(guard) = self.registry.read() {
            for handle in guard.active.values() {
                handle.cancel_token.cancel();
            }
        }
    }
}
