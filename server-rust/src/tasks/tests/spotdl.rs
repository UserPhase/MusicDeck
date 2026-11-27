use super::*;
use crate::acquisition::{
    PlaylistImportTimeout, SpotDLDownloaderAdapter, SqliteImportJobRepository, StoredImportJob,
};
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
const MISSING_SPOTDL: &str = "spotDL failed (missing-downloader): The server could not launch spotDL. Check its configured executable path.";

async fn download_targets(args: &[String], directory: &Path) -> Vec<String> {
    let Some(index) = args.iter().position(|arg| arg == "download") else {
        return Vec::new();
    };
    let targets = &args[index + 1..];
    if targets == ["musicdeck-batch-input.spotdl"] {
        let input = tokio::fs::read(directory.join(&targets[0])).await.unwrap();
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&input).unwrap();
        return rows
            .into_iter()
            .map(|row| {
                assert!(row["download_url"].is_null());
                assert_eq!(row["album_name"], "Fixture Album");
                row["url"].as_str().unwrap().to_owned()
            })
            .collect();
    }
    targets.to_vec()
}

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
        if args == ["--version"] {
            return Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: "4.6.0".into(),
                stderr: String::new(),
                signal: None,
            });
        }
        if args
            .get(2)
            .is_some_and(|arg| arg == "spotify-playlist-page")
        {
            let alternate = args[3].ends_with(ALTERNATE_RECORDING);
            let items: Vec<_> = ["Second", "First", "Second"]
                .into_iter()
                .enumerate()
                .map(|(position, title)| {
                    let id = fixture_recording(title, alternate);
                    json!({"key": position.to_string(), "song": {
                        "name": title, "artist": "Fixture Artist", "album_name": "Fixture Album",
                        "song_id": id, "url": format!("https://open.spotify.com/track/{id}"),
                        "duration": 180.0, "download_url": null,
                    }})
                })
                .collect();
            let response =
                json!({"page": {"offset": 0, "total": 3, "name": FIXTURE_NAME, "items": items}});
            tokio::fs::write(&args[6], response.to_string())
                .await
                .unwrap();
            return Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
                signal: None,
            });
        }
        if args.first().is_some_and(|arg| arg == "-c") {
            let file = tokio::fs::read(args.last().expect("tag inspection filename"))
                .await
                .unwrap();
            let id = match file[44] {
                1 | 2 | 9 => FIRST_RECORDING,
                3 => ALTERNATE_RECORDING,
                _ => "SecondRecording",
            };
            return Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: json!({
                    "hasArtwork": false, "sourceUrl": format!("https://open.spotify.com/track/{id}"),
                    "duration": if file[44] == 9 { 60.0 } else { 180.0 }
                })
                .to_string(),
                stderr: String::new(),
                signal: None,
            });
        }
        let directory = options.cwd.expect("download output directory");
        if args.iter().any(|arg| arg == "save") {
            let target = args.last().unwrap();
            let alternate = target.ends_with(ALTERNATE_RECORDING);
            let titles: &[&str] = if target.contains("/track/") {
                &["First"]
            } else {
                &["Second", "First", "Second"]
            };
            let mut metadata = titles.iter().enumerate().map(|(position, title)| {
                let id = fixture_recording(title, alternate);
                json!({"name": title, "artist": "Fixture Artist", "album_name": "Fixture Album",
                    "song_id": id, "url": format!("https://open.spotify.com/track/{id}"), "list_name": FIXTURE_NAME,
                    "download_url": "https://www.youtube.com/watch?v=invalid-example",
                    "list_position": position + 1, "list_length": titles.len() })
            }).collect::<Vec<_>>();
            if target.contains("/playlist/") {
                metadata.swap(0, 1);
            }
            tokio::fs::write(
                directory.join("musicdeck-occurrences.spotdl"),
                json!(metadata).to_string(),
            )
            .await
            .unwrap();
            return Ok(ProcessExecutionResult {
                exit_code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
                signal: None,
            });
        }
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
            let targets = download_targets(args, &directory).await;
            let single = targets.len() == 1;
            let alternate = targets
                .iter()
                .any(|target| target.ends_with(ALTERNATE_RECORDING));
            let titles: Vec<&str> = targets
                .iter()
                .map(|target| {
                    if target.ends_with("SecondRecording") {
                        "Second"
                    } else {
                        "First"
                    }
                })
                .collect();
            for title in &titles {
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
    RejectFirstPlaylist,
}

struct MockNavidrome {
    music_root: PathBuf,
    scans: AtomicUsize,
    scan_requests: Arc<AtomicUsize>,
    result: NavidromeResult,
    members: std::sync::Mutex<Vec<String>>,
    creates: AtomicUsize,
}

async fn navidrome_request(
    State(mock): State<Arc<MockNavidrome>>,
    AxumPath(endpoint): AxumPath<String>,
    uri: axum::http::Uri,
    method: axum::http::Method,
    body: Bytes,
) -> Json<Value> {
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
            mock.scan_requests.fetch_add(1, Ordering::SeqCst);
            mock.scans.store(0, Ordering::SeqCst);
            json!({"status":"ok", "scanStatus":{"scanning":true}})
        }
        "getScanStatus.view" => {
            let poll = mock.scans.fetch_add(1, Ordering::SeqCst);
            json!({"status":"ok", "scanStatus":{"scanning":poll == 0, "count":2}})
        }
        "search3.view" => {
            assert_eq!(query["query"], "", "imports browse the library in bulk");
            assert_eq!(query["artistCount"], "0");
            assert_eq!(query["albumCount"], "0");
            let offset: usize = query["songOffset"].parse().unwrap();
            let limit: usize = query["songCount"].parse().unwrap();
            let mut songs = vec![
                json!({"id":"wrong-path", "title":"First", "path":format!("/music/Existing/{}", fixture_path("First"))}),
            ];
            for file in std::fs::read_dir(mock.music_root.join(FIXTURE_ALBUM)).unwrap() {
                let file = file.unwrap();
                let path = file.path();
                let stem = path.file_stem().unwrap().to_str().unwrap();
                if matches!(mock.result, NavidromeResult::MissingTrack) && stem == "First" {
                    continue;
                }
                songs.push(json!({"id":format!("nav-{stem}"), "title":"Different indexed title",
                    "path":format!("/music/{FIXTURE_ALBUM}/{}", file.file_name().to_string_lossy())}));
            }
            songs.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
            json!({"status":"ok", "searchResult3":{"song":songs.into_iter().skip(offset).take(limit).collect::<Vec<_>>()}})
        }
        "getPlaylists.view" => json!({"status":"ok", "playlists":{"playlist":[]}}),
        "getPlaylist.view" => {
            let ids = mock.members.lock().unwrap();
            let entries: Vec<_> = ids.iter().map(|id| json!({"id":id, "title":id})).collect();
            json!({"status":"ok", "playlist":{"id":"nav-playlist","name":FIXTURE_NAME,"entry":entries}})
        }
        "createPlaylist.view" => {
            assert_eq!(method, axum::http::Method::POST);
            let params: Vec<_> = url::form_urlencoded::parse(&body).collect();
            assert!(params.iter().any(|(key, value)| (key == "name"
                && value.starts_with("MusicDeck import spimp_"))
                || (key == "playlistId" && value == "nav-playlist")));
            let ids: Vec<_> = params
                .iter()
                .filter(|(key, _)| key == "songId")
                .map(|(_, value)| value.to_string())
                .collect();
            let create = mock.creates.fetch_add(1, Ordering::SeqCst);
            if matches!(mock.result, NavidromeResult::RejectFirstPlaylist) && create == 0 {
                json!({"status":"failed", "error":{"code":0, "message":"fixture rejected playlist"}})
            } else {
                *mock.members.lock().unwrap() = ids.clone();
                let entries: Vec<_> = ids.iter().map(|id| json!({"id":id})).collect();
                json!({"status":"ok", "playlist":{"id":"nav-playlist", "entry":entries}})
            }
        }
        "updatePlaylist.view" => {
            assert_eq!(query["playlistId"], "nav-playlist");
            assert_eq!(query["public"], "false");
            assert_eq!(query["name"], FIXTURE_NAME);
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
    Arc<AtomicUsize>,
) {
    let scan_requests = Arc::new(AtomicUsize::new(0));
    let server = Router::new()
        .route("/rest/:endpoint", any(navidrome_request))
        .with_state(Arc::new(MockNavidrome {
            music_root: music_root.into(),
            scans: AtomicUsize::new(0),
            scan_requests: scan_requests.clone(),
            result,
            members: std::sync::Mutex::new(Vec::new()),
            creates: AtomicUsize::new(0),
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
        scan_requests,
    )
}

struct PlaylistTimeoutRunner(u64);

fn fixture_user() -> UserRecord {
    UserRecord {
        id: "alice".into(),
        username: "alice".into(),
        display_name: "Alice".into(),
        role: UserRole::User,
        avatar_ref: None,
        avatar_url: None,
        disabled: false,
        is_master_admin: false,
        external_search_enabled: true,
        external_playback_enabled: true,
        last_login_at: None,
        last_playback_at: None,
        created_at: "2026-01-01".into(),
        updated_at: "2026-01-01".into(),
    }
}

struct InterruptedBatchRunner {
    timeout: bool,
    provider_timeout: bool,
    downloads: std::sync::Mutex<Vec<Vec<String>>>,
}

#[derive(Default)]
struct NicheTrackRunner {
    attempts: std::sync::Mutex<Vec<(String, Vec<String>)>>,
}

#[async_trait::async_trait]
impl ProcessRunner for NicheTrackRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        let stage = options.cwd.clone();
        let result = SuccessfulProcessRunner.run(command, args, options).await?;
        if args.iter().any(|arg| arg == "save") {
            let path = stage.unwrap().join("musicdeck-occurrences.spotdl");
            let mut rows: Vec<serde_json::Value> =
                serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
            for row in &mut rows {
                row["duration"] = json!(180.0);
            }
            tokio::fs::write(path, serde_json::to_vec(&rows).unwrap())
                .await
                .unwrap();
        } else if args.iter().any(|arg| arg == "download") {
            let stage = stage.unwrap();
            let targets = download_targets(args, &stage).await;
            let arg = |name: &str| {
                args.windows(2)
                    .find(|pair| pair[0] == name)
                    .map(|pair| pair[1].as_str())
            };
            let phase = if let Some(query) = arg("--search-query") {
                assert_eq!(query, "{artist} - {title} {album}");
                "edition"
            } else if arg("--audio") == Some("soundcloud") {
                assert_eq!(arg("soundcloud"), Some("--threads"));
                "soundcloud"
            } else {
                "standard"
            };
            assert_eq!(
                arg("--threads"),
                Some(if phase == "standard" { "3" } else { "2" })
            );
            assert!(!args.iter().any(|arg| arg == "--dont-filter-results"));
            match phase {
                "standard" => {
                    tokio::fs::remove_file(
                        stage.join(staged_fixture_path("First", FIRST_RECORDING)),
                    )
                    .await
                    .unwrap();
                    let errors = format!(
                        "https://open.spotify.com/track/{FIRST_RECORDING} - AudioProviderError: No results found"
                    );
                    tokio::fs::write(stage.join("musicdeck-errors.txt"), errors)
                        .await
                        .unwrap();
                }
                "edition" => {
                    let path = stage.join(staged_fixture_path("First", FIRST_RECORDING));
                    let mut wav = tokio::fs::read(&path).await.unwrap();
                    wav[44] = 9;
                    tokio::fs::write(path, wav).await.unwrap();
                }
                _ => {}
            }
            self.attempts
                .lock()
                .unwrap()
                .push((phase.to_owned(), targets));
        }
        Ok(result)
    }
}

#[tokio::test]
async fn niche_track_fallback_rejects_wrong_duration_and_only_retries_the_missing_recording() {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    seed_test_user(&db).await;
    let music = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let (imports, acquisitions, mock, scans) =
        import_fixture(db.clone(), music.path(), NavidromeResult::Success).await;
    let tasks = TaskManager::new(Some(db.clone()));
    tasks.initialize_tables().await;
    let process = Arc::new(NicheTrackRunner::default());
    tasks.register(
        TaskType::SpotdlImport,
        Arc::new(
            SpotdlRunner::with_services(Some(db.clone()), acquisitions, imports.clone())
                .with_downloader(Arc::new(SpotDLDownloaderAdapter::with_runner(
                    process.clone(),
                )))
                .with_output_dir(stage.path()),
        ),
    );
    let job = imports
        .start(
            "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
            &fixture_user(),
            Some(&tasks),
        )
        .await
        .unwrap();
    let task: String = sqlx::query_scalar(
        "SELECT id FROM background_tasks WHERE json_extract(payload_json,'$.jobId')=?",
    )
    .bind(&job.id)
    .fetch_one(db.inner())
    .await
    .unwrap();
    tasks
        .wait_for_settlement(&task, Duration::from_secs(8))
        .await
        .unwrap();
    let imported = imports.get(&job.id, "alice").await.unwrap();
    assert_eq!(imported.status, "completed", "{:?}", imported.error);
    assert_eq!(imported.imported_count, Some(3));
    let published = tokio::fs::read(music.path().join(fixture_path("First")))
        .await
        .unwrap();
    assert_eq!(published[44], 1, "the wrong-duration edition was discarded");
    let first = format!("https://open.spotify.com/track/{FIRST_RECORDING}");
    assert_eq!(
        *process.attempts.lock().unwrap(),
        [
            (
                "standard".into(),
                vec![
                    "https://open.spotify.com/track/SecondRecording".into(),
                    first.clone()
                ]
            ),
            ("edition".into(), vec![first.clone()]),
            ("soundcloud".into(), vec![first]),
        ]
    );
    assert_eq!(scans.load(Ordering::SeqCst), 1);
    tasks.close();
    mock.abort();
}

#[async_trait::async_trait]
impl ProcessRunner for InterruptedBatchRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        let first_batch = if args.iter().any(|arg| arg == "download") {
            assert_eq!(args.last().unwrap(), "musicdeck-batch-input.spotdl");
            let targets = download_targets(args, options.cwd.as_deref().unwrap()).await;
            let mut downloads = self.downloads.lock().unwrap();
            downloads.push(targets);
            downloads.len() == 1
        } else {
            false
        };
        let stage = options.cwd.clone();
        let mut output = SuccessfulProcessRunner.run(command, args, options).await?;
        if first_batch {
            let stage = stage.unwrap();
            let file = stage.join(staged_fixture_path("First", FIRST_RECORDING));
            // Leave a recognizable but truncated recording and destroy spotDL's end-of-run artifacts.
            tokio::fs::OpenOptions::new()
                .write(true)
                .open(file)
                .await
                .unwrap()
                .set_len(50)
                .await
                .unwrap();
            tokio::fs::remove_file(stage.join("batch.m3u8"))
                .await
                .unwrap();
            tokio::fs::remove_file(stage.join("musicdeck-source.spotdl"))
                .await
                .unwrap();
            if self.timeout {
                return Err(ProcessError::TimedOut(1000));
            }
            output.exit_code = Some(1);
            if self.provider_timeout {
                tokio::fs::write(
                    stage.join("musicdeck-errors.txt"),
                    format!("https://open.spotify.com/track/{FIRST_RECORDING} - ReadTimeout: provider timed out\n"),
                )
                .await
                .unwrap();
            } else {
                output.stderr = "FFmpegError: fixture download was interrupted".into();
            }
        }
        Ok(output)
    }
}

#[tokio::test]
async fn resumes_interrupted_playlists_in_place_and_reuses_library_audio() {
    for (timeout, provider_timeout) in [(false, false), (true, false), (false, true)] {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        seed_test_user(&db).await;
        let music = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let (imports, acquisitions, navidrome, scan_requests) =
            import_fixture(db.clone(), music.path(), NavidromeResult::Success).await;
        let manager = TaskManager::new(Some(db.clone()));
        manager.initialize_tables().await;
        let process = Arc::new(InterruptedBatchRunner {
            timeout,
            provider_timeout,
            downloads: std::sync::Mutex::new(Vec::new()),
        });
        let runner: Arc<dyn TaskDefinition> = Arc::new(
            SpotdlRunner::with_services(Some(db.clone()), acquisitions.clone(), imports.clone())
                .with_downloader(Arc::new(SpotDLDownloaderAdapter::with_runner(
                    process.clone(),
                )))
                .with_output_dir(stage.path()),
        );
        manager.register(TaskType::SpotdlDownload, runner.clone());
        manager.register(TaskType::SpotdlImport, runner);
        let user = fixture_user();
        let url = "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM";
        let task_for = |id: String| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT id FROM background_tasks WHERE json_extract(payload_json,'$.jobId')=? ORDER BY created_at DESC LIMIT 1")
                    .bind(id).fetch_one(db.inner()).await.unwrap()
            }
        };
        let initial = imports.start(url, &user, Some(&manager)).await.unwrap();
        let first_task = task_for(initial.id.clone()).await;
        if provider_timeout {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if imports.get(&initial.id, "alice").await.unwrap().stage == "retry_wait" {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the transient failure should expose a retry wait");
        }
        manager
            .wait_for_settlement(&first_task, Duration::from_secs(8))
            .await
            .unwrap();
        if !provider_timeout {
            let partial = imports.get(&initial.id, "alice").await.unwrap();
            assert_eq!(partial.status, "partial", "{:?}", partial.error);
            assert_eq!(partial.imported_count, Some(2));
            assert_eq!(partial.manifest.as_ref().unwrap()[2].duplicate_of, Some(1));
            let playlist_id = partial.playlist_id.unwrap();
            tokio::time::timeout(Duration::from_secs(1), async {
                while manager.is_executing(&first_task) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let resumed = imports.start(url, &user, Some(&manager)).await.unwrap();
            assert_eq!(resumed.id, initial.id);
            manager
                .wait_for_settlement(&task_for(initial.id.clone()).await, Duration::from_secs(8))
                .await
                .unwrap();
            let finished = imports.get(&initial.id, "alice").await.unwrap();
            assert_eq!(finished.playlist_id.as_deref(), Some(playlist_id.as_str()));
        }
        let finished = imports.get(&initial.id, "alice").await.unwrap();
        assert_eq!(finished.status, "completed", "{:?}", finished.error);
        let ordered: Vec<String> = sqlx::query_scalar(
            "SELECT provider_track_id FROM playlist_items WHERE playlist_id=? ORDER BY position",
        )
        .bind(finished.playlist_id.unwrap())
        .fetch_all(db.inner())
        .await
        .unwrap();
        assert_eq!(ordered, ["nav-Second", "nav-First", "nav-Second"]);

        let scans_before_reuse = scan_requests.load(Ordering::SeqCst);
        let already_present = acquisitions
            .create_job(
                AcquisitionCreateOptions {
                    user_id: "alice".into(),
                    track_id: Some(format!("https://open.spotify.com/track/{FIRST_RECORDING}")),
                    ..Default::default()
                },
                Some(&manager),
            )
            .await
            .unwrap();
        manager
            .wait_for_settlement(
                &task_for(already_present.id.clone()).await,
                Duration::from_secs(8),
            )
            .await
            .unwrap();
        let reused = acquisitions
            .get_job(&already_present.id, "alice", false)
            .await
            .unwrap();
        assert_eq!(reused.status, AcquisitionJobStatus::Completed);
        assert!(reused.files.unwrap()[0].reused);
        assert_eq!(scan_requests.load(Ordering::SeqCst), scans_before_reuse);
        let downloads = process.downloads.lock().unwrap();
        assert_eq!(downloads.len(), 2);
        assert_eq!(downloads[0].len(), 2);
        assert_eq!(
            downloads[1],
            [format!("https://open.spotify.com/track/{FIRST_RECORDING}")]
        );
        manager.close();
        navidrome.abort();
    }
}

#[async_trait::async_trait]
impl ProcessRunner for PlaylistTimeoutRunner {
    async fn run(
        &self,
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        if args.iter().any(|arg| arg == "download") {
            assert_eq!(options.timeout_ms, Some(self.0));
        }
        SuccessfulProcessRunner.run(command, args, options).await
    }
}

#[tokio::test]
async fn playlist_import_reports_partial_or_failed_when_navidrome_cannot_link_every_track() {
    for (case, status, imported, timeout, timeout_ms) in [
        (
            NavidromeResult::MissingTrack,
            "partial",
            2,
            PlaylistImportTimeout::Auto,
            0,
        ),
        (
            NavidromeResult::RejectFirstPlaylist,
            "failed",
            0,
            PlaylistImportTimeout::Manual { minutes: 90 },
            5_400_000,
        ),
    ] {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        seed_test_user(&db).await;
        let music = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let (imports, _, mock, _) = import_fixture(db.clone(), music.path(), case).await;
        let mut record: StoredImportJob = serde_json::from_value(json!({
            "job": {"id":"spimp_fixture", "userId":"alice", "status":"queued", "stage":"queued"},
            "playlistUrl":"https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
            "user":{"id":"alice", "disabled":false},
            "timeout": timeout
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
                    PlaylistTimeoutRunner(timeout_ms),
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
        if imported == 0 {
            // A failed upstream request can leave a durable attempt with no remote marker.
            // Age the fixture's request so the test exercises reconciliation without its grace wait.
            sqlx::query("UPDATE import_jobs SET manifest_json=json_set(manifest_json,'$.playlistIntent.attemptedAt',0) WHERE id='spimp_fixture'")
                .execute(db.inner()).await.unwrap();
            tokio::time::timeout(Duration::from_secs(1), async {
                while manager.is_executing(&task.id) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let rerun = imports
                .start(
                    "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
                    &fixture_user(),
                    Some(&manager),
                )
                .await
                .unwrap();
            assert_eq!(rerun.id, "spimp_fixture");
            let task_id: String = sqlx::query_scalar("SELECT id FROM background_tasks WHERE id<>? AND json_extract(payload_json,'$.jobId')='spimp_fixture'")
                .bind(&task.id).fetch_one(db.inner()).await.unwrap();
            manager
                .wait_for_settlement(&task_id, Duration::from_secs(8))
                .await
                .unwrap();
            let resumed = imports.get("spimp_fixture", "alice").await.unwrap();
            assert_eq!(resumed.status, "completed", "{:?}", resumed.error);
        }
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
        command: &str,
        args: &[String],
        options: ProcessOptions,
    ) -> Result<ProcessExecutionResult, ProcessError> {
        if args == ["--version"]
            || args
                .get(2)
                .is_some_and(|arg| arg == "spotify-playlist-page")
        {
            return SuccessfulProcessRunner.run(command, args, options).await;
        }
        tokio::fs::write(options.cwd.unwrap().join("empty.wav"), [])
            .await
            .unwrap();
        Ok(ProcessExecutionResult {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: "AudioProviderError: No audio source found".into(),
            signal: None,
        })
    }
}

#[tokio::test]
async fn zero_byte_audio_fails_even_if_spotdl_exits_zero() {
    assert_failed_downloads(
        SpotDLDownloaderAdapter::with_runner(Arc::new(EmptyAudioRunner)),
        "spotDL failed (no-match): The downloader could not match this recording to an audio source.",
        None,
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
    let (playlists, acquisitions, mock, _) =
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
    let attempt = stage.path().join(format!("{}-{task_id}", job.id));
    let checkpoint = std::fs::read_to_string(attempt.join("musicdeck-checkpoint.json")).unwrap();
    let checkpoint: Value = serde_json::from_str(&checkpoint).unwrap();
    let file = checkpoint["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["source"]["title"] == "First")
        .unwrap()["filePath"]
        .as_str()
        .unwrap();
    assert!(Path::new(file).is_file());
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
    discovery_error: Option<&str>,
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
        let expected_error = if kind == "playlist" {
            discovery_error.unwrap_or(expected_error)
        } else {
            expected_error
        };
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
        let keep_playlist_pages =
            kind == "playlist" && expected_error.starts_with("spotDL failed (no-match)");
        assert_eq!(
            output.path().join(&job_id).exists(),
            keep_playlist_pages,
            "{kind}"
        );
    }
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
        MISSING_SPOTDL,
        None,
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
        MISSING_SPOTDL,
        None,
        true,
        false,
    )
    .await;
}

#[tokio::test]
async fn injected_spawn_failure_hides_process_details_and_aborts_partial_playlist() {
    let downloader = SpotDLDownloaderAdapter::with_runner(Arc::new(SpawnFailureRunner))
        .with_spotdl_path("configured-spotdl");
    assert_failed_downloads(downloader, MISSING_SPOTDL, None, true, false).await;
}

#[tokio::test]
async fn successful_exit_without_audio_fails_instead_of_inventing_imported_files() {
    assert_failed_downloads(
        SpotDLDownloaderAdapter::with_runner(Arc::new(NoOutputRunner)),
        "spotDL did not return source track details. Check the playlist URL and server credentials.",
        Some("Could not decode the Spotify playlist page"),
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
                MISSING_SPOTDL,
                None,
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
