//! # Automated Media Acquisition, SpotDL Adapter & Spotify Playlist Importer (`acquisition`)
//!
//! Exports [`SpotDLDownloaderAdapter`], [`SpotDLOutputFormat`], [`AcquisitionProgress`],
//! [`TrackImportRequest`], [`parse_spotdl_progress`], [`canonical_spotify_url`],
//! [`canonical_manual_acquisition_url`], [`SqliteImportJobRepository`], [`ImportJob`],
//! [`SpotifyPlaylistImportService`], and [`AcquisitionService`].

pub mod repository;
pub mod service;
pub mod spotdl;

pub use repository::{
    ImportEntry, ImportEntryStatus, ImportJob, PlaylistImportForbiddenError,
    SpotifyImportTrackMetadata, SpotifyPlaylistImportService, SqliteImportJobRepository,
    StoredImportJob, parse_spotify_playlist_url, spotify_playlist_description,
};
pub use service::{
    AcquiredFileRecord, AcquisitionCapacityError, AcquisitionCreateOptions, AcquisitionEvent,
    AcquisitionJob, AcquisitionJobError, AcquisitionJobStatus, AcquisitionLimits,
    AcquisitionService,
};
pub use spotdl::{
    AcquisitionProgress, AcquisitionValidationError, SPOTDL_LIBRARY_TEMPLATE,
    SpotDLDiagnosticResult, SpotDLDownloaderAdapter, SpotDLOutputFormat, TrackImportRequest,
    canonical_manual_acquisition_url, canonical_spotify_url, classify_spotdl_error,
    parse_spotdl_progress, spotdl_format_args, validate_spotdl_request,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DbPool, run_migrations};
    use serde_json::json;

    #[test]
    fn parses_spotdl_progress_and_validates_canonical_acquisition_urls() {
        let p1 = parse_spotdl_progress("Downloading 45.2% 2.5MiB/s 4.5MiB/10.0MiB")
            .expect("parse downloading line");
        assert_eq!(p1.stage.as_deref(), Some("downloading"));
        assert_eq!(p1.percent, Some(45.0));
        assert_eq!(p1.speed_bytes_per_second, Some(2_621_440));
        assert_eq!(p1.bytes_downloaded, Some(4_718_592));
        assert_eq!(p1.total_bytes, Some(10_485_760));

        let p2 = parse_spotdl_progress("Downloaded Daft Punk - Veridis Quo")
            .expect("parse downloaded line");
        assert_eq!(p2.percent, Some(100.0));
        assert_eq!(p2.stage.as_deref(), Some("processing"));

        assert_eq!(
            canonical_spotify_url("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT/")
                .unwrap(),
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
        );
        assert_eq!(
            canonical_manual_acquisition_url("https://youtu.be/dQw4w9WgXcQ").unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        assert!(canonical_spotify_url("http://open.spotify.com/track/123").is_err());
        assert!(canonical_manual_acquisition_url("https://evil.example.com/watch?v=123").is_err());
    }

    #[tokio::test]
    async fn persists_import_job_checkpoints_and_manages_acquisition_lifecycle() {
        let pool = DbPool::connect_memory().await.expect("open memory db");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('alice', 'alice', 'hash', 'Alice', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed user");

        let repo = SqliteImportJobRepository::new(pool.clone());
        let stored = StoredImportJob {
            job: ImportJob {
                id: String::from("spimp_1"),
                user_id: String::from("alice"),
                status: String::from("queued"),
                stage: String::from("queued"),
                playlist_id: None,
                playlist_name: Some(String::from("Synthwave")),
                playlist_description: None,
                playlist_artwork_url: None,
                expected_count: Some(10),
                downloaded_count: Some(0),
                current_track: None,
                current_track_name: None,
                imported_count: Some(0),
                error: None,
                completed_count: Some(0),
                failed_count: Some(0),
                manifest: None,
            },
            playlist_url: String::from("https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM"),
            user: json!({ "id": "alice", "role": "user", "disabled": false }),
            unreadable_manifest: None,
        };

        repo.save(&stored).await.expect("save import checkpoint");
        let loaded = repo.get("spimp_1", "alice").await.expect("load checkpoint");
        assert_eq!(loaded.job.playlist_name.as_deref(), Some("Synthwave"));
        assert_eq!(repo.unfinished().await.len(), 1);

        let acq = AcquisitionService::new(Some(pool.clone()));
        let job = acq
            .create_job(
                AcquisitionCreateOptions {
                    user_id: String::from("alice"),
                    track_id: Some(String::from("external_deezer_track_123")),
                    ..AcquisitionCreateOptions::default()
                },
                None,
            )
            .await
            .expect("create acquisition job");
        assert_eq!(job.status, AcquisitionJobStatus::Queued);

        assert!(acq.cancel_job(&job.id, "alice", false).await);
        let retried = acq
            .retry_job(&job.id, "alice", false)
            .await
            .expect("retry cancelled job");
        assert_eq!(retried.status, AcquisitionJobStatus::Queued);

        pool.close().await;
    }
}
