//! # User Favorites Persistence (`services::favorites`)
//!
//! Complete Rust port of `server/src/domain/favorites.ts` plus album/media
//! favorites in `media_favorites` (Migrations 11 & 36).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::db::{DbError, DbPool};

/// Saved favorite album or media item row from `media_favorites`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFavoriteRecord {
    /// Media item type (`"album"`, `"artist"`, `"track"`).
    pub item_type: String,
    /// Stable MusicDeck or external item ID.
    pub item_id: String,
    /// ISO-8601 timestamp when favorited.
    pub created_at: String,
    /// Optional cached metadata snapshot JSON.
    pub metadata: Option<Value>,
}

/// Lists all favorited track IDs (`md_...`) for `user_id` ordered by `created_at DESC`.
pub async fn list_favorite_track_ids(
    pool: &DbPool,
    user_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows = sqlx::query(
        "SELECT track_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC;",
    )
    .bind(user_id)
    .fetch_all(pool.inner())
    .await?;

    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        ids.push(row.try_get("track_id")?);
    }
    Ok(ids)
}

/// Adds or removes `track_id` from `favorites` for `user_id`, matching
/// `setTrackFavorite` in `server/src/domain/favorites.ts`.
pub async fn set_track_favorite(
    pool: &DbPool,
    user_id: &str,
    track_id: &str,
    liked: bool,
) -> Result<(), DbError> {
    if liked {
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            "INSERT OR IGNORE INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?);",
        )
        .bind(user_id)
        .bind(track_id)
        .bind(now_iso)
        .execute(pool.inner())
        .await?;
    } else {
        sqlx::query("DELETE FROM favorites WHERE user_id = ? AND track_id = ?;")
            .bind(user_id)
            .bind(track_id)
            .execute(pool.inner())
            .await?;
    }
    Ok(())
}

/// Adds or removes a generic media favorite (`album`, `artist`, `track`) in `media_favorites`.
pub async fn set_media_favorite(
    pool: &DbPool,
    user_id: &str,
    item_type: &str,
    item_id: &str,
    liked: bool,
    metadata: Option<&Value>,
) -> Result<(), DbError> {
    if liked {
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let metadata_json = metadata.and_then(|m| serde_json::to_string(m).ok());
        sqlx::query(
            r"
            INSERT INTO media_favorites (user_id, item_type, item_id, created_at, metadata_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
              metadata_json = COALESCE(excluded.metadata_json, media_favorites.metadata_json);
            ",
        )
        .bind(user_id)
        .bind(item_type)
        .bind(item_id)
        .bind(now_iso)
        .bind(metadata_json)
        .execute(pool.inner())
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM media_favorites WHERE user_id = ? AND item_type = ? AND item_id = ?;",
        )
        .bind(user_id)
        .bind(item_type)
        .bind(item_id)
        .execute(pool.inner())
        .await?;
    }
    Ok(())
}

/// Lists all favorited albums for `user_id` from `media_favorites` ordered by `created_at DESC`.
pub async fn list_favorite_albums(
    pool: &DbPool,
    user_id: &str,
) -> Result<Vec<MediaFavoriteRecord>, DbError> {
    let rows = sqlx::query(
        r"
        SELECT item_type, item_id, created_at, metadata_json
        FROM media_favorites
        WHERE user_id = ? AND item_type = 'album'
        ORDER BY created_at DESC;
        ",
    )
    .bind(user_id)
    .fetch_all(pool.inner())
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let raw_meta: Option<String> = row.try_get("metadata_json")?;
        let metadata = raw_meta.and_then(|s| serde_json::from_str::<Value>(&s).ok());
        out.push(MediaFavoriteRecord {
            item_type: row.try_get("item_type")?,
            item_id: row.try_get("item_id")?,
            created_at: row.try_get("created_at")?,
            metadata,
        });
    }
    Ok(out)
}
