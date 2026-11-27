//! # SQLite Import Job Repository & Spotify Playlist Importer (`acquisition::repository`)
//!
//! Ports:
//! - `server/src/infrastructure/persistence/sqliteImportJobRepository.ts`:
//!   - [`StoredImportJob`] and [`SqliteImportJobRepository`] (`save`, `get`, `unfinished`,
//!     and corrupt-manifest quarantine retaining `unreadable_manifest`)
//! - `server/src/domain/spotify-playlist-import.ts`:
//!   - [`ImportEntryStatus`], [`ImportEntry`], [`ImportJob`] (`SpotifyImportJob`)
//!   - [`parse_spotify_playlist_url`], [`spotify_playlist_description`],
//!     [`PlaylistImportForbiddenError`], and [`SpotifyPlaylistImportService`]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Executor, Row, Sqlite};
use tokio::{fs, time::Instant};

use super::playlist_files::{
    AcquisitionLibrary, PublicationJournal, cleanup_staging, read_playlist_artifact,
    staged_playlist_path, staging_path,
};
use super::playlist_timeout::{
    PLAYLIST_CREATION_TIMEOUT, POST_DOWNLOAD_TIMEOUT, PlaylistDeadline, PlaylistImportTimeout,
    within_phase,
};
use super::progress::{DownloadTelemetry, TrackIssue, monitor_download, safe_title};
use super::{input::Operand, resume};
use crate::acquisition::spotdl::{
    SpotDLDownloaderAdapter, TrackImportRequest, canonical_spotify_url, downloader_error_message,
    scan_downloaded_audio_files,
};
use crate::auth::UserRecord;
use crate::catalog::library::{LibraryItemType, LibraryService, SourceRef};
use crate::config::AppConfig;
use crate::db::DbPool;
use crate::providers::{BackendRegistry, MusicBackend};
use crate::tasks::{TaskError, TaskManager, TaskProgressPatch, TaskRunContext, TaskType};

/// Per-track entry status inside a Spotify playlist import manifest (`ImportEntryStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportEntryStatus {
    #[serde(rename = "PENDING")]
    Pending,
    #[serde(rename = "DOWNLOADED")]
    Downloaded,
    #[serde(rename = "READY")]
    Ready,
    #[serde(rename = "COMPLETED")]
    Completed,
    #[serde(rename = "FAILED_METADATA_MISSING")]
    FailedMetadataMissing,
    #[serde(rename = "FAILED_DOWNLOAD")]
    FailedDownload,
    #[serde(rename = "FAILED_TAGGING")]
    FailedTagging,
    #[serde(rename = "FAILED_INDEXING")]
    FailedIndexing,
    #[serde(rename = "FAILED_LINKING")]
    FailedLinking,
}

/// Source track metadata inside an [`ImportEntry`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyImportTrackMetadata {
    pub position: usize,
    pub url: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
}

/// Individual track entry inside a [`ImportJob::manifest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    pub position: usize,
    pub source: SpotifyImportTrackMetadata,
    pub status: ImportEntryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_path: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub library_reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_scan: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) catalog: Option<super::catalog_audio::CatalogTrackDetails>,
}

/// Batch Spotify playlist import job state (`SpotifyImportJob` / `ImportJob`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub user_id: String,
    /// `"queued" | "running" | "completed" | "partial" | "failed" | "cancelled"`.
    pub status: String,
    /// `"queued" | "download" | "conversion" | "scan" | "playlist_creation" | "completed" | "cancelled"`.
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_artwork_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovered_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_track: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_track_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<Vec<ImportEntry>>,
}

impl ImportJob {
    /// Returns display-safe details without subprocess output or filesystem paths.
    pub fn track_issues(&self) -> Vec<TrackIssue> {
        self.manifest
            .iter()
            .flatten()
            .filter_map(ImportEntry::issue)
            .collect()
    }

    pub fn downloader_error_code(&self) -> Option<&str> {
        self.error
            .as_deref()
            .and_then(super::spotdl::downloader_failure_code)
    }
}

impl ImportEntry {
    pub(super) fn issue(&self) -> Option<TrackIssue> {
        let (code, message) = match self.status {
            ImportEntryStatus::FailedDownload => {
                let code = self.error_code.as_deref().unwrap_or("download-failed");
                (code, downloader_error_message(code))
            }
            ImportEntryStatus::FailedMetadataMissing => (
                "missing-metadata",
                "The source did not provide usable track metadata.",
            ),
            ImportEntryStatus::FailedTagging => (
                "publish-failed",
                "Audio could not be saved to the shared music directory.",
            ),
            ImportEntryStatus::FailedIndexing
                if self.error_code.as_deref() == Some("indexing-ambiguous") =>
            {
                (
                    "indexing-ambiguous",
                    "Navidrome reported multiple matches for this file. Check the shared music mount and Report Real Path.",
                )
            }
            ImportEntryStatus::FailedIndexing => (
                "indexing-failed",
                "Navidrome could not locate this file in the shared library.",
            ),
            ImportEntryStatus::FailedLinking => (
                "linking-failed",
                "The track could not be added to the playlist.",
            ),
            _ => return None,
        };
        Some(TrackIssue {
            position: self.position,
            title: safe_title(&self.source.title),
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }
}

/// Persisted checkpoint envelope stored in `import_jobs.manifest_json` (`StoredImportJob`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredImportJob {
    pub job: ImportJob,
    pub playlist_url: String,
    pub user: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable_manifest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) playlist_intent: Option<PlaylistCreationIntent>,
    #[serde(default)]
    pub(super) timeout: PlaylistImportTimeout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) download_sample: Option<PlaylistDownloadSample>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlaylistDownloadSample {
    elapsed_ms: u64,
    downloaded_tracks: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlaylistCreationIntent {
    marker: String,
    connection_id: String,
    tracks: Vec<(String, String)>,
    attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempted_at: Option<i64>,
    upstream_id: Option<String>,
}

/// SQLite repository persisting [`StoredImportJob`] checkpoints in `import_jobs`.
#[derive(Debug, Clone)]
pub struct SqliteImportJobRepository {
    db: DbPool,
}

impl SqliteImportJobRepository {
    /// Creates a new [`SqliteImportJobRepository`].
    #[must_use]
    pub const fn new(db: DbPool) -> Self {
        Self { db }
    }

    /// Saves or updates a [`StoredImportJob`] checkpoint in `import_jobs`.
    pub async fn save(&self, record: &StoredImportJob) -> Result<(), String> {
        Self::save_on(record, self.db.inner()).await
    }

    async fn save_on(
        record: &StoredImportJob,
        executor: impl Executor<'_, Database = Sqlite>,
    ) -> Result<(), String> {
        let job = &record.job;
        let user_id_in_record = record
            .user
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if user_id_in_record != job.user_id {
            return Err(String::from("Import checkpoint owner mismatch"));
        }

        let db_status = match job.status.as_str() {
            "queued" => "PENDING",
            "running" => "PROCESSING",
            "failed" | "partial" | "cancelled" => "FAILED",
            _ => "COMPLETED",
        };
        let now = Utc::now().to_rfc3339();
        let total = job.expected_count.unwrap_or(0) as i64;
        let completed = job.completed_count.or(job.imported_count).unwrap_or(0) as i64;
        let failed = job.failed_count.unwrap_or(0) as i64;
        let manifest_json =
            serde_json::to_string(record).map_err(|e| format!("Serialize error: {e}"))?;

        let res = sqlx::query(
            r"
            INSERT INTO import_jobs (
                id, user_id, status, total_tracks, completed_tracks,
                failed_tracks, manifest_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                total_tracks = excluded.total_tracks,
                completed_tracks = excluded.completed_tracks,
                failed_tracks = excluded.failed_tracks,
                manifest_json = excluded.manifest_json,
                updated_at = excluded.updated_at
            WHERE import_jobs.user_id = excluded.user_id
              AND (json_extract(CASE WHEN json_valid(import_jobs.manifest_json) THEN import_jobs.manifest_json END, '$.job.status') IS NOT 'cancelled'
                   OR json_extract(excluded.manifest_json, '$.job.status') IN ('queued','cancelled'))
            ",
        )
        .bind(&job.id)
        .bind(&job.user_id)
        .bind(db_status)
        .bind(total)
        .bind(completed)
        .bind(failed)
        .bind(manifest_json)
        .bind(&now)
        .bind(&now)
        .execute(executor)
        .await
        .map_err(|e| e.to_string())?;

        if res.rows_affected() == 0 {
            return Err(String::from("Import checkpoint belongs to another user"));
        }
        Ok(())
    }

    async fn report_download(
        &self,
        id: &str,
        task_id: &str,
        update: DownloadTelemetry,
        offset: Option<(usize, usize, usize)>,
    ) {
        let (downloaded, expected, current) = match offset {
            Some((index, count, done)) => (done, Some(count), Some(index + 1)),
            None => (
                update.downloaded,
                update.expected,
                update
                    .expected
                    .map(|count| (update.finished + 1).min(count)),
            ),
        };
        let downloaded = expected.map_or(downloaded, |count| downloaded.min(count));
        let result = sqlx::query(
            "UPDATE import_jobs SET total_tracks=COALESCE(?1,total_tracks), updated_at=?2,
               manifest_json=json_set(manifest_json,'$.job.stage',?3,'$.job.expectedCount',COALESCE(?1,json_extract(manifest_json,'$.job.expectedCount')),
                 '$.job.downloadedCount',?4,'$.job.currentTrack',?5,
                 '$.job.discoveredCount',COALESCE(?8,json_extract(manifest_json,'$.job.discoveredCount')))
             WHERE id=?6 AND status='PROCESSING' AND EXISTS(SELECT 1 FROM background_tasks WHERE id=?7 AND state IN ('PROCESSING','PAUSED'))",
        ).bind(expected.map(|count| count as i64)).bind(Utc::now().to_rfc3339()).bind(update.stage)
          .bind(downloaded as i64).bind(current.map(|index| index as i64)).bind(id).bind(task_id)
          .bind(update.discovered.map(|count| count as i64)).execute(self.db.inner()).await;
        if let Err(error) = result {
            tracing::warn!(%error, "Could not update playlist download progress");
        }
    }

    async fn claim_playlist_creation(
        &self,
        record: &mut StoredImportJob,
        task_id: &str,
    ) -> Result<(), TaskError> {
        let mut tx = crate::db::begin_sqlite_write(
            self.db.inner(),
            "UPDATE import_jobs SET status=status WHERE 0",
        )
        .await
        .map_err(import_db_error)?;
        let now = Utc::now().timestamp_millis();
        let claimed = sqlx::query(
            "UPDATE import_jobs SET manifest_json=json_set(manifest_json,'$.playlistIntent.attempted',json('true'),'$.playlistIntent.attemptedAt',?)
             WHERE id=? AND status='PROCESSING'
               AND EXISTS (SELECT 1 FROM background_tasks WHERE id=? AND state IN ('PROCESSING','PAUSED'))",
        ).bind(now).bind(&record.job.id).bind(task_id).execute(&mut *tx).await.map_err(import_db_error)?.rows_affected();
        if claimed == 0 {
            return Err(TaskError::ExecutionFailed(
                "Playlist creation is already claimed or the task was cancelled".into(),
            ));
        }
        tx.commit().await.map_err(import_db_error)?;
        let intent = record
            .playlist_intent
            .as_mut()
            .expect("claimed playlist intent");
        intent.attempted = true;
        intent.attempted_at = Some(now);
        Ok(())
    }

    async fn finish_playlist(
        &self,
        record: &StoredImportJob,
        local_id: &str,
        connection_id: &str,
        upstream_id: &str,
        tracks: &[(String, String)],
        task_id: &str,
    ) -> Result<(), TaskError> {
        let job = &record.job;
        let now = Utc::now().to_rfc3339();
        let mut tx = crate::db::begin_sqlite_write(
            self.db.inner(),
            "UPDATE import_jobs SET status=status WHERE 0",
        )
        .await
        .map_err(import_db_error)?;
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM background_tasks WHERE id=? AND state IN ('PROCESSING','PAUSED'))")
            .bind(task_id).fetch_one(&mut *tx).await.map_err(import_db_error)?;
        if !active {
            return Err(TaskError::Cancelled);
        }
        sqlx::query(
            "INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id,
                source_playlist_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET source_connection_id=excluded.source_connection_id,
                source_playlist_id=excluded.source_playlist_id, updated_at=excluded.updated_at
             WHERE playlists.owner_user_id=excluded.owner_user_id",
        )
        .bind(local_id)
        .bind(&job.user_id)
        .bind(&job.playlist_name)
        .bind(&job.playlist_description)
        .bind(connection_id)
        .bind(upstream_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(import_db_error)?;
        sqlx::query("DELETE FROM playlist_items WHERE playlist_id=?")
            .bind(local_id)
            .execute(&mut *tx)
            .await
            .map_err(import_db_error)?;
        for (position, (provider_id, library_id)) in tracks.iter().enumerate() {
            sqlx::query(
                "INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id,
                    library_track_id, created_at, added_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("mdpli_{}", nanoid!(16))).bind(local_id).bind(position as i64)
            .bind(connection_id).bind(provider_id).bind(library_id).bind(&now).bind(&job.user_id)
            .execute(&mut *tx).await.map_err(import_db_error)?;
        }
        Self::save_on(record, &mut *tx)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        tx.commit().await.map_err(import_db_error)
    }

    async fn decode_row(
        &self,
        id: String,
        user_id: String,
        manifest_json: String,
    ) -> StoredImportJob {
        if let Ok(record) = serde_json::from_str::<StoredImportJob>(&manifest_json) {
            let valid_owner = record.job.id == id
                && record.job.user_id == user_id
                && record.user.get("id").and_then(Value::as_str) == Some(user_id.as_str());
            let valid_status = matches!(
                record.job.status.as_str(),
                "queued" | "running" | "completed" | "partial" | "failed" | "cancelled"
            );
            if valid_owner && valid_status {
                return record;
            }
        }

        // Quarantine unreadable checkpoint without discarding evidence
        let fallback = StoredImportJob {
            playlist_url: String::new(),
            user: json!({ "id": user_id, "disabled": true }),
            job: ImportJob {
                id,
                user_id,
                status: String::from("failed"),
                stage: String::from("completed"),
                playlist_id: None,
                playlist_name: None,
                playlist_description: None,
                playlist_artwork_url: None,
                expected_count: None,
                discovered_count: None,
                downloaded_count: None,
                current_track: None,
                current_track_name: None,
                imported_count: None,
                error: Some(String::from(
                    "Stored import checkpoint is invalid; original manifest retained",
                )),
                completed_count: None,
                failed_count: None,
                manifest: None,
            },
            unreadable_manifest: Some(manifest_json),
            playlist_intent: None,
            timeout: PlaylistImportTimeout::Auto,
            download_sample: None,
        };
        if let Err(error) = self.save(&fallback).await {
            tracing::warn!(job_id = %fallback.job.id, %error, "Could not quarantine an invalid playlist import checkpoint");
        }
        fallback
    }

    /// Retrieves a stored import job for `(id, user_id)`.
    pub async fn get(&self, id: &str, user_id: &str) -> Option<StoredImportJob> {
        let row = sqlx::query(
            "SELECT id, user_id, manifest_json FROM import_jobs WHERE id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(self.db.inner())
        .await
        .ok()
        .flatten()?;

        let r_id: String = row.try_get("id").ok()?;
        let r_uid: String = row.try_get("user_id").ok()?;
        let m_json: String = row.try_get("manifest_json").ok()?;
        Some(self.decode_row(r_id, r_uid, m_json).await)
    }

    async fn historical_download_rate(&self, user_id: &str) -> Result<Option<u64>, sqlx::Error> {
        let samples: Vec<String> = sqlx::query_scalar(
            "SELECT json_extract(manifest_json, '$.downloadSample') FROM import_jobs
             WHERE user_id=? AND json_type(CASE WHEN json_valid(manifest_json) THEN manifest_json END,
                 '$.downloadSample')='object'
             ORDER BY updated_at DESC, id DESC LIMIT 7",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await?;
        let mut rates: Vec<_> = samples
            .iter()
            .filter_map(|sample| serde_json::from_str::<PlaylistDownloadSample>(sample).ok())
            .filter(|sample| sample.downloaded_tracks >= 5 && sample.elapsed_ms > 0)
            .map(|sample| sample.elapsed_ms / sample.downloaded_tracks)
            .collect();
        rates.sort_unstable();
        Ok(rates.get(rates.len() / 2).copied())
    }

    /// Retrieves a stored import job by `id` alone (used by background workers).
    pub async fn get_by_id(&self, id: &str) -> Option<StoredImportJob> {
        let row = sqlx::query("SELECT id, user_id, manifest_json FROM import_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(self.db.inner())
            .await
            .ok()
            .flatten()?;

        let r_id: String = row.try_get("id").ok()?;
        let r_uid: String = row.try_get("user_id").ok()?;
        let m_json: String = row.try_get("manifest_json").ok()?;
        Some(self.decode_row(r_id, r_uid, m_json).await)
    }

    /// Lists unfinished (`PENDING` or `PROCESSING`) import jobs in creation order.
    pub async fn unfinished(&self) -> Vec<StoredImportJob> {
        self.read_unfinished().await.unwrap_or_default()
    }

    async fn read_unfinished(&self) -> Result<Vec<StoredImportJob>, sqlx::Error> {
        let rows = sqlx::query(
            r"
            SELECT id, user_id, manifest_json FROM import_jobs
            WHERE status IN ('PENDING', 'PROCESSING')
            ORDER BY created_at, id
            ",
        )
        .fetch_all(self.db.inner())
        .await?;

        let mut out = Vec::new();
        for row in rows {
            let (Ok(id), Ok(uid), Ok(m_json)) = (
                row.try_get::<String, _>("id"),
                row.try_get::<String, _>("user_id"),
                row.try_get::<String, _>("manifest_json"),
            ) else {
                continue;
            };
            let decoded = self.decode_row(id, uid, m_json).await;
            if matches!(decoded.job.status.as_str(), "queued" | "running") {
                out.push(decoded);
            }
        }
        Ok(out)
    }
}

/// Validates and canonicalizes a Spotify public playlist URL (`https://open.spotify.com/playlist/<id>`).
#[must_use]
pub fn parse_spotify_playlist_url(raw: &str) -> Option<(String, String)> {
    let canonical = canonical_spotify_url(raw.trim()).ok()?;
    let id = canonical
        .strip_prefix("https://open.spotify.com/playlist/")?
        .to_owned();
    Some((id, canonical))
}

/// Formats a playlist description with `Imported from Spotify: <url>` attribution within 1,000 characters.
#[must_use]
pub fn spotify_playlist_description(description: Option<&str>, playlist_url: &str) -> String {
    let attribution = format!("Imported from Spotify: {playlist_url}");
    let Some(orig) = description.map(str::trim).filter(|s| !s.is_empty()) else {
        return attribution;
    };
    let sep = "\n\n";
    let avail = 1000_usize.saturating_sub(sep.len() + attribution.len());
    let truncated: String = orig.chars().take(avail).collect();
    format!("{}{sep}{attribution}", truncated.trim_end())
}

/// Error returned when a user lacks permission to import Spotify playlists.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PlaylistImportForbiddenError(pub String);

/// Service managing Spotify playlist import jobs and checkpoint persistence.
#[derive(Clone)]
pub struct SpotifyPlaylistImportService {
    db: Option<DbPool>,
    jobs: Arc<RwLock<HashMap<String, ImportJob>>>,
    library: Option<AcquisitionLibrary>,
}

impl std::fmt::Debug for SpotifyPlaylistImportService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpotifyPlaylistImportService").finish()
    }
}

impl SpotifyPlaylistImportService {
    /// Creates a new [`SpotifyPlaylistImportService`].
    #[must_use]
    pub fn new(db: Option<DbPool>) -> Self {
        Self {
            db,
            jobs: Arc::new(RwLock::new(HashMap::new())),
            library: None,
        }
    }

    #[must_use]
    pub(crate) fn with_library(
        mut self,
        config: Arc<RwLock<Arc<AppConfig>>>,
        providers: BackendRegistry,
    ) -> Self {
        self.library = Some(AcquisitionLibrary { config, providers });
        self
    }

    /// Starts a new Spotify playlist import job and enqueues it on `tasks` if available.
    pub async fn start(
        &self,
        playlist_url: &str,
        user: &UserRecord,
        tasks: Option<&TaskManager>,
    ) -> Result<ImportJob, String> {
        self.start_with_timeout(playlist_url, PlaylistImportTimeout::Auto, user, tasks)
            .await
    }

    /// Starts a Spotify playlist import with the timeout selected for this job.
    pub async fn start_with_timeout(
        &self,
        playlist_url: &str,
        timeout: PlaylistImportTimeout,
        user: &UserRecord,
        tasks: Option<&TaskManager>,
    ) -> Result<ImportJob, String> {
        if user.disabled {
            return Err(String::from("Import owner is disabled"));
        }
        if !user.is_admin() && !user.external_playback_enabled {
            return Err(String::from("Downloads are not enabled for this user"));
        }
        let Some((_, canonical_url)) = parse_spotify_playlist_url(playlist_url) else {
            return Err(String::from(
                "Please enter a valid open.spotify.com/playlist URL",
            ));
        };
        timeout.validate()?;

        let mut tx = match &self.db {
            Some(pool) => Some(
                crate::db::begin_sqlite_write(
                    pool.inner(),
                    "UPDATE import_jobs SET status=status WHERE 0",
                )
                .await
                .map_err(|err| format!("STORAGE:{err}"))?,
            ),
            None if tasks.is_some() => return Err("STORAGE:Database is unavailable".into()),
            None => None,
        };
        let mut resumed = None;
        if let Some(tx) = &mut tx {
            let manifest: Option<String> = sqlx::query_scalar(
                "SELECT manifest_json FROM import_jobs
                 WHERE user_id=? AND json_extract(CASE WHEN json_valid(manifest_json) THEN manifest_json END, '$.playlistUrl')=?
                   AND (status IN ('PENDING','PROCESSING') OR
                       json_extract(CASE WHEN json_valid(manifest_json) THEN manifest_json END, '$.job.status') IN ('failed','cancelled','partial'))
                 ORDER BY status IN ('PENDING','PROCESSING') DESC, created_at DESC, id DESC LIMIT 1",
            ).bind(&user.id).bind(&canonical_url).fetch_optional(&mut **tx).await.map_err(|err| format!("STORAGE:{err}"))?;
            let existing = manifest
                .map(|json| serde_json::from_str::<StoredImportJob>(&json))
                .transpose()
                .map_err(|err| format!("STORAGE:{err}"))?;
            if let Some(existing) = &existing
                && matches!(existing.job.status.as_str(), "queued" | "running")
            {
                return Ok(existing.job.clone());
            }
            let limits = self
                .library
                .as_ref()
                .map(|library| {
                    library
                        .config
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .acquisition_limits
                })
                .unwrap_or_default();
            super::admission::admit(tx, &user.id, limits).await?;
            if let (Some(mut existing), Some(manager)) = (existing, tasks) {
                let ids: Vec<String> = sqlx::query_scalar(
                    "SELECT id FROM background_tasks WHERE type='SPOTDL_IMPORT' AND payload_json=?",
                )
                .bind(json!({ "kind":"playlist", "jobId":existing.job.id }).to_string())
                .fetch_all(&mut **tx)
                .await
                .map_err(|err| format!("STORAGE:{err}"))?;
                if ids.iter().any(|id| manager.is_executing(id)) {
                    return Err("CAPACITY:1".into());
                }
                existing.job.status = "queued".into();
                existing.job.stage = "queued".into();
                existing.job.error = None;
                existing.timeout = timeout;
                SqliteImportJobRepository::save_on(&existing, &mut **tx).await?;
                let task = manager
                    .enqueue_on(
                        tx,
                        TaskType::SpotdlImport,
                        json!({ "kind": "playlist", "jobId": existing.job.id }),
                        &user.id,
                        None,
                    )
                    .await
                    .map_err(|err| format!("STORAGE:{err}"))?;
                resumed = Some((existing.job, task));
            }
        }

        if let Some((job, task)) = resumed {
            tx.take()
                .expect("admission transaction")
                .commit()
                .await
                .map_err(|err| format!("STORAGE:{err}"))?;
            if let Some(manager) = tasks {
                manager.notify_committed(&task);
            }
            return Ok(job);
        }

        let id = format!("spimp_{}", nanoid!(16));
        let job = ImportJob {
            id: id.clone(),
            user_id: user.id.clone(),
            status: String::from("queued"),
            stage: String::from("queued"),
            playlist_id: None,
            playlist_name: None,
            playlist_description: None,
            playlist_artwork_url: None,
            expected_count: None,
            discovered_count: None,
            downloaded_count: Some(0),
            current_track: None,
            current_track_name: None,
            imported_count: Some(0),
            error: None,
            completed_count: Some(0),
            failed_count: Some(0),
            manifest: None,
        };

        let record = StoredImportJob {
            job: job.clone(),
            playlist_url: canonical_url,
            user: json!({
                "id": user.id,
                "username": user.username,
                "role": user.role,
                "disabled": user.disabled,
                "externalPlaybackEnabled": user.external_playback_enabled,
            }),
            unreadable_manifest: None,
            playlist_intent: None,
            timeout,
            download_sample: None,
        };
        if let Some(mut tx) = tx {
            SqliteImportJobRepository::save_on(&record, &mut *tx).await?;
            let task = if let Some(manager) = tasks {
                Some(
                    manager
                        .enqueue_on(
                            &mut tx,
                            TaskType::SpotdlImport,
                            json!({ "kind": "playlist", "jobId": id }),
                            &user.id,
                            None,
                        )
                        .await
                        .map_err(|err| err.to_string())?,
                )
            } else {
                None
            };
            tx.commit().await.map_err(|err| err.to_string())?;
            if let (Some(manager), Some(task)) = (tasks, task) {
                manager.notify_committed(&task);
            }
        } else if let Ok(mut guard) = self.jobs.write() {
            guard.insert(id.clone(), job.clone());
        }

        Ok(job)
    }

    /// Settles interrupted jobs before the task pump starts.
    pub async fn recover_interrupted_jobs(&self) -> Result<(), String> {
        let Some(pool) = &self.db else {
            return Ok(());
        };
        let repo = SqliteImportJobRepository::new(pool.clone());
        for mut record in repo.read_unfinished().await.map_err(|e| e.to_string())? {
            if record.unreadable_manifest.is_none() {
                let mut tx = crate::db::begin_sqlite_write(
                    pool.inner(),
                    "UPDATE import_jobs SET status=status WHERE 0",
                )
                .await
                .map_err(|err| err.to_string())?;
                let now = Utc::now().to_rfc3339();
                let resumed = sqlx::query(
                    "UPDATE background_tasks SET state='QUEUED', error=NULL, started_at=NULL,
                        finished_at=NULL, updated_at=?
                     WHERE type='SPOTDL_IMPORT'
                       AND payload_json=?
                       AND (state IN ('QUEUED', 'PROCESSING', 'PAUSED') OR
                            (state='FAILED' AND error='Task was interrupted by a server restart'))",
                )
                .bind(&now)
                .bind(json!({ "kind": "playlist", "jobId": record.job.id }).to_string())
                .execute(&mut *tx)
                .await
                .map_err(|err| err.to_string())?
                .rows_affected();
                if resumed > 0 {
                    record.job.status = "queued".into();
                    SqliteImportJobRepository::save_on(&record, &mut *tx).await?;
                    tx.commit().await.map_err(|err| err.to_string())?;
                    continue;
                }
            }
            let queued = record.job.status == "queued"
                && sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM background_tasks WHERE type='SPOTDL_IMPORT'
                AND state='QUEUED' AND payload_json=?)",
                )
                .bind(json!({ "kind": "playlist", "jobId": record.job.id }).to_string())
                .fetch_one(pool.inner())
                .await
                .map_err(|err| err.to_string())?;
            if !queued {
                record.job.status = "failed".into();
                record.job.stage = "completed".into();
                record.job.error = Some(
                    "Playlist import was interrupted. Submit the same link to resume it.".into(),
                );
                record.job.current_track = None;
                record.job.current_track_name = None;
                if let Err(error) = repo.save(&record).await {
                    tracing::warn!(job_id = %record.job.id, %error, "Could not mark interrupted playlist import as failed");
                }
            }
        }
        Ok(())
    }

    pub async fn cancel(
        &self,
        id: &str,
        user_id: &str,
        manager: &TaskManager,
    ) -> Result<ImportJob, TaskError> {
        let pool = self.db.as_ref().ok_or(TaskError::NotFound)?;
        let job = self.get(id, user_id).await.ok_or(TaskError::NotFound)?;
        if job.status == "cancelled" {
            return Ok(job);
        }
        let task_id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM background_tasks WHERE type='SPOTDL_IMPORT' AND created_by=?
             AND payload_json=? AND state IN ('QUEUED','PROCESSING','PAUSED') LIMIT 1",
        )
        .bind(user_id)
        .bind(json!({ "kind": "playlist", "jobId": id }).to_string())
        .fetch_optional(pool.inner())
        .await
        .map_err(import_db_error)?;
        let task_id = task_id.ok_or_else(|| {
            TaskError::Conflict("Only an active playlist import can be cancelled".into())
        })?;
        manager.cancel(&task_id).await?;
        self.get(id, user_id).await.ok_or(TaskError::NotFound)
    }

    /// Retrieves a [`ImportJob`] by `(job_id, user_id)`.
    pub async fn get(&self, job_id: &str, user_id: &str) -> Option<ImportJob> {
        if let Some(pool) = &self.db {
            let repo = SqliteImportJobRepository::new(pool.clone());
            return repo.get(job_id, user_id).await.map(|stored| stored.job);
        }
        if let Ok(guard) = self.jobs.read() {
            if let Some(job) = guard.get(job_id) {
                if job.user_id == user_id {
                    return Some(job.clone());
                }
            }
        }
        None
    }

    /// Retrieves a [`ImportJob`] by `job_id` regardless of owner (used by background workers).
    pub async fn get_by_id(&self, job_id: &str) -> Option<ImportJob> {
        if let Some(pool) = &self.db {
            let repo = SqliteImportJobRepository::new(pool.clone());
            return repo.get_by_id(job_id).await.map(|stored| stored.job);
        }
        if let Ok(guard) = self.jobs.read() {
            if let Some(job) = guard.get(job_id) {
                return Some(job.clone());
            }
        }
        None
    }

    /// Runs the downloader and imports its output into the shared Navidrome library.
    pub async fn run_managed_job(
        &self,
        job_id: &str,
        context: &TaskRunContext,
        downloader: &SpotDLDownloaderAdapter,
        output_dir: Option<&Path>,
    ) -> Result<ImportJob, TaskError> {
        context.checkpoint().await?;
        let pool = self
            .db
            .as_ref()
            .or_else(|| context.db())
            .ok_or(TaskError::NotFound)?;
        let repo = SqliteImportJobRepository::new(pool.clone());
        let mut record = repo.get_by_id(job_id).await.ok_or(TaskError::NotFound)?;
        if record.job.status == "cancelled" {
            return Err(TaskError::Cancelled);
        }
        if record.unreadable_manifest.is_some() || record.job.status == "failed" {
            return Err(TaskError::ExecutionFailed(
                record
                    .job
                    .error
                    .clone()
                    .unwrap_or_else(|| "Spotify playlist import failed".into()),
            ));
        }
        if matches!(record.job.status.as_str(), "completed" | "partial")
            && record.job.playlist_id.is_some()
        {
            return Ok(record.job);
        }

        let config = self.library.as_ref().map(|library| {
            library
                .config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        });
        let staging_root = output_dir
            .map(Path::to_path_buf)
            .or_else(|| {
                config
                    .as_deref()
                    .map(|cfg| PathBuf::from(&cfg.acquisition_tmp_dir))
            })
            .unwrap_or_else(|| std::env::temp_dir().join("musicdeck-playlist"));
        let staging_dir = staging_path(&staging_root, job_id).map_err(|err| {
            TaskError::ExecutionFailed(format!("Could not resolve import staging directory: {err}"))
        })?;

        let result = self
            .ingest(
                &repo,
                &mut record,
                context,
                downloader,
                &staging_dir,
                config.as_deref(),
            )
            .await;
        if let Err(err) = &result {
            if matches!(err, TaskError::Cancelled) || context.cancel_token().is_cancelled() {
                return Err(TaskError::Cancelled);
            }
            let keep_intent = record.playlist_intent.is_some();
            if keep_intent {
                // Reload the durable checkpoint so a failed commit cannot discard
                // the upstream ID or an earlier create attempt.
                let Some(checkpoint) = repo.get_by_id(job_id).await else {
                    return result.map(|()| record.job);
                };
                if matches!(checkpoint.job.status.as_str(), "completed" | "partial")
                    && checkpoint.job.playlist_id.is_some()
                {
                    return Ok(checkpoint.job);
                }
                record = checkpoint;
            }
            if let Some(current) = repo.get_by_id(job_id).await {
                if current.job.status == "cancelled" {
                    return Err(TaskError::Cancelled);
                }
                record.job.stage = current.job.stage;
                record.job.downloaded_count = current.job.downloaded_count;
                record.job.discovered_count = current.job.discovered_count;
                record.job.expected_count =
                    record.job.expected_count.or(current.job.expected_count);
            }
            record.job.error = Some(err.to_string());
            record.job.current_track = None;
            record.job.current_track_name = None;
            let committed = match record.job.playlist_id.as_deref() {
                Some(id) => sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM playlist_items WHERE playlist_id=?",
                )
                .bind(id)
                .fetch_one(pool.inner())
                .await
                .map_err(import_db_error)? as usize,
                None => 0,
            };
            record.job.status = if record.job.playlist_id.is_some() {
                "partial"
            } else {
                "failed"
            }
            .into();
            record.job.imported_count = Some(committed);
            record.job.completed_count = Some(committed);
            record.job.failed_count = record
                .job
                .expected_count
                .map(|expected| expected.saturating_sub(committed));
            repo.save(&record)
                .await
                .map_err(TaskError::ExecutionFailed)?;
            tracing::warn!(job_id, error = %err, "Spotify playlist import failed");
            // Keep any unpublished audio available for recovery.
            if !keep_intent
                && !super::spotify_playlist::has_checkpoint(&staging_dir).await
                && scan_downloaded_audio_files(&staging_dir)
                    .await
                    .is_ok_and(|files| files.is_empty())
            {
                cleanup_staging(&staging_dir).await;
            }
        }
        result.map(|()| record.job)
    }

    async fn ingest(
        &self,
        repo: &SqliteImportJobRepository,
        record: &mut StoredImportJob,
        context: &TaskRunContext,
        downloader: &SpotDLDownloaderAdapter,
        staging_dir: &Path,
        config: Option<&AppConfig>,
    ) -> Result<(), TaskError> {
        if record.user.get("disabled").and_then(Value::as_bool) == Some(true) {
            return Err(TaskError::ExecutionFailed(
                "Import owner is disabled".into(),
            ));
        }
        if let Some(intent) = &record.playlist_intent
            && record.job.playlist_id.is_none()
        {
            let backend = self
                .library
                .as_ref()
                .and_then(|library| {
                    library
                        .providers
                        .get_by_connection_id(&intent.connection_id)
                })
                .ok_or_else(|| {
                    TaskError::ExecutionFailed("The Navidrome import backend is unavailable".into())
                })?;
            return self
                .complete_bounded(repo, record, context, backend.provider.as_ref())
                .await;
        }

        let (spotify_id, url) =
            parse_spotify_playlist_url(&record.playlist_url).ok_or_else(|| {
                TaskError::Validation("Stored Spotify playlist URL is invalid".into())
            })?;
        let library = match self.library.as_ref().zip(config) {
            Some((library, config)) => Some(library.ready(config).await?),
            None => None,
        };
        let stage = resume::open_stage(
            staging_dir,
            library.as_ref().map(|(_, root)| root.as_path()),
        )
        .await?;
        record.job.status = "running".into();
        record.job.stage = "download".into();
        let attribution = spotify_playlist_description(None, &url);
        if !record
            .job
            .playlist_description
            .as_deref()
            .is_some_and(|desc| desc.ends_with(&attribution))
        {
            record.job.playlist_description = Some(spotify_playlist_description(
                record.job.playlist_description.as_deref(),
                &url,
            ));
        }
        repo.save(record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        let started = Instant::now();
        let history = if record.timeout == PlaylistImportTimeout::Auto {
            repo.historical_download_rate(&record.job.user_id)
                .await
                .unwrap_or_default()
        } else {
            None
        };
        let deadline = PlaylistDeadline::new(record.timeout, history, started).hard_deadline();
        let mut manifest = match resume::load(&stage).await? {
            Some(manifest) => manifest,
            None => match record.job.manifest.clone() {
                Some(mut entries) if !entries.is_empty() => {
                    entries.sort_by_key(|entry| entry.position);
                    for entry in &mut entries {
                        if entry.library_path.is_none()
                            && entry
                                .file_path
                                .as_deref()
                                .is_some_and(|path| Path::new(path).is_relative())
                        {
                            entry.library_path = entry.file_path.take();
                        }
                    }
                    ManifestDownload {
                        expected_count: record.job.expected_count.unwrap_or(entries.len()),
                        name: record.job.playlist_name.clone(),
                        entries,
                        indexed_connection: None,
                    }
                }
                _ => {
                    let job_id = &record.job.id;
                    resume::discover(
                        context,
                        downloader,
                        &stage,
                        &[Operand::Spotify { url: url.clone() }],
                        true,
                        deadline,
                        |update| repo.report_download(job_id, context.task_id(), update, None),
                    )
                    .await?
                }
            },
        };
        record.job.expected_count = Some(manifest.expected_count);
        record.job.discovered_count = Some(manifest.expected_count);
        record.job.playlist_name.get_or_insert_with(|| {
            manifest.name.clone().unwrap_or_else(|| {
                format!(
                    "Spotify Playlist {}",
                    &spotify_id[..spotify_id.len().min(8)]
                )
            })
        });
        record.job.manifest = Some(manifest.entries.clone());
        repo.save(record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        let previous_ready = manifest
            .entries
            .iter()
            .filter(|entry| entry.file_path.is_some() || entry.library_path.is_some())
            .count();
        let job_id = record.job.id.clone();
        let download_error = resume::fetch_missing(
            context,
            downloader,
            &repo.db,
            &stage,
            library.as_ref().map(|(_, root)| root.as_path()),
            &mut manifest,
            record.timeout,
            deadline,
            |update| repo.report_download(&job_id, context.task_id(), update, None),
        )
        .await?;
        let downloaded = manifest
            .entries
            .iter()
            .filter(|entry| entry.file_path.is_some() || entry.library_path.is_some())
            .count();
        record.job.downloaded_count = Some(downloaded);
        record.job.manifest = Some(manifest.entries.clone());
        let new_audio = manifest
            .entries
            .iter()
            .filter(|entry| entry.file_path.is_some())
            .count()
            .saturating_sub(previous_ready);
        if new_audio >= 5 {
            record.download_sample = Some(PlaylistDownloadSample {
                elapsed_ms: started.elapsed().as_millis() as u64,
                downloaded_tracks: new_audio as u64,
            });
        }
        repo.save(record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        if downloaded == 0 {
            return Err(download_error.unwrap_or_else(|| {
                TaskError::ExecutionFailed(first_import_error(
                    &record.job,
                    "No usable tracks were downloaded",
                ))
            }));
        }
        let (backend, root) = library.ok_or_else(|| {
            TaskError::ExecutionFailed(
                "Shared Navidrome library is not configured for playlist imports".into(),
            )
        })?;
        let scan_deadline = Instant::now() + POST_DOWNLOAD_TIMEOUT;
        let journal = PublicationJournal {
            db: &repo.db,
            job_id: &job_id,
        };
        within_phase(
            context,
            scan_deadline,
            "publication",
            resume::publish(
                context,
                &journal,
                &stage,
                &root,
                &mut manifest,
                &downloader.tagger(),
            ),
        )
        .await?;
        record.job.stage = "scan".into();
        record.job.current_track = None;
        record.job.manifest = Some(manifest.entries.clone());
        repo.save(record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        let progress_job_id = job_id.as_str();
        let indexed = within_phase(context, scan_deadline, "scan", resume::index(context, backend.provider.as_ref(), &backend.connection_id, &stage, &root, &mut manifest, |count| async move {
            let result = sqlx::query("UPDATE import_jobs SET manifest_json=json_set(manifest_json,'$.job.importedCount',?),updated_at=? WHERE id=? AND status='PROCESSING'")
                .bind(count as i64).bind(Utc::now().to_rfc3339()).bind(progress_job_id).execute(repo.db.inner()).await;
            if let Err(error) = result { tracing::warn!(%error, "Could not report indexed playlist tracks"); }
        })).await;
        record.job.manifest = Some(manifest.entries);
        indexed?;

        let library =
            LibraryService::new(repo.db.clone(), Some(root.to_string_lossy().into_owned()));
        let connection = backend.connection_id;
        let mut known_ids = HashMap::new();
        let tracks = within_phase(context, scan_deadline, "indexing", async {
            let mut tracks = Vec::new();
            for entry in record.job.manifest.iter().flatten() {
                let Some(id) = entry.provider_track_id.as_ref() else {
                    continue;
                };
                let library_id = if let Some(id) = known_ids.get(id) {
                    String::clone(id)
                } else {
                    let library_id = library
                        .ensure_id(
                            LibraryItemType::Track,
                            &SourceRef {
                                connection_id: connection.clone(),
                                provider_item_id: id.clone(),
                            },
                            None,
                        )
                        .await
                        .map_err(import_db_error)?;
                    known_ids.insert(id.clone(), library_id.clone());
                    library_id
                };
                tracks.push((id.clone(), library_id));
            }
            Ok(tracks)
        })
        .await?;
        if tracks.is_empty() {
            return Err(TaskError::ExecutionFailed(first_import_error(
                &record.job,
                "None of the files could be indexed by Navidrome",
            )));
        }
        record.job.imported_count = Some(tracks.len());
        let prior = record
            .playlist_intent
            .take()
            .filter(|intent| intent.connection_id == connection);
        record.playlist_intent = Some(PlaylistCreationIntent {
            marker: format!("MusicDeck import {}", record.job.id),
            connection_id: connection,
            tracks,
            attempted: prior.as_ref().is_some_and(|intent| intent.attempted),
            attempted_at: prior.as_ref().and_then(|intent| intent.attempted_at),
            upstream_id: prior.and_then(|intent| intent.upstream_id),
        });
        self.complete_bounded(repo, record, context, backend.provider.as_ref())
            .await?;
        if record.job.status == "completed" {
            cleanup_staging(&stage).await;
        }
        Ok(())
    }

    async fn complete_bounded(
        &self,
        repo: &SqliteImportJobRepository,
        record: &mut StoredImportJob,
        context: &TaskRunContext,
        provider: &dyn MusicBackend,
    ) -> Result<(), TaskError> {
        within_phase(
            context,
            Instant::now() + PLAYLIST_CREATION_TIMEOUT,
            "playlist creation",
            async {
                record.job.status = "running".into();
                record.job.stage = "playlist_creation".into();
                repo.save(record)
                    .await
                    .map_err(TaskError::ExecutionFailed)?;
                context
                    .report(TaskProgressPatch {
                        percent: Some(95.0),
                        message: Some(Some("Creating playlist".into())),
                        ..Default::default()
                    })
                    .await;
                self.complete_playlist_intent(repo, record, context, provider)
                    .await
            },
        )
        .await
    }

    async fn complete_playlist_intent(
        &self,
        repo: &SqliteImportJobRepository,
        record: &mut StoredImportJob,
        context: &TaskRunContext,
        provider: &dyn MusicBackend,
    ) -> Result<(), TaskError> {
        let intent = record
            .playlist_intent
            .as_ref()
            .expect("persisted playlist intent")
            .clone();
        let track_ids: Vec<String> = intent.tracks.iter().map(|(id, _)| id.clone()).collect();
        let existing = match intent.upstream_id.as_deref() {
            Some(id) => provider
                .get_playlist(id)
                .await
                .map_err(import_provider_error)?,
            None => None,
        };
        let upstream_id = if let Some(existing) = existing {
            existing.provider_id
        } else {
            let mut markers = matching_markers(provider, &intent.marker).await?;
            if markers.is_empty()
                && let Some(attempted) = intent.attempted_at
            {
                // Allow a previous timed-out request to become visible before creating again.
                let wait = attempted
                    .saturating_add(30_000)
                    .saturating_sub(Utc::now().timestamp_millis())
                    .clamp(0, 30_000);
                if wait > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(wait as u64)).await;
                    markers = matching_markers(provider, &intent.marker).await?;
                }
            }
            let id = if let Some(id) = markers.first() {
                id.clone()
            } else {
                context.checkpoint().await?;
                repo.claim_playlist_creation(record, context.task_id())
                    .await?;
                provider
                    .create_imported_playlist(&intent.marker, &track_ids)
                    .await
                    .map_err(import_provider_error)?
            };
            // Remove surplus internal markers only after checking their names and local ownership.
            for duplicate in markers.into_iter().filter(|duplicate| duplicate != &id) {
                let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playlists WHERE source_connection_id=? AND source_playlist_id=?)")
                    .bind(&intent.connection_id).bind(&duplicate).fetch_one(repo.db.inner()).await.map_err(import_db_error)?;
                if !linked
                    && provider
                        .get_playlist(&duplicate)
                        .await
                        .map_err(import_provider_error)?
                        .is_some_and(|playlist| playlist.name == intent.marker)
                {
                    provider
                        .delete_playlist(&duplicate)
                        .await
                        .map_err(import_provider_error)?;
                }
            }
            record.playlist_intent.as_mut().unwrap().upstream_id = Some(id.clone());
            repo.save(record)
                .await
                .map_err(TaskError::ExecutionFailed)?;
            id
        };
        let current = provider
            .get_playlist(&upstream_id)
            .await
            .map_err(import_provider_error)?;
        if current.is_some_and(|playlist| {
            !playlist.tracks.is_some_and(|tracks| {
                tracks
                    .iter()
                    .map(|track| &track.provider_id)
                    .eq(track_ids.iter())
            })
        }) {
            provider
                .replace_imported_playlist_tracks(&upstream_id, &track_ids)
                .await
                .map_err(import_provider_error)?;
        }
        let job = &mut record.job;
        let name = job
            .playlist_name
            .as_deref()
            .ok_or_else(|| TaskError::Validation("Missing import playlist name".into()))?;
        context.checkpoint().await?;
        let playlist = provider
            .finalize_imported_playlist(
                &upstream_id,
                name,
                job.playlist_description.as_deref().unwrap_or_default(),
            )
            .await
            .map_err(import_provider_error)?;
        if !playlist
            .and_then(|playlist| playlist.tracks)
            .is_some_and(|tracks| {
                tracks
                    .iter()
                    .map(|track| &track.provider_id)
                    .eq(track_ids.iter())
            })
        {
            return Err(TaskError::ExecutionFailed(
                "Navidrome did not attach all requested tracks in order".into(),
            ));
        }

        let local_id = format!("mdpl_{}", job.id);
        for entry in job.manifest.iter_mut().flatten() {
            if entry.status == ImportEntryStatus::Ready {
                entry.status = ImportEntryStatus::Completed;
            }
        }
        let completed = intent.tracks.len();
        let expected = job.expected_count.unwrap_or(completed);
        let failed = expected.saturating_sub(completed);
        job.playlist_id = Some(local_id.clone());
        job.imported_count = Some(completed);
        job.completed_count = Some(completed);
        job.failed_count = Some(failed);
        job.current_track = None;
        job.current_track_name = None;
        job.status = if failed > 0 { "partial" } else { "completed" }.into();
        job.stage = "completed".into();
        job.error = (failed > 0).then(|| {
            format!(
                "Imported {completed} of {expected} tracks. {}",
                first_import_error(job, "Some Spotify tracks were unavailable.")
            )
        });
        repo.finish_playlist(
            record,
            &local_id,
            &intent.connection_id,
            &upstream_id,
            &intent.tracks,
            context.task_id(),
        )
        .await
    }
}

async fn matching_markers(
    provider: &dyn MusicBackend,
    marker: &str,
) -> Result<Vec<String>, TaskError> {
    let mut ids: Vec<_> = provider
        .list_playlists()
        .await
        .map_err(import_provider_error)?
        .into_iter()
        .filter(|playlist| playlist.name == marker)
        .map(|playlist| playlist.provider_id)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn import_provider_error(error: crate::providers::ProviderError) -> TaskError {
    TaskError::ExecutionFailed(format!("Navidrome playlist import failed: {error}"))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SpotdlPlaylistTrack {
    name: Option<String>,
    artist: Option<String>,
    artists: Option<Vec<String>>,
    url: Option<String>,
    song_id: Option<String>,
    album_name: Option<String>,
    album_artist: Option<String>,
    duration: Option<f64>,
    isrc: Option<String>,
    list_name: Option<String>,
    list_length: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ManifestDownload {
    pub entries: Vec<ImportEntry>,
    pub expected_count: usize,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexed_connection: Option<String>,
}

pub(super) async fn download_manifest<F>(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    request: &TrackImportRequest,
    job_id: &str,
    deadline: Option<PlaylistDeadline>,
    hard_deadline: Instant,
    persist: impl FnMut(DownloadTelemetry) -> F,
) -> Result<ManifestDownload, TaskError>
where
    F: std::future::Future<Output = ()> + Send,
{
    let m3u_name = request
        .playlist_m3u_name
        .as_deref()
        .ok_or_else(|| TaskError::Validation("Download requires a track manifest".into()))?;
    let stage = &request.output_directory;
    let output = monitor_download(
        context,
        downloader,
        request,
        deadline,
        hard_deadline,
        persist,
    )
    .await;
    if matches!(output, Err(TaskError::Cancelled)) {
        return Err(TaskError::Cancelled);
    }
    let stage = fs::canonicalize(stage).await.map_err(import_db_error)?;
    let (files, track_errors, failed) = match output {
        Ok(output) => (
            output.files,
            output.track_errors,
            output
                .failure
                .map(|error| TaskError::ExecutionFailed(error.to_string())),
        ),
        Err(error) => (
            scan_downloaded_audio_files(&stage)
                .await
                .map_err(import_db_error)?,
            HashMap::new(),
            Some(error),
        ),
    };
    if files.is_empty()
        && let Some(error) = failed
    {
        return Err(error);
    }
    let mut staged_files = HashSet::new();
    for path in files {
        if let Some(path) = staged_playlist_path(&stage, &path.to_string_lossy()).await {
            staged_files.insert(path);
        }
    }
    let source_json = read_playlist_artifact(&stage.join("musicdeck-source.spotdl")).await;
    let manifest = match read_playlist_artifact(&stage.join(m3u_name)).await {
        Ok(manifest) => manifest,
        Err(error) => {
            if let Ok(json) = &source_json {
                let mut recovered = resume::occurrence_manifest(json, false)?;
                resume::harvest(
                    context,
                    &stage,
                    staged_files.iter().cloned(),
                    &mut recovered,
                    &downloader.tagger(),
                )
                .await?;
                if recovered
                    .entries
                    .iter()
                    .any(|entry| entry.file_path.is_some())
                {
                    return Ok(recovered);
                }
            }
            return Err(failed.unwrap_or_else(|| {
                TaskError::ExecutionFailed(format!(
                    "spotDL did not provide a readable track manifest: {error}"
                ))
            }));
        }
    };
    let metadata: Vec<SpotdlPlaylistTrack> = source_json
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let name = metadata
        .iter()
        .filter_map(|entry| entry.list_name.as_deref())
        .map(str::trim)
        .find(|name| !name.is_empty())
        .map(|name| name.chars().take(200).collect());
    let metadata_by_id: HashMap<_, _> = metadata
        .iter()
        .filter_map(|track| Some((track.song_id.as_deref()?, track)))
        .collect();
    let mut entries = Vec::new();
    for (position, line) in manifest
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .enumerate()
    {
        context.checkpoint().await?;
        let stem = Path::new(line).file_stem().and_then(|stem| stem.to_str());
        let staged_id = stem
            .and_then(|stem| stem.rsplit_once(" ["))
            .and_then(|(_, id)| id.strip_suffix(']'))
            .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        let source = staged_id
            .and_then(|id| metadata_by_id.get(id).copied())
            .or_else(|| {
                metadata.get(position).filter(|track| {
                    staged_id
                        .zip(track.song_id.as_deref())
                        .is_none_or(|(file_id, manifest_id)| file_id == manifest_id)
                })
            });
        let title = source
            .and_then(|track| track.name.as_deref())
            .unwrap_or_default();
        let path = staged_playlist_path(&stage, line)
            .await
            .filter(|path| staged_files.contains(path));
        let mut entry = ImportEntry {
            position: position + 1,
            source: SpotifyImportTrackMetadata {
                position: position + 1,
                url: source
                    .and_then(|track| track.url.clone())
                    .unwrap_or_default(),
                title: title.to_owned(),
                artist: source
                    .and_then(|track| track.artist.clone())
                    .unwrap_or_default(),
                artists: source
                    .and_then(|track| track.artists.clone())
                    .unwrap_or_default(),
                duration: source.and_then(|track| track.duration).unwrap_or_default(),
                album: source.and_then(|track| track.album_name.clone()),
                album_artist: source.and_then(|track| track.album_artist.clone()),
                year: None,
                artwork_url: None,
                isrc: source.and_then(|track| track.isrc.clone()),
            },
            status: ImportEntryStatus::Downloaded,
            error: None,
            error_code: None,
            file_path: path.map(|path| path.to_string_lossy().into_owned()),
            library_path: None,
            library_reused: false,
            provider_track_id: None,
            duplicate_of: None,
            requires_scan: None,
            catalog: None,
        };
        if source.is_none() {
            entry.file_path = None;
            fail_import_entry(
                job_id,
                &mut entry,
                ImportEntryStatus::FailedMetadataMissing,
                "No matching source metadata was available".into(),
            );
        } else if entry.file_path.is_none() {
            let id = staged_id.or_else(|| source.and_then(|track| track.song_id.as_deref()));
            entry.error_code = id
                .and_then(|id| track_errors.get(id))
                .map(|code| (*code).to_owned());
            let message =
                downloader_error_message(entry.error_code.as_deref().unwrap_or("general"));
            fail_import_entry(
                job_id,
                &mut entry,
                ImportEntryStatus::FailedDownload,
                message.to_owned(),
            );
        }
        entries.push(entry);
    }
    if entries.is_empty() {
        return Err(TaskError::ExecutionFailed(
            "spotDL returned an empty playlist track list".into(),
        ));
    }
    let expected_count = entries.len().max(
        metadata
            .iter()
            .filter_map(|track| track.list_length)
            .filter(|length| *length <= i32::MAX as usize)
            .max()
            .unwrap_or(0),
    );
    Ok(ManifestDownload {
        expected_count,
        entries,
        name,
        indexed_connection: None,
    })
}

fn fail_import_entry(
    job_id: &str,
    entry: &mut ImportEntry,
    status: ImportEntryStatus,
    message: String,
) {
    tracing::warn!(job_id, position = entry.position, error = %message, "Spotify playlist track could not be imported");
    entry.status = status;
    entry.error = Some(message);
}

fn first_import_error(job: &ImportJob, fallback: &str) -> String {
    job.manifest
        .iter()
        .flatten()
        .find_map(|entry| entry.error.clone())
        .unwrap_or_else(|| fallback.to_owned())
}

fn import_db_error(err: impl std::fmt::Display) -> TaskError {
    TaskError::ExecutionFailed(format!("Could not save Spotify import to MusicDeck: {err}"))
}

#[cfg(test)]
mod playlist_intent_tests {
    use super::*;
    use crate::db::run_migrations;
    use crate::providers::{Playlist, Track, media_fixture};
    use crate::tasks::{TaskDefinition, TaskStatus};
    use std::time::Duration;

    #[tokio::test]
    async fn playlist_timeout_history_uses_download_samples_from_the_import_owner() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO import_jobs (id, user_id, status, manifest_json, created_at, updated_at) VALUES
                ('1', 'alice', 'COMPLETED', '{\"downloadSample\":{\"elapsedMs\":60000,\"downloadedTracks\":10}}', '1', '1'),
                ('2', 'alice', 'COMPLETED', '{\"downloadSample\":{\"elapsedMs\":20000,\"downloadedTracks\":10}}', '2', '2'),
                ('3', 'alice', 'COMPLETED', '{\"downloadSample\":{\"elapsedMs\":40000,\"downloadedTracks\":10}}', '3', '3'),
                ('4', 'alice', 'FAILED', 'invalid checkpoint', '4', '4'),
                ('5', 'bob', 'COMPLETED', '{\"downloadSample\":{\"elapsedMs\":90000,\"downloadedTracks\":10}}', '5', '5');",
        )
        .execute(db.inner())
        .await
        .unwrap();
        let repo = SqliteImportJobRepository::new(db);
        assert_eq!(
            repo.historical_download_rate("alice").await.unwrap(),
            Some(4_000)
        );
        assert_eq!(
            repo.historical_download_rate("bob").await.unwrap(),
            Some(9_000)
        );
        assert_eq!(
            repo.historical_download_rate("new-user").await.unwrap(),
            None
        );
    }

    struct ResumeImport(SpotifyPlaylistImportService);

    #[tokio::test]
    async fn restart_requeues_a_download_before_playlist_creation() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        let store = SpotifyPlaylistImportService::new(Some(db.clone()));
        let manager = TaskManager::new_with_dispatch(Some(db.clone()), false);
        manager.initialize_tables().await;
        manager.register(
            TaskType::SpotdlImport,
            Arc::new(ResumeImport(store.clone())),
        );
        let repo = SqliteImportJobRepository::new(db.clone());
        let record = serde_json::from_value::<StoredImportJob>(json!({
            "job": {"id":"spimp_mid_job","userId":"alice","status":"running","stage":"download"},
            "playlistUrl":"https://open.spotify.com/playlist/abc123",
            "user":{"id":"alice","disabled":false},
        }))
        .unwrap();
        repo.save(&record).await.unwrap();
        let task = manager
            .enqueue(
                TaskType::SpotdlImport,
                json!({"kind":"playlist","jobId":"spimp_mid_job"}),
                "alice",
                None,
            )
            .await
            .unwrap();
        sqlx::query("UPDATE background_tasks SET state='PROCESSING' WHERE id=?")
            .bind(&task.id)
            .execute(db.inner())
            .await
            .unwrap();
        manager.recover_interrupted_tasks().await;
        store.recover_interrupted_jobs().await.unwrap();
        assert_eq!(
            store.get_by_id("spimp_mid_job").await.unwrap().status,
            "queued"
        );
        let state: String = sqlx::query_scalar("SELECT state FROM background_tasks WHERE id=?")
            .bind(task.id)
            .fetch_one(db.inner())
            .await
            .unwrap();
        assert_eq!(state, "QUEUED");
        manager.close();
    }

    #[async_trait::async_trait]
    impl TaskDefinition for ResumeImport {
        fn validate(&self, payload: &Value) -> bool {
            payload.is_object()
        }
        async fn run(&self, payload: Value, context: TaskRunContext) -> Result<(), TaskError> {
            self.0
                .run_managed_job(
                    payload["jobId"].as_str().unwrap(),
                    &context,
                    &SpotDLDownloaderAdapter::new(),
                    None,
                )
                .await?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn startup_reconciles_a_playlist_created_before_its_remote_id_was_saved() {
        let db = DbPool::connect_memory().await.unwrap();
        run_migrations(&db, None).await.unwrap();
        sqlx::raw_sql("INSERT INTO roles VALUES ('user','Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('alice','alice','hash','Alice','user','2026-01-01','2026-01-01');")
            .execute(db.inner()).await.unwrap();
        let manager = TaskManager::new_with_dispatch(Some(db.clone()), false);
        manager.initialize_tables().await;
        let provider_track: Track = serde_json::from_value(json!({
            "id": "track", "providerId": "track", "title": "Fixture",
            "artistName": "Artist", "albumName": "Album", "streamUrl": ""
        }))
        .unwrap();
        let store = SpotifyPlaylistImportService::new(Some(db.clone())).with_library(
            Arc::new(RwLock::new(Arc::new(AppConfig::default()))),
            BackendRegistry::new(vec![media_fixture::playlist_provider(
                "fixture",
                Playlist {
                    id: "remote".into(),
                    provider_id: "remote".into(),
                    name: "MusicDeck import spimp_crash".into(),
                    description: None,
                    artwork_id: None,
                    artwork_url: None,
                    song_count: 2,
                    tracks: Some(vec![provider_track.clone(), provider_track]),
                },
            )]),
        );
        manager.register(
            TaskType::SpotdlImport,
            Arc::new(ResumeImport(store.clone())),
        );
        let library_id = LibraryService::new(db.clone(), None)
            .ensure_id(
                LibraryItemType::Track,
                &SourceRef {
                    connection_id: "fixture".into(),
                    provider_item_id: "track".into(),
                },
                None,
            )
            .await
            .unwrap();
        let repo = SqliteImportJobRepository::new(db.clone());
        let record = serde_json::from_value::<StoredImportJob>(json!({
            "job": {
                "id": "spimp_crash", "userId": "alice", "status": "running", "stage": "importing",
                "playlistName": "Desired name", "expectedCount": 2
            },
            "playlistUrl": "https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM",
            "user": {"id": "alice", "disabled": false},
            "playlistIntent": {"marker": "MusicDeck import spimp_crash", "connectionId": "fixture", "tracks": [["track", library_id], ["track", library_id]],
                "attempted": true, "upstreamId": null}
        })).unwrap();
        repo.save(&record).await.unwrap();
        let task = manager
            .enqueue(
                TaskType::SpotdlImport,
                json!({"kind":"playlist", "jobId":"spimp_crash"}),
                "alice",
                None,
            )
            .await
            .unwrap();
        sqlx::query("UPDATE background_tasks SET state='PROCESSING' WHERE id=?")
            .bind(&task.id)
            .execute(db.inner())
            .await
            .unwrap();

        manager.recover_interrupted_tasks().await;
        store.recover_interrupted_jobs().await.unwrap();
        manager.enable_dispatch();
        let task = manager
            .wait_for_settlement(&task.id, Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(task.state, TaskStatus::Finished, "{:?}", task.error);
        let saved = repo.get_by_id("spimp_crash").await.unwrap();
        assert_eq!(saved.job.playlist_id.as_deref(), Some("mdpl_spimp_crash"));
        assert_eq!(
            saved.playlist_intent.unwrap().upstream_id.as_deref(),
            Some("remote")
        );
        let tracks: Vec<(i64, String)> = sqlx::query_as(
            "SELECT position, provider_track_id FROM playlist_items WHERE playlist_id='mdpl_spimp_crash' ORDER BY position",
        ).fetch_all(db.inner()).await.unwrap();
        assert_eq!(tracks, vec![(0, "track".into()), (1, "track".into())]);
        manager.close();
    }
}
