use super::*;

struct Fixture {
    _temp: tempfile::TempDir,
    paths: SystemRecoveryPaths,
    stage: PathBuf,
    journal: RecoveryJournal,
}

impl Fixture {
    fn new(had_artwork: bool, had_config: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let paths = SystemRecoveryPaths::from_database_path(
            &temp.path().join("musicdeck.sqlite").to_string_lossy(),
        );
        let journal = RecoveryJournal {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            phase: "installing".into(),
            had_artwork,
            had_config,
            replace_artwork: true,
        };
        let stage = paths.recovery.join(&journal.id);
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(&paths.database, b"replacement db").unwrap();
        std::fs::write(stage.join("old-database.sqlite"), b"original db").unwrap();
        std::fs::write(&paths.configuration, b"replacement config").unwrap();
        if had_config {
            std::fs::write(stage.join("old-config.json"), b"original config").unwrap();
        }
        std::fs::create_dir_all(paths.artwork.join("partial")).unwrap();
        std::fs::write(
            paths.artwork.join("partial/new.webp"),
            b"incomplete replacement artwork",
        )
        .unwrap();
        if had_artwork {
            std::fs::create_dir_all(stage.join("old-artwork/albums")).unwrap();
            std::fs::write(
                stage.join("old-artwork/albums/cover.webp"),
                b"original artwork",
            )
            .unwrap();
        }
        let result = Self {
            _temp: temp,
            paths,
            stage,
            journal,
        };
        result.write_journal();
        result
    }
    fn write_journal(&self) {
        durable_json(&self.paths.recovery.join("journal.json"), &self.journal).unwrap();
    }
    fn recover(&self) -> Result<bool, RecoveryError> {
        recover(&self.paths.database.to_string_lossy(), true)
    }
    fn assert_clean(&self) {
        assert!(!self.stage.exists());
        assert!(!self.paths.recovery.join("journal.json").exists());
    }
}

#[test]
fn interrupted_restore_recovers_original_artwork_database_and_configuration_before_cleanup() {
    let fixture = Fixture::new(true, true);
    assert!(fixture.recover().unwrap());
    assert_eq!(
        std::fs::read(&fixture.paths.database).unwrap(),
        b"original db"
    );
    assert_eq!(
        std::fs::read(&fixture.paths.configuration).unwrap(),
        b"original config"
    );
    assert_eq!(
        std::fs::read(fixture.paths.artwork.join("albums/cover.webp")).unwrap(),
        b"original artwork"
    );
    assert!(!fixture.paths.artwork.join("partial").exists());
    fixture.assert_clean();
    assert!(!fixture.recover().unwrap());
}

#[test]
fn rollback_removes_new_artwork_and_configuration_when_neither_existed_originally() {
    let fixture = Fixture::new(false, false);
    assert!(fixture.recover().unwrap());
    assert!(!fixture.paths.artwork.exists());
    assert!(!fixture.paths.configuration.exists());
    fixture.assert_clean();
}

#[test]
fn crash_before_atomic_artwork_move_preserves_the_untouched_live_directory() {
    let fixture = Fixture::new(true, true);
    std::fs::remove_dir_all(fixture.stage.join("old-artwork")).unwrap();
    let unchanged = std::fs::read(fixture.paths.artwork.join("partial/new.webp")).unwrap();
    assert!(fixture.recover().unwrap());
    assert_eq!(
        std::fs::read(fixture.paths.artwork.join("partial/new.webp")).unwrap(),
        unchanged
    );
    fixture.assert_clean();
}

#[test]
fn failed_rollback_retains_journal_and_artwork_then_retries_after_repair() {
    let fixture = Fixture::new(true, true);
    // A directory at the config-file path causes a portable, deterministic I/O failure.
    std::fs::remove_file(&fixture.paths.configuration).unwrap();
    std::fs::create_dir(&fixture.paths.configuration).unwrap();
    assert!(fixture.recover().is_err());
    assert!(fixture.paths.recovery.join("journal.json").exists());
    assert_eq!(
        std::fs::read(fixture.stage.join("old-artwork/albums/cover.webp")).unwrap(),
        b"original artwork"
    );
    std::fs::remove_dir(&fixture.paths.configuration).unwrap();
    assert!(fixture.recover().unwrap());
    assert_eq!(
        std::fs::read(fixture.paths.artwork.join("albums/cover.webp")).unwrap(),
        b"original artwork"
    );
    assert_eq!(
        std::fs::read(&fixture.paths.configuration).unwrap(),
        b"original config"
    );
    fixture.assert_clean();
}

#[test]
fn missing_original_artwork_and_snapshot_fail_closed_without_deleting_staging() {
    let fixture = Fixture::new(true, true);
    std::fs::remove_dir_all(fixture.stage.join("old-artwork")).unwrap();
    std::fs::remove_dir_all(&fixture.paths.artwork).unwrap();
    assert!(fixture.recover().is_err());
    assert!(fixture.stage.exists());
    assert!(fixture.paths.recovery.join("journal.json").exists());
}

#[test]
fn committed_restore_keeps_new_artwork_and_only_cleans_old_staging() {
    let mut fixture = Fixture::new(true, true);
    fixture.journal.phase = "committed".into();
    fixture.write_journal();
    assert!(fixture.recover().unwrap());
    assert_eq!(
        std::fs::read(fixture.paths.artwork.join("partial/new.webp")).unwrap(),
        b"incomplete replacement artwork"
    );
    assert_eq!(
        std::fs::read(&fixture.paths.database).unwrap(),
        b"replacement db"
    );
    fixture.assert_clean();
}

#[test]
fn rollback_cleanup_resumes_after_staging_was_already_removed() {
    let mut fixture = Fixture::new(true, true);
    fixture.journal.phase = "rolled-back".into();
    fixture.write_journal();
    std::fs::remove_dir_all(&fixture.stage).unwrap();
    assert!(fixture.recover().unwrap());
    fixture.assert_clean();
}

#[test]
fn journal_path_traversal_is_rejected_before_touching_files() {
    let mut fixture = Fixture::new(true, true);
    fixture.journal.id = "../artwork".into();
    fixture.write_journal();
    assert!(fixture.recover().is_err());
    assert!(fixture.stage.exists());
    assert!(fixture.paths.artwork.join("partial/new.webp").exists());
}
