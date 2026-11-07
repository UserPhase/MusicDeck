//! # Taste Profile Governance, Private Listening & Feedback Filter (`profile::taste`)
//!
//! Ports `server/src/services/TasteProfileManager.ts`:
//! - [`taste_artist_id`] (`artist_name_<sha256(normalize_music_text(artist))>`)
//! - [`taste_recording_key`] (`[normalize_music_text(artist), normalize_music_text(title), version_signature(title)]`)
//! - [`TasteProfileManager`]:
//!   - `state`: Queries `taste_settings` (`private_listening`, `revision`, `reset_before`, `provider_history_disabled`)
//!   - `set_private`: Compare-And-Swap (`revision`), opens/closes `taste_private_periods`, marks active
//!     `listening_events` and `recently_played` rows `taste_excluded = 1`
//!   - `decision`: Evaluates whether a playback event is excluded from taste affinity
//!   - `set_playlist` & `set_track`: Excludes playlists or individual recordings and rebuilds `smart_playlist_activity`
//!   - `reset`: Advances `reset_before` to `now`, disables provider history, and clears `smart_playlist_activity`
//!   - `feedback_filter`, `hidden`, `restore`, and `overview`

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::UserRecord;
use crate::catalog::{normalize_music_text, version_signature};
use crate::db::DbPool;
use crate::playlists::PlaylistCollaborationService;
use crate::providers::Track;

/// Computes the deterministic taste artist identifier (`artist_name_<sha256>`).
#[must_use]
pub fn taste_artist_id(artist: &str) -> String {
    let norm = normalize_music_text(Some(artist));
    let mut sha = Sha256::new();
    sha.update(norm.as_bytes());
    format!("artist_name_{:x}", sha.finalize())
}

/// Computes the canonical recording key (`[normalized_artist, normalized_title, version_signature]`)
/// used to match excluded or hidden recordings across sources.
#[must_use]
pub fn taste_recording_key(title: &str, artist: &str) -> String {
    serde_json::to_string(&json!([
        normalize_music_text(Some(artist)),
        normalize_music_text(Some(title)),
        version_signature(Some(title)),
    ]))
    .unwrap_or_default()
}

/// Per-user taste governance state stored in `taste_settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct TasteState {
    pub private_listening: bool,
    pub revision: i64,
    pub reset_before: Option<String>,
    pub provider_history_disabled: bool,
}


/// Target descriptor for taste feedback or exclusion rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteTarget {
    pub id: String,
    /// `"track" | "artist" | "album"`.
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artist_id: Option<String>,
    pub album_id: Option<String>,
}

impl TasteTarget {
    /// Constructs a [`TasteTarget`] from a catalog [`Track`].
    #[must_use]
    pub fn from_track(track: &Track) -> Self {
        Self {
            id: track.id.clone(),
            item_type: Some(String::from("track")),
            title: Some(track.title.clone()),
            artist: Some(track.artist_name.clone()),
            album: Some(track.album_name.clone()),
            artist_id: track.artist_id.clone(),
            album_id: track.album_id.clone(),
        }
    }
}

/// Hidden feedback item returned in [`TasteProfileOverview::hidden`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteHiddenItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub aliases: usize,
    pub updated_at: String,
}

/// Excluded track summary returned in [`TasteProfileOverview::track_exclusions`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteExcludedTrack {
    pub id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// Excluded playlist summary returned in [`TasteProfileOverview::playlist_exclusions`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteExcludedPlaylist {
    pub id: String,
    pub name: String,
}

/// Complete taste profile overview returned by `GET /api/v1/taste-profile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteProfileOverview {
    pub private_listening: bool,
    pub revision: i64,
    pub reset_before: Option<String>,
    pub provider_history_disabled: bool,
    pub hidden: Vec<TasteHiddenItem>,
    pub track_exclusions: Vec<TasteExcludedTrack>,
    pub playlist_exclusions: Vec<TasteExcludedPlaylist>,
    pub eligible_listens: i64,
}

/// Decision returned by [`TasteProfileManager::decision`] for an incoming playback event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteExclusionDecision {
    pub excluded: bool,
    pub recording_key: Option<String>,
    pub playlist_id: Option<String>,
}

/// Structured error returned by [`TasteProfileManager`].
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct TasteProfileError {
    pub message: String,
    pub status_code: u16,
}

impl TasteProfileError {
    /// Creates a new [`TasteProfileError`].
    #[must_use]
    pub fn new(message: impl Into<String>, status_code: u16) -> Self {
        Self {
            message: message.into(),
            status_code,
        }
    }
}

/// Compiled predicate filtering out negatively-rated or blocked tracks, artists, and albums.
#[derive(Debug, Clone, Default)]
pub struct TasteFeedbackFilter {
    ids: HashSet<String>,
    tracks: HashSet<String>,
    artists: HashSet<String>,
    albums: HashSet<String>,
}

impl TasteFeedbackFilter {
    /// Returns `true` if `target` is allowed (not hidden or blocked).
    #[must_use]
    pub fn allows(&self, target: &TasteTarget) -> bool {
        if self.ids.is_empty()
            && self.tracks.is_empty()
            && self.artists.is_empty()
            && self.albums.is_empty()
        {
            return true;
        }

        let item_type = target.item_type.as_deref().unwrap_or("track");
        if self.ids.contains(&format!("{item_type}:{}", target.id)) {
            return false;
        }
        if let Some(artist_id) = &target.artist_id {
            if self.ids.contains(&format!("artist:{artist_id}")) {
                return false;
            }
        }
        if let Some(album_id) = &target.album_id {
            if self.ids.contains(&format!("album:{album_id}")) {
                return false;
            }
        }

        if !self.artists.is_empty() {
            let raw_artist = target
                .artist
                .as_deref()
                .or_else(|| (item_type == "artist").then_some(target.title.as_deref()).flatten());
            let norm_artist = normalize_music_text(raw_artist);
            if !norm_artist.is_empty() && self.artists.contains(&norm_artist) {
                return false;
            }
        }

        if !self.tracks.is_empty() && item_type == "track" {
            if let (Some(title), Some(artist)) = (&target.title, &target.artist) {
                if self.tracks.contains(&taste_recording_key(title, artist)) {
                    return false;
                }
            }
        }

        if !self.albums.is_empty() && item_type != "artist" {
            let album_name = target
                .album
                .as_deref()
                .or_else(|| (item_type == "album").then_some(target.title.as_deref()).flatten());
            if let (Some(album_name), Some(artist)) = (album_name, &target.artist) {
                if self
                    .albums
                    .contains(&taste_recording_key(album_name, artist))
                {
                    return false;
                }
            }
        }

        true
    }
}

#[derive(Debug, Clone)]
struct NegativeFeedbackRow {
    item_type: String,
    item_id: String,
    updated_at: String,
    target: TasteTarget,
}

/// Manager governing user taste settings, private listening windows, exclusions, and feedback filters.
#[derive(Debug, Clone)]
pub struct TasteProfileManager {
    db: DbPool,
}

impl TasteProfileManager {
    /// Creates a new [`TasteProfileManager`].
    #[must_use]
    pub const fn new(db: DbPool) -> Self {
        Self { db }
    }

    /// Reads the current [`TasteState`] for `user_id`.
    pub async fn state(&self, user_id: &str) -> TasteState {
        let row = sqlx::query("SELECT * FROM taste_settings WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(self.db.inner())
            .await
            .ok()
            .flatten();

        let Some(row) = row else {
            return TasteState::default();
        };

        TasteState {
            private_listening: row.try_get::<i64, _>("private_listening").unwrap_or(0) != 0,
            revision: row.try_get("revision").unwrap_or(0),
            reset_before: row.try_get("reset_before").ok(),
            provider_history_disabled: row
                .try_get::<i64, _>("provider_history_disabled")
                .unwrap_or(0)
                != 0,
        }
    }

    /// Returns `true` if external provider play counts/history can be used for `user_id`.
    pub async fn can_use_provider_history(&self, user_id: &str) -> bool {
        !self.state(user_id).await.provider_history_disabled
    }

    /// Increments `taste_settings.revision` for `user_id`.
    pub async fn bump(&self, user_id: &str) {
        let _ = sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
            .bind(user_id)
            .execute(self.db.inner())
            .await;
        let _ = sqlx::query("UPDATE taste_settings SET revision = revision + 1 WHERE user_id = ?")
            .bind(user_id)
            .execute(self.db.inner())
            .await;
    }

    /// Toggles private listening for `user_id` with optimistic concurrency (`expected_revision`).
    pub async fn set_private(
        &self,
        user_id: &str,
        enabled: bool,
        expected_revision: i64,
    ) -> Result<TasteState, TasteProfileError> {
        let current = self.state(user_id).await;
        if current.revision != expected_revision {
            return Err(TasteProfileError::new(
                "Taste settings changed elsewhere. Refresh and try again.",
                409,
            ));
        }
        if current.private_listening == enabled {
            return Ok(current);
        }

        let now = Utc::now();
        let now_iso = now.to_rfc3339();
        let day_ago_iso = (now - chrono::Duration::hours(24)).to_rfc3339();

        let mut tx = self
            .db
            .inner()
            .begin()
            .await
            .map_err(|_| TasteProfileError::new("Database error", 400))?;

        sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .ok();

        if enabled {
            sqlx::query(
                "INSERT INTO taste_private_periods (id, user_id, started_at) VALUES (?, ?, ?)",
            )
            .bind(format!("private_{}", nanoid!(16)))
            .bind(user_id)
            .bind(&now_iso)
            .execute(&mut *tx)
            .await
            .ok();

            sqlx::query(
                "UPDATE taste_settings SET provider_history_disabled = 1 WHERE user_id = ? AND provider_history_disabled = 0",
            )
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .ok();

            sqlx::query(
                r"
                UPDATE listening_events
                SET taste_excluded = 1
                WHERE user_id = ?
                  AND playback_session_id IS NOT NULL
                  AND finished = 0
                  AND updated_at >= ?
                ",
            )
            .bind(user_id)
            .bind(&day_ago_iso)
            .execute(&mut *tx)
            .await
            .ok();

            sqlx::query(
                r"
                UPDATE recently_played
                SET taste_excluded = 1
                WHERE user_id = ?
                  AND playback_session_id IN (
                      SELECT playback_session_id FROM listening_events
                      WHERE user_id = ? AND taste_excluded = 1
                  )
                ",
            )
            .bind(user_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .ok();
        } else {
            sqlx::query(
                "UPDATE taste_private_periods SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL",
            )
            .bind(&now_iso)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .ok();
        }

        sqlx::query(
            "UPDATE taste_settings SET private_listening = ?, revision = revision + 1 WHERE user_id = ?",
        )
        .bind(i64::from(enabled))
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .ok();

        tx.commit()
            .await
            .map_err(|_| TasteProfileError::new("Database error", 400))?;

        Ok(self.state(user_id).await)
    }

    /// Evaluates whether an incoming playback event should be excluded from taste profiling.
    pub async fn decision(
        &self,
        user_id: &str,
        track_id: &str,
        started_at: &str,
        reported_at: Option<&str>,
        private_listening_flag: bool,
        exclude_from_taste_flag: bool,
        playlist_id: Option<&str>,
        title: Option<&str>,
        artist: Option<&str>,
    ) -> TasteExclusionDecision {
        let state = self.state(user_id).await;
        let now_iso = Utc::now().to_rfc3339();
        let at = reported_at.unwrap_or(&now_iso);

        let recording_key = match (title, artist) {
            (Some(t), Some(a)) if !t.trim().is_empty() && !a.trim().is_empty() => {
                Some(taste_recording_key(t, a))
            }
            _ => None,
        };

        let in_private_period = sqlx::query(
            r"
            SELECT 1 FROM taste_private_periods
            WHERE user_id = ?
              AND started_at <= ?
              AND COALESCE(ended_at, '9999') >= ?
            LIMIT 1
            ",
        )
        .bind(user_id)
        .bind(at)
        .bind(started_at)
        .fetch_optional(self.db.inner())
        .await
        .ok()
        .flatten()
        .is_some();

        let playlist_excluded = if let Some(pid) = playlist_id {
            sqlx::query(
                "SELECT exclude_from_taste FROM playlists WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(pid)
            .fetch_optional(self.db.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i64, _>("exclude_from_taste").ok())
            .unwrap_or(0)
                != 0
        } else {
            false
        };

        let track_excluded = sqlx::query(
            r"
            SELECT 1 FROM taste_track_exclusions
            WHERE user_id = ? AND (track_id = ? OR recording_key = ?)
            LIMIT 1
            ",
        )
        .bind(user_id)
        .bind(track_id)
        .bind(recording_key.as_deref())
        .fetch_optional(self.db.inner())
        .await
        .ok()
        .flatten()
        .is_some();

        let before_reset = state
            .reset_before
            .as_deref()
            .is_some_and(|reset| started_at <= reset);

        let excluded = state.private_listening
            || private_listening_flag
            || exclude_from_taste_flag
            || in_private_period
            || playlist_excluded
            || track_excluded
            || before_reset;

        if excluded {
            let _ = sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
                .bind(user_id)
                .execute(self.db.inner())
                .await;
            let _ = sqlx::query(
                "UPDATE taste_settings SET provider_history_disabled = 1 WHERE user_id = ? AND provider_history_disabled = 0",
            )
            .bind(user_id)
            .execute(self.db.inner())
            .await;
        }

        TasteExclusionDecision {
            excluded,
            recording_key,
            playlist_id: playlist_id.map(str::to_owned),
        }
    }

    /// Sets `exclude_from_taste` on a playlist managed by `user`.
    pub async fn set_playlist(
        &self,
        user: &UserRecord,
        playlist_id: &str,
        excluded: bool,
    ) -> Result<(String, bool), TasteProfileError> {
        let collab = PlaylistCollaborationService::new(self.db.clone());
        let access = collab
            .access(playlist_id, user, false)
            .await
            .map_err(|_| TasteProfileError::new("Playlist not found or not editable.", 404))?;
        if !access.can_manage {
            return Err(TasteProfileError::new(
                "Playlist not found or not editable.",
                404,
            ));
        }

        let mut tx = self
            .db
            .inner()
            .begin()
            .await
            .map_err(|_| TasteProfileError::new("Database error", 400))?;

        sqlx::query("UPDATE playlists SET exclude_from_taste = ? WHERE id = ?")
            .bind(i64::from(excluded))
            .bind(playlist_id)
            .execute(&mut *tx)
            .await
            .ok();

        if excluded {
            sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
                .bind(&user.id)
                .execute(&mut *tx)
                .await
                .ok();
            sqlx::query(
                "UPDATE taste_settings SET provider_history_disabled = 1 WHERE user_id = ? AND provider_history_disabled = 0",
            )
            .bind(&user.id)
            .execute(&mut *tx)
            .await
            .ok();
            sqlx::query(
                r"
                UPDATE listening_events
                SET taste_excluded = 1
                WHERE user_id = ? AND context_playlist_id = ? AND finished = 0
                ",
            )
            .bind(&user.id)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await
            .ok();
            sqlx::query(
                r"
                UPDATE recently_played
                SET taste_excluded = 1
                WHERE user_id = ?
                  AND playback_session_id IN (
                      SELECT playback_session_id FROM listening_events
                      WHERE user_id = ? AND context_playlist_id = ? AND taste_excluded = 1
                  )
                ",
            )
            .bind(&user.id)
            .bind(&user.id)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await
            .ok();
        }

        tx.commit()
            .await
            .map_err(|_| TasteProfileError::new("Database error", 400))?;

        self.bump(&user.id).await;
        Ok((playlist_id.to_owned(), excluded))
    }

    async fn rebuild_activity(&self, user_id: &str) {
        let _ = sqlx::query("DELETE FROM smart_playlist_activity WHERE user_id = ?")
            .bind(user_id)
            .execute(self.db.inner())
            .await;

        let _ = sqlx::query(
            r"
            INSERT INTO smart_playlist_activity (user_id, track_id, plays, skips, last_played)
            SELECT
                user_id,
                track_id,
                COUNT(CASE WHEN event_type IN ('play', 'complete') THEN 1 END),
                SUM(CASE WHEN event_type = 'skip' OR (event_type = 'progress' AND finished = 1 AND listened_seconds > 0) THEN 1 ELSE 0 END),
                MAX(CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER))
            FROM taste_listening_events
            WHERE user_id = ?
            GROUP BY user_id, track_id
            ",
        )
        .bind(user_id)
        .execute(self.db.inner())
        .await;

        let _ = sqlx::query(
            r"
            INSERT INTO smart_playlist_activity (user_id, track_id, recent_plays, recent_last_played)
            SELECT
                user_id,
                track_id,
                COUNT(*),
                MAX(CAST(ROUND((julianday(played_at) - 2440587.5) * 86400000) AS INTEGER))
            FROM taste_recently_played
            WHERE user_id = ?
            GROUP BY user_id, track_id
            ON CONFLICT(user_id, track_id) DO UPDATE SET
                recent_plays = excluded.recent_plays,
                recent_last_played = excluded.recent_last_played
            ",
        )
        .bind(user_id)
        .execute(self.db.inner())
        .await;
    }

    /// Resolves missing `title`/`artist`/`album` fields for a [`TasteTarget`] from cached catalog payloads.
    pub async fn resolve(&self, mut target: TasteTarget) -> TasteTarget {
        let item_type = target
            .item_type
            .clone()
            .unwrap_or_else(|| String::from("track"));
        target.item_type = Some(item_type.clone());

        if item_type == "track" {
            if let Ok(Some(row)) = sqlx::query(
                "SELECT track_json FROM smart_playlist_track_payloads WHERE track_id = ?",
            )
            .bind(&target.id)
            .fetch_optional(self.db.inner())
            .await
            {
                if let Ok(json_str) = row.try_get::<String, _>("track_json") {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        if target.title.is_none() {
                            target.title = val
                                .get("title")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                        }
                        if target.artist.is_none() {
                            target.artist = val
                                .get("artistName")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                        }
                        if target.album.is_none() {
                            target.album = val
                                .get("albumName")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                        }
                        if target.artist_id.is_none() {
                            target.artist_id = val
                                .get("artistId")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                        }
                        if target.album_id.is_none() {
                            target.album_id = val
                                .get("albumId")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                        }
                    }
                }
            }
        }

        target
    }

    /// Excludes or re-includes a recording in `taste_track_exclusions`.
    pub async fn set_track(
        &self,
        user_id: &str,
        target: TasteTarget,
        excluded: bool,
    ) -> Result<(), TasteProfileError> {
        let resolved = self.resolve(target).await;
        let title = resolved
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let artist = resolved
            .artist
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if excluded && (title.is_none() || artist.is_none()) {
            return Err(TasteProfileError::new(
                "A song title and artist are needed to exclude this recording.",
                400,
            ));
        }

        if excluded {
            let (title, artist) = (title.unwrap_or_default(), artist.unwrap_or_default());
            let rec_key = taste_recording_key(title, artist);
            let now_iso = Utc::now().to_rfc3339();

            let _ = sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
                .bind(user_id)
                .execute(self.db.inner())
                .await;
            let _ = sqlx::query(
                "UPDATE taste_settings SET provider_history_disabled = 1 WHERE user_id = ? AND provider_history_disabled = 0",
            )
            .bind(user_id)
            .execute(self.db.inner())
            .await;

            sqlx::query(
                r"
                INSERT INTO taste_track_exclusions (
                    user_id, track_id, recording_key, title, artist, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, track_id) DO UPDATE SET
                    recording_key = excluded.recording_key,
                    title = excluded.title,
                    artist = excluded.artist
                ",
            )
            .bind(user_id)
            .bind(&resolved.id)
            .bind(rec_key)
            .bind(title)
            .bind(artist)
            .bind(now_iso)
            .execute(self.db.inner())
            .await
            .map_err(|_| TasteProfileError::new("Database error", 400))?;
        } else {
            let existing_key: String = sqlx::query(
                "SELECT recording_key FROM taste_track_exclusions WHERE user_id = ? AND track_id = ?",
            )
            .bind(user_id)
            .bind(&resolved.id)
            .fetch_optional(self.db.inner())
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("recording_key").ok())
            .unwrap_or_default();

            let _ = sqlx::query(
                "DELETE FROM taste_track_exclusions WHERE user_id = ? AND (track_id = ? OR recording_key = ?)",
            )
            .bind(user_id)
            .bind(&resolved.id)
            .bind(existing_key)
            .execute(self.db.inner())
            .await;
        }

        self.rebuild_activity(user_id).await;
        self.bump(user_id).await;
        Ok(())
    }

    /// Resets the taste profile for `user_id` (`reset_before = now`), clearing `smart_playlist_activity`.
    pub async fn reset(
        &self,
        user_id: &str,
        expected_revision: i64,
    ) -> Result<TasteState, TasteProfileError> {
        let current = self.state(user_id).await;
        if current.revision != expected_revision {
            return Err(TasteProfileError::new(
                "Taste settings changed elsewhere. Refresh and try again.",
                409,
            ));
        }

        let now_iso = Utc::now().to_rfc3339();
        let _ = sqlx::query("INSERT OR IGNORE INTO taste_settings (user_id) VALUES (?)")
            .bind(user_id)
            .execute(self.db.inner())
            .await;
        let _ = sqlx::query(
            r"
            UPDATE taste_settings
            SET provider_history_disabled = 1,
                reset_before = ?,
                revision = revision + 1
            WHERE user_id = ?
            ",
        )
        .bind(now_iso)
        .bind(user_id)
        .execute(self.db.inner())
        .await;

        let _ = sqlx::query("DELETE FROM smart_playlist_activity WHERE user_id = ?")
            .bind(user_id)
            .execute(self.db.inner())
            .await;

        Ok(self.state(user_id).await)
    }

    async fn negative_rows(&self, user_id: &str) -> Vec<NegativeFeedbackRow> {
        let rows = sqlx::query(
            r"
            SELECT item_type, item_id, action, updated_at,
                   identity_title, identity_artist, identity_album
            FROM recommendation_feedback
            WHERE user_id = ?
              AND action IN ('hide', 'not-interested', 'block-artist', 'block-album')
            ORDER BY updated_at DESC, item_type, item_id
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        .unwrap_or_default();

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let item_type: String = row.try_get("item_type").unwrap_or_default();
            let item_id: String = row.try_get("item_id").unwrap_or_default();
            let updated_at: String = row.try_get("updated_at").unwrap_or_default();
            let target = self
                .resolve(TasteTarget {
                    id: item_id.clone(),
                    item_type: Some(item_type.clone()),
                    title: row.try_get("identity_title").ok(),
                    artist: row.try_get("identity_artist").ok(),
                    album: row.try_get("identity_album").ok(),
                    artist_id: None,
                    album_id: None,
                })
                .await;
            out.push(NegativeFeedbackRow {
                item_type,
                item_id,
                updated_at,
                target,
            });
        }
        out
    }

    fn target_identity(target: &TasteTarget) -> Option<String> {
        let item_type = target.item_type.as_deref().unwrap_or("track");
        if item_type == "artist" {
            let name = target.artist.as_deref().or(target.title.as_deref());
            let norm = normalize_music_text(name);
            return (!norm.is_empty()).then_some(norm);
        }
        if item_type == "album" {
            let album = target.album.as_deref().or(target.title.as_deref())?;
            let artist = target.artist.as_deref()?;
            return Some(taste_recording_key(album, artist));
        }
        let title = target.title.as_deref()?;
        let artist = target.artist.as_deref()?;
        Some(taste_recording_key(title, artist))
    }

    /// Builds a [`TasteFeedbackFilter`] for `user_id`.
    pub async fn feedback_filter(
        &self,
        user_id: &str,
        catalog: &[TasteTarget],
    ) -> TasteFeedbackFilter {
        let rows = self.negative_rows(user_id).await;
        if rows.is_empty() {
            return TasteFeedbackFilter::default();
        }

        let mut filter = TasteFeedbackFilter::default();
        let supplied: HashMap<String, &TasteTarget> = catalog
            .iter()
            .map(|item| {
                (
                    format!(
                        "{}:{}",
                        item.item_type.as_deref().unwrap_or("track"),
                        item.id
                    ),
                    item,
                )
            })
            .collect();

        for neg in rows {
            let key = format!("{}:{}", neg.item_type, neg.item_id);
            filter.ids.insert(key.clone());

            let mut merged = neg.target.clone();
            if let Some(sup) = supplied.get(&key) {
                if merged.title.is_none() {
                    merged.title = sup.title.clone();
                }
                if merged.artist.is_none() {
                    merged.artist = sup.artist.clone();
                }
                if merged.album.is_none() {
                    merged.album = sup.album.clone();
                }
            }

            let id_opt = Self::target_identity(&merged);
            if let Some(ref ident) = id_opt {
                match neg.item_type.as_str() {
                    "artist" => {
                        filter.artists.insert(ident.clone());
                    }
                    "album" => {
                        filter.albums.insert(ident.clone());
                    }
                    _ => {
                        filter.tracks.insert(ident.clone());
                    }
                }
            } else if neg.item_type == "artist" {
                for item in catalog {
                    if item.artist_id.as_deref() == Some(neg.item_id.as_str()) {
                        if let Some(artist) = &item.artist {
                            let norm = normalize_music_text(Some(artist));
                            if !norm.is_empty() {
                                filter.artists.insert(norm);
                            }
                        }
                    }
                }
            } else if neg.item_type == "album" {
                for item in catalog {
                    if item.album_id.as_deref() == Some(neg.item_id.as_str()) {
                        if let (Some(album), Some(artist)) = (&item.album, &item.artist) {
                            filter.albums.insert(taste_recording_key(album, artist));
                        }
                    }
                }
            }
        }

        filter
    }

    /// Lists grouped hidden/blocked feedback items for `user_id`.
    pub async fn hidden(&self, user_id: &str) -> Vec<TasteHiddenItem> {
        let rows = self.negative_rows(user_id).await;
        let mut order = Vec::new();
        let mut groups: HashMap<String, TasteHiddenItem> = HashMap::new();

        for neg in rows {
            let ident = Self::target_identity(&neg.target).unwrap_or_else(|| neg.item_id.clone());
            let group_key = format!("{}:{ident}", neg.item_type);
            if let Some(existing) = groups.get_mut(&group_key) {
                existing.aliases += 1;
                continue;
            }
            let title = match neg.item_type.as_str() {
                "artist" => neg
                    .target
                    .artist
                    .clone()
                    .or_else(|| neg.target.title.clone()),
                "album" => neg
                    .target
                    .album
                    .clone()
                    .or_else(|| neg.target.title.clone()),
                _ => neg.target.title.clone(),
            }
            .unwrap_or_else(|| neg.item_id.clone());

            order.push(group_key.clone());
            groups.insert(
                group_key,
                TasteHiddenItem {
                    id: neg.item_id,
                    item_type: neg.item_type,
                    title,
                    artist: neg.target.artist.unwrap_or_default(),
                    album: neg.target.album.unwrap_or_default(),
                    aliases: 1,
                    updated_at: neg.updated_at,
                },
            );
        }

        order
            .into_iter()
            .filter_map(|k| groups.remove(&k))
            .collect()
    }

    /// Restores a previously hidden/blocked item and all its identity aliases.
    pub async fn restore(
        &self,
        user_id: &str,
        item_type: &str,
        id: &str,
    ) -> Result<(), TasteProfileError> {
        let rows = self.negative_rows(user_id).await;
        let Some(selected) = rows
            .iter()
            .find(|r| r.item_type == item_type && r.item_id == id)
        else {
            return Err(TasteProfileError::new(
                "This item is already restored. Refresh the list.",
                404,
            ));
        };

        let target_ident = Self::target_identity(&selected.target);
        for neg in &rows {
            if neg.item_type != item_type {
                continue;
            }
            let same_ident = target_ident.as_ref().is_some_and(|ident| {
                Self::target_identity(&neg.target).as_ref() == Some(ident)
            });
            if neg.item_id == id || same_ident {
                let _ = sqlx::query(
                    r"
                    DELETE FROM recommendation_feedback
                    WHERE user_id = ? AND item_type = ? AND item_id = ?
                      AND action IN ('hide', 'not-interested', 'block-artist', 'block-album')
                    ",
                )
                .bind(user_id)
                .bind(item_type)
                .bind(&neg.item_id)
                .execute(self.db.inner())
                .await;
            }
        }

        Ok(())
    }

    /// Returns the complete [`TasteProfileOverview`] for `user_id`.
    pub async fn overview(&self, user_id: &str) -> TasteProfileOverview {
        let state = self.state(user_id).await;
        let hidden = self.hidden(user_id).await;

        let track_rows = sqlx::query(
            "SELECT track_id AS id, title, artist FROM taste_track_exclusions WHERE user_id = ? ORDER BY title, track_id",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        .unwrap_or_default();

        let track_exclusions = track_rows
            .into_iter()
            .filter_map(|r| {
                Some(TasteExcludedTrack {
                    id: r.try_get("id").ok()?,
                    title: r.try_get("title").ok(),
                    artist: r.try_get("artist").ok(),
                })
            })
            .collect();

        let playlist_rows = sqlx::query(
            r"
            SELECT id, name FROM playlists
            WHERE owner_user_id = ? AND deleted_at IS NULL AND exclude_from_taste = 1
            ORDER BY name, id
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await
        .unwrap_or_default();

        let playlist_exclusions = playlist_rows
            .into_iter()
            .filter_map(|r| {
                Some(TasteExcludedPlaylist {
                    id: r.try_get("id").ok()?,
                    name: r.try_get("name").ok()?,
                })
            })
            .collect();

        let eligible_listens: i64 = sqlx::query(
            "SELECT COUNT(*) AS n FROM taste_listening_events WHERE user_id = ? AND counted = 1",
        )
        .bind(user_id)
        .fetch_optional(self.db.inner())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("n").ok())
        .unwrap_or(0);

        TasteProfileOverview {
            private_listening: state.private_listening,
            revision: state.revision,
            reset_before: state.reset_before,
            provider_history_disabled: state.provider_history_disabled,
            hidden,
            track_exclusions,
            playlist_exclusions,
            eligible_listens,
        }
    }
}
