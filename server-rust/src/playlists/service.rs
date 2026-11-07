//! # Playlist CRUD, Compare-And-Swap Reordering & Batch Mutation Service (`playlists::service`)
//!
//! Complete Rust port of `server/src/domain/playlist-service.ts`.
//!
//! ## Relational & Concurrency Guarantees
//! 1. **Authoritative Local SQLite Store (`playlists` & `playlist_items`)**:
//!    - Every playlist item row (`id = mdpli_<nanoid>`) stores its zero-based `position`,
//!      `connection_id`, `provider_track_id`, `library_track_id`, `external_track_json`,
//!      and `added_by_user_id`.
//! 2. **Compare-And-Swap (CAS) Entry Reordering ([`PlaylistService::reorder_items`])**:
//!    - Inside an atomic SQLite transaction (`BEGIN` ... `COMMIT`), fetches the current
//!      ordered `playlist_items.id` sequence and verifies it matches `expected_item_ids`
//!      element-by-element. If another collaborator or tab modified the playlist concurrently,
//!      aborts with [`PlaylistError::Conflict`] (`HTTP 409 PLAYLIST_CONFLICT`).
//!    - Validates that `item_ids` is a bijective permutation of the existing item IDs
//!      (every occurrence ID present exactly once) before updating `position = 0..N`.
//! 3. **Batch Track Add & Remove ([`PlaylistService::edit_tracks`])**:
//!    - `Add`: Deduplicates `(connection_id, provider_track_id)` pairs against existing
//!      items and appends new `mdpli_...` entries at contiguous positions starting at `items.len()`.
//!    - `Remove`: Verifies `expected_item_ids` via CAS, deletes the selected `item_ids`,
//!      and compacts remaining item positions to `0..M` inside the same transaction.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, Row};
use thiserror::Error;

use crate::auth::SessionUser;
use crate::avatars::avatar_url_for;
use crate::catalog::{CatalogService, LibraryService, SourceResolver};
use crate::db::{DbError, DbPool, create_id};
use crate::playlists::artwork::{
    COLLAGE_TILE_COUNT, PlaylistArtworkMode, PlaylistArtworkService, RenderedArtwork,
};

/// Sharing visibility mode on `playlists.sharing_mode` (Migration 45).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlaylistVisibility {
    /// Visible and editable only by the owner (and admins).
    #[default]
    Private,
    /// Readable by invited viewers/collaborators or via share link.
    SharedRead,
    /// Editable by invited collaborators.
    Collaborative,
    /// Visible to all authenticated users on the server.
    PublicServer,
}

impl PlaylistVisibility {
    /// Parses a database `sharing_mode` string.
    #[must_use]
    pub fn parse_str(raw: &str) -> Self {
        match raw.trim() {
            "SHARED_READ" => Self::SharedRead,
            "COLLABORATIVE" => Self::Collaborative,
            "PUBLIC_SERVER" => Self::PublicServer,
            _ => Self::Private,
        }
    }

    /// Returns the database string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Private => "PRIVATE",
            Self::SharedRead => "SHARED_READ",
            Self::Collaborative => "COLLABORATIVE",
            Self::PublicServer => "PUBLIC_SERVER",
        }
    }
}

/// Computed viewer access flags attached to playlist responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPermissions {
    /// Whether the viewer can read the playlist and its tracks.
    pub can_read: bool,
    /// Whether the viewer can add, remove, or reorder tracks.
    pub can_edit_tracks: bool,
    /// Whether the viewer can rename, delete, or change artwork/sharing settings.
    pub can_manage: bool,
}

/// Collaborator attribution attached to a hydrated [`PlaylistTrack`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAddedByUser {
    /// User ID of the collaborator who added the track.
    pub id: String,
    /// Display name (`"Former member"` fallback if user was deleted).
    pub display_name: String,
    /// Optional versioned avatar URL.
    pub avatar_url: Option<String>,
}

/// Hydrated track occurrence inside a [`PlaylistRecord`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    /// Unique occurrence ID in `playlist_items.id` (`mdpli_<nanoid>`).
    pub playlist_item_id: String,
    /// ISO-8601 timestamp when the item was added to the playlist.
    pub playlist_added_at: String,
    /// Optional user ID who added the track.
    pub added_by_user_id: Option<String>,
    /// Optional hydrated collaborator profile.
    pub added_by: Option<TrackAddedByUser>,
    /// Flattened track metadata fields (`id`, `title`, `artistName`, `albumName`, `streamUrl`, etc.).
    #[serde(flatten)]
    pub track: Value,
}

/// Complete MusicDeck playlist representation (`Playlist & { ownerUserId }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRecord {
    /// Playlist ID (`mdpl_<nanoid>`).
    pub id: String,
    /// Upstream provider playlist ID (or `id` when local-only).
    pub provider_id: String,
    /// Owning user ID (`None` for server-wide legacy public playlists).
    pub owner_user_id: Option<String>,
    /// Playlist title.
    pub name: String,
    /// Optional playlist description.
    pub description: Option<String>,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// Monotonically incremented edit revision (updated by SQLite triggers on item/metadata changes).
    pub edit_revision: i64,
    /// Sharing mode (`PRIVATE`, `SHARED_READ`, `COLLABORATIVE`, `PUBLIC_SERVER`).
    pub sharing_mode: PlaylistVisibility,
    /// Sharing revision counter.
    pub sharing_revision: i64,
    /// Whether plays from this playlist are excluded from the user's taste profile.
    pub exclude_from_taste: bool,
    /// Opaque artwork ID (`mdplart_<sig>_<playlistId>`).
    pub artwork_id: Option<String>,
    /// Relative MusicDeck artwork URL (`/api/artwork/mdplart_...`).
    pub artwork_url: Option<String>,
    /// Artwork resolution mode (`custom` or `collage`).
    pub artwork_mode: Option<PlaylistArtworkMode>,
    /// Total number of tracks in the playlist.
    pub song_count: usize,
    /// Viewer permissions for this playlist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PlaylistPermissions>,
    /// Complete ordered list of `playlist_items.id` occurrence tokens (included on detail reads).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_ids: Option<Vec<String>>,
    /// Hydrated tracks (included on detail reads).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<PlaylistTrack>>,
}

/// Input payload for `PATCH /api/playlists/:playlistId`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistUpdatePayload {
    /// Optional updated playlist name (`1..=200` trimmed chars).
    pub name: Option<String>,
    /// Optional updated description (`<= 1000` chars, or `null` to clear).
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub description: Option<Option<String>>,
}

/// Discriminated union payload for `POST /api/v1/playlists/:playlistId/tracks/batch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum PlaylistBatchEdit {
    /// Append tracks (skipping already-present `(connection_id, provider_track_id)` pairs).
    Add {
        /// Track IDs (`md_...`) to append (`1..=20000`).
        #[serde(rename = "trackIds")]
        track_ids: Vec<String>,
    },
    /// Remove specific occurrence IDs with Compare-And-Swap verification.
    Remove {
        /// Occurrence IDs (`mdpli_...`) to remove (`1..=20000`).
        #[serde(rename = "itemIds")]
        item_ids: Vec<String>,
        /// Caller's expected full ordered list of `playlist_items.id` before deletion.
        #[serde(rename = "expectedItemIds")]
        expected_item_ids: Vec<String>,
    },
}

/// Error taxonomy for playlist operations (`PlaylistEditError` in TypeScript).
#[derive(Debug, Error)]
pub enum PlaylistError {
    /// Invalid request parameters or reorder permutation (`400 Bad Request`, `VALIDATION_ERROR`).
    #[error("{0}")]
    Validation(String),

    /// Compare-And-Swap (`expectedItemIds`) mismatch (`409 Conflict`, `PLAYLIST_CONFLICT`).
    #[error("{0}")]
    Conflict(String),

    /// Caller lacks permission to view, edit, or manage the playlist (`403 Forbidden`).
    #[error("Playlist access denied")]
    AccessDenied,

    /// Playlist does not exist or is soft-deleted (`404 Not Found`).
    #[error("Playlist not found")]
    NotFound,

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("Playlist database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
struct RawPlaylistRow {
    id: String,
    owner_user_id: Option<String>,
    name: String,
    description: Option<String>,
    #[allow(dead_code)]
    source_connection_id: Option<String>,
    source_playlist_id: Option<String>,
    created_at: String,
    edit_revision: i64,
    sharing_mode: PlaylistVisibility,
    sharing_revision: i64,
    exclude_from_taste: bool,
}

#[derive(Debug, Clone)]
struct RawPlaylistItemRow {
    id: String,
    #[allow(dead_code)]
    position: i64,
    connection_id: String,
    provider_track_id: String,
    library_track_id: Option<String>,
    created_at: String,
    external_track_json: Option<String>,
    added_by_user_id: Option<String>,
    added_by_name: Option<String>,
    added_by_avatar: Option<String>,
}

/// MusicDeck playlist service coordinating SQLite persistence, permission checks,
/// track hydration, and dynamic 2x2 collage / custom artwork resolution.
#[derive(Debug, Clone)]
pub struct PlaylistService {
    db: DbPool,
    catalog: CatalogService,
    library: LibraryService,
    resolver: SourceResolver,
    artwork: PlaylistArtworkService,
}

impl PlaylistService {
    /// Constructs a new [`PlaylistService`].
    #[must_use]
    pub fn new(
        db: DbPool,
        catalog: CatalogService,
        library: LibraryService,
        resolver: SourceResolver,
    ) -> Self {
        let artwork = PlaylistArtworkService::new(db.clone());
        Self {
            db,
            catalog,
            library,
            resolver,
            artwork,
        }
    }

    /// Returns a reference to the [`PlaylistArtworkService`].
    #[must_use]
    pub const fn artwork(&self) -> &PlaylistArtworkService {
        &self.artwork
    }

    /// Computes [`PlaylistPermissions`] for `user` on `playlist_id`.
    pub async fn permissions_for(
        &self,
        playlist_id: &str,
        user: &SessionUser,
    ) -> Result<PlaylistPermissions, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(PlaylistPermissions {
                can_read: false,
                can_edit_tracks: false,
                can_manage: false,
            });
        };

        self.permissions_for_row(&row, user).await
    }

    async fn permissions_for_row(
        &self,
        row: &RawPlaylistRow,
        user: &SessionUser,
    ) -> Result<PlaylistPermissions, PlaylistError> {
        let is_owner = row.owner_user_id.as_deref() == Some(user.id.as_str());
        let is_public_legacy = row.owner_user_id.is_none();

        if is_owner || user.is_admin() {
            return Ok(PlaylistPermissions {
                can_read: true,
                can_edit_tracks: true,
                can_manage: true,
            });
        }

        if is_public_legacy {
            return Ok(PlaylistPermissions {
                can_read: true,
                can_edit_tracks: true,
                can_manage: false,
            });
        }

        let explicit_role: Option<String> = sqlx::query(
            "SELECT role FROM playlist_permissions WHERE playlist_id = ? AND user_id = ?;",
        )
        .bind(&row.id)
        .bind(&user.id)
        .fetch_optional(self.db.inner())
        .await?
        .and_then(|r| r.try_get("role").ok());

        let is_collaborator = explicit_role.as_deref() == Some("COLLABORATOR");
        let is_viewer = is_collaborator || explicit_role.as_deref() == Some("VIEWER");

        let can_read = match row.sharing_mode {
            PlaylistVisibility::PublicServer => true,
            PlaylistVisibility::SharedRead | PlaylistVisibility::Collaborative => is_viewer,
            PlaylistVisibility::Private => false,
        };

        let can_edit_tracks =
            row.sharing_mode == PlaylistVisibility::Collaborative && is_collaborator;

        Ok(PlaylistPermissions {
            can_read,
            can_edit_tracks,
            can_manage: false,
        })
    }

    /// Lists all non-deleted playlists readable by `user` ordered by `created_at ASC`.
    pub async fn list(&self, user: &SessionUser) -> Result<Vec<PlaylistRecord>, PlaylistError> {
        let rows = sqlx::query(
            "SELECT * FROM playlists WHERE deleted_at IS NULL ORDER BY created_at ASC;",
        )
        .fetch_all(self.db.inner())
        .await?;

        let mut playlists = Vec::new();
        for raw in rows {
            let row = map_playlist_row(&raw)?;
            let perms = self.permissions_for_row(&row, user).await?;
            if !perms.can_read {
                continue;
            }
            playlists.push(self.build_record(row, None, None, Some(perms)).await?);
        }
        Ok(playlists)
    }

    /// Fetches a single playlist with its hydrated tracks and ordered `itemIds`.
    pub async fn get(
        &self,
        playlist_id: &str,
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_read {
            return Ok(None);
        }

        let items = self.fetch_item_rows(playlist_id).await?;
        let item_ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        let tracks = self.hydrate_items(&items).await;

        Ok(Some(
            self.build_record(row, Some(tracks), Some(item_ids), Some(perms))
                .await?,
        ))
    }

    /// Creates a new MusicDeck-owned playlist in SQLite.
    pub async fn create(
        &self,
        name: &str,
        user: &SessionUser,
        description: Option<&str>,
    ) -> Result<PlaylistRecord, PlaylistError> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() || trimmed_name.chars().count() > 200 {
            return Err(PlaylistError::Validation(String::from(
                "Invalid playlist request",
            )));
        }
        if let Some(desc) = description
            && desc.chars().count() > 1000
        {
            return Err(PlaylistError::Validation(String::from(
                "Invalid playlist request",
            )));
        }

        let id = create_id("mdpl");
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let primary_conn = self.primary_connection_id().await?;
        let clean_desc = description.map(str::trim).filter(|s| !s.is_empty());

        sqlx::query(
            r"
            INSERT INTO playlists
              (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?);
            ",
        )
        .bind(&id)
        .bind(&user.id)
        .bind(trimmed_name)
        .bind(clean_desc)
        .bind(primary_conn)
        .bind(&now_iso)
        .bind(&now_iso)
        .execute(self.db.inner())
        .await?;

        self.get(&id, user)
            .await?
            .ok_or(PlaylistError::NotFound)
    }

    /// Updates a playlist's `name` and/or `description`.
    pub async fn update(
        &self,
        playlist_id: &str,
        payload: PlaylistUpdatePayload,
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        if payload.name.is_none() && payload.description.is_none() {
            return Err(PlaylistError::Validation(String::from(
                "Invalid playlist update request",
            )));
        }
        if let Some(ref name) = payload.name {
            let trimmed = name.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 200 {
                return Err(PlaylistError::Validation(String::from(
                    "Invalid playlist update request",
                )));
            }
        }
        if let Some(Some(ref desc)) = payload.description
            && desc.trim().chars().count() > 1000
        {
            return Err(PlaylistError::Validation(String::from(
                "Invalid playlist update request",
            )));
        }

        let Some(existing) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&existing, user).await?;
        if !perms.can_manage {
            return Err(PlaylistError::AccessDenied);
        }

        let next_name = payload
            .name
            .as_deref()
            .map(str::trim)
            .unwrap_or(&existing.name);
        let next_desc: Option<String> = match payload.description {
            Some(Some(d)) => {
                let t = d.trim();
                (!t.is_empty()).then(|| t.to_owned())
            }
            Some(None) => None,
            None => existing.description.clone(),
        };
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        sqlx::query(
            "UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?;",
        )
        .bind(next_name)
        .bind(next_desc)
        .bind(&now_iso)
        .bind(playlist_id)
        .execute(self.db.inner())
        .await?;

        self.get(playlist_id, user).await
    }

    /// Permanently deletes a playlist (cascading to `playlist_items` and `playlist_artwork`).
    pub async fn remove(
        &self,
        playlist_id: &str,
        user: &SessionUser,
    ) -> Result<bool, PlaylistError> {
        let Some(existing) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(false);
        };
        let perms = self.permissions_for_row(&existing, user).await?;
        if !perms.can_manage {
            return Err(PlaylistError::AccessDenied);
        }

        let res = sqlx::query("DELETE FROM playlists WHERE id = ?;")
            .bind(playlist_id)
            .execute(self.db.inner())
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Appends `track_id` to `playlist_id` if not already present, returning `{ "added": bool }`.
    pub async fn add_track(
        &self,
        playlist_id: &str,
        track_id: &str,
        user: &SessionUser,
    ) -> Result<bool, PlaylistError> {
        let trimmed_track = track_id.trim();
        if trimmed_track.is_empty() {
            return Err(PlaylistError::Validation(String::from(
                "Invalid playlist track request",
            )));
        }

        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Err(PlaylistError::NotFound);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_edit_tracks {
            return Err(PlaylistError::AccessDenied);
        }

        let source = self.library.get_primary_source(trimmed_track).await?;
        let primary_conn = self.primary_connection_id().await?.unwrap_or_default();
        let connection_id = source
            .as_ref()
            .map_or(primary_conn.as_str(), |s| s.connection_id.as_str());
        let provider_track_id = source
            .as_ref()
            .map_or(trimmed_track, |s| s.provider_item_id.as_str());
        let library_track_id = source.as_ref().map(|_| trimmed_track);

        let existing = sqlx::query(
            r"
            SELECT id FROM playlist_items
            WHERE playlist_id = ? AND connection_id = ? AND provider_track_id = ?;
            ",
        )
        .bind(playlist_id)
        .bind(connection_id)
        .bind(provider_track_id)
        .fetch_optional(self.db.inner())
        .await?;

        if existing.is_some() {
            return Ok(false);
        }

        let next_pos_row = sqlx::query(
            "SELECT COALESCE(MAX(position) + 1, 0) AS next_pos FROM playlist_items WHERE playlist_id = ?;",
        )
        .bind(playlist_id)
        .fetch_one(self.db.inner())
        .await?;
        let next_pos: i64 = next_pos_row.try_get("next_pos")?;
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        sqlx::query(
            r"
            INSERT INTO playlist_items
              (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, added_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(create_id("mdpli"))
        .bind(playlist_id)
        .bind(next_pos)
        .bind(connection_id)
        .bind(provider_track_id)
        .bind(library_track_id)
        .bind(&now_iso)
        .bind(&user.id)
        .execute(self.db.inner())
        .await?;

        sqlx::query("UPDATE playlists SET updated_at = ? WHERE id = ?;")
            .bind(&now_iso)
            .bind(playlist_id)
            .execute(self.db.inner())
            .await?;

        Ok(true)
    }

    /// Removes a track occurrence (by `playlist_items.id`, `library_track_id`, or `provider_track_id`)
    /// and compacts subsequent item positions inside an atomic transaction.
    pub async fn remove_item(
        &self,
        playlist_id: &str,
        item_or_track_id: &str,
        user: &SessionUser,
    ) -> Result<bool, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(false);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_edit_tracks {
            return Err(PlaylistError::AccessDenied);
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let target = sqlx::query(
            r"
            SELECT id, position FROM playlist_items
            WHERE playlist_id = ?
              AND (id = ? OR library_track_id = ? OR provider_track_id = ?)
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, position ASC
            LIMIT 1;
            ",
        )
        .bind(playlist_id)
        .bind(item_or_track_id)
        .bind(item_or_track_id)
        .bind(item_or_track_id)
        .bind(item_or_track_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(target) = target else {
            tx.rollback().await?;
            return Ok(false);
        };

        let item_id: String = target.try_get("id")?;
        let item_pos: i64 = target.try_get("position")?;

        sqlx::query("DELETE FROM playlist_items WHERE id = ?;")
            .bind(&item_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            "UPDATE playlist_items SET position = position - 1 WHERE playlist_id = ? AND position > ?;",
        )
        .bind(playlist_id)
        .bind(item_pos)
        .execute(&mut *tx)
        .await?;

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE playlists SET updated_at = ? WHERE id = ?;")
            .bind(&now_iso)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(true)
    }

    /// Reorders playlist items by track IDs (`PUT /api/playlists/:playlistId/tracks/reorder`),
    /// preserving any unmentioned items at the tail in their relative order.
    pub async fn reorder_by_track_ids(
        &self,
        playlist_id: &str,
        track_ids: &[String],
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_edit_tracks {
            return Err(PlaylistError::AccessDenied);
        }

        let items = self.fetch_item_rows(playlist_id).await?;
        let mut by_lib_id: HashMap<String, String> = HashMap::new();
        let mut by_prov_id: HashMap<String, String> = HashMap::new();
        for item in &items {
            if let Some(ref lib_id) = item.library_track_id {
                by_lib_id.entry(lib_id.clone()).or_insert_with(|| item.id.clone());
            }
            by_prov_id
                .entry(item.provider_track_id.clone())
                .or_insert_with(|| item.id.clone());
        }

        let mut seen_item_ids = HashSet::new();
        let mut ordered_item_ids = Vec::with_capacity(items.len());

        for tid in track_ids {
            if let Some(item_id) = by_lib_id.get(tid).or_else(|| by_prov_id.get(tid))
                && seen_item_ids.insert(item_id.clone())
            {
                ordered_item_ids.push(item_id.clone());
            }
        }
        for item in &items {
            if seen_item_ids.insert(item.id.clone()) {
                ordered_item_ids.push(item.id.clone());
            }
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;
        for (idx, item_id) in ordered_item_ids.iter().enumerate() {
            sqlx::query(
                "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?;",
            )
            .bind(i64::try_from(idx).unwrap_or(0))
            .bind(playlist_id)
            .bind(item_id)
            .execute(&mut *tx)
            .await?;
        }
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE playlists SET updated_at = ? WHERE id = ?;")
            .bind(&now_iso)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        drop(conn);

        self.get(playlist_id, user).await
    }

    /// Exact occurrence permutation reorder with Compare-And-Swap (`expected_item_ids`)
    /// checked inside the SQLite write transaction (`POST /api/v1/playlists/:playlistId/reorder`).
    pub async fn reorder_items(
        &self,
        playlist_id: &str,
        item_ids: &[String],
        expected_item_ids: &[String],
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_edit_tracks {
            return Err(PlaylistError::AccessDenied);
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let current_rows = sqlx::query(
            "SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC;",
        )
        .bind(playlist_id)
        .fetch_all(&mut *tx)
        .await?;
        let current_ids: Vec<String> = current_rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>("id").ok())
            .collect();

        if current_ids != expected_item_ids {
            tx.rollback().await?;
            return Err(PlaylistError::Conflict(String::from(
                "This playlist changed elsewhere. Reload it before editing again.",
            )));
        }

        let known_set: HashSet<&String> = current_ids.iter().collect();
        let submitted_set: HashSet<&String> = item_ids.iter().collect();
        if item_ids.len() != current_ids.len()
            || submitted_set.len() != current_ids.len()
            || item_ids.iter().any(|id| !known_set.contains(id))
        {
            tx.rollback().await?;
            return Err(PlaylistError::Validation(String::from(
                "Reorder must contain every playlist entry exactly once.",
            )));
        }

        for (idx, item_id) in item_ids.iter().enumerate() {
            sqlx::query(
                "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?;",
            )
            .bind(i64::try_from(idx).unwrap_or(0))
            .bind(playlist_id)
            .bind(item_id)
            .execute(&mut *tx)
            .await?;
        }

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE playlists SET updated_at = ? WHERE id = ?;")
            .bind(&now_iso)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        drop(conn);
        self.get(playlist_id, user).await
    }

    /// Executes an atomic batch track addition or CAS-verified batch removal
    /// (`POST /api/v1/playlists/:playlistId/tracks/batch`).
    pub async fn edit_tracks(
        &self,
        playlist_id: &str,
        edit: PlaylistBatchEdit,
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_edit_tracks {
            return Err(PlaylistError::AccessDenied);
        }

        let primary_conn = self.primary_connection_id().await?.unwrap_or_default();
        let mut pre_resolved_sources = HashMap::new();
        if let PlaylistBatchEdit::Add { ref track_ids } = edit {
            for track_id in track_ids {
                let source = self.library.get_primary_source(track_id).await?;
                pre_resolved_sources.insert(track_id.clone(), source);
            }
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let current_rows = sqlx::query(
            "SELECT id, connection_id, provider_track_id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC;",
        )
        .bind(playlist_id)
        .fetch_all(&mut *tx)
        .await?;

        let current_ids: Vec<String> = current_rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>("id").ok())
            .collect();

        match edit {
            PlaylistBatchEdit::Remove {
                item_ids,
                expected_item_ids,
            } => {
                if item_ids.is_empty() || item_ids.len() > 20_000 {
                    tx.rollback().await?;
                    return Err(PlaylistError::Validation(String::from(
                        "Invalid playlist batch edit",
                    )));
                }
                if current_ids != expected_item_ids {
                    tx.rollback().await?;
                    return Err(PlaylistError::Conflict(String::from(
                        "This playlist changed elsewhere. Reload it before editing again.",
                    )));
                }

                let selected: HashSet<&String> = item_ids.iter().collect();
                let known: HashSet<&String> = current_ids.iter().collect();
                if selected.len() != item_ids.len()
                    || item_ids.iter().any(|id| !known.contains(id))
                {
                    tx.rollback().await?;
                    return Err(PlaylistError::Validation(String::from(
                        "Selected entries do not belong to this playlist.",
                    )));
                }

                for id in &item_ids {
                    sqlx::query("DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?;")
                        .bind(playlist_id)
                        .bind(id)
                        .execute(&mut *tx)
                        .await?;
                }

                let remaining: Vec<&String> = current_ids
                    .iter()
                    .filter(|id| !selected.contains(id))
                    .collect();
                for (idx, id) in remaining.into_iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?;",
                    )
                    .bind(i64::try_from(idx).unwrap_or(0))
                    .bind(playlist_id)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            PlaylistBatchEdit::Add { track_ids } => {
                if track_ids.is_empty() || track_ids.len() > 20_000 {
                    tx.rollback().await?;
                    return Err(PlaylistError::Validation(String::from(
                        "Invalid playlist batch edit",
                    )));
                }

                let mut existing_pairs: HashSet<(String, String)> = current_rows
                    .iter()
                    .filter_map(|r| {
                        Some((
                            r.try_get::<String, _>("connection_id").ok()?,
                            r.try_get::<String, _>("provider_track_id").ok()?,
                        ))
                    })
                    .collect();

                let mut next_position = i64::try_from(current_ids.len()).unwrap_or(0);
                let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

                for track_id in track_ids {
                    let source = pre_resolved_sources.get(&track_id).cloned().flatten();
                    let conn_id = source
                        .as_ref()
                        .map_or_else(|| primary_conn.clone(), |s| s.connection_id.clone());
                    let prov_id = source
                        .as_ref()
                        .map_or_else(|| track_id.clone(), |s| s.provider_item_id.clone());

                    if !existing_pairs.insert((conn_id.clone(), prov_id.clone())) {
                        continue;
                    }

                    let lib_id = source.as_ref().map(|_| track_id.as_str());
                    sqlx::query(
                        r"
                        INSERT INTO playlist_items
                          (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, added_by_user_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                        ",
                    )
                    .bind(create_id("mdpli"))
                    .bind(playlist_id)
                    .bind(next_position)
                    .bind(&conn_id)
                    .bind(&prov_id)
                    .bind(lib_id)
                    .bind(&now_iso)
                    .bind(&user.id)
                    .execute(&mut *tx)
                    .await?;
                    next_position += 1;
                }
            }
        }

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE playlists SET updated_at = ? WHERE id = ?;")
            .bind(&now_iso)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        drop(conn);
        self.get(playlist_id, user).await
    }

    /// Sets custom artwork for `playlist_id` (`PUT /api/playlists/:playlistId/artwork`).
    pub async fn set_custom_artwork(
        &self,
        playlist_id: &str,
        data: &[u8],
        content_type: &str,
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_manage {
            return Err(PlaylistError::AccessDenied);
        }

        self.artwork
            .set_custom(playlist_id, data, content_type)
            .await?;
        self.get(playlist_id, user).await
    }

    /// Clears custom artwork for `playlist_id` (`DELETE /api/playlists/:playlistId/artwork`).
    pub async fn clear_custom_artwork(
        &self,
        playlist_id: &str,
        user: &SessionUser,
    ) -> Result<Option<PlaylistRecord>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_manage {
            return Err(PlaylistError::AccessDenied);
        }

        self.artwork.clear_custom(playlist_id).await?;
        self.get(playlist_id, user).await
    }

    /// Renders custom artwork or the dynamic 2x2 collage for `playlist_id`.
    pub async fn render_artwork(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        size: Option<u32>,
    ) -> Result<Option<RenderedArtwork>, PlaylistError> {
        let Some(row) = self.fetch_playlist_row(playlist_id).await? else {
            return Ok(None);
        };
        let perms = self.permissions_for_row(&row, user).await?;
        if !perms.can_read {
            return Ok(None);
        }

        if let Some(custom) = self.artwork.get_custom(playlist_id).await? {
            let etag = format!("\"plcustom-{}\"", custom.updated_at);
            return Ok(Some(RenderedArtwork {
                body: custom.data,
                content_type: custom.content_type,
                etag,
            }));
        }

        let items = self.fetch_item_rows(playlist_id).await?;
        let leading: Vec<&RawPlaylistItemRow> = items.iter().take(COLLAGE_TILE_COUNT).collect();
        if leading.is_empty() {
            return Ok(None);
        }

        let mut artwork_ids = Vec::new();
        for item in leading {
            if item.external_track_json.is_some() {
                continue;
            }
            if let Some(ref lib_id) = item.library_track_id {
                let candidates = self.resolver.candidate_sources(lib_id, None).await;
                for candidate in candidates {
                    if let Ok(Some(track)) = candidate
                        .provider
                        .provider
                        .get_track(&candidate.source.provider_item_id)
                        .await
                        && let Ok(stamped) = self
                            .catalog
                            .stamp_track(track, &candidate.source.connection_id)
                            .await
                        && let Some(art_id) = stamped.item.artwork_id
                    {
                        artwork_ids.push(art_id);
                        break;
                    }
                }
            }
        }

        Ok(Some(
            self.artwork
                .get_or_cache_svg_collage(&artwork_ids, &[], size),
        ))
    }

    async fn fetch_playlist_row(
        &self,
        playlist_id: &str,
    ) -> Result<Option<RawPlaylistRow>, PlaylistError> {
        let row = sqlx::query("SELECT * FROM playlists WHERE id = ? AND deleted_at IS NULL;")
            .bind(playlist_id)
            .fetch_optional(self.db.inner())
            .await?;

        row.as_ref().map(map_playlist_row).transpose()
    }

    async fn fetch_item_rows(
        &self,
        playlist_id: &str,
    ) -> Result<Vec<RawPlaylistItemRow>, PlaylistError> {
        let rows = sqlx::query(
            r"
            SELECT i.*, u.display_name AS added_by_name, u.avatar_updated_at AS added_by_avatar
            FROM playlist_items i
            LEFT JOIN users u ON u.id = i.added_by_user_id
            WHERE i.playlist_id = ?
            ORDER BY i.position ASC;
            ",
        )
        .bind(playlist_id)
        .fetch_all(self.db.inner())
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            items.push(RawPlaylistItemRow {
                id: row.try_get("id")?,
                position: row.try_get("position")?,
                connection_id: row.try_get("connection_id")?,
                provider_track_id: row.try_get("provider_track_id")?,
                library_track_id: row.try_get("library_track_id")?,
                created_at: row.try_get("created_at")?,
                external_track_json: row.try_get("external_track_json").ok().flatten(),
                added_by_user_id: row.try_get("added_by_user_id").ok().flatten(),
                added_by_name: row.try_get("added_by_name").ok().flatten(),
                added_by_avatar: row.try_get("added_by_avatar").ok().flatten(),
            });
        }
        Ok(items)
    }

    async fn hydrate_items(&self, items: &[RawPlaylistItemRow]) -> Vec<PlaylistTrack> {
        let mut hydrated = Vec::with_capacity(items.len());
        let mut resolved_cache: HashMap<String, Value> = HashMap::new();

        for item in items {
            let added_by = item.added_by_user_id.as_ref().map(|uid| TrackAddedByUser {
                id: uid.clone(),
                display_name: item
                    .added_by_name
                    .clone()
                    .unwrap_or_else(|| String::from("Former member")),
                avatar_url: avatar_url_for(uid, item.added_by_avatar.as_deref()),
            });

            if let Some(ref ext_json) = item.external_track_json
                && let Ok(parsed) = serde_json::from_str::<Value>(ext_json)
            {
                hydrated.push(PlaylistTrack {
                    playlist_item_id: item.id.clone(),
                    playlist_added_at: item.created_at.clone(),
                    added_by_user_id: item.added_by_user_id.clone(),
                    added_by,
                    track: parsed,
                });
                continue;
            }

            let cache_key = item.library_track_id.clone().unwrap_or_else(|| {
                format!("{}:{}", item.connection_id, item.provider_track_id)
            });

            if let Some(cached_val) = resolved_cache.get(&cache_key) {
                hydrated.push(PlaylistTrack {
                    playlist_item_id: item.id.clone(),
                    playlist_added_at: item.created_at.clone(),
                    added_by_user_id: item.added_by_user_id.clone(),
                    added_by,
                    track: cached_val.clone(),
                });
                continue;
            }

            if let Some(ref lib_id) = item.library_track_id {
                let candidates = self.resolver.candidate_sources(lib_id, None).await;
                let mut found_val = None;
                for candidate in candidates {
                    if let Ok(Some(track)) = candidate
                        .provider
                        .provider
                        .get_track(&candidate.source.provider_item_id)
                        .await
                        && let Ok(stamped) = self
                            .catalog
                            .stamp_track(track, &candidate.source.connection_id)
                            .await
                        && let Ok(val) = serde_json::to_value(&stamped)
                    {
                        found_val = Some(val);
                        break;
                    }
                }
                if let Some(val) = found_val {
                    resolved_cache.insert(cache_key, val.clone());
                    hydrated.push(PlaylistTrack {
                        playlist_item_id: item.id.clone(),
                        playlist_added_at: item.created_at.clone(),
                        added_by_user_id: item.added_by_user_id.clone(),
                        added_by,
                        track: val,
                    });
                }
            } else {
                let fallback = json!({
                    "id": item.provider_track_id,
                    "providerId": item.provider_track_id,
                    "connectionId": item.connection_id,
                });
                resolved_cache.insert(cache_key, fallback.clone());
                hydrated.push(PlaylistTrack {
                    playlist_item_id: item.id.clone(),
                    playlist_added_at: item.created_at.clone(),
                    added_by_user_id: item.added_by_user_id.clone(),
                    added_by,
                    track: fallback,
                });
            }
        }

        hydrated
    }

    async fn build_record(
        &self,
        row: RawPlaylistRow,
        tracks: Option<Vec<PlaylistTrack>>,
        item_ids: Option<Vec<String>>,
        permissions: Option<PlaylistPermissions>,
    ) -> Result<PlaylistRecord, PlaylistError> {
        let leading_refs = self.collage_track_refs(&row.id).await?;
        let art_desc = self.artwork.describe(&row.id, &leading_refs).await?;

        let song_count = if let Some(ref ids) = item_ids {
            ids.len()
        } else if let Some(ref t) = tracks {
            t.len()
        } else {
            let count_row =
                sqlx::query("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?;")
                    .bind(&row.id)
                    .fetch_one(self.db.inner())
                    .await?;
            let n: i64 = count_row.try_get("n")?;
            usize::try_from(n).unwrap_or(0)
        };

        Ok(PlaylistRecord {
            provider_id: row
                .source_playlist_id
                .clone()
                .unwrap_or_else(|| row.id.clone()),
            id: row.id,
            owner_user_id: row.owner_user_id,
            name: row.name,
            description: row.description,
            created_at: row.created_at,
            edit_revision: row.edit_revision,
            sharing_mode: row.sharing_mode,
            sharing_revision: row.sharing_revision,
            exclude_from_taste: row.exclude_from_taste,
            artwork_id: art_desc.artwork_id,
            artwork_url: art_desc.artwork_url,
            artwork_mode: art_desc.artwork_mode,
            song_count,
            permissions,
            item_ids,
            tracks,
        })
    }

    async fn collage_track_refs(&self, playlist_id: &str) -> Result<Vec<String>, PlaylistError> {
        let rows = sqlx::query(
            r"
            SELECT COALESCE(library_track_id, connection_id || ':' || provider_track_id) AS ref
            FROM playlist_items
            WHERE playlist_id = ?
            ORDER BY position ASC
            LIMIT ?;
            ",
        )
        .bind(playlist_id)
        .bind(i64::try_from(COLLAGE_TILE_COUNT).unwrap_or(4))
        .fetch_all(self.db.inner())
        .await?;

        let mut refs = Vec::with_capacity(rows.len());
        for row in rows {
            refs.push(row.try_get("ref")?);
        }
        Ok(refs)
    }

    async fn primary_connection_id(&self) -> Result<Option<String>, PlaylistError> {
        let row = sqlx::query(
            "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1;",
        )
        .fetch_optional(self.db.inner())
        .await?;

        row.map(|r| r.try_get("id").map_err(PlaylistError::from))
            .transpose()
    }
}

fn map_playlist_row(row: &sqlx::sqlite::SqliteRow) -> Result<RawPlaylistRow, PlaylistError> {
    let sharing_str: String = row
        .try_get("sharing_mode")
        .unwrap_or_else(|_| String::from("PRIVATE"));
    let exclude_int: i64 = row.try_get("exclude_from_taste").unwrap_or(0);

    Ok(RawPlaylistRow {
        id: row.try_get("id")?,
        owner_user_id: row.try_get("owner_user_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        source_connection_id: row.try_get("source_connection_id")?,
        source_playlist_id: row.try_get("source_playlist_id")?,
        created_at: row.try_get("created_at")?,
        edit_revision: row.try_get("edit_revision").unwrap_or(0),
        sharing_mode: PlaylistVisibility::parse_str(&sharing_str),
        sharing_revision: row.try_get("sharing_revision").unwrap_or(0),
        exclude_from_taste: exclude_int != 0,
    })
}
