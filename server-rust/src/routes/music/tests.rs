use super::*;
use crate::auth::SESSION_COOKIE;
use crate::catalog::{LibraryItemType, SourceRef};
use crate::config::{AppConfig, JellyfinConfig, NavidromeConfig};
use crate::db::run_migrations;
use crate::providers::media_fixture;
use crate::providers::{JellyfinClient, MusicBackend, NavidromeClient, RegisteredProvider};
use crate::routes::playlists::playlist_routes;
use axum::body::Body;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use http::Request;
use http_body_util::BodyExt;
use sqlx::Row;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration as Timeout;
use tower::ServiceExt;

async fn playback_state(local_only: bool) -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.expect("open database");
    playback_state_with_db(db, local_only).await
}

async fn playback_state_with_db(db: DbPool, local_only: bool) -> (DbPool, AppState, String) {
    run_migrations(&db, None).await.expect("migrate database");
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (name, description) VALUES ('user', 'Listener');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('listener', 'listener', 'unused', 'Listener', 'user', '2026-01-01', '2026-01-01');
        INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
        VALUES ('lastfm', 1, '{"apiKey":"fixture-key","apiSecret":"fixture-secret"}',
                '["history.read","network.request"]', '2026-01-01'),
               ('listenbrainz', 1, '{}', '["history.read","network.request"]', '2026-01-01');
        INSERT INTO scrobble_connections (user_id, provider, credentials_json, username,
            account_key, generation, connected_at, updated_at)
        VALUES ('listener', 'lastfm', '{}', 'listener', 'lastfm-account', 'generation-1', 0, 0),
               ('listener', 'listenbrainz', '{}', 'listener', 'listenbrainz-account', 'generation-1', 0, 0);
        "#,
    ).execute(db.inner()).await.expect("seed scrobble integrations");
    let mut config = AppConfig::default();
    config.network.local_only_mode = local_only;
    let state = AppState::with_database(config, db.clone())
        .await
        .expect("initialize state");
    let session = state
        .session_store()
        .expect("session store")
        .create_session("listener", true)
        .await
        .expect("create session");
    (db, state, session.id)
}

fn playback_event(seconds: f64, finished: bool) -> Value {
    json!({
        "playbackSessionId": "playback-session-1", "trackId": "track-1",
        "ownerUserId": "listener",
        "startedAt": (Utc::now() - Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "listenedSeconds": seconds, "durationSeconds": 180, "finished": finished,
        "track": { "title": "Roygbiv", "artist": "Boards of Canada", "album": "Music Has the Right to Children" }
    })
}

#[tokio::test]
async fn recently_played_playlists_are_distinct_ordered_and_visible_to_the_listener() {
    let (db, state, session) = playback_state(false).await;
    sqlx::raw_sql(
        "
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('other', 'other', 'unused', 'Other', 'user', '2026-01-01', '2026-01-01');
        INSERT INTO playlists (id, owner_user_id, name, sharing_mode, created_at, updated_at, deleted_at)
        VALUES ('recent', 'listener', 'Recently played', 'PRIVATE', '2026-01-01', '2026-01-01', NULL),
               ('shared', 'other', 'Shared', 'SHARED_READ', '2026-01-01', '2026-01-01', NULL),
               ('not-shared', 'other', 'Private', 'PRIVATE', '2026-01-01', '2026-01-01', NULL),
               ('deleted', 'listener', 'Deleted', 'PRIVATE', '2026-01-01', '2026-01-01', '2026-01-01'),
               ('private-listen', 'listener', 'Hidden listen', 'PRIVATE', '2026-01-01', '2026-01-01', NULL),
               ('old', 'listener', 'Old', 'PRIVATE', '2026-01-01', '2026-01-01', NULL),
               ('unplayed', 'listener', 'Unplayed', 'PRIVATE', '2026-01-01', '2026-01-01', NULL);
        INSERT INTO playlist_permissions (playlist_id, user_id, role, granted_at)
        VALUES ('shared', 'listener', 'VIEWER', '2026-01-01');
        INSERT INTO smart_playlists (id, user_id, name, rules_json, created_at, updated_at)
        VALUES ('smart', 'listener', 'Smart', '{}', '2026-01-01', '2026-01-01'),
               ('other-smart', 'other', 'Other Smart', '{}', '2026-01-01', '2026-01-01');
        ",
    )
    .execute(db.inner())
    .await
    .unwrap();

    let now = Utc::now();
    for (index, (user, playlist, days_ago, counted, excluded)) in [
        ("listener", "recent", 1, true, false),
        ("listener", "recent", 5, true, false),
        ("listener", "smart", 2, true, false),
        ("listener", "shared", 3, true, false),
        ("listener", "not-shared", 0, true, false),
        ("listener", "other-smart", 0, true, false),
        ("listener", "deleted", 0, true, false),
        ("listener", "private-listen", 0, true, true),
        ("listener", "old", 46, true, false),
        ("listener", "unplayed", 0, false, false),
        ("other", "unplayed", 0, true, false),
    ]
    .into_iter()
    .enumerate()
    {
        sqlx::query(
            "INSERT INTO listening_events
                (id, user_id, track_id, event_type, created_at, counted, taste_excluded, context_playlist_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
        )
        .bind(format!("listen-{index}"))
        .bind(user)
        .bind(format!("track-{index}"))
        .bind(if counted { "complete" } else { "progress" })
        .bind((now - Duration::days(days_ago)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(counted)
        .bind(excluded)
        .bind(playlist)
        .execute(db.inner())
        .await
        .unwrap();
    }

    let path = "/api/v1/playlists/recently-played";
    let (status, data) = json_response(request(&state, &session, "GET", path, None).await).await;
    assert_eq!(status, StatusCode::OK);
    let items = data["playlists"].as_array().unwrap();
    let ids = items.iter().map(|item| item["id"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(ids, ["recent", "smart", "shared"]);
    assert_eq!(items[1]["isSmart"], true);
}

async fn report(state: &AppState, session: &str, event: &Value) -> (StatusCode, Value) {
    json_response(request(state, session, "POST", "/api/listening-events", Some(event)).await).await
}

async fn request(
    state: &AppState,
    session: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Response {
    music_routes()
        .merge(crate::routes::audio_playback::audio_playback_routes())
        .merge(playlist_routes())
        .merge(crate::routes::queue_and_media_session_routes())
        .merge(crate::routes::sonic_mixes::sonic_and_mixes_routes())
        .merge(crate::routes::playlist_collaboration::playlist_collaboration_routes())
        .merge(crate::routes::external_discovery::external_discovery_routes())
        .merge(crate::routes::taste_and_recommendation_routes())
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", format!("{SESSION_COOKIE}={session}"))
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .expect("request"),
        )
        .await
        .expect("response")
}

async fn json_response(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read response")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).expect("JSON response"),
    )
}

#[tokio::test]
async fn large_playlist_load_preserves_occurrences_and_playable_ids() {
    let (db, state, session) = playback_state(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = NavidromeClient::new(NavidromeConfig {
        url: format!("http://{}", listener.local_addr().unwrap()),
        username: "fixture".into(),
        password: "fixture".into(),
    })
    .unwrap();
    let upstream = tokio::spawn(async move {
        let router = Router::new().route(
            "/rest/getSong.view",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                tokio::time::sleep(Timeout::from_millis(3)).await;
                Json(json!({ "subsonic-response": { "status": "ok", "song": {
                "id": params["id"], "title": params["id"], "albumId": "album", "artistId": "artist",
                "coverArt": "art", "duration": 180
            } } }))
            }),
        );
        axum::serve(listener, router).await.unwrap();
    });
    state.providers().replace_all(vec![RegisteredProvider {
        connection_id: "fixture".into(),
        provider_type: "navidrome".into(),
        name: "Fixture".into(),
        enabled: true,
        provider: Arc::new(provider),
    }]);
    sqlx::raw_sql(
        "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
          VALUES ('fixture', 'navidrome', 'Fixture', '{}', 1, '2026-01-01', '2026-01-01');
         INSERT INTO playlists (id, name, owner_user_id, created_at, updated_at)
          VALUES ('large', 'Large playlist', 'listener', '2026-01-01', '2026-01-01');
         WITH RECURSIVE tracks(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM tracks WHERE n < 1199)
         INSERT INTO library_items (id, type, created_at, updated_at)
          SELECT 'md_' || n, 'track', '2026-01-01', '2026-01-01' FROM tracks;
         INSERT INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
          SELECT id, 'track', 'fixture', 'song-' || substr(id, 4), '2026-01-01' FROM library_items;
         INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
          SELECT 'entry-' || substr(id, 4), 'large', substr(id, 4), 'fixture', 'song-' || substr(id, 4), id, '2026-01-01'
          FROM library_items;
         INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
          VALUES ('repeat', 'large', 1200, 'fixture', 'song-0', 'md_0', '2026-01-01');"
    ).execute(db.inner()).await.unwrap();

    let started = std::time::Instant::now();
    let response = request(&state, &session, "GET", "/api/playlists/large", None).await;
    let elapsed = started.elapsed();
    let timing = response.headers().get("server-timing").cloned();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    eprintln!(
        "1201 occurrences: {elapsed:?}, {} JSON bytes, {timing:?}",
        bytes.len()
    );
    let timing = timing.unwrap();
    for phase in ["playlist_db", "playlist_hydrate", "playlist_json"] {
        assert!(timing.to_str().unwrap().contains(phase));
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let playlist = &body["playlist"];
    let tracks = playlist["tracks"].as_array().unwrap();
    let ids = playlist["itemIds"].as_array().unwrap();
    assert_eq!(playlist["songCount"], 1201);
    assert_eq!(ids.len(), tracks.len());
    for (index, track) in tracks.iter().enumerate() {
        let track_index = index % 1200;
        assert_eq!(track["id"], format!("md_{track_index}"));
        assert_eq!(
            track["streamUrl"],
            format!("/api/tracks/md_{track_index}/stream")
        );
        assert_eq!(track["playlistItemId"], ids[index]);
        for field in ["albumId", "artistId", "artworkId"] {
            assert!(track[field].is_string());
            assert_eq!(track[field], tracks[0][field]);
        }
    }
    assert_eq!(ids[1200], "repeat");

    let compressed = playlist_routes()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/playlists/large")
                .header("cookie", format!("{SESSION_COOKIE}={session}"))
                .header(http::header::ACCEPT_ENCODING, "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(compressed.status(), StatusCode::OK);
    assert_eq!(compressed.headers()[http::header::CONTENT_ENCODING], "gzip");
    let compressed_bytes = compressed.into_body().collect().await.unwrap().to_bytes();
    use std::io::Read as _;
    let mut uncompressed = Vec::new();
    flate2::read::GzDecoder::new(compressed_bytes.as_ref())
        .read_to_end(&mut uncompressed)
        .unwrap();
    assert_eq!(uncompressed.as_slice(), bytes.as_ref());
    eprintln!("1201 occurrences: {} gzip bytes", compressed_bytes.len());
    upstream.abort();
}

#[tokio::test]
async fn silence_analysis_routes_reject_invalid_profiles_and_explain_missing_audio() {
    let (db, state, session) = playback_state(true).await;
    let track = LibraryService::new(db, None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef { connection_id: "offline-source".into(), provider_item_id: "offline-track".into() },
            None,
        ).await.unwrap();
    let path = format!("/api/tracks/{track}/silence-analysis");
    let params = json!({"thresholdDb": -28, "minSilenceSeconds": 0.8});

    let (status, data) = json_response(request(&state, &session, "GET", &format!("{path}?thresholdDb=-28&minSilenceSeconds=0.8"), None).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data, json!({"analysis": null}));
    let (status, data) = json_response(request(&state, &session, "POST", &path, Some(&params)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["analysis"]["status"], "unavailable");
    assert_eq!(data["analysis"]["thresholdDb"], -28.0);
    assert!(data["analysis"]["errorMessage"].as_str().unwrap().contains("Original library audio"));
    assert_eq!(request(&state, &session, "POST", &path, Some(&json!({"minSilenceSeconds": 0}))).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(request(&state, &session, "POST", "/api/tracks/missing/silence-analysis", Some(&params)).await.status(), StatusCode::NOT_FOUND);

    let (status, scan) = json_response(request(&state, &session, "POST", "/api/playback/silence-scan", Some(&params)).await).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(scan["scan"]["status"], "discovering");
    let terminal = tokio::time::timeout(Timeout::from_secs(3), async {
        loop {
            let (status, data) = json_response(request(&state, &session, "GET", "/api/playback/silence-scan", None).await).await;
            assert_eq!(status, StatusCode::OK);
            if data["scan"]["status"] == "completed" {
                break data["scan"].clone();
            }
            tokio::time::sleep(Timeout::from_millis(10)).await;
        }
    }).await.expect("empty scan finishes");
    assert_eq!(terminal["totalTracks"], 0);
    assert!(terminal["warning"].as_str().unwrap().contains("No library tracks"));
}

#[tokio::test]
#[ignore = "requires an installed FFmpeg with silencedetect"]
async fn silence_analysis_and_scan_complete_with_host_ffmpeg() {
    let (db, state, session) = playback_state(true).await;
    let source = SourceRef {
        connection_id: "silence-fixture".into(),
        provider_item_id: "silence-wav".into(),
    };
    let track = LibraryService::new(db.clone(), None)
        .ensure_id(LibraryItemType::Track, &source, None)
        .await.unwrap();
    let wav = silence_fixture_wav();
    state.providers().replace_all(vec![media_fixture::provider(
        "silence-fixture",
        move |id, range, _, _| {
            assert_eq!(id, "silence-wav");
            assert!(range.is_none());
            (Timeout::ZERO, media_fixture::response(StatusCode::OK, [], wav.clone()))
        },
    )]);
    sqlx::query(
        "INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at)
         VALUES ('analysis-fixture', 'listener', 'Analysis fixture', '', '')",
    ).execute(db.inner()).await.unwrap();
    sqlx::query(
        "INSERT INTO playlist_items (id, playlist_id, position, connection_id,
            provider_track_id, library_track_id, created_at)
         VALUES ('analysis-item', 'analysis-fixture', 0, ?, ?, ?, '')",
    )
    .bind(&source.connection_id).bind(&source.provider_item_id).bind(&track)
    .execute(db.inner()).await.unwrap();

    let path = format!("/api/tracks/{track}/silence-analysis");
    let params = json!({"thresholdDb": -35, "minSilenceSeconds": 0.5, "force": true});
    let (status, body) = json_response(request(&state, &session, "POST", &path, Some(&params)).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let analysis = &body["analysis"];
    assert_eq!(analysis["status"], "completed", "{body}");
    for field in ["leadingSilenceSeconds", "trailingSilenceSeconds"] {
        assert!((analysis[field].as_f64().unwrap() - 1.0).abs() < 0.01, "{body}");
    }
    let query = format!("{path}?thresholdDb=-35&minSilenceSeconds=0.5");
    let (status, cached) = json_response(request(&state, &session, "GET", &query, None).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cached, body);

    // A different profile makes the background worker decode the fixture too.
    let params = json!({"thresholdDb": -34, "minSilenceSeconds": 0.5});
    let scan_path = "/api/playback/silence-scan";
    let (status, body) = json_response(request(&state, &session, "POST", scan_path, Some(&params)).await).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let job = tokio::time::timeout(Timeout::from_secs(20), async {
        loop {
            let (status, data) = json_response(request(&state, &session, "GET", scan_path, None).await).await;
            assert_eq!(status, StatusCode::OK);
            if matches!(data["scan"]["status"].as_str(), Some("completed" | "failed")) {
                return data["scan"].clone();
            }
            tokio::time::sleep(Timeout::from_millis(30)).await;
        }
    }).await.expect("scan reaches a terminal status");
    assert_eq!(job["id"], body["scan"]["id"]);
    assert_eq!(job["status"], "completed", "{job}");
    assert_eq!(job["totalTracks"], 1);
    assert_eq!(job["completedTracks"], 1);
    assert_eq!(job["skippedTracks"], 0);
    assert_eq!(job["failedTracks"], 0);
}

#[tokio::test]
#[ignore = "requires an installed FFmpeg with loudnorm"]
async fn normalization_prepares_verified_audio_and_scans_loudness_with_host_ffmpeg() {
    let dir = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&dir.path().join("loudness.sqlite")).await.unwrap();
    let (db, state, session) = playback_state_with_db(db, true).await;
    let source = SourceRef {
        connection_id: "loudness-fixture".into(),
        provider_item_id: "tone".into(),
    };
    let track = LibraryService::new(db.clone(), None)
        .ensure_id(LibraryItemType::Track, &source, None)
        .await.unwrap();
    let wav = silence_fixture_wav();
    state.providers().replace_all(vec![media_fixture::provider(
        &source.connection_id,
        move |id, _, _, _| {
            assert_eq!(id, "tone");
            (Timeout::ZERO, media_fixture::response(StatusCode::OK,
                [(http::header::CONTENT_TYPE, "audio/wav")], wav.clone()))
        },
    )]);
    sqlx::query(
        "INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at)
         VALUES ('loudness-list', 'listener', 'Loudness fixture', '', '')",
    ).execute(db.inner()).await.unwrap();
    sqlx::query(
        "INSERT INTO playlist_items (id, playlist_id, position, connection_id,
            provider_track_id, library_track_id, created_at)
         VALUES ('loudness-item', 'loudness-list', 0, ?, ?, ?, '')",
    )
    .bind(&source.connection_id).bind(&source.provider_item_id).bind(&track)
    .execute(db.inner()).await.unwrap();

    let params = json!({"trackId": track, "source": source.connection_id, "background": true, "targetLufs": -16});
    let normalize = "/api/playback/normalize";
    let writer = crate::db::begin_sqlite_write(db.inner(), "UPDATE library_items SET id=id WHERE 0").await.unwrap();
    let (status, body) = json_response(request(&state, &session, "POST", normalize, Some(&params)).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "processing");
    let raw = request(&state, &session, "GET", &format!("/api/tracks/{track}/stream"), None).await;
    assert_eq!(raw.status(), StatusCode::OK);
    assert!(raw.into_body().collect().await.unwrap().to_bytes().starts_with(b"RIFF"));
    writer.rollback().await.unwrap();

    let ready = tokio::time::timeout(Timeout::from_secs(20), async {
        loop {
            let (status, body) = json_response(request(&state, &session, "POST", normalize, Some(&params)).await).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            if body["status"] != "processing" {
                return body;
            }
            tokio::time::sleep(Timeout::from_millis(50)).await;
        }
    }).await.expect("normalization finishes");
    assert_eq!(ready["status"], "ready", "{ready}");
    assert!((ready["integratedLufs"].as_f64().unwrap() + 16.0).abs() < 1.0);
    assert!(ready["truePeakDb"].as_f64().unwrap() <= -0.9);
    let asset = request(&state, &session, "GET", ready["streamUrl"].as_str().unwrap(), None).await;
    assert_eq!(asset.status(), StatusCode::OK);
    assert!(asset.into_body().collect().await.unwrap().to_bytes().starts_with(b"fLaC"));

    let scan_path = "/api/playback/loudness-scan";
    let (status, scan) = json_response(request(&state, &session, "POST", scan_path, Some(&json!({}))).await).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{scan}");
    assert_eq!(scan["scan"]["status"], "discovering");
    let job = tokio::time::timeout(Timeout::from_secs(20), async {
        loop {
            let (status, data) = json_response(request(&state, &session, "GET", scan_path, None).await).await;
            assert_eq!(status, StatusCode::OK);
            if matches!(data["scan"]["status"].as_str(), Some("completed" | "failed")) {
                return data["scan"].clone();
            }
            tokio::time::sleep(Timeout::from_millis(50)).await;
        }
    }).await.expect("loudness scan reaches a terminal state");
    assert_eq!(job["status"], "completed", "{job}");
    assert_eq!(job["totalTracks"], 1);
    assert_eq!(job["completedTracks"], 1);
    assert_eq!(job["failedTracks"], 0);
    let (status, measured) = json_response(request(&state, &session, "POST", normalize,
        Some(&json!({"trackId": track, "background": true}))).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(measured["status"], "measured", "{measured}");
    assert!(measured["gainDb"].as_f64().unwrap().is_finite());
}

fn silence_fixture_wav() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const SAMPLES: u32 = 4 * SAMPLE_RATE;
    const PCM_BYTES: u32 = 2 * SAMPLES;
    let mut wav = Vec::with_capacity(44 + PCM_BYTES as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + PCM_BYTES).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1_u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&PCM_BYTES.to_le_bytes());
    for i in 0..SAMPLES {
        let sample = if (SAMPLE_RATE..3 * SAMPLE_RATE).contains(&i) {
            let phase = std::f64::consts::TAU * 440.0 * f64::from(i) / f64::from(SAMPLE_RATE);
            (phase.sin() * 8_000.0) as i16
        } else {
            0
        };
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[tokio::test]
async fn media_checkpoint_json_contract_preserves_axum_statuses_and_request_ids() {
    let (_db, state, session) = playback_state(true).await;
    let now = Utc::now().timestamp_millis();
    let fixture = json!({
        "type": "album", "mediaId": "album-fixture", "trackId": "track-fixture", "title": "Fixture",
        "trackIndex": 0, "trackCount": 1, "positionSeconds": 12.5, "capturedAt": now
    });
    let mut nullable = fixture.clone();
    nullable["durationSeconds"] = Value::Null;
    nullable["occurrenceId"] = Value::Null;
    let router = crate::create_router(state);
    let send = |body: String, content_type: Option<&str>| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/user/media-sessions")
            .header("cookie", format!("{SESSION_COOKIE}={session}"));
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
    };
    for body in [&fixture, &nullable] {
        let (status, out) = json_response(
            send(body.to_string(), Some("application/json"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{out}");
        assert_eq!(out["checkpoint"]["capturedAt"], now);
        assert_eq!(out["checkpoint"]["positionSeconds"], 12.5);
    }

    let mut cases = vec![
        (
            "{".into(),
            Some("application/json"),
            StatusCode::BAD_REQUEST,
            "INVALID_JSON",
        ),
        (
            fixture.to_string(),
            None,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
        ),
        (
            " ".repeat(2 * 1024 * 1024 + 1),
            Some("application/json"),
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
        ),
    ];
    for (field, value, status, code) in [
        (
            "type",
            json!("folder"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "trackId",
            json!(123),
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "completed",
            Value::Null,
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_JSON_DATA",
        ),
        (
            "capturedAt",
            json!(now / 1000),
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
        ),
        (
            "positionSeconds",
            json!(125_000),
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
        ),
        ("mediaId", json!(""), StatusCode::BAD_REQUEST, "BAD_REQUEST"),
    ] {
        let mut invalid = fixture.clone();
        invalid[field] = value;
        cases.push((invalid.to_string(), Some("application/json"), status, code));
    }
    for (body, content_type, expected_status, code) in cases {
        let response = send(body, content_type).await.unwrap();
        let request_id = response.headers()["x-request-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let (status, out) = json_response(response).await;
        assert_eq!(status, expected_status, "{out}");
        assert_eq!(out["error"]["code"], code);
        assert_eq!(out["error"]["requestId"], request_id);
        assert!(uuid::Uuid::parse_str(&request_id).is_ok());
    }
}

const MEDIA_SESSION_PATH: &str = "/api/v1/user/media-sessions";

fn media_checkpoint_payload(captured_at: i64) -> Value {
    json!({
        "type": "album", "mediaId": "album", "title": "Fixture", "trackId": "track-1",
        "occurrenceId": null, "trackIndex": 1, "trackCount": 3,
        "positionSeconds": 42.125, "durationSeconds": 180, "capturedAt": captured_at,
        "completed": false,
    })
}

#[tokio::test]
async fn media_checkpoint_round_trips_and_hides_expired_or_completed_sessions() {
    let (db, state, session) = playback_state(true).await;
    let path = format!("{MEDIA_SESSION_PATH}?type=album&mediaId=album");
    let empty = (StatusCode::OK, json!({"items": []}));
    assert_eq!(json_response(request(&state, &session, "GET", &path, None).await).await, empty);

    let now = Utc::now().timestamp_millis();
    let mut checkpoint = media_checkpoint_payload(now);
    let (status, saved) = json_response(request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&checkpoint)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["checkpoint"]["positionSeconds"], 42.125);
    assert_eq!(saved["checkpoint"]["capturedAt"], now);
    assert!(saved["checkpoint"]["updatedAt"].as_i64().is_some_and(|at| at >= now));
    assert_eq!(json_response(request(&state, &session, "GET", &path, None).await).await,
        (StatusCode::OK, json!({"items": [saved["checkpoint"]]})));

    let mut stale = checkpoint.clone();
    stale["capturedAt"] = json!(now - 1);
    stale["positionSeconds"] = json!(10);
    assert_eq!(json_response(request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&stale)).await).await,
        (StatusCode::OK, saved));

    checkpoint["completed"] = json!(true);
    checkpoint["capturedAt"] = json!(now + 1);
    let completed = (StatusCode::OK, json!({"checkpoint": null}));
    for input in [&checkpoint, &stale] {
        assert_eq!(json_response(request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(input)).await).await, completed);
    }
    assert_eq!(json_response(request(&state, &session, "GET", &path, None).await).await, empty);

    let current = media_checkpoint_payload(now + 2);
    assert_eq!(request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&current)).await.status(), StatusCode::OK);
    sqlx::query("UPDATE media_sessions SET updated_at = 0;").execute(db.inner()).await.unwrap();
    assert_eq!(json_response(request(&state, &session, "GET", MEDIA_SESSION_PATH, None).await).await, empty);
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_sessions").fetch_one(db.inner()).await.unwrap();
    assert_eq!(stored, 1, "GET filters expired rows without writing");
}

#[tokio::test]
async fn media_checkpoint_read_and_save_respect_playlist_visibility() {
    let (db, state, session) = playback_state(true).await;
    sqlx::query("INSERT INTO playlists (id, name, sharing_mode, created_at, updated_at)
        VALUES ('shared', 'Shared playlist', 'PUBLIC_SERVER', '2026-01-01', '2026-01-01');")
        .execute(db.inner()).await.unwrap();
    let now = Utc::now().timestamp_millis();
    let mut checkpoint = media_checkpoint_payload(now);
    checkpoint["type"] = json!("playlist");
    checkpoint["mediaId"] = json!("shared");
    checkpoint["occurrenceId"] = json!("slot-2");
    let response = request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&checkpoint)).await;
    let (status, saved) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["checkpoint"]["occurrenceId"], "slot-2");

    sqlx::query("UPDATE playlists SET deleted_at = '2026-01-02' WHERE id = 'shared';")
        .execute(db.inner()).await.unwrap();
    let path = format!("{MEDIA_SESSION_PATH}?type=playlist&mediaId=shared");
    assert_eq!(json_response(request(&state, &session, "GET", &path, None).await).await,
        (StatusCode::OK, json!({"items": []})));
    assert_eq!(request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&checkpoint)).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn media_checkpoint_reads_during_other_writes_and_retries_first_save_after_unlock() {
    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("media.sqlite")).await.unwrap();
    let (db, state, session) = playback_state_with_db(db, true).await;
    let now = Utc::now().timestamp_millis();
    let mut writer = db.inner().begin().await.unwrap();
    sqlx::query("UPDATE queue_sessions SET sequence = sequence WHERE 0")
        .execute(&mut *writer).await.unwrap();
    let response = request(&state, &session, "GET", MEDIA_SESSION_PATH, None).await;
    assert_eq!(response.headers()[http::header::CACHE_CONTROL], "private, no-store");
    assert_eq!(json_response(response).await, (StatusCode::OK, json!({"items": []})));

    let checkpoint = media_checkpoint_payload(now);
    let response = tokio::time::timeout(Timeout::from_secs(4),
        request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&checkpoint))).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[http::header::RETRY_AFTER], "1");
    writer.rollback().await.unwrap();

    let response = request(&state, &session, "POST", MEDIA_SESSION_PATH, Some(&checkpoint)).await;
    let (status, saved) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["checkpoint"]["positionSeconds"], 42.125);
}

#[tokio::test]
async fn playback_write_routes_return_service_unavailable_for_read_only_storage() {
    let (db, state, session) = playback_state(true).await;
    sqlx::query("PRAGMA query_only = ON").execute(db.inner()).await.unwrap();
    let router = crate::create_router(state.clone());
    let now = Utc::now().timestamp_millis();
    let operations = [
        ("PUT", "/api/v1/user/queue-session", json!({
            "ownerId": "listener", "deviceId": "device", "deviceName": "Desktop",
            "contentId": "a".repeat(64), "sequence": 1,
            "checkpoint": {"index": 0, "position": 0, "repeatOne": false, "shuffle": false,
                "shuffleMode": "standard", "albumAware": false, "volume": 1, "wasPlaying": true, "capturedAt": now}
        })),
        ("POST", "/api/listening-events", playback_event(1.0, false)),
        ("POST", "/api/v1/user/media-sessions", json!({
            "type": "album", "mediaId": "album", "title": "Album", "trackId": "track-1",
            "trackIndex": 0, "trackCount": 1, "positionSeconds": 1, "capturedAt": now
        })),
    ];
    for (method, path, body) in operations {
        let response = router.clone().oneshot(Request::builder().method(method).uri(path)
            .header("content-type", "application/json")
            .header("cookie", format!("{SESSION_COOKIE}={session}"))
            .body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let request_id = response.headers()["x-request-id"].to_str().unwrap().to_owned();
        let (status, payload) = json_response(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path} {payload}");
        assert_eq!(payload["error"]["requestId"], request_id);
        assert!(!payload.to_string().contains("readonly database"));
    }
    sqlx::query("PRAGMA query_only = OFF").execute(db.inner()).await.unwrap();
    let (status, _) = report(&state, &session, &playback_event(1.0, false)).await;
    assert_eq!(status, StatusCode::OK);
}

const QUEUE_SESSION_PATH: &str = "/api/v1/user/queue-session";

fn queue_session_payload(
    content_id: &Value,
    sequence: u64,
    index: i64,
    position: f64,
    captured_at: i64,
) -> Value {
    json!({
        "ownerId": "listener", "deviceId": "browser", "deviceName": "Desktop",
        "contentId": content_id, "sequence": sequence,
        "checkpoint": {"index": index, "position": position, "repeatOne": false, "shuffle": false,
            "shuffleSeed": null, "shuffleMode": "standard", "albumAware": false, "volume": 0.75,
            "wasPlaying": index >= 0, "context": null, "capturedAt": captured_at}
    })
}

#[tokio::test]
async fn queue_session_routes_round_trip_browser_checkpoints_and_empty_queues() {
    let (db, state, session) = playback_state(true).await;
    let response = request(&state, &session, "GET", QUEUE_SESSION_PATH, None).await;
    assert_eq!(
        response.headers()[http::header::CACHE_CONTROL],
        "private, no-store"
    );
    let empty_listing = json!({"sessions": [], "namedQueues": []});
    assert_eq!(json_response(response).await, (StatusCode::OK, empty_listing.clone()));

    let first = json!({"entryId": "first", "track": {"id": "track-1"}});
    let second = json!({"entryId": "second", "track": {"id": "track-2", "title": "Song", "previewUrl": null}});
    let now = Utc::now().timestamp_millis();
    for (sequence, index, position, tracks) in [
        (1, 0, 0.0, vec![&first, &second]),
        (2, 0, 0.0, vec![&second, &first]),
        (3, 1, 12.875, vec![&second, &first]),
        (4, -1, 0.0, vec![]),
    ] {
        let content = json!({"version": 2, "entries": tracks});
        let (status, uploaded) = upload_queue_content(&state, &session, &content).await;
        assert_eq!(status, StatusCode::OK, "{uploaded}");
        let content_id = &uploaded["contentId"];
        let update = queue_session_payload(content_id, sequence, index, position, now + sequence as i64);
        let response = request(&state, &session, "PUT", QUEUE_SESSION_PATH, Some(&update)).await;
        assert_eq!(json_response(response).await, (StatusCode::OK, json!({"saved": true, "sequence": sequence})));
        let response = request(&state, &session, "GET", QUEUE_SESSION_PATH, None).await;
        let (status, listing) = json_response(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listing["sessions"][0]["deviceId"], "browser");
        assert_eq!(listing["sessions"][0]["contentId"], *content_id);
        assert_eq!(listing["sessions"][0]["checkpoint"], update["checkpoint"]);
        assert_eq!(listing["sessions"][0]["sequence"], sequence);
        assert_eq!(listing["sessions"][0]["trackCount"], tracks.len());
        assert!(listing["sessions"][0]["updatedAt"].as_i64().is_some_and(|timestamp| timestamp >= now));
        let path = format!("{QUEUE_SESSION_PATH}/content/{}", content_id.as_str().unwrap());
        assert_eq!(json_response(request(&state, &session, "GET", &path, None).await).await,
            (StatusCode::OK, content));
        if sequence == 4 {
            let wrong_index = queue_session_payload(content_id, 5, 0, 0.0, now + 5);
            let stale_clock = queue_session_payload(content_id, 5, -1, 0.0, now);
            let malformed = json!({"owner_id": "listener", "checkpoint": null});
            for (value, expected) in [
                (wrong_index, StatusCode::BAD_REQUEST),
                (malformed, StatusCode::UNPROCESSABLE_ENTITY),
            ] {
                let response = request(&state, &session, "PUT", QUEUE_SESSION_PATH, Some(&value)).await;
                assert_eq!(response.status(), expected);
            }
            let response = request(&state, &session, "PUT", QUEUE_SESSION_PATH, Some(&stale_clock)).await;
            assert_eq!(json_response(response).await, (StatusCode::OK, json!({"saved": false, "sequence": 4})));
        }
    }

    sqlx::query("UPDATE queue_sessions SET checkpoint_json = '{'")
        .execute(db.inner()).await.unwrap();
    let response = request(&state, &session, "GET", QUEUE_SESSION_PATH, None).await;
    assert_eq!(json_response(response).await, (StatusCode::OK, empty_listing));
}

#[tokio::test]
async fn queue_session_writer_returns_retryable_response_while_sqlite_is_locked() {
    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("queue.sqlite")).await.unwrap();
    let (db, state, session) = playback_state_with_db(db, true).await;
    let content = json!({"version": 2, "entries": []});
    let (status, uploaded) = upload_queue_content(&state, &session, &content).await;
    assert_eq!(status, StatusCode::OK);
    let update = queue_session_payload(&uploaded["contentId"], 1, -1, 0.0, Utc::now().timestamp_millis());

    let mut writer = db.inner().begin().await.unwrap();
    sqlx::query("UPDATE queue_sessions SET sequence = sequence WHERE 0")
        .execute(&mut *writer).await.unwrap();
    let response = tokio::time::timeout(Timeout::from_secs(4),
        request(&state, &session, "PUT", QUEUE_SESSION_PATH, Some(&update))).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[http::header::RETRY_AFTER], "1");
    writer.rollback().await.unwrap();

    let response = request(&state, &session, "PUT", QUEUE_SESSION_PATH, Some(&update)).await;
    assert_eq!(json_response(response).await, (StatusCode::OK, json!({"saved": true, "sequence": 1})));
}

async fn upload_queue_content(state: &AppState, session: &str, content: &Value) -> (StatusCode, Value) {
    json_response(request(state, session, "POST",
        "/api/v1/user/queue-session/content?ownerId=listener", Some(content)).await).await
}

fn catalog_test_track(id: &str, title: &str) -> crate::providers::Track {
    serde_json::from_value(json!({
        "id": id, "providerId": id, "title": title, "artistName": "Fixture Artist",
        "albumName": "Fixture Album", "streamUrl": "", "durationSeconds": 180,
    }))
    .unwrap()
}

fn catalog_test_album(id: &str, name: &str) -> crate::providers::Album {
    serde_json::from_value(json!({
        "id": id, "providerId": id, "name": name, "artistName": "Fixture Artist", "songCount": 1,
    }))
    .unwrap()
}

fn set_catalog_fixture(
    state: &AppState,
    tracks: Vec<crate::providers::Track>,
    albums: Vec<crate::providers::Album>,
) -> Arc<std::sync::RwLock<media_fixture::CatalogFixture>> {
    let fixture = Arc::new(std::sync::RwLock::new(media_fixture::CatalogFixture {
        tracks,
        albums,
    }));
    state
        .providers()
        .replace_all(vec![media_fixture::catalog_provider(
            "fixture",
            fixture.clone(),
        )]);
    fixture
}

#[tokio::test]
async fn playlist_recommendations_use_the_playlist_seeds_and_permissions() {
    let (db, state, session) = playback_state(true).await;
    let mut seed = catalog_test_track("seed", "Seed");
    seed.genres = Some(vec!["Trip Hop".into()]);
    let mut genre_match = catalog_test_track("genre", "Same Genre");
    genre_match.artist_name = "Another Artist".into();
    genre_match.genres = seed.genres.clone();
    let mut unrelated = catalog_test_track("unrelated", "Unrelated");
    unrelated.artist_name = "Another Artist".into();
    set_catalog_fixture(
        &state,
        vec![
            seed.clone(),
            catalog_test_track("duplicate", "Seed"),
            catalog_test_track("same-artist", "Same Artist"),
            genre_match,
            unrelated,
        ],
        vec![],
    );
    let (status, created) = json_response(
        request(
            &state,
            &session,
            "POST",
            "/api/playlists",
            Some(&json!({"name": "Fixture"})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let playlist_id = created["playlist"]["id"].as_str().unwrap();
    let path = format!("/api/v1/playlists/{playlist_id}/recommendations");
    let empty = request(&state, &session, "GET", &path, None).await;
    assert_eq!(
        json_response(empty).await,
        (
            StatusCode::OK,
            json!({"items": [], "message": null, "canModify": true})
        )
    );

    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let seed_id = catalog.stamp_track(seed, "fixture").await.unwrap().item.id;
    let add = request(
        &state,
        &session,
        "POST",
        &format!("/api/v1/playlists/{playlist_id}/tracks/batch"),
        Some(&json!({"action": "add", "trackIds": [seed_id]})),
    )
    .await;
    assert_eq!(add.status(), StatusCode::OK);
    let response = request(
        &state,
        &session,
        "GET",
        &format!("{path}?source=library"),
        None,
    )
    .await;
    assert_eq!(
        response.headers()[http::header::CACHE_CONTROL],
        "private, no-store"
    );
    let (status, payload) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["canModify"], true);
    let items = payload["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["title"], "Same Artist");
    assert_eq!(
        items[0]["recommendationReason"],
        "Fixture Artist is in this playlist"
    );
    assert_eq!(items[1]["title"], "Same Genre");

    sqlx::query("UPDATE users SET external_search_enabled = 1 WHERE id = 'listener'")
        .execute(db.inner())
        .await
        .unwrap();
    let (_, external) = json_response(
        request(
            &state,
            &session,
            "GET",
            &format!("{path}?source=external"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        external,
        json!({"items": [], "message": "External suggestions are disabled.", "canModify": true})
    );

    sqlx::query(
        "INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
         VALUES ('viewer', 'viewer', 'unused', 'Viewer', 'user', '2026-01-01', '2026-01-01')",
    ).execute(db.inner()).await.unwrap();
    let viewer = state
        .session_store()
        .unwrap()
        .create_session("viewer", true)
        .await
        .unwrap();
    assert_eq!(
        request(&state, &viewer.id, "GET", &path, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE playlists SET sharing_mode = 'PUBLIC_SERVER' WHERE id = ?")
        .bind(playlist_id)
        .execute(db.inner())
        .await
        .unwrap();
    let (status, shared) =
        json_response(request(&state, &viewer.id, "GET", &path, None).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shared["canModify"], false);
    assert_eq!(shared["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn playlist_recommendations_filter_external_recordings_and_preserve_import_metadata() {
    use crate::recommendations::service::{
        PlaylistRecommendationSeeds, recommend_external_for_playlist,
    };
    let (db, state, _) = playback_state(true).await;
    set_catalog_fixture(&state, vec![catalog_test_track("owned", "Owned")], vec![]);
    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let inventory = catalog.list_tracks().await;
    let seeds = PlaylistRecommendationSeeds::new(&[crate::playlists::PlaylistTrack {
        playlist_item_id: "occurrence".into(),
        playlist_added_at: "2026-01-01".into(),
        added_by_user_id: None,
        added_by: None,
        track: json!({
            "id": "external_seed", "title": "Seed", "artist": "Fixture Artist",
            "artistCredits": [{"name": "Fixture Artist"}, {"name": "Guest Artist"}],
            "identityHints": {"isrc": "ZZ0000000000"}
        }),
    }]);
    assert_eq!(
        seeds.external_artist_names(),
        vec!["Fixture Artist", "Guest Artist"]
    );
    let external = |id: u64, title: &str, artist: &str| {
        json!({
            "id": format!("external_deezer_track_{id}"), "type": "track", "title": title, "artist": artist,
            "source": {"kind": "external", "count": 0}, "provider": "external",
            "previewUrl": "https://cdns-preview.dzcdn.net/preview.mp3", "metadata": {"deezerTrackId": id}
        })
    };
    let mut duplicate_isrc = external(5, "Seed alternate", "Fixture Artist");
    duplicate_isrc["identityHints"] = json!({"isrc": "zz0000000000"});
    let candidates = [
        external(1, "Seed", "Fixture Artist"),
        external(2, "Owned", "Fixture Artist"),
        external(3, "New Track", "Fixture Artist"),
        external(4, "New Track", "Fixture Artist"),
        duplicate_isrc,
        external(6, "Unrelated", "Another Artist"),
        external(8, "Guest Track", "Guest Artist"),
        external(9, "Second Track", "Fixture Artist"),
    ]
    .into_iter()
    .map(|track| (track, None))
    .chain([(
        external(7, "Related Track", "Related Artist"),
        Some("Fixture Artist"),
    )]);
    let rows =
        recommend_external_for_playlist(&db, "listener", &seeds, &inventory.items, candidates, 30)
            .await;
    assert_eq!(
        rows.iter()
            .map(|item| item["metadata"]["deezerTrackId"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![3, 8, 7, 9]
    );
    assert_eq!(rows[0]["id"], "external_deezer_track_3");
    assert_eq!(rows[0]["source"]["kind"], "external");
    assert_eq!(rows[0]["metadata"]["deezerTrackId"], 3);
    assert_eq!(
        rows[0]["recommendationReason"],
        "Fixture Artist is in this playlist"
    );
    assert_eq!(rows[2]["recommendationReason"], "Related to Fixture Artist");
}

#[tokio::test]
async fn autoplay_returns_empty_for_missing_seeds_and_unanalyzed_tracks() {
    let (_db, state, session) = playback_state(true).await;
    set_catalog_fixture(&state, vec![], vec![]);
    let response = request(
        &state,
        &session,
        "POST",
        "/api/recommendations/autoplay",
        Some(&json!({"seedId": "missing"})),
    )
    .await;
    assert_eq!(
        response.headers()[http::header::CACHE_CONTROL],
        "private, no-store"
    );
    assert_eq!(
        json_response(response).await,
        (
            StatusCode::OK,
            json!({"tracks": [], "items": [], "degraded": false})
        )
    );

    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let track = catalog
        .stamp_track(catalog_test_track("unanalyzed", "No vector"), "fixture")
        .await
        .unwrap();
    state
        .sonic()
        .configure(
            crate::sonic::SonicSettings {
                enabled: true,
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let path = format!("/api/sonic/similar/{}", track.item.id);
    let response = request(&state, &session, "GET", &path, None).await;
    assert_eq!(
        json_response(response).await,
        (
            StatusCode::OK,
            json!({"trackId": track.item.id, "matches": []})
        )
    );
}

#[tokio::test]
async fn autoplay_honors_seed_queue_exclusions_and_taste_during_a_playback_write() {
    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("autoplay.sqlite"))
        .await
        .unwrap();
    let (db, state, session) = playback_state_with_db(db, true).await;
    let seed = catalog_test_track("seed", "Seed");
    let queued = catalog_test_track("queued", "Already queued");
    let next = catalog_test_track("next", "Next track");
    set_catalog_fixture(
        &state,
        vec![
            catalog_test_track("unmapped", "Unmapped track"),
            seed.clone(),
            queued.clone(),
            next.clone(),
        ],
        vec![],
    );
    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let seed = catalog.stamp_track(seed, "fixture").await.unwrap().item.id;
    let queued = catalog
        .stamp_track(queued, "fixture")
        .await
        .unwrap()
        .item
        .id;
    let next = catalog.stamp_track(next, "fixture").await.unwrap().item.id;
    sqlx::query(
        "INSERT INTO taste_track_exclusions (user_id, track_id, recording_key, title, artist, created_at)
         VALUES ('listener', 'duplicate-id', ?, 'Seed', 'Fixture Artist', '2026-01-01')",
    )
    .bind(crate::profile::taste_recording_key("Seed", "Fixture Artist"))
    .execute(db.inner()).await.unwrap();

    let get_autoplay = async |body: Value| {
        let response = request(
            &state,
            &session,
            "POST",
            "/api/recommendations/autoplay",
            Some(&body),
        )
        .await;
        let (status, payload) = json_response(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["degraded"], false);
        payload["tracks"].as_array().unwrap().clone()
    };
    let start_writer = || async {
        let mut writer = db.inner().begin().await.unwrap();
        sqlx::query("UPDATE queue_sessions SET sequence = sequence WHERE 0")
            .execute(&mut *writer)
            .await
            .unwrap();
        writer
    };
    let writer = start_writer().await;
    assert!(get_autoplay(json!({"seedId": seed})).await.is_empty());
    writer.rollback().await.unwrap();
    let settings_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM taste_settings")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(settings_count, 0);
    sqlx::query("DELETE FROM taste_track_exclusions")
        .execute(db.inner())
        .await
        .unwrap();

    let writer = start_writer().await;
    let tracks =
        get_autoplay(json!({"seedId": seed, "limit": 2, "excludeIds": [seed, queued]})).await;
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["id"], next);
    assert!(tracks[0]["metadata"]["recommendationReason"].is_string());
    assert!(get_autoplay(json!({"seedId": "missing"})).await.is_empty());
    assert!(
        get_autoplay(json!({"seedId": seed, "excludeIds": [queued, next]}))
            .await
            .is_empty()
    );
    writer.rollback().await.unwrap();
    let unmapped_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM library_item_sources WHERE provider_item_id = 'unmapped'",
    )
    .fetch_one(db.inner())
    .await
    .unwrap();
    assert_eq!(unmapped_count, 0);
}

#[tokio::test]
async fn autoplay_reuses_the_catalog_loaded_by_recently_added_tracks() {
    let (_db, state, session) = playback_state(true).await;
    let fixture = set_catalog_fixture(
        &state,
        vec![
            catalog_test_track("seed", "Seed"),
            catalog_test_track("next", "Next track"),
        ],
        vec![],
    );
    let response = request(
        &state,
        &session,
        "GET",
        "/api/tracks/recently-added?limit=1",
        None,
    )
    .await;
    let (status, recent) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recent["tracks"][0]["title"], "Seed");
    assert_eq!(recent["tracks"].as_array().unwrap().len(), 1);
    // The provider cannot return candidates now. Playback uses the completed library window.
    fixture.write().unwrap().tracks.clear();
    let response = request(
        &state,
        &session,
        "POST",
        "/api/recommendations/autoplay",
        Some(&json!({"seedId": recent["tracks"][0]["id"]})),
    )
    .await;
    let (status, refill) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(refill["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(refill["tracks"][0]["title"], "Next track");
    let response = request(
        &state,
        &session,
        "GET",
        "/api/library/random-tracks?limit=2",
        None,
    )
    .await;
    let (status, fallback) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fallback["tracks"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn library_pages_cover_albums_past_500_and_revise_when_same_count_rows_shift() {
    let (_, state, session) = playback_state(true).await;
    let albums = (0..504)
        .map(|index| catalog_test_album(&format!("album-{index}"), &format!("Album {index:03}")))
        .collect();
    let fixture = set_catalog_fixture(
        &state,
        vec![
            catalog_test_track("a", "First"),
            catalog_test_track("b", "Second"),
        ],
        albums,
    );
    let read = |path| {
        let state = &state;
        let session = &session;
        async move {
            let (status, body) =
                json_response(request(state, session, "GET", path, None).await).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        }
    };
    let first = read("/api/albums?offset=0&limit=1").await;
    let late = read("/api/albums?offset=500&limit=2").await;
    assert_eq!(late["total"], 504);
    assert_eq!(late["albums"][0]["providerId"], "album-500");
    assert_eq!(late["albums"][1]["providerId"], "album-501");
    assert_eq!(late["revision"], first["revision"]);
    assert_eq!(late["degraded"], false);
    assert_eq!(
        read("/api/albums?offset=504&limit=2").await["albums"],
        json!([])
    );

    let first_track = read("/api/tracks?offset=0&limit=1").await;
    fixture.write().unwrap().tracks.swap(0, 1);
    fixture.write().unwrap().albums.swap(0, 1);
    let cached = read("/api/tracks?offset=1&limit=1").await;
    assert_eq!(cached["tracks"][0]["providerId"], "b");
    assert_eq!(cached["revision"], first_track["revision"]);

    state.catalog_snapshots().invalidate().await;
    let shifted = read("/api/tracks?offset=1&limit=1").await;
    assert_eq!(shifted["tracks"][0]["providerId"], "a");
    assert_eq!(shifted["total"], first_track["total"]);
    assert_ne!(shifted["revision"], first_track["revision"]);
    assert_ne!(
        read("/api/albums?offset=500&limit=2").await["revision"],
        late["revision"]
    );
    state.catalog_snapshots().invalidate().await;
    assert_eq!(
        read("/api/tracks?offset=0&limit=1").await["revision"],
        shifted["revision"]
    );
}

#[tokio::test]
async fn library_track_filters_apply_before_paging_and_revisions_are_user_scoped() {
    let (db, state, session) = playback_state(true).await;
    let mut tracks: Vec<_> = ["a", "b", "c", "d", "e"]
        .into_iter()
        .enumerate()
        .map(|(index, id)| {
            let mut track = catalog_test_track(id, "Shared title");
            track.identity_hints = Some(crate::providers::IdentityHints {
                isrc: Some(format!("USABC26{index:05}")),
                ..Default::default()
            });
            track
        })
        .collect();
    let mut duplicate = tracks[2].clone();
    duplicate.id = "copy-c".into();
    duplicate.provider_id = duplicate.id.clone();
    duplicate.added_at = Some("2026-01-01T00:00:00Z".into());
    tracks.insert(3, duplicate);
    set_catalog_fixture(&state, tracks, vec![]);
    let (_, listing) =
        json_response(request(&state, &session, "GET", "/api/tracks", None).await).await;
    let rows = listing["tracks"].as_array().unwrap();
    assert_eq!(listing["total"], 5);
    assert_eq!(rows[2]["providerId"], "c");
    assert_eq!(rows[3]["providerId"], "d");
    let (status, recent) = json_response(request(&state, &session, "GET", "/api/tracks/recently-added?limit=5", None).await).await;
    assert_eq!(status, StatusCode::OK);
    let recent = recent["tracks"].as_array().unwrap();
    assert_eq!(recent.len(), 5);
    assert_eq!(recent[0]["providerId"], "copy-c");
    assert!(!recent.iter().any(|track| track["providerId"] == "c"));
    let duplicate_id = recent[0]["id"].as_str().unwrap();
    let id = |index: usize| rows[index]["id"].as_str().unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('other', 'other', 'unused', 'Other', 'user', '2026-01-01', '2026-01-01')")
        .execute(db.inner()).await.unwrap();
    for (user, index) in [
        ("other", 0),
        ("listener", 1),
        ("listener", 2),
        ("listener", 3),
    ] {
        crate::services::favorites::set_track_favorite(&db, user, id(index), true)
            .await
            .unwrap();
    }
    crate::services::favorites::set_media_favorite(&db, "listener", "track", id(4), true, None)
        .await
        .unwrap();
    crate::services::favorites::set_track_favorite(&db, "listener", duplicate_id, true)
        .await.unwrap();
    add_recently_played(&db, "listener", id(1), None, false, None, None)
        .await
        .unwrap();
    add_recently_played(&db, "other", id(2), None, false, None, None)
        .await
        .unwrap();
    let body = |offset| {
        json!({ "offset": offset, "limit": 1, "filters": [
        {"field": "favorite", "op": "boolean", "value": true},
        {"field": "played", "op": "boolean", "value": false},
        {"field": "durationSeconds", "op": "gte", "value": 100}
    ] })
    };
    let read = |offset| {
        let body = body(offset);
        let state = &state;
        let session = &session;
        async move {
            let (status, response) = json_response(
                request(
                    state,
                    session,
                    "POST",
                    "/api/library/tracks/filter",
                    Some(&body),
                )
                .await,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{response}");
            response
        }
    };
    let first = read(0).await;
    let second = read(1).await;
    assert_eq!(first["total"], 3);
    assert_eq!(first["tracks"][0]["id"], id(2));
    assert_eq!(first["tracks"][0]["favorite"], true);
    assert_eq!(first["tracks"][0]["played"], false);
    assert_eq!(second["tracks"][0]["id"], id(3));
    assert_eq!(second["revision"], first["revision"]);
    assert_eq!(read(2).await["tracks"][0]["id"], id(4));
    add_recently_played(&db, "listener", id(2), None, false, None, None)
        .await
        .unwrap();
    add_recently_played(&db, "listener", duplicate_id, None, false, None, None)
        .await.unwrap();
    crate::services::favorites::set_track_favorite(&db, "listener", id(0), true)
        .await
        .unwrap();
    let shifted = read(0).await;
    assert_eq!(shifted["tracks"][0]["id"], id(0));
    assert_eq!(shifted["total"], first["total"]);
    assert_ne!(shifted["revision"], first["revision"]);
}

#[tokio::test]
async fn album_window_follows_navidrome_and_jellyfin_provider_pagination() {
    let (_, state, session) = playback_state(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route(
            "/Items",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["IncludeItemTypes"], "MusicAlbum");
                assert_eq!(params["Limit"], "500");
                let start: usize = params["StartIndex"].parse().unwrap();
                let items: Vec<_> = (start..(start + 500).min(502)).map(|index| json!({
                "Id": format!("jellyfin-{index}"), "Name": format!("Jellyfin Album {index}"),
                "Type": "MusicAlbum"
            })).collect();
                Json(json!({ "Items": items, "TotalRecordCount": 502 }))
            }),
        )
        .route(
            "/rest/getAlbumList2.view",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["size"], "500");
                let start: usize = params["offset"].parse().unwrap();
                let items: Vec<_> = (start..(start + 500).min(503)).map(|index| json!({
                "id": format!("navidrome-{index}"), "name": format!("Navidrome Album {index}")
            })).collect();
                Json(json!({ "subsonic-response": {
                "status": "ok", "albumList2": { "album": items }
            } }))
            }),
        );
    let upstream = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: [(&str, Arc<dyn MusicBackend>); 2] = [
        (
            "jellyfin",
            Arc::new(
                JellyfinClient::new(JellyfinConfig {
                    url: url.clone(),
                    api_key: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
        (
            "navidrome",
            Arc::new(
                NavidromeClient::new(NavidromeConfig {
                    url,
                    username: "fixture".into(),
                    password: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
    ];
    state.providers().replace_all(
        providers
            .into_iter()
            .map(|(id, provider)| RegisteredProvider {
                connection_id: id.into(),
                provider_type: id.into(),
                name: id.into(),
                enabled: true,
                provider,
            })
            .collect(),
    );

    let (status, page) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/albums?offset=500&limit=2",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1005);
    assert_eq!(page["albums"][0]["providerId"], "jellyfin-500");
    assert_eq!(page["albums"][1]["providerId"], "jellyfin-501");

    let (status, tail) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/albums?offset=1002&limit=3",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tail}");
    assert_eq!(tail["albums"][0]["providerId"], "navidrome-500");
    assert_eq!(tail["albums"][2]["providerId"], "navidrome-502");
    assert_eq!(tail["revision"], page["revision"]);
    assert_eq!(tail["degraded"], false);
    upstream.abort();
}

#[tokio::test]
async fn library_matches_preserve_input_order_and_recording_identity() {
    let (_, state, session) = playback_state(true).await;
    let mut track = catalog_test_track("studio", "The Song");
    track.identity_hints = Some(crate::providers::IdentityHints {
        isrc: Some("USAAA1234567".into()),
        music_brainz_id: None,
        upc: None,
    });
    track.artist_credits = Some(vec![crate::providers::TrackArtistCredit {
        id: None,
        name: "Guest Artist".into(),
    }]);
    set_catalog_fixture(
        &state,
        vec![track],
        vec![catalog_test_album("album", "The Album")],
    );
    let payload = json!({ "items": [
        {"id":"album","type":"album","title":"the album","artist":"Fixture Artist"},
        {"id":"live","type":"track","title":"The Song (Live)","artist":"Fixture Artist"},
        {"id":"conflict","type":"track","title":"The Song","artist":"Fixture Artist","isrc":"USAAA1234568"},
        {"id":"strong","type":"track","title":"Alternate title","artist":"Another Artist","isrc":"usaaa1234567"},
        {"id":"guest","type":"track","title":"The Song","artist":"Guest Artist","durationSeconds":182},
        {"id":"long","type":"track","title":"The Song","artist":"Guest Artist","durationSeconds":210},
        {"id":"album","type":"album","title":"The Album","artist":"Another Artist"}
    ] });
    let (status, response) = json_response(
        request(
            &state,
            &session,
            "POST",
            "/api/library/matches",
            Some(&payload),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let matches = response["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 7);
    let album_id = matches[0]["localAlbumId"].as_str().unwrap();
    let track_id = matches[3]["localTrackId"].as_str().unwrap();
    assert!(album_id.starts_with("md_"));
    assert!(track_id.starts_with("md_"));
    assert_eq!(
        response["matches"],
        json!([
            {"id":"album", "inLibrary":true, "localTrackId":null, "localAlbumId":album_id},
            {"id":"live", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"conflict", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"strong", "inLibrary":true, "localTrackId":track_id, "localAlbumId":null},
            {"id":"guest", "inLibrary":true, "localTrackId":track_id, "localAlbumId":null},
            {"id":"long", "inLibrary":false, "localTrackId":null, "localAlbumId":null},
            {"id":"album", "inLibrary":false, "localTrackId":null, "localAlbumId":null}
        ])
    );
    let oversized = json!({ "items": vec![payload["items"][0].clone(); 101] });
    let response = request(
        &state,
        &session,
        "POST",
        "/api/library/matches",
        Some(&oversized),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn catalog_album_lookup_continues_past_an_unregistered_connection() {
    let (db, state, _) = playback_state(true).await;
    set_catalog_fixture(
        &state,
        vec![],
        vec![catalog_test_album("fallback-album", "Available Album")],
    );
    let (catalog, _, library) = build_catalog_and_resolver(&state).unwrap();
    let id = library
        .ensure_id(
            LibraryItemType::Album,
            &SourceRef {
                connection_id: "removed".into(),
                provider_item_id: "old-album".into(),
            },
            None,
        )
        .await
        .unwrap();
    sqlx::query("UPDATE library_item_sources SET created_at='2025-01-01' WHERE library_item_id=?")
        .bind(&id)
        .execute(db.inner())
        .await
        .unwrap();
    library
        .add_source(
            &id,
            &SourceRef {
                connection_id: "fixture".into(),
                provider_item_id: "fallback-album".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        library.get_sources(&id).await.unwrap()[0].connection_id,
        "removed"
    );

    let album = catalog.get_album(&id).await.unwrap();
    assert_eq!(album.item.id, id);
    assert_eq!(album.item.name, "Available Album");
}

#[tokio::test]
async fn similar_mix_save_rolls_back_partial_writes_and_reads_back_in_order() {
    let (db, state, session) = playback_state(true).await;
    let tracks = [
        catalog_test_track("first", "First"),
        catalog_test_track("last", "Last"),
    ];
    set_catalog_fixture(&state, tracks.to_vec(), vec![]);
    let (catalog, _, _) = build_catalog_and_resolver(&state).unwrap();
    let first = catalog
        .stamp_track(tracks[0].clone(), "fixture")
        .await
        .unwrap();
    let last = catalog
        .stamp_track(tracks[1].clone(), "fixture")
        .await
        .unwrap();
    let external = state
        .similar_mixes()
        .register_external_seed("Discovery", "Guest")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO smart_playlist_catalog_state (singleton, refreshed_at, degraded, mix_revision)
        VALUES (1, '2026-01-01', 0, 1)",
    )
    .execute(db.inner())
    .await
    .unwrap();
    for track in [&first, &last] {
        sqlx::query(
            "INSERT INTO smart_playlist_tracks (id, title, artist, album, revision)
            VALUES (?, ?, 'Fixture Artist', 'Fixture Album', 'fixture')",
        )
        .bind(&track.item.id)
        .bind(&track.item.title)
        .execute(db.inner())
        .await
        .unwrap();
        sqlx::query("INSERT INTO smart_playlist_track_payloads VALUES (?, ?)")
            .bind(&track.item.id)
            .bind(serde_json::to_string(track).unwrap())
            .execute(db.inner())
            .await
            .unwrap();
    }
    let selection = [
        last.item.id.as_str(),
        external.id.as_str(),
        first.item.id.as_str(),
    ];
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO similar_mix_previews (id, user_id, candidate_ids_json, created_at, expires_at)
        VALUES ('preview', 'listener', ?, ?, ?)",
    )
    .bind(serde_json::to_string(&selection).unwrap())
    .bind(now)
    .bind(now + 60_000)
    .execute(db.inner())
    .await
    .unwrap();
    let payload = json!({ "ownerId": "listener", "previewId": "preview", "trackIds": selection, "name": "Mix" });
    let save = || {
        request(
            &state,
            &session,
            "POST",
            "/api/v1/similar-mixes/save",
            Some(&payload),
        )
    };
    sqlx::query(
        "CREATE TRIGGER refuse_mix_item BEFORE INSERT ON playlist_items WHEN NEW.position = 1
        BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
    )
    .execute(db.inner())
    .await
    .unwrap();
    assert_eq!(save().await.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM playlists")
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let claimed =
        sqlx::query_scalar::<_, Option<String>>("SELECT playlist_id FROM similar_mix_previews")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!(claimed, None);
    sqlx::query("DROP TRIGGER refuse_mix_item")
        .execute(db.inner())
        .await
        .unwrap();

    let (left, right) = tokio::join!(save(), save());
    let (created, replay) = if left.status() == StatusCode::CREATED {
        (left, right)
    } else {
        (right, left)
    };
    let (status, created) = json_response(created).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, replay) = json_response(replay).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["alreadySaved"], true);
    assert_eq!(created["playlist"], replay["playlist"]);

    let pid = created["playlist"]["id"].as_str().unwrap();
    let (status, response) = json_response(
        request(
            &state,
            &session,
            "GET",
            &format!("/api/playlists/{pid}"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let tracks = response["playlist"]["tracks"].as_array().unwrap();
    assert_eq!(
        tracks
            .iter()
            .map(|track| track["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        selection
    );
    assert_eq!(tracks[0]["providerId"], "last");
    assert_eq!(tracks[1]["external"], true);
    assert_eq!(tracks[2]["providerId"], "first");
}

#[tokio::test]
async fn library_search_returns_tracks_from_navidrome_and_jellyfin() {
    let (db, state, session) = playback_state(true).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route(
            "/rest/search3.view",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(params["query"], "Fixture Track");
                assert_eq!(params["artistCount"], "20");
                assert_eq!(params["albumCount"], "20");
                assert_ne!(params["songCount"], "0");
                Json(json!({
                    "subsonic-response": { "status": "ok", "searchResult3": {
                        "song": [{ "id": "navidrome-track", "title": "Fixture Track" }]
                    }}
                }))
            }),
        )
        .route(
            "/Items",
            get(
                |headers: HeaderMap, Query(params): Query<HashMap<String, String>>| async move {
                    let authorization = headers[http::header::AUTHORIZATION].to_str().unwrap();
                    assert!(authorization.starts_with("MediaBrowser Client=\"MusicDeck\""));
                    assert!(authorization.ends_with("Token=\"fixture\""));
                    assert_eq!(params["searchTerm"], "Fixture Track");
                    assert_eq!(params["IncludeItemTypes"], "MusicArtist,MusicAlbum,Audio");
                    Json(json!({ "Items": [{
                    "Id": "jellyfin-track", "Name": "Fixture Track", "Type": "Audio"
                }] }))
                },
            ),
        );
    let upstream = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let providers: [(&str, Arc<dyn MusicBackend>); 2] = [
        (
            "navidrome",
            Arc::new(
                NavidromeClient::new(NavidromeConfig {
                    url: url.clone(),
                    username: "fixture".into(),
                    password: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
        (
            "jellyfin",
            Arc::new(
                JellyfinClient::new(JellyfinConfig {
                    url,
                    api_key: "fixture".into(),
                })
                .unwrap(),
            ),
        ),
    ];
    for (kind, provider) in providers {
        sqlx::query(
            "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
             VALUES (?, ?, 'Fixture', '{}', 1, '2026-01-01', '2026-01-01')",
        )
        .bind(kind)
        .bind(kind)
        .execute(db.inner())
        .await
        .unwrap();
        state.providers().replace_all(vec![RegisteredProvider {
            connection_id: kind.into(),
            provider_type: kind.into(),
            name: "Fixture".into(),
            enabled: true,
            provider,
        }]);

        let path = "/api/search?q=Fixture%20Track&types=track&mode=library&phase=local";
        let (status, body) =
            json_response(request(&state, &session, "GET", path, None).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["degraded"], false, "{kind}: {body}");
        assert_eq!(
            body["tracks"][0]["title"], "Fixture Track",
            "{kind}: {body}"
        );
    }
    upstream.abort();
}

fn fixture_cover(color: u8) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([color, 80, 150, 255]));
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("encode fixture cover");
    bytes.into_inner()
}

async fn add_fixture_library(db: &DbPool, state: &AppState) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind library fixture");
    let url = format!("http://{}", listener.local_addr().expect("fixture address"));
    sqlx::query(
        "INSERT INTO backend_connections (id, type, name, config_json, enabled, created_at, updated_at)
         VALUES ('fixture-library', 'navidrome', 'Fixture', '{}', 1, '2026-01-01', '2026-01-01')",
    )
    .execute(db.inner())
    .await
    .expect("store fixture connection");
    let provider = NavidromeClient::new(NavidromeConfig {
        url,
        username: String::from("fixture"),
        password: String::from("fixture"),
    })
    .expect("create fixture provider");
    state.providers().replace_all(vec![RegisteredProvider {
        connection_id: String::from("fixture-library"),
        provider_type: String::from("navidrome"),
        name: String::from("Fixture"),
        enabled: true,
        provider: Arc::new(provider),
    }]);

    tokio::spawn(async move {
        let stream_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let router = Router::new()
            .route(
                "/rest/stream.view",
                get(move |Query(params): Query<HashMap<String, String>>, headers: HeaderMap| {
                    let stream_attempts = stream_attempts.clone();
                    async move {
                    if params["id"] == "stream-error" {
                        return Json(json!({"subsonic-response": {"status": "failed", "error": {"code": 70}}})).into_response();
                    }
                    if params["id"] == "stream-retry" {
                        if headers[RANGE] == "bytes=12-" {
                            return (StatusCode::RANGE_NOT_SATISFIABLE, [(http::header::CONTENT_RANGE, "bytes */12")]).into_response();
                        }
                        assert_eq!(headers[RANGE], "bytes=4-11");
                        assert_eq!(headers[http::header::IF_RANGE], "\"fixture\"");
                        assert_eq!(headers[http::header::ACCEPT_ENCODING], "identity");
                        if stream_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                            return StatusCode::BAD_GATEWAY.into_response();
                        }
                        let chunks = tokio_stream::StreamExt::chain(
                            tokio_stream::once(Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"fLaC"))),
                            tokio_stream::pending(),
                        );
                        return (StatusCode::PARTIAL_CONTENT, [
                            (http::header::CONTENT_TYPE, "audio/flac"),
                            (http::header::CONTENT_RANGE, "bytes 4-11/12"),
                            (http::header::CONTENT_LENGTH, "8"),
                        ], Body::from_stream(chunks)).into_response();
                    }
                    ([(http::header::CONTENT_TYPE, "audio/flac")], "fLaC").into_response()
                    }
                }),
            )
            .route(
                "/rest/getArtist.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let id = &params["id"];
                    let mut artist = json!({"id": id, "name": "Fixture Artist", "album": []});
                    if id == "local-portrait" {
                        artist["coverArt"] = json!("5");
                    }
                    Json(json!({"subsonic-response": {"status": "ok", "artist": artist}}))
                }),
            )
            .route(
                "/rest/getArtistInfo2.view",
                get(|| async {
                    Json(json!({"subsonic-response": {"status": "ok", "artistInfo2": {
                        "mediumImageUrl": "https://fixture.example/artist/fixture.jpg"
                    }}}))
                }),
            )
            .route(
                "/rest/getSong.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let id = &params["id"];
                    Json(json!({"subsonic-response": {"status": "ok", "song": {
                        "id": id, "title": format!("Song {id}"), "artist": "Fixture Artist",
                        "album": "Fixture Album", "duration": 205, "coverArt": id
                    }}}))
                }),
            )
            .route(
                "/rest/getCoverArt.view",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let color = params["id"].parse().expect("fixture cover ID");
                    (
                        [(http::header::CONTENT_TYPE, "image/png")],
                        fixture_cover(color),
                    )
                }),
            );
        axum::serve(listener, router)
            .await
            .expect("serve fixture library");
    })
}

#[tokio::test]
async fn library_stream_skips_a_success_status_with_a_subsonic_error_body() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let library = LibraryService::new(db, None);
    let source = |id: &str| SourceRef {
        connection_id: "fixture-library".into(),
        provider_item_id: id.into(),
    };
    let id = library
        .ensure_id(LibraryItemType::Track, &source("stream-error"), None)
        .await
        .unwrap();
    let path = format!("/api/tracks/{id}/stream");
    assert_eq!(
        request(&state, &session, "GET", &path, None).await.status(),
        StatusCode::BAD_GATEWAY
    );

    library
        .add_source(&id, &source("stream-audio"))
        .await
        .unwrap();
    let response = request(&state, &session, "GET", &path, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(http::header::CONTENT_RANGE));
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"fLaC"
    );
    provider.abort();
}

#[tokio::test]
async fn stream_routes_distinguish_missing_tracks_and_unavailable_lookups() {
    let (db, state, session) = playback_state(false).await;
    let path = "/api/tracks/md_missing/stream";
    let status = || async { request(&state, &session, "GET", path, None).await.status() };
    assert_eq!(status().await, StatusCode::NOT_FOUND);

    sqlx::query("ALTER TABLE library_items RENAME TO unavailable_library_items")
        .execute(db.inner())
        .await
        .unwrap();
    assert_eq!(status().await, StatusCode::SERVICE_UNAVAILABLE);
}

async fn request_playback_range(
    state: &AppState,
    session: &str,
    url: &str,
    range: Option<&str>,
    if_range: Option<&str>,
) -> Response {
    let mut request = Request::builder()
        .uri(url)
        .header("cookie", format!("{SESSION_COOKIE}={session}"));
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    if let Some(if_range) = if_range {
        request = request.header(http::header::IF_RANGE, if_range);
    }
    music_routes()
        .with_state(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn playback_storage_errors_are_retryable_and_only_missing_tracks_are_404() {
    let (db, state, session) = playback_state(true).await;
    let library = LibraryService::new(db.clone(), None);
    let track = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture".into(),
                provider_item_id: "mapped-song".into(),
            },
            None,
        )
        .await
        .unwrap();
    sqlx::query("DROP TABLE library_item_sources")
        .execute(db.inner())
        .await
        .unwrap();

    for path in [
        format!("/api/tracks/{track}"),
        format!("/api/tracks/{track}/stream"),
    ] {
        let response = request(&state, &session, "GET", &path, None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[http::header::RETRY_AFTER], "1");
    }
    let missing = request(&state, &session, "GET", "/api/tracks/no-track/stream", None).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn playback_failover_requires_a_fresh_url_and_initial_byte_zero() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let (db, state, session) = playback_state(true).await;
    let primary_online = Arc::new(AtomicBool::new(true));
    let alternate_requests = Arc::new(AtomicUsize::new(0));
    let online = primary_online.clone();
    let primary = media_fixture::provider("primary", move |id, range, _, bitrate| {
        assert_eq!(id, "original");
        assert_eq!(bitrate, Some(192));
        let response = if !online.load(Ordering::Relaxed) {
            media_fixture::response(StatusCode::SERVICE_UNAVAILABLE, [], "")
        } else if range == Some("bytes=2-") {
            media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-3/4"),
                    (CONTENT_LENGTH, "2"),
                ],
                "cd",
            )
        } else {
            media_fixture::response(
                StatusCode::OK,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_LENGTH, "4")],
                "abcd",
            )
        };
        (Timeout::ZERO, response)
    });
    let requests = alternate_requests.clone();
    let alternate = media_fixture::provider("alternate", move |id, range, if_range, bitrate| {
        assert_eq!(id, "fallback");
        assert_eq!(bitrate, Some(192));
        assert!(if_range.is_none());
        requests.fetch_add(1, Ordering::Relaxed);
        let response = match range {
            Some("bytes=0-1") => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/flac"),
                    (CONTENT_RANGE, "bytes 0-1/8"),
                    (CONTENT_LENGTH, "2"),
                ],
                "AB",
            ),
            Some("bytes=5-") => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/flac"),
                    (CONTENT_RANGE, "bytes 5-7/8"),
                    (CONTENT_LENGTH, "3"),
                ],
                "FGH",
            ),
            other => panic!("unexpected alternate range: {other:?}"),
        };
        (Timeout::ZERO, response)
    });
    state.providers().replace_all(vec![primary, alternate]);
    let library = LibraryService::new(db, None);
    let id = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "primary".into(),
                provider_item_id: "original".into(),
            },
            None,
        )
        .await
        .unwrap();
    library
        .add_source(
            &id,
            &SourceRef {
                connection_id: "alternate".into(),
                provider_item_id: "fallback".into(),
            },
        )
        .await
        .unwrap();
    let old = format!("/api/tracks/{id}/stream?source=primary&maxBitRate=192&inspectionId=old&inspect=false");
    let fresh = format!(
        "/api/tracks/{id}/stream?source=primary&maxBitRate=192&inspectionId=fresh&retryFrom=old&inspect=false"
    );
    assert_eq!(
        request_playback_range(&state, &session, &old, None, None)
            .await
            .status(),
        StatusCode::OK
    );
    let range = request_playback_range(&state, &session, &old, Some("bytes=2-"), None).await;
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(range.headers()[CONTENT_TYPE], "audio/mpeg");

    primary_online.store(false, Ordering::Relaxed);
    assert_eq!(
        request_playback_range(&state, &session, &old, Some("bytes=2-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 0);
    assert_eq!(
        request_playback_range(&state, &session, &fresh, Some("bytes=2-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 0);

    // Even after the first provider recovers, a replacement prefers the alternate.
    primary_online.store(true, Ordering::Relaxed);
    let metadata =
        request_playback_range(&state, &session, &fresh, Some("bytes=0-1"), Some("\"old\"")).await;
    assert_eq!(metadata.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(metadata.headers()[CONTENT_TYPE], "audio/flac");
    assert_eq!(metadata.headers()[CONTENT_RANGE], "bytes 0-1/8");
    let seek = request_playback_range(&state, &session, &fresh, Some("bytes=5-"), None).await;
    assert_eq!(seek.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        seek.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"FGH"
    );
    assert_eq!(alternate_requests.load(Ordering::Relaxed), 2);
    assert!(state.inspector().source_descriptor("listener", &id, "old").is_none());
    assert!(state.inspector().source_descriptor("listener", &id, "fresh").is_none());
    assert_eq!(
        request_playback_range(&state, &session, old.trim_end_matches("&inspect=false"), Some("bytes=2-"), None)
            .await
            .headers()[CONTENT_TYPE],
        "audio/mpeg"
    );
    assert!(state.inspector().source_descriptor("listener", &id, "old").is_some());
}

#[tokio::test]
async fn playback_rejects_mismatched_partial_layout_and_preserves_full_responses() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG};

    let (db, state, session) = playback_state(true).await;
    state.providers().replace_all(vec![media_fixture::provider(
        "pinned",
        |_, range, if_range, _| {
            let stream = match (range, if_range) {
                (None, _) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac; codecs=flac"),
                        (ETAG, "\"original\""),
                    ],
                    "abcd",
                ),
                (Some("bytes=1-"), Some("\"original\"")) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (ETAG, "\"replacement\""),
                        (CONTENT_LENGTH, "6"),
                    ],
                    "abcdef",
                ),
                (Some("bytes=0-1"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 0-1/4"),
                        (CONTENT_LENGTH, "2"),
                        (ETAG, "\"original\""),
                    ],
                    "ab",
                ),
                (Some("bytes=1-"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-5/6"),
                        (CONTENT_LENGTH, "5"),
                    ],
                    "bcdef",
                ),
                (Some("bytes=2-"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-3/4"),
                        (CONTENT_LENGTH, "3"),
                    ],
                    "bcd",
                ),
                (Some("bytes=1-2"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (CONTENT_RANGE, "bytes 1-2/4"),
                        (CONTENT_LENGTH, "3"),
                    ],
                    "bcd",
                ),
                (Some("bytes=2-2"), _) => media_fixture::response(
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (CONTENT_TYPE, "audio/flac; codecs=opus"),
                        (CONTENT_RANGE, "bytes 2-2/4"),
                        (CONTENT_LENGTH, "1"),
                    ],
                    "c",
                ),
                (Some("bytes=3-"), _) => media_fixture::response(
                    StatusCode::OK,
                    [
                        (CONTENT_TYPE, "audio/flac"),
                        (ETAG, "\"original\""),
                        (CONTENT_LENGTH, "4"),
                    ],
                    "abcd",
                ),
                other => panic!("unexpected stream request: {other:?}"),
            };
            (Timeout::ZERO, stream)
        },
    )]);
    let id = LibraryService::new(db, None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "pinned".into(),
                provider_item_id: "track".into(),
            },
            None,
        )
        .await
        .unwrap();
    let url = format!("/api/tracks/{id}/stream?inspectionId=layout");
    assert_eq!(
        request_playback_range(&state, &session, &url, None, None)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=0-1"), None)
            .await
            .status(),
        StatusCode::PARTIAL_CONTENT
    );
    for request in ["bytes=1-", "bytes=2-", "bytes=1-2", "bytes=2-2"] {
        assert_eq!(
            request_playback_range(&state, &session, &url, Some(request), None)
                .await
                .status(),
            StatusCode::BAD_GATEWAY,
            "{request}"
        );
    }
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=0-1"), Some("\"stale\""))
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    let full = request_playback_range(
        &state,
        &session,
        &url,
        Some("bytes=1-"),
        Some("\"original\""),
    )
    .await;
    assert_eq!(full.status(), StatusCode::OK);
    assert_eq!(
        full.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"abcdef"
    );
    assert_eq!(
        request_playback_range(&state, &session, &url, Some("bytes=1-"), None)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
    let ignored_range =
        request_playback_range(&state, &session, &url, Some("bytes=3-"), None).await;
    assert_eq!(ignored_range.status(), StatusCode::OK);
    assert_eq!(
        ignored_range
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"abcd"
    );
}

#[tokio::test]
async fn playback_ranges_survive_concurrent_wal_writes() {
    use http::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, COOKIE};
    use crate::remote::RemoteClientMessage;

    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("playback.sqlite"))
        .await
        .unwrap();
    let (db, state, session) = playback_state_with_db(db, false).await;
    let provider = media_fixture::provider("media", |track, range, _, _| {
        let response = match (track, range) {
            ("normal" | "stall", None) => media_fixture::response(
                StatusCode::OK,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_LENGTH, "8")],
                "abcdefgh",
            ),
            ("normal", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-5/8"),
                    (CONTENT_LENGTH, "4"),
                ],
                "cdef",
            ),
            ("normal", Some("bytes=8-")) => media_fixture::response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(CONTENT_RANGE, "bytes */8")],
                "",
            ),
            ("mismatch", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [(CONTENT_TYPE, "audio/mpeg"), (CONTENT_RANGE, "bytes 3-6/8")],
                "defg",
            ),
            ("truncated", Some("bytes=2-5")) => media_fixture::response(
                StatusCode::PARTIAL_CONTENT,
                [
                    (CONTENT_TYPE, "audio/mpeg"),
                    (CONTENT_RANGE, "bytes 2-5/8"),
                    (CONTENT_LENGTH, "4"),
                ],
                "cd",
            ),
            _ => panic!("unexpected media fixture request"),
        };
        let header_delay = if track == "stall" {
            Timeout::from_secs(20)
        } else {
            Timeout::ZERO
        };
        (header_delay, response)
    });
    state.providers().replace_all(vec![provider]);
    let library = LibraryService::new(db.clone(), None);
    let mut tracks = HashMap::new();
    for native_id in ["normal", "mismatch", "truncated", "stall"] {
        let id = library
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: "media".into(),
                    provider_item_id: native_id.into(),
                },
                None,
            )
            .await
            .unwrap();
        tracks.insert(native_id, id);
    }
    let router = crate::create_router(state.clone());
    let cookie = format!("{SESSION_COOKIE}={session}");
    let send = |method: &str, uri: &str, payload: Option<Value>, range: Option<&str>| {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(COOKIE, &cookie);
        if payload.is_some() {
            request = request.header(CONTENT_TYPE, "application/json");
        }
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        router.clone().oneshot(
            request
                .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
    };
    let track = &tracks["normal"];
    let hub = state.remote_hub();
    let (remote, mut frames) = hub.connect_client("listener", &session, 0).unwrap();
    hub.handle_message(&remote, serde_json::from_value::<RemoteClientMessage>(json!({
        "type": "REGISTER", "device_id": "ws-device", "queue_device_id": "ws-device",
        "device_name": "Browser", "device_type": "web", "can_receive": true,
        "live_sync": true, "playback_lease": true, "playbackLeaseProtocol": 1,
        "state": {"playing": true, "position_ms": 0, "duration_ms": 180_000, "volume": 1,
            "current_track": {"id": track, "title": "Track"}}
    })).unwrap());
    assert!(std::iter::from_fn(|| frames.try_recv().ok()).any(|frame| frame["type"] == "INITIAL_STATE"));
    let (status, content) = json_response(
        send(
            "POST",
            "/api/v1/user/queue-session/content?ownerId=listener",
            Some(json!({"version": 2, "entries": [{"entryId": "entry", "track": {"id": track}}]})),
            None,
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{content}");

    let queue = |device: u8, sequence: i64| {
        json!({
            "ownerId": "listener", "deviceId": format!("device-{device}"), "deviceName": "Fixture",
            "contentId": content["contentId"], "sequence": sequence,
            "checkpoint": {"index": 0, "position": sequence, "repeatOne": false, "shuffle": false,
                "shuffleMode": "standard", "albumAware": false, "volume": 1, "wasPlaying": true,
                "capturedAt": Utc::now().timestamp_millis()},
        })
    };
    let started = Utc::now() - Duration::minutes(1);
    // Older checkpoints may have a playback session ID without usable metadata.
    sqlx::query("INSERT INTO listening_events
        (id,user_id,track_id,event_type,created_at,playback_session_id,listened_seconds,track_json)
        VALUES ('legacy-listen','listener',?,'progress',?,'playback-1',0,NULL)")
        .bind(track).bind(started.to_rfc3339()).execute(db.inner()).await.unwrap();
    let listening = |device: u8, sequence: i64| {
        let mut event = playback_event(sequence as f64, false);
        event["playbackSessionId"] = json!(format!("playback-{device}"));
        event["trackId"] = json!(track);
        event["startedAt"] = json!(started.to_rfc3339());
        event
    };
    let stream_path =
        |track: &str| format!("/api/tracks/{}/stream?inspectionId=wal-test", tracks[track]);
    let normal = stream_path("normal");
    let inspection = format!("/api/v1/stream/inspect/{track}?inspectionId=wal-test");
    let ranges = [
        (None, StatusCode::OK, None, "abcdefgh"),
        (
            Some("bytes=2-5"),
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 2-5/8"),
            "cdef",
        ),
        (
            Some("bytes=8-"),
            StatusCode::RANGE_NOT_SATISFIABLE,
            Some("bytes */8"),
            "",
        ),
    ];
    for (index, (range, status, content_range, expected)) in
        ranges.into_iter().cycle().take(9).enumerate()
    {
        let sequence = (index + 1) as i64;
        let (stream, queue_one, queue_two, listen_one, listen_two, media, inspector) = tokio::join!(
            send("GET", &normal, None, range),
            send(
                "PUT",
                "/api/v1/user/queue-session",
                Some(queue(1, sequence)),
                None
            ),
            send(
                "PUT",
                "/api/v1/user/queue-session",
                Some(queue(2, sequence)),
                None
            ),
            send(
                "POST",
                "/api/listening-events",
                Some(listening(1, sequence)),
                None
            ),
            send(
                "POST",
                "/api/listening-events",
                Some(listening(2, sequence)),
                None
            ),
            send("POST", "/api/v1/user/media-sessions", Some(json!({
                "type": "album", "mediaId": "album", "title": "Album", "trackId": track,
                "trackIndex": 0, "trackCount": 1, "positionSeconds": sequence, "durationSeconds": 180,
                "capturedAt": started.timestamp_millis() + sequence,
            })), None),
            send("GET", &inspection, None, None),
        );
        let stream = stream.unwrap();
        assert_eq!(stream.status(), status);
        assert_eq!(
            stream
                .headers()
                .get(CONTENT_RANGE)
                .map(|value| value.to_str().unwrap()),
            content_range
        );
        assert_eq!(
            stream.into_body().collect().await.unwrap().to_bytes(),
            expected
        );
        for response in [queue_one, queue_two] {
            let (status, body) = json_response(response.unwrap()).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body, json!({"saved": true, "sequence": sequence}));
        }
        for response in [listen_one, listen_two] {
            let (status, body) = json_response(response.unwrap()).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["listenedSeconds"].as_f64(), Some(sequence as f64));
        }
        let (status, body) = json_response(media.unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["checkpoint"]["positionSeconds"].as_f64(), Some(sequence as f64));
        let diagnostic = inspector.unwrap();
        assert_eq!(diagnostic.status(), StatusCode::OK);
        assert_eq!(diagnostic.headers()[http::header::CACHE_CONTROL], "private, no-store");
        let (_, diagnostic) = json_response(diagnostic).await;
        assert!(diagnostic["output"]["codec"].is_null());
        assert!(diagnostic["sourceError"].is_null());
        let notifications = std::iter::from_fn(|| frames.try_recv().ok())
            .filter(|frame| frame["type"] == "QUEUE_CHANGED").count();
        assert_eq!(notifications, 2);
    }
    let repaired: String = sqlx::query_scalar("SELECT track_json FROM listening_events WHERE id='legacy-listen'")
        .fetch_one(db.inner()).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&repaired).unwrap()["title"], "Roygbiv");
    hub.disconnect_client(&remote);

    let mismatch = send("GET", &stream_path("mismatch"), None, Some("bytes=2-5"))
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::BAD_GATEWAY);
    let truncated = send("GET", &stream_path("truncated"), None, Some("bytes=2-5"))
        .await
        .unwrap();
    assert_eq!(truncated.status(), StatusCode::PARTIAL_CONTENT);
    let mut body = truncated.into_body();
    assert_eq!(
        body.frame().await.unwrap().unwrap().into_data().unwrap(),
        "cd"
    );
    assert!(body.frame().await.unwrap().is_err());

    let stall = stream_path("stall");
    let stalled = tokio::time::timeout(Timeout::from_secs(10), send("GET", &stall, None, None))
        .await
        .expect("the resolver must time out before the fixture sends headers")
        .unwrap();
    assert_eq!(stalled.status(), StatusCode::BAD_GATEWAY);

    state.tasks().close();
    db.close().await;
}

#[tokio::test]
async fn selected_library_source_retries_gateway_failure_and_streams_a_validated_range() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let library = LibraryService::new(db, None);
    let id = library
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture-library".into(),
                provider_item_id: "stream-retry".into(),
            },
            None,
        )
        .await
        .unwrap();
    // Legacy clients send selected connection IDs in playableSource.
    let uri = format!("/api/tracks/{id}/stream?playableSource=fixture-library");
    let router = music_routes().with_state(state);
    let send_range = |range| {
        router.clone().oneshot(
            Request::builder()
                .uri(&uri)
                .header(http::header::COOKIE, format!("{SESSION_COOKIE}={session}"))
                .header(RANGE, range)
                .header(http::header::IF_RANGE, "\"fixture\"")
                .body(Body::empty())
                .unwrap(),
        )
    };

    let response = tokio::time::timeout(Timeout::from_secs(3), send_range("bytes=4-11"))
        .await
        .expect("stream header arrived while the body was still pending")
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()[http::header::CONTENT_RANGE],
        "bytes 4-11/12"
    );
    assert_eq!(response.headers()[http::header::CONTENT_LENGTH], "8");
    let first = tokio::time::timeout(Timeout::from_secs(3), response.into_body().frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert_eq!(first.as_ref(), b"fLaC");

    let response = send_range("bytes=12-").await.unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers()[http::header::CONTENT_RANGE],
        "bytes */12"
    );
    provider.abort();
}

#[tokio::test]
async fn background_normalization_returns_unavailable_without_a_playable_source() {
    let (db, state, session) = playback_state(false).await;
    let id = LibraryService::new(db, None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: "fixture-library".into(),
                provider_item_id: "stream-audio".into(),
            },
            None,
        )
        .await
        .unwrap();
    let response = crate::routes::audio_playback::audio_playback_routes()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/playback/normalize")
                .header(http::header::COOKIE, format!("{SESSION_COOKIE}={session}"))
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"trackId": id, "background": true, "targetLufs": -16}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = json_response(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "unavailable");
}

#[tokio::test]
async fn artist_portraits_use_the_library_and_respect_local_only_mode() {
    for local_only in [false, true] {
        let (db, state, session) = playback_state(local_only).await;
        let provider = add_fixture_library(&db, &state).await;
        for native_id in ["local-portrait", "extended-portrait"] {
            let artist_id = LibraryService::new(db.clone(), None)
                .ensure_id(
                    LibraryItemType::Artist,
                    &SourceRef {
                        connection_id: "fixture-library".into(),
                        provider_item_id: native_id.into(),
                    },
                    None,
                )
                .await
                .expect("map artist");
            let path = format!("/api/artists/{artist_id}/portrait");
            let (status, body) =
                json_response(request(&state, &session, "GET", &path, None).await).await;
            assert_eq!(status, StatusCode::OK);
            if native_id == "local-portrait" {
                let url = body["imageUrl"].as_str().expect("local portrait URL");
                assert!(url.starts_with("/api/artwork/mdart_"));
                assert_eq!(body["imageKind"], "artist");
                let image = request(&state, &session, "GET", url, None).await;
                assert_eq!(image.status(), StatusCode::OK);
                let bytes = image
                    .into_body()
                    .collect()
                    .await
                    .expect("image body")
                    .to_bytes();
                assert_eq!(bytes.as_ref(), fixture_cover(5));
            } else if local_only {
                assert!(body["imageUrl"].is_null());
            } else {
                assert_eq!(
                    body["imageUrl"],
                    "https://fixture.example/artist/fixture.jpg"
                );
            }
            if native_id == "extended-portrait" {
                let cached_url = "https://upload.wikimedia.org/wikipedia/commons/a/ab/fixture.jpg";
                sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
                    .bind(format!("artist_avatar_mb:{artist_id}"))
                    .bind(json!({"name": "Fixture Artist", "url": cached_url}).to_string())
                    .execute(db.inner()).await.expect("cache fixture portrait");
                let (status, body) = json_response(
                    request(
                        &state,
                        &session,
                        "GET",
                        &format!("{path}/musicbrainz"),
                        None,
                    )
                    .await,
                )
                .await;
                assert_eq!(status, StatusCode::OK);
                if local_only {
                    assert!(body["imageUrl"].is_null());
                } else {
                    assert_eq!(body["imageUrl"], cached_url);
                    assert_eq!(body["imageSource"], "musicbrainz");
                }
            }
        }
        provider.abort();
    }
}

#[tokio::test]
async fn recently_played_returns_track_details_for_recorded_and_legacy_plays() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let legacy_id = LibraryService::new(db.clone(), None)
        .ensure_id(
            LibraryItemType::Track,
            &SourceRef {
                connection_id: String::from("fixture-library"),
                provider_item_id: String::from("1"),
            },
            None,
        )
        .await
        .expect("map legacy song");
    let legacy_time = (Utc::now() - Duration::days(1)).to_rfc3339();
    add_recently_played(
        &db,
        "listener",
        &legacy_id,
        Some(&legacy_time),
        false,
        None,
        None,
    )
    .await
    .expect("store legacy song");
    let mut event = playback_event(180.0, true);
    event["track"]["coverArt"] = json!("mdart_fixture");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    let latest_play = Utc::now().to_rfc3339();
    add_recently_played(
        &db,
        "listener",
        "track-1",
        Some(&latest_play),
        false,
        None,
        None,
    )
    .await
    .expect("store duplicate play");
    add_recently_played(&db, "listener", "private-song", None, true, None, None)
        .await
        .expect("store private play");

    let (status, result) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/recently-played?tasteOnly=1",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let tracks = result["tracks"].as_array().expect("recent tracks");
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0]["id"], "track-1");
    assert_eq!(tracks[0]["title"], "Roygbiv");
    assert_eq!(tracks[0]["artist"], "Boards of Canada");
    assert_eq!(tracks[0]["coverArt"], "mdart_fixture");
    assert_eq!(tracks[0]["duration"], 180.0);
    assert_eq!(tracks[0]["playedAt"], latest_play);
    assert_eq!(tracks[1]["trackId"], legacy_id);
    assert_eq!(tracks[1]["title"], "Song 1");
    assert_eq!(tracks[1]["artistName"], "Fixture Artist");
    assert_eq!(tracks[1]["durationSeconds"], 205);
    assert!(tracks[1]["artworkId"].is_string());
    assert_eq!(tracks[1]["playedAt"], legacy_time);
    provider.abort();
}

#[tokio::test]
async fn recently_played_keeps_the_newest_recording_and_fills_past_duplicate_ids() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    event["playbackSessionId"] = json!("other-playback");
    event["trackId"] = json!("other-catalog-id");
    event["track"]["title"] = json!("ROYGBIV");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    let newest = (Utc::now() + Duration::seconds(1)).to_rfc3339();
    add_recently_played(&db, "listener", "other-catalog-id", Some(&newest), false, None, None)
        .await.unwrap();
    let older = (Utc::now() - Duration::days(1)).to_rfc3339();
    for index in 0..49 {
        let id = format!("older-{index:02}");
        add_recently_played(&db, "listener", &id, Some(&older), false, None, None).await.unwrap();
    }
    let (status, result) = json_response(request(&state, &session, "GET", "/api/recently-played?tasteOnly=1", None).await).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let tracks = result["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 50);
    assert_eq!(tracks[0]["id"], "other-catalog-id");
    assert_eq!(tracks[0]["playedAt"], newest);
    assert_eq!(tracks[49]["id"], "older-48");
    assert!(!tracks.iter().any(|track| track["id"] == "track-1"));
}

#[tokio::test]
async fn playlist_artwork_uses_the_first_four_tracks_and_keeps_custom_covers() {
    let (db, state, session) = playback_state(false).await;
    let provider = add_fixture_library(&db, &state).await;
    let (status, result) = json_response(
        request(
            &state,
            &session,
            "POST",
            "/api/playlists",
            Some(&json!({"name": "Fixture playlist"})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    let id = result["playlist"]["id"].as_str().expect("playlist ID");
    let (status, result) = json_response(
        request(
            &state,
            &session,
            "POST",
            &format!("/api/v1/playlists/{id}/tracks/batch"),
            Some(&json!({"action": "add", "trackIds": ["3", "1", "4", "2", "5"]})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let token = result["playlist"]["artworkId"]
        .as_str()
        .expect("artwork ID");
    let (status, tree) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/v1/playlist-organization",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tree["playlists"][0]["id"], id);
    assert_eq!(tree["playlists"][0]["artworkId"], token);
    let response = request(
        &state,
        &session,
        "GET",
        &format!("/api/artwork/{token}?size=64"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[http::header::CONTENT_TYPE],
        "image/svg+xml"
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("read collage")
        .to_bytes();
    let svg = std::str::from_utf8(&body).expect("SVG document");
    let expected = [3, 1, 4, 2].map(|color| {
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(fixture_cover(color))
        )
    });
    let tiles: Vec<_> = svg
        .split("href=\"")
        .skip(1)
        .map(|tile| tile.split('"').next().unwrap())
        .collect();
    assert_eq!(tiles, expected);

    let custom = fixture_cover(99);
    crate::playlists::PlaylistArtworkService::new(db)
        .set_custom(id, &custom, "image/png")
        .await
        .expect("store custom cover");
    let (status, tree) = json_response(
        request(
            &state,
            &session,
            "GET",
            "/api/v1/playlist-organization",
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let custom_token = tree["playlists"][0]["artworkId"]
        .as_str()
        .expect("custom cover ID");
    assert_ne!(custom_token, token);
    let response = request(
        &state,
        &session,
        "GET",
        &format!("/api/artwork/{custom_token}?size=64"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[http::header::CONTENT_TYPE], "image/png");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .expect("read custom artwork")
            .to_bytes(),
        custom
    );
    provider.abort();
}

async fn queue_count(db: &DbPool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM scrobble_queue")
        .fetch_one(db.inner())
        .await
        .expect("queue count")
}

#[tokio::test]
async fn completed_playback_enqueues_one_canonical_listen_per_provider_and_retries_deduplicate() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    let (status, recorded) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
    event["track"]["title"] = json!("Changed retry metadata");
    event["durationSeconds"] = Value::Null;
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
    let rows =
        sqlx::query("SELECT user_id, listening_event_id, payload_json, state FROM scrobble_queue")
            .fetch_all(db.inner())
            .await
            .expect("queued listens");
    for row in rows {
        assert_eq!(row.get::<String, _>("user_id"), "listener");
        assert_eq!(
            row.get::<String, _>("listening_event_id"),
            recorded["id"].as_str().expect("event ID")
        );
        assert_eq!(row.get::<String, _>("state"), "pending");
        let payload: Value =
            serde_json::from_str(&row.get::<String, _>("payload_json")).expect("listen payload");
        assert_eq!(payload["track"], "Roygbiv");
        assert_eq!(payload["artist"], "Boards of Canada");
        assert_eq!(payload["duration"], 180);
    }
}

#[tokio::test]
async fn later_progress_enqueues_after_the_provider_threshold_even_after_initial_scrobble_point() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(20.0, false);
    let (status, first) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["scrobbleDue"], true);
    assert_eq!(queue_count(&db).await, 0);
    event["listenedSeconds"] = json!(90.0);
    let (status, later) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(later["scrobbleDue"], false);
    assert_eq!(later["id"], first["id"]);
    assert_eq!(queue_count(&db).await, 2);
}

#[tokio::test]
async fn reported_seconds_are_clamped_before_scrobble_qualification() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    event["startedAt"] = json!(Utc::now().to_rfc3339());
    let (status, outcome) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        outcome["listenedSeconds"]
            .as_f64()
            .expect("listened seconds")
            < 90.0
    );
    assert_eq!(queue_count(&db).await, 0);
}

#[tokio::test]
async fn listening_event_round_trips_browser_reports_and_ignores_stale_progress() {
    let (db, state, session) = playback_state(true).await;
    let mut event = playback_event(90.0, false);
    let started = Utc::now() - Duration::minutes(1);
    event["startedAt"] = json!(started.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    event["reportedAt"] = json!((started + Duration::milliseconds(12_500))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    event["clientName"] = json!("MusicDeck Web");
    event["playlistId"] = json!("playlist-fixture");
    event["privateListening"] = json!(false);
    event["excludeFromTaste"] = json!(true);
    event["track"]["coverArt"] = Value::Null;
    event["track"]["artistId"] = json!("artist-fixture");
    let (status, progress) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(progress["listenedSeconds"], 12.5);
    assert_eq!(progress["counted"], false);
    assert_eq!(progress["tasteExcluded"], true);

    event["reportedAt"] = json!((started + Duration::seconds(45)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    event["listenedSeconds"] = json!(40.0);
    event["finished"] = json!(true);
    let (status, finish) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(finish["id"], progress["id"]);
    assert_eq!(finish["newlyCounted"], true);

    event["durationSeconds"] = Value::Null;
    event["listenedSeconds"] = json!(10.0);
    event["finished"] = json!(false);
    let (status, stale) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stale["listenedSeconds"], 40.0);
    assert_eq!(stale["newlyCounted"], false);
    let row = sqlx::query("SELECT track_id, event_type, finished, duration_seconds, context_playlist_id, client_name FROM listening_events")
        .fetch_one(db.inner()).await.unwrap();
    assert_eq!(row.get::<String, _>("track_id"), "track-1");
    assert_eq!(row.get::<String, _>("event_type"), "complete");
    assert_eq!(row.get::<i64, _>("finished"), 1);
    assert_eq!(row.get::<f64, _>("duration_seconds"), 180.0);
    assert_eq!(row.get::<String, _>("context_playlist_id"), "playlist-fixture");
    assert_eq!(row.get::<String, _>("client_name"), "MusicDeck Web");

    event["trackId"] = json!("other-track");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn listening_event_writer_returns_retryable_response_until_sqlite_unlocks() {
    let directory = tempfile::tempdir().unwrap();
    let db = DbPool::connect(&directory.path().join("listening.sqlite")).await.unwrap();
    let (db, state, session) = playback_state_with_db(db, false).await;
    let mut writer = db.inner().begin().await.unwrap();
    sqlx::query("UPDATE queue_sessions SET sequence = sequence WHERE 0")
        .execute(&mut *writer).await.unwrap();
    let event = playback_event(120.0, true);
    let response = tokio::time::timeout(Timeout::from_secs(4),
        request(&state, &session, "POST", "/api/listening-events", Some(&event))).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[http::header::RETRY_AFTER], "1");
    assert_eq!(queue_count(&db).await, 0);
    writer.rollback().await.unwrap();

    let (status, saved) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["newlyCounted"], true);
    let (status, retry) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["id"], saved["id"]);
    assert_eq!(retry["newlyCounted"], false);
    assert_eq!(queue_count(&db).await, 2);
}

#[tokio::test]
async fn provider_specific_rules_and_disabled_integrations_are_preserved() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(30.0, true);
    event["durationSeconds"] = json!(30.0);
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    let providers: Vec<String> = sqlx::query_scalar("SELECT provider FROM scrobble_queue")
        .fetch_all(db.inner())
        .await
        .expect("provider names");
    assert_eq!(providers, vec![String::from("listenbrainz")]);
    sqlx::query("UPDATE plugin_configs SET enabled = 0")
        .execute(db.inner())
        .await
        .expect("disable plugins");
    event["playbackSessionId"] = json!("playback-session-2");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 1);
}

#[tokio::test]
async fn local_only_preserves_local_history_and_blocks_external_queueing() {
    let (db, state, session) = playback_state(true).await;
    assert_eq!(
        report(&state, &session, &playback_event(180.0, true))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(queue_count(&db).await, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listening_events")
        .fetch_one(db.inner())
        .await
        .expect("listening events");
    assert_eq!(count, 1);
}

#[tokio::test]
async fn playback_owner_mismatch_is_rejected_before_recording_or_queueing() {
    let (db, state, session) = playback_state(false).await;
    let mut event = playback_event(180.0, true);
    event["ownerUserId"] = json!("another-user");
    let (status, error) = report(&state, &session, &event).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["error"]["code"], "USER_MISMATCH");
    assert_eq!(queue_count(&db).await, 0);
}

#[tokio::test]
async fn outbox_failure_rolls_back_the_listen_and_both_provider_jobs_before_retry() {
    let (db, state, session) = playback_state(false).await;
    sqlx::raw_sql(
        "CREATE TRIGGER reject_scrobble BEFORE INSERT ON scrobble_queue
        WHEN NEW.provider = 'listenbrainz' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
    )
    .execute(db.inner())
    .await
    .expect("install write failure");
    let event = playback_event(180.0, true);
    assert_eq!(
        report(&state, &session, &event).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(queue_count(&db).await, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listening_events")
        .fetch_one(db.inner())
        .await
        .expect("listening events");
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER reject_scrobble")
        .execute(db.inner())
        .await
        .expect("restore writes");
    assert_eq!(report(&state, &session, &event).await.0, StatusCode::OK);
    assert_eq!(queue_count(&db).await, 2);
}

#[tokio::test]
async fn background_worker_processes_pending_listens_and_shuts_down_without_network_calls() {
    let (db, state, session) = playback_state(false).await;
    sqlx::query("UPDATE plugin_configs SET enabled = 0 WHERE plugin_id = 'lastfm'")
        .execute(db.inner())
        .await
        .expect("enable only ListenBrainz");
    assert_eq!(
        report(&state, &session, &playback_event(180.0, true))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(queue_count(&db).await, 1);
    // Empty fixture credentials fail validation before an HTTP request can be sent.
    let queue = state.scrobble_queue();
    let worker = queue.start_worker().expect("start worker");
    assert!(queue.start_worker().is_none());
    let processed = tokio::time::timeout(Timeout::from_secs(5), async {
        loop {
            let status: String = sqlx::query_scalar("SELECT state FROM scrobble_queue")
                .fetch_one(db.inner())
                .await
                .expect("delivery status");
            if status == "blocked" {
                break;
            }
            tokio::time::sleep(Timeout::from_millis(10)).await;
        }
    })
    .await;
    queue.close();
    tokio::time::timeout(Timeout::from_secs(5), worker)
        .await
        .expect("shutdown deadline")
        .expect("worker exited");
    processed.expect("worker processed pending listen");
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM scrobble_queue")
        .fetch_one(db.inner())
        .await
        .expect("delivery attempts");
    assert_eq!(attempts, 1);
    assert!(queue.start_worker().is_none());
}
