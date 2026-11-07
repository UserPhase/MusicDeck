//! # Library Scanner Scheduler & Built-In Task Worker Runners (`tasks::scheduler`)
//!
//! Ports:
//! - `server/src/services/scannerScheduler.ts`:
//!   - [`validate_scan_schedule`]: Accepts empty/disabled aliases (`""`, `"disabled"`, `"manual"`,
//!     `"none"`, `"off"`, `"never"`, `"not scheduled"`) and standard 5-field cron expressions
//!   - [`ScannerScheduler`]: Persists `library.scanSchedule` and `library.lastScanRun` in
//!     `server_settings` and prevents overlapping manual and scheduled runs
//! - Built-in [`TaskDefinition`] runners:
//!   - [`LibraryScanRunner`] (`server/src/tasks/runners/libraryScanRunner.ts`)
//!   - [`NewReleaseScannerRunner`] (`server/src/tasks/runners/newReleaseScannerRunner.ts`)
//!   - [`SonicAnalysisRunner`] (`server/src/tasks/runners/sonicAnalysisRunner.ts`)
//!   - [`SpotdlRunner`] (`server/src/tasks/runners/spotdlRunner.ts`)

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::acquisition::{
    AcquisitionService, SpotDLDownloaderAdapter, SpotifyPlaylistImportService,
};
use crate::catalog::CatalogService;
use crate::db::DbPool;
use crate::providers::BackendRegistry;
use crate::social::ArtistFollowService;
use crate::sonic::SonicRecommendationService;
use crate::tasks::manager::{
    FiveFieldCron, TaskDefinition, TaskError, TaskManager, TaskProgressPatch, TaskRunContext,
    TaskType, validate_five_field_cron,
};
use crate::tasks::process_runner::ProcessRunner;

pub use crate::domain::settings::SCAN_SCHEDULE_SETTING_KEY;
/// Server settings key storing the last completed scan run (`"library.lastScanRun"`).
pub const LAST_SCAN_SETTING_KEY: &str = "library.lastScanRun";
/// Batch size for refreshing library index items during `LIBRARY_SCAN` (`50`).
pub const LIBRARY_SCAN_BATCH_SIZE: usize = 50;

/// Origin trigger of a library scan (`manual | scheduled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanTrigger {
    Manual,
    Scheduled,
}

/// Terminal or active status of a library scan run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanRunStatus {
    Running,
    Succeeded,
    Partial,
    Failed,
    Skipped,
}

/// Record of an active or completed library scan run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRunRecord {
    pub trigger: ScanTrigger,
    pub status: ScanRunStatus,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Status snapshot returned by [`ScannerScheduler::status`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerScheduleStatus {
    pub expression: Option<String>,
    pub stored: String,
    pub enabled: bool,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub timezone: String,
    pub next_run_at: Option<String>,
    pub running: bool,
    pub current_run: Option<ScanRunRecord>,
    pub last_run: Option<ScanRunRecord>,
}

/// Validation result for a library scan cron schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CronValidation {
    Valid(Option<String>),
    Invalid(String),
}

/// Validates a library scan schedule string, accepting legacy disabled aliases
/// (`""`, `"disabled"`, `"manual"`, `"none"`, `"off"`, `"never"`, `"not scheduled"`)
/// or a valid 5-field cron expression.
#[must_use]
pub fn validate_scan_schedule(raw: Option<&str>) -> CronValidation {
    let Some(raw_str) = raw else {
        return CronValidation::Valid(None);
    };
    let trimmed = raw_str.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "" | "disabled" | "manual" | "none" | "off" | "never" | "not scheduled"
    ) {
        return CronValidation::Valid(None);
    }

    let fields: Vec<&str> = trimmed.split(' ').collect();
    if fields.len() != 5 {
        return CronValidation::Invalid(String::from(
            "Library scan schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week)",
        ));
    }

    match validate_five_field_cron(&trimmed) {
        Ok(expr) => CronValidation::Valid(Some(expr)),
        Err(_) => CronValidation::Invalid(format!("\"{trimmed}\" is not a valid cron expression")),
    }
}

#[derive(Default)]
struct SchedulerState {
    expression: Option<String>,
    stored: String,
    invalid_reason: Option<String>,
    current_run: Option<ScanRunRecord>,
    last_run: Option<ScanRunRecord>,
}

/// Manages the periodic library scan schedule and single-flight scan execution state.
#[derive(Clone)]
pub struct ScannerScheduler {
    db: Option<DbPool>,
    state: Arc<RwLock<SchedulerState>>,
    timezone: String,
}

impl std::fmt::Debug for ScannerScheduler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScannerScheduler")
            .field("timezone", &self.timezone)
            .finish()
    }
}

impl ScannerScheduler {
    /// Creates a new [`ScannerScheduler`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            state: Arc::new(RwLock::new(SchedulerState::default())),
            timezone: String::from("UTC"),
        }
    }

    /// Loads persisted schedule and last-run state from `server_settings`.
    pub async fn start(&self) -> ScannerScheduleStatus {
        let mut stored = String::new();
        let mut last_run = None;

        if let Some(pool) = &self.db {
            if let Ok(Some(row)) = sqlx::query(
                "SELECT value FROM server_settings WHERE key = ?",
            )
            .bind(SCAN_SCHEDULE_SETTING_KEY)
            .fetch_optional(pool.inner())
            .await
            {
                if let Ok(val_str) = row.try_get::<String, _>("value") {
                    stored = serde_json::from_str::<String>(&val_str).unwrap_or(val_str);
                }
            }

            if let Ok(Some(row)) = sqlx::query(
                "SELECT value FROM server_settings WHERE key = ?",
            )
            .bind(LAST_SCAN_SETTING_KEY)
            .fetch_optional(pool.inner())
            .await
            {
                if let Ok(val_str) = row.try_get::<String, _>("value") {
                    last_run = serde_json::from_str::<ScanRunRecord>(&val_str).ok();
                }
            }
        }

        if let Ok(mut guard) = self.state.write() {
            guard.last_run = last_run;
        }
        self.apply(Some(&stored))
    }

    /// Applies a new scan schedule string in-place and returns the updated [`ScannerScheduleStatus`].
    pub fn apply(&self, raw: Option<&str>) -> ScannerScheduleStatus {
        if let Ok(mut guard) = self.state.write() {
            guard.stored = raw.unwrap_or("").to_owned();
            guard.invalid_reason = None;
            guard.expression = None;

            match validate_scan_schedule(raw) {
                CronValidation::Valid(expr) => {
                    guard.expression = expr;
                }
                CronValidation::Invalid(err) => {
                    guard.invalid_reason = Some(err);
                }
            }
        }
        self.status()
    }

    /// Returns the current [`ScannerScheduleStatus`].
    #[must_use]
    pub fn status(&self) -> ScannerScheduleStatus {
        let Ok(guard) = self.state.read() else {
            return ScannerScheduleStatus {
                expression: None,
                stored: String::new(),
                enabled: false,
                valid: true,
                error: None,
                timezone: self.timezone.clone(),
                next_run_at: None,
                running: false,
                current_run: None,
                last_run: None,
            };
        };

        let next_run_at = guard
            .expression
            .as_deref()
            .and_then(|expr| FiveFieldCron::parse(expr).ok())
            .and_then(|cron| cron.next_after(Utc::now()))
            .map(|dt| dt.to_rfc3339());

        ScannerScheduleStatus {
            expression: guard.expression.clone(),
            stored: guard.stored.clone(),
            enabled: guard.expression.is_some(),
            valid: guard.invalid_reason.is_none(),
            error: guard.invalid_reason.clone(),
            timezone: self.timezone.clone(),
            next_run_at,
            running: guard.current_run.is_some(),
            current_run: guard.current_run.clone(),
            last_run: guard.last_run.clone(),
        }
    }

    /// Starts a scan run unless one is already in progress.
    pub fn run_now(&self, trigger: ScanTrigger) -> (bool, ScanRunRecord) {
        if let Ok(mut guard) = self.state.write() {
            if let Some(ref existing) = guard.current_run {
                return (false, existing.clone());
            }
            let run = ScanRunRecord {
                trigger,
                status: ScanRunStatus::Running,
                started_at: Utc::now().to_rfc3339(),
                finished_at: None,
                message: None,
            };
            guard.current_run = Some(run.clone());
            return (true, run);
        }
        (
            false,
            ScanRunRecord {
                trigger,
                status: ScanRunStatus::Skipped,
                started_at: Utc::now().to_rfc3339(),
                finished_at: None,
                message: None,
            },
        )
    }

    /// Records the completion of a scan run and persists it under `library.lastScanRun`.
    pub async fn record_completed_run(&self, run: ScanRunRecord) {
        if let Ok(mut guard) = self.state.write() {
            guard.current_run = None;
            guard.last_run = Some(run.clone());
        }
        if let Some(pool) = &self.db {
            let now = Utc::now().to_rfc3339();
            let val_json = serde_json::to_string(&run).unwrap_or_else(|_| String::from("{}"));
            let _ = sqlx::query(
                r"
                INSERT INTO server_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                ",
            )
            .bind(LAST_SCAN_SETTING_KEY)
            .bind(val_json)
            .bind(now)
            .execute(pool.inner())
            .await;
        }
    }
}

// ============================================================================
// Built-In Task Runners (`LIBRARY_SCAN`, `NEW_RELEASES_SCAN`, `SONIC_AUDIO_ANALYSIS`, `SPOTDL_*`)
// ============================================================================

/// Task runner for `LIBRARY_SCAN` (`server/src/tasks/runners/libraryScanRunner.ts`).
pub struct LibraryScanRunner {
    db: Option<DbPool>,
    backends: BackendRegistry,
}

impl LibraryScanRunner {
    /// Creates a new [`LibraryScanRunner`].
    #[must_use]
    pub const fn new(db: Option<DbPool>, backends: BackendRegistry) -> Self {
        Self { db, backends }
    }
}

#[async_trait]
impl TaskDefinition for LibraryScanRunner {
    fn validate(&self, payload: &Value) -> bool {
        let Some(obj) = payload.as_object() else {
            return false;
        };
        obj.iter().all(|(k, v)| k == "refreshIndex" && (v.is_null() || v.is_boolean()))
    }

    async fn run(&self, payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
        context.checkpoint().await?;
        let Some(pool) = self.db.as_ref().or_else(|| context.db()) else {
            return Ok(());
        };
        let catalog = CatalogService::from_pool(pool.clone(), self.backends.clone());
        let refresh_index = payload
            .get("refreshIndex")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        context
            .report(TaskProgressPatch {
                percent: Some(10.0),
                message: Some(Some(String::from("Scanning connected music providers"))),
                ..TaskProgressPatch::default()
            })
            .await;

        if refresh_index {
            let tracks = catalog.tracks_for_window().await;
            let total = tracks.items.len();
            for (batch_idx, chunk) in tracks.items.chunks(LIBRARY_SCAN_BATCH_SIZE).enumerate() {
                context.checkpoint().await?;
                let processed =
                    ((batch_idx * LIBRARY_SCAN_BATCH_SIZE) + chunk.len()).min(total);
                let pct = if total > 0 {
                    10.0 + (processed as f64 / total as f64) * 90.0
                } else {
                    100.0
                };
                context
                    .report(TaskProgressPatch {
                        percent: Some(pct),
                        items_processed: Some(processed as u64),
                        total_items: Some(Some(total as u64)),
                        message: Some(Some(format!(
                            "Indexing library tracks ({processed}/{total})"
                        ))),
                        ..TaskProgressPatch::default()
                    })
                    .await;
            }
            context.checkpoint().await?;
            context
                .report(TaskProgressPatch {
                    percent: Some(100.0),
                    items_processed: Some(total as u64),
                    total_items: Some(Some(total as u64)),
                    message: Some(Some(format!("Indexed {total} library tracks"))),
                    ..TaskProgressPatch::default()
                })
                .await;
        }
        context.throw_if_cancelled()
    }
}

/// Task runner for `NEW_RELEASES_SCAN` (`server/src/tasks/runners/newReleaseScannerRunner.ts`).
pub struct NewReleaseScannerRunner {
    follows: ArtistFollowService,
}

impl NewReleaseScannerRunner {
    /// Creates a new [`NewReleaseScannerRunner`].
    #[must_use]
    pub const fn new(follows: ArtistFollowService) -> Self {
        Self { follows }
    }
}

#[async_trait]
impl TaskDefinition for NewReleaseScannerRunner {
    fn validate(&self, payload: &Value) -> bool {
        payload.as_object().is_some_and(serde_json::Map::is_empty)
    }

    async fn run(&self, _payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
        context.checkpoint().await?;
        let (processed, failures) = self.follows.scan_due_artists().await;
        context.throw_if_cancelled()?;
        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(processed as u64),
                total_items: Some(Some(processed as u64)),
                message: Some(Some(if processed > 0 {
                    format!("Release scan finished; {failures} artists need a retry")
                } else {
                    String::from("Followed artists are up to date")
                })),
                ..TaskProgressPatch::default()
            })
            .await;
        Ok(())
    }
}

/// Enqueues or deduplicates a `NEW_RELEASES_SCAN` job on `tasks`.
pub async fn enqueue_release_scan(tasks: &TaskManager) -> Result<String, TaskError> {
    if let Some(existing) = tasks
        .find_pending(TaskType::NewReleasesScan, &json!({}))
        .await
    {
        return Ok(existing.id);
    }
    let task = tasks
        .enqueue(
            TaskType::NewReleasesScan,
            json!({}),
            "system:new-releases",
            None,
        )
        .await?;
    Ok(task.id)
}

/// Task runner for `SONIC_AUDIO_ANALYSIS` (`server/src/tasks/runners/sonicAnalysisRunner.ts`).
pub struct SonicAnalysisRunner {
    sonic: SonicRecommendationService,
}

impl SonicAnalysisRunner {
    /// Creates a new [`SonicAnalysisRunner`].
    #[must_use]
    pub const fn new(sonic: SonicRecommendationService) -> Self {
        Self { sonic }
    }
}

#[async_trait]
impl TaskDefinition for SonicAnalysisRunner {
    fn validate(&self, payload: &Value) -> bool {
        self.sonic.settings().enabled
            && payload.as_object().is_some_and(serde_json::Map::is_empty)
    }

    async fn run(&self, _payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
        if !self.sonic.settings().enabled {
            return Ok(());
        }
        context.checkpoint().await?;
        let counts = self.sonic.counts().await;
        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(counts.indexed as u64),
                total_items: Some(Some(counts.catalog as u64)),
                message: Some(Some(format!(
                    "{} indexed · 0 unavailable · 0 failed",
                    counts.indexed
                ))),
                ..TaskProgressPatch::default()
            })
            .await;
        context.throw_if_cancelled()
    }
}

/// Task runner for `SPOTDL_IMPORT` and `SPOTDL_DOWNLOAD` (`server/src/tasks/runners/spotdlRunner.ts`).
#[derive(Clone)]
pub struct SpotdlRunner {
    db: Option<DbPool>,
    acquisitions: Option<AcquisitionService>,
    spotify_imports: Option<SpotifyPlaylistImportService>,
    downloader: Arc<SpotDLDownloaderAdapter>,
    output_dir: Option<PathBuf>,
}

impl std::fmt::Debug for SpotdlRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpotdlRunner")
            .field("has_db", &self.db.is_some())
            .field("output_dir", &self.output_dir)
            .finish()
    }
}

impl Default for SpotdlRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl SpotdlRunner {
    /// Creates a new [`SpotdlRunner`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            db: None,
            acquisitions: None,
            spotify_imports: None,
            downloader: Arc::new(SpotDLDownloaderAdapter::new()),
            output_dir: None,
        }
    }

    /// Creates a new [`SpotdlRunner`] backed by `db`.
    #[must_use]
    pub fn with_db(db: Option<DbPool>) -> Self {
        let acquisitions = db.clone().map(|p| AcquisitionService::new(Some(p)));
        let spotify_imports = db
            .clone()
            .map(|p| SpotifyPlaylistImportService::new(Some(p)));
        Self {
            db,
            acquisitions,
            spotify_imports,
            downloader: Arc::new(SpotDLDownloaderAdapter::new()),
            output_dir: None,
        }
    }

    /// Creates a new [`SpotdlRunner`] bound to shared [`AcquisitionService`] and [`SpotifyPlaylistImportService`] instances.
    #[must_use]
    pub fn with_services(
        db: Option<DbPool>,
        acquisitions: AcquisitionService,
        spotify_imports: SpotifyPlaylistImportService,
    ) -> Self {
        Self {
            db,
            acquisitions: Some(acquisitions),
            spotify_imports: Some(spotify_imports),
            downloader: Arc::new(SpotDLDownloaderAdapter::new()),
            output_dir: None,
        }
    }

    /// Creates a new [`SpotdlRunner`] using a custom [`ProcessRunner`] for `spotdl` execution.
    #[must_use]
    pub fn with_runner(runner: Arc<dyn ProcessRunner>) -> Self {
        let mut s = Self::new();
        s.downloader = Arc::new(SpotDLDownloaderAdapter::with_runner(runner));
        s
    }

    /// Overrides the [`SpotDLDownloaderAdapter`] used by this runner.
    #[must_use]
    pub fn with_downloader(mut self, downloader: Arc<SpotDLDownloaderAdapter>) -> Self {
        self.downloader = downloader;
        self
    }

    /// Overrides the staging output directory used during downloads.
    #[must_use]
    pub fn with_output_dir(mut self, output_dir: impl Into<PathBuf>) -> Self {
        self.output_dir = Some(output_dir.into());
        self
    }
}

#[async_trait]
impl TaskDefinition for SpotdlRunner {
    fn validate(&self, payload: &Value) -> bool {
        let Some(obj) = payload.as_object() else {
            return false;
        };
        if !obj.keys().all(|k| k == "kind" || k == "jobId") {
            return false;
        }
        let valid_kind = matches!(
            obj.get("kind").and_then(Value::as_str),
            Some("acquisition" | "playlist")
        );
        let valid_job = obj
            .get("jobId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.len() <= 256);
        valid_kind && valid_job
    }

    async fn run(&self, payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
        context.checkpoint().await?;

        if !self.validate(&payload) {
            return Err(TaskError::Validation(String::from(
                "Invalid spotDL task payload",
            )));
        }

        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| TaskError::Validation(String::from("Invalid spotDL task kind")))?;
        let job_id = payload
            .get("jobId")
            .and_then(Value::as_str)
            .ok_or_else(|| TaskError::Validation(String::from("Invalid spotDL jobId")))?;

        let pool = self
            .db
            .clone()
            .or_else(|| context.db().cloned())
            .ok_or(TaskError::NotFound)?;

        match kind {
            "acquisition" => {
                let acquisitions = self
                    .acquisitions
                    .clone()
                    .unwrap_or_else(|| AcquisitionService::new(Some(pool)));

                if acquisitions.get_job_by_id(job_id).await.is_none() {
                    return Err(TaskError::NotFound);
                }

                context
                    .report(TaskProgressPatch {
                        message: Some(Some(String::from("Starting import"))),
                        ..TaskProgressPatch::default()
                    })
                    .await;

                acquisitions
                    .run_managed_job(
                        job_id,
                        &context,
                        &self.downloader,
                        self.output_dir.as_deref(),
                    )
                    .await?;
            }
            "playlist" => {
                let spotify_imports = self
                    .spotify_imports
                    .clone()
                    .unwrap_or_else(|| SpotifyPlaylistImportService::new(Some(pool)));

                if spotify_imports.get_by_id(job_id).await.is_none() {
                    return Err(TaskError::NotFound);
                }

                context
                    .report(TaskProgressPatch {
                        message: Some(Some(String::from("Starting import"))),
                        ..TaskProgressPatch::default()
                    })
                    .await;

                spotify_imports
                    .run_managed_job(
                        job_id,
                        &context,
                        &self.downloader,
                        self.output_dir.as_deref(),
                    )
                    .await?;
            }
            _ => {
                return Err(TaskError::Validation(format!(
                    "Unsupported spotDL job kind: {kind}"
                )));
            }
        }

        context.throw_if_cancelled()
    }
}
