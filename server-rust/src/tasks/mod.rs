//! # Background Task Manager, Process Runner & Schedulers (`tasks`)
//!
//! Exports [`ProcessRunner`], [`DefaultProcessRunner`], [`ProcessOptions`],
//! [`ProcessExecutionResult`], [`TaskManager`], [`Task`], [`TaskType`],
//! [`TaskStatus`], [`TaskProgress`], [`TaskRunContext`], [`TaskDefinition`],
//! [`ScannerScheduler`], and the built-in task runners.

pub mod manager;
pub mod process_runner;
pub mod scheduler;

pub use manager::{
    DEFAULT_CRON_TICK_INTERVAL_MS, FiveFieldCron, MAX_LOGS_PER_TASK, MAX_TASK_PAYLOAD_BYTES,
    MAX_TERMINAL_HISTORY, MediaStreamGuard, Task, TaskDefinition, TaskError, TaskEvent,
    TaskLogEntry, TaskManager, TaskMetrics, TaskProgress, TaskProgressPatch, TaskRunContext,
    TaskSchedule, TaskStatus, TaskType, validate_five_field_cron,
};
pub use process_runner::{
    DefaultProcessRunner, MAX_CAPTURE_BYTES_PER_STREAM, MAX_PARTIAL_LINE_BYTES, ProcessError,
    ProcessExecutionResult, ProcessOptions, ProcessRunner, StreamCallback, append_bounded,
};
pub use scheduler::{
    CronValidation, LAST_SCAN_SETTING_KEY, LIBRARY_SCAN_BATCH_SIZE, LibraryScanRunner,
    NewReleaseScannerRunner, SCAN_SCHEDULE_SETTING_KEY, ScanRunRecord, ScanRunStatus, ScanTrigger,
    ScannerScheduleStatus, ScannerScheduler, SonicAnalysisRunner, SpotdlRunner,
    enqueue_release_scan, validate_scan_schedule,
};

#[cfg(test)]
mod tests {
    mod spotdl;

    use std::sync::Arc;
    use std::time::Duration;

    use chrono::{TimeZone, Utc};
    use serde_json::{Value, json};

    use super::*;
    use crate::acquisition::{
        AcquisitionCreateOptions, AcquisitionJobStatus, AcquisitionService,
        SpotifyPlaylistImportService,
    };
    use crate::auth::{UserRecord, UserRole};
    use crate::db::{DbPool, run_migrations};

    struct NoopTaskRunner;

    #[async_trait::async_trait]
    impl TaskDefinition for NoopTaskRunner {
        fn validate(&self, payload: &Value) -> bool {
            payload.is_object()
        }

        async fn run(&self, _payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
            context.checkpoint().await?;
            context
                .report(TaskProgressPatch {
                    percent: Some(50.0),
                    items_processed: Some(5),
                    total_items: Some(Some(10)),
                    message: Some(Some(String::from("Halfway done"))),
                    ..TaskProgressPatch::default()
                })
                .await;
            Ok(())
        }
    }

    struct FailingProcessRunner;

    #[async_trait::async_trait]
    impl ProcessRunner for FailingProcessRunner {
        async fn run(
            &self,
            _command: &str,
            _args: &[String],
            _options: ProcessOptions,
        ) -> Result<ProcessExecutionResult, ProcessError> {
            Ok(ProcessExecutionResult {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: String::from("AudioProviderError: no results found for track"),
                signal: None,
            })
        }
    }

    async fn seed_test_user(pool: &DbPool) {
        sqlx::raw_sql(
            r"
            INSERT OR IGNORE INTO roles VALUES ('user', 'Listener'), ('admin', 'Admin');
            INSERT OR IGNORE INTO users (
                id, username, password_hash, display_name, role, disabled,
                external_playback_enabled, created_at, updated_at
            )
            VALUES (
                'alice', 'alice', 'hash', 'Alice', 'user', 0,
                1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            );
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed user alice");
    }

    #[test]
    fn validates_five_field_cron_and_bounded_stream_buffers() {
        assert!(validate_five_field_cron("30 2 * * *").is_ok());
        assert!(validate_five_field_cron("*/15 * * * 1-5").is_ok());
        assert!(validate_five_field_cron("0 0 0 * * *").is_err()); // 6 fields rejected
        assert!(validate_five_field_cron("99 * * * *").is_err());

        let cron = FiveFieldCron::parse("*/15 2 * * 1-5").expect("parse cron");
        let matching = Utc.with_ymd_and_hms(2026, 11, 6, 2, 30, 0).unwrap(); // Friday
        let non_matching = Utc.with_ymd_and_hms(2026, 11, 6, 3, 30, 0).unwrap();
        assert!(cron.matches_datetime(matching));
        assert!(!cron.matches_datetime(non_matching));
        let next = cron.next_after(matching).expect("next occurrence");
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 11, 6, 2, 45, 0).unwrap());

        assert_eq!(
            validate_scan_schedule(Some("disabled")),
            CronValidation::Valid(None)
        );
        assert_eq!(
            validate_scan_schedule(Some("17 * * * *")),
            CronValidation::Valid(Some(String::from("17 * * * *")))
        );

        let sched = ScannerScheduler::new(None);
        let st = sched.apply(Some("17 * * * *"));
        assert!(st.enabled);
        assert!(st.next_run_at.is_some());

        let mut buf = b"hello ".to_vec();
        append_bounded(&mut buf, b"world!", 8);
        assert_eq!(&buf, b"o world!");
    }

    #[tokio::test]
    async fn recovers_interrupted_tasks_and_executes_queued_jobs_to_completion() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        let manager = TaskManager::new(Some(pool.clone()));
        manager.initialize_tables().await;

        // Seed an orphaned PROCESSING task from a prior server run
        sqlx::raw_sql(
            r#"
            INSERT INTO background_tasks (
                id, type, state, priority, payload_json, progress_json,
                created_by, created_at, updated_at
            )
            VALUES (
                'orphan_1', 'LIBRARY_SCAN', 'PROCESSING', 200, '{}',
                '{"percent":20,"itemsProcessed":1,"totalItems":5,"memoryBytes":1000,"message":null}',
                'admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            );
            "#,
        )
        .execute(pool.inner())
        .await
        .expect("insert orphan task");

        manager.recover_interrupted_tasks().await;

        let recovered = manager.get("orphan_1").await.expect("get orphan_1");
        assert_eq!(recovered.state, TaskStatus::Failed);
        assert_eq!(
            recovered.error.as_deref(),
            Some("Task was interrupted by a server restart")
        );

        manager.register(TaskType::LibraryScan, Arc::new(NoopTaskRunner));
        let queued = manager
            .enqueue(TaskType::LibraryScan, json!({}), "admin", Some(250))
            .await
            .expect("enqueue library scan");

        let finished = manager
            .wait_for_settlement(&queued.id, Duration::from_secs(2))
            .await
            .expect("settle library scan");
        assert_eq!(finished.state, TaskStatus::Finished);
        assert_eq!(finished.progress.percent, 100.0);

        let logs = manager.diagnostics(&queued.id).await.expect("diagnostics");
        assert!(!logs.is_empty());

        manager.close();
        pool.close().await;
    }

    #[tokio::test]
    async fn spotdl_runner_executes_valid_acquisition_and_playlist_jobs_and_rejects_missing_ids() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");
        seed_test_user(&pool).await;

        let acquisitions = AcquisitionService::new(Some(pool.clone()));
        let spotify_imports = SpotifyPlaylistImportService::new(Some(pool.clone()));
        let manager = TaskManager::new(Some(pool.clone()));
        manager.initialize_tables().await;

        let runner: Arc<dyn TaskDefinition> = Arc::new(
            SpotdlRunner::with_services(
                Some(pool.clone()),
                acquisitions.clone(),
                spotify_imports.clone(),
            )
            .with_downloader(Arc::new(
                crate::acquisition::SpotDLDownloaderAdapter::with_runner(Arc::new(
                    spotdl::SuccessfulProcessRunner,
                )),
            )),
        );
        manager.register(TaskType::SpotdlDownload, Arc::clone(&runner));
        manager.register(TaskType::SpotdlImport, Arc::clone(&runner));

        // 1. Valid acquisition job executes payload and updates SQLite to completed
        let acq_job = acquisitions
            .create_job(
                AcquisitionCreateOptions {
                    user_id: String::from("alice"),
                    track_id: Some(String::from(
                        "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                    )),
                    ..AcquisitionCreateOptions::default()
                },
                None,
            )
            .await
            .expect("create acquisition job");
        assert_eq!(acq_job.status, AcquisitionJobStatus::Queued);

        let dl_task = manager
            .enqueue(
                TaskType::SpotdlDownload,
                json!({ "kind": "acquisition", "jobId": acq_job.id }),
                "alice",
                None,
            )
            .await
            .expect("enqueue spotdl download");

        let settled_dl = manager
            .wait_for_settlement(&dl_task.id, Duration::from_secs(3))
            .await
            .expect("settle spotdl download");
        assert_eq!(settled_dl.state, TaskStatus::Finished);
        assert_eq!(settled_dl.progress.percent, 100.0);

        let completed_acq = acquisitions
            .get_job(&acq_job.id, "alice", false)
            .await
            .expect("load completed acquisition job");
        assert_eq!(completed_acq.status, AcquisitionJobStatus::Completed);
        assert!(completed_acq.files.as_ref().is_some_and(|f| !f.is_empty()));

        // 2. Valid playlist import job executes payload and updates SQLite to completed
        let user_rec = UserRecord {
            id: String::from("alice"),
            username: String::from("alice"),
            display_name: String::from("Alice"),
            role: UserRole::User,
            avatar_ref: None,
            avatar_url: None,
            disabled: false,
            is_master_admin: false,
            external_search_enabled: true,
            external_playback_enabled: true,
            last_login_at: None,
            last_playback_at: None,
            created_at: String::from("2026-01-01T00:00:00Z"),
            updated_at: String::from("2026-01-01T00:00:00Z"),
        };
        let import_job = spotify_imports
            .start(
                "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
                &user_rec,
                None,
            )
            .await
            .expect("start playlist import");
        assert_eq!(import_job.status, "queued");

        let imp_task = manager
            .enqueue(
                TaskType::SpotdlImport,
                json!({ "kind": "playlist", "jobId": import_job.id }),
                "alice",
                None,
            )
            .await
            .expect("enqueue spotdl import");

        let settled_imp = manager
            .wait_for_settlement(&imp_task.id, Duration::from_secs(3))
            .await
            .expect("settle spotdl import");
        assert_eq!(settled_imp.state, TaskStatus::Finished);

        let completed_imp = spotify_imports
            .get(&import_job.id, "alice")
            .await
            .expect("load completed playlist import");
        assert_eq!(completed_imp.status, "completed");
        assert_eq!(completed_imp.stage, "completed");

        // 3. Non-existent job IDs fail with TaskError::NotFound instead of marking success
        let missing_acq_task = manager
            .enqueue(
                TaskType::SpotdlDownload,
                json!({ "kind": "acquisition", "jobId": "acq_nonexistent_id" }),
                "alice",
                None,
            )
            .await
            .expect("enqueue missing acquisition task");

        let settled_missing_acq = manager
            .wait_for_settlement(&missing_acq_task.id, Duration::from_secs(2))
            .await
            .expect("settle missing acquisition task");
        assert_eq!(settled_missing_acq.state, TaskStatus::Failed);
        assert_eq!(
            settled_missing_acq.error.as_deref(),
            Some(TaskError::NotFound.to_string().as_str())
        );

        let missing_pl_task = manager
            .enqueue(
                TaskType::SpotdlImport,
                json!({ "kind": "playlist", "jobId": "spimp_nonexistent_id" }),
                "alice",
                None,
            )
            .await
            .expect("enqueue missing playlist task");

        let settled_missing_pl = manager
            .wait_for_settlement(&missing_pl_task.id, Duration::from_secs(2))
            .await
            .expect("settle missing playlist task");
        assert_eq!(settled_missing_pl.state, TaskStatus::Failed);
        assert_eq!(
            settled_missing_pl.error.as_deref(),
            Some(TaskError::NotFound.to_string().as_str())
        );

        manager.close();
        pool.close().await;
    }

    #[tokio::test]
    async fn runner_execution_errors_mark_job_and_task_failed_with_exact_error_message() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");
        seed_test_user(&pool).await;

        let acquisitions = AcquisitionService::new(Some(pool.clone()));
        let manager = TaskManager::new(Some(pool.clone()));
        manager.initialize_tables().await;

        let failing_runner = Arc::new(SpotdlRunner::with_runner(Arc::new(FailingProcessRunner)));
        manager.register(TaskType::SpotdlDownload, failing_runner);

        let job = acquisitions
            .create_job(
                AcquisitionCreateOptions {
                    user_id: String::from("alice"),
                    track_id: Some(String::from("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")),
                    ..AcquisitionCreateOptions::default()
                },
                None,
            )
            .await
            .expect("create job");

        let task = manager
            .enqueue(
                TaskType::SpotdlDownload,
                json!({ "kind": "acquisition", "jobId": job.id }),
                "alice",
                None,
            )
            .await
            .expect("enqueue task");

        let settled = manager
            .wait_for_settlement(&task.id, Duration::from_secs(2))
            .await
            .expect("wait for failed task");
        assert_eq!(settled.state, TaskStatus::Failed);
        assert_eq!(
            settled.error.as_deref(),
            Some("spotDL failed (no-match): exit Some(1)")
        );

        let failed_job = acquisitions
            .get_job(&job.id, "alice", false)
            .await
            .expect("load failed acquisition job");
        assert_eq!(failed_job.status, AcquisitionJobStatus::Failed);
        assert_eq!(
            failed_job.error_message.as_deref(),
            Some("spotDL failed (no-match): exit Some(1)")
        );

        manager.close();
        pool.close().await;
    }

    #[tokio::test]
    async fn cron_scheduler_worker_automatically_dispatches_scheduled_tasks_and_recovers_from_clock_skew() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        let manager = TaskManager::new(Some(pool.clone()))
            .with_cron_tick_interval(Duration::from_millis(25));
        manager.initialize_tables().await;
        manager.register(TaskType::LibraryScan, Arc::new(NoopTaskRunner));

        // 1. Active Tokio interval worker automatically triggers a due("* * * * *") schedule
        let schedule = manager
            .set_schedule(TaskType::LibraryScan, json!({}), "* * * * *", "admin")
            .await
            .expect("configure every-minute schedule");
        assert!(schedule.enabled);

        let mut scheduled_tasks = Vec::new();
        for _ in 0..40 {
            let all = manager.list(Some(50), true).await.expect("list tasks");
            if all
                .iter()
                .any(|t| t.task_type == TaskType::LibraryScan && t.state == TaskStatus::Finished)
            {
                scheduled_tasks = all;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        assert_eq!(
            scheduled_tasks.len(),
            1,
            "expected cron worker to automatically enqueue and complete 1 scheduled task"
        );
        assert_eq!(scheduled_tasks[0].state, TaskStatus::Finished);

        // 2. Deterministic timestamp evaluation & backward clock skew recovery
        manager.remove_schedule(TaskType::LibraryScan).await.unwrap();
        manager.clear_history().await;

        manager.register(TaskType::NewReleasesScan, Arc::new(NoopTaskRunner));
        manager
            .set_schedule(
                TaskType::NewReleasesScan,
                json!({}),
                "15 4 * * *",
                "system:cron",
            )
            .await
            .expect("set 04:15 schedule");

        let t_before = Utc.with_ymd_and_hms(2026, 11, 6, 4, 14, 0).unwrap();
        let t_due = Utc.with_ymd_and_hms(2026, 11, 6, 4, 15, 0).unwrap();
        let t_same_min = Utc.with_ymd_and_hms(2026, 11, 6, 4, 15, 45).unwrap();
        let t_skew_back = Utc.with_ymd_and_hms(2026, 11, 5, 4, 15, 0).unwrap();

        assert_eq!(manager.evaluate_schedules_at(t_before).await, 0);
        assert_eq!(manager.evaluate_schedules_at(t_due).await, 1);
        // Same minute slot must not double-enqueue
        assert_eq!(manager.evaluate_schedules_at(t_same_min).await, 0);

        // Wait for the dispatched task to settle before testing clock-skew recovery
        let tasks_after_due = manager.list(Some(50), true).await.expect("list tasks");
        for t in &tasks_after_due {
            let _ = manager
                .wait_for_settlement(&t.id, Duration::from_secs(2))
                .await;
        }

        // Backward clock skew resets future slot markers and allows the new due slot to fire
        assert_eq!(manager.evaluate_schedules_at(t_skew_back).await, 1);

        manager.close();
        pool.close().await;
    }
}
