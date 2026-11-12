use super::*;
use crate::auth::SESSION_COOKIE;
use crate::catalog::{LibraryItemType, SourceRef};
use crate::config::{AppConfig, NavidromeConfig};
use crate::db::run_migrations;
use crate::providers::{NavidromeClient, RegisteredProvider};
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
        .merge(playlist_routes())
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
        let router = Router::new()
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
    let response = request(
        &state,
        &session,
        "GET",
        &format!("/api/playlists/{id}/artwork"),
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
