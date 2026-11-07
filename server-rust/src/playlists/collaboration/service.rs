//! # Collaborative Playlist Sharing, Cryptographic Share Links & Live Party Hub (`playlists::collaboration::service`)
//!
//! Complete Rust port of `server/src/services/PlaylistCollaborationService.ts`
//! plus a real-time WebSocket [`PartyBroadcastHub`] powered by `tokio::sync::broadcast`.
//!
//! ## Security & Protocol Guarantees
//! 1. **Cryptographic Share Links (`playlist_share_links`)**:
//!    - Generates 256-bit CSPRNG invitation tokens (`32` random bytes encoded as 64-char
//!      lowercase hex).
//!    - Only `sha256(token)` is persisted in `playlist_share_links.token_hash`, with a
//!      7-day expiration (`SHARE_LINK_TTL_MS`) and a 50-active-link cap per playlist.
//!    - Changing a playlist's sharing mode revokes all active share links and closes any
//!      open party session if the mode is no longer `COLLABORATIVE`.
//! 2. **Live Party Sessions & Request Queue (`playlist_party_sessions` & `playlist_party_requests`)**:
//!    - Enforces at most one open party session per playlist (`WHERE closed_at IS NULL`)
//!      with a 90-second host heartbeat lease (`PARTY_LEASE_MS = 90_000`).
//!    - Collaborators submit track requests with client-generated UUID `idempotency_key`s,
//!      bounded at `200` total pending requests per party and `20` pending requests per user.
//! 3. **Real-Time WebSocket Party Room Hub ([`PartyBroadcastHub`])**:
//!    - Coordinates live WebSocket frames (`join_session`, `queue_add`, `track_vote`,
//!      `host_control`, `sync_state`) across all connected party participants for a playlist,
//!      automatically cleaning up empty room channels when the last subscriber disconnects.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row, SqliteConnection};
use thiserror::Error;
use tokio::sync::broadcast;

use crate::auth::SessionUser;
use crate::avatars::avatar_url_for;
use crate::db::{DbError, DbPool, create_id};
use crate::playlists::{PlaylistPermissions, PlaylistVisibility};

/// Host heartbeat lease duration (`90,000` ms = 90 seconds) for an active party session.
pub const PARTY_LEASE_MS: i64 = 90_000;

/// Invitation link lifetime (`7` days in milliseconds).
pub const SHARE_LINK_TTL_MS: i64 = 7 * 86_400_000;

/// Maximum active share links allowed per playlist (`50`).
pub const MAX_ACTIVE_SHARE_LINKS: i64 = 50;

/// Maximum total pending party requests per session (`200`).
pub const MAX_PARTY_PENDING_TOTAL: i64 = 200;

/// Maximum pending party requests per individual collaborator (`20`).
pub const MAX_PARTY_PENDING_PER_USER: i64 = 20;

/// Role granted to a named household member in `playlist_permissions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CollaboratorRole {
    /// Read-only access to the shared playlist.
    Viewer,
    /// Can add, remove, and reorder tracks, and submit party requests.
    Collaborator,
}

impl CollaboratorRole {
    /// Parses `"VIEWER"` or `"COLLABORATOR"`.
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "VIEWER" => Some(Self::Viewer),
            "COLLABORATOR" => Some(Self::Collaborator),
            _ => None,
        }
    }

    /// Returns the database literal string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "VIEWER",
            Self::Collaborator => "COLLABORATOR",
        }
    }
}

/// Input grant item in `PUT /api/v1/playlists/:playlistId/sharing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaylistGrant {
    /// Target user ID.
    pub user_id: String,
    /// Granted collaborator role (`VIEWER` or `COLLABORATOR`).
    pub role: CollaboratorRole,
}

/// Hydrated grant entry returned in [`SharingSnapshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedPlaylistGrant {
    /// User ID.
    pub user_id: String,
    /// Granted role.
    pub role: CollaboratorRole,
    /// Username.
    pub username: String,
    /// Display name.
    pub display_name: String,
    /// Whether the user account is disabled.
    pub disabled: bool,
    /// Optional versioned avatar URL.
    pub avatar_url: Option<String>,
}

/// Active share link metadata returned in [`SharingSnapshot`] (never exposes the raw token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkSummary {
    /// Link ID (`plshare_<nanoid>`).
    pub id: String,
    /// Optional recipient user ID.
    pub recipient_user_id: Option<String>,
    /// Optional recipient display name.
    pub recipient_name: Option<String>,
    /// Expiration epoch timestamp in milliseconds.
    pub expires_at: i64,
}

/// Newly minted share token returned once on `POST /api/v1/playlists/:playlistId/sharing/links` (`ShareToken`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareToken {
    /// Share link ID (`plshare_<nanoid>`).
    pub id: String,
    /// Raw 64-character hex invitation token (only returned at creation time).
    pub token: String,
    /// Expiration epoch timestamp in milliseconds.
    pub expires_at: i64,
}

/// Complete sharing configuration snapshot returned by `GET /api/v1/playlists/:playlistId/sharing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingSnapshot {
    /// Playlist ID.
    pub playlist_id: String,
    /// Active sharing mode.
    pub mode: PlaylistVisibility,
    /// Current `sharing_revision`.
    pub revision: i64,
    /// Owner user ID.
    pub owner_user_id: Option<String>,
    /// Hydrated member grants.
    pub grants: Vec<HydratedPlaylistGrant>,
    /// Active (non-revoked, non-expired) share links.
    pub links: Vec<ShareLinkSummary>,
}

/// Household user search result returned by `GET /api/v1/playlists/:playlistId/sharing/users`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HouseholdUserItem {
    /// User ID.
    pub id: String,
    /// Username.
    pub username: String,
    /// Display name.
    pub display_name: String,
    /// Optional avatar URL.
    pub avatar_url: Option<String>,
}

/// Lifecycle state of a party track request (`PENDING`, `QUEUED`, `DISMISSED`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PartyRequestState {
    /// Waiting for host review.
    Pending,
    /// Accepted and queued by the host player.
    Queued,
    /// Dismissed by the host player (or invalidated if collaborator access was revoked).
    Dismissed,
}

impl PartyRequestState {
    /// Returns the database literal string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Queued => "QUEUED",
            Self::Dismissed => "DISMISSED",
        }
    }
}

/// Active party session metadata (`PartySessionState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartySessionInfo {
    /// Party session ID (`party_<nanoid>`).
    pub id: String,
    /// `true` if the requesting caller is the active hosting player (`user + session + device`).
    pub is_host: bool,
    /// Lease expiration timestamp in milliseconds.
    pub expires_at: i64,
}

/// Pending track request row inside a live party session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyTrackRequestItem {
    /// Request ID (`partyreq_<nanoid>`).
    pub id: String,
    /// Requested library track ID (`md_...`).
    pub track_id: String,
    /// User ID of the requester.
    pub requested_by_user_id: Option<String>,
    /// Display name of the requester.
    pub requested_by: Option<String>,
    /// Creation timestamp (epoch ms).
    pub created_at: i64,
    /// Optional hydrated track payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<serde_json::Value>,
}

/// Combined party session and pending request list (`GET /api/v1/playlists/:playlistId/party`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartySessionState {
    /// Active party session info, or `None` if no party is currently open.
    pub party: Option<PartySessionInfo>,
    /// Pending track requests visible to the caller.
    pub requests: Vec<PartyTrackRequestItem>,
}

/// Host control action (`POST /api/v1/playlists/:playlistId/party/control`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PartyHostAction {
    /// Extend the party session lease by [`PARTY_LEASE_MS`] (`90` seconds).
    #[serde(rename = "heartbeat")]
    Heartbeat,
    /// Close the party session immediately.
    #[serde(rename = "close")]
    Close,
    /// Mark a pending `request_id` as `QUEUED`.
    #[serde(rename = "QUEUED")]
    Queued,
    /// Mark a pending `request_id` as `DISMISSED`.
    #[serde(rename = "DISMISSED")]
    Dismissed,
}

// ============================================================================
// Real-Time WebSocket Party Room Protocol & Broadcast Hub
// ============================================================================

/// Inbound JSON WebSocket message sent by a participant in a live party session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PartyWsClientFrame {
    /// Join/identify the participant's device in the party room.
    JoinSession {
        /// Client device UUID.
        device_id: String,
    },
    /// Submit a live track request to the party queue.
    QueueAdd {
        /// Library track ID (`md_...`).
        track_id: String,
        /// Client UUID idempotency key.
        idempotency_key: String,
    },
    /// Upvote or toggle a vote on a pending party request.
    TrackVote {
        /// Target party request ID (`partyreq_...`).
        request_id: String,
        /// Vote direction (`true` = upvote, `false` = remove vote).
        upvote: bool,
    },
    /// Request an immediate `sync_state` broadcast from the server.
    SyncState {
        /// Client device UUID.
        device_id: String,
    },
}

/// Outbound JSON WebSocket message broadcast by [`PartyBroadcastHub`] to party participants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PartyWsServerFrame {
    /// Full or incremental party state synchronization frame.
    SyncState {
        /// Playlist ID.
        playlist_id: String,
        /// Current party session state.
        state: PartySessionState,
    },
    /// Notification that a new track was requested in the party room.
    QueueAdded {
        /// Playlist ID.
        playlist_id: String,
        /// Request ID (`partyreq_...`).
        request_id: String,
        /// Track ID (`md_...`).
        track_id: String,
        /// Requester user ID.
        requested_by_user_id: String,
    },
    /// Notification that a participant voted on a pending track request.
    TrackVoted {
        /// Playlist ID.
        playlist_id: String,
        /// Request ID (`partyreq_...`).
        request_id: String,
        /// Voter user ID.
        voter_user_id: String,
        /// Vote state.
        upvote: bool,
    },
    /// Notification that the host reviewed a request or closed the party.
    PartyUpdated {
        /// Playlist ID.
        playlist_id: String,
        /// Action performed (`heartbeat`, `close`, `QUEUED`, `DISMISSED`).
        action: String,
        /// Optional affected request ID.
        request_id: Option<String>,
    },
    /// Structured error frame for invalid client commands.
    Error {
        /// Error code.
        code: String,
        /// Human-readable error message.
        message: String,
    },
}

/// Thread-safe broadcast hub managing per-playlist WebSocket channels for live party rooms.
#[derive(Debug, Clone, Default)]
pub struct PartyBroadcastHub {
    rooms: Arc<RwLock<HashMap<String, broadcast::Sender<PartyWsServerFrame>>>>,
}

impl PartyBroadcastHub {
    /// Creates a new [`PartyBroadcastHub`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribes to live [`PartyWsServerFrame`] events for `playlist_id`.
    #[must_use]
    pub fn subscribe(&self, playlist_id: &str) -> broadcast::Receiver<PartyWsServerFrame> {
        let mut guard = self
            .rooms
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = guard
            .entry(playlist_id.to_owned())
            .or_insert_with(|| broadcast::channel(128).0);
        sender.subscribe()
    }

    /// Broadcasts `frame` to all connected WebSocket participants in `playlist_id`,
    /// pruning the room channel if zero subscribers remain.
    pub fn publish(&self, playlist_id: &str, frame: PartyWsServerFrame) {
        let mut should_remove = false;
        if let Ok(guard) = self.rooms.read()
            && let Some(sender) = guard.get(playlist_id)
            && (sender.send(frame).is_err() || sender.receiver_count() == 0) {
                should_remove = true;
            }
        if should_remove && let Ok(mut guard) = self.rooms.write()
            && guard
                .get(playlist_id)
                .is_some_and(|s| s.receiver_count() == 0)
            {
                guard.remove(playlist_id);
            }
    }
}

/// Error taxonomy for playlist sharing, invitations, and party queue operations
/// (`PlaylistPermissionError` in TypeScript).
#[derive(Debug, Error)]
pub enum CollaborationError {
    /// Invalid sharing or party request parameters (`400 Bad Request`).
    #[error("{0}")]
    BadRequest(String),

    /// Insufficient permissions (`403 Forbidden`).
    #[error("{0}")]
    Forbidden(String),

    /// Playlist, invitation, or party request not found (`404 Not Found`).
    #[error("{0}")]
    NotFound(String),

    /// Revision mismatch or offline party queue (`409 Conflict`).
    #[error("{0}")]
    Conflict(String),

    /// Expired invitation (`410 Gone`).
    #[error("{0}")]
    Gone(String),

    /// Share link or party request rate/capacity limit exceeded (`429 Too Many Requests`).
    #[error("{0}")]
    TooManyRequests(String),

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("Collaboration database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

impl CollaborationError {
    /// Returns the HTTP status code (`400`, `403`, `404`, `409`, `410`, `429`, or `500`).
    #[must_use]
    pub const fn status_code(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            Self::Forbidden(_) => 403,
            Self::NotFound(_) => 404,
            Self::Conflict(_) => 409,
            Self::Gone(_) => 410,
            Self::TooManyRequests(_) => 429,
            Self::Db(_) | Self::Sqlx(_) => 500,
        }
    }
}

/// Authoritative service for playlist permissions, sharing modes, cryptographic share links,
/// and live party request queues.
#[derive(Debug, Clone)]
pub struct PlaylistCollaborationService {
    db: DbPool,
    hub: PartyBroadcastHub,
}

impl PlaylistCollaborationService {
    /// Constructs a new [`PlaylistCollaborationService`].
    #[must_use]
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            hub: PartyBroadcastHub::new(),
        }
    }

    /// Constructs a [`PlaylistCollaborationService`] sharing an existing [`PartyBroadcastHub`].
    #[must_use]
    pub const fn with_hub(db: DbPool, hub: PartyBroadcastHub) -> Self {
        Self { db, hub }
    }

    /// Returns a reference to the real-time [`PartyBroadcastHub`].
    #[must_use]
    pub const fn hub(&self) -> &PartyBroadcastHub {
        &self.hub
    }

    /// Computes [`PlaylistPermissions`] (`canRead`, `canEditTracks`, `canManage`) for `user` on `playlist_id`.
    pub async fn access(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        include_trash: bool,
    ) -> Result<PlaylistPermissions, CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        self.access_on_conn(&mut conn, playlist_id, user, include_trash)
            .await
    }

    /// Computes [`PlaylistPermissions`] on an existing SQLite connection or transaction.
    pub async fn access_on_conn(
        &self,
        conn: &mut SqliteConnection,
        playlist_id: &str,
        user: &SessionUser,
        include_trash: bool,
    ) -> Result<PlaylistPermissions, CollaborationError> {
        let denied = PlaylistPermissions {
            can_read: false,
            can_edit_tracks: false,
            can_manage: false,
        };

        let user_active = sqlx::query("SELECT 1 FROM users WHERE id = ? AND disabled = 0;")
            .bind(&user.id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
        if !user_active {
            return Ok(denied);
        }

        let row = sqlx::query(
            "SELECT owner_user_id, sharing_mode, deleted_at FROM playlists WHERE id = ?;",
        )
        .bind(playlist_id)
        .fetch_optional(&mut *conn)
        .await?;

        let Some(row) = row else {
            return Ok(denied);
        };

        let owner_user_id: Option<String> = row.try_get("owner_user_id")?;
        let sharing_str: String = row.try_get("sharing_mode")?;
        let sharing_mode = PlaylistVisibility::parse_str(&sharing_str);
        let deleted_at: Option<String> = row.try_get("deleted_at")?;

        let is_manager = user.is_admin() || owner_user_id.as_deref() == Some(user.id.as_str());
        if deleted_at.is_some() {
            return Ok(if include_trash && is_manager {
                PlaylistPermissions {
                    can_read: true,
                    can_edit_tracks: true,
                    can_manage: true,
                }
            } else {
                denied
            });
        }

        if is_manager {
            return Ok(PlaylistPermissions {
                can_read: true,
                can_edit_tracks: true,
                can_manage: true,
            });
        }

        let grant_role: Option<CollaboratorRole> = sqlx::query(
            "SELECT role FROM playlist_permissions WHERE playlist_id = ? AND user_id = ?;",
        )
        .bind(playlist_id)
        .bind(&user.id)
        .fetch_optional(&mut *conn)
        .await?
        .and_then(|r| r.try_get::<String, _>("role").ok())
        .and_then(|s| CollaboratorRole::parse_str(&s));

        let named_mode = matches!(
            sharing_mode,
            PlaylistVisibility::SharedRead | PlaylistVisibility::Collaborative
        );

        Ok(PlaylistPermissions {
            can_read: sharing_mode == PlaylistVisibility::PublicServer
                || (named_mode && grant_role.is_some()),
            can_edit_tracks: sharing_mode == PlaylistVisibility::Collaborative
                && grant_role == Some(CollaboratorRole::Collaborator),
            can_manage: false,
        })
    }

    /// Requires that `user` holds the requested capability on `playlist_id`, returning
    /// `Err(CollaborationError::Forbidden)` otherwise.
    pub async fn require_capability(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        capability: &str,
    ) -> Result<PlaylistPermissions, CollaborationError> {
        let perms = self.access(playlist_id, user, false).await?;
        let allowed = match capability {
            "canRead" => perms.can_read,
            "canEditTracks" => perms.can_edit_tracks,
            "canManage" => perms.can_manage,
            _ => false,
        };
        if !allowed {
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }
        Ok(perms)
    }

    /// Returns the [`SharingSnapshot`] (`mode`, `revision`, `grants`, `links`) for `playlist_id`.
    pub async fn snapshot(
        &self,
        playlist_id: &str,
        user: &SessionUser,
    ) -> Result<SharingSnapshot, CollaborationError> {
        self.require_capability(playlist_id, user, "canManage")
            .await?;

        let row = sqlx::query(
            "SELECT owner_user_id, sharing_mode, sharing_revision FROM playlists WHERE id = ?;",
        )
        .bind(playlist_id)
        .fetch_optional(self.db.inner())
        .await?
        .ok_or_else(|| CollaborationError::NotFound(String::from("Playlist not found.")))?;

        let owner_user_id: Option<String> = row.try_get("owner_user_id")?;
        let mode = PlaylistVisibility::parse_str(&row.try_get::<String, _>("sharing_mode")?);
        let revision: i64 = row.try_get("sharing_revision")?;

        let grant_rows = sqlx::query(
            r"
            SELECT perm.user_id, perm.role, u.username, u.display_name, u.avatar_updated_at, u.disabled
            FROM playlist_permissions perm
            JOIN users u ON u.id = perm.user_id
            WHERE perm.playlist_id = ?
            ORDER BY u.username COLLATE NOCASE ASC;
            ",
        )
        .bind(playlist_id)
        .fetch_all(self.db.inner())
        .await?;

        let mut grants = Vec::with_capacity(grant_rows.len());
        for gr in grant_rows {
            let uid: String = gr.try_get("user_id")?;
            let role_str: String = gr.try_get("role")?;
            let avatar_ts: Option<String> = gr.try_get("avatar_updated_at")?;
            grants.push(HydratedPlaylistGrant {
                avatar_url: avatar_url_for(&uid, avatar_ts.as_deref()),
                user_id: uid,
                role: CollaboratorRole::parse_str(&role_str).unwrap_or(CollaboratorRole::Viewer),
                username: gr.try_get("username")?,
                display_name: gr.try_get("display_name")?,
                disabled: gr.try_get::<i64, _>("disabled").unwrap_or(0) != 0,
            });
        }

        let now_ms = Utc::now().timestamp_millis();
        let link_rows = sqlx::query(
            r"
            SELECT l.id, l.recipient_user_id, u.display_name AS recipient_name, l.expires_at
            FROM playlist_share_links l
            LEFT JOIN users u ON u.id = l.recipient_user_id
            WHERE l.playlist_id = ? AND l.revoked_at IS NULL AND l.expires_at > ?
            ORDER BY l.created_at DESC
            LIMIT 50;
            ",
        )
        .bind(playlist_id)
        .bind(now_ms)
        .fetch_all(self.db.inner())
        .await?;

        let mut links = Vec::with_capacity(link_rows.len());
        for lr in link_rows {
            links.push(ShareLinkSummary {
                id: lr.try_get("id")?,
                recipient_user_id: lr.try_get("recipient_user_id")?,
                recipient_name: lr.try_get("recipient_name")?,
                expires_at: lr.try_get("expires_at")?,
            });
        }

        Ok(SharingSnapshot {
            playlist_id: playlist_id.to_owned(),
            mode,
            revision,
            owner_user_id,
            grants,
            links,
        })
    }

    /// Searches active household user accounts for the sharing invitation picker.
    pub async fn search_household_users(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        query: &str,
    ) -> Result<Vec<HouseholdUserItem>, CollaborationError> {
        self.require_capability(playlist_id, user, "canManage")
            .await?;

        let owner_row = sqlx::query("SELECT owner_user_id FROM playlists WHERE id = ?;")
            .bind(playlist_id)
            .fetch_optional(self.db.inner())
            .await?
            .ok_or_else(|| CollaborationError::NotFound(String::from("Playlist not found.")))?;
        let owner_id: String = owner_row
            .try_get::<Option<String>, _>("owner_user_id")?
            .unwrap_or_default();

        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");

        let rows = sqlx::query(
            r"
            SELECT id, username, display_name, avatar_updated_at
            FROM users
            WHERE disabled = 0
              AND id <> ?
              AND (username LIKE ? ESCAPE '\' OR display_name LIKE ? ESCAPE '\')
            ORDER BY username COLLATE NOCASE ASC
            LIMIT 50;
            ",
        )
        .bind(owner_id)
        .bind(&pattern)
        .bind(&pattern)
        .fetch_all(self.db.inner())
        .await?;

        let mut users = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let avatar_ts: Option<String> = row.try_get("avatar_updated_at")?;
            users.push(HouseholdUserItem {
                avatar_url: avatar_url_for(&id, avatar_ts.as_deref()),
                id,
                username: row.try_get("username")?,
                display_name: row.try_get("display_name")?,
            });
        }
        Ok(users)
    }

    /// Atomically updates the playlist's `sharing_mode` and member `grants` after verifying
    /// `expected_revision`, revoking existing share links and closing active party sessions
    /// if the mode is no longer `COLLABORATIVE`.
    pub async fn update_sharing(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        expected_revision: i64,
        mode: PlaylistVisibility,
        grants: &[PlaylistGrant],
    ) -> Result<SharingSnapshot, CollaborationError> {
        if expected_revision < 0 {
            return Err(CollaborationError::BadRequest(String::from(
                "Invalid sharing settings.",
            )));
        }

        let unique_users: std::collections::HashSet<&str> =
            grants.iter().map(|g| g.user_id.as_str()).collect();
        if grants.len() > 100 || unique_users.len() != grants.len() {
            return Err(CollaborationError::BadRequest(String::from(
                "Choose at most 100 distinct household members.",
            )));
        }

        if (matches!(
            mode,
            PlaylistVisibility::Private | PlaylistVisibility::PublicServer
        ) && !grants.is_empty())
            || (mode == PlaylistVisibility::SharedRead
                && grants.iter().any(|g| g.role != CollaboratorRole::Viewer))
        {
            return Err(CollaborationError::BadRequest(String::from(
                "This sharing mode does not allow the selected roles.",
            )));
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_manage {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let row = sqlx::query(
            "SELECT owner_user_id, sharing_revision FROM playlists WHERE id = ?;",
        )
        .bind(playlist_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| CollaborationError::NotFound(String::from("Playlist not found.")))?;

        let owner_id: Option<String> = row.try_get("owner_user_id")?;
        let current_rev: i64 = row.try_get("sharing_revision")?;
        if current_rev != expected_revision {
            tx.rollback().await?;
            return Err(CollaborationError::Conflict(String::from(
                "Sharing changed elsewhere. Reload before saving.",
            )));
        }

        for grant in grants {
            if owner_id.as_deref() == Some(grant.user_id.as_str()) {
                tx.rollback().await?;
                return Err(CollaborationError::BadRequest(String::from(
                    "A selected account is unavailable or has an invalid role.",
                )));
            }
            let exists = sqlx::query("SELECT 1 FROM users WHERE id = ? AND disabled = 0;")
                .bind(&grant.user_id)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            if !exists {
                tx.rollback().await?;
                return Err(CollaborationError::BadRequest(String::from(
                    "A selected account is unavailable or has an invalid role.",
                )));
            }
        }

        sqlx::query("DELETE FROM playlist_permissions WHERE playlist_id = ?;")
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;

        let now_ms = Utc::now().timestamp_millis();
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        for grant in grants {
            sqlx::query(
                "INSERT INTO playlist_permissions (playlist_id, user_id, role, granted_by_user_id, granted_at) VALUES (?, ?, ?, ?, ?);",
            )
            .bind(playlist_id)
            .bind(&grant.user_id)
            .bind(grant.role.as_str())
            .bind(&user.id)
            .bind(&now_iso)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            r"
            UPDATE playlists
            SET sharing_mode = ?,
                sharing_revision = sharing_revision + 1,
                edit_revision = edit_revision + 1,
                updated_at = ?
            WHERE id = ?;
            ",
        )
        .bind(mode.as_str())
        .bind(&now_iso)
        .bind(playlist_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE playlist_share_links SET revoked_at = ? WHERE playlist_id = ? AND revoked_at IS NULL;",
        )
        .bind(now_ms)
        .bind(playlist_id)
        .execute(&mut *tx)
        .await?;

        if mode != PlaylistVisibility::Collaborative {
            sqlx::query(
                "UPDATE playlist_party_sessions SET closed_at = ? WHERE playlist_id = ? AND closed_at IS NULL;",
            )
            .bind(now_ms)
            .bind(playlist_id)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        drop(conn);
        self.snapshot(playlist_id, user).await
    }

    /// Mints a new 256-bit cryptographic share link (`ShareToken`), storing only its SHA-256
    /// digest in `playlist_share_links`.
    pub async fn create_link(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        recipient_user_id: Option<&str>,
    ) -> Result<ShareToken, CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_manage {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let row = sqlx::query("SELECT sharing_mode FROM playlists WHERE id = ?;")
            .bind(playlist_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| CollaborationError::NotFound(String::from("Playlist not found.")))?;
        let mode = PlaylistVisibility::parse_str(&row.try_get::<String, _>("sharing_mode")?);

        if mode == PlaylistVisibility::Private {
            tx.rollback().await?;
            return Err(CollaborationError::BadRequest(String::from(
                "Share this playlist before creating an invitation link.",
            )));
        }

        if recipient_user_id.is_none() && mode != PlaylistVisibility::PublicServer {
            tx.rollback().await?;
            return Err(CollaborationError::BadRequest(String::from(
                "Choose an existing playlist member for this link.",
            )));
        }

        if let Some(recipient) = recipient_user_id {
            let active_user = sqlx::query("SELECT 1 FROM users WHERE id = ? AND disabled = 0;")
                .bind(recipient)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            if !active_user {
                tx.rollback().await?;
                return Err(CollaborationError::BadRequest(String::from(
                    "Recipient account is unavailable.",
                )));
            }

            if mode != PlaylistVisibility::PublicServer {
                let has_perm = sqlx::query(
                    "SELECT 1 FROM playlist_permissions WHERE playlist_id = ? AND user_id = ?;",
                )
                .bind(playlist_id)
                .bind(recipient)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
                if !has_perm {
                    tx.rollback().await?;
                    return Err(CollaborationError::BadRequest(String::from(
                        "Add this member to the playlist before creating a link.",
                    )));
                }
            }
        }

        let now_ms = Utc::now().timestamp_millis();
        let active_count_row = sqlx::query(
            r"
            SELECT COUNT(*) AS n FROM playlist_share_links
            WHERE playlist_id = ? AND revoked_at IS NULL AND expires_at > ?;
            ",
        )
        .bind(playlist_id)
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await?;
        let active_count: i64 = active_count_row.try_get("n")?;
        if active_count >= MAX_ACTIVE_SHARE_LINKS {
            tx.rollback().await?;
            return Err(CollaborationError::TooManyRequests(String::from(
                "Revoke an existing invitation before creating another.",
            )));
        }

        let token = generate_hex_token_32_bytes();
        let token_hash = sha256_hex(&token);
        let id = create_id("plshare");
        let expires_at = now_ms + SHARE_LINK_TTL_MS;

        sqlx::query(
            r"
            INSERT INTO playlist_share_links
              (id, playlist_id, recipient_user_id, token_hash, created_by_user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(&id)
        .bind(playlist_id)
        .bind(recipient_user_id)
        .bind(&token_hash)
        .bind(&user.id)
        .bind(now_ms)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(ShareToken {
            id,
            token,
            expires_at,
        })
    }

    /// Revokes an invitation link (`DELETE /api/v1/playlists/:playlistId/sharing/links/:linkId`).
    pub async fn revoke_link(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        link_id: &str,
    ) -> Result<(), CollaborationError> {
        self.require_capability(playlist_id, user, "canManage")
            .await?;

        let now_ms = Utc::now().timestamp_millis();
        sqlx::query(
            "UPDATE playlist_share_links SET revoked_at = ? WHERE id = ? AND playlist_id = ? AND revoked_at IS NULL;",
        )
        .bind(now_ms)
        .bind(link_id)
        .bind(playlist_id)
        .execute(self.db.inner())
        .await?;
        Ok(())
    }

    /// Validates a 64-character hex share token and returns the target `playlist_id`
    /// (`POST /api/v1/playlist-shares/resolve`).
    pub async fn resolve_link(
        &self,
        user: &SessionUser,
        token: &str,
    ) -> Result<String, CollaborationError> {
        let trimmed = token.trim();
        if trimmed.len() != 64 || !trimmed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(CollaborationError::NotFound(String::from(
                "Invitation expired or unavailable.",
            )));
        }

        let now_ms = Utc::now().timestamp_millis();
        let token_hash = sha256_hex(trimmed);

        let row = sqlx::query(
            r"
            SELECT playlist_id, recipient_user_id
            FROM playlist_share_links
            WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?;
            ",
        )
        .bind(&token_hash)
        .bind(now_ms)
        .fetch_optional(self.db.inner())
        .await?
        .ok_or_else(|| {
            CollaborationError::Forbidden(String::from(
                "This invitation is unavailable for your account.",
            ))
        })?;

        let playlist_id: String = row.try_get("playlist_id")?;
        let recipient_user_id: Option<String> = row.try_get("recipient_user_id")?;

        if let Some(ref recipient) = recipient_user_id
            && recipient != &user.id
        {
            return Err(CollaborationError::Forbidden(String::from(
                "This invitation is unavailable for your account.",
            )));
        }

        self.require_capability(&playlist_id, user, "canRead")
            .await?;
        Ok(playlist_id)
    }

    /// Opens or renews a live party queue session (`POST /api/v1/playlists/:playlistId/party`).
    pub async fn start_party(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        session_id: &str,
        device_id: &str,
    ) -> Result<(String, i64), CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_manage {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let mode_row = sqlx::query("SELECT sharing_mode FROM playlists WHERE id = ?;")
            .bind(playlist_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| CollaborationError::NotFound(String::from("Playlist not found.")))?;
        let mode = PlaylistVisibility::parse_str(&mode_row.try_get::<String, _>("sharing_mode")?);
        if mode != PlaylistVisibility::Collaborative {
            tx.rollback().await?;
            return Err(CollaborationError::BadRequest(String::from(
                "Choose collaborative sharing before opening a party queue.",
            )));
        }

        let now_ms = Utc::now().timestamp_millis();
        if let Some(current) = self.active_party_on_conn(&mut tx, playlist_id, now_ms).await? {
            if current.host_user_id != user.id
                || current.host_session_id != session_id
                || current.host_device_id != device_id
            {
                tx.rollback().await?;
                return Err(CollaborationError::Forbidden(String::from(
                    "Only the hosting player can manage this party queue.",
                )));
            }
            let expires_at = now_ms + PARTY_LEASE_MS;
            sqlx::query("UPDATE playlist_party_sessions SET expires_at = ? WHERE id = ?;")
                .bind(expires_at)
                .bind(&current.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok((current.id, expires_at));
        }

        let id = create_id("party");
        let expires_at = now_ms + PARTY_LEASE_MS;
        sqlx::query(
            r"
            INSERT INTO playlist_party_sessions
              (id, playlist_id, host_user_id, host_session_id, host_device_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(&id)
        .bind(playlist_id)
        .bind(&user.id)
        .bind(session_id)
        .bind(device_id)
        .bind(now_ms)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok((id, expires_at))
    }

    /// Queries the current [`PartySessionState`] and pending track requests for `playlist_id`.
    pub async fn party_state(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        session_id: &str,
        device_id: &str,
    ) -> Result<PartySessionState, CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_edit_tracks {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let now_ms = Utc::now().timestamp_millis();
        let Some(party) = self.active_party_on_conn(&mut tx, playlist_id, now_ms).await? else {
            tx.commit().await?;
            return Ok(PartySessionState {
                party: None,
                requests: Vec::new(),
            });
        };

        // Dismiss pending requests from users who are no longer active collaborators
        let owner_row = sqlx::query("SELECT owner_user_id FROM playlists WHERE id = ?;")
            .bind(playlist_id)
            .fetch_one(&mut *tx)
            .await?;
        let owner_id: Option<String> = owner_row.try_get("owner_user_id")?;

        sqlx::query(
            r"
            UPDATE playlist_party_requests
            SET state = 'DISMISSED'
            WHERE party_id = ?
              AND state = 'PENDING'
              AND NOT EXISTS (
                SELECT 1 FROM users u
                WHERE u.id = playlist_party_requests.requested_by_user_id
                  AND u.disabled = 0
                  AND (
                    u.role = 'admin'
                    OR u.id = ?
                    OR EXISTS (
                      SELECT 1 FROM playlist_permissions perm
                      WHERE perm.playlist_id = ? AND perm.user_id = u.id AND perm.role = 'COLLABORATOR'
                    )
                  )
              );
            ",
        )
        .bind(&party.id)
        .bind(&owner_id)
        .bind(playlist_id)
        .execute(&mut *tx)
        .await?;

        let is_host = party.host_user_id == user.id
            && party.host_session_id == session_id
            && party.host_device_id == device_id;

        let req_rows = sqlx::query(
            r"
            SELECT r.id, r.track_id, r.requested_by_user_id, r.created_at, u.display_name AS requested_by
            FROM playlist_party_requests r
            LEFT JOIN users u ON u.id = r.requested_by_user_id
            WHERE r.party_id = ?
              AND r.state = 'PENDING'
              AND (r.requested_by_user_id = ? OR ? = 1)
            ORDER BY r.created_at ASC, r.rowid ASC
            LIMIT 200;
            ",
        )
        .bind(&party.id)
        .bind(&user.id)
        .bind(i64::from(is_host))
        .fetch_all(&mut *tx)
        .await?;

        let mut requests = Vec::with_capacity(req_rows.len());
        for rr in req_rows {
            requests.push(PartyTrackRequestItem {
                id: rr.try_get("id")?,
                track_id: rr.try_get("track_id")?,
                requested_by_user_id: rr.try_get("requested_by_user_id")?,
                requested_by: rr.try_get("requested_by")?,
                created_at: rr.try_get("created_at")?,
                track: None,
            });
        }

        tx.commit().await?;
        Ok(PartySessionState {
            party: Some(PartySessionInfo {
                id: party.id,
                is_host,
                expires_at: party.expires_at,
            }),
            requests,
        })
    }

    /// Submits an idempotent party track request (`POST /api/v1/playlists/:playlistId/party/requests`)
    /// and broadcasts [`PartyWsServerFrame::QueueAdded`] over [`PartyBroadcastHub`].
    pub async fn request_track(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        track_id: &str,
        idempotency_key: &str,
    ) -> Result<(String, String, String), CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_edit_tracks {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let now_ms = Utc::now().timestamp_millis();
        let Some(party) = self.active_party_on_conn(&mut tx, playlist_id, now_ms).await? else {
            tx.rollback().await?;
            return Err(CollaborationError::Conflict(String::from(
                "The host's party queue is offline. Ask them to reopen it.",
            )));
        };

        let existing = sqlx::query(
            r"
            SELECT id, track_id, state
            FROM playlist_party_requests
            WHERE party_id = ? AND requested_by_user_id = ? AND idempotency_key = ?;
            ",
        )
        .bind(&party.id)
        .bind(&user.id)
        .bind(idempotency_key)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(prev) = existing {
            let prev_id: String = prev.try_get("id")?;
            let prev_track: String = prev.try_get("track_id")?;
            let prev_state: String = prev.try_get("state")?;
            if prev_track != track_id {
                tx.rollback().await?;
                return Err(CollaborationError::Conflict(String::from(
                    "Request key already belongs to another track.",
                )));
            }
            tx.commit().await?;
            return Ok((prev_id, prev_track, prev_state));
        }

        let track_exists = sqlx::query(
            "SELECT 1 FROM library_items WHERE id = ? AND type = 'track';",
        )
        .bind(track_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
        if !track_exists {
            tx.rollback().await?;
            return Err(CollaborationError::BadRequest(String::from(
                "Choose a library track for this party queue.",
            )));
        }

        let count_row = sqlx::query(
            r"
            SELECT
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN requested_by_user_id = ? THEN 1 ELSE 0 END), 0) AS own
            FROM playlist_party_requests
            WHERE party_id = ? AND state = 'PENDING';
            ",
        )
        .bind(&user.id)
        .bind(&party.id)
        .fetch_one(&mut *tx)
        .await?;

        let total_pending: i64 = count_row.try_get("total")?;
        let own_pending: i64 = count_row.try_get("own")?;
        if total_pending >= MAX_PARTY_PENDING_TOTAL || own_pending >= MAX_PARTY_PENDING_PER_USER {
            tx.rollback().await?;
            return Err(CollaborationError::TooManyRequests(String::from(
                "The party request queue is full. Wait for the host to review requests.",
            )));
        }

        let req_id = create_id("partyreq");
        sqlx::query(
            r"
            INSERT INTO playlist_party_requests
              (id, party_id, track_id, requested_by_user_id, idempotency_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(&req_id)
        .bind(&party.id)
        .bind(track_id)
        .bind(&user.id)
        .bind(idempotency_key)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        self.hub.publish(
            playlist_id,
            PartyWsServerFrame::QueueAdded {
                playlist_id: playlist_id.to_owned(),
                request_id: req_id.clone(),
                track_id: track_id.to_owned(),
                requested_by_user_id: user.id.clone(),
            },
        );

        Ok((req_id, track_id.to_owned(), String::from("PENDING")))
    }

    /// Executes a host party control action (`heartbeat`, `close`, `QUEUED`, or `DISMISSED`).
    pub async fn host_action(
        &self,
        playlist_id: &str,
        user: &SessionUser,
        session_id: &str,
        device_id: &str,
        action: PartyHostAction,
        request_id: Option<&str>,
    ) -> Result<(), CollaborationError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let perms = self
            .access_on_conn(&mut tx, playlist_id, user, false)
            .await?;
        if !perms.can_manage {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "You do not have permission for this playlist action.",
            )));
        }

        let now_ms = Utc::now().timestamp_millis();
        let Some(party) = self.active_party_on_conn(&mut tx, playlist_id, now_ms).await? else {
            tx.rollback().await?;
            return Err(CollaborationError::Conflict(String::from(
                "Party queue expired. Open it again on the hosting player.",
            )));
        };

        if party.host_user_id != user.id
            || party.host_session_id != session_id
            || party.host_device_id != device_id
        {
            tx.rollback().await?;
            return Err(CollaborationError::Forbidden(String::from(
                "Only the hosting player can manage this party queue.",
            )));
        }

        let action_label = match action {
            PartyHostAction::Heartbeat => {
                sqlx::query("UPDATE playlist_party_sessions SET expires_at = ? WHERE id = ?;")
                    .bind(now_ms + PARTY_LEASE_MS)
                    .bind(&party.id)
                    .execute(&mut *tx)
                    .await?;
                "heartbeat"
            }
            PartyHostAction::Close => {
                sqlx::query("UPDATE playlist_party_sessions SET closed_at = ? WHERE id = ?;")
                    .bind(now_ms)
                    .bind(&party.id)
                    .execute(&mut *tx)
                    .await?;
                "close"
            }
            PartyHostAction::Queued | PartyHostAction::Dismissed => {
                let target_state = if action == PartyHostAction::Queued {
                    "QUEUED"
                } else {
                    "DISMISSED"
                };
                let rid = request_id.unwrap_or_default();
                let req_row = sqlx::query(
                    "SELECT state FROM playlist_party_requests WHERE id = ? AND party_id = ?;",
                )
                .bind(rid)
                .bind(&party.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| {
                    CollaborationError::NotFound(String::from("Party request not found."))
                })?;

                let current_state: String = req_row.try_get("state")?;
                if current_state != "PENDING" && current_state != target_state {
                    tx.rollback().await?;
                    return Err(CollaborationError::Conflict(String::from(
                        "This request was already reviewed.",
                    )));
                }

                sqlx::query(
                    "UPDATE playlist_party_requests SET state = ? WHERE id = ? AND party_id = ?;",
                )
                .bind(target_state)
                .bind(rid)
                .bind(&party.id)
                .execute(&mut *tx)
                .await?;
                target_state
            }
        };

        tx.commit().await?;

        self.hub.publish(
            playlist_id,
            PartyWsServerFrame::PartyUpdated {
                playlist_id: playlist_id.to_owned(),
                action: String::from(action_label),
                request_id: request_id.map(str::to_owned),
            },
        );
        Ok(())
    }

    /// Prunes expired or closed party sessions, reviewed party requests, and expired share links
    /// older than 7 days.
    pub async fn prune(&self) -> Result<(), CollaborationError> {
        let before_ms = Utc::now().timestamp_millis() - SHARE_LINK_TTL_MS;
        sqlx::query(
            "DELETE FROM playlist_party_requests WHERE state <> 'PENDING' AND created_at < ?;",
        )
        .bind(before_ms)
        .execute(self.db.inner())
        .await?;
        sqlx::query(
            "DELETE FROM playlist_party_sessions WHERE COALESCE(closed_at, expires_at) < ?;",
        )
        .bind(before_ms)
        .execute(self.db.inner())
        .await?;
        sqlx::query(
            "DELETE FROM playlist_share_links WHERE COALESCE(revoked_at, expires_at) < ?;",
        )
        .bind(before_ms)
        .execute(self.db.inner())
        .await?;
        Ok(())
    }

    async fn active_party_on_conn(
        &self,
        conn: &mut SqliteConnection,
        playlist_id: &str,
        now_ms: i64,
    ) -> Result<Option<RawPartyRow>, CollaborationError> {
        let row = sqlx::query(
            "SELECT * FROM playlist_party_sessions WHERE playlist_id = ? AND closed_at IS NULL;",
        )
        .bind(playlist_id)
        .fetch_optional(&mut *conn)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let party = RawPartyRow {
            id: row.try_get("id")?,
            host_user_id: row.try_get("host_user_id")?,
            host_session_id: row.try_get("host_session_id")?,
            host_device_id: row.try_get("host_device_id")?,
            expires_at: row.try_get("expires_at")?,
        };

        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let host_valid = sqlx::query(
            r"
            SELECT 1
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            JOIN playlists p ON p.id = ?
            WHERE s.id = ?
              AND s.user_id = ?
              AND s.expires_at > ?
              AND u.disabled = 0
              AND p.deleted_at IS NULL
              AND p.sharing_mode = 'COLLABORATIVE'
              AND (u.role = 'admin' OR p.owner_user_id = u.id);
            ",
        )
        .bind(playlist_id)
        .bind(&party.host_session_id)
        .bind(&party.host_user_id)
        .bind(&now_iso)
        .fetch_optional(&mut *conn)
        .await?
        .is_some();

        if party.expires_at <= now_ms || !host_valid {
            sqlx::query("UPDATE playlist_party_sessions SET closed_at = ? WHERE id = ?;")
                .bind(now_ms)
                .bind(&party.id)
                .execute(&mut *conn)
                .await?;
            return Ok(None);
        }

        Ok(Some(party))
    }
}

#[derive(Debug, Clone)]
struct RawPartyRow {
    id: String,
    host_user_id: String,
    host_session_id: String,
    host_device_id: String,
    expires_at: i64,
}

fn generate_hex_token_32_bytes() -> String {
    let mut random_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut random_bytes);
    let mut hex = String::with_capacity(64);
    for b in random_bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}
