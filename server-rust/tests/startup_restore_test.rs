use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use musicdeck_server::config::{AppConfig, durable_json};
use musicdeck_server::db::DbPool;
use musicdeck_server::recovery::{RecoveryJournal, SystemRecoveryPaths};
use serde_json::json;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tokio::io::{AsyncBufReadExt, BufReader};

struct Fixture {
    root: tempfile::TempDir,
    paths: SystemRecoveryPaths,
    stage: PathBuf,
}

impl Fixture {
    async fn new(phase: &str, installed: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let db_path = root.path().join("musicdeck.sqlite");
        let paths = SystemRecoveryPaths::from_database_path(&db_path.to_string_lossy());
        let journal = RecoveryJournal {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            phase: phase.to_owned(),
            had_config: true,
            had_artwork: true,
            replace_artwork: true,
        };
        let stage = paths.recovery.join(&journal.id);
        std::fs::create_dir_all(&paths.recovery).unwrap();
        std::fs::create_dir_all(&paths.artwork).unwrap();

        let cfg = AppConfig::default();
        let config = |generation: &str| {
            json!({
                "version": 1, "backend": "navidrome",
                "navidrome": { "url": "http://127.0.0.1:4533", "username": "", "password": "" },
                "jellyfin": { "url": "http://127.0.0.1:8096", "apiKey": "" },
                "musicRoot": generation, "acquisitionTmpDir": cfg.acquisition_tmp_dir,
            })
        };
        let expected_live = if installed { "replacement" } else { "original" };
        Self::database(&db_path, expected_live).await;
        if phase != "rolled-back" {
            std::fs::create_dir_all(stage.join("old-artwork")).unwrap();
            durable_json(&stage.join("old-config.json"), &config("original")).unwrap();
            std::fs::write(stage.join("old-artwork/generation"), b"original").unwrap();
            Self::database(&stage.join("old-database.sqlite"), "original").await;
        }
        std::fs::write(paths.artwork.join("generation"), expected_live).unwrap();
        durable_json(&paths.configuration, &config(expected_live)).unwrap();
        durable_json(&paths.recovery.join("journal.json"), &journal).unwrap();
        Self { root, paths, stage }
    }

    async fn database(path: &Path, generation: &str) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE fixture_generation (value TEXT NOT NULL)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO fixture_generation (value) VALUES (?)")
            .bind(generation)
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
    }

    fn server(&self, port: u16) -> tokio::process::Command {
        let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_musicdeck-server"));
        server
            .current_dir(self.root.path())
            .env_clear()
            .env("MUSICDECK_BIND_ADDR", format!("127.0.0.1:{port}"))
            .env("MUSICDECK_DB_PATH", &self.paths.database)
            .env("MUSICDECK_ENV", "production")
            .env("MUSICDECK_SESSION_SECRET", "startup-fixture-session-secret")
            .env("MUSICDECK_PUBLIC_URL", format!("http://127.0.0.1:{port}"))
            .env("MUSICDECK_SECURE_COOKIES", "false")
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            server.env("SystemRoot", system_root);
        }
        server
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn server_launch_recovers_each_restore_phase_before_opening_config_or_database() {
    for (phase, installed, expected) in [
        ("installing", true, "original"),
        ("committed", true, "replacement"),
        ("rolled-back", false, "original"),
    ] {
        let fixture = Fixture::new(phase, installed).await;
        if phase == "installing" {
            std::fs::write(&fixture.paths.configuration, b"interrupted config write").unwrap();
        }
        let port = free_port();
        let mut child = fixture.server(port).spawn().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let log = tokio::time::timeout(Duration::from_secs(20), async {
            let mut log = Vec::new();
            while let Some(line) = stdout.next_line().await.unwrap() {
                let ready =
                    line.contains("MusicDeck Server listening and ready to accept connections");
                log.push(line);
                if ready {
                    return Ok(log);
                }
            }
            Err(log)
        })
        .await
        .unwrap_or_else(|_| panic!("startup timed out for {phase}"));
        assert!(log.is_ok(), "startup failed for {phase}: {log:?}");
        child.kill().await.unwrap();

        assert!(
            !fixture.paths.recovery.join("journal.json").exists(),
            "{phase}"
        );
        assert!(!fixture.stage.exists(), "{phase}");
        assert_eq!(
            std::fs::read_to_string(fixture.paths.artwork.join("generation")).unwrap(),
            expected
        );
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&fixture.paths.configuration).unwrap()).unwrap();
        assert_eq!(config["musicRoot"], expected);
        let db = DbPool::connect(&fixture.paths.database).await.unwrap();
        let generation: String = sqlx::query_scalar("SELECT value FROM fixture_generation")
            .fetch_one(db.inner())
            .await
            .unwrap();
        assert_eq!(generation, expected);
        db.close().await;
    }
}

#[tokio::test]
async fn failed_startup_rollback_retains_journal_and_does_not_serve() {
    let fixture = Fixture::new("installing", true).await;
    std::fs::remove_file(fixture.stage.join("old-database.sqlite")).unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.server(free_port()).output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    assert!(fixture.paths.recovery.join("journal.json").exists());
    assert!(fixture.stage.exists());
    let db = DbPool::connect(&fixture.paths.database).await.unwrap();
    let schema_migrations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name = 'schema_migrations'")
            .fetch_one(db.inner())
            .await
            .unwrap();
    assert_eq!(
        schema_migrations, 0,
        "server must fail before it migrates SQLite"
    );
    db.close().await;
}

#[tokio::test]
async fn invalid_production_environment_leaves_restore_journal_and_live_configuration_untouched() {
    let fixture = Fixture::new("installing", true).await;
    let journal = fixture.paths.recovery.join("journal.json");
    let before = std::fs::read(&journal).unwrap();
    let invalid_config = b"invalid restored config";
    std::fs::write(&fixture.paths.configuration, invalid_config).unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        fixture
            .server(free_port())
            .env_remove("MUSICDECK_SESSION_SECRET")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    let log = String::from_utf8_lossy(&output.stdout);
    assert!(log.contains("MUSICDECK_SESSION_SECRET"), "{log}");
    assert_eq!(std::fs::read(&journal).unwrap(), before);
    assert_eq!(
        std::fs::read(&fixture.paths.configuration).unwrap(),
        invalid_config
    );
    assert!(fixture.stage.exists());
}
