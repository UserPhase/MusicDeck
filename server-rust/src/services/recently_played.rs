//! # Recently Played Queue & Retention Service (`services::recently_played`)
//!
//! Complete Rust port of `server/src/domain/recently-played.ts`.
//!
//! ## Retention & Multi-User Rules
//! - Stores up to [`RECENTLY_PLAYED_RETENTION`] (`100`) rows per user in `recently_played`,
//!   returning the most recent [`RECENTLY_PLAYED_LIMIT`] (`50`) distinct tracks played
//!   within the last [`LISTENING_WINDOW_DAYS`] (`45` days).
//! - [`can_use_provider_history`] returns `true` only when at most 1 enabled user account
//!   exists on the server so shared Navidrome/Jellyfin service accounts never leak one
//!   person's external client plays into another user's recently played list.

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, Row};

use crate::db::{DbError, DbPool, create_id};

/// Maximum number of distinct recently-played tracks returned to clients.
pub const RECENTLY_PLAYED_LIMIT: i64 = 50;

/// Maximum number of raw rows retained per user in `recently_played`.
pub const RECENTLY_PLAYED_RETENTION: i64 = 100;

/// Rolling window in days (`45`) for recently played queries.
pub const LISTENING_WINDOW_DAYS: i64 = 45;

/// Deduplicated recently played entry from `recently_played` or `taste_recently_played`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentlyPlayedEntry {
    /// Stable MusicDeck track ID.
    pub track_id: String,
    /// ISO-8601 timestamp of the most recent play.
    pub played_at: String,
}

/// Computes the ISO-8601 cutoff timestamp for [`LISTENING_WINDOW_DAYS`] ago.
#[must_use]
pub fn listening_window_start_iso() -> String {
    (Utc::now() - Duration::days(LISTENING_WINDOW_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Returns `true` if at most one active (`disabled = 0`) user exists in `users`,
/// matching `canUseProviderHistory(db)` in `server/src/domain/recently-played.ts`.
pub async fn can_use_provider_history(pool: &DbPool) -> Result<bool, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS count FROM users WHERE disabled = 0;")
        .fetch_one(pool.inner())
        .await?;
    let count: i64 = row.try_get("count")?;
    Ok(count <= 1)
}

/// Records a track play in `recently_played` and trims rows older than the newest
/// [`RECENTLY_PLAYED_RETENTION`] (`100`) entries for `user_id` inside a single transaction.
pub async fn add_recently_played(
    pool: &DbPool,
    user_id: &str,
    track_id: &str,
    played_at_iso: Option<&str>,
    taste_excluded: bool,
    playback_session_id: Option<&str>,
    taste_recording_key: Option<&str>,
) -> Result<String, DbError> {
    let id = create_id("recent");
    let played_at = played_at_iso.map_or_else(
        || Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        str::to_owned,
    );

    let mut conn = pool.inner().acquire().await?;
    let mut tx = conn.begin().await?;

    sqlx::query(
        r"
        INSERT INTO recently_played
          (id, user_id, track_id, played_at, taste_excluded, playback_session_id, taste_recording_key)
        VALUES (?, ?, ?, ?, ?, ?, ?);
        ",
    )
    .bind(&id)
    .bind(user_id)
    .bind(track_id)
    .bind(&played_at)
    .bind(i64::from(taste_excluded))
    .bind(playback_session_id)
    .bind(taste_recording_key)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r"
        DELETE FROM recently_played
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id
            FROM recently_played
            WHERE user_id = ?
            ORDER BY played_at DESC
            LIMIT ?
          );
        ",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(RECENTLY_PLAYED_RETENTION)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(id)
}

/// Queries the most recent [`RECENTLY_PLAYED_LIMIT`] (`50`) distinct track plays for `user_id`
/// within the 45-day window (`taste_only = true` queries the `taste_recently_played` view).
pub async fn list_recently_played_entries(
    pool: &DbPool,
    user_id: &str,
    taste_only: bool,
) -> Result<Vec<RecentlyPlayedEntry>, DbError> {
    let table = if taste_only {
        "taste_recently_played"
    } else {
        "recently_played"
    };
    let cutoff = listening_window_start_iso();
    let sql = format!(
        r"
        SELECT track_id, MAX(played_at) AS played_at
        FROM {table}
        WHERE user_id = ? AND played_at >= ?
        GROUP BY track_id
        ORDER BY played_at DESC
        LIMIT ?;
        "
    );

    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(cutoff)
        .bind(RECENTLY_PLAYED_LIMIT)
        .fetch_all(pool.inner())
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(RecentlyPlayedEntry {
            track_id: row.try_get("track_id")?,
            played_at: row.try_get("played_at")?,
        });
    }
    Ok(out)
}
