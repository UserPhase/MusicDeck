use super::*;
use crate::auth::SESSION_COOKIE;
use crate::config::durable_json;
use crate::db::{DbPool, run_migrations};
use crate::{AppConfig, AppState, create_router};
use axum::body::Body;
use http::{Method, Request, StatusCode};
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;

struct Fixture {
    _temp: tempfile::TempDir,
    db: DbPool,
    state: AppState,
    paths: SystemRecoveryPaths,
    cookie: String,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.database.database_path = temp
            .path()
            .join("musicdeck.sqlite")
            .to_string_lossy()
            .into_owned();
        config.navidrome.url = "http://navidrome.internal:4533".into();
        config.navidrome.username = "service".into();
        config.navidrome.password = "fixture-password".into();
        config.music_root = temp.path().join("music").to_string_lossy().into_owned();
        config.acquisition_tmp_dir = temp
            .path()
            .join("acquisitions")
            .to_string_lossy()
            .into_owned();
        config.setup_required = false;
        let paths = SystemRecoveryPaths::from_database_path(config.database_path());
        let db = DbPool::connect_file(config.database_path(), false)
            .await
            .unwrap();
        run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql("INSERT INTO roles VALUES ('admin', 'Administrator');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('admin', 'admin', 'unused', 'Original admin', 'admin', '2026-01-01', '2026-01-01');")
            .execute(db.inner()).await.unwrap();
        durable_json(&paths.configuration, &config.configuration_snapshot()).unwrap();
        tokio::fs::create_dir_all(paths.artwork.join("albums"))
            .await
            .unwrap();
        tokio::fs::write(
            paths.artwork.join("albums/cover.webp"),
            b"artwork in backup",
        )
        .await
        .unwrap();
        let state = AppState::with_database(config, db.clone()).await.unwrap();
        let session = state
            .session_store()
            .unwrap()
            .create_session("admin", true)
            .await
            .unwrap();
        Self {
            _temp: temp,
            db,
            state,
            paths,
            cookie: format!("{SESSION_COOKIE}={}", session.id),
        }
    }
    async fn archive(&self) -> Vec<u8> {
        let service = self.state.recovery_service();
        let backup = service.create_backup().await.unwrap();
        tokio::fs::read(service.backup_path(&backup.id).await.unwrap())
            .await
            .unwrap()
    }
    fn request(&self, path: &str, body: Vec<u8>) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(path)
            .header("cookie", &self.cookie)
            .header("content-type", "application/gzip")
            .body(Body::from(body))
            .unwrap()
    }
    async fn wait_for_reserved_restore(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.state.restore_state().is_busy() || self.state.runtime_ready() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn failed_admin_write_or_commit_preserves_configuration_on_disk_and_in_sqlite() {
    for failure in [
        "CREATE TRIGGER reject_admin BEFORE UPDATE OF password_hash ON users
        BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
        "CREATE TABLE deferred_config_check (
            user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER reject_commit AFTER UPDATE OF password_hash ON users
        BEGIN INSERT INTO deferred_config_check VALUES ('missing'); END;",
    ] {
        let fixture = Fixture::new().await;
        let previous_config = tokio::fs::read(&fixture.paths.configuration).await.unwrap();
        sqlx::raw_sql(failure)
            .execute(fixture.db.inner())
            .await
            .unwrap();
        let payload = json!({
            "backend": "jellyfin",
            "jellyfin": { "url": "http://jellyfin.internal:8096", "apiKey": "fixture-key" },
            "admin": { "username": "changed-admin", "password": "fixture-password" },
        });
        let response = create_router(fixture.state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/admin/system/configuration")
                    .header("cookie", &fixture.cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            tokio::fs::read(&fixture.paths.configuration).await.unwrap(),
            previous_config
        );
        let admin: String = sqlx::query_scalar("SELECT username FROM users WHERE id = 'admin'")
            .fetch_one(fixture.db.inner())
            .await
            .unwrap();
        assert_eq!(admin, "admin");
        let settings: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM server_settings WHERE key LIKE 'setup.%'")
                .fetch_one(fixture.db.inner())
                .await
                .unwrap();
        assert_eq!(settings, 0);
        let backend: Option<String> =
            sqlx::query_scalar("SELECT type FROM backend_connections WHERE id = 'backend-primary'")
                .fetch_optional(fixture.db.inner())
                .await
                .unwrap();
        assert!(backend.is_none());
        fixture.state.tasks().close();
        fixture.db.close().await;
    }
}

#[tokio::test]
async fn backup_policy_returns_an_http_error_when_sqlite_rejects_the_save() {
    let fixture = Fixture::new().await;
    sqlx::query(
        "CREATE TRIGGER reject_backup_policy BEFORE INSERT ON server_settings
        WHEN NEW.key = 'recovery.backupDaily' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    .execute(fixture.db.inner())
    .await
    .unwrap();
    let response = create_router(fixture.state.clone())
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri("/api/v1/admin/system/backup-policy")
                .header("cookie", &fixture.cookie)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"daily":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    fixture.state.tasks().close();
    fixture.db.close().await;
}

#[tokio::test]
async fn overlapping_restore_and_backup_requests_return_409_without_waiting_for_runtime_gate() {
    let fixture = Fixture::new().await;
    let bytes = fixture.archive().await;
    let router = create_router(fixture.state.clone());
    // Keep the first operation at the runtime write gate with no timing-dependent I/O.
    let generation = fixture.state.runtime_read().await;
    let first = tokio::spawn(
        router
            .clone()
            .oneshot(fixture.request("/api/v1/admin/system/restore", bytes.clone())),
    );
    fixture.wait_for_reserved_restore().await;
    for path in [
        "/api/v1/admin/system/restore",
        "/api/v1/admin/system/backups",
    ] {
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            router.clone().oneshot(fixture.request(path, bytes.clone())),
        )
        .await
        .expect("conflicting request must not wait for the first restore")
        .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
    }
    assert!(!first.is_finished());
    drop(generation);
    let response = tokio::time::timeout(Duration::from_secs(10), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert!(!fixture.state.restore_state().is_busy());
    fixture.db.close().await;
}

#[tokio::test]
async fn backup_reservation_also_rejects_an_overlapping_restore() {
    let fixture = Fixture::new().await;
    let transition = fixture.state.begin_runtime_update().await;
    let router = create_router(fixture.state.clone());
    let first = tokio::spawn(
        router
            .clone()
            .oneshot(fixture.request("/api/v1/admin/system/backups", vec![])),
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.state.restore_state().is_busy() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(1),
        router.oneshot(fixture.request("/api/v1/admin/system/restore", vec![])),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    transition.complete();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), first)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert!(!fixture.state.restore_state().is_busy());
    fixture.db.close().await;
}

#[tokio::test]
async fn disconnecting_restore_request_keeps_reservation_until_detached_work_finishes() {
    let fixture = Fixture::new().await;
    let bytes = fixture.archive().await;
    let router = create_router(fixture.state.clone());
    let generation = fixture.state.runtime_read().await;
    let first = tokio::spawn(
        router
            .clone()
            .oneshot(fixture.request("/api/v1/admin/system/restore", bytes.clone())),
    );
    fixture.wait_for_reserved_restore().await;
    first.abort();
    let _ = first.await;
    assert!(fixture.state.restore_state().is_busy());
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(1),
            router.oneshot(fixture.request("/api/v1/admin/system/restore", bytes))
        )
        .await
        .unwrap()
        .unwrap()
        .status(),
        StatusCode::CONFLICT
    );
    drop(generation);
    tokio::time::timeout(Duration::from_secs(10), async {
        while fixture.state.restore_state().is_busy() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.state.runtime_ready());
    fixture.db.close().await;
}

#[tokio::test]
async fn independent_services_share_admission_and_failed_validation_releases_it() {
    let fixture = Fixture::new().await;
    let first_service = fixture.state.recovery_service();
    let second_service = fixture.state.recovery_service();
    let held = fixture.state.restore_state().try_acquire().unwrap();
    assert_eq!(
        first_service.create_backup().await.unwrap_err().status_code,
        409
    );
    assert_eq!(
        second_service
            .restore_from_archive(b"invalid archive")
            .await
            .unwrap_err()
            .status_code,
        409
    );
    drop(held);
    assert_eq!(
        second_service
            .restore_from_archive(b"invalid archive")
            .await
            .unwrap_err()
            .status_code,
        400
    );
    assert!(!fixture.state.restore_state().is_busy());
    assert!(first_service.create_backup().await.is_ok());
    fixture.db.close().await;
}

#[tokio::test]
async fn failed_install_restores_artwork_and_keeps_snapshots_when_sql_rollback_cannot_finish() {
    let fixture = Fixture::new().await;
    // Include the trigger in the archive schema, so validation succeeds and install fails.
    sqlx::raw_sql("CREATE TRIGGER reject_user_restore BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'restore failure fixture'); END;")
        .execute(fixture.db.inner()).await.unwrap();
    let bytes = fixture.archive().await;
    // These live edits must survive rollback, including committed WAL contents.
    sqlx::query("UPDATE users SET display_name = 'Live edit after backup' WHERE id = 'admin'")
        .execute(fixture.db.inner())
        .await
        .unwrap();
    tokio::fs::write(
        fixture.paths.artwork.join("albums/cover.webp"),
        b"live artwork after backup",
    )
    .await
    .unwrap();
    let error = fixture
        .state
        .recovery_service()
        .restore_from_archive(&bytes)
        .await
        .unwrap_err();
    assert_eq!(error.status_code, 500);
    assert_eq!(
        tokio::fs::read(fixture.paths.artwork.join("albums/cover.webp"))
            .await
            .unwrap(),
        b"live artwork after backup"
    );
    let journal_file = fixture.paths.recovery.join("journal.json");
    let journal: RecoveryJournal =
        serde_json::from_slice(&tokio::fs::read(&journal_file).await.unwrap()).unwrap();
    let stage = fixture.paths.recovery.join(&journal.id);
    assert!(stage.join("old-database.sqlite").exists());
    assert_eq!(
        fixture
            .state
            .recovery_service()
            .create_backup()
            .await
            .unwrap_err()
            .status_code,
        409
    );
    // Simulate process shutdown, not just a pool-close racing the live cron worker.
    fixture.state.tasks().close();
    fixture.state.scrobble_queue().close();
    fixture.db.checkpoint_and_close().await.unwrap();
    let Fixture {
        _temp,
        db,
        state,
        paths,
        cookie: _,
    } = fixture;
    drop(state);
    drop(db);
    assert!(recover_interrupted_restore(&paths.database.to_string_lossy()).unwrap());
    assert!(!stage.exists());
    assert!(!journal_file.exists());
    let reopened = DbPool::connect_file(&paths.database.to_string_lossy(), false)
        .await
        .unwrap();
    let display: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id = 'admin'")
        .fetch_one(reopened.inner())
        .await
        .unwrap();
    assert_eq!(display, "Live edit after backup");
    reopened.close().await;
}
