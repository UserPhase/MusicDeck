//! # Stable Library Identity & Content Revision Mapping (`catalog::library`)
//!
//! Complete Rust port of `server/src/domain/library.ts`.
//!
//! ## Core Invariants
//! - Maps `(connection_id, provider_item_id, item_type)` to a stable MusicDeck ID
//!   (`md_<24-char nanoid>` for tracks/albums/artists, `mdart_<24-char nanoid>` for artwork).
//! - Scoping by `item_type` ensures a Jellyfin item (whose artwork reference is its own
//!   item ID) maintains distinct `md_...` and `mdart_...` identities.
//! - Tracks carry a mutable `content_revision` UUID in `library_items` that rotates
//!   automatically whenever a provider reports a changed content fingerprint/path or
//!   completes a library rescan, invalidating stale silence-trim and loudness caches.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};
use uuid::Uuid;

use crate::db::{DbError, DbPool, create_id};

/// Discriminant for `library_items.type` and `library_item_sources.item_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryItemType {
    /// Audio track.
    Track,
    /// Album collection.
    Album,
    /// Artist profile.
    Artist,
    /// Cover/avatar artwork asset.
    Artwork,
}

impl LibraryItemType {
    /// Returns the database column literal (`"track"`, `"album"`, `"artist"`, `"artwork"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Album => "album",
            Self::Artist => "artist",
            Self::Artwork => "artwork",
        }
    }

    /// Parses a database item type string.
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "track" => Some(Self::Track),
            "album" => Some(Self::Album),
            "artist" => Some(Self::Artist),
            "artwork" => Some(Self::Artwork),
            _ => None,
        }
    }
}

/// Provider-scoped reference `(connection_id, provider_item_id)`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    /// `backend_connections.id` of the upstream provider.
    pub connection_id: String,
    /// Provider-native item identifier.
    pub provider_item_id: String,
}

/// Optional track content hint observed during catalog reads (`contentRevision.ts`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TrackContentHint {
    /// SHA-256 fingerprint of provider-reported file attributes (size, mtime, suffix).
    pub fingerprint: Option<String>,
    /// Canonical JSON string of sorted provider attributes.
    pub metadata_json: Option<String>,
    /// Optional provider-reported file path.
    pub file_path: Option<String>,
}

/// Service managing `library_items` and `library_item_sources` identity mappings.
#[derive(Debug, Clone)]
pub struct LibraryService {
    db: DbPool,
    music_root: Option<String>,
}

impl LibraryService {
    /// Creates a new [`LibraryService`] backed by `db` and an optional `music_root` path.
    #[must_use]
    pub const fn new(db: DbPool, music_root: Option<String>) -> Self {
        Self { db, music_root }
    }

    /// Returns the configured `music_root` path, if any.
    #[must_use]
    pub fn music_root(&self) -> Option<&str> {
        self.music_root.as_deref()
    }

    /// Resolves or creates the stable MusicDeck ID (`md_...` or `mdart_...`) for `ref_item`
    /// under `item_type`.
    pub async fn ensure_id(
        &self,
        item_type: LibraryItemType,
        ref_item: &SourceRef,
        content: Option<&TrackContentHint>,
    ) -> Result<String, DbError> {
        let existing = sqlx::query(
            r"
            SELECT library_item_id AS id
            FROM library_item_sources
            WHERE connection_id = ? AND provider_item_id = ? AND item_type = ?;
            ",
        )
        .bind(&ref_item.connection_id)
        .bind(&ref_item.provider_item_id)
        .bind(item_type.as_str())
        .fetch_optional(self.db.inner())
        .await?;

        if let Some(row) = existing {
            let id: String = row.try_get("id")?;
            if item_type == LibraryItemType::Track
                && let Some(hint) = content
            {
                self.observe_content(&id, ref_item, hint).await?;
            }
            return Ok(id);
        }

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let id = if item_type == LibraryItemType::Artwork {
            create_id("mdart")
        } else {
            create_id("md")
        };
        let revision = if item_type == LibraryItemType::Track {
            Uuid::new_v4().to_string()
        } else {
            String::new()
        };

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        sqlx::query(
            r"
            INSERT INTO library_items (id, type, created_at, updated_at, content_revision)
            VALUES (?, ?, ?, ?, ?);
            ",
        )
        .bind(&id)
        .bind(item_type.as_str())
        .bind(&now_iso)
        .bind(&now_iso)
        .bind(&revision)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r"
            INSERT INTO library_item_sources
              (library_item_id, item_type, connection_id, provider_item_id, created_at)
            VALUES (?, ?, ?, ?, ?);
            ",
        )
        .bind(&id)
        .bind(item_type.as_str())
        .bind(&ref_item.connection_id)
        .bind(&ref_item.provider_item_id)
        .bind(&now_iso)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        if item_type == LibraryItemType::Track
            && let Some(hint) = content
        {
            self.observe_content(&id, ref_item, hint).await?;
        }

        Ok(id)
    }

    /// Convenience wrapper for `ensure_id(LibraryItemType::Artwork, ref_item, None)`.
    pub async fn ensure_artwork_id(&self, ref_item: &SourceRef) -> Result<String, DbError> {
        self.ensure_id(LibraryItemType::Artwork, ref_item, None).await
    }

    /// Returns all mapped [`SourceRef`]s for `library_item_id` in insertion order (`created_at ASC`).
    pub async fn get_sources(&self, library_item_id: &str) -> Result<Vec<SourceRef>, DbError> {
        let rows = sqlx::query(
            r"
            SELECT connection_id, provider_item_id
            FROM library_item_sources
            WHERE library_item_id = ?
            ORDER BY created_at ASC;
            ",
        )
        .bind(library_item_id)
        .fetch_all(self.db.inner())
        .await?;

        let mut sources = Vec::with_capacity(rows.len());
        for row in rows {
            sources.push(SourceRef {
                connection_id: row.try_get("connection_id")?,
                provider_item_id: row.try_get("provider_item_id")?,
            });
        }
        Ok(sources)
    }

    /// Returns the first-mapped [`SourceRef`] for `library_item_id`, if any.
    pub async fn get_primary_source(
        &self,
        library_item_id: &str,
    ) -> Result<Option<SourceRef>, DbError> {
        Ok(self.get_sources(library_item_id).await?.into_iter().next())
    }

    /// Queries the [`LibraryItemType`] for `library_item_id`.
    pub async fn get_item_type(
        &self,
        library_item_id: &str,
    ) -> Result<Option<LibraryItemType>, DbError> {
        let row = sqlx::query("SELECT type FROM library_items WHERE id = ?;")
            .bind(library_item_id)
            .fetch_optional(self.db.inner())
            .await?;

        let Some(row) = row else {
            return Ok(None);
        };
        let type_str: String = row.try_get("type")?;
        Ok(LibraryItemType::parse_str(&type_str))
    }

    /// Attaches an additional provider [`SourceRef`] to an existing `library_item_id`.
    pub async fn add_source(
        &self,
        library_item_id: &str,
        ref_item: &SourceRef,
    ) -> Result<(), DbError> {
        let Some(item_type) = self.get_item_type(library_item_id).await? else {
            return Err(DbError::InvalidPath(format!(
                "Unknown library item: {library_item_id}"
            )));
        };

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            r"
            INSERT OR IGNORE INTO library_item_sources
              (library_item_id, item_type, connection_id, provider_item_id, created_at)
            VALUES (?, ?, ?, ?, ?);
            ",
        )
        .bind(library_item_id)
        .bind(item_type.as_str())
        .bind(&ref_item.connection_id)
        .bind(&ref_item.provider_item_id)
        .bind(&now_iso)
        .execute(self.db.inner())
        .await?;

        Ok(())
    }

    /// Returns `true` if `library_item_id` exists in `library_items`.
    pub async fn exists(&self, library_item_id: &str) -> Result<bool, DbError> {
        let row = sqlx::query("SELECT 1 FROM library_items WHERE id = ?;")
            .bind(library_item_id)
            .fetch_optional(self.db.inner())
            .await?;
        Ok(row.is_some())
    }

    /// Reads the current `content_revision` token for a track.
    pub async fn get_content_revision(&self, track_id: &str) -> Result<Option<String>, DbError> {
        let row = sqlx::query(
            "SELECT content_revision FROM library_items WHERE id = ? AND type = 'track';",
        )
        .bind(track_id)
        .fetch_optional(self.db.inner())
        .await?;

        Ok(row
            .and_then(|r| r.try_get::<String, _>("content_revision").ok())
            .filter(|s| !s.is_empty()))
    }

    /// Rotates `content_revision` and invalidates cached silence analyses for all tracks
    /// belonging to `connection_id` after a provider rescan.
    pub async fn invalidate_connection_content(&self, connection_id: &str) -> Result<(), DbError> {
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        sqlx::query(
            r"
            UPDATE library_items
            SET content_revision = lower(hex(randomblob(16))), updated_at = ?
            WHERE type = 'track'
              AND id IN (
                SELECT library_item_id FROM library_item_sources
                WHERE connection_id = ? AND item_type = 'track'
              );
            ",
        )
        .bind(&now_iso)
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r"
            DELETE FROM track_silence_analysis
            WHERE track_id IN (
              SELECT library_item_id FROM library_item_sources
              WHERE connection_id = ? AND item_type = 'track'
            );
            ",
        )
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r"
            DELETE FROM track_silence_analysis_profiles
            WHERE track_id IN (
              SELECT library_item_id FROM library_item_sources
              WHERE connection_id = ? AND item_type = 'track'
            );
            ",
        )
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    async fn observe_content(
        &self,
        track_id: &str,
        ref_item: &SourceRef,
        hint: &TrackContentHint,
    ) -> Result<(), DbError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let prev_row = sqlx::query(
            r"
            SELECT content_fingerprint, file_path
            FROM library_item_sources
            WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?;
            ",
        )
        .bind(track_id)
        .bind(&ref_item.connection_id)
        .bind(&ref_item.provider_item_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(prev_row) = prev_row else {
            tx.rollback().await?;
            return Ok(());
        };

        let prev_fp: Option<String> = prev_row.try_get("content_fingerprint")?;
        let prev_path: Option<String> = prev_row.try_get("file_path")?;

        let computed_fp = hint.metadata_json.as_deref().map_or_else(
            || hint.fingerprint.clone(),
            |json| {
                let digest = Sha256::digest(json.as_bytes());
                let mut hex = String::with_capacity(64);
                for b in digest {
                    use std::fmt::Write;
                    let _ = write!(&mut hex, "{b:02x}");
                }
                Some(hex)
            },
        );

        let changed = (computed_fp.is_some() && prev_fp != computed_fp)
            || (hint.file_path.is_some() && prev_path.is_some() && prev_path != hint.file_path);

        if changed {
            let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            sqlx::query(
                "UPDATE library_items SET content_revision = ?, updated_at = ? WHERE id = ? AND type = 'track';",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&now_iso)
            .bind(track_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query("DELETE FROM track_silence_analysis WHERE track_id = ?;")
                .bind(track_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM track_silence_analysis_profiles WHERE track_id = ?;")
                .bind(track_id)
                .execute(&mut *tx)
                .await?;
        }

        sqlx::query(
            r"
            UPDATE library_item_sources
            SET content_fingerprint = COALESCE(?, content_fingerprint),
                content_metadata_json = COALESCE(?, content_metadata_json),
                file_path = COALESCE(?, file_path)
            WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?;
            ",
        )
        .bind(&computed_fp)
        .bind(&hint.metadata_json)
        .bind(&hint.file_path)
        .bind(track_id)
        .bind(&ref_item.connection_id)
        .bind(&ref_item.provider_item_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }
}
