//! # Comprehensive SQLite Migration, Legacy Upgrade, Trigger & Permission Test Suite
//!
//! Integration test suite achieving full parity with:
//! - `server/test/migrations.test.ts`
//! - `server/test/migration-connection-scope.test.ts`
//! - `server/test/database-permissions.test.ts`
//!
//! ## Concurrency & Isolation Model
//! Every test case constructs either:
//! 1. A private in-memory database (`DbPool::connect_memory()`), or
//! 2. An isolated RAII temporary directory (`tempfile::TempDir`) with its own
//!    `musicdeck.sqlite`, `-wal`, and `-shm` files.
//! No global database file or shared mutable state is touched across tests, allowing
//! `cargo test` to execute all scenarios in parallel without SQLite lock contention.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::path::PathBuf;

use musicdeck_server::config::AppConfig;
use musicdeck_server::db::{
    DbError, DbPool, LATEST_SCHEMA_VERSION, open_database,
    protect_database_file, protect_database_files, run_migrations, seed_initial_data,
};
use pretty_assertions::assert_eq;
use serde_json::Value;
use sqlx::Row;
use tempfile::TempDir;

/// Test fixture holding an isolated temporary directory and database path.
struct FileDbFixture {
    _temp_dir: TempDir,
    db_path: PathBuf,
}

impl FileDbFixture {
    fn new() -> Self {
        let temp_dir = TempDir::new().expect("create temporary test directory");
        let db_path = temp_dir.path().join("private-data").join("musicdeck.sqlite");
        Self {
            _temp_dir: temp_dir,
            db_path,
        }
    }

    fn config_with_admin(&self) -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.database.database_path = self.db_path.to_string_lossy().into_owned();
        cfg.auth.session_secret = String::from("integration-test-session-secret");
        cfg.auth.first_admin.username = String::from("admin");
        cfg.auth.first_admin.password = String::from("admin-fixture-password");
        cfg.navidrome.url = String::from("http://navidrome:4533");
        cfg.navidrome.username = String::from("service-user");
        cfg.navidrome.password = String::from("service-password");
        cfg
    }
}

// ============================================================================
// 1. Fresh Database Initialization & Query Plan Index Verification (v1..=50)
// ============================================================================

#[tokio::test]
async fn fresh_in_memory_database_applies_all_50_migrations_and_uses_catalog_indexes() {
    let pool = DbPool::connect_memory().await.expect("open in-memory pool");

    let report = run_migrations(&pool, None)
        .await
        .expect("run all 50 migrations");
    assert_eq!(report.total_applied, LATEST_SCHEMA_VERSION as usize);
    assert_eq!(
        report.newly_applied,
        (1..=LATEST_SCHEMA_VERSION).collect::<Vec<u32>>()
    );

    // Verify idempotency: running a second time applies 0 new migrations.
    let second_run = run_migrations(&pool, None)
        .await
        .expect("idempotent second migration run");
    assert!(second_run.newly_applied.is_empty());
    assert_eq!(second_run.total_applied, 50);

    // Verify core and late-stage domain tables exist in sqlite_master.
    let table_rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table';")
        .fetch_all(pool.inner())
        .await
        .expect("query sqlite_master tables");
    let tables: HashSet<String> = table_rows
        .into_iter()
        .map(|r| r.try_get::<String, _>("name").expect("table name"))
        .collect();

    for expected_table in [
        "schema_migrations",
        "roles",
        "users",
        "sessions",
        "backend_connections",
        "playlists",
        "playlist_items",
        "library_items",
        "library_item_sources",
        "smart_playlists",
        "smart_playlist_tracks",
        "smart_playlist_track_payloads",
        "smart_playlist_genres",
        "smart_playlist_activity",
        "scrobble_connections",
        "scrobble_queue",
        "playlist_folders",
        "playlist_placements",
        "playlist_provider_tombstones",
        "similar_mix_vectors",
        "taste_settings",
        "followed_artist_catalog",
        "followed_artists",
        "playlist_permissions",
        "playlist_party_sessions",
        "queue_contents",
        "queue_sessions",
        "named_queues",
        "sonic_vectors",
    ] {
        assert!(
            tables.contains(expected_table),
            "expected table '{expected_table}' to exist after migration 50"
        );
    }

    // Verify EXPLAIN QUERY PLAN uses the expected B-tree indexes (parity with `migrations.test.ts`).
    let expected_plans = [
        (
            "SELECT id FROM playlists WHERE owner_user_id = 'user' AND deleted_at IS NULL",
            "playlists_owner_deleted_idx",
        ),
        (
            "SELECT id FROM smart_playlist_tracks WHERE artist COLLATE NOCASE = 'Artist' ORDER BY title COLLATE NOCASE, id",
            "smart_tracks_artist",
        ),
        (
            "SELECT id FROM smart_playlist_tracks WHERE album COLLATE NOCASE = 'Album' ORDER BY title COLLATE NOCASE, id",
            "smart_tracks_album",
        ),
        (
            "SELECT id FROM smart_playlist_tracks WHERE title COLLATE NOCASE = 'Song'",
            "smart_tracks_title",
        ),
        (
            "SELECT id FROM listening_events WHERE user_id = 'user' AND counted = 1 AND created_at >= '2026' ORDER BY created_at DESC, id DESC",
            "listening_activity_history_idx",
        ),
    ];

    for (sql_query, expected_index) in expected_plans {
        let plan_rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {sql_query};"))
            .fetch_all(pool.inner())
            .await
            .expect("explain query plan");
        let matched = plan_rows.iter().any(|row| {
            let detail: String = row.try_get("detail").unwrap_or_default();
            detail.contains("SEARCH") && detail.contains(expected_index)
        });
        assert!(
            matched,
            "expected EXPLAIN QUERY PLAN for `{sql_query}` to SEARCH using `{expected_index}`"
        );
    }

    pool.close().await;
}

// ============================================================================
// 2. Legacy Upgrade Path Simulation (v2 -> v50 and v38 -> v39..=43 -> v50)
// ============================================================================

#[tokio::test]
async fn upgrades_phase5_v2_database_and_backfills_connection_scope_and_library_identities() {
    let fixture = FileDbFixture::new();
    let pool = DbPool::connect(&fixture.db_path)
        .await
        .expect("open v2 fixture db");

    // Roll forward only to Migration 2 (Phase 5 schema before connection_id and library_items)
    run_migrations(&pool, Some(2))
        .await
        .expect("migrate up to v2");

    sqlx::raw_sql(
        r#"
        INSERT INTO roles VALUES ('admin', 'Full server administrator');
        INSERT INTO backend_connections
          (id, type, name, config_json, enabled, created_at, updated_at)
        VALUES
          ('backend-primary', 'navidrome', 'Navidrome', '{"url":"http://old","username":"old-user","password":"old-password"}', 1, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
        INSERT INTO users
          (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
        VALUES
          ('user-1', 'admin', 'hash', 'admin', 'admin', 0, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
        INSERT INTO favorites (user_id, track_id, created_at)
        VALUES ('user-1', 'track-1', '2026-09-03T00:00:00.000Z');
        INSERT INTO recently_played (id, user_id, track_id, played_at)
        VALUES ('recent-1', 'user-1', 'track-9', '2026-09-03T00:00:00.000Z');
        INSERT INTO playlist_ownership (playlist_id, owner_user_id, created_at, updated_at)
        VALUES ('playlist-1', 'user-1', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
        "#,
    )
    .execute(pool.inner())
    .await
    .expect("seed v2 legacy records");
    pool.close().await;

    // Now run full `open_database` (migrations 3..=50 + seed scrubbing + backfills)
    let config = fixture.config_with_admin();
    let upgraded = open_database(&config)
        .await
        .expect("upgrade v2 database to v50");

    // 1. Verify legacy plaintext credentials in backend_connections were scrubbed
    let conn_row =
        sqlx::query("SELECT config_json FROM backend_connections WHERE id = 'backend-primary';")
            .fetch_one(upgraded.inner())
            .await
            .expect("fetch backend-primary");
    let conn_json: Value =
        serde_json::from_str(&conn_row.try_get::<String, _>("config_json").unwrap())
            .expect("parse config_json");
    assert_eq!(conn_json.get("username"), None);
    assert_eq!(conn_json.get("password"), None);
    assert_eq!(
        conn_json.get("credentials").and_then(Value::as_str),
        Some("environment")
    );

    // 2. Verify favorites & recently_played were rewritten to `md_` IDs and mapped in `library_item_sources`
    let fav_row = sqlx::query("SELECT user_id, track_id FROM favorites;")
        .fetch_one(upgraded.inner())
        .await
        .expect("fetch migrated favorite");
    let fav_track_id: String = fav_row.try_get("track_id").unwrap();
    assert!(fav_track_id.starts_with("md_"));

    let source_row = sqlx::query(
        "SELECT connection_id, provider_item_id FROM library_item_sources WHERE library_item_id = ?;",
    )
    .bind(&fav_track_id)
    .fetch_one(upgraded.inner())
    .await
    .expect("fetch source mapping");
    assert_eq!(
        source_row.try_get::<String, _>("connection_id").unwrap(),
        "backend-primary"
    );
    assert_eq!(
        source_row.try_get::<String, _>("provider_item_id").unwrap(),
        "track-1"
    );

    // 3. Verify `playlist_ownership` became a `playlists` row scoped to `backend-primary`
    let playlist_row = sqlx::query(
        "SELECT source_connection_id, owner_user_id, sharing_mode FROM playlists WHERE source_playlist_id = 'playlist-1';",
    )
    .fetch_one(upgraded.inner())
    .await
    .expect("fetch migrated playlist");
    assert_eq!(
        playlist_row
            .try_get::<String, _>("source_connection_id")
            .unwrap(),
        "backend-primary"
    );
    assert_eq!(
        playlist_row.try_get::<String, _>("owner_user_id").unwrap(),
        "user-1"
    );
    assert_eq!(
        playlist_row.try_get::<String, _>("sharing_mode").unwrap(),
        "PRIVATE"
    );

    upgraded.close().await;
}

#[tokio::test]
async fn upgrades_v38_through_v43_procedural_smart_playlists_scrobble_and_taste_views() {
    let pool = DbPool::connect_memory().await.expect("open memory pool");

    // 1. Migrate up to v38 (just before procedural migration 39)
    run_migrations(&pool, Some(38))
        .await
        .expect("migrate up to v38");

    let mut cfg = AppConfig::default();
    cfg.database.database_path = String::from(":memory:");
    cfg.auth.first_admin.password = String::from("admin-password");
    seed_initial_data(&pool, &cfg).await.expect("seed v38");

    // Seed a legacy track payload in `smart_playlist_tracks` + `smart_playlist_track_payloads`,
    // plus an enabled `lastfm` plugin missing `apiSecret` and a `lidarr` plugin config.
    sqlx::raw_sql(
        r#"
        INSERT INTO smart_playlist_tracks (id, title, artist, album, genre, year, bpm, revision)
        VALUES ('md_track_legacy', 'Nightcall', 'Kavinsky', 'OutRun', 'Electronic', 2010, 91.0, 'rev1');
        INSERT INTO smart_playlist_track_payloads (track_id, track_json)
        VALUES ('md_track_legacy', '{"id":"md_track_legacy","genres":["Synthwave","Outrun","Electronic"]}');
        INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
        VALUES ('lastfm', 1, '{"apiKey":"key-without-secret"}', '[]', '2026-01-01T00:00:00Z');
        "#,
    )
    .execute(pool.inner())
    .await
    .expect("seed v38 smart playlist and lastfm state");

    // 2. Execute migrations 39..=43
    let report = run_migrations(&pool, Some(43))
        .await
        .expect("migrate 39..=43");
    assert_eq!(report.newly_applied, vec![39, 40, 41, 42, 43]);

    // Verify Migration 39 extracted multi-genre array from `track_json` into `smart_playlist_genres`
    // and updated `smart_playlist_tracks.genre` with unit-separator `\u{001f}`.
    let genre_rows = sqlx::query(
        "SELECT genre FROM smart_playlist_genres WHERE track_id = 'md_track_legacy' ORDER BY genre ASC;",
    )
    .fetch_all(pool.inner())
    .await
    .expect("query normalized genres");
    let genres: Vec<String> = genre_rows
        .into_iter()
        .map(|r| r.try_get("genre").unwrap())
        .collect();
    assert_eq!(genres, vec!["Electronic", "Outrun", "Synthwave"]);

    let track_row =
        sqlx::query("SELECT genre FROM smart_playlist_tracks WHERE id = 'md_track_legacy';")
            .fetch_one(pool.inner())
            .await
            .expect("query track genre column");
    let joined_genre: String = track_row.try_get("genre").unwrap();
    assert_eq!(joined_genre, "Synthwave\u{001f}Outrun\u{001f}Electronic");

    // Verify Migration 40 disabled the incomplete `lastfm` plugin configuration
    let lastfm_row =
        sqlx::query("SELECT enabled FROM plugin_configs WHERE plugin_id = 'lastfm';")
            .fetch_one(pool.inner())
            .await
            .expect("query lastfm plugin");
    let lastfm_enabled: i64 = lastfm_row.try_get("enabled").unwrap();
    assert_eq!(lastfm_enabled, 0);

    // Finish migrating 44..=50
    let final_report = run_migrations(&pool, None).await.expect("migrate 44..=50");
    assert_eq!(final_report.newly_applied, vec![44, 45, 46, 47, 48, 49, 50]);
    assert_eq!(final_report.total_applied, 50);

    pool.close().await;
}

// ============================================================================
// 3. Trigger & Foreign-Key Constraint Validation (v41 & v43 Triggers)
// ============================================================================

#[tokio::test]
async fn enforces_playlist_folder_cycle_revision_tombstone_and_taste_activity_triggers() {
    let pool = DbPool::connect_memory().await.expect("open memory pool");
    run_migrations(&pool, None).await.expect("migrate to v50");

    let mut cfg = AppConfig::default();
    cfg.database.database_path = String::from(":memory:");
    cfg.auth.first_admin.password = String::from("admin-password");
    seed_initial_data(&pool, &cfg).await.expect("seed data");

    let user_id: String = sqlx::query("SELECT id FROM users LIMIT 1;")
        .fetch_one(pool.inner())
        .await
        .expect("fetch admin")
        .try_get("id")
        .unwrap();

    // A. Test `playlist_folder_cycle` trigger (Migration 41)
    sqlx::query(
        "INSERT INTO playlist_folders (id, name, parent_folder_id, user_id, pinned, position) VALUES ('f_root', 'Root', NULL, ?, 0, 0);",
    )
    .bind(&user_id)
    .execute(pool.inner())
    .await
    .expect("insert root folder");

    sqlx::query(
        "INSERT INTO playlist_folders (id, name, parent_folder_id, user_id, pinned, position) VALUES ('f_child', 'Child', 'f_root', ?, 0, 0);",
    )
    .bind(&user_id)
    .execute(pool.inner())
    .await
    .expect("insert child folder");

    let cycle_err = sqlx::query(
        "UPDATE playlist_folders SET parent_folder_id = 'f_child' WHERE id = 'f_root';",
    )
    .execute(pool.inner())
    .await
    .unwrap_err();
    assert!(
        cycle_err
            .to_string()
            .contains("Playlist folders cannot contain cycles"),
        "expected cycle trigger abort, got: {cycle_err}"
    );

    // B. Test `playlist_metadata_revision`, `playlist_insert_revision`, and `playlist_trash_tombstone` triggers
    sqlx::query(
        r"
        INSERT INTO playlists
          (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
        VALUES
          ('pl_1', ?, 'Roadtrip', NULL, 'conn_nav', 'remote_pl_99', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        ",
    )
    .bind(&user_id)
    .execute(pool.inner())
    .await
    .expect("insert playlist");

    sqlx::query(
        r"
        INSERT INTO playlist_items
          (id, playlist_id, position, connection_id, provider_track_id, created_at)
        VALUES
          ('item_1', 'pl_1', 0, 'conn_nav', 'prov_track_1', '2026-01-01T00:00:00Z');
        ",
    )
    .execute(pool.inner())
    .await
    .expect("insert playlist item");

    sqlx::query("UPDATE playlists SET deleted_at = '2026-02-01T00:00:00Z' WHERE id = 'pl_1';")
        .execute(pool.inner())
        .await
        .expect("soft-delete playlist");

    let rev_row = sqlx::query("SELECT edit_revision FROM playlists WHERE id = 'pl_1';")
        .fetch_one(pool.inner())
        .await
        .expect("query edit_revision");
    let edit_revision: i64 = rev_row.try_get("edit_revision").unwrap();
    assert_eq!(edit_revision, 2); // +1 from item insert, +1 from deleted_at update

    let tombstone = sqlx::query(
        "SELECT 1 FROM playlist_provider_tombstones WHERE connection_id = 'conn_nav' AND provider_playlist_id = 'remote_pl_99';",
    )
    .fetch_optional(pool.inner())
    .await
    .expect("query tombstone");
    assert!(tombstone.is_some());

    // C. Test `smart_listening_events_insert` and `taste_feedback_insert` triggers (Migration 43)
    sqlx::query(
        r"
        INSERT INTO listening_events
          (id, user_id, track_id, event_type, created_at, counted, finished, taste_excluded)
        VALUES
          ('ev_public', ?, 'md_track_1', 'complete', '2026-03-01T12:00:00.000Z', 1, 1, 0),
          ('ev_private', ?, 'md_track_1', 'complete', '2026-03-01T12:05:00.000Z', 1, 1, 1);
        ",
    )
    .bind(&user_id)
    .bind(&user_id)
    .execute(pool.inner())
    .await
    .expect("insert listening events");

    let activity_row = sqlx::query(
        "SELECT plays FROM smart_playlist_activity WHERE user_id = ? AND track_id = 'md_track_1';",
    )
    .bind(&user_id)
    .fetch_one(pool.inner())
    .await
    .expect("query smart_playlist_activity");
    let plays: i64 = activity_row.try_get("plays").unwrap();
    // Only the non-taste-excluded event (`ev_public`) is counted in `taste_listening_events`!
    assert_eq!(plays, 1);

    sqlx::query(
        r"
        INSERT INTO recommendation_feedback
          (user_id, item_type, item_id, action, weight, created_at, updated_at)
        VALUES
          (?, 'track', 'md_track_1', 'like', 1.0, '2026-03-01T12:00:00Z', '2026-03-01T12:00:00Z');
        ",
    )
    .bind(&user_id)
    .execute(pool.inner())
    .await
    .expect("insert recommendation feedback");

    let taste_rev: i64 = sqlx::query("SELECT revision FROM taste_settings WHERE user_id = ?;")
        .bind(&user_id)
        .fetch_one(pool.inner())
        .await
        .expect("query taste_settings")
        .try_get("revision")
        .unwrap();
    assert_eq!(taste_rev, 1);

    // D. Cascading user deletion must remove `smart_playlist_activity` without trigger resurrection
    sqlx::query("DELETE FROM users WHERE id = ?;")
        .bind(&user_id)
        .execute(pool.inner())
        .await
        .expect("delete user");

    let remaining_activity: i64 =
        sqlx::query("SELECT COUNT(*) AS c FROM smart_playlist_activity WHERE user_id = ?;")
            .bind(&user_id)
            .fetch_one(pool.inner())
            .await
            .expect("count remaining activity")
            .try_get("c")
            .unwrap();
    assert_eq!(remaining_activity, 0);

    pool.close().await;
}

// ============================================================================
// 4. File Permissions, Sidecar Protection & WAL Mode Validation
// ============================================================================

#[tokio::test]
async fn enforces_wal_mode_and_protects_database_and_sidecar_files() {
    let fixture = FileDbFixture::new();
    let config = fixture.config_with_admin();

    let pool = open_database(&config)
        .await
        .expect("open and initialize persistent database");
    assert_eq!(pool.journal_mode().await.expect("journal mode"), "wal");

    protect_database_files(&fixture.db_path).expect("protect database and sidecars");
    assert!(fixture.db_path.exists());

    #[cfg(unix)]
    {
        use musicdeck_server::db::prepare_database_path;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let parent_dir = fixture.db_path.parent().expect("parent dir");
        assert_eq!(
            std::fs::metadata(parent_dir).expect("dir stat").mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&fixture.db_path)
                .expect("db stat")
                .mode()
                & 0o777,
            0o600
        );

        // Relax mode to 0666 and verify `prepare_database_path` restores 0600
        std::fs::set_permissions(&fixture.db_path, std::fs::Permissions::from_mode(0o666))
            .expect("chmod 0666");
        prepare_database_path(&fixture.db_path).expect("re-harden database path");
        assert_eq!(
            std::fs::metadata(&fixture.db_path)
                .expect("db stat after protect")
                .mode()
                & 0o777,
            0o600
        );
    }

    // Passing a directory path to `protect_database_file` must fail with `UnsafeFileType`
    let dir_err = protect_database_file(fixture.db_path.parent().unwrap()).unwrap_err();
    assert!(matches!(dir_err, DbError::UnsafeFileType { .. }));

    pool.checkpoint_and_close()
        .await
        .expect("checkpoint and close");
}
