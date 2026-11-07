use super::*;
use crate::acquisition::{SpotDLDownloaderAdapter, SqliteImportJobRepository, StoredImportJob};

/// Explicit success fixture, injected only by tests; production always spawns spotDL.
pub(super) struct SuccessfulProcessRunner;

#[async_trait::async_trait]
impl ProcessRunner for SuccessfulProcessRunner {
    async fn run(
        &self,
        _command: &str,
        _args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        let directory = options.cwd.expect("download output directory");
        // A small valid mono PCM WAV file for the output discovery step.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&356_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8000_u32.to_le_bytes());
        wav.extend_from_slice(&16000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&320_u32.to_le_bytes());
        wav.resize(364, 0);
        tokio::fs::write(directory.join("fixture.wav"), wav)
            .await
            .expect("write fixture audio");
        Ok(ProcessExecutionResult {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            signal: None,
        })
    }
}

struct SpawnFailureRunner;

#[async_trait::async_trait]
impl ProcessRunner for SpawnFailureRunner {
    async fn run(
        &self,
        command: &str,
        _args: &[String],
        _options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        Err(ProcessError::SpawnFailed {
            command: command.to_owned(),
            reason: String::from("fixture: access denied while starting spotDL"),
        })
    }
}

struct NoOutputRunner;

#[async_trait::async_trait]
impl ProcessRunner for NoOutputRunner {
    async fn run(
        &self,
        _command: &str,
        _args: &[String],
        _options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        Ok(ProcessExecutionResult {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            signal: None,
        })
    }
}

async fn assert_failed_downloads(
    downloader: SpotDLDownloaderAdapter,
    expected_error: &str,
    include_manifest: bool,
    production_defaults: bool,
) {
    let pool = DbPool::connect_memory().await.expect("database");
    run_migrations(&pool, None).await.expect("migrations");
    seed_test_user(&pool).await;
    let output = tempfile::tempdir().expect("staging root");
    let acquisitions = AcquisitionService::new(Some(pool.clone()));
    let imports = SpotifyPlaylistImportService::new(Some(pool.clone()));
    let manager = TaskManager::new(Some(pool.clone()));
    manager.initialize_tables().await;
    let runner =
        SpotdlRunner::with_services(Some(pool.clone()), acquisitions.clone(), imports.clone());
    let runner = if production_defaults {
        runner
    } else {
        runner.with_downloader(Arc::new(downloader))
    };
    let runner: Arc<dyn TaskDefinition> = Arc::new(runner.with_output_dir(output.path()));
    manager.register(TaskType::SpotdlDownload, Arc::clone(&runner));
    manager.register(TaskType::SpotdlImport, runner);

    let kinds = if include_manifest {
        vec!["acquisition", "playlist", "manifest"]
    } else {
        vec!["acquisition", "playlist"]
    };
    for kind in kinds {
        let job_id = if kind == "acquisition" {
            acquisitions
                .create_job(
                    AcquisitionCreateOptions {
                        user_id: String::from("alice"),
                        track_id: Some(String::from(
                            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                        )),
                        ..Default::default()
                    },
                    None,
                )
                .await
                .expect("acquisition job")
                .id
        } else {
            let job_id = format!("import-{kind}");
            let mut record: StoredImportJob = serde_json::from_value(json!({
                "job": {"id": job_id, "userId": "alice", "status": "queued", "stage": "queued"},
                "playlistUrl": "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
                "user": {"id": "alice", "disabled": false}
            }))
            .expect("playlist fixture");
            if kind == "manifest" {
                // A prior successful track must not hide a fatal spawn error on the next.
                record.job.completed_count = Some(1);
                record.job.manifest = Some(serde_json::from_value(json!([
                    {"position": 0, "status": "COMPLETED", "source": {
                        "position": 0, "url": "", "title": "Previous track", "artist": "Fixture"
                    }},
                    {"position": 1, "status": "PENDING", "source": {
                        "position": 1, "url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                        "title": "Next track", "artist": "Fixture"
                    }}
                ])).expect("manifest fixture"));
            }
            SqliteImportJobRepository::new(pool.clone())
                .save(&record)
                .await
                .expect("save import");
            job_id
        };
        let task_type = if kind == "acquisition" {
            TaskType::SpotdlDownload
        } else {
            TaskType::SpotdlImport
        };
        let task_kind = if kind == "acquisition" {
            "acquisition"
        } else {
            "playlist"
        };
        let task = manager
            .enqueue(
                task_type,
                json!({"kind": task_kind, "jobId": job_id}),
                "alice",
                None,
            )
            .await
            .expect("enqueue task");
        let settled = manager
            .wait_for_settlement(&task.id, Duration::from_secs(5))
            .await
            .expect("task settlement");
        assert_eq!(settled.state, TaskStatus::Failed, "{kind}");
        assert_eq!(settled.error.as_deref(), Some(expected_error), "{kind}");
        assert!(settled.progress.percent < 100.0);
        let (state, error): (String, Option<String>) =
            sqlx::query_as("SELECT state, error FROM background_tasks WHERE id = ?")
                .bind(&task.id)
                .fetch_one(pool.inner())
                .await
                .expect("saved task");
        assert_eq!(state, "FAILED");
        assert_eq!(error.as_deref(), Some(expected_error));
        if kind == "acquisition" {
            let job = acquisitions
                .get_job(&job_id, "alice", false)
                .await
                .expect("saved acquisition");
            assert_eq!(job.status, AcquisitionJobStatus::Failed);
            assert_eq!(job.error_message.as_deref(), Some(expected_error));
            assert!(job.files.unwrap_or_default().is_empty());
        } else {
            let job = imports.get(&job_id, "alice").await.expect("saved import");
            assert_eq!(job.status, "failed");
            assert_eq!(job.error.as_deref(), Some(expected_error));
            if kind == "manifest" {
                assert_eq!(
                    job.manifest.unwrap()[1].status,
                    crate::acquisition::ImportEntryStatus::FailedDownload
                );
            }
        }
        assert!(
            !output.path().join(&job_id).exists(),
            "failed staging must be removed"
        );
    }
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
    manager.close();
    pool.close().await;
}

#[tokio::test]
async fn missing_spotdl_executable_fails_tasks_and_jobs_in_sqlite() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp
        .path()
        .join("missing-spotdl.exe")
        .to_string_lossy()
        .into_owned();
    let error = DefaultProcessRunner::new()
        .run(&executable, &[], ProcessOptions::default())
        .await
        .expect_err("missing executable must fail");
    assert!(matches!(error, ProcessError::SpawnFailed { .. }));
    assert_failed_downloads(
        SpotDLDownloaderAdapter::new().with_spotdl_path(executable),
        &error.to_string(),
        true,
        false,
    )
    .await;
}

#[tokio::test]
async fn invalid_spotdl_executable_fails_tasks_and_jobs_in_sqlite() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("invalid-spotdl.exe");
    tokio::fs::write(&executable, b"not an executable")
        .await
        .unwrap();
    let path = executable.to_string_lossy().into_owned();
    let error = DefaultProcessRunner::new()
        .run(&path, &[], ProcessOptions::default())
        .await
        .expect_err("invalid executable must fail to start");
    assert!(matches!(error, ProcessError::SpawnFailed { .. }));
    assert_failed_downloads(
        SpotDLDownloaderAdapter::new().with_spotdl_path(path),
        &error.to_string(),
        true,
        false,
    )
    .await;
}

#[tokio::test]
async fn injected_spawn_failure_preserves_exact_error_and_aborts_partial_playlist() {
    let error = ProcessError::SpawnFailed {
        command: String::from("configured-spotdl"),
        reason: String::from("fixture: access denied while starting spotDL"),
    };
    let downloader = SpotDLDownloaderAdapter::with_runner(Arc::new(SpawnFailureRunner))
        .with_spotdl_path("configured-spotdl");
    assert_failed_downloads(downloader, &error.to_string(), true, false).await;
}

#[tokio::test]
async fn successful_exit_without_audio_fails_instead_of_inventing_imported_files() {
    assert_failed_downloads(
        SpotDLDownloaderAdapter::with_runner(Arc::new(NoOutputRunner)),
        "spotDL exited successfully but produced no audio files",
        false,
        false,
    )
    .await;
}

#[test]
fn unconfigured_spotdl_without_path_binary_fails_using_production_defaults() {
    const CHILD: &str = "MUSICDECK_TEST_SPOTDL_MISSING_CHILD";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let error = DefaultProcessRunner::new()
                .run("spotdl", &[], ProcessOptions::default())
                .await
                .expect_err("spotdl must be absent from isolated PATH");
            assert!(matches!(error, ProcessError::SpawnFailed { .. }));
            assert_failed_downloads(
                SpotDLDownloaderAdapter::new(),
                &error.to_string(),
                true,
                true,
            )
            .await;
        });
        return;
    }
    // Isolate the environment in a child instead of mutating global test state.
    let path = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tasks::tests::spotdl::unconfigured_spotdl_without_path_binary_fails_using_production_defaults", "--nocapture"])
        .env_remove("SPOTDL_PATH")
        .env("PATH", path.path())
        .env(CHILD, "1")
        .output().expect("run isolated missing-binary test");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
