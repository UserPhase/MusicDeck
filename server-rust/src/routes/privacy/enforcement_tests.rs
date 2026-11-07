use super::*;
use crate::auth::SESSION_COOKIE;
use crate::db::{DbPool, run_migrations};
use crate::{AppConfig, AppState, create_router};
use http::Request;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tower::ServiceExt;

async fn fixture() -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO roles VALUES ('admin', 'Administrator');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('admin', 'admin', 'unused', 'Admin', 'admin', '2026-01-01', '2026-01-01');",
    )
    .execute(db.inner())
    .await
    .unwrap();
    let mut config = AppConfig::default();
    config.database.database_path = ":memory:".into();
    let state = AppState::with_database(config, db.clone()).await.unwrap();
    let session = state
        .session_store()
        .unwrap()
        .create_session("admin", true)
        .await
        .unwrap();
    (db, state, format!("{SESSION_COOKIE}={}", session.id))
}

fn request(method: Method, path: &str, cookie: &str, payload: Option<Value>) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap()
}

#[tokio::test]
async fn local_only_guards_external_subroutes_and_encoded_queries_before_handlers() {
    let (db, state, cookie) = fixture().await;
    state
        .privacy()
        .update(PrivacySettings {
            local_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let router = Router::new()
        .fallback(move || {
            let calls = handler_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }
        })
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            privacy_guard_middleware,
        ));
    for path in [
        "/api/albums/external_deezer_album_1/tracks",
        "/api/artists/external_deezer_artist_1/albums",
        "/api/artists/extdetail_artist_1/tracks",
        "/api/artists/external_itunes_artist_1/top-tracks",
        "/api/artists/deezer_artist_1/albums",
        "/api/search?%6Dode=%65xternal",
        "/api/v1/new-releases/scan",
        "/api/v1/scrobble/listenbrainz/test",
    ] {
        let method = if path.ends_with("/scan") || path.ends_with("/test") {
            Method::POST
        } else {
            Method::GET
        };
        let response = router
            .clone()
            .oneshot(request(method, path, &cookie, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        router
            .oneshot(request(
                Method::GET,
                "/api/albums/local-album/tracks",
                &cookie,
                None
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Route handlers themselves also defend callers that mount them without global middleware.
    let response = crate::routes::music_routes()
        .with_state(state)
        .oneshot(request(
            Method::GET,
            "/api/albums/external_deezer_album_1/tracks",
            &cookie,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    db.close().await;
}

#[tokio::test]
async fn runtime_transition_cancels_active_handlers_before_waiting_for_readers() {
    let (db, state, cookie) = fixture().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let router = Router::new()
        .route(
            "/api/external/held",
            get(move || {
                let signal = signal.clone();
                async move {
                    signal.notify_one();
                    std::future::pending::<StatusCode>().await
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            privacy_guard_middleware,
        ));
    let running =
        tokio::spawn(router.oneshot(request(Method::GET, "/api/external/held", &cookie, None)));
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    let transition = tokio::time::timeout(Duration::from_secs(2), state.begin_runtime_update())
        .await
        .unwrap();
    assert_eq!(
        running.await.unwrap().unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert!(!state.privacy().snapshot().effective.external);
    transition.complete();
    assert!(state.privacy().snapshot().effective.external);
    db.close().await;
}

fn configuration() -> Value {
    json!({"backend":"jellyfin", "jellyfin":{"url":"http://jellyfin.internal:8096", "apiKey":"fixture-key"}})
}

#[tokio::test]
async fn failed_refresh_blocks_traffic_and_retry_rehydrates_shared_policy_and_providers() {
    let (db, state, cookie) = fixture().await;
    let existing = state.privacy().clone();
    sqlx::query("INSERT INTO server_settings (key, value, updated_at) VALUES ('privacy.policy', 'invalid JSON', '2026-01-01')")
        .execute(db.inner()).await.unwrap();
    let router = create_router(state.clone());
    let failed = router
        .clone()
        .oneshot(request(
            Method::POST,
            "/api/v1/admin/system/configuration",
            &cookie,
            Some(configuration()),
        ))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!state.runtime_ready());
    assert!(!existing.snapshot().effective.external);
    assert_eq!(
        router
            .clone()
            .oneshot(request(Method::GET, "/api/albums", &cookie, None))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let policy = PrivacySettings {
        local_only: true,
        ..Default::default()
    };
    sqlx::query("UPDATE server_settings SET value = ? WHERE key = 'privacy.policy'")
        .bind(serde_json::to_string(&policy).unwrap())
        .execute(db.inner())
        .await
        .unwrap();
    let success = router
        .oneshot(request(
            Method::POST,
            "/api/v1/admin/system/configuration",
            &cookie,
            Some(configuration()),
        ))
        .await
        .unwrap();
    assert_eq!(success.status(), StatusCode::ACCEPTED);
    assert!(state.runtime_ready());
    assert!(existing.snapshot().local_only);
    assert!(!existing.snapshot().effective.external);
    assert_eq!(
        state.providers().get_primary().unwrap().provider_type,
        "jellyfin"
    );
    assert!(
        existing.is_library_url(&url::Url::parse("http://jellyfin.internal:8096/Items").unwrap())
    );
    assert!(!existing.is_library_url(&url::Url::parse("http://localhost:4533/rest").unwrap()));
    db.close().await;
}

#[tokio::test]
async fn configuration_database_failure_rolls_back_changes_and_never_reports_success() {
    let (db, state, cookie) = fixture().await;
    sqlx::raw_sql("CREATE TRIGGER reject_backend BEFORE INSERT ON backend_connections BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
        .execute(db.inner()).await.unwrap();
    let response = create_router(state.clone())
        .oneshot(request(
            Method::POST,
            "/api/v1/admin/system/configuration",
            &cookie,
            Some(configuration()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM server_settings WHERE key LIKE 'setup.%'")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert!(!state.runtime_ready());
    assert!(!state.privacy().snapshot().effective.external);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(!String::from_utf8_lossy(&bytes).contains("fixture"));
    db.close().await;
}

#[tokio::test]
async fn waiting_policy_mutation_rechecks_session_after_restore_revocation() {
    let (db, state, cookie) = fixture().await;
    let held = state.privacy_update_lock().await;
    let authenticated = Arc::new(tokio::sync::Notify::new());
    let signal = authenticated.clone();
    let app = Router::new()
        .route(
            "/mutation",
            axum::routing::post(move |State(state): State<AppState>, admin: RequireAdmin| {
                let signal = signal.clone();
                async move {
                    signal.notify_one();
                    patch_privacy_policy(
                        State(state),
                        admin,
                        Ok(Json(PrivacySettings {
                            local_only: true,
                            ..Default::default()
                        })),
                    )
                    .await
                }
            }),
        )
        .with_state(state.clone());
    let pending = tokio::spawn(app.oneshot(request(Method::POST, "/mutation", &cookie, None)));
    tokio::time::timeout(Duration::from_secs(2), authenticated.notified())
        .await
        .unwrap();
    sqlx::query("DELETE FROM sessions")
        .execute(db.inner())
        .await
        .unwrap();
    drop(held);
    assert_eq!(
        pending.await.unwrap().unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(!state.privacy().snapshot().local_only);
    db.close().await;
}

#[tokio::test]
async fn invalid_restore_cannot_reopen_a_previously_failed_runtime() {
    let (db, state, cookie) = fixture().await;
    drop(state.begin_runtime_update().await);
    assert!(!state.runtime_ready());
    let response = create_router(state.clone())
        .oneshot(request(
            Method::POST,
            "/api/v1/admin/system/restore",
            &cookie,
            Some(json!({"invalid":"backup"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT); // in-memory recovery is unsupported
    assert!(!state.runtime_ready());
    assert!(!state.privacy().snapshot().effective.external);
    db.close().await;
}
