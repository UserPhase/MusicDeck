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
use tokio::{fs, sync::mpsc};

use super::playlist_files::{
    AcquisitionLibrary, cleanup_staging, navidrome_path, publish_staged_track,
    read_playlist_artifact, staged_playlist_path, staging_path,
};
use crate::acquisition::spotdl::{
    AcquisitionProgress, SpotDLDownloadError, SpotDLDownloaderAdapter, TrackImportRequest,
    canonical_spotify_url, scan_downloaded_audio_files,
};
use crate::auth::UserRecord;
use crate::catalog::library::{LibraryItemType, LibraryService, SourceRef};
use crate::config::AppConfig;
use crate::db::DbPool;
use crate::providers::BackendRegistry;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_scan: Option<bool>,
}

/// Batch Spotify playlist import job state (`SpotifyImportJob` / `ImportJob`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub user_id: String,
    /// `"queued" | "running" | "completed" | "partial" | "failed"`.
    pub status: String,
    /// `"queued" | "fetching" | "downloading" | "scanning" | "completed"`.
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

/// Persisted checkpoint envelope stored in `import_jobs.manifest_json` (`StoredImportJob`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredImportJob {
    pub job: ImportJob,
    pub playlist_url: String,
    pub user: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable_manifest: Option<String>,
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
            "failed" | "partial" => "FAILED",
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
        let mut tx = self.db.inner().begin().await.map_err(import_db_error)?;
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM background_tasks WHERE id=? AND state IN ('PROCESSING','PAUSED'))")
            .bind(task_id).fetch_one(&mut *tx).await.map_err(import_db_error)?;
        if !active {
            return Err(TaskError::Cancelled);
        }
        sqlx::query(
            "INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id,
                source_playlist_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
                "queued" | "running" | "completed" | "partial" | "failed"
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
        };
        let _ = self.save(&fallback).await;
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
        };
        if let Some(pool) = &self.db {
            let mut tx = pool.inner().begin().await.map_err(|err| err.to_string())?;
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
        } else if tasks.is_some() {
            return Err("Database is unavailable".into());
        }

        if let Ok(mut guard) = self.jobs.write() {
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
                record.job.error = Some("Playlist import was interrupted by server restart. Start a new import to try again.".into());
                record.job.current_track = None;
                record.job.current_track_name = None;
                repo.save(&record).await?;
            }
        }
        Ok(())
    }

    /// Retrieves a [`ImportJob`] by `(job_id, user_id)`.
    pub async fn get(&self, job_id: &str, user_id: &str) -> Option<ImportJob> {
        if let Some(pool) = &self.db {
            let repo = SqliteImportJobRepository::new(pool.clone());
            if let Some(stored) = repo.get(job_id, user_id).await {
                if let Ok(mut guard) = self.jobs.write() {
                    guard.insert(job_id.to_owned(), stored.job.clone());
                }
                return Some(stored.job);
            }
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
            if let Some(stored) = repo.get_by_id(job_id).await {
                return Some(stored.job);
            }
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
            record.job.status = "failed".into();
            record.job.stage = "completed".into();
            record.job.error = Some(err.to_string());
            record.job.playlist_id = None;
            record.job.current_track = None;
            record.job.current_track_name = None;
            record.job.imported_count = Some(0);
            record.job.completed_count = Some(0);
            for entry in record.job.manifest.iter_mut().flatten() {
                if matches!(
                    entry.status,
                    ImportEntryStatus::Ready | ImportEntryStatus::Completed
                ) {
                    entry.status = ImportEntryStatus::FailedLinking;
                    entry.error = record.job.error.clone();
                }
            }
            if let Some(expected) = record.job.expected_count {
                record.job.failed_count = Some(expected);
            }
            repo.save(&record)
                .await
                .map_err(TaskError::ExecutionFailed)?;
            tracing::warn!(job_id, error = %err, "Spotify playlist import failed");
            // Keep any unpublished audio available for recovery.
            if scan_downloaded_audio_files(&staging_dir)
                .await
                .is_ok_and(|files| files.is_empty())
            {
                cleanup_staging(&staging_dir).await;
            }
        }
        if let Ok(mut cache) = self.jobs.write() {
            cache.insert(job_id.to_owned(), record.job.clone());
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
        let (spotify_id, url) =
            parse_spotify_playlist_url(&record.playlist_url).ok_or_else(|| {
                TaskError::Validation("Stored Spotify playlist URL is invalid".into())
            })?;
        let library = self
            .library
            .as_ref()
            .zip(config)
            .map(|(library, cfg)| async {
                let backend = library.providers.get_primary().map_err(|err| {
                    TaskError::ExecutionFailed(format!(
                        "Configure Navidrome before importing: {err}"
                    ))
                })?;
                if backend.provider_type != "navidrome" {
                    return Err(TaskError::ExecutionFailed(
                        "Spotify playlist import requires Navidrome as the primary backend".into(),
                    ));
                }
                let root = fs::canonicalize(&cfg.music_root).await.map_err(|err| {
                    TaskError::ExecutionFailed(format!(
                        "Could not open the shared music directory: {err}"
                    ))
                })?;
                Ok((backend, root, PathBuf::from(&cfg.spotify_import_subdir)))
            });
        let library = match library {
            Some(load) => Some(load.await?),
            None => None,
        };

        record.job.status = "running".into();
        record.job.stage = "downloading".into();
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
        fs::create_dir_all(staging_dir).await.map_err(|err| {
            TaskError::ExecutionFailed(format!(
                "Could not create playlist staging directory: {err}"
            ))
        })?;
        if !fs::symlink_metadata(staging_dir)
            .await
            .is_ok_and(|meta| meta.is_dir())
        {
            return Err(TaskError::ExecutionFailed(
                "Spotify import staging must be a regular directory".into(),
            ));
        }
        if record.job.manifest.is_some() {
            download_checkpointed_tracks(record, context, downloader, staging_dir).await?;
        } else {
            download_playlist(record, context, downloader, staging_dir, &url).await?;
        }
        let job = &mut record.job;
        job.playlist_name.get_or_insert_with(|| {
            format!(
                "Spotify Playlist {}",
                &spotify_id[..spotify_id.len().min(8)]
            )
        });
        let (backend, music_root, import_subdir) = library.ok_or_else(|| {
            TaskError::ExecutionFailed(
                "Shared Navidrome library is not configured for playlist imports".into(),
            )
        })?;
        let provider = backend.provider;
        let connection = backend.connection_id;
        let stage = fs::canonicalize(staging_dir).await.map_err(|err| {
            TaskError::ExecutionFailed(format!("Could not open playlist staging files: {err}"))
        })?;

        let mut entries = job.manifest.take().ok_or_else(|| {
            TaskError::ExecutionFailed("spotDL returned no playlist entries".into())
        })?;
        let expected = job.expected_count.unwrap_or(0).max(entries.len());
        job.expected_count = Some(expected);
        job.downloaded_count = Some(
            entries
                .iter()
                .filter(|entry| entry.status == ImportEntryStatus::Downloaded)
                .count(),
        );

        let collection = import_subdir.join(&job.id);
        let mut published = HashSet::new();
        for entry in &mut entries {
            if let Err(err) = context.checkpoint().await {
                job.manifest = Some(entries);
                return Err(err);
            }
            let Some(staged) = entry.file_path.take().map(PathBuf::from) else {
                continue;
            };
            let staged = fs::canonicalize(staged).await.ok();
            let transfer = async {
                let staged = staged
                    .as_deref()
                    .ok_or("Downloaded file is missing".to_owned())?;
                let relative = if published.contains(staged) {
                    collection.join(
                        staged
                            .strip_prefix(&stage)
                            .map_err(|_| "Downloaded file is outside staging".to_owned())?,
                    )
                } else {
                    let relative = publish_staged_track(&music_root, &collection, &stage, staged)
                        .await
                        .map_err(|err| {
                            format!("Could not save audio to the shared music directory: {err}")
                        })?;
                    published.insert(staged.to_path_buf());
                    relative
                };
                navidrome_path(&relative).ok_or("Invalid library import path".to_owned())
            }
            .await;
            match transfer {
                Ok(path) => entry.file_path = Some(path),
                Err(message) => {
                    fail_import_entry(&job.id, entry, ImportEntryStatus::FailedDownload, message);
                }
            }
        }
        job.manifest = Some(entries);
        job.stage = "scanning".into();
        repo.save(record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        if published.is_empty() {
            return Err(TaskError::ExecutionFailed(first_import_error(
                &record.job,
                "No audio could be saved to the music library",
            )));
        }

        context
            .report(TaskProgressPatch {
                message: Some(Some(
                    "Waiting for Navidrome to index the imported files".into(),
                )),
                ..Default::default()
            })
            .await;
        context.checkpoint().await?;
        let cancellation = context.cancel_token();
        tokio::select! {
            () = cancellation.cancelled() => return Err(TaskError::Cancelled),
            result = provider.scan_library() => result.map_err(|err| {
                TaskError::ExecutionFailed(format!("Audio was saved, but Navidrome could not finish scanning: {err}"))
            })?,
        };

        let library = LibraryService::new(
            repo.db.clone(),
            Some(music_root.to_string_lossy().into_owned()),
        );
        let job = &mut record.job;
        let entries = job.manifest.as_mut().expect("staged import manifest");
        let mut tracks = Vec::new();
        let mut resolved = HashMap::<String, (String, String)>::new();
        for entry in entries.iter_mut() {
            context.checkpoint().await?;
            let Some(path) = entry.file_path.as_deref() else {
                continue;
            };
            let ids = if let Some(ids) = resolved.get(path) {
                ids.clone()
            } else {
                let title = &entry.source.title;
                let lookup = tokio::select! {
                    () = cancellation.cancelled() => return Err(TaskError::Cancelled),
                    result = provider.find_imported_track(path, title) => result,
                };
                let track = match lookup {
                    Ok(Some(track)) => track,
                    Ok(None) => {
                        fail_import_entry(
                            &job.id,
                            entry,
                            ImportEntryStatus::FailedIndexing,
                            format!(
                                "Navidrome did not index {path} with its real path. Check the shared music mount and enable Report Real Path for the MusicDeck player."
                            ),
                        );
                        continue;
                    }
                    Err(err) => {
                        fail_import_entry(
                            &job.id,
                            entry,
                            ImportEntryStatus::FailedIndexing,
                            format!("Could not locate {path} in Navidrome: {err}"),
                        );
                        continue;
                    }
                };
                let provider_id = track.provider_id;
                let library_id = library
                    .ensure_id(
                        LibraryItemType::Track,
                        &SourceRef {
                            connection_id: connection.clone(),
                            provider_item_id: provider_id.clone(),
                        },
                        None,
                    )
                    .await
                    .map_err(import_db_error)?;
                let ids = (provider_id, library_id);
                resolved.insert(path.to_owned(), ids.clone());
                ids
            };
            entry.provider_track_id = Some(ids.0.clone());
            entry.status = ImportEntryStatus::Ready;
            tracks.push(ids);
        }

        if tracks.is_empty() {
            return Err(TaskError::ExecutionFailed(first_import_error(
                job,
                "None of the downloaded files were indexed by Navidrome",
            )));
        }
        context.checkpoint().await?;
        let track_ids: Vec<String> = tracks
            .iter()
            .map(|(provider_id, _)| provider_id.clone())
            .collect();
        let upstream_id = provider
            .create_imported_playlist(
                job.playlist_name.as_deref().expect("import playlist name"),
                job.playlist_description.as_deref().unwrap_or_default(),
                &track_ids,
            )
            .await
            .map_err(|err| {
                TaskError::ExecutionFailed(format!(
                    "Navidrome could not create the playlist: {err}"
                ))
            })?;
        let local_id = format!("mdpl_{}", job.id);
        for entry in job.manifest.as_mut().expect("indexed import manifest") {
            if entry.status == ImportEntryStatus::Ready {
                entry.status = ImportEntryStatus::Completed;
            }
        }
        let completed = tracks.len();
        let failed = expected - completed;
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
        if let Err(err) = repo
            .finish_playlist(
                record,
                &local_id,
                &connection,
                &upstream_id,
                &tracks,
                context.task_id(),
            )
            .await
        {
            if let Err(cleanup) = provider.delete_playlist(&upstream_id).await {
                tracing::warn!(playlist_id = upstream_id, error = %cleanup, "Could not remove unlinked Navidrome import playlist");
            }
            return Err(err);
        }
        if failed == 0
            && scan_downloaded_audio_files(&stage)
                .await
                .is_ok_and(|files| files.iter().all(|file| published.contains(file)))
        {
            cleanup_staging(staging_dir).await;
        }
        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(expected as u64),
                total_items: Some(Some(expected as u64)),
                message: Some(Some(format!("Imported {completed} of {expected} tracks"))),
                ..Default::default()
            })
            .await;
        Ok(())
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SpotdlPlaylistTrack {
    name: String,
    artist: String,
    url: String,
    list_name: Option<String>,
    list_length: Option<usize>,
}

async fn download_playlist(
    record: &mut StoredImportJob,
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    stage: &Path,
    url: &str,
) -> Result<(), TaskError> {
    let m3u_name = format!("musicdeck-{}.m3u8", record.job.id);
    let request = TrackImportRequest {
        spotify_track_url: Some(url.to_owned()),
        output_directory: stage.to_path_buf(),
        playlist_m3u_name: Some(m3u_name),
        ..Default::default()
    };
    let batch = download_manifest(context, downloader, &request, &record.job.id).await?;
    if let Some(name) = batch.name {
        record.job.playlist_name.get_or_insert(name);
    }
    record.job.expected_count = Some(batch.expected_count);
    record.job.manifest = Some(batch.entries);
    Ok(())
}

pub(super) struct ManifestDownload {
    pub entries: Vec<ImportEntry>,
    pub expected_count: usize,
    pub name: Option<String>,
}

pub(super) async fn download_manifest(
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    request: &TrackImportRequest,
    job_id: &str,
) -> Result<ManifestDownload, TaskError> {
    let m3u_name = request
        .playlist_m3u_name
        .as_deref()
        .ok_or_else(|| TaskError::Validation("Download requires a track manifest".into()))?;
    let stage = &request.output_directory;
    let (tx, mut rx) = mpsc::unbounded_channel::<AcquisitionProgress>();
    let ctx = context.clone();
    let progress = tokio::spawn(async move {
        while let Some(update) = rx.recv().await {
            ctx.report(TaskProgressPatch {
                percent: update.percent.map(|p| p * 0.8),
                message: Some(update.message.or(update.stage)),
                ..Default::default()
            })
            .await;
        }
    });
    let output = downloader
        .download_with_cancel(request, context.cancel_token(), move |update| {
            let _ = tx.send(update);
        })
        .await;
    let _ = progress.await;
    let output = output.map_err(|err| match err {
        SpotDLDownloadError::Process(crate::tasks::ProcessError::Cancelled) => TaskError::Cancelled,
        other => TaskError::ExecutionFailed(other.to_string()),
    })?;
    let stage = fs::canonicalize(stage).await.map_err(|err| {
        TaskError::ExecutionFailed(format!("Could not open spotDL output directory: {err}"))
    })?;
    let mut staged_files = HashSet::new();
    for path in output.files {
        if let Some(path) = staged_playlist_path(&stage, &path.to_string_lossy()).await {
            staged_files.insert(path);
        }
    }
    let manifest = read_playlist_artifact(&stage.join(&m3u_name))
        .await
        .map_err(|err| {
            TaskError::ExecutionFailed(format!(
                "spotDL did not provide a readable playlist track list: {err}"
            ))
        })?;
    let metadata: Vec<SpotdlPlaylistTrack> =
        match read_playlist_artifact(&stage.join("musicdeck-source.spotdl")).await {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
    let name = metadata
        .iter()
        .filter_map(|entry| entry.list_name.as_deref())
        .map(str::trim)
        .find(|name| !name.is_empty())
        .map(|name| name.chars().take(200).collect());
    let mut entries = Vec::new();
    for (position, line) in manifest
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .enumerate()
    {
        context.checkpoint().await?;
        let source = metadata.get(position);
        let title = source
            .map(|track| track.name.as_str())
            .filter(|name| !name.trim().is_empty())
            .or_else(|| {
                Path::new(line)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|stem| {
                        let title = stem.split_once(" - ").map_or(stem, |(_, title)| title);
                        title
                            .rsplit_once(" [")
                            .filter(|(_, id)| {
                                id.strip_suffix(']').is_some_and(|value| {
                                    !value.is_empty()
                                        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
                                })
                            })
                            .map_or(title, |(title, _)| title)
                    })
            })
            .unwrap_or_default();
        let path = staged_playlist_path(&stage, line)
            .await
            .filter(|path| staged_files.contains(path));
        let mut entry = ImportEntry {
            position: position + 1,
            source: SpotifyImportTrackMetadata {
                position: position + 1,
                url: source.map_or_else(String::new, |track| track.url.clone()),
                title: title.to_owned(),
                artist: source.map_or_else(String::new, |track| track.artist.clone()),
                artists: Vec::new(),
                duration: 0.0,
                album: None,
                album_artist: None,
                year: None,
                artwork_url: None,
                isrc: None,
            },
            status: ImportEntryStatus::Downloaded,
            error: None,
            file_path: path.map(|path| path.to_string_lossy().into_owned()),
            provider_track_id: None,
            duplicate_of: None,
            requires_scan: None,
        };
        if entry.file_path.is_none() {
            fail_import_entry(
                job_id,
                &mut entry,
                ImportEntryStatus::FailedDownload,
                match output.warning {
                    Some(code) => {
                        format!("spotDL did not download track {} ({code})", position + 1)
                    }
                    None => format!("spotDL did not download playlist track {}", position + 1),
                },
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
    })
}

async fn download_checkpointed_tracks(
    record: &mut StoredImportJob,
    context: &TaskRunContext,
    downloader: &SpotDLDownloaderAdapter,
    stage: &Path,
) -> Result<(), TaskError> {
    let job = &mut record.job;
    let entries = job.manifest.as_mut().expect("stored import manifest");
    job.expected_count = Some(entries.len());
    for (index, entry) in entries.iter_mut().enumerate() {
        context.checkpoint().await?;
        let previous_status = entry.status;
        entry.file_path = None;
        entry.provider_track_id = None;
        let mut request = TrackImportRequest {
            output_directory: stage.join(format!("track-{}", index + 1)),
            ..Default::default()
        };
        if let Ok(url) = canonical_spotify_url(&entry.source.url) {
            request.spotify_track_url = Some(url);
        } else if previous_status == ImportEntryStatus::Pending
            && !entry.source.title.trim().is_empty()
        {
            request.query = Some(
                format!(
                    "{} {}",
                    entry.source.artist.trim(),
                    entry.source.title.trim()
                )
                .trim()
                .to_owned(),
            );
        } else {
            fail_import_entry(
                &job.id,
                entry,
                ImportEntryStatus::FailedMetadataMissing,
                "Stored track has no valid Spotify source".into(),
            );
            continue;
        }
        let result = downloader
            .download_with_cancel(&request, context.cancel_token(), |_| {})
            .await
            .map(|output| output.files);
        if matches!(
            result,
            Err(SpotDLDownloadError::Process(
                crate::tasks::ProcessError::Cancelled
            ))
        ) {
            return Err(TaskError::Cancelled);
        }
        match result {
            Ok(files) if files.len() == 1 => {
                entry.status = ImportEntryStatus::Downloaded;
                entry.error = None;
                entry.file_path = Some(files[0].to_string_lossy().into_owned());
            }
            Ok(_) => fail_import_entry(
                &job.id,
                entry,
                ImportEntryStatus::FailedDownload,
                "spotDL did not return exactly one audio file for this track".into(),
            ),
            Err(err) => {
                let message = err.to_string();
                fail_import_entry(
                    &job.id,
                    entry,
                    ImportEntryStatus::FailedDownload,
                    message.clone(),
                );
                if matches!(err, SpotDLDownloadError::Process(_)) {
                    return Err(TaskError::ExecutionFailed(message));
                }
            }
        }
    }
    Ok(())
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
