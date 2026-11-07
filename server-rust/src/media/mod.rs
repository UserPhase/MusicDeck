//! # Resumable Media Session Persistence (`media`)
//!
//! Complete Rust port of `server/src/services/ResumableMediaService.ts`.
//!
//! ## Core Invariants
//! 1. **30-Day Retention Window (`MEDIA_SESSION_TTL_MS`)**:
//!    - Active checkpoints in `media_sessions` and completion tombstones in
//!      `media_session_completions` expire 30 days after `updated_at`.
//! 2. **Monotonic Completion Tombstones (`media_session_completions`)**:
//!    - When a user finishes an album or playlist (`completed == true` or `progress >= 1.0`),
//!      the checkpoint is removed from `media_sessions` and its `captured_at` timestamp is
//!      recorded in `media_session_completions`.
//!    - Delayed or out-of-order network reports with `captured_at <= completed.captured_at`
//!      are ignored (`Ok(None)`) so a 5-second-delayed progress heartbeat can never
//!      resurrect a completed album/playlist.
//! 3. **Deleted/Unreadable Playlist Pruning**:
//!    - Before serving `get` or `list`, [`ResumableMediaService`] removes any playlist
//!      checkpoint whose target playlist was moved to Trash or is no longer readable by
//!      the viewer.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Row};
use thiserror::Error;

use crate::db::{DbError, DbPool};

/// Retention window (`30` days in milliseconds) for resumable media checkpoints.
pub const MEDIA_SESSION_TTL_MS: i64 = 30 * 86_400_000;

/// Maximum clock skew in the future (`5,000` ms) tolerated on `captured_at`.
pub const MAX_FUTURE_DRIFT_MS: i64 = 5_000;

/// Media collection kind (`"album"` or `"playlist"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaCollectionType {
    /// Album playback session.
    Album,
    /// Playlist playback session.
    Playlist,
}

impl MediaCollectionType {
    /// Parses `"album"` or `"playlist"`.
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "album" => Some(Self::Album),
            "playlist" => Some(Self::Playlist),
            _ => None,
        }
    }

    /// Returns the database literal string (`"album"` or `"playlist"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Album => "album",
            Self::Playlist => "playlist",
        }
    }
}

/// Input payload accepted by `POST /api/v1/user/media-sessions` (`mediaCheckpointSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaCheckpointInput {
    /// Collection type (`album` or `playlist`).
    #[serde(rename = "type")]
    pub media_type: MediaCollectionType,
    /// Collection ID (`1..=300` chars).
    pub media_id: String,
    /// Collection title (`1..=500` trimmed chars).
    pub title: String,
    /// Active track ID (`1..=300` chars).
    pub track_id: String,
    /// Optional playlist item occurrence ID (`1..=300` chars).
    #[serde(default)]
    pub occurrence_id: Option<String>,
    /// Zero-based index of `track_id` inside the collection (`0..=1_000_000`).
    pub track_index: usize,
    /// Total track count of the collection (`1..=1_000_001`, must be `> track_index`).
    pub track_count: usize,
    /// Playback position within the current track in seconds (`0.0..=86400.0`).
    pub position_seconds: f64,
    /// Duration of the current track in seconds (`> 0.0..=86400.0`), if known.
    pub duration_seconds: Option<f64>,
    /// Client capture timestamp in epoch milliseconds (`> 0`).
    pub captured_at: i64,
    /// Whether the user finished the collection (`defaults to false`).
    #[serde(default)]
    pub completed: bool,
}

/// Persisted resumable media bookmark (`MediaCheckpoint` / `PlaybackSession`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCheckpoint {
    /// Collection type (`album` or `playlist`).
    #[serde(rename = "type")]
    pub media_type: MediaCollectionType,
    /// Collection ID.
    pub media_id: String,
    /// Collection title.
    pub title: String,
    /// Track ID where playback was paused/bookmarked.
    pub track_id: String,
    /// Optional playlist occurrence ID.
    pub occurrence_id: Option<String>,
    /// Zero-based track index.
    pub track_index: usize,
    /// Total track count.
    pub track_count: usize,
    /// Playback position in seconds.
    pub position_seconds: f64,
    /// Optional track duration in seconds.
    pub duration_seconds: Option<f64>,
    /// Overall collection completion ratio in `[0.0, 1.0)`.
    pub progress: f64,
    /// Client capture timestamp (epoch ms).
    pub captured_at: i64,
    /// Server update timestamp (epoch ms).
    pub updated_at: i64,
}

/// Alias matching the prompt's `PlaybackSession` struct name.
pub type PlaybackSession = MediaCheckpoint;

/// Error taxonomy for resumable media session operations.
#[derive(Debug, Error)]
pub enum MediaSessionError {
    /// Validation failure (`400 Bad Request`).
    #[error("{0}")]
    Validation(String),

    /// Referenced playlist is not readable or does not exist (`404 Not Found`).
    #[error("{0}")]
    NotFound(String),

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("Media session database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Service managing per-user resumable album/playlist bookmarks in `media_sessions`
/// and completion tombstones in `media_session_completions`.
#[derive(Debug, Clone)]
pub struct ResumableMediaService {
    db: DbPool,
}

impl ResumableMediaService {
    /// Creates a new [`ResumableMediaService`].
    #[must_use]
    pub const fn new(db: DbPool) -> Self {
        Self { db }
    }

    /// Prunes expired checkpoints and completion tombstones older than [`MEDIA_SESSION_TTL_MS`].
    pub async fn prune_at(&self, now_ms: i64) -> Result<u64, MediaSessionError> {
        let cutoff = now_ms - MEDIA_SESSION_TTL_MS;
        sqlx::query("DELETE FROM media_session_completions WHERE updated_at < ?;")
            .bind(cutoff)
            .execute(self.db.inner())
            .await?;

        let res = sqlx::query("DELETE FROM media_sessions WHERE updated_at < ? OR progress >= 1.0;")
            .bind(cutoff)
            .execute(self.db.inner())
            .await?;

        Ok(res.rows_affected())
    }

    /// Fetches a single resumable checkpoint for `(user_id, media_type, media_id)`.
    pub async fn get(
        &self,
        user_id: &str,
        media_type: MediaCollectionType,
        media_id: &str,
    ) -> Result<Option<MediaCheckpoint>, MediaSessionError> {
        let now_ms = Utc::now().timestamp_millis();
        self.clean_for_user(user_id, now_ms).await?;

        let row = sqlx::query(
            "SELECT * FROM media_sessions WHERE user_id = ? AND media_type = ? AND media_id = ?;",
        )
        .bind(user_id)
        .bind(media_type.as_str())
        .bind(media_id)
        .fetch_optional(self.db.inner())
        .await?;

        row.as_ref().map(map_session_row).transpose()
    }

    /// Lists up to 100 recent resumable media checkpoints for `user_id` ordered by `updated_at DESC`.
    pub async fn list(&self, user_id: &str) -> Result<Vec<MediaCheckpoint>, MediaSessionError> {
        let now_ms = Utc::now().timestamp_millis();
        self.clean_for_user(user_id, now_ms).await?;

        let rows = sqlx::query(
            r"
            SELECT * FROM media_sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC, media_type ASC, media_id ASC
            LIMIT 100;
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await?;

        rows.iter().map(map_session_row).collect()
    }

    /// Validates and saves a [`MediaCheckpointInput`] at `now_ms` inside an atomic transaction.
    ///
    /// Returns `Ok(None)` if the collection is now completed (`progress >= 1.0`) or if a newer
    /// completion tombstone already exists.
    pub async fn save_at(
        &self,
        user_id: &str,
        mut input: MediaCheckpointInput,
        now_ms: i64,
    ) -> Result<Option<MediaCheckpoint>, MediaSessionError> {
        validate_checkpoint_input(&mut input, now_ms)?;
        self.prune_at(now_ms).await?;

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let completed_row = sqlx::query(
            r"
            SELECT captured_at FROM media_session_completions
            WHERE user_id = ? AND media_type = ? AND media_id = ?;
            ",
        )
        .bind(user_id)
        .bind(input.media_type.as_str())
        .bind(&input.media_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(comp) = completed_row {
            let comp_at: i64 = comp.try_get("captured_at")?;
            if comp_at >= input.captured_at {
                tx.commit().await?;
                return Ok(None);
            }
        }

        let prev_row = sqlx::query(
            r"
            SELECT * FROM media_sessions
            WHERE user_id = ? AND media_type = ? AND media_id = ?;
            ",
        )
        .bind(user_id)
        .bind(input.media_type.as_str())
        .bind(&input.media_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(ref prev) = prev_row {
            let prev_captured: i64 = prev.try_get("captured_at")?;
            if prev_captured > input.captured_at
                || (prev_captured == input.captured_at && !input.completed)
            {
                let existing = map_session_row(prev)?;
                tx.commit().await?;
                return Ok(Some(existing));
            }
        }

        let track_fraction = match input.duration_seconds {
            Some(d) if d > 0.0 => input.position_seconds / d,
            _ => 0.0,
        };
        let progress = if input.completed {
            1.0
        } else {
            ((input.track_index as f64) + track_fraction) / (input.track_count as f64)
        };

        if progress >= 1.0 {
            sqlx::query(
                r"
                INSERT INTO media_session_completions
                  (user_id, media_type, media_id, captured_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, media_type, media_id) DO UPDATE SET
                  captured_at = excluded.captured_at,
                  updated_at = excluded.updated_at;
                ",
            )
            .bind(user_id)
            .bind(input.media_type.as_str())
            .bind(&input.media_id)
            .bind(input.captured_at)
            .bind(now_ms)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "DELETE FROM media_sessions WHERE user_id = ? AND media_type = ? AND media_id = ?;",
            )
            .bind(user_id)
            .bind(input.media_type.as_str())
            .bind(&input.media_id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;
            return Ok(None);
        }

        sqlx::query(
            "DELETE FROM media_session_completions WHERE user_id = ? AND media_type = ? AND media_id = ?;",
        )
        .bind(user_id)
        .bind(input.media_type.as_str())
        .bind(&input.media_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r"
            INSERT INTO media_sessions (
              user_id, media_type, media_id, title, track_id, occurrence_id,
              track_index, track_count, position_seconds, duration_seconds,
              progress, captured_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, media_type, media_id) DO UPDATE SET
              title = excluded.title,
              track_id = excluded.track_id,
              occurrence_id = excluded.occurrence_id,
              track_index = excluded.track_index,
              track_count = excluded.track_count,
              position_seconds = excluded.position_seconds,
              duration_seconds = excluded.duration_seconds,
              progress = excluded.progress,
              captured_at = excluded.captured_at,
              updated_at = excluded.updated_at;
            ",
        )
        .bind(user_id)
        .bind(input.media_type.as_str())
        .bind(&input.media_id)
        .bind(&input.title)
        .bind(&input.track_id)
        .bind(&input.occurrence_id)
        .bind(i64::try_from(input.track_index).unwrap_or(0))
        .bind(i64::try_from(input.track_count).unwrap_or(1))
        .bind(input.position_seconds)
        .bind(input.duration_seconds)
        .bind(progress)
        .bind(input.captured_at)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(Some(MediaCheckpoint {
            media_type: input.media_type,
            media_id: input.media_id,
            title: input.title,
            track_id: input.track_id,
            occurrence_id: input.occurrence_id,
            track_index: input.track_index,
            track_count: input.track_count,
            position_seconds: input.position_seconds,
            duration_seconds: input.duration_seconds,
            progress,
            captured_at: input.captured_at,
            updated_at: now_ms,
        }))
    }

    /// Removes a resumable checkpoint (`DELETE /api/v1/user/media-sessions`).
    pub async fn remove(
        &self,
        user_id: &str,
        media_type: MediaCollectionType,
        media_id: &str,
    ) -> Result<(), MediaSessionError> {
        sqlx::query(
            "DELETE FROM media_sessions WHERE user_id = ? AND media_type = ? AND media_id = ?;",
        )
        .bind(user_id)
        .bind(media_type.as_str())
        .bind(media_id)
        .execute(self.db.inner())
        .await?;
        Ok(())
    }

    async fn clean_for_user(&self, user_id: &str, now_ms: i64) -> Result<(), MediaSessionError> {
        self.prune_at(now_ms).await?;

        let is_admin = sqlx::query("SELECT 1 FROM users WHERE id = ? AND role = 'admin';")
            .bind(user_id)
            .fetch_optional(self.db.inner())
            .await?
            .is_some();

        sqlx::query(
            r"
            DELETE FROM media_sessions
            WHERE user_id = ?
              AND media_type = 'playlist'
              AND NOT EXISTS (
                SELECT 1 FROM playlists p
                WHERE p.id = media_sessions.media_id
                  AND p.deleted_at IS NULL
                  AND (
                    p.owner_user_id = ?
                    OR ? = 1
                    OR p.sharing_mode = 'PUBLIC_SERVER'
                    OR (
                      p.sharing_mode IN ('SHARED_READ', 'COLLABORATIVE')
                      AND EXISTS (
                        SELECT 1 FROM playlist_permissions perm
                        WHERE perm.playlist_id = p.id AND perm.user_id = ?
                      )
                    )
                  )
              );
            ",
        )
        .bind(user_id)
        .bind(user_id)
        .bind(i64::from(is_admin))
        .bind(user_id)
        .execute(self.db.inner())
        .await?;

        Ok(())
    }
}

fn validate_checkpoint_input(
    input: &mut MediaCheckpointInput,
    now_ms: i64,
) -> Result<(), MediaSessionError> {
    input.title = input.title.trim().to_owned();
    if input.media_id.is_empty()
        || input.media_id.len() > 300
        || input.title.is_empty()
        || input.title.chars().count() > 500
        || input.track_id.is_empty()
        || input.track_id.len() > 300
    {
        return Err(MediaSessionError::Validation(String::from(
            "Invalid media checkpoint fields.",
        )));
    }
    if let Some(ref occ) = input.occurrence_id
        && (occ.is_empty() || occ.len() > 300)
    {
        return Err(MediaSessionError::Validation(String::from(
            "Invalid occurrenceId.",
        )));
    }
    if input.track_count == 0
        || input.track_count > 1_000_001
        || input.track_index > 1_000_000
        || input.track_index >= input.track_count
    {
        return Err(MediaSessionError::Validation(String::from(
            "Track index is outside the collection.",
        )));
    }
    if !input.position_seconds.is_finite()
        || !(0.0..=86_400.0).contains(&input.position_seconds)
    {
        return Err(MediaSessionError::Validation(String::from(
            "Invalid positionSeconds.",
        )));
    }
    if let Some(dur) = input.duration_seconds {
        if !dur.is_finite() || dur <= 0.0 || dur > 86_400.0 {
            return Err(MediaSessionError::Validation(String::from(
                "Invalid durationSeconds.",
            )));
        }
        if input.position_seconds > dur {
            return Err(MediaSessionError::Validation(String::from(
                "Position exceeds track duration.",
            )));
        }
    }
    if input.captured_at <= 0
        || input.captured_at > now_ms + MAX_FUTURE_DRIFT_MS
        || input.captured_at < now_ms - MEDIA_SESSION_TTL_MS
    {
        return Err(MediaSessionError::Validation(String::from(
            "Checkpoint timestamp is outside the allowed range.",
        )));
    }

    Ok(())
}

fn map_session_row(row: &sqlx::sqlite::SqliteRow) -> Result<MediaCheckpoint, MediaSessionError> {
    let type_str: String = row.try_get("media_type")?;
    let media_type =
        MediaCollectionType::parse_str(&type_str).unwrap_or(MediaCollectionType::Album);
    let track_index_i64: i64 = row.try_get("track_index")?;
    let track_count_i64: i64 = row.try_get("track_count")?;

    Ok(MediaCheckpoint {
        media_type,
        media_id: row.try_get("media_id")?,
        title: row.try_get("title")?,
        track_id: row.try_get("track_id")?,
        occurrence_id: row.try_get("occurrence_id")?,
        track_index: usize::try_from(track_index_i64.max(0)).unwrap_or(0),
        track_count: usize::try_from(track_count_i64.max(1)).unwrap_or(1),
        position_seconds: row.try_get("position_seconds")?,
        duration_seconds: row.try_get("duration_seconds")?,
        progress: row.try_get("progress")?,
        captured_at: row.try_get("captured_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}
