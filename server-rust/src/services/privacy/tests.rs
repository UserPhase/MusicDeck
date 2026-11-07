use std::future::Future;
use std::task::Poll;
use std::time::Duration;

use axum::body::Body;
use http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::auth::SESSION_COOKIE;
use crate::db::{DbPool, run_migrations};
use crate::routes::privacy_routes;
use crate::services::privacy::{
    PRIVACY_POLICY_SETTING_KEY, PrivacyCategory, PrivacyError, PrivacyManager, PrivacySettings,
};
use crate::{AppConfig, AppState};

async fn prepare_database(db: &DbPool) {
    run_migrations(db, None).await.expect("run migrations");
    sqlx::raw_sql(
        "INSERT INTO roles (name, description) VALUES ('admin', 'Administrator');
         INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
         VALUES ('privacy-admin', 'admin', 'unused', 'Admin', 'admin',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
    )
    .execute(db.inner())
    .await
    .expect("seed administrator");
}

async fn memory_state() -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.expect("open database");
    prepare_database(&db).await;
    let mut config = AppConfig::default();
    config.database.database_path = String::from(":memory:");
    let state = AppState::with_database(config, db.clone())
        .await
        .expect("initialize state");
    let session = state
        .session_store()
        .expect("session store")
        .create_session("privacy-admin", true)
        .await
        .expect("create session");
    (db, state, session.id)
}

async fn privacy_request(
    state: &AppState,
    session_id: &str,
    method: Method,
    payload: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri("/api/v1/privacy")
        .header(header::COOKIE, format!("{SESSION_COOKIE}={session_id}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .expect("build request");
    let response = privacy_routes()
        .with_state(state.clone())
        .oneshot(request)
        .await
        .expect("serve request");
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

async fn stored_policy(db: &DbPool) -> PrivacySettings {
    let json: String = sqlx::query_scalar("SELECT value FROM server_settings WHERE key = ?")
        .bind(PRIVACY_POLICY_SETTING_KEY)
        .fetch_one(db.inner())
        .await
        .expect("read saved policy");
    serde_json::from_str(&json).expect("decode saved policy")
}

#[tokio::test]
async fn api_policy_survives_database_close_and_application_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("musicdeck.sqlite");
    let db = DbPool::connect(&path).await.expect("open database");
    prepare_database(&db).await;
    let mut config = AppConfig::default();
    config.database.database_path = path.to_string_lossy().into_owned();
    let state = AppState::with_database(config.clone(), db.clone())
        .await
        .expect("initialize state");
    let session = state
        .session_store()
        .expect("session store")
        .create_session("privacy-admin", true)
        .await
        .expect("create session");
    let next = PrivacySettings {
        local_only: true,
        ..PrivacySettings::default()
    };
    let (status, saved) = privacy_request(
        &state,
        &session.id,
        Method::PATCH,
        Some(serde_json::to_value(next).expect("encode policy")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored_policy(&db).await, next);
    assert!(
        !state
            .privacy()
            .is_external_allowed(PrivacyCategory::External)
    );
    drop(state);
    db.close().await;
    drop(db);

    let reopened = DbPool::connect(&path).await.expect("reopen database");
    let restarted = AppState::with_database(config, reopened.clone())
        .await
        .expect("restart application");
    let (status, restored) = privacy_request(&restarted, &session.id, Method::GET, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored, saved);
    assert!(
        !restarted
            .privacy()
            .is_external_allowed(PrivacyCategory::External)
    );
    assert!(restarted.privacy().is_library_url(
        &url::Url::parse("http://localhost:4533/rest/ping.view").expect("library URL")
    ));
    drop(restarted);
    reopened.close().await;
}

#[tokio::test]
async fn startup_rejects_corrupt_stored_policy() {
    let db = DbPool::connect_memory().await.expect("open database");
    prepare_database(&db).await;
    sqlx::query("INSERT INTO server_settings (key, value, updated_at) VALUES (?, 'invalid-json', '2026-01-01')")
        .bind(PRIVACY_POLICY_SETTING_KEY).execute(db.inner()).await.expect("store invalid policy");
    let error = AppState::with_database(AppConfig::default(), db)
        .await
        .expect_err("reject corrupt policy");
    assert!(matches!(error, PrivacyError::CorruptStoredPolicy(_)));
}

#[tokio::test]
async fn update_publishes_without_subscribers_and_reaches_late_subscribers() {
    let manager = PrivacyManager::default();
    assert!(manager.policy_tx.is_closed());
    let next = PrivacySettings {
        local_only: true,
        ..PrivacySettings::default()
    };
    let published = manager
        .update(next)
        .await
        .expect("update without subscribers");
    assert_eq!(manager.snapshot(), published);
    assert!(manager.snapshot().local_only);
    assert!(manager.policy_tx.is_closed());
    assert_eq!(*manager.subscribe().borrow(), published);
    assert!(!manager.is_external_allowed(PrivacyCategory::External));
}

#[tokio::test]
async fn committed_policy_notifies_existing_subscribers() {
    let (db, state, _) = memory_state().await;
    let mut receiver = state.privacy().subscribe();
    let next = PrivacySettings {
        allow_imports: false,
        ..PrivacySettings::default()
    };
    let published = state.privacy().update(next).await.expect("update policy");
    tokio::time::timeout(Duration::from_secs(5), receiver.changed())
        .await
        .expect("notification deadline")
        .expect("policy notification");
    assert_eq!(*receiver.borrow_and_update(), published);
    assert_eq!(stored_policy(&db).await, next);
    assert!(
        !state
            .privacy()
            .is_external_allowed(PrivacyCategory::External)
    );
}

#[tokio::test]
async fn database_failure_returns_http_500_and_preserves_policy_and_notifications() {
    let (db, state, session_id) = memory_state().await;
    state
        .privacy()
        .update(PrivacySettings::default())
        .await
        .expect("save initial policy");
    let before = state.privacy().snapshot();
    let receiver = state.privacy().subscribe();
    sqlx::raw_sql(
        "CREATE TRIGGER reject_privacy_update BEFORE UPDATE ON server_settings
         WHEN NEW.key = 'privacy.policy'
         BEGIN SELECT RAISE(ABORT, 'private database failure details'); END;",
    )
    .execute(db.inner())
    .await
    .expect("install failing write trigger");
    let next = PrivacySettings {
        local_only: true,
        ..PrivacySettings::default()
    };
    let (status, error) = privacy_request(
        &state,
        &session_id,
        Method::PATCH,
        Some(serde_json::to_value(next).expect("encode policy")),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error["error"]["code"], "INTERNAL_SERVER_ERROR");
    assert!(
        !error
            .to_string()
            .contains("private database failure details")
    );
    assert_eq!(stored_policy(&db).await, PrivacySettings::default());
    assert_eq!(state.privacy().snapshot(), before);
    assert!(!receiver.has_changed().expect("open watch channel"));
}

#[tokio::test]
async fn invalid_policy_returns_http_400_without_changing_state() {
    let (db, state, session_id) = memory_state().await;
    let before = state.privacy().snapshot();
    let (status, error) = privacy_request(
        &state,
        &session_id,
        Method::PATCH,
        Some(json!({ "localOnly": "true" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "VALIDATION_ERROR");
    assert_eq!(state.privacy().snapshot(), before);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_settings WHERE key = ?")
        .bind(PRIVACY_POLICY_SETTING_KEY)
        .fetch_one(db.inner())
        .await
        .expect("query policy count");
    assert_eq!(count, 0);
}

#[tokio::test]
async fn environment_lock_overrides_persisted_and_updated_permissions() {
    let db = DbPool::connect_memory().await.expect("open database");
    prepare_database(&db).await;
    let mut config = AppConfig::default();
    config.network.local_only_mode = true;
    let state = AppState::with_database(config, db.clone())
        .await
        .expect("initialize state");
    let published = state
        .privacy()
        .update(PrivacySettings::default())
        .await
        .expect("save policy");
    assert!(published.enforced_by_environment);
    assert!(!published.local_only);
    assert!(!published.effective.external);
    assert!(!published.effective.metadata);
    assert_eq!(stored_policy(&db).await, PrivacySettings::default());
}

#[tokio::test]
async fn concurrent_updates_leave_database_and_shared_snapshot_consistent() {
    let (db, state, _) = memory_state().await;
    let mut updates = tokio::task::JoinSet::new();
    for index in 0..16 {
        let manager = state.privacy().clone();
        updates.spawn(async move {
            manager
                .update(PrivacySettings {
                    local_only: index % 2 == 0,
                    allow_metadata: index % 3 == 0,
                    allow_imports: index % 4 == 0,
                    allow_artwork: index % 5 == 0,
                })
                .await
                .expect("concurrent policy update")
        });
    }
    while let Some(result) = updates.join_next().await {
        result.expect("update task completed");
    }
    let stored = stored_policy(&db).await;
    let snapshot = state.privacy().snapshot();
    assert_eq!(snapshot.local_only, stored.local_only);
    assert_eq!(snapshot.allow_metadata, stored.allow_metadata);
    assert_eq!(snapshot.allow_imports, stored.allow_imports);
    assert_eq!(snapshot.allow_artwork, stored.allow_artwork);
    assert_eq!(*state.privacy().subscribe().borrow(), snapshot);
}

#[tokio::test]
async fn cancelled_request_finishes_persistence_and_publication() {
    let (db, state, _) = memory_state().await;
    let mut receiver = state.privacy().subscribe();
    // Occupy the only SQLite connection until the caller drops its update future.
    let transaction = db.inner().begin().await.expect("hold database connection");
    let next = PrivacySettings {
        local_only: true,
        ..PrivacySettings::default()
    };
    let mut update = Box::pin(state.privacy().update(next));
    futures_util::future::poll_fn(|context| {
        assert!(update.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(update);
    transaction.rollback().await.expect("release connection");
    tokio::time::timeout(Duration::from_secs(5), receiver.changed())
        .await
        .expect("notification deadline")
        .expect("policy notification");
    assert!(receiver.borrow_and_update().local_only);
    assert_eq!(stored_policy(&db).await, next);
    assert!(state.privacy().snapshot().local_only);
}

#[tokio::test]
async fn restriction_cancels_existing_permits_even_when_immediately_reenabled() {
    let manager = PrivacyManager::default();
    let permit = manager.outbound_permit(PrivacyCategory::External).unwrap();
    manager
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    manager.update(PrivacySettings::default()).await.unwrap();
    assert!(permit.is_cancelled());
    assert!(
        !manager
            .outbound_permit(PrivacyCategory::External)
            .unwrap()
            .is_cancelled()
    );
}

#[tokio::test]
async fn blocked_work_is_never_polled_and_active_work_is_dropped() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let manager = PrivacyManager::default();
    let started = Arc::new(tokio::sync::Notify::new());
    let finished = Arc::new(AtomicBool::new(false));
    let work = {
        let manager = manager.clone();
        let started = started.clone();
        let finished = finished.clone();
        tokio::spawn(async move {
            manager
                .run_external(PrivacyCategory::Metadata, async {
                    started.notify_one();
                    std::future::pending::<()>().await;
                    finished.store(true, Ordering::SeqCst);
                })
                .await
        })
    };
    started.notified().await;
    manager
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), work)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(!finished.load(Ordering::SeqCst));
    assert!(
        manager
            .run_external(PrivacyCategory::Metadata, async {
                panic!("blocked work was polled")
            })
            .await
            .is_err()
    );
}
