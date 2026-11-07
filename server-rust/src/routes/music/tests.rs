use super::*;
use crate::auth::SESSION_COOKIE;
use crate::config::AppConfig;
use crate::db::run_migrations;
use axum::body::Body;
use chrono::{Duration, Utc};
use http::Request;
use http_body_util::BodyExt;
use sqlx::Row;
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
    let response = music_routes()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/listening-events")
                .header("content-type", "application/json")
                .header("cookie", format!("{SESSION_COOKIE}={session}"))
                .body(Body::from(event.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
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
