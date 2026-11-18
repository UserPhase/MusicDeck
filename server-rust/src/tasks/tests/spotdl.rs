use super::*;
use crate::acquisition::{SpotDLDownloaderAdapter, SqliteImportJobRepository, StoredImportJob};
use crate::config::AppConfig;
use crate::providers::{BackendRegistry, NavidromeClient, RegisteredProvider};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path as AxumPath, State},
    routing::any,
};
use std::path::{Path, PathBuf};
use std::sync::{
    RwLock,
    atomic::{AtomicUsize, Ordering},
};

const FIXTURE_ALBUM: &str = "Fixture Artist/Fixture Album";
const FIXTURE_NAME: &str = "Imported Fixture Playlist";
const FIRST_RECORDING: &str = "4cOdK2wGLETKBW3PvgPWqT";
pub(super) const ALTERNATE_RECORDING: &str = "DifferentRecording";

/// Explicit success fixture, injected only by tests; production always spawns spotDL.
pub(super) struct SuccessfulProcessRunner;

#[async_trait::async_trait]
impl ProcessRunner for SuccessfulProcessRunner {
    async fn run(
        &self,
        _command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        if args.first().is_some_and(|arg| arg == "-c") {
            let file = tokio::fs::read(args.last().expect("tag inspection filename"))
                .await
                .unwrap();
            let id = match file[44] {
                1 | 2 => FIRST_RECORDING,
                3 => ALTERNATE_RECORDING,
                _ => "SecondRecording",
            };
            return Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: json!({
                    "hasArtwork": false, "sourceUrl": format!("https://open.spotify.com/track/{id}")
                })
                .to_string(),
                stderr: String::new(),
                signal: None,
            });
        }
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
        if let Some(m3u) = args.windows(2).find(|pair| pair[0] == "--m3u") {
            tokio::fs::create_dir_all(directory.join(FIXTURE_ALBUM))
                .await
                .unwrap();
            let single = args.last().is_some_and(|target| target.contains("/track/"));
            let alternate = args
                .last()
                .is_some_and(|target| target.ends_with(ALTERNATE_RECORDING));
            let titles: &[&str] = if single {
                &["First"]
            } else {
                &["Second", "First", "Second"]
            };
            for title in titles {
                // The playlist encoding differs from the single download even for the same recording.
                let (id, marker) = match (*title, single, alternate) {
                    ("First", _, true) => (ALTERNATE_RECORDING, 3),
                    ("First", true, false) => (FIRST_RECORDING, 1),
                    ("First", false, false) => (FIRST_RECORDING, 2),
                    _ => ("SecondRecording", 4),
                };
                wav[44] = marker;
                tokio::fs::write(directory.join(staged_fixture_path(title, id)), &wav)
                    .await
                    .unwrap();
            }
            // Alphabetical order differs from playlist order and a repeated song stays repeated.
            let manifest = titles
                .iter()
                .map(|title| staged_fixture_path(title, fixture_recording(title, alternate)))
                .collect::<Vec<_>>()
                .join("\n");
            let metadata = titles
                .iter()
                .map(|title| {
                    let id = fixture_recording(title, alternate);
                    json!({
                        "name": title, "artist": "Fixture Artist", "album_name": "Fixture Album",
                        "song_id": id, "url": format!("https://open.spotify.com/track/{id}"),
                        "list_name": FIXTURE_NAME, "list_length": titles.len()
                    })
                })
                .collect::<Vec<_>>();
            tokio::fs::write(directory.join(&m3u[1]), format!("#EXTM3U\n{manifest}\n"))
                .await
                .unwrap();
            tokio::fs::write(
                directory.join("musicdeck-source.spotdl"),
                json!(metadata).to_string(),
            )
            .await
            .unwrap();
        } else {
            tokio::fs::write(directory.join("fixture.wav"), wav)
                .await
                .unwrap();
        }
        Ok(ProcessExecutionResult {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            signal: None,
        })
    }
}

fn fixture_recording(title: &str, alternate: bool) -> &str {
    match (title, alternate) {
        ("First", true) => ALTERNATE_RECORDING,
        ("First", false) => FIRST_RECORDING,
        _ => "SecondRecording",
    }
}

fn staged_fixture_path(title: &str, recording: &str) -> String {
    format!("{FIXTURE_ALBUM}/Fixture Artist - {title} [{recording}].wav")
}

pub(super) fn fixture_path(title: &str) -> String {
    format!("{FIXTURE_ALBUM}/{title}.wav")
}

#[derive(Clone, Copy)]
pub(super) enum NavidromeResult {
    Success,
    MissingTrack,
    RejectPlaylist,
}

struct MockNavidrome {
    music_root: PathBuf,
    scans: AtomicUsize,
    result: NavidromeResult,
}

async fn navidrome_request(
    State(mock): State<Arc<MockNavidrome>>,
    AxumPath(endpoint): AxumPath<String>,
    uri: axum::http::Uri,
    method: axum::http::Method,
    body: Bytes,
) -> Json<Value> {
    assert!(mock.music_root.join(fixture_path("First")).is_file());
    for title in ["First", "Second"] {
        let path = mock.music_root.join(fixture_path(title));
        if !path.exists() {
            continue;
        }
        let file = std::fs::read(path).unwrap();
        assert_eq!(file.len(), 364);
        assert_eq!(&file[..4], b"RIFF");
    }
    let query: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let result = match endpoint.as_str() {
        "startScan.view" => {
            mock.scans.store(0, Ordering::SeqCst);
            json!({"status":"ok", "scanStatus":{"scanning":true}})
        }
        "getScanStatus.view" => {
            let poll = mock.scans.fetch_add(1, Ordering::SeqCst);
            json!({"status":"ok", "scanStatus":{"scanning":poll == 0, "count":2}})
        }
        "search3.view" => {
            assert!(mock.scans.load(Ordering::SeqCst) >= 2);
            let title = &query["query"];
            let mut songs = vec![
                json!({"id":"wrong-path", "title":title, "path":format!("/music/Existing/{}", fixture_path(title))}),
            ];
            if !(matches!(mock.result, NavidromeResult::MissingTrack) && title == "First") {
                for file in std::fs::read_dir(mock.music_root.join(FIXTURE_ALBUM)).unwrap() {
                    let file = file.unwrap();
                    let path = file.path();
                    let stem = path.file_stem().unwrap().to_str().unwrap();
                    if stem == title || stem.starts_with(&format!("{title} [")) {
                        songs.push(json!({"id":format!("nav-{stem}"), "title":title,
                            "path":format!("/music/{FIXTURE_ALBUM}/{}", file.file_name().to_string_lossy())}));
                    }
                }
            }
            json!({"status":"ok", "searchResult3":{"song":songs}})
        }
        "createPlaylist.view" => {
            assert_eq!(method, axum::http::Method::POST);
            let params: Vec<_> = url::form_urlencoded::parse(&body).collect();
            assert!(
                params
                    .iter()
                    .any(|(key, value)| key == "name" && value == FIXTURE_NAME)
            );
            let ids: Vec<_> = params
                .iter()
                .filter(|(key, _)| key == "songId")
                .map(|(_, value)| value.as_ref())
                .collect();
            let expected = if matches!(mock.result, NavidromeResult::MissingTrack) {
                vec!["nav-Second", "nav-Second"]
            } else {
                vec!["nav-Second", "nav-First", "nav-Second"]
            };
            assert_eq!(ids, expected);
            if matches!(mock.result, NavidromeResult::RejectPlaylist) {
                json!({"status":"failed", "error":{"code":0, "message":"fixture rejected playlist"}})
            } else {
                let entries: Vec<_> = ids.iter().map(|id| json!({"id":id})).collect();
                json!({"status":"ok", "playlist":{"id":"nav-playlist", "entry":entries}})
            }
        }
        "updatePlaylist.view" => {
            assert_eq!(query["playlistId"], "nav-playlist");
            assert_eq!(query["public"], "false");
            assert!(query["comment"].contains("Imported from Spotify:"));
            json!({"status":"ok"})
        }
        _ => panic!("unexpected import endpoint {endpoint}"),
    };
    Json(json!({"subsonic-response":result}))
}

pub(super) async fn import_fixture(
    pool: DbPool,
    music_root: &Path,
    result: NavidromeResult,
) -> (
    SpotifyPlaylistImportService,
    AcquisitionService,
    tokio::task::JoinHandle<()>,
) {
    let server = Router::new()
        .route("/rest/:endpoint", any(navidrome_request))
        .with_state(Arc::new(MockNavidrome {
            music_root: music_root.into(),
            scans: AtomicUsize::new(0),
            result,
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = AppConfig::default();
    config.music_root = music_root.to_string_lossy().into_owned();
    config.navidrome.url = format!("http://{}", listener.local_addr().unwrap());
    let providers = BackendRegistry::new(vec![RegisteredProvider {
        connection_id: "env-navidrome".into(),
        provider_type: "navidrome".into(),
        name: "Navidrome".into(),
        enabled: true,
        provider: Arc::new(NavidromeClient::new(config.navidrome.clone()).unwrap()),
    }]);
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let config = Arc::new(RwLock::new(Arc::new(config)));
    (
        SpotifyPlaylistImportService::new(Some(pool.clone()))
            .with_library(config.clone(), providers.clone()),
        AcquisitionService::new(Some(pool)).with_library(config, providers),
        task,
    )
}

#[tokio::test]
async fn playlist_import_reports_partial_or_failed_when_navidrome_cannot_link_every_track() {
    for (case, status, imported) in [
        (NavidromeResult::MissingTrack, "partial", 2),
        (NavidromeResult::RejectPlaylist, "failed", 0),
    ] {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        seed_test_user(&db).await;
        let music = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let (imports, _, mock) = import_fixture(db.clone(), music.path(), case).await;
        let mut record: StoredImportJob = serde_json::from_value(json!({
            "job": {"id":"spimp_fixture", "userId":"alice", "status":"queued", "stage":"queued"},
            "playlistUrl":"https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
            "user":{"id":"alice", "disabled":false}
        }))
        .unwrap();
        record.job.playlist_description = Some("Original description".into());
        SqliteImportJobRepository::new(db.clone())
            .save(&record)
            .await
            .unwrap();
        let manager = TaskManager::new(Some(db.clone()));
        manager.initialize_tables().await;
        manager.register(
            TaskType::SpotdlImport,
            Arc::new(
                SpotdlRunner::with_services(
                    Some(db.clone()),
                    AcquisitionService::new(Some(db.clone())),
                    imports.clone(),
                )
                .with_downloader(Arc::new(SpotDLDownloaderAdapter::with_runner(Arc::new(
                    SuccessfulProcessRunner,
                ))))
                .with_output_dir(stage.path()),
            ),
        );
        let task = manager
            .enqueue(
                TaskType::SpotdlImport,
                json!({"kind":"playlist", "jobId":"spimp_fixture"}),
                "alice",
                None,
            )
            .await
            .unwrap();
        let settled = manager
            .wait_for_settlement(&task.id, Duration::from_secs(8))
            .await
            .unwrap();
        let job = imports.get("spimp_fixture", "alice").await.unwrap();
        assert_eq!(job.status, status, "{:?}", job.error);
        assert_eq!(job.imported_count, Some(imported));
        assert_eq!(job.failed_count, Some(3 - imported));
        assert!(
            job.playlist_description
                .unwrap()
                .starts_with("Original description")
        );
        let error = job.error.unwrap();
        if imported == 0 {
            assert_eq!(settled.state, TaskStatus::Failed);
            assert!(job.playlist_id.is_none());
            assert!(error.contains("fixture rejected playlist"), "{error}");
        } else {
            assert_eq!(settled.state, TaskStatus::Finished);
            assert!(job.playlist_id.is_some());
            assert!(error.contains("Navidrome did not index"), "{error}");
        }
        let playlists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playlists")
            .fetch_one(db.inner())
            .await
            .unwrap();
        assert_eq!(playlists, i64::from(imported > 0));
        assert!(music.path().join(fixture_path("First")).is_file());
        assert!(stage.path().join("spimp_fixture").exists());
        mock.abort();
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

struct EmptyAudioRunner;

#[async_trait::async_trait]
impl ProcessRunner for EmptyAudioRunner {
    async fn run(
        &self,
        _: &str,
        _: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        tokio::fs::write(options.cwd.unwrap().join("empty.wav"), [])
            .await
            .unwrap();
        Ok(ProcessExecutionResult {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: "AudioProviderError".into(),
            signal: None,
        })
    }
}

#[tokio::test]
async fn zero_byte_audio_fails_even_if_spotdl_exits_zero() {
    assert_failed_downloads(
        SpotDLDownloaderAdapter::with_runner(Arc::new(EmptyAudioRunner)),
        "spotDL produced no usable audio (no-match)",
        false,
        false,
    )
    .await;
}

#[tokio::test]
async fn album_acquisition_reports_partial_and_preserves_unindexed_staging() {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    seed_test_user(&db).await;
    let music = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let (playlists, acquisitions, mock) =
        import_fixture(db.clone(), music.path(), NavidromeResult::MissingTrack).await;
    let manager = TaskManager::new(Some(db.clone()));
    manager.initialize_tables().await;
    manager.register(
        TaskType::SpotdlDownload,
        Arc::new(
            SpotdlRunner::with_services(Some(db.clone()), acquisitions.clone(), playlists)
                .with_downloader(Arc::new(SpotDLDownloaderAdapter::with_runner(Arc::new(
                    SuccessfulProcessRunner,
                ))))
                .with_output_dir(stage.path()),
        ),
    );
    let mut options: AcquisitionCreateOptions = serde_json::from_value(json!({
        "spotifyUrl": "https://open.spotify.com/intl-nl/album/FixtureAlbum",
        "albumId": "external_itunes_album_101",
        "result": {"type":"album", "id":"external_itunes_album_101", "provider":"itunes", "metadata":{"durationSeconds":3.5}}
    })).unwrap();
    options.user_id = "alice".into();
    let job = acquisitions
        .create_job(options, Some(&manager))
        .await
        .unwrap();
    let task_id: String =
        sqlx::query_scalar("SELECT active_task_id FROM acquisition_jobs WHERE id=?")
            .bind(&job.id)
            .fetch_one(db.inner())
            .await
            .unwrap();
    manager
        .wait_for_settlement(&task_id, Duration::from_secs(8))
        .await
        .unwrap();
    let job = acquisitions.get_job(&job.id, "alice", false).await.unwrap();
    assert_eq!(
        job.status,
        AcquisitionJobStatus::Partial,
        "{:?}",
        job.error_message
    );
    assert_eq!(job.requested_track_id, None);
    assert_eq!(job.expected_count, Some(3));
    assert_eq!(job.imported_count, Some(2));
    assert!(
        job.files
            .unwrap()
            .iter()
            .all(|file| file.provider_track_id.as_deref() == Some("nav-Second"))
    );
    assert!(
        stage
            .path()
            .join(format!("{}-{task_id}", job.id))
            .join(staged_fixture_path("First", FIRST_RECORDING))
            .is_file()
    );
    mock.abort();
}

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
