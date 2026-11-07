//! # Administrative Diagnostics, Library Health Scanner & Media Deletion (`admin`)
//!
//! Exports [`LibraryHealthScanService`], [`LibraryHealthScanStatus`],
//! [`LibraryHealthReport`], [`SystemHealthWizard`], [`DiagnosticReport`],
//! [`DiagnosticCheck`], [`verified_audio_path`], [`remove_empty_parents`],
//! and [`remove_album_directory_if_safe`].

pub mod library_health_scan;
pub mod media_deletion;
pub mod wizard;

pub use library_health_scan::{
    HEALTH_REPORT_ISSUE_LIMIT, LibraryHealthPruneResult, LibraryHealthReport,
    LibraryHealthReportSummary, LibraryHealthScanBusy, LibraryHealthScanPhase,
    LibraryHealthScanService, LibraryHealthScanState, LibraryHealthScanStatus,
};
pub use media_deletion::{
    MediaPathError, is_path_within_root, remove_album_directory_if_safe, remove_empty_parents,
    verified_audio_path,
};
pub use wizard::{
    DiagnosticCategory, DiagnosticCheck, DiagnosticReport, DiagnosticStatus, SystemHealthWizard,
};

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use super::*;
    use crate::config::AppConfig;
    use crate::db::{DbPool, run_migrations};

    #[tokio::test]
    async fn verifies_media_paths_and_runs_system_health_wizard() {
        let temp_root = tempfile::tempdir().expect("create temp music root");
        let artist_album = temp_root.path().join("Artist").join("Album");
        tokio::fs::create_dir_all(&artist_album).await.unwrap();

        let track_path = artist_album.join("01 - Song.flac");
        let cover_path = artist_album.join("cover.jpg");
        tokio::fs::write(&track_path, b"fLaC").await.unwrap();
        tokio::fs::write(&cover_path, b"jpg").await.unwrap();

        assert!(!is_path_within_root(temp_root.path(), temp_root.path()));
        assert!(is_path_within_root(&track_path, temp_root.path()));

        let verified = verified_audio_path("Artist/Album/01 - Song.flac", temp_root.path())
            .await
            .expect("verify valid flac path");
        assert!(verified.ends_with(Path::new("01 - Song.flac")));

        assert!(
            verified_audio_path("../outside.flac", temp_root.path())
                .await
                .is_err()
        );
        assert!(
            verified_audio_path("Artist/Album/cover.jpg", temp_root.path())
                .await
                .is_err()
        );

        tokio::fs::remove_file(&verified).await.unwrap();
        remove_album_directory_if_safe(std::slice::from_ref(&verified), temp_root.path()).await;
        remove_empty_parents(&verified, temp_root.path()).await;
        assert!(!artist_album.exists());

        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");
        let cfg = AppConfig::load_from_iter(std::iter::empty::<(String, String)>())
            .expect("default config");
        let wizard = SystemHealthWizard::new(Some(pool.clone()), Arc::new(cfg));
        let report = wizard.run().await;

        let db_check = report
            .checks
            .iter()
            .find(|c| c.id == "database-integrity")
            .expect("database-integrity check");
        assert_eq!(db_check.status, DiagnosticStatus::Pass);

        pool.close().await;
    }
}
