//! # Listening Activity, Scrobble Point & Statistics Service (`services::listening_activity`)
//!
//! Complete Rust port of `server/src/domain/listening-activity.ts` and
//! `server/src/routes/listening-activity-routes.ts`.
//!
//! ## Core Telemetry Invariants
//! 1. **Scrobble Point ([`scrobble_point_seconds`])**:
//!    - Qualified scrobble threshold is `min(20.0, duration_seconds / 2.0)` when
//!      `duration_seconds > 0`, or `20.0` seconds when duration is unknown.
//! 2. **Cumulative Session Deduplication ([`record_playback`])**:
//!    - Keyed by `(user_id, playback_session_id)`.
//!    - Rejects session reuse if `track_id` or `started_at` differs from the existing row.
//!    - Clamps reported `listened_seconds` against elapsed wall-clock time `(now - started)`
//!      and takes `max(previous.listened_seconds, clamped)` so retries or out-of-order
//!      progress reports never double-count seconds or trigger duplicate scrobbles.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, Row};
use thiserror::Error;

use crate::db::{DbError, DbPool, create_id};
use crate::scrobbling::{ScrobbleError, ScrobbleQueueService};

/// Maximum listening time (`20.0` seconds) required before a track reaches its scrobble point.
pub const SCROBBLE_MAX_SECONDS: f64 = 20.0;

/// Default listening threshold (`30.0` seconds) for counting a play in listening statistics.
pub const DEFAULT_LISTENING_THRESHOLD_SECONDS: f64 = 30.0;

/// Supported time windows for listening history and statistics queries.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivityPeriod {
    /// Last 7 days.
    #[serde(rename = "7")]
    Days7,
    /// Last 30 days.
    #[serde(rename = "30")]
    Days30,
    /// Last 90 days.
    #[serde(rename = "90")]
    Days90,
    /// Current UTC calendar year (`Jan 1 00:00:00Z` to present).
    #[serde(rename = "year")]
    Year,
    /// All recorded history.
    #[default]
    #[serde(rename = "all")]
    All,
}

impl ActivityPeriod {
    /// Parses a query parameter string (`"7"`, `"30"`, `"90"`, `"year"`, `"all"`).
    pub fn parse_str(raw: &str) -> Result<Self, ListeningActivityError> {
        match raw.trim() {
            "7" => Ok(Self::Days7),
            "30" => Ok(Self::Days30),
            "90" => Ok(Self::Days90),
            "year" => Ok(Self::Year),
            "all" | "" => Ok(Self::All),
            _ => Err(ListeningActivityError::Validation(String::from(
                "Invalid statistics period",
            ))),
        }
    }

    /// Returns the wire string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Days7 => "7",
            Self::Days30 => "30",
            Self::Days90 => "90",
            Self::Year => "year",
            Self::All => "all",
        }
    }

    /// Computes the lower-bound ISO-8601 timestamp for this [`ActivityPeriod`].
    #[must_use]
    pub fn start_timestamp_iso(self, now: DateTime<Utc>) -> String {
        match self {
            Self::All => String::from("0000"),
            Self::Year => Utc
                .with_ymd_and_hms(now.year(), 1, 1, 0, 0, 0)
                .single()
                .unwrap_or(now)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            Self::Days7 => (now - Duration::days(7))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            Self::Days30 => (now - Duration::days(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            Self::Days90 => (now - Duration::days(90))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// Embedded track metadata snapshot submitted with a [`PlaybackEventInput`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTrackSnapshot {
    /// Track title.
    pub title: String,
    /// Artist name.
    pub artist: String,
    /// Album title.
    pub album: String,
    /// Optional artist ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    /// Optional album ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    /// Optional artwork ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_art: Option<String>,
    /// Optional cover artwork URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
}

/// Payload accepted by `POST /api/listening-events` (`playbackEventSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackEventInput {
    /// Client-generated session identifier (`8..=100` alphanumeric/`_`/`-` chars).
    pub playback_session_id: String,
    /// Optional owner user ID.
    pub owner_user_id: Option<String>,
    /// Played track ID.
    pub track_id: String,
    /// ISO-8601 UTC timestamp when playback started.
    pub started_at: String,
    /// Cumulative seconds listened during this playback session (`0..=86400`).
    pub listened_seconds: f64,
    /// Track duration in seconds (`> 0..=86400`), if known.
    pub duration_seconds: Option<f64>,
    /// Whether playback reached the end of the track.
    pub finished: bool,
    /// Optional client name (`"MusicDeck Web"`, `"MusicDeck Desktop"`, etc.).
    pub client_name: Option<String>,
    /// Whether private listening mode was active for this session.
    pub private_listening: Option<bool>,
    /// Whether this play should be excluded from taste profile calculations.
    pub exclude_from_taste: Option<bool>,
    /// Optional context playlist ID.
    pub playlist_id: Option<String>,
    /// Optional ISO-8601 timestamp when the report was generated.
    pub reported_at: Option<String>,
    /// Track metadata snapshot persisted in `listening_events.track_json`.
    pub track: PlaybackTrackSnapshot,
}

/// Outcome returned by [`record_playback`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPlaybackOutcome {
    /// `listening_events.id` (`listen_<nanoid>`).
    pub id: String,
    /// Whether the session has crossed the configured `listening.thresholdSeconds`.
    pub counted: bool,
    /// `true` on the exact report that transitioned `counted` from `false` to `true`.
    pub newly_counted: bool,
    /// `true` on the exact report that crossed [`scrobble_point_seconds`].
    pub scrobble_due: bool,
    /// Clamped cumulative listened seconds stored in SQLite.
    pub listened_seconds: f64,
    /// Whether the event is excluded from taste profile calculations.
    pub taste_excluded: bool,
}

/// Keyset pagination cursor for `GET /api/listening-activity/history`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryCursor {
    /// `created_at` ISO timestamp of the last item on the previous page.
    pub at: String,
    /// `id` of the last item on the previous page.
    pub id: String,
}

impl HistoryCursor {
    /// Decodes a `base64url`-encoded JSON cursor string.
    pub fn decode(encoded: &str) -> Result<Self, ListeningActivityError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| ListeningActivityError::Validation(String::from("Invalid history cursor")))?;
        let cursor: Self = serde_json::from_slice(&bytes)
            .map_err(|_| ListeningActivityError::Validation(String::from("Invalid history cursor")))?;
        if cursor.id.is_empty() || cursor.id.len() > 200 || DateTime::parse_from_rfc3339(&cursor.at).is_err() {
            return Err(ListeningActivityError::Validation(String::from(
                "Invalid history cursor",
            )));
        }
        Ok(cursor)
    }

    /// Encodes this cursor as a `base64url` string.
    #[must_use]
    pub fn encode(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        URL_SAFE_NO_PAD.encode(bytes)
    }
}

/// Hydrated listening history item returned by `GET /api/listening-activity/history`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningHistoryItem {
    /// Event ID.
    pub id: String,
    /// ISO-8601 timestamp when the listen started.
    pub played_at: String,
    /// Cumulative seconds listened.
    pub listened_seconds: Option<f64>,
    /// Hydrated track metadata object.
    pub track: Value,
}

/// Paginated response for `GET /api/listening-activity/history`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningHistoryResponse {
    /// Page of hydrated listening history items.
    pub items: Vec<ListeningHistoryItem>,
    /// Base64url cursor for the next page, or `None` when at the end of history.
    pub next_cursor: Option<String>,
}

/// Error taxonomy for listening activity operations.
#[derive(Debug, Error)]
pub enum ListeningActivityError {
    /// Request validation failure (`400 Bad Request`).
    #[error("{0}")]
    Validation(String),

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("SQLite error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("Scrobble queue error: {0}")]
    Scrobble(#[from] ScrobbleError),
}

/// Computes the scrobble point in seconds: `min(20.0, duration_seconds / 2.0)` when
/// `duration_seconds > 0`, or `20.0` seconds otherwise.
#[must_use]
pub fn scrobble_point_seconds(duration_seconds: Option<f64>) -> f64 {
    match duration_seconds {
        Some(d) if d.is_finite() && d > 0.0 => SCROBBLE_MAX_SECONDS.min(d / 2.0),
        _ => SCROBBLE_MAX_SECONDS,
    }
}

/// Reads the configured `listening.thresholdSeconds` from `server_settings`, defaulting to `30.0`.
pub async fn listening_threshold(pool: &DbPool) -> Result<f64, ListeningActivityError> {
    let row = sqlx::query(
        "SELECT value FROM server_settings WHERE key = 'listening.thresholdSeconds';",
    )
    .fetch_optional(pool.inner())
    .await?;

    let Some(row) = row else {
        return Ok(DEFAULT_LISTENING_THRESHOLD_SECONDS);
    };

    let raw: String = row.try_get("value")?;
    let val: f64 = serde_json::from_str(&raw).map_err(|_| {
        ListeningActivityError::Validation(String::from("Invalid configured listening threshold"))
    })?;

    if !val.is_finite() || !(1.0..=240.0).contains(&val) {
        return Err(ListeningActivityError::Validation(String::from(
            "Invalid configured listening threshold",
        )));
    }
    Ok(val)
}

/// Validates and records a cumulative [`PlaybackEventInput`] inside an atomic SQLite transaction.
pub async fn record_playback(
    pool: &DbPool,
    user_id: &str,
    event: &PlaybackEventInput,
) -> Result<RecordPlaybackOutcome, ListeningActivityError> {
    record_playback_with_scrobbles(pool, user_id, event, None).await
}

/// Records listening progress and qualified external listens in one transaction.
pub async fn record_playback_with_scrobbles(
    pool: &DbPool,
    user_id: &str,
    event: &PlaybackEventInput,
    scrobbles: Option<&ScrobbleQueueService>,
) -> Result<RecordPlaybackOutcome, ListeningActivityError> {
    validate_playback_event(event)?;

    let now = Utc::now();
    let started_dt = DateTime::parse_from_rfc3339(&event.started_at)
        .map_err(|_| {
            ListeningActivityError::Validation(String::from("Invalid startedAt timestamp"))
        })?
        .with_timezone(&Utc);

    if started_dt > now + Duration::seconds(5) || started_dt < now - Duration::days(30) {
        return Err(ListeningActivityError::Validation(String::from(
            "Playback start timestamp is outside the supported session window",
        )));
    }

    if let Some(ref rep_str) = event.reported_at {
        let rep_dt = DateTime::parse_from_rfc3339(rep_str)
            .map_err(|_| {
                ListeningActivityError::Validation(String::from("Invalid reportedAt timestamp"))
            })?
            .with_timezone(&Utc);
        if rep_dt < started_dt || rep_dt > now + Duration::seconds(5) {
            return Err(ListeningActivityError::Validation(String::from(
                "Playback report timestamp is outside the supported session window",
            )));
        }
    }

    let threshold_cfg = listening_threshold(pool).await?;
    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    let prev_row = sqlx::query(
        r"
        SELECT id, track_id, created_at, listened_seconds, duration_seconds, counted, finished, taste_excluded
        FROM listening_events
        WHERE user_id = ? AND playback_session_id = ?;
        ",
    )
    .bind(user_id)
    .bind(&event.playback_session_id)
    .fetch_optional(&mut *tx)
    .await?;

    let elapsed_wall_secs = ((now - started_dt).num_milliseconds() as f64 / 1000.0).max(0.0);
    let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(prev) = prev_row {
        let prev_id: String = prev.try_get("id")?;
        let prev_track_id: String = prev.try_get("track_id")?;
        let prev_created_at: String = prev.try_get("created_at")?;
        if prev_track_id != event.track_id || prev_created_at != event.started_at {
            tx.rollback().await?;
            return Err(ListeningActivityError::Validation(String::from(
                "Playback session cannot be reused for another listen",
            )));
        }

        let prev_seconds: f64 = prev
            .try_get::<Option<f64>, _>("listened_seconds")?
            .unwrap_or(0.0);
        let prev_duration: Option<f64> = prev.try_get("duration_seconds")?;
        let prev_counted: i64 = prev.try_get("counted")?;
        let prev_finished: i64 = prev.try_get("finished")?;
        let prev_excluded: i64 = prev.try_get("taste_excluded").unwrap_or(0);

        let seconds = prev_seconds.max(event.listened_seconds.min(elapsed_wall_secs));
        let duration = event.duration_seconds.or(prev_duration);
        let effective_threshold = duration.map_or(threshold_cfg, |d| threshold_cfg.min(d));
        let counted = prev_counted != 0 || seconds >= effective_threshold;
        let newly_counted = counted && prev_counted == 0;
        let scrobbled_before = prev_seconds >= scrobble_point_seconds(prev_duration);
        let scrobble_due = !scrobbled_before && seconds >= scrobble_point_seconds(duration);
        let finished = prev_finished != 0 || event.finished;
        let excluded = prev_excluded != 0
            || event.private_listening.unwrap_or(false)
            || event.exclude_from_taste.unwrap_or(false);
        let ratio = duration
            .filter(|&d| d > 0.0)
            .map(|d| (seconds / d).min(1.0));
        let event_type = if counted { "complete" } else { "progress" };

        sqlx::query(
            r"
            UPDATE listening_events
            SET listened_seconds = ?,
                duration_seconds = ?,
                counted = ?,
                finished = ?,
                event_type = ?,
                completion_ratio = ?,
                updated_at = ?,
                taste_excluded = ?
            WHERE id = ? AND user_id = ?;
            ",
        )
        .bind(seconds)
        .bind(duration)
        .bind(i64::from(counted))
        .bind(i64::from(finished))
        .bind(event_type)
        .bind(ratio)
        .bind(&now_iso)
        .bind(i64::from(excluded))
        .bind(&prev_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

        return commit_playback(
            tx,
            user_id,
            RecordPlaybackOutcome {
                id: prev_id,
                counted,
                newly_counted,
                scrobble_due,
                listened_seconds: seconds,
                taste_excluded: excluded,
            },
            scrobbles,
        )
        .await;
    }

    let id = create_id("listen");
    let seconds = event.listened_seconds.min(elapsed_wall_secs).max(0.0);
    let duration = event.duration_seconds;
    let effective_threshold = duration.map_or(threshold_cfg, |d| threshold_cfg.min(d));
    let counted = seconds >= effective_threshold;
    let scrobble_due = seconds >= scrobble_point_seconds(duration);
    let excluded =
        event.private_listening.unwrap_or(false) || event.exclude_from_taste.unwrap_or(false);
    let ratio = duration
        .filter(|&d| d > 0.0)
        .map(|d| (seconds / d).min(1.0));
    let event_type = if counted { "complete" } else { "progress" };

    let artist_lower = event.track.artist.trim().to_lowercase();
    let album_lower = event.track.album.trim().to_lowercase();
    let artist_key = event.track.artist_id.clone().or_else(|| {
        (!artist_lower.is_empty() && artist_lower != "unknown artist").then_some(artist_lower)
    });
    let album_key = event.track.album_id.clone().or_else(|| {
        (!album_lower.is_empty() && album_lower != "unknown album").then(|| {
            format!(
                "{}\u{001f}{album_lower}",
                artist_key.as_deref().unwrap_or("")
            )
        })
    });
    let track_json = serde_json::to_string(&event.track).unwrap_or_else(|_| String::from("{}"));

    sqlx::query(
        r"
        INSERT INTO listening_events (
          id, user_id, track_id, event_type, completion_ratio, created_at,
          playback_session_id, listened_seconds, duration_seconds, counted, finished,
          updated_at, track_json, artist_key, album_key, client_name, taste_excluded,
          context_playlist_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        ",
    )
    .bind(&id)
    .bind(user_id)
    .bind(&event.track_id)
    .bind(event_type)
    .bind(ratio)
    .bind(&event.started_at)
    .bind(&event.playback_session_id)
    .bind(seconds)
    .bind(duration)
    .bind(i64::from(counted))
    .bind(i64::from(event.finished))
    .bind(&now_iso)
    .bind(&track_json)
    .bind(&artist_key)
    .bind(&album_key)
    .bind(&event.client_name)
    .bind(i64::from(excluded))
    .bind(&event.playlist_id)
    .execute(&mut *tx)
    .await?;

    commit_playback(
        tx,
        user_id,
        RecordPlaybackOutcome {
            id,
            counted,
            newly_counted: counted,
            scrobble_due,
            listened_seconds: seconds,
            taste_excluded: excluded,
        },
        scrobbles,
    )
    .await
}

async fn commit_playback(
    mut transaction: sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: &str,
    outcome: RecordPlaybackOutcome,
    scrobbles: Option<&ScrobbleQueueService>,
) -> Result<RecordPlaybackOutcome, ListeningActivityError> {
    if let Some(queue) = scrobbles {
        queue
            .enqueue_recorded_playback(&mut transaction, user_id, &outcome.id)
            .await?;
    }
    transaction.commit().await?;
    if let Some(queue) = scrobbles {
        queue.kick();
    }
    Ok(outcome)
}

/// Queries paginated listening history for `user_id` (`counted = 1`).
pub async fn listening_history(
    pool: &DbPool,
    user_id: &str,
    period: ActivityPeriod,
    search: &str,
    limit: usize,
    cursor: Option<&HistoryCursor>,
) -> Result<ListeningHistoryResponse, ListeningActivityError> {
    let clamped_limit = limit.clamp(1, 50);
    let start_iso = period.start_timestamp_iso(Utc::now());
    let escaped_search = search
        .trim()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like_pattern = format!("%{escaped_search}%");
    let cursor_at = cursor.map_or("", |c| c.at.as_str());
    let cursor_id = cursor.map_or("", |c| c.id.as_str());

    let rows = sqlx::query(
        r"
        SELECT id, track_id, created_at, listened_seconds, duration_seconds, track_json
        FROM listening_events
        WHERE user_id = ? AND counted = 1 AND created_at >= ?
          AND (? = '' OR COALESCE(json_extract(track_json, '$.title'), track_id) LIKE ? ESCAPE '\'
            OR json_extract(track_json, '$.artist') LIKE ? ESCAPE '\'
            OR json_extract(track_json, '$.album') LIKE ? ESCAPE '\')
          AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?;
        ",
    )
    .bind(user_id)
    .bind(&start_iso)
    .bind(&escaped_search)
    .bind(&like_pattern)
    .bind(&like_pattern)
    .bind(&like_pattern)
    .bind(cursor_at)
    .bind(cursor_at)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(i64::try_from(clamped_limit + 1).unwrap_or(51))
    .fetch_all(pool.inner())
    .await?;

    let has_more = rows.len() > clamped_limit;
    let page = &rows[..rows.len().min(clamped_limit)];

    let mut items = Vec::with_capacity(page.len());
    let mut last_cursor = None;

    for (idx, row) in page.iter().enumerate() {
        let id: String = row.try_get("id")?;
        let track_id: String = row.try_get("track_id")?;
        let created_at: String = row.try_get("created_at")?;
        let listened_seconds: Option<f64> = row.try_get("listened_seconds")?;
        let duration_seconds: Option<f64> = row.try_get("duration_seconds")?;
        let track_json_opt: Option<String> = row.try_get("track_json")?;

        if idx + 1 == page.len() && has_more {
            last_cursor = Some(
                HistoryCursor {
                    at: created_at.clone(),
                    id: id.clone(),
                }
                .encode(),
            );
        }

        let mut snapshot = track_json_opt
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(|| json!({ "unavailable": true }));

        if let Value::Object(ref mut map) = snapshot {
            map.insert(String::from("id"), Value::String(track_id));
            if !map.contains_key("title") {
                map.insert(
                    String::from("title"),
                    Value::String(String::from("Unavailable track")),
                );
            }
            if !map.contains_key("artist") {
                map.insert(
                    String::from("artist"),
                    Value::String(String::from("Unknown artist")),
                );
            }
            if !map.contains_key("album") {
                map.insert(String::from("album"), Value::String(String::new()));
            }
            if !map.contains_key("duration") {
                map.insert(
                    String::from("duration"),
                    duration_seconds.map_or(Value::Null, |d| json!(d)),
                );
            }
            map.insert(
                String::from("source"),
                json!({ "kind": "library", "count": 1 }),
            );
        }

        items.push(ListeningHistoryItem {
            id,
            played_at: created_at,
            listened_seconds,
            track: snapshot,
        });
    }

    Ok(ListeningHistoryResponse {
        items,
        next_cursor: last_cursor,
    })
}

/// Computes aggregated listening statistics (`overview`, `topSongs`, `topArtists`, `topAlbums`,
/// and temporal buckets `daily`, `monthly`, `weekdays`, `hourly`) for `user_id`.
pub async fn listening_statistics(
    pool: &DbPool,
    user_id: &str,
    period: ActivityPeriod,
) -> Result<Value, ListeningActivityError> {
    let start_iso = period.start_timestamp_iso(Utc::now());

    let ov_row = sqlx::query(
        r"
        SELECT
          COALESCE(SUM(listened_seconds), 0.0) AS listeningSeconds,
          COALESCE(SUM(CASE WHEN counted = 1 THEN 1 ELSE 0 END), 0) AS plays,
          COUNT(DISTINCT CASE WHEN counted = 1 THEN track_id END) AS uniqueSongs,
          COUNT(DISTINCT CASE WHEN counted = 1 THEN artist_key END) AS uniqueArtists,
          COUNT(DISTINCT CASE WHEN counted = 1 THEN album_key END) AS uniqueAlbums,
          COALESCE(SUM(CASE WHEN counted = 1 AND listened_seconds IS NULL THEN 1 ELSE 0 END), 0) AS legacyPlays
        FROM listening_events
        WHERE user_id = ? AND created_at >= ?;
        ",
    )
    .bind(user_id)
    .bind(&start_iso)
    .fetch_one(pool.inner())
    .await?;

    let overview = json!({
        "listeningSeconds": ov_row.try_get::<f64, _>("listeningSeconds").unwrap_or(0.0),
        "plays": ov_row.try_get::<i64, _>("plays").unwrap_or(0),
        "uniqueSongs": ov_row.try_get::<i64, _>("uniqueSongs").unwrap_or(0),
        "uniqueArtists": ov_row.try_get::<i64, _>("uniqueArtists").unwrap_or(0),
        "uniqueAlbums": ov_row.try_get::<i64, _>("uniqueAlbums").unwrap_or(0),
        "legacyPlays": ov_row.try_get::<i64, _>("legacyPlays").unwrap_or(0),
    });

    let top_songs = query_top_entities(pool, user_id, &start_iso, "track_id", true).await?;
    let top_artists = query_top_entities(pool, user_id, &start_iso, "artist_key", false).await?;
    let top_albums = query_top_entities(pool, user_id, &start_iso, "album_key", false).await?;

    let daily = query_trend_buckets(pool, user_id, &start_iso, "%Y-%m-%d").await?;
    let monthly = query_trend_buckets(pool, user_id, &start_iso, "%Y-%m").await?;
    let weekdays = query_trend_buckets(pool, user_id, &start_iso, "%w").await?;
    let hourly = query_trend_buckets(pool, user_id, &start_iso, "%H").await?;

    Ok(json!({
        "period": period.as_str(),
        "timezone": "UTC",
        "overview": overview,
        "topSongs": top_songs,
        "topArtists": top_artists,
        "topAlbums": top_albums,
        "daily": daily,
        "monthly": monthly,
        "weekdays": weekdays,
        "hourly": hourly,
    }))
}

async fn query_top_entities(
    pool: &DbPool,
    user_id: &str,
    start_iso: &str,
    column: &str,
    order_by_plays_first: bool,
) -> Result<Vec<Value>, ListeningActivityError> {
    let order_clause = if order_by_plays_first {
        "plays DESC, listeningSeconds DESC"
    } else {
        "listeningSeconds DESC, plays DESC"
    };
    let sql = format!(
        r"
        SELECT {column} AS key, COUNT(*) AS plays, COALESCE(SUM(listened_seconds), 0.0) AS listeningSeconds,
               MAX(created_at) AS lastPlayedAt, track_json AS snapshot
        FROM listening_events
        WHERE user_id = ? AND created_at >= ? AND counted = 1 AND {column} IS NOT NULL
        GROUP BY {column}
        ORDER BY {order_clause}, key
        LIMIT 10;
        "
    );

    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(start_iso)
        .fetch_all(pool.inner())
        .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let key: String = row.try_get("key")?;
        let plays: i64 = row.try_get("plays")?;
        let listening_seconds: f64 = row.try_get("listeningSeconds")?;
        let snapshot_raw: Option<String> = row.try_get("snapshot")?;
        let track = snapshot_raw
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);

        items.push(json!({
            "key": key,
            "plays": plays,
            "listeningSeconds": listening_seconds,
            "track": track,
        }));
    }
    Ok(items)
}

async fn query_trend_buckets(
    pool: &DbPool,
    user_id: &str,
    start_iso: &str,
    strftime_fmt: &str,
) -> Result<Vec<Value>, ListeningActivityError> {
    let rows = sqlx::query(
        r"
        SELECT strftime(?, created_at) AS bucket,
               SUM(counted) AS plays,
               COALESCE(SUM(listened_seconds), 0.0) AS listeningSeconds
        FROM listening_events
        WHERE user_id = ? AND created_at >= ? AND (counted = 1 OR listened_seconds > 0)
        GROUP BY bucket
        ORDER BY bucket;
        ",
    )
    .bind(strftime_fmt)
    .bind(user_id)
    .bind(start_iso)
    .fetch_all(pool.inner())
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(json!({
            "bucket": row.try_get::<Option<String>, _>("bucket")?,
            "plays": row.try_get::<i64, _>("plays").unwrap_or(0),
            "listeningSeconds": row.try_get::<f64, _>("listeningSeconds").unwrap_or(0.0),
        }));
    }
    Ok(out)
}

fn validate_playback_event(event: &PlaybackEventInput) -> Result<(), ListeningActivityError> {
    let sid = event.playback_session_id.trim();
    if !(8..=100).contains(&sid.len())
        || !sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ListeningActivityError::Validation(String::from(
            "Invalid playbackSessionId",
        )));
    }
    if event.track_id.trim().is_empty() || event.track_id.len() > 300 {
        return Err(ListeningActivityError::Validation(String::from(
            "Invalid trackId",
        )));
    }
    if !event.listened_seconds.is_finite()
        || !(0.0..=86_400.0).contains(&event.listened_seconds)
    {
        return Err(ListeningActivityError::Validation(String::from(
            "Invalid listenedSeconds",
        )));
    }
    if let Some(d) = event.duration_seconds
        && (!d.is_finite() || d <= 0.0 || d > 86_400.0)
    {
        return Err(ListeningActivityError::Validation(String::from(
            "Invalid durationSeconds",
        )));
    }
    Ok(())
}
