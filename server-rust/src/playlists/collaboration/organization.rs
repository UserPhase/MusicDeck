//! # Hierarchical Playlist Folders, Pinning, Trash & Reversible Commands (`playlists::collaboration::organization`)
//!
//! Complete Rust port of `server/src/domain/playlist-organization.ts`.
//!
//! ## Core Invariants
//! 1. **Recursive Folder Hierarchy (`playlist_folders`, `MAX_FOLDER_DEPTH = 16`)**:
//!    - Before creating or moving a folder, [`PlaylistOrganizationService::check_parent_folder`]
//!      walks ancestors to reject self/descendant cycles (`A -> B -> A`) and executes a
//!      `WITH RECURSIVE children(id, depth) AS (...)` CTE in SQLite to guarantee that
//!      `ancestor_depth + subtree_height <= 16`.
//!    - Deleting a folder reparents its child folders and playlists to the deleted folder's
//!      `parent_folder_id` with `position + 100000` so nothing is orphaned or lost.
//! 2. **Pinning & Custom Pin Order (`playlist_placements.pin_position`)**:
//!    - Pinned playlists sort by `(pin_position ASC NULLS LAST, name COLLATE NOCASE, id)`
//!      and can be reordered independently of their folder placement via `PinOrder`.
//! 3. **30-Day Soft-Delete Trash & Reversible Command Stack (`playlist_edit_commands`)**:
//!    - Every command (`reorder`, `remove`, `add`, `details`, `trash`, `restore`) computes
//!      a SHA-256 fingerprint (`before_hash` / `after_hash`) over `[name, description, deleted_at, entries]`,
//!      stores forward and inverse deltas, and retains the newest `50` commands per user.
//!    - Undo/redo (`reverse`) verifies both `edit_revision` and the SHA-256 state hash
//!      before applying the inverse/forward delta.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row, SqliteConnection};
use thiserror::Error;

use crate::auth::SessionUser;
use crate::catalog::LibraryService;
use crate::db::{DbError, DbPool, create_id};
use crate::playlists::collaboration::service::{CollaborationError, PlaylistCollaborationService};

/// Retention duration (`30` days in milliseconds) for soft-deleted playlists in Trash.
pub const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Maximum permitted folder nesting depth (`16` levels).
pub const MAX_FOLDER_DEPTH: usize = 16;

/// Maximum entries permitted in a single playlist (`20,000`).
pub const MAX_PLAYLIST_ITEMS: usize = 20_000;

/// Maximum reversible edit commands retained per user (`50`).
pub const MAX_RETAINED_COMMANDS: i64 = 50;

/// User-owned folder node in the hierarchical playlist sidebar (`PlaylistFolder`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistFolder {
    /// Folder ID (`plfolder_<nanoid>`).
    pub id: String,
    /// Folder display name (`1..=200` trimmed chars).
    pub name: String,
    /// Optional parent folder ID (`None` for root-level folders).
    pub parent_folder_id: Option<String>,
    /// Owning user ID.
    pub user_id: String,
    /// Whether the folder is pinned in the sidebar.
    pub pinned: bool,
    /// Zero-based sibling sort position.
    pub position: i64,
}

/// Playlist placement and pin metadata inside the user's organization tree (`PinItem` / `PlaylistTreeRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTreeItem {
    /// Playlist ID (`mdpl_...`).
    pub id: String,
    /// Playlist name.
    pub name: String,
    /// Owner user ID.
    pub owner_user_id: Option<String>,
    /// Last updated timestamp.
    pub updated_at: String,
    /// Creation timestamp.
    pub created_at: String,
    /// Display name of the playlist creator.
    pub creator: Option<String>,
    /// Assigned folder ID for this viewer (`None` = root level).
    pub folder_id: Option<String>,
    /// Whether the viewer has pinned this playlist.
    pub pinned: bool,
    /// Sibling position inside `folder_id`.
    pub position: i64,
    /// Explicit pin-bar ordering index (`playlist_placements.pin_position`).
    pub pin_position: Option<i64>,
}

/// Alias matching the prompt's `PinItem` type name.
pub type PinItem = PlaylistTreeItem;

/// Complete user playlist organization tree returned by `GET /api/v1/playlist-organization`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationTree {
    /// Monotonically incremented per-user organization state revision.
    pub revision: i64,
    /// All folders owned by the user.
    pub folders: Vec<PlaylistFolder>,
    /// All readable playlists with their per-user folder and pin placements.
    pub playlists: Vec<PlaylistTreeItem>,
}

/// Discriminated union of folder and playlist placement operations (`POST /api/v1/playlist-organization`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OrganizationOperation {
    /// Create a new folder under `parent_id`.
    CreateFolder {
        /// Folder name (`1..=200` chars).
        name: String,
        /// Optional parent folder ID.
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
    },
    /// Rename, move, pin, or reorder an existing folder.
    Folder {
        /// Target folder ID.
        id: String,
        /// Optional updated name.
        name: Option<String>,
        /// Optional updated parent (`Some(Some(id))` moves under `id`, `Some(None)` moves to root).
        #[serde(default, rename = "parentId", with = "::serde_with::rust::double_option")]
        parent_id: Option<Option<String>>,
        /// Optional updated pin flag.
        pinned: Option<bool>,
        /// Optional updated sibling position.
        position: Option<usize>,
    },
    /// Delete a folder (reparenting its children to its parent).
    DeleteFolder {
        /// Folder ID to delete.
        id: String,
    },
    /// Move, pin/unpin, or reorder a playlist within a folder.
    Playlist {
        /// Playlist ID.
        id: String,
        /// Optional target folder (`Some(Some(id))` moves into folder, `Some(None)` moves to root).
        #[serde(default, rename = "folderId", with = "::serde_with::rust::double_option")]
        folder_id: Option<Option<String>>,
        /// Optional updated pin flag.
        pinned: Option<bool>,
        /// Optional updated position within the folder.
        position: Option<usize>,
    },
    /// Reorder a pinned playlist within the pinned items bar.
    PinOrder {
        /// Pinned playlist ID.
        id: String,
        /// Zero-based target index in the pinned list.
        position: usize,
    },
}

/// Reversible playlist edit command input (`POST /api/v1/playlists/:playlistId/commands`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReversiblePlaylistEdit {
    /// Reorder playlist occurrence IDs.
    Reorder {
        /// New ordered occurrence IDs.
        #[serde(rename = "itemIds")]
        item_ids: Vec<String>,
        /// Expected current occurrence IDs.
        #[serde(rename = "expectedItemIds")]
        expected_item_ids: Vec<String>,
    },
    /// Remove occurrence IDs.
    Remove {
        /// Occurrence IDs to remove.
        #[serde(rename = "itemIds")]
        item_ids: Vec<String>,
        /// Optional expected current occurrence IDs.
        #[serde(rename = "expectedItemIds")]
        expected_item_ids: Option<Vec<String>>,
    },
    /// Append library track IDs.
    Add {
        /// Track IDs (`md_...`) to add.
        #[serde(rename = "trackIds")]
        track_ids: Vec<String>,
    },
    /// Update playlist title and/or description.
    Details {
        /// Optional new title.
        name: Option<String>,
        /// Optional new description.
        #[serde(default, with = "::serde_with::rust::double_option")]
        description: Option<Option<String>>,
    },
    /// Move playlist to Trash (`deleted_at = now`).
    Trash,
    /// Restore playlist from Trash (`deleted_at = NULL`).
    Restore,
}

/// Undo/redo direction (`POST /api/v1/playlist-commands/:commandId/:direction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandDirection {
    /// Undo a `done` command using its `inverse_json` delta.
    Undo,
    /// Redo an `undone` command using its `forward_json` delta.
    Redo,
}

/// Summary of a recorded reversible command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSummary {
    /// Command ID (`plcmd_<nanoid>`).
    pub id: String,
    /// Target playlist ID.
    pub playlist_id: String,
    /// Human-readable command label (`"Tracks reordered"`, `"Playlist moved to Trash"`, etc.).
    pub label: String,
}

/// Result returned by [`PlaylistOrganizationService::execute`] and [`PlaylistOrganizationService::reverse`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionResult {
    /// Recorded command summary (`None` if the edit was a no-op).
    pub command: Option<CommandSummary>,
    /// Updated `playlists.edit_revision`.
    pub revision: i64,
    /// Current `playlists.deleted_at` timestamp (`Some(...)` when in Trash).
    pub deleted_at: Option<String>,
}

/// Summary of a soft-deleted playlist in Trash (`GET /api/v1/playlists/trash`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPlaylistSummary {
    /// Playlist ID.
    pub id: String,
    /// Playlist name.
    pub name: String,
    /// ISO-8601 deletion timestamp.
    pub deleted_at: String,
    /// Current `edit_revision`.
    pub revision: i64,
    /// Number of tracks inside the trashed playlist.
    pub track_count: i64,
}

/// Error taxonomy for playlist organization, folder tree, and undo/redo operations.
#[derive(Debug, Error)]
pub enum OrganizationError {
    /// Invalid folder depth, cycle, or malformed edit (`400 Bad Request`).
    #[error("{0}")]
    BadRequest(String),

    /// Insufficient permission (`403 Forbidden`).
    #[error("{0}")]
    Forbidden(String),

    /// Folder or playlist not found (`404 Not Found`).
    #[error("{0}")]
    NotFound(String),

    /// Revision or state hash conflict (`409 Conflict`, `PLAYLIST_CONFLICT`).
    #[error("{0}")]
    Conflict(String),

    /// Expired undo step or expired 30-day Trash retention (`410 Gone`).
    #[error("{0}")]
    Gone(String),

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("Organization database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

impl From<CollaborationError> for OrganizationError {
    fn from(err: CollaborationError) -> Self {
        match err {
            CollaborationError::BadRequest(m) => Self::BadRequest(m),
            CollaborationError::Forbidden(m) => Self::Forbidden(m),
            CollaborationError::NotFound(m) => Self::NotFound(m),
            CollaborationError::Conflict(m) | CollaborationError::TooManyRequests(m) => {
                Self::Conflict(m)
            }
            CollaborationError::Gone(m) => Self::Gone(m),
            CollaborationError::Db(d) => Self::Db(d),
            CollaborationError::Sqlx(s) => Self::Sqlx(s),
        }
    }
}

impl OrganizationError {
    /// Returns the HTTP status code (`400`, `403`, `404`, `409`, `410`, or `500`).
    #[must_use]
    pub const fn status_code(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            Self::Forbidden(_) => 403,
            Self::NotFound(_) => 404,
            Self::Conflict(_) => 409,
            Self::Gone(_) => 410,
            Self::Db(_) | Self::Sqlx(_) => 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEntry {
    id: String,
    playlist_id: String,
    position: i64,
    connection_id: String,
    provider_track_id: String,
    library_track_id: Option<String>,
    created_at: String,
    external_track_json: Option<String>,
    added_by_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CommandDelta {
    Order {
        ids: Vec<String>,
    },
    Remove {
        ids: Vec<String>,
    },
    Insert {
        items: Vec<StoredEntry>,
    },
    Details {
        name: String,
        description: Option<String>,
    },
    Trash {
        at: Option<String>,
    },
}

/// Service managing playlist folders, pins, Trash lifecycle, and reversible edit commands.
#[derive(Debug, Clone)]
pub struct PlaylistOrganizationService {
    db: DbPool,
    library: LibraryService,
    collab: PlaylistCollaborationService,
}

impl PlaylistOrganizationService {
    /// Constructs a new [`PlaylistOrganizationService`].
    #[must_use]
    pub fn new(db: DbPool, library: LibraryService) -> Self {
        let collab = PlaylistCollaborationService::new(db.clone());
        Self {
            db,
            library,
            collab,
        }
    }

    /// Returns the current edit state (`{ revision, itemIds, deletedAt }`) for `playlist_id`.
    pub async fn edit_state(
        &self,
        user: &SessionUser,
        playlist_id: &str,
    ) -> Result<(i64, Vec<String>, Option<String>), OrganizationError> {
        let mut conn = self.db.inner().acquire().await?;
        let row = self.load_playlist_row(&mut conn, playlist_id, user, true, true).await?;
        let entries = self.load_entries(&mut conn, playlist_id).await?;
        let item_ids = entries.into_iter().map(|e| e.id).collect();
        Ok((row.edit_revision, item_ids, row.deleted_at))
    }

    /// Builds the complete [`OrganizationTree`] (`revision`, `folders`, `playlists`) for `user`.
    pub async fn tree(&self, user: &SessionUser) -> Result<OrganizationTree, OrganizationError> {
        let mut conn = self.db.inner().acquire().await?;
        self.tree_on_conn(&mut conn, user).await
    }

    /// Applies an [`OrganizationOperation`] (folder create/move/delete, playlist placement,
    /// or pin-bar reorder) inside an atomic transaction after verifying `expected_revision`.
    pub async fn organize(
        &self,
        user: &SessionUser,
        expected_revision: i64,
        operation: OrganizationOperation,
    ) -> Result<OrganizationTree, OrganizationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let current_rev = self.organization_revision(&mut tx, &user.id).await?;
        if current_rev != expected_revision {
            tx.rollback().await?;
            return Err(OrganizationError::Conflict(String::from(
                "This playlist changed elsewhere. Reload it before editing or undoing.",
            )));
        }

        match operation {
            OrganizationOperation::CreateFolder { name, parent_id } => {
                let clean_name = validate_folder_name(&name)?;
                self.check_parent_folder(&mut tx, &user.id, parent_id.as_deref(), None)
                    .await?;
                let next_pos_row = sqlx::query(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_folders WHERE user_id = ? AND parent_folder_id IS ?;",
                )
                .bind(&user.id)
                .bind(&parent_id)
                .fetch_one(&mut *tx)
                .await?;
                let next_pos: i64 = next_pos_row.try_get("n")?;

                sqlx::query(
                    "INSERT INTO playlist_folders (id, name, parent_folder_id, user_id, position) VALUES (?, ?, ?, ?, ?);",
                )
                .bind(create_id("plfolder"))
                .bind(clean_name)
                .bind(&parent_id)
                .bind(&user.id)
                .bind(next_pos)
                .execute(&mut *tx)
                .await?;
            }
            OrganizationOperation::Folder {
                id,
                name,
                parent_id,
                pinned,
                position,
            } => {
                let folder = self.load_folder(&mut tx, &user.id, &id).await?;
                let next_parent = match parent_id {
                    Some(explicit) => explicit,
                    None => folder.parent_folder_id.clone(),
                };
                self.check_parent_folder(
                    &mut tx,
                    &user.id,
                    next_parent.as_deref(),
                    Some(&folder.id),
                )
                .await?;

                let next_name = match name {
                    Some(ref n) => validate_folder_name(n)?,
                    None => folder.name.clone(),
                };
                let next_pinned = pinned.unwrap_or(folder.pinned);

                let sibling_rows = sqlx::query(
                    r"
                    SELECT id, position FROM playlist_folders
                    WHERE user_id = ? AND parent_folder_id IS ? AND id <> ?
                    ORDER BY position ASC, id ASC;
                    ",
                )
                .bind(&user.id)
                .bind(&next_parent)
                .bind(&folder.id)
                .fetch_all(&mut *tx)
                .await?;

                let mut sibling_ids: Vec<(String, i64)> = Vec::with_capacity(sibling_rows.len());
                for r in sibling_rows {
                    sibling_ids.push((r.try_get("id")?, r.try_get("position")?));
                }

                let default_rank = sibling_ids
                    .iter()
                    .filter(|(sid, pos)| {
                        *pos < folder.position || (*pos == folder.position && *sid < folder.id)
                    })
                    .count();
                let target_idx = position
                    .unwrap_or(if next_parent == folder.parent_folder_id {
                        default_rank
                    } else {
                        sibling_ids.len()
                    })
                    .min(sibling_ids.len());

                let mut ordered_ids: Vec<String> =
                    sibling_ids.into_iter().map(|(sid, _)| sid).collect();
                ordered_ids.insert(target_idx, folder.id.clone());

                sqlx::query(
                    "UPDATE playlist_folders SET name = ?, parent_folder_id = ?, pinned = ? WHERE id = ? AND user_id = ?;",
                )
                .bind(&next_name)
                .bind(&next_parent)
                .bind(i64::from(next_pinned))
                .bind(&folder.id)
                .bind(&user.id)
                .execute(&mut *tx)
                .await?;

                for (idx, sid) in ordered_ids.iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_folders SET position = ? WHERE id = ? AND user_id = ?;",
                    )
                    .bind(i64::try_from(idx).unwrap_or(0))
                    .bind(sid)
                    .bind(&user.id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            OrganizationOperation::DeleteFolder { id } => {
                let folder = self.load_folder(&mut tx, &user.id, &id).await?;
                sqlx::query(
                    "UPDATE playlist_placements SET folder_id = ?, position = position + 100000 WHERE user_id = ? AND folder_id = ?;",
                )
                .bind(&folder.parent_folder_id)
                .bind(&user.id)
                .bind(&folder.id)
                .execute(&mut *tx)
                .await?;

                sqlx::query(
                    "UPDATE playlist_folders SET parent_folder_id = ?, position = position + 100000 WHERE user_id = ? AND parent_folder_id = ?;",
                )
                .bind(&folder.parent_folder_id)
                .bind(&user.id)
                .bind(&folder.id)
                .execute(&mut *tx)
                .await?;

                sqlx::query("DELETE FROM playlist_folders WHERE id = ? AND user_id = ?;")
                    .bind(&folder.id)
                    .bind(&user.id)
                    .execute(&mut *tx)
                    .await?;
            }
            OrganizationOperation::PinOrder { id, position } => {
                let current_tree = self.tree_on_conn(&mut tx, user).await?;
                let mut pins: Vec<PlaylistTreeItem> = current_tree
                    .playlists
                    .into_iter()
                    .filter(|p| p.pinned)
                    .collect();
                pins.sort_by(|a, b| {
                    a.pin_position
                        .unwrap_or(i64::MAX)
                        .cmp(&b.pin_position.unwrap_or(i64::MAX))
                        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                        .then_with(|| a.id.cmp(&b.id))
                });

                let Some(current_idx) = pins.iter().position(|p| p.id == id) else {
                    tx.rollback().await?;
                    return Err(OrganizationError::BadRequest(String::from(
                        "Only pinned playlists can be reordered here.",
                    )));
                };

                let item = pins.remove(current_idx);
                let insert_idx = position.min(pins.len());
                pins.insert(insert_idx, item);

                for (idx, pin_item) in pins.iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_placements SET pin_position = ? WHERE user_id = ? AND playlist_id = ?;",
                    )
                    .bind(i64::try_from(idx).unwrap_or(0))
                    .bind(&user.id)
                    .bind(&pin_item.id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            OrganizationOperation::Playlist {
                id,
                folder_id,
                pinned,
                position,
            } => {
                let _ = self
                    .load_playlist_row(&mut tx, &id, user, false, false)
                    .await?;

                let prev_placement = sqlx::query(
                    "SELECT folder_id, position, pinned FROM playlist_placements WHERE user_id = ? AND playlist_id = ?;",
                )
                .bind(&user.id)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;

                let prev_folder: Option<String> = match prev_placement {
                    Some(ref r) => r.try_get("folder_id")?,
                    None => None,
                };
                let prev_pinned: bool = match prev_placement {
                    Some(ref r) => r.try_get::<i64, _>("pinned").unwrap_or(0) != 0,
                    None => false,
                };

                let target_folder = match folder_id {
                    Some(explicit) => explicit,
                    None => prev_folder.clone(),
                };
                if let Some(ref fid) = target_folder {
                    let _ = self.load_folder(&mut tx, &user.id, fid).await?;
                }

                let current_tree = self.tree_on_conn(&mut tx, user).await?;
                let current_siblings: Vec<PlaylistTreeItem> = current_tree
                    .playlists
                    .into_iter()
                    .filter(|p| p.folder_id == target_folder)
                    .collect();
                let current_rank = current_siblings.iter().position(|p| p.id == id);

                let mut sibling_ids: Vec<String> = current_siblings
                    .into_iter()
                    .filter(|p| p.id != id)
                    .map(|p| p.id)
                    .collect();

                let default_idx = if prev_folder == target_folder {
                    current_rank.unwrap_or(sibling_ids.len())
                } else {
                    sibling_ids.len()
                };
                let target_idx = position.unwrap_or(default_idx).min(sibling_ids.len());
                sibling_ids.insert(target_idx, id.clone());

                for (idx, pid) in sibling_ids.iter().enumerate() {
                    let item_pinned = if *pid == id {
                        pinned.unwrap_or(prev_pinned)
                    } else {
                        sqlx::query(
                            "SELECT pinned FROM playlist_placements WHERE user_id = ? AND playlist_id = ?;",
                        )
                        .bind(&user.id)
                        .bind(pid)
                        .fetch_optional(&mut *tx)
                        .await?
                        .is_some_and(|r| r.try_get::<i64, _>("pinned").unwrap_or(0) != 0)
                    };

                    sqlx::query(
                        r"
                        INSERT INTO playlist_placements (user_id, playlist_id, folder_id, pinned, position)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, playlist_id) DO UPDATE SET
                          folder_id = excluded.folder_id,
                          pinned = excluded.pinned,
                          position = excluded.position;
                        ",
                    )
                    .bind(&user.id)
                    .bind(pid)
                    .bind(&target_folder)
                    .bind(i64::from(item_pinned))
                    .bind(i64::try_from(idx).unwrap_or(0))
                    .execute(&mut *tx)
                    .await?;
                }

                if pinned == Some(false) {
                    sqlx::query(
                        "UPDATE playlist_placements SET pin_position = NULL WHERE user_id = ? AND playlist_id = ?;",
                    )
                    .bind(&user.id)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        sqlx::query(
            "UPDATE playlist_organization_state SET revision = revision + 1 WHERE user_id = ?;",
        )
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;

        let updated_tree = self.tree_on_conn(&mut tx, user).await?;
        tx.commit().await?;
        Ok(updated_tree)
    }

    /// Executes a reversible playlist edit command (`reorder`, `remove`, `add`, `details`, `trash`, `restore`)
    /// and records the forward/inverse delta in `playlist_edit_commands`.
    pub async fn execute(
        &self,
        user: &SessionUser,
        playlist_id: &str,
        expected_revision: i64,
        edit: ReversiblePlaylistEdit,
    ) -> Result<CommandExecutionResult, OrganizationError> {
        let mut pre_resolved_sources = HashMap::new();
        if let ReversiblePlaylistEdit::Add { ref track_ids } = edit {
            for track_id in track_ids {
                let source = self.library.get_primary_source(track_id).await?;
                pre_resolved_sources.insert(track_id.clone(), source);
            }
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let allow_trash = matches!(edit, ReversiblePlaylistEdit::Restore);
        let row = self
            .load_playlist_row(&mut tx, playlist_id, user, allow_trash, true)
            .await?;

        if matches!(
            edit,
            ReversiblePlaylistEdit::Details { .. }
                | ReversiblePlaylistEdit::Trash
                | ReversiblePlaylistEdit::Restore
        ) {
            let access = self
                .collab
                .access_on_conn(&mut tx, playlist_id, user, allow_trash)
                .await?;
            if !access.can_manage {
                tx.rollback().await?;
                return Err(OrganizationError::Forbidden(String::from(
                    "Only the owner can manage playlist details and Trash.",
                )));
            }
        }

        if row.edit_revision != expected_revision {
            tx.rollback().await?;
            return Err(OrganizationError::Conflict(String::from(
                "This playlist changed elsewhere. Reload it before editing or undoing.",
            )));
        }

        let items = self.load_entries(&mut tx, playlist_id).await?;
        let before_hash = compute_playlist_fingerprint(&row, &items);
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let (forward, inverse, label) = match edit {
            ReversiblePlaylistEdit::Reorder {
                item_ids,
                expected_item_ids,
            } => {
                assert_item_order(&items, Some(&expected_item_ids))?;
                let prev_ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
                (
                    CommandDelta::Order { ids: item_ids },
                    CommandDelta::Order { ids: prev_ids },
                    String::from("Tracks reordered"),
                )
            }
            ReversiblePlaylistEdit::Remove {
                item_ids,
                expected_item_ids,
            } => {
                assert_item_order(&items, expected_item_ids.as_deref())?;
                let remove_set: HashSet<&String> = item_ids.iter().collect();
                let removed_entries: Vec<StoredEntry> = items
                    .iter()
                    .filter(|i| remove_set.contains(&i.id))
                    .cloned()
                    .collect();
                let label = if remove_set.len() == 1 {
                    String::from("Track removed")
                } else {
                    String::from("Tracks removed")
                };
                (
                    CommandDelta::Remove { ids: item_ids },
                    CommandDelta::Insert {
                        items: removed_entries,
                    },
                    label,
                )
            }
            ReversiblePlaylistEdit::Add { track_ids } => {
                let mut known_pairs: HashSet<(String, String)> = items
                    .iter()
                    .map(|i| (i.connection_id.clone(), i.provider_track_id.clone()))
                    .collect();
                let mut added = Vec::new();
                for track_id in track_ids {
                    let Some(source) = pre_resolved_sources.get(&track_id).cloned().flatten() else {
                        tx.rollback().await?;
                        return Err(OrganizationError::BadRequest(String::from(
                            "A selected track is not in the library. Import it before adding it.",
                        )));
                    };
                    if !known_pairs
                        .insert((source.connection_id.clone(), source.provider_item_id.clone()))
                    {
                        continue;
                    }
                    let pos = i64::try_from(items.len() + added.len()).unwrap_or(0);
                    added.push(StoredEntry {
                        id: create_id("mdpli"),
                        playlist_id: playlist_id.to_owned(),
                        position: pos,
                        connection_id: source.connection_id,
                        provider_track_id: source.provider_item_id,
                        library_track_id: Some(track_id),
                        created_at: now_iso.clone(),
                        external_track_json: None,
                        added_by_user_id: Some(user.id.clone()),
                    });
                }
                let added_ids: Vec<String> = added.iter().map(|i| i.id.clone()).collect();
                let label = if added.len() == 1 {
                    String::from("Track added")
                } else {
                    String::from("Tracks added")
                };
                (
                    CommandDelta::Insert { items: added },
                    CommandDelta::Remove { ids: added_ids },
                    label,
                )
            }
            ReversiblePlaylistEdit::Details { name, description } => {
                let next_name = name.unwrap_or_else(|| row.name.clone());
                let next_desc = match description {
                    Some(explicit) => explicit,
                    None => row.description.clone(),
                };
                (
                    CommandDelta::Details {
                        name: next_name,
                        description: next_desc,
                    },
                    CommandDelta::Details {
                        name: row.name.clone(),
                        description: row.description.clone(),
                    },
                    String::from("Playlist details updated"),
                )
            }
            ReversiblePlaylistEdit::Trash => (
                CommandDelta::Trash {
                    at: Some(now_iso.clone()),
                },
                CommandDelta::Trash {
                    at: row.deleted_at.clone(),
                },
                String::from("Playlist moved to Trash"),
            ),
            ReversiblePlaylistEdit::Restore => (
                CommandDelta::Trash { at: None },
                CommandDelta::Trash {
                    at: row.deleted_at.clone(),
                },
                String::from("Playlist restored"),
            ),
        };

        self.apply_delta(&mut tx, playlist_id, &forward, &now_iso)
            .await?;

        let after_row = self
            .load_playlist_row(&mut tx, playlist_id, user, true, true)
            .await?;
        let after_items = self.load_entries(&mut tx, playlist_id).await?;
        let after_hash = compute_playlist_fingerprint(&after_row, &after_items);

        if before_hash == after_hash {
            tx.commit().await?;
            return Ok(CommandExecutionResult {
                command: None,
                revision: after_row.edit_revision,
                deleted_at: after_row.deleted_at,
            });
        }

        let command_id = create_id("plcmd");
        let forward_json = serde_json::to_string(&forward).unwrap_or_default();
        let inverse_json = serde_json::to_string(&inverse).unwrap_or_default();

        sqlx::query(
            r"
            INSERT INTO playlist_edit_commands
              (id, user_id, playlist_id, label, before_hash, after_hash, forward_json, inverse_json, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?);
            ",
        )
        .bind(&command_id)
        .bind(&user.id)
        .bind(playlist_id)
        .bind(&label)
        .bind(&before_hash)
        .bind(&after_hash)
        .bind(&forward_json)
        .bind(&inverse_json)
        .bind(&now_iso)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r"
            DELETE FROM playlist_edit_commands
            WHERE user_id = ?
              AND id NOT IN (
                SELECT id FROM playlist_edit_commands
                WHERE user_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
              );
            ",
        )
        .bind(&user.id)
        .bind(&user.id)
        .bind(MAX_RETAINED_COMMANDS)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(CommandExecutionResult {
            command: Some(CommandSummary {
                id: command_id,
                playlist_id: playlist_id.to_owned(),
                label,
            }),
            revision: after_row.edit_revision,
            deleted_at: after_row.deleted_at,
        })
    }

    /// Reverses (`undo` or `redo`) a previously recorded command after verifying `expected_revision`
    /// and the SHA-256 playlist fingerprint.
    pub async fn reverse(
        &self,
        user: &SessionUser,
        command_id: &str,
        expected_revision: i64,
        direction: CommandDirection,
    ) -> Result<CommandExecutionResult, OrganizationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let cmd_row = sqlx::query(
            "SELECT * FROM playlist_edit_commands WHERE id = ? AND user_id = ?;",
        )
        .bind(command_id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(cmd_row) = cmd_row else {
            tx.rollback().await?;
            return Err(OrganizationError::Gone(String::from(
                "This undo step has expired. Reload the playlist.",
            )));
        };

        let playlist_id: String = cmd_row.try_get("playlist_id")?;
        let label: String = cmd_row.try_get("label")?;
        let before_hash: String = cmd_row.try_get("before_hash")?;
        let after_hash: String = cmd_row.try_get("after_hash")?;
        let forward_json: String = cmd_row.try_get("forward_json")?;
        let inverse_json: String = cmd_row.try_get("inverse_json")?;
        let state_str: String = cmd_row.try_get("state")?;

        let row = self
            .load_playlist_row(&mut tx, &playlist_id, user, true, true)
            .await?;
        if row.edit_revision != expected_revision {
            tx.rollback().await?;
            return Err(OrganizationError::Conflict(String::from(
                "This playlist changed elsewhere. Reload it before editing or undoing.",
            )));
        }

        let items = self.load_entries(&mut tx, &playlist_id).await?;
        let current_fp = compute_playlist_fingerprint(&row, &items);

        let (expected_state, expected_hash, delta_json, next_state) = match direction {
            CommandDirection::Undo => ("done", &after_hash, &inverse_json, "undone"),
            CommandDirection::Redo => ("undone", &before_hash, &forward_json, "done"),
        };

        if state_str != expected_state || &current_fp != expected_hash {
            tx.rollback().await?;
            return Err(OrganizationError::Conflict(String::from(
                "Undo history no longer matches this playlist. Reload it before continuing.",
            )));
        }

        let delta: CommandDelta = serde_json::from_str(delta_json).map_err(|_| {
            OrganizationError::BadRequest(String::from("Stored command payload is invalid"))
        })?;

        if matches!(
            delta,
            CommandDelta::Details { .. } | CommandDelta::Trash { .. }
        ) {
            let access = self
                .collab
                .access_on_conn(&mut tx, &playlist_id, user, true)
                .await?;
            if !access.can_manage {
                tx.rollback().await?;
                return Err(OrganizationError::Forbidden(String::from(
                    "Only the owner can undo playlist management changes.",
                )));
            }
        }

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.apply_delta(&mut tx, &playlist_id, &delta, &now_iso)
            .await?;

        sqlx::query("UPDATE playlist_edit_commands SET state = ? WHERE id = ?;")
            .bind(next_state)
            .bind(command_id)
            .execute(&mut *tx)
            .await?;

        let updated = self
            .load_playlist_row(&mut tx, &playlist_id, user, true, true)
            .await?;
        tx.commit().await?;

        Ok(CommandExecutionResult {
            command: Some(CommandSummary {
                id: command_id.to_owned(),
                playlist_id,
                label,
            }),
            revision: updated.edit_revision,
            deleted_at: updated.deleted_at,
        })
    }

    /// Lists playlists in Trash (`deleted_at IS NOT NULL`) within the 30-day recovery window.
    pub async fn trash(
        &self,
        user: &SessionUser,
    ) -> Result<Vec<TrashPlaylistSummary>, OrganizationError> {
        let cutoff_ms = Utc::now().timestamp_millis() - TRASH_RETENTION_MS;
        let cutoff_iso = DateTime::from_timestamp_millis(cutoff_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let rows = sqlx::query(
            r"
            SELECT id, name, deleted_at, edit_revision,
                   (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS track_count
            FROM playlists p
            WHERE deleted_at IS NOT NULL
              AND deleted_at > ?
              AND (owner_user_id = ? OR ? = 1)
            ORDER BY deleted_at DESC, id ASC;
            ",
        )
        .bind(&cutoff_iso)
        .bind(&user.id)
        .bind(i64::from(user.is_admin()))
        .fetch_all(self.db.inner())
        .await?;

        let mut list = Vec::with_capacity(rows.len());
        for row in rows {
            list.push(TrashPlaylistSummary {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                deleted_at: row.try_get("deleted_at")?,
                revision: row.try_get("edit_revision")?,
                track_count: row.try_get("track_count")?,
            });
        }
        Ok(list)
    }

    /// Purges up to `limit` playlists whose 30-day Trash retention window has expired.
    pub async fn purge_expired(&self, limit: i64) -> Result<u64, OrganizationError> {
        let cutoff_ms = Utc::now().timestamp_millis() - TRASH_RETENTION_MS;
        let cutoff_iso = DateTime::from_timestamp_millis(cutoff_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let res = sqlx::query(
            r"
            DELETE FROM playlists
            WHERE id IN (
              SELECT id FROM playlists
              WHERE deleted_at IS NOT NULL AND deleted_at <= ?
              ORDER BY deleted_at ASC
              LIMIT ?
            );
            ",
        )
        .bind(cutoff_iso)
        .bind(limit.max(1))
        .execute(self.db.inner())
        .await?;

        Ok(res.rows_affected())
    }

    async fn tree_on_conn(
        &self,
        conn: &mut SqliteConnection,
        user: &SessionUser,
    ) -> Result<OrganizationTree, OrganizationError> {
        let rev = self.organization_revision(&mut *conn, &user.id).await?;

        let folder_rows = sqlx::query(
            "SELECT * FROM playlist_folders WHERE user_id = ? ORDER BY position ASC, id ASC;",
        )
        .bind(&user.id)
        .fetch_all(&mut *conn)
        .await?;

        let mut folders = Vec::with_capacity(folder_rows.len());
        for row in folder_rows {
            folders.push(PlaylistFolder {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                parent_folder_id: row.try_get("parent_folder_id")?,
                user_id: row.try_get("user_id")?,
                pinned: row.try_get::<i64, _>("pinned").unwrap_or(0) != 0,
                position: row.try_get("position")?,
            });
        }

        let playlist_rows = sqlx::query(
            r"
            SELECT
              p.id,
              p.name,
              p.owner_user_id,
              p.updated_at,
              p.created_at,
              u.display_name AS creator,
              o.folder_id,
              COALESCE(o.pinned, 0) AS pinned,
              COALESCE(o.position, 2147483647) AS position,
              o.pin_position
            FROM playlists p
            LEFT JOIN playlist_placements o ON o.playlist_id = p.id AND o.user_id = ?
            LEFT JOIN users u ON u.id = p.owner_user_id
            WHERE p.deleted_at IS NULL
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
            ORDER BY position ASC, p.name COLLATE NOCASE ASC, p.id ASC;
            ",
        )
        .bind(&user.id)
        .bind(&user.id)
        .bind(i64::from(user.is_admin()))
        .bind(&user.id)
        .fetch_all(&mut *conn)
        .await?;

        let mut playlists = Vec::with_capacity(playlist_rows.len());
        for row in playlist_rows {
            playlists.push(PlaylistTreeItem {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                owner_user_id: row.try_get("owner_user_id")?,
                updated_at: row.try_get("updated_at")?,
                created_at: row.try_get("created_at")?,
                creator: row.try_get("creator")?,
                folder_id: row.try_get("folder_id")?,
                pinned: row.try_get::<i64, _>("pinned").unwrap_or(0) != 0,
                position: row.try_get("position")?,
                pin_position: row.try_get("pin_position")?,
            });
        }

        Ok(OrganizationTree {
            revision: rev,
            folders,
            playlists,
        })
    }

    async fn organization_revision(
        &self,
        conn: &mut SqliteConnection,
        user_id: &str,
    ) -> Result<i64, OrganizationError> {
        sqlx::query("INSERT OR IGNORE INTO playlist_organization_state (user_id) VALUES (?);")
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
        let row = sqlx::query(
            "SELECT revision FROM playlist_organization_state WHERE user_id = ?;",
        )
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await?;
        Ok(row.try_get("revision")?)
    }

    async fn load_folder(
        &self,
        conn: &mut SqliteConnection,
        user_id: &str,
        folder_id: &str,
    ) -> Result<PlaylistFolder, OrganizationError> {
        let row = sqlx::query(
            "SELECT * FROM playlist_folders WHERE id = ? AND user_id = ?;",
        )
        .bind(folder_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| OrganizationError::NotFound(String::from("Folder not found.")))?;

        Ok(PlaylistFolder {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            parent_folder_id: row.try_get("parent_folder_id")?,
            user_id: row.try_get("user_id")?,
            pinned: row.try_get::<i64, _>("pinned").unwrap_or(0) != 0,
            position: row.try_get("position")?,
        })
    }

    async fn check_parent_folder(
        &self,
        conn: &mut SqliteConnection,
        user_id: &str,
        parent_id: Option<&str>,
        moving_id: Option<&str>,
    ) -> Result<(), OrganizationError> {
        let mut depth = 0usize;
        let mut cursor: Option<String> = parent_id.map(str::to_owned);

        while let Some(ref cid) = cursor {
            if moving_id == Some(cid.as_str()) {
                return Err(OrganizationError::BadRequest(String::from(
                    "A folder cannot be moved into itself or its descendants.",
                )));
            }
            let parent_folder = self.load_folder(&mut *conn, user_id, cid).await?;
            cursor = parent_folder.parent_folder_id;
            depth += 1;
            if depth >= MAX_FOLDER_DEPTH {
                return Err(OrganizationError::BadRequest(String::from(
                    "Folders support up to 16 nesting levels.",
                )));
            }
        }

        if let Some(moving) = moving_id {
            let row = sqlx::query(
                r"
                WITH RECURSIVE children(id, depth) AS (
                  SELECT ?, 1
                  UNION ALL
                  SELECT f.id, c.depth + 1
                  FROM playlist_folders f
                  JOIN children c ON f.parent_folder_id = c.id
                  WHERE f.user_id = ?
                )
                SELECT COALESCE(MAX(depth), 1) AS max_depth FROM children;
                ",
            )
            .bind(moving)
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?;

            let subtree_height = usize::try_from(row.try_get::<i64, _>("max_depth").unwrap_or(1))
                .unwrap_or(1);
            if depth + subtree_height > MAX_FOLDER_DEPTH {
                return Err(OrganizationError::BadRequest(String::from(
                    "This move would exceed 16 nesting levels.",
                )));
            }
        }

        Ok(())
    }

    async fn load_playlist_row(
        &self,
        conn: &mut SqliteConnection,
        playlist_id: &str,
        user: &SessionUser,
        allow_trash: bool,
        write: bool,
    ) -> Result<OrgPlaylistRow, OrganizationError> {
        let row = sqlx::query(
            "SELECT id, owner_user_id, name, description, deleted_at, edit_revision FROM playlists WHERE id = ?;",
        )
        .bind(playlist_id)
        .fetch_optional(&mut *conn)
        .await?;

        let access = self
            .collab
            .access_on_conn(&mut *conn, playlist_id, user, allow_trash)
            .await?;

        let Some(row) = row else {
            return Err(if write {
                OrganizationError::Forbidden(String::from("Playlist edit access denied."))
            } else {
                OrganizationError::NotFound(String::from("Playlist not found."))
            });
        };

        if !access.can_read {
            return Err(if write {
                OrganizationError::Forbidden(String::from("Playlist edit access denied."))
            } else {
                OrganizationError::NotFound(String::from("Playlist not found."))
            });
        }

        if write && !access.can_edit_tracks {
            return Err(OrganizationError::Forbidden(String::from(
                "Collaborator access is required to edit tracks.",
            )));
        }

        let deleted_at: Option<String> = row.try_get("deleted_at")?;
        if let Some(ref del_str) = deleted_at {
            if !allow_trash {
                return Err(OrganizationError::NotFound(String::from(
                    "Playlist is in Trash.",
                )));
            }
            let expired = DateTime::parse_from_rfc3339(del_str).is_ok_and(|dt| {
                Utc::now().timestamp_millis() - dt.timestamp_millis() >= TRASH_RETENTION_MS
            });
            if expired {
                return Err(OrganizationError::Gone(String::from(
                    "This playlist's recovery period has expired.",
                )));
            }
        }

        Ok(OrgPlaylistRow {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            deleted_at,
            edit_revision: row.try_get("edit_revision")?,
        })
    }

    async fn load_entries(
        &self,
        conn: &mut SqliteConnection,
        playlist_id: &str,
    ) -> Result<Vec<StoredEntry>, OrganizationError> {
        let rows = sqlx::query(
            "SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC, id ASC;",
        )
        .bind(playlist_id)
        .fetch_all(&mut *conn)
        .await?;

        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            entries.push(StoredEntry {
                id: row.try_get("id")?,
                playlist_id: row.try_get("playlist_id")?,
                position: row.try_get("position")?,
                connection_id: row.try_get("connection_id")?,
                provider_track_id: row.try_get("provider_track_id")?,
                library_track_id: row.try_get("library_track_id")?,
                created_at: row.try_get("created_at")?,
                external_track_json: row.try_get("external_track_json").ok().flatten(),
                added_by_user_id: row.try_get("added_by_user_id").ok().flatten(),
            });
        }
        Ok(entries)
    }

    async fn apply_delta(
        &self,
        conn: &mut SqliteConnection,
        playlist_id: &str,
        delta: &CommandDelta,
        now_iso: &str,
    ) -> Result<(), OrganizationError> {
        let items = self.load_entries(&mut *conn, playlist_id).await?;

        match delta {
            CommandDelta::Details { name, description } => {
                sqlx::query("UPDATE playlists SET name = ?, description = ? WHERE id = ?;")
                    .bind(name)
                    .bind(description)
                    .bind(playlist_id)
                    .execute(&mut *conn)
                    .await?;
            }
            CommandDelta::Trash { at } => {
                sqlx::query("UPDATE playlists SET deleted_at = ? WHERE id = ?;")
                    .bind(at)
                    .bind(playlist_id)
                    .execute(&mut *conn)
                    .await?;
            }
            CommandDelta::Order { ids } => {
                let by_id: HashMap<&str, &StoredEntry> =
                    items.iter().map(|i| (i.id.as_str(), i)).collect();
                let unique: HashSet<&String> = ids.iter().collect();
                if unique.len() != items.len()
                    || ids.len() != items.len()
                    || ids.iter().any(|k| !by_id.contains_key(k.as_str()))
                {
                    return Err(OrganizationError::BadRequest(String::from(
                        "Reorder must contain every entry exactly once.",
                    )));
                }
                for (pos, item_id) in ids.iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?;",
                    )
                    .bind(i64::try_from(pos).unwrap_or(0))
                    .bind(item_id)
                    .bind(playlist_id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
            CommandDelta::Remove { ids } => {
                let remove_set: HashSet<&String> = ids.iter().collect();
                let known_set: HashSet<&String> = items.iter().map(|i| &i.id).collect();
                if remove_set.len() != ids.len()
                    || ids.iter().any(|k| !known_set.contains(k))
                {
                    return Err(OrganizationError::Conflict(String::from(
                        "An entry is no longer in this playlist.",
                    )));
                }
                for item_id in ids {
                    sqlx::query("DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?;")
                        .bind(playlist_id)
                        .bind(item_id)
                        .execute(&mut *conn)
                        .await?;
                }
                let remaining: Vec<&StoredEntry> = items
                    .iter()
                    .filter(|i| !remove_set.contains(&i.id))
                    .collect();
                for (pos, entry) in remaining.into_iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?;",
                    )
                    .bind(i64::try_from(pos).unwrap_or(0))
                    .bind(&entry.id)
                    .bind(playlist_id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
            CommandDelta::Insert {
                items: to_insert,
            } => {
                if items.len() + to_insert.len() > MAX_PLAYLIST_ITEMS {
                    return Err(OrganizationError::BadRequest(String::from(
                        "A playlist can contain at most 20,000 entries.",
                    )));
                }
                let mut order = items;
                let mut sorted_inserts = to_insert.clone();
                sorted_inserts.sort_by_key(|i| i.position);

                for entry in sorted_inserts {
                    let contributor = if let Some(ref uid) = entry.added_by_user_id {
                        let exists = sqlx::query("SELECT 1 FROM users WHERE id = ?;")
                            .bind(uid)
                            .fetch_optional(&mut *conn)
                            .await?
                            .is_some();
                        exists.then(|| uid.clone())
                    } else {
                        None
                    };

                    sqlx::query(
                        r"
                        INSERT INTO playlist_items
                          (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, external_track_json, added_by_user_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                        ",
                    )
                    .bind(&entry.id)
                    .bind(playlist_id)
                    .bind(entry.position)
                    .bind(&entry.connection_id)
                    .bind(&entry.provider_track_id)
                    .bind(&entry.library_track_id)
                    .bind(&entry.created_at)
                    .bind(&entry.external_track_json)
                    .bind(contributor)
                    .execute(&mut *conn)
                    .await?;

                    let idx = usize::try_from(entry.position.max(0))
                        .unwrap_or(order.len())
                        .min(order.len());
                    order.insert(idx, entry);
                }

                for (pos, entry) in order.iter().enumerate() {
                    sqlx::query(
                        "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?;",
                    )
                    .bind(i64::try_from(pos).unwrap_or(0))
                    .bind(&entry.id)
                    .bind(playlist_id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
        }

        sqlx::query(
            "UPDATE playlists SET updated_at = ?, edit_revision = edit_revision + 1 WHERE id = ?;",
        )
        .bind(now_iso)
        .bind(playlist_id)
        .execute(&mut *conn)
        .await?;

        Ok(())
    }
}

#[derive(Debug, Clone)]
struct OrgPlaylistRow {
    id: String,
    name: String,
    description: Option<String>,
    deleted_at: Option<String>,
    edit_revision: i64,
}

fn compute_playlist_fingerprint(row: &OrgPlaylistRow, items: &[StoredEntry]) -> String {
    let _ = &row.id;
    let payload = json!([row.name, row.description, row.deleted_at, items]);
    let digest = Sha256::digest(payload.to_string().as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

fn assert_item_order(
    items: &[StoredEntry],
    expected: Option<&[String]>,
) -> Result<(), OrganizationError> {
    if let Some(exp) = expected {
        let matches = items.len() == exp.len()
            && items.iter().zip(exp.iter()).all(|(a, b)| a.id == *b);
        if !matches {
            return Err(OrganizationError::Conflict(String::from(
                "The playlist's track order changed. Reload before editing.",
            )));
        }
    }
    Ok(())
}

fn validate_folder_name(raw: &str) -> Result<String, OrganizationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 || trimmed.contains('\0') {
        return Err(OrganizationError::BadRequest(String::from(
            "Invalid folder or playlist placement.",
        )));
    }
    Ok(trimmed.to_owned())
}
