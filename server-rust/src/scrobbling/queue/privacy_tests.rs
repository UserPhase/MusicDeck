use super::*;
use crate::db::run_migrations;
use crate::services::listening_activity::{PlaybackEventInput, record_playback_with_scrobbles};
use crate::services::privacy::PrivacySettings;
use std::sync::atomic::AtomicUsize;
use tokio::time::timeout;

async fn fixture() -> (DbPool, PrivacyManager, ScrobbleQueueService) {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    sqlx::raw_sql(r#"
        INSERT INTO roles VALUES ('user', 'Listener');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
          VALUES ('listener', 'listener', 'unused', 'Listener', 'user', '2026-01-01', '2026-01-01');
        INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
          VALUES ('listenbrainz', 1, '{}', '["history.read","network.request"]', '2026-01-01');
        INSERT INTO scrobble_connections (user_id, provider, credentials_json, username, account_key, generation, connected_at, updated_at)
          VALUES ('listener', 'listenbrainz', '{"token":"fixture-token"}', 'listener', 'account', 'generation', 0, 0);
    "#).execute(db.inner()).await.unwrap();
    let privacy = PrivacyManager::from_database(db.clone(), &crate::AppConfig::default())
        .await
        .unwrap();
    let queue = ScrobbleQueueService::new(Some(db.clone()), privacy.clone());
    for number in 0..2 {
        let event: PlaybackEventInput = serde_json::from_value(json!({
            "playbackSessionId": format!("session-{number}"), "trackId": format!("track-{number}"),
            "startedAt": (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339(),
            "listenedSeconds": 120, "durationSeconds": 180, "finished": true,
            "track": {"title": format!("Track {number}"), "artist": "Artist", "album": "Album"}
        }))
        .unwrap();
        record_playback_with_scrobbles(&db, "listener", &event, Some(&queue))
            .await
            .unwrap();
    }
    (db, privacy, queue)
}

async fn states(db: &DbPool) -> Vec<String> {
    sqlx::query_scalar("SELECT state FROM scrobble_queue ORDER BY id")
        .fetch_all(db.inner())
        .await
        .unwrap()
}

#[tokio::test]
async fn restriction_transaction_cancels_pending_jobs_and_reenable_never_replays_them() {
    let (db, privacy, queue) = fixture().await;
    assert_eq!(states(&db).await, vec!["pending", "pending"]);
    privacy
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(states(&db).await, vec!["cancelled", "cancelled"]);
    privacy.update(PrivacySettings::default()).await.unwrap();
    assert!(queue.claim_next_job().await.is_none());
    db.close().await;
}

#[tokio::test]
async fn queue_flush_failure_rolls_back_both_policy_and_cancellations() {
    let (db, privacy, _) = fixture().await;
    sqlx::raw_sql("CREATE TRIGGER reject_cancel BEFORE UPDATE ON scrobble_queue BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
        .execute(db.inner()).await.unwrap();
    assert!(
        privacy
            .update(PrivacySettings {
                local_only: true,
                ..Default::default()
            })
            .await
            .is_err()
    );
    assert!(!privacy.snapshot().local_only);
    assert_eq!(states(&db).await, vec!["pending", "pending"]);
    let policies: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM server_settings WHERE key = 'privacy.policy'")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!(policies, 0);
    db.close().await;
}

#[tokio::test]
async fn confirmed_success_stays_sent_when_policy_changes_before_bookkeeping() {
    let (db, _, mut queue) = fixture().await;
    // Isolate finalization from the transactional cancellation to exercise the old bug.
    queue.privacy = PrivacyManager::default();
    let job = queue.claim_next_job().await.unwrap();
    let id = job.id.clone();
    queue
        .privacy
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    queue.finish_delivery(job, Ok(())).await;
    let state: String = sqlx::query_scalar("SELECT state FROM scrobble_queue WHERE id = ?")
        .bind(id)
        .fetch_one(db.inner())
        .await
        .unwrap();
    assert_eq!(state, "sent");
    queue.drain().await;
    assert!(
        states(&db)
            .await
            .iter()
            .all(|state| state == "sent" || state == "cancelled")
    );
    db.close().await;
}

#[derive(Clone, Default)]
struct FakeProvider {
    started: Arc<Notify>,
    respond: Arc<Notify>,
    calls: Arc<AtomicUsize>,
}

async fn submit(
    axum::extract::State(provider): axum::extract::State<FakeProvider>,
) -> axum::Json<Value> {
    provider.calls.fetch_add(1, Ordering::SeqCst);
    provider.started.notify_one();
    provider.respond.notified().await;
    axum::Json(json!({"status": "ok"}))
}

#[tokio::test]
async fn policy_toggle_drops_in_flight_http_submission_and_flushes_other_jobs() {
    let (db, privacy, mut queue) = fixture().await;
    let provider = FakeProvider::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    queue.listenbrainz_endpoint = Some(format!("http://{}/1", listener.local_addr().unwrap()));
    let app = axum::Router::new()
        .route("/1/submit-listens", axum::routing::post(submit))
        .with_state(provider.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let worker = queue.start_worker().unwrap();
    timeout(Duration::from_secs(5), provider.started.notified())
        .await
        .unwrap();
    privacy
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    // The provider has not replied: drain can finish only if the request was dropped.
    timeout(Duration::from_secs(2), async {
        while queue.draining.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(states(&db).await, vec!["cancelled", "cancelled"]);
    privacy.update(PrivacySettings::default()).await.unwrap();
    provider.respond.notify_waiters();
    queue.kick();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(states(&db).await, vec!["cancelled", "cancelled"]);
    queue.close();
    timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap();
    server.abort();
    let _ = server.await;
    db.close().await;
}
