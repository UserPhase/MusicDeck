//! # System Backup, Crash-Safe Restore & GDPR User Data Exports (`recovery`)
//!
//! Exports [`BackupRestoreService`], [`BackupManifest`], [`BackupFile`],
//! [`RecoveryStatus`], [`RecoveryError`], [`recover_interrupted_restore`],
//! [`DataExportService`], [`ExportSummary`], [`csv_cell`], and [`xml_text`].

pub mod backup_restore;
pub mod data_export;
pub mod state;
mod rollback;
#[cfg(test)]
mod reliability_tests;
pub use state::{RestoreGuard, RestoreState};

pub use backup_restore::{
    BackupFile, BackupManifest, BackupManifestFile, BackupRestoreService, MAX_BACKUP_UPLOAD,
    MAX_EXPANDED_BYTES, MAX_MANIFEST_BYTES, MIN_SQLITE_FILE_BYTES, RecoveryError, RecoveryJournal,
    RecoveryStatus, RestoreOutcome, SQLITE_HEADER_MAGIC, SystemRecoveryPaths,
    compute_database_schema_hash, is_valid_backup_archive_path, parse_and_validate_staged_config,
    recover_interrupted_restore, validate_archive_entry_path_safety,
    validate_sqlite_header_magic,
};
pub use data_export::{
    DataExportService, EXPORT_PAGE_SIZE, ExportCounts, ExportEstimatedBytes, ExportKind,
    ExportNotFoundError, ExportPlaylistSummary, ExportSummary, PlaylistEstimatedBytes,
    PlaylistExportFormat, csv_cell, xml_text,
};

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use axum::body::Body;
    use http::{Method, Request, StatusCode, header};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use sqlx::Row;
    use tower::ServiceExt;

    use super::*;
    use crate::auth::SESSION_COOKIE;
    use crate::auth::passwords::verify_password;
    use crate::config::{AppConfig, apply_system_configuration};
    use crate::db::{DbPool, run_migrations};
    use crate::{AppState, create_router};

    #[test]
    fn sanitizes_csv_formula_injection_and_xml_entities() {
        assert_eq!(csv_cell("=SUM(A1:A5)"), "\"'=SUM(A1:A5)\"");
        assert_eq!(csv_cell("  +cmd|' /C calc'!A0"), "\"'  +cmd|' /C calc'!A0\"");
        assert_eq!(csv_cell("Normal \"Song\" Title"), "\"Normal \"\"Song\"\" Title\"");
        assert_eq!(
            xml_text("Björk & Thom Yorke <Live>\u{0000}"),
            "Björk &amp; Thom Yorke &lt;Live&gt;"
        );

        assert!(is_valid_backup_archive_path("database.sqlite"));
        assert!(is_valid_backup_archive_path("config.json"));
        assert!(is_valid_backup_archive_path("artwork/albums/cover_1.webp"));
        assert!(!is_valid_backup_archive_path("../etc/passwd"));
        assert!(!is_valid_backup_archive_path("artwork/../secret.json"));
        assert!(validate_archive_entry_path_safety(Path::new("../evil.sqlite")).is_err());
        assert!(validate_archive_entry_path_safety(Path::new("artwork/../../evil.png")).is_err());
        assert!(validate_archive_entry_path_safety(Path::new("/etc/passwd")).is_err());
    }

    #[tokio::test]
    async fn creates_and_validates_backup_archive_round_trip() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let db_file = temp_dir.path().join("musicdeck.sqlite");
        let db_path_str = db_file.to_string_lossy().into_owned();

        let pool = DbPool::connect_file(&db_path_str, false)
            .await
            .expect("open file db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('admin', 'Admin'), ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
            VALUES
                ('admin1', 'admin', 'hash', 'Admin', 'admin', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                ('u_restore', 'restored_user', 'hash', 'Restored User', 'user', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed active admin and user");

        // Seed an artwork file in <db_dir>/artwork/albums/cover_1.webp
        let artwork_file = temp_dir.path().join("artwork").join("albums").join("cover_1.webp");
        tokio::fs::create_dir_all(artwork_file.parent().unwrap())
            .await
            .expect("create artwork dir");
        tokio::fs::write(&artwork_file, b"RIFF-WEBP-ARTWORK-DATA")
            .await
            .expect("write artwork fixture");

        let mut cfg = AppConfig::load_from_iter(std::iter::empty::<(String, String)>())
            .expect("default config");
        cfg.database.database_path = db_path_str.clone();
        cfg.navidrome.url = String::from("http://navidrome-backup:4533");
        cfg.navidrome.username = String::from("backup_admin");
        cfg.navidrome.password = String::from("backup_secret");
        cfg.music_root = temp_dir.path().join("music").to_string_lossy().into_owned();

        let service = BackupRestoreService::new(Some(pool.clone()), Arc::new(cfg));
        let backup = service.create_backup().await.expect("create system backup");
        assert_eq!(backup.kind, "system");
        assert!(backup.bytes > 0);

        let archive_path = service
            .backup_path(&backup.id)
            .await
            .expect("resolve backup path");
        let archive_bytes = tokio::fs::read(&archive_path)
            .await
            .expect("read backup tar.gz");

        let restore_stage = temp_dir.path().join("restore-stage");
        let manifest = service
            .unpack_and_validate_restore(&archive_bytes, &restore_stage)
            .await
            .expect("validate unpacked backup");
        assert_eq!(manifest.format, "musicdeck-system");
        assert_eq!(manifest.version, 1);
        assert!(!manifest.media_included);

        // Mutate live state: delete user `u_restore` and remove artwork file
        sqlx::query("DELETE FROM users WHERE id = 'u_restore'")
            .execute(pool.inner())
            .await
            .expect("delete u_restore before restore");
        tokio::fs::remove_file(&artwork_file)
            .await
            .expect("delete artwork before restore");

        // Perform full atomic restore
        let outcome = service
            .restore_from_archive(&archive_bytes)
            .await
            .expect("restore from archive");
        assert_eq!(
            outcome.restored_config.navidrome.url,
            "http://navidrome-backup:4533"
        );
        assert_eq!(outcome.restored_config.navidrome.username, "backup_admin");

        // Verify database row, config.json, and artwork file were restored
        let restored_user_count: i64 =
            sqlx::query("SELECT COUNT(*) AS n FROM users WHERE id = 'u_restore'")
                .fetch_one(pool.inner())
                .await
                .and_then(|r| r.try_get("n"))
                .unwrap_or(0);
        assert_eq!(restored_user_count, 1);
        assert!(temp_dir.path().join("config.json").exists());
        assert_eq!(
            tokio::fs::read(&artwork_file).await.expect("read restored artwork"),
            b"RIFF-WEBP-ARTWORK-DATA"
        );

        // Verify invalid SQLite header magic bytes are rejected
        let bad_db_file = temp_dir.path().join("corrupt.sqlite");
        tokio::fs::write(&bad_db_file, b"NOT_A_VALID_SQLITE_HEADER_000000000000000000000000000000000000000000000000000000000000000000000000000000000000000")
            .await
            .expect("write corrupt sqlite");
        assert!(validate_sqlite_header_magic(&bad_db_file).is_err());

        pool.close().await;
    }

    #[tokio::test]
    async fn setup_completion_persists_configuration_and_restore_route_installs_backup() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let db_file = temp_dir.path().join("musicdeck.sqlite");
        let db_path_str = db_file.to_string_lossy().into_owned();
        let music_dir = temp_dir.path().join("music-lib");
        let tmp_acq_dir = temp_dir.path().join("acq-tmp");

        let pool = DbPool::connect_file(&db_path_str, false)
            .await
            .expect("open file db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('admin', 'Admin'), ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, disabled, is_master, created_at, updated_at)
            VALUES ('admin1', 'admin', 'initial_hash', 'Admin', 'admin', 0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed initial admin");

        let mut cfg = AppConfig::load_from_iter(std::iter::empty::<(String, String)>())
            .expect("default config");
        cfg.database.database_path = db_path_str.clone();
        cfg.setup_required = true;

        let state = AppState::with_database(cfg, pool.clone())
            .await
            .expect("initialize application state");
        assert!(state.config().setup_required);

        let session = state
            .session_store()
            .expect("session store")
            .create_session("admin1", true)
            .await
            .expect("create admin session");
        let cookie_header = format!("{SESSION_COOKIE}={}", session.id);

        let router = create_router(state.clone());

        // 1. Submit setup completion configuration payload
        let setup_payload = json!({
            "backend": "navidrome",
            "navidrome": {
                "url": "http://navidrome.internal:4533",
                "username": "nd_service",
                "password": "nd_super_secret_password"
            },
            "musicRoot": music_dir.to_string_lossy(),
            "acquisitionTmpDir": tmp_acq_dir.to_string_lossy(),
            "admin": {
                "username": "sysadmin",
                "password": "new_admin_password_123",
                "displayName": "System Administrator"
            }
        });

        let setup_req = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/admin/system/setup/complete")
            .header(header::COOKIE, &cookie_header)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(setup_payload.to_string()))
            .unwrap();

        let setup_resp = router
            .clone()
            .oneshot(setup_req)
            .await
            .expect("setup response");
        assert_eq!(setup_resp.status(), StatusCode::OK);
        let setup_bytes = setup_resp.into_body().collect().await.unwrap().to_bytes();
        let setup_body: Value = serde_json::from_slice(&setup_bytes).expect("parse setup json");
        assert_eq!(setup_body["completed"], json!(true));
        assert_eq!(setup_body["setupRequired"], json!(false));
        assert_eq!(
            setup_body["configuration"]["navidrome"]["url"],
            json!("http://navidrome.internal:4533")
        );
        assert_eq!(
            setup_body["configuration"]["navidrome"]["username"],
            json!("nd_service")
        );
        assert_eq!(
            setup_body["configuration"]["navidrome"]["passwordSet"],
            json!(true)
        );

        // Verify runtime state transitioned setup_required -> false and saved fields
        assert!(!state.config().setup_required);
        assert_eq!(
            state.config().navidrome.url,
            "http://navidrome.internal:4533"
        );
        assert_eq!(state.config().navidrome.username, "nd_service");
        assert_eq!(
            state.config().navidrome.password,
            "nd_super_secret_password"
        );
        assert_eq!(state.config().music_root, music_dir.to_string_lossy());
        assert_eq!(
            state.config().acquisition_tmp_dir,
            tmp_acq_dir.to_string_lossy()
        );

        // Verify config.json on disk reloads via apply_system_configuration
        let mut fresh_cfg = AppConfig::default();
        fresh_cfg.database.database_path = db_path_str.clone();
        let reloaded = apply_system_configuration(fresh_cfg).expect("reload config.json");
        assert_eq!(reloaded.navidrome.url, "http://navidrome.internal:4533");
        assert_eq!(reloaded.navidrome.username, "nd_service");
        assert_eq!(reloaded.navidrome.password, "nd_super_secret_password");

        // Verify admin user credentials were updated and hashed in SQLite
        let admin_row = sqlx::query(
            "SELECT username, password_hash, display_name FROM users WHERE id = 'admin1'",
        )
        .fetch_one(pool.inner())
        .await
        .expect("fetch updated admin row");
        let saved_username: String = admin_row.try_get("username").unwrap();
        let saved_hash: String = admin_row.try_get("password_hash").unwrap();
        assert_eq!(saved_username, "sysadmin");
        assert!(
            verify_password("new_admin_password_123", &saved_hash)
                .await
                .expect("verify password")
        );

        assert_eq!(
            state.providers().get_primary().unwrap().provider_type,
            "navidrome"
        );
        let shared_privacy = state.privacy().clone();
        shared_privacy
            .update(crate::services::privacy::PrivacySettings {
                local_only: true,
                ..Default::default()
            })
            .await
            .unwrap();

        // 2. Create backup via POST /api/v1/admin/system/backups
        let create_bk_req = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/admin/system/backups")
            .header(header::COOKIE, &cookie_header)
            .body(Body::empty())
            .unwrap();
        let create_bk_resp = router
            .clone()
            .oneshot(create_bk_req)
            .await
            .expect("create backup response");
        assert_eq!(create_bk_resp.status(), StatusCode::CREATED);
        let bk_bytes = create_bk_resp
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let bk_json: Value = serde_json::from_slice(&bk_bytes).unwrap();
        let backup_id = bk_json["backup"]["id"].as_str().expect("backup id");

        // Download the backup archive via GET /api/v1/admin/system/backups/:id
        let dl_bk_req = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/v1/admin/system/backups/{backup_id}"))
            .header(header::COOKIE, &cookie_header)
            .body(Body::empty())
            .unwrap();
        let dl_bk_resp = router
            .clone()
            .oneshot(dl_bk_req)
            .await
            .expect("download backup");
        assert_eq!(dl_bk_resp.status(), StatusCode::OK);
        let archive_payload = dl_bk_resp.into_body().collect().await.unwrap().to_bytes();

        // Install a different live provider and policy before restoring the backup.
        shared_privacy.update(Default::default()).await.unwrap();
        let configuration = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/admin/system/configuration")
            .header(header::COOKIE, &cookie_header)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"backend":"jellyfin", "jellyfin":{
                    "url":"http://changed-host:8096", "apiKey":"fixture-key"
                }})
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            router
                .clone()
                .oneshot(configuration)
                .await
                .unwrap()
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(
            state.providers().get_primary().unwrap().provider_type,
            "jellyfin"
        );
        assert!(
            shared_privacy
                .is_library_url(&url::Url::parse("http://changed-host:8096/Items").unwrap())
        );
        let _ = tokio::fs::remove_file(temp_dir.path().join("config.json")).await;

        // Restore via POST /api/v1/admin/system/restore
        let restore_req = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/admin/system/restore")
            .header(header::COOKIE, &cookie_header)
            .header(header::CONTENT_TYPE, "application/gzip")
            .body(Body::from(archive_payload))
            .unwrap();
        let restore_resp = router
            .clone()
            .oneshot(restore_req)
            .await
            .expect("restore response");
        assert_eq!(restore_resp.status(), StatusCode::ACCEPTED);
        let restore_resp_bytes = restore_resp.into_body().collect().await.unwrap().to_bytes();
        let restore_json: Value = serde_json::from_slice(&restore_resp_bytes).unwrap();
        assert_eq!(restore_json["accepted"], json!(true));
        assert!(restore_json["safetyBackupId"].as_str().is_some());

        // Verify config.json and runtime state were restored from the backup
        assert!(temp_dir.path().join("config.json").exists());
        assert_eq!(
            state.config().navidrome.url,
            "http://navidrome.internal:4533"
        );
        assert!(shared_privacy.snapshot().local_only);
        assert!(!shared_privacy.snapshot().effective.external);
        assert_eq!(
            state.providers().get_primary().unwrap().provider_type,
            "navidrome"
        );
        assert!(
            shared_privacy
                .is_library_url(&url::Url::parse("http://navidrome.internal:4533/rest").unwrap())
        );
        assert!(
            !shared_privacy
                .is_library_url(&url::Url::parse("http://changed-host:8096/Items").unwrap())
        );
        assert!(
            state
                .scrobble_queue()
                .statuses("admin1")
                .await
                .iter()
                .all(|status| !status.available)
        );

        pool.close().await;
    }

    #[tokio::test]
    async fn exports_user_summary_playlists_and_history_csv() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('u1', 'alice', 'hash', 'Alice', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            INSERT INTO playlists (id, name, description, owner_user_id, sharing_mode, created_at, updated_at)
            VALUES ('pl1', 'Late Night', 'Synthwave', 'u1', 'PRIVATE', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            INSERT INTO listening_events (id, user_id, track_id, event_type, listened_seconds, created_at, counted, finished)
            VALUES ('ev1', 'u1', 'tr1', 'complete', 180, '2026-01-01T00:00:00Z', 1, 1);
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed user export fixtures");

        let export = DataExportService::new(Some(pool.clone()), "http://127.0.0.1:4533");
        let summary = export.summary("u1").await;
        assert_eq!(summary.counts.playlists, 1);
        assert_eq!(summary.counts.history, 1);

        let m3u8 = export
            .export_playlist_text("u1", "pl1", PlaylistExportFormat::M3u8)
            .await
            .expect("export m3u8");
        assert!(m3u8.starts_with("#EXTM3U\n#PLAYLIST:Late Night\n"));

        let xspf = export
            .export_playlist_text("u1", "pl1", PlaylistExportFormat::Xspf)
            .await
            .expect("export xspf");
        assert!(xspf.contains("<title>Late Night</title>"));

        let csv = export.export_history_csv("u1").await;
        assert!(csv.contains("\"2026-01-01T00:00:00Z\",\"tr1\""));

        pool.close().await;
    }
}
