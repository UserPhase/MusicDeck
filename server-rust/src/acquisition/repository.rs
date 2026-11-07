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

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use chrono::Utc;
use nanoid::nanoid;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use tokio::sync::mpsc;
use url::Url;

use crate::acquisition::spotdl::{
    AcquisitionProgress, SpotDLDownloadError, SpotDLDownloaderAdapter, TrackImportRequest,
    canonical_spotify_url,
};
use crate::auth::UserRecord;
use crate::db::DbPool;
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
        let completed = job
            .completed_count
            .or(job.imported_count)
            .unwrap_or(0) as i64;
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
        .execute(self.db.inner())
        .await
        .map_err(|e| e.to_string())?;

        if res.rows_affected() == 0 {
            return Err(String::from("Import checkpoint belongs to another user"));
        }
        Ok(())
    }

    async fn decode_row(&self, id: String, user_id: String, manifest_json: String) -> StoredImportJob {
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
        let row = sqlx::query(
            "SELECT id, user_id, manifest_json FROM import_jobs WHERE id = ?",
        )
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
        let rows = sqlx::query(
            r"
            SELECT id, user_id, manifest_json FROM import_jobs
            WHERE status IN ('PENDING', 'PROCESSING')
            ORDER BY created_at, id
            ",
        )
        .fetch_all(self.db.inner())
        .await
        .unwrap_or_default();

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
        out
    }
}

/// Validates and canonicalizes a Spotify public playlist URL (`https://open.spotify.com/playlist/<id>`).
#[must_use]
pub fn parse_spotify_playlist_url(raw: &str) -> Option<(String, String)> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("open.spotify.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let re = Regex::new(r"^/playlist/([a-zA-Z0-9]+)/?$").expect("valid regex");
    let caps = re.captures(parsed.path())?;
    let id = caps.get(1)?.as_str().to_owned();
    let canonical = format!("https://open.spotify.com/playlist/{id}");
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
        }
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

        if let Some(pool) = &self.db {
            let repo = SqliteImportJobRepository::new(pool.clone());
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
            repo.save(&record).await?;
        }

        if let Ok(mut guard) = self.jobs.write() {
            guard.insert(id.clone(), job.clone());
        }

        if let Some(tm) = tasks {
            let _ = tm
                .enqueue(
                    TaskType::SpotdlImport,
                    json!({ "kind": "playlist", "jobId": id }),
                    &user.id,
                    None,
                )
                .await;
        }

        Ok(job)
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

    /// Executes a queued Spotify playlist import job inside a [`TaskRunContext`] using `downloader`,
    /// persisting per-track checkpoints and terminal status to `import_jobs` in SQLite.
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
            .ok_or(TaskError::NotFound)?
            .clone();
        let repo = SqliteImportJobRepository::new(pool);

        let mut record = repo.get_by_id(job_id).await.ok_or(TaskError::NotFound)?;

        if record.unreadable_manifest.is_some() {
            let err_msg = record.job.error.clone().unwrap_or_else(|| {
                String::from("Stored import checkpoint is invalid; original manifest retained")
            });
            return Err(TaskError::ExecutionFailed(err_msg));
        }

        if record.job.status == "failed" {
            let err_msg = record
                .job
                .error
                .clone()
                .unwrap_or_else(|| String::from("Spotify playlist import failed"));
            return Err(TaskError::ExecutionFailed(err_msg));
        }

        if record.job.status == "completed" {
            context
                .report(TaskProgressPatch {
                    percent: Some(100.0),
                    message: Some(Some(String::from("Completed"))),
                    ..TaskProgressPatch::default()
                })
                .await;
            return Ok(record.job);
        }

        if record
            .user
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let err_msg = String::from("Import owner is disabled");
            record.job.status = String::from("failed");
            record.job.stage = String::from("completed");
            record.job.error = Some(err_msg.clone());
            let _ = repo.save(&record).await;
            if let Ok(mut guard) = self.jobs.write() {
                guard.insert(job_id.to_owned(), record.job.clone());
            }
            return Err(TaskError::ExecutionFailed(err_msg));
        }

        let Some((spotify_id, canonical_url)) = parse_spotify_playlist_url(&record.playlist_url)
        else {
            let err_msg = String::from("Stored playlist URL is invalid");
            record.job.status = String::from("failed");
            record.job.stage = String::from("completed");
            record.job.error = Some(err_msg.clone());
            let _ = repo.save(&record).await;
            if let Ok(mut guard) = self.jobs.write() {
                guard.insert(job_id.to_owned(), record.job.clone());
            }
            return Err(TaskError::ExecutionFailed(err_msg));
        };

        let staging_dir = output_dir
            .map(|p| p.join(job_id))
            .unwrap_or_else(|| std::env::temp_dir().join("musicdeck-playlist").join(job_id));

        record.job.status = String::from("running");
        record.job.stage = String::from("downloading");
        if record.job.playlist_name.is_none() {
            record.job.playlist_name = Some(format!(
                "Spotify Playlist {}",
                &spotify_id[..spotify_id.len().min(8)]
            ));
        }
        if record.job.playlist_description.is_none() {
            record.job.playlist_description =
                Some(spotify_playlist_description(None, &canonical_url));
        }
        repo.save(&record)
            .await
            .map_err(TaskError::ExecutionFailed)?;
        if let Ok(mut guard) = self.jobs.write() {
            guard.insert(job_id.to_owned(), record.job.clone());
        }

        if let Some(mut entries) = record.job.manifest.take() {
            let total = entries.len();
            record.job.expected_count = Some(total);

            for idx in 0..total {
                if let Err(err) = context.checkpoint().await {
                    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                    if matches!(err, TaskError::Cancelled) {
                        record.job.status = String::from("failed");
                        record.job.error = Some(String::from("Playlist import cancelled"));
                        let _ = repo.save(&record).await;
                    }
                    return Err(err);
                }

                let status = entries[idx].status;
                if matches!(
                    status,
                    ImportEntryStatus::Completed
                        | ImportEntryStatus::Ready
                        | ImportEntryStatus::Downloaded
                ) {
                    if status != ImportEntryStatus::Completed {
                        entries[idx].status = ImportEntryStatus::Completed;
                    }
                    continue;
                }
                if !matches!(status, ImportEntryStatus::Pending) {
                    continue;
                }

                let pos = entries[idx].position;
                let title = entries[idx].source.title.trim().to_owned();
                let artist = entries[idx].source.artist.trim().to_owned();
                let track_url = entries[idx].source.url.trim().to_owned();

                record.job.current_track = Some(pos);
                record.job.current_track_name = Some(format!("{artist} - {title}"));

                if title.is_empty() && artist.is_empty() && track_url.is_empty() {
                    entries[idx].status = ImportEntryStatus::FailedMetadataMissing;
                    entries[idx].error = Some(String::from(
                        "Could not resolve canonical Spotify track metadata",
                    ));
                    continue;
                }

                let mut req = TrackImportRequest {
                    output_directory: staging_dir.join(format!("track-{pos}")),
                    ..TrackImportRequest::default()
                };
                if let Ok(sp_track) = canonical_spotify_url(&track_url) {
                    req.spotify_track_url = Some(sp_track);
                } else {
                    req.query = Some(format!("{artist} - {title}"));
                }

                match downloader.download_checked(&req, |_| {}).await {
                    Ok(files) => {
                        entries[idx].status = ImportEntryStatus::Completed;
                        entries[idx].file_path =
                            files.first().map(|p| p.to_string_lossy().into_owned());
                        entries[idx].provider_track_id = Some(format!("imported_{pos}"));
                    }
                    Err(err) => {
                        let err_msg = err.to_string();
                        entries[idx].status = ImportEntryStatus::FailedDownload;
                        entries[idx].error = Some(err_msg.clone());
                        // A broken subprocess cannot recover by trying the next track.
                        if matches!(err, SpotDLDownloadError::Process(_)) {
                            record.job.status = String::from("failed");
                            record.job.stage = String::from("completed");
                            record.job.error = Some(err_msg.clone());
                            record.job.failed_count = Some(
                                entries
                                    .iter()
                                    .filter(|entry| {
                                        entry.status == ImportEntryStatus::FailedDownload
                                    })
                                    .count(),
                            );
                            record.job.manifest = Some(entries);
                            repo.save(&record)
                                .await
                                .map_err(TaskError::ExecutionFailed)?;
                            if let Ok(mut guard) = self.jobs.write() {
                                guard.insert(job_id.to_owned(), record.job.clone());
                            }
                            let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                            return Err(TaskError::ExecutionFailed(err_msg));
                        }
                    }
                }

                let completed = entries
                    .iter()
                    .filter(|e| e.status == ImportEntryStatus::Completed)
                    .count();
                let failed = entries
                    .iter()
                    .filter(|e| {
                        matches!(
                            e.status,
                            ImportEntryStatus::FailedMetadataMissing
                                | ImportEntryStatus::FailedDownload
                                | ImportEntryStatus::FailedTagging
                                | ImportEntryStatus::FailedIndexing
                                | ImportEntryStatus::FailedLinking
                        )
                    })
                    .count();

                record.job.completed_count = Some(completed);
                record.job.imported_count = Some(completed);
                record.job.downloaded_count = Some(completed);
                record.job.failed_count = Some(failed);
                record.job.manifest = Some(entries.clone());
                let _ = repo.save(&record).await;

                let pct = if total > 0 {
                    ((completed + failed) as f64 / total as f64) * 100.0
                } else {
                    100.0
                };
                context
                    .report(TaskProgressPatch {
                        percent: Some(pct),
                        items_processed: Some((completed + failed) as u64),
                        total_items: Some(Some(total as u64)),
                        message: record.job.current_track_name.clone().map(Some),
                        ..TaskProgressPatch::default()
                    })
                    .await;
            }

            let completed = entries
                .iter()
                .filter(|e| e.status == ImportEntryStatus::Completed)
                .count();
            let failed = entries
                .iter()
                .filter(|e| {
                    matches!(
                        e.status,
                        ImportEntryStatus::FailedMetadataMissing
                            | ImportEntryStatus::FailedDownload
                            | ImportEntryStatus::FailedTagging
                            | ImportEntryStatus::FailedIndexing
                            | ImportEntryStatus::FailedLinking
                    )
                })
                .count();

            record.job.completed_count = Some(completed);
            record.job.imported_count = Some(completed);
            record.job.downloaded_count = Some(completed);
            record.job.failed_count = Some(failed);
            record.job.stage = String::from("completed");

            if completed == 0 && failed > 0 {
                let first_err = entries
                    .iter()
                    .find_map(|e| e.error.clone())
                    .unwrap_or_else(|| String::from("Spotify playlist import failed"));
                record.job.status = String::from("failed");
                record.job.error = Some(first_err.clone());
                record.job.manifest = Some(entries);
                let _ = repo.save(&record).await;
                if let Ok(mut guard) = self.jobs.write() {
                    guard.insert(job_id.to_owned(), record.job.clone());
                }
                let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                return Err(TaskError::ExecutionFailed(first_err));
            }

            record.job.status = if failed > 0 {
                String::from("partial")
            } else {
                String::from("completed")
            };
            record.job.manifest = Some(entries);
            repo.save(&record)
                .await
                .map_err(TaskError::ExecutionFailed)?;
        } else {
            let safe_m3u_stem: String = job_id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            let req = TrackImportRequest {
                spotify_track_url: Some(canonical_url.clone()),
                output_directory: staging_dir.clone(),
                playlist_m3u_name: Some(format!("musicdeck-{safe_m3u_stem}.m3u8")),
                ..TrackImportRequest::default()
            };

            let (prog_tx, mut prog_rx) = mpsc::unbounded_channel::<AcquisitionProgress>();
            let prog_ctx = context.clone();
            let prog_worker = tokio::spawn(async move {
                while let Some(p) = prog_rx.recv().await {
                    prog_ctx
                        .report(TaskProgressPatch {
                            percent: p.percent,
                            speed_bytes_per_second: p.speed_bytes_per_second.map(|s| s as f64),
                            message: Some(p.message.or(p.stage)),
                            ..TaskProgressPatch::default()
                        })
                        .await;
                }
            });

            let dl_res = downloader
                .download(&req, move |p| {
                    let _ = prog_tx.send(p);
                })
                .await;
            let _ = prog_worker.await;

            match dl_res {
                Ok(files) => {
                    let count = files.len();
                    record.job.expected_count = Some(count);
                    record.job.downloaded_count = Some(count);
                    record.job.completed_count = Some(count);
                    record.job.imported_count = Some(count);
                    record.job.failed_count = Some(0);
                    record.job.stage = String::from("completed");
                    record.job.status = String::from("completed");
                    repo.save(&record)
                        .await
                        .map_err(TaskError::ExecutionFailed)?;
                }
                Err(err_msg) => {
                    record.job.status = String::from("failed");
                    record.job.stage = String::from("completed");
                    record.job.error = Some(err_msg.clone());
                    let _ = repo.save(&record).await;
                    if let Ok(mut guard) = self.jobs.write() {
                        guard.insert(job_id.to_owned(), record.job.clone());
                    }
                    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
                    return Err(TaskError::ExecutionFailed(err_msg));
                }
            }
        }

        let _ = tokio::fs::remove_dir_all(&staging_dir).await;
        if let Ok(mut guard) = self.jobs.write() {
            guard.insert(job_id.to_owned(), record.job.clone());
        }

        let processed = record.job.completed_count.unwrap_or(1) as u64;
        let total = record.job.expected_count.unwrap_or(1) as u64;
        context
            .report(TaskProgressPatch {
                percent: Some(100.0),
                items_processed: Some(processed),
                total_items: Some(Some(total)),
                message: Some(Some(String::from("Import completed"))),
                ..TaskProgressPatch::default()
            })
            .await;

        Ok(record.job)
    }
}
