//! # Durable Queue Synchronization, Gzip Compression & 128 MiB Memory Budget (`queue`)
//!
//! Complete Rust port of `server/src/services/QueueSyncService.ts`.
//!
//! ## Core Architectural Invariants
//! 1. **Content-Addressed Gzip Blob Storage (`queue_contents`)**:
//!    - Queue track lists (`QueueContent` v2) are serialized to canonical UTF-8 JSON,
//!      bounded at [`MAX_QUEUE_CONTENT_BYTES`] (`32 MiB`), hashed with SHA-256 to derive
//!      a 64-character hex `content_id`, and compressed with `flate2::write::GzEncoder`
//!      (`Compression::fast()` level 1).
//!    - On read (`get_content`), decompression is bounded via `Read::take(MAX_QUEUE_CONTENT_BYTES + 1)`
//!      to prevent gzip decompression bombs, and verified against `raw_bytes`, `content_id`
//!      (SHA-256), and `track_count` (`409 QUEUE_SYNC_ERROR` on mismatch).
//! 2. **128 MiB Account Budget & Upload Concurrency Semaphore**:
//!    - Each user account has a strict [`MAX_ACCOUNT_STORAGE_BUDGET_BYTES`] (`128 MiB`)
//!      ceiling across `SUM(length(compressed))` in `queue_contents` (`413 Payload Too Large`).
//!    - Concurrent queue content uploads are gated by an in-memory `tokio::sync::Semaphore`
//!      (`MAX_CONCURRENT_UPLOADS = 2`) so simultaneous multi-megabyte compressions cannot
//!      exhaust server RAM.
//! 3. **Sequence & Clock Vector Conflict Resolution (`save_session`)**:
//!    - Rejects device clocks ahead of the server by more than 5 minutes (`CLOCK_SKEW_TOLERANCE_MS`).
//!    - Enforces strict monotonicity on both `sequence` (`sequence > old.sequence`) and
//!      `checkpoint.captured_at` (`captured_at >= old.captured_at`), returning
//!      `{ saved: false, sequence: old.sequence }` on stale or out-of-order writes.
//!    - Caps active synced devices at `12` per user and named queues at `50` per user.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::Arc;

use chrono::Utc;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};
use thiserror::Error;
use tokio::sync::Semaphore;
use url::Url;

use crate::catalog::LibraryService;
use crate::db::{DbError, DbPool, create_id};
use crate::playlists::smart::MixOrder;

/// Maximum uncompressed JSON payload size (`32 MiB`) for a single queue content snapshot.
pub const MAX_QUEUE_CONTENT_BYTES: usize = 32 * 1024 * 1024;

/// Maximum total compressed storage budget (`128 MiB`) per user account in `queue_contents`.
pub const MAX_ACCOUNT_STORAGE_BUDGET_BYTES: i64 = 128 * 1024 * 1024;

/// Maximum concurrent queue content compression uploads across the process (`2`).
pub const MAX_CONCURRENT_UPLOADS: usize = 2;

/// Maximum synced device sessions retained per user (`12`).
pub const MAX_DEVICES_PER_USER: i64 = 12;

/// Maximum named queues retained per user (`50`).
pub const MAX_NAMED_QUEUES_PER_USER: i64 = 50;

/// Maximum clock skew in the future (`5` minutes in milliseconds) permitted on `captured_at`.
pub const CLOCK_SKEW_TOLERANCE_MS: i64 = 5 * 60_000;

/// One day in milliseconds (`86,400,000` ms).
pub const DAY_MS: i64 = 86_400_000;

/// Monotonic sequence and wall-clock vector used to order multi-device queue checkpoints (`ClockVector`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockVector {
    /// Monotonically increasing per-device sequence number.
    pub sequence: u64,
    /// Client capture timestamp in epoch milliseconds.
    pub captured_at: i64,
}

/// Queue entry inside a [`QueueContent`] v2 snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEntry {
    /// Unique occurrence identifier within the queue (`1..=160` chars).
    pub entry_id: String,
    /// Track payload object (`id`, `title`, `artist`, `album`, `previewUrl`, etc.).
    pub track: Value,
}

/// Version 2 queue content payload (`QueueState` / `QueueContent` in `QueueSyncService.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueContent {
    /// Schema version literal (must be `2`).
    pub version: u8,
    /// Ordered list of queue entries with unique `entry_id`s.
    pub entries: Vec<QueueEntry>,
}

/// Alias matching the prompt's `QueueState` struct name.
pub type QueueState = QueueContent;

/// Playback context descriptor inside a [`QueueCheckpoint`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueContextInfo {
    /// Context kind (`"album"`, `"playlist"`, `"artist"`, etc.).
    #[serde(rename = "type")]
    pub context_type: String,
    /// Context entity ID.
    pub id: String,
    /// Context display name.
    pub name: String,
    /// Optional cover artwork URL/ID.
    pub cover_art: Option<String>,
}

/// Shuffle mode in a [`QueueCheckpoint`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueShuffleMode {
    /// Standard Fisher-Yates shuffle.
    Standard,
    /// Smart artist-spread shuffle.
    Smart,
}

/// Playback position and transport mode checkpoint (`queueCheckpointSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueCheckpoint {
    /// Active queue entry index (`-1` when queue is empty, `0..track_count` otherwise).
    pub index: i64,
    /// Playback position in seconds (`0.0..=604800.0`).
    pub position: f64,
    /// Whether single-track repeat is enabled.
    pub repeat_one: bool,
    /// Whether shuffle is enabled.
    pub shuffle: bool,
    /// Optional 32-bit shuffle PRNG seed (`0..=0xFFFF_FFFF`).
    pub shuffle_seed: Option<u64>,
    /// Shuffle mode (`standard` or `smart`).
    pub shuffle_mode: QueueShuffleMode,
    /// Whether album-aware playback grouping is enabled.
    pub album_aware: bool,
    /// Player volume in `[0.0, 1.0]`.
    pub volume: f64,
    /// Whether audio was actively playing when captured.
    pub was_playing: bool,
    /// Optional playback source context.
    pub context: Option<QueueContextInfo>,
    /// Client capture timestamp in epoch milliseconds (`>= 0`).
    pub captured_at: i64,
}

/// Combined device session synchronization payload (`SyncPayload`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncPayload {
    /// Account owner ID (`ownerId`).
    pub owner_id: String,
    /// Client device identifier (`1..=300` chars).
    pub device_id: String,
    /// Human-readable device name (`1..=200` trimmed chars).
    pub device_name: String,
    /// SHA-256 content address (`64` hex chars).
    pub content_id: String,
    /// Playback checkpoint.
    pub checkpoint: QueueCheckpoint,
    /// Monotonic client sequence number.
    pub sequence: u64,
}

/// Stored device queue session returned by `GET /api/v1/user/queue-session`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceQueueSession {
    /// Device ID.
    pub device_id: String,
    /// Device display name.
    pub device_name: String,
    /// Referenced `queue_contents.content_id`.
    pub content_id: String,
    /// Deserialized playback checkpoint.
    pub checkpoint: QueueCheckpoint,
    /// Current monotonic sequence number.
    pub sequence: u64,
    /// Last update timestamp (epoch ms).
    pub updated_at: i64,
    /// Number of tracks in the referenced queue content.
    pub track_count: usize,
}

/// Stored named queue snapshot returned by `GET /api/v1/user/queue-session`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedQueueRecord {
    /// Named queue ID (`queue_<nanoid>`).
    pub id: String,
    /// User-supplied queue name.
    pub name: String,
    /// Referenced `queue_contents.content_id`.
    pub content_id: String,
    /// Deserialized playback checkpoint.
    pub checkpoint: QueueCheckpoint,
    /// Optimistic concurrency revision.
    pub revision: u64,
    /// Creation timestamp (epoch ms).
    pub created_at: i64,
    /// Last update timestamp (epoch ms).
    pub updated_at: i64,
    /// Number of tracks in the referenced queue content.
    pub track_count: usize,
}

/// Error taxonomy matching `QueueSyncError` (`QUEUE_SYNC_ERROR`) in `QueueSyncService.ts`.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct QueueSyncError {
    /// Human-readable error message.
    pub message: String,
    /// HTTP status code (`400`, `404`, `409`, `410`, `413`, or `429`).
    pub status_code: u16,
}

impl QueueSyncError {
    /// Constructs a new [`QueueSyncError`].
    #[must_use]
    pub fn new(message: impl Into<String>, status_code: u16) -> Self {
        Self {
            message: message.into(),
            status_code,
        }
    }
}

impl From<sqlx::Error> for QueueSyncError {
    fn from(err: sqlx::Error) -> Self {
        Self::new(format!("Queue database error: {err}"), 500)
    }
}

impl From<DbError> for QueueSyncError {
    fn from(err: DbError) -> Self {
        Self::new(err.to_string(), 500)
    }
}

/// Service managing content-addressed gzipped queue blobs, 128 MiB per-user storage budgets,
/// multi-device session checkpoints, and named queues.
#[derive(Debug, Clone)]
pub struct QueueSyncService {
    db: DbPool,
    library: LibraryService,
    upload_semaphore: Arc<Semaphore>,
}

impl QueueSyncService {
    /// Creates a new [`QueueSyncService`].
    #[must_use]
    pub fn new(db: DbPool, library: LibraryService) -> Self {
        Self {
            db,
            library,
            upload_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS)),
        }
    }

    /// Acquires a bounded upload concurrency slot (`MAX_CONCURRENT_UPLOADS = 2`),
    /// returning `Err(QueueSyncError(429))` immediately if 2 uploads are already in flight.
    pub fn try_acquire_upload_slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit, QueueSyncError> {
        Arc::clone(&self.upload_semaphore)
            .try_acquire_owned()
            .map_err(|_| {
                QueueSyncError::new(
                    "Queue sync is busy. The local queue is safe; retry shortly.",
                    429,
                )
            })
    }

    /// Validates, hashes, gzip-compresses (level 1), and persists a [`QueueContent`] v2 blob
    /// while enforcing the 32 MiB payload cap and 128 MiB per-user storage budget.
    pub async fn store_content(
        &self,
        user_id: &str,
        raw_input: &Value,
        now_ms: i64,
    ) -> Result<(String, usize), QueueSyncError> {
        let content = validate_queue_content(raw_input)?;
        let serialized = serde_json::to_string(&content).map_err(|_| {
            QueueSyncError::new(
                "The queue contains invalid tracks or duplicate occurrence IDs.",
                400,
            )
        })?;

        let raw_bytes = serialized.len();
        if raw_bytes > MAX_QUEUE_CONTENT_BYTES {
            return Err(QueueSyncError::new(
                "This queue exceeds the server's 32 MiB sync limit. The local queue remains intact.",
                413,
            ));
        }

        let content_id = sha256_hex(serialized.as_bytes());
        let track_count = content.entries.len();

        let already_stored = sqlx::query(
            "SELECT 1 FROM queue_contents WHERE user_id = ? AND content_id = ?;",
        )
        .bind(user_id)
        .bind(&content_id)
        .fetch_optional(self.db.inner())
        .await?
        .is_some();

        if already_stored {
            return Ok((content_id, track_count));
        }

        let serialized_bytes = serialized.into_bytes();
        let compressed = tokio::task::spawn_blocking(move || compress_gzip_level1(&serialized_bytes))
            .await
            .map_err(|_| QueueSyncError::new("Queue compression task failed.", 500))??;

        let compressed_len = i64::try_from(compressed.len()).unwrap_or(i64::MAX);

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let budget_row = sqlx::query(
            "SELECT COALESCE(SUM(length(compressed)), 0) AS used FROM queue_contents WHERE user_id = ?;",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
        let current_used: i64 = budget_row.try_get("used")?;

        if current_used.saturating_add(compressed_len) > MAX_ACCOUNT_STORAGE_BUDGET_BYTES {
            tx.rollback().await?;
            return Err(QueueSyncError::new(
                "Your synced queues use the account's 128 MiB storage budget. Remove old named queues and retry later.",
                413,
            ));
        }

        sqlx::query(
            r"
            INSERT OR IGNORE INTO queue_contents
              (user_id, content_id, compressed, raw_bytes, track_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(user_id)
        .bind(&content_id)
        .bind(&compressed)
        .bind(i64::try_from(raw_bytes).unwrap_or(0))
        .bind(i64::try_from(track_count).unwrap_or(0))
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok((content_id, track_count))
    }

    /// Loads, decompresses, and integrity-checks a stored [`QueueContent`] v2 blob.
    pub async fn get_content(
        &self,
        user_id: &str,
        content_id: &str,
    ) -> Result<QueueContent, QueueSyncError> {
        let row = sqlx::query(
            r"
            SELECT compressed, raw_bytes, track_count
            FROM queue_contents
            WHERE user_id = ? AND content_id = ?;
            ",
        )
        .bind(user_id)
        .bind(content_id)
        .fetch_optional(self.db.inner())
        .await?
        .ok_or_else(|| {
            QueueSyncError::new(
                "The saved queue is unavailable for this account. Sync this device again.",
                404,
            )
        })?;

        let compressed: Vec<u8> = row.try_get("compressed")?;
        let raw_bytes = usize::try_from(row.try_get::<i64, _>("raw_bytes")?.max(0)).unwrap_or(0);
        let track_count =
            usize::try_from(row.try_get::<i64, _>("track_count")?.max(0)).unwrap_or(0);
        let expected_hash = content_id.to_owned();

        tokio::task::spawn_blocking(move || {
            decompress_and_verify(&compressed, raw_bytes, &expected_hash, track_count)
        })
        .await
        .map_err(|_| QueueSyncError::new("Queue decompression worker failed.", 500))?
    }

    /// Saves a device queue session checkpoint (`PUT /api/v1/user/queue-session`),
    /// enforcing sequence and `captured_at` monotonicity, clock-skew bounds, and the
    /// 12-device-per-user limit.
    pub async fn save_session_at(
        &self,
        user_id: &str,
        device_id: &str,
        device_name: &str,
        content_id: &str,
        checkpoint: &QueueCheckpoint,
        sequence: u64,
        now_ms: i64,
    ) -> Result<(bool, u64), QueueSyncError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        self.validate_checkpoint_on_conn(&mut tx, user_id, content_id, checkpoint, now_ms)
            .await?;

        let existing = sqlx::query(
            "SELECT sequence, checkpoint_json FROM queue_sessions WHERE user_id = ? AND device_id = ?;",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(ref old_row) = existing {
            let old_seq_i64: i64 = old_row.try_get("sequence")?;
            let old_seq = u64::try_from(old_seq_i64.max(0)).unwrap_or(0);
            let old_cp_json: String = old_row.try_get("checkpoint_json")?;
            let old_captured_at = serde_json::from_str::<QueueCheckpoint>(&old_cp_json)
                .map_or(0, |cp| cp.captured_at);

            if old_seq >= sequence || old_captured_at > checkpoint.captured_at {
                tx.commit().await?;
                return Ok((false, old_seq));
            }
        } else {
            let count_row =
                sqlx::query("SELECT COUNT(*) AS n FROM queue_sessions WHERE user_id = ?;")
                    .bind(user_id)
                    .fetch_one(&mut *tx)
                    .await?;
            let device_count: i64 = count_row.try_get("n")?;
            if device_count >= MAX_DEVICES_PER_USER {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    "This account already has 12 recent queue devices. Remove an old device queue before syncing another.",
                    429,
                ));
            }
        }

        let cp_json = serde_json::to_string(checkpoint).unwrap_or_default();
        sqlx::query(
            r"
            INSERT INTO queue_sessions
              (user_id, device_id, device_name, content_id, checkpoint_json, sequence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, device_id) DO UPDATE SET
              device_name = excluded.device_name,
              content_id = excluded.content_id,
              checkpoint_json = excluded.checkpoint_json,
              sequence = excluded.sequence,
              updated_at = excluded.updated_at;
            ",
        )
        .bind(user_id)
        .bind(device_id)
        .bind(device_name.trim())
        .bind(content_id)
        .bind(&cp_json)
        .bind(i64::try_from(sequence).unwrap_or(i64::MAX))
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok((true, sequence))
    }

    /// Lists all active device queue sessions for `user_id` ordered by `updated_at DESC`.
    pub async fn list_sessions(
        &self,
        user_id: &str,
    ) -> Result<Vec<DeviceQueueSession>, QueueSyncError> {
        let rows = sqlx::query(
            r"
            SELECT s.device_id, s.device_name, s.content_id, s.checkpoint_json, s.sequence,
                   s.updated_at, c.track_count
            FROM queue_sessions s
            JOIN queue_contents c ON c.user_id = s.user_id AND c.content_id = s.content_id
            WHERE s.user_id = ?
            ORDER BY s.updated_at DESC, s.device_id ASC;
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await?;

        let mut sessions = Vec::with_capacity(rows.len());
        for row in rows {
            let cp_json: String = row.try_get("checkpoint_json")?;
            let checkpoint: QueueCheckpoint = serde_json::from_str(&cp_json)
                .map_err(|_| QueueSyncError::new("Stored queue checkpoint is invalid.", 500))?;
            let seq_i64: i64 = row.try_get("sequence")?;
            let tc_i64: i64 = row.try_get("track_count")?;

            sessions.push(DeviceQueueSession {
                device_id: row.try_get("device_id")?,
                device_name: row.try_get("device_name")?,
                content_id: row.try_get("content_id")?,
                checkpoint,
                sequence: u64::try_from(seq_i64.max(0)).unwrap_or(0),
                updated_at: row.try_get("updated_at")?,
                track_count: usize::try_from(tc_i64.max(0)).unwrap_or(0),
            });
        }
        Ok(sessions)
    }

    /// Removes a synced device queue session (`DELETE /api/v1/user/queue-session`).
    pub async fn remove_session(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<(), QueueSyncError> {
        sqlx::query("DELETE FROM queue_sessions WHERE user_id = ? AND device_id = ?;")
            .bind(user_id)
            .bind(device_id)
            .execute(self.db.inner())
            .await?;
        Ok(())
    }

    /// Lists all named queues for `user_id` ordered by `updated_at DESC`.
    pub async fn list_named(&self, user_id: &str) -> Result<Vec<NamedQueueRecord>, QueueSyncError> {
        let rows = sqlx::query(
            r"
            SELECT n.id, n.name, n.content_id, n.checkpoint_json, n.revision,
                   n.created_at, n.updated_at, c.track_count
            FROM named_queues n
            JOIN queue_contents c ON c.user_id = n.user_id AND c.content_id = n.content_id
            WHERE n.user_id = ?
            ORDER BY n.updated_at DESC, n.id ASC;
            ",
        )
        .bind(user_id)
        .fetch_all(self.db.inner())
        .await?;

        let mut named = Vec::with_capacity(rows.len());
        for row in rows {
            let cp_json: String = row.try_get("checkpoint_json")?;
            let checkpoint: QueueCheckpoint = serde_json::from_str(&cp_json)
                .map_err(|_| QueueSyncError::new("Stored queue checkpoint is invalid.", 500))?;
            let rev_i64: i64 = row.try_get("revision")?;
            let tc_i64: i64 = row.try_get("track_count")?;

            named.push(NamedQueueRecord {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                content_id: row.try_get("content_id")?,
                checkpoint,
                revision: u64::try_from(rev_i64.max(0)).unwrap_or(0),
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
                track_count: usize::try_from(tc_i64.max(0)).unwrap_or(0),
            });
        }
        Ok(named)
    }

    /// Saves a named queue (`POST /api/v1/user/queue-session/named`) with idempotency
    /// on `(user_id, operation_id)` and a 50-queue cap per user.
    pub async fn save_named_at(
        &self,
        user_id: &str,
        name: &str,
        content_id: &str,
        checkpoint: &QueueCheckpoint,
        operation_id: &str,
        now_ms: i64,
    ) -> Result<String, QueueSyncError> {
        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        self.validate_checkpoint_on_conn(&mut tx, user_id, content_id, checkpoint, now_ms)
            .await?;

        let existing = sqlx::query(
            "SELECT id, name, content_id FROM named_queues WHERE user_id = ? AND operation_id = ?;",
        )
        .bind(user_id)
        .bind(operation_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(prev) = existing {
            let prev_id: String = prev.try_get("id")?;
            let prev_name: String = prev.try_get("name")?;
            let prev_cid: String = prev.try_get("content_id")?;
            if prev_cid != content_id || prev_name != name.trim() {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    "Save request already belongs to another named queue.",
                    409,
                ));
            }
            tx.commit().await?;
            return Ok(prev_id);
        }

        let count_row =
            sqlx::query("SELECT COUNT(*) AS n FROM named_queues WHERE user_id = ?;")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
        let count: i64 = count_row.try_get("n")?;
        if count >= MAX_NAMED_QUEUES_PER_USER {
            tx.rollback().await?;
            return Err(QueueSyncError::new(
                "You can keep up to 50 named queues. Remove an older one before saving another.",
                429,
            ));
        }

        let id = create_id("queue");
        let cp_json = serde_json::to_string(checkpoint).unwrap_or_default();
        sqlx::query(
            r"
            INSERT INTO named_queues
              (id, user_id, name, content_id, checkpoint_json, operation_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            ",
        )
        .bind(&id)
        .bind(user_id)
        .bind(name.trim())
        .bind(content_id)
        .bind(&cp_json)
        .bind(operation_id)
        .bind(now_ms)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(id)
    }

    /// Deletes a named queue after verifying `revision` (`DELETE /api/v1/user/queue-session/named/:queueId`).
    pub async fn remove_named(
        &self,
        user_id: &str,
        queue_id: &str,
        revision: u64,
    ) -> Result<(), QueueSyncError> {
        let res = sqlx::query(
            "DELETE FROM named_queues WHERE user_id = ? AND id = ? AND revision = ?;",
        )
        .bind(user_id)
        .bind(queue_id)
        .bind(i64::try_from(revision).unwrap_or(0))
        .execute(self.db.inner())
        .await?;

        if res.rows_affected() == 0 {
            return Err(QueueSyncError::new(
                "The named queue changed or was removed. Refresh the list.",
                409,
            ));
        }
        Ok(())
    }

    /// Converts a saved queue content blob into a persistent MusicDeck playlist
    /// (`POST /api/v1/user/queue-session/playlist`) with idempotency via `queue_playlist_saves`.
    pub async fn save_as_playlist(
        &self,
        user_id: &str,
        name: &str,
        content_id: &str,
        operation_id: &str,
    ) -> Result<String, QueueSyncError> {
        let content = self.get_content(user_id, content_id).await?;
        if content.entries.is_empty() {
            return Err(QueueSyncError::new(
                "Add tracks to the queue before saving it as a playlist.",
                400,
            ));
        }
        if content.entries.len() > 20_000 {
            return Err(QueueSyncError::new(
                "Static playlists support 20,000 tracks. Save this queue as a named queue to preserve every entry.",
                413,
            ));
        }

        let mut conn = self.db.inner().acquire().await?;
        let mut tx = conn.begin().await?;

        let prev_row = sqlx::query(
            "SELECT playlist_id, content_id, name FROM queue_playlist_saves WHERE user_id = ? AND operation_id = ?;",
        )
        .bind(user_id)
        .bind(operation_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(prev) = prev_row {
            let prev_pl_id: Option<String> = prev.try_get("playlist_id")?;
            let prev_cid: String = prev.try_get("content_id")?;
            let prev_name: String = prev.try_get("name")?;
            if prev_cid != content_id || prev_name != name.trim() {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    "Save request already belongs to another playlist.",
                    409,
                ));
            }
            let Some(pl_id) = prev_pl_id else {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    "The previously saved playlist was deleted. Restore it from Trash or start a new save.",
                    410,
                ));
            };
            let alive = sqlx::query(
                "SELECT 1 FROM playlists WHERE id = ? AND deleted_at IS NULL;",
            )
            .bind(&pl_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            if !alive {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    "The previously saved playlist was deleted. Restore it from Trash or start a new save.",
                    410,
                ));
            }
            tx.commit().await?;
            return Ok(pl_id);
        }

        let primary_conn: String = sqlx::query(
            "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1;",
        )
        .fetch_optional(&mut *tx)
        .await?
        .and_then(|r| r.try_get("id").ok())
        .unwrap_or_default();

        let playlist_id = create_id("mdpl");
        let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        sqlx::query(
            r"
            INSERT INTO playlists (id, owner_user_id, name, description, created_at, updated_at)
            VALUES (?, ?, ?, 'Saved listening queue', ?, ?);
            ",
        )
        .bind(&playlist_id)
        .bind(user_id)
        .bind(name.trim())
        .bind(&now_iso)
        .bind(&now_iso)
        .execute(&mut *tx)
        .await?;

        for (pos, entry) in content.entries.iter().enumerate() {
            let track_id = entry
                .track
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let source = self.library.get_primary_source(track_id).await?;
            let is_external = entry
                .track
                .get("external")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || entry
                    .track
                    .get("source")
                    .and_then(|s| s.get("kind"))
                    .and_then(Value::as_str)
                    == Some("external")
                || track_id.starts_with("external_");

            if source.is_none() && !is_external {
                tx.rollback().await?;
                return Err(QueueSyncError::new(
                    format!(
                        "Queue track {} is no longer in the library. The original queue is unchanged.",
                        pos + 1
                    ),
                    409,
                ));
            }

            let ext_json = if is_external && source.is_none() {
                Some(
                    json!({
                        "id": track_id,
                        "providerId": track_id,
                        "title": entry.track.get("title").and_then(Value::as_str).unwrap_or("Unknown title"),
                        "artistName": entry.track.get("artist").and_then(Value::as_str).unwrap_or("Unknown artist"),
                        "artistId": entry.track.get("artistId"),
                        "artistCredits": entry.track.get("artistCredits"),
                        "albumName": entry.track.get("album").and_then(Value::as_str).unwrap_or(""),
                        "albumId": entry.track.get("albumId"),
                        "durationSeconds": entry.track.get("duration"),
                        "trackNumber": Value::Null,
                        "artworkId": entry.track.get("coverArt"),
                        "artworkUrl": Value::Null,
                        "streamUrl": "",
                        "external": true,
                        "provider": "external",
                        "source": { "kind": "external", "count": 0 },
                        "previewUrl": entry.track.get("previewUrl"),
                    })
                    .to_string(),
                )
            } else {
                None
            };

            let conn_id = source
                .as_ref()
                .map_or(primary_conn.as_str(), |s| s.connection_id.as_str());
            let prov_id = source
                .as_ref()
                .map_or(track_id, |s| s.provider_item_id.as_str());
            let lib_id = source.as_ref().map(|_| track_id);

            sqlx::query(
                r"
                INSERT INTO playlist_items
                  (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, external_track_json, added_by_user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                ",
            )
            .bind(create_id("mdpli"))
            .bind(&playlist_id)
            .bind(i64::try_from(pos).unwrap_or(0))
            .bind(conn_id)
            .bind(prov_id)
            .bind(lib_id)
            .bind(&now_iso)
            .bind(ext_json)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            "INSERT INTO queue_playlist_saves (user_id, operation_id, playlist_id, content_id, name) VALUES (?, ?, ?, ?, ?);",
        )
        .bind(user_id)
        .bind(operation_id)
        .bind(&playlist_id)
        .bind(content_id)
        .bind(name.trim())
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(playlist_id)
    }

    /// Prunes expired `queue_sessions` (older than 30 days) and unreferenced `queue_contents`
    /// blobs (older than 24 hours).
    pub async fn prune_at(&self, now_ms: i64) -> Result<(), QueueSyncError> {
        sqlx::query("DELETE FROM queue_sessions WHERE updated_at < ?;")
            .bind(now_ms - 30 * DAY_MS)
            .execute(self.db.inner())
            .await?;

        sqlx::query(
            r"
            DELETE FROM queue_contents
            WHERE created_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM queue_sessions s
                WHERE s.user_id = queue_contents.user_id AND s.content_id = queue_contents.content_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM named_queues n
                WHERE n.user_id = queue_contents.user_id AND n.content_id = queue_contents.content_id
              );
            ",
        )
        .bind(now_ms - DAY_MS)
        .execute(self.db.inner())
        .await?;

        Ok(())
    }

    async fn validate_checkpoint_on_conn(
        &self,
        conn: &mut sqlx::SqliteConnection,
        user_id: &str,
        content_id: &str,
        checkpoint: &QueueCheckpoint,
        now_ms: i64,
    ) -> Result<(), QueueSyncError> {
        if !checkpoint.position.is_finite()
            || !(0.0..=(7.0 * DAY_MS as f64 / 1000.0)).contains(&checkpoint.position)
            || !checkpoint.volume.is_finite()
            || !(0.0..=1.0).contains(&checkpoint.volume)
            || checkpoint.captured_at < 0
        {
            return Err(QueueSyncError::new(
                "Invalid queue playback checkpoint.",
                400,
            ));
        }

        if let Some(seed) = checkpoint.shuffle_seed
            && seed > u64::from(u32::MAX)
        {
            return Err(QueueSyncError::new(
                "Invalid queue playback checkpoint.",
                400,
            ));
        }

        let row = sqlx::query(
            "SELECT track_count FROM queue_contents WHERE user_id = ? AND content_id = ?;",
        )
        .bind(user_id)
        .bind(content_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            QueueSyncError::new(
                "The saved queue is unavailable for this account. Sync this device again.",
                404,
            )
        })?;

        let count: i64 = row.try_get("track_count")?;
        if (count == 0 && checkpoint.index != -1)
            || (count > 0 && (checkpoint.index < 0 || checkpoint.index >= count))
        {
            return Err(QueueSyncError::new(
                "The playback index does not belong to this queue.",
                400,
            ));
        }

        if checkpoint.captured_at > now_ms + CLOCK_SKEW_TOLERANCE_MS {
            return Err(QueueSyncError::new(
                "The device clock is ahead of the server. Correct the clock and retry queue sync.",
                400,
            ));
        }

        let _ = MixOrder::Variety;
        Ok(())
    }
}

fn validate_queue_content(raw_input: &Value) -> Result<QueueContent, QueueSyncError> {
    let invalid = || {
        QueueSyncError::new(
            "The queue contains invalid tracks or duplicate occurrence IDs.",
            400,
        )
    };

    let content: QueueContent = serde_json::from_value(raw_input.clone()).map_err(|_| invalid())?;
    if content.version != 2 {
        return Err(invalid());
    }

    let mut seen_entry_ids = HashSet::with_capacity(content.entries.len());
    for entry in &content.entries {
        if entry.entry_id.is_empty()
            || entry.entry_id.len() > 160
            || !seen_entry_ids.insert(entry.entry_id.as_str())
        {
            return Err(invalid());
        }

        let Some(track_obj) = entry.track.as_object() else {
            return Err(invalid());
        };
        let Some(track_id) = track_obj.get("id").and_then(Value::as_str) else {
            return Err(invalid());
        };
        if track_id.is_empty() || track_id.len() > 1000 {
            return Err(invalid());
        }

        if let Some(preview_val) = track_obj.get("previewUrl") {
            let Some(preview_str) = preview_val.as_str() else {
                return Err(invalid());
            };
            if !is_allowed_preview_url(preview_str) {
                return Err(invalid());
            }
        }
    }

    Ok(content)
}

fn is_allowed_preview_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "itunes.apple.com"
        || host.ends_with(".itunes.apple.com")
        || host == "dzcdn.net"
        || host.ends_with(".dzcdn.net")
}

fn compress_gzip_level1(raw: &[u8]) -> Result<Vec<u8>, QueueSyncError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(raw)
        .map_err(|_| QueueSyncError::new("Failed to compress queue payload.", 500))?;
    encoder
        .finish()
        .map_err(|_| QueueSyncError::new("Failed to finalize queue compression.", 500))
}

fn decompress_and_verify(
    compressed: &[u8],
    expected_raw_bytes: usize,
    expected_content_id: &str,
    expected_track_count: usize,
) -> Result<QueueContent, QueueSyncError> {
    let integrity_err = || {
        QueueSyncError::new(
            "The saved queue failed its integrity check. Sync the original device again.",
            409,
        )
    };

    let decoder = GzDecoder::new(compressed);
    let mut bounded = decoder.take((MAX_QUEUE_CONTENT_BYTES as u64) + 1);
    let mut decoded = Vec::with_capacity(expected_raw_bytes.min(MAX_QUEUE_CONTENT_BYTES));
    bounded
        .read_to_end(&mut decoded)
        .map_err(|_| integrity_err())?;

    if decoded.len() != expected_raw_bytes || decoded.len() > MAX_QUEUE_CONTENT_BYTES {
        return Err(integrity_err());
    }

    if sha256_hex(&decoded) != expected_content_id {
        return Err(integrity_err());
    }

    let parsed_val: Value = serde_json::from_slice(&decoded).map_err(|_| integrity_err())?;
    let content = validate_queue_content(&parsed_val).map_err(|_| integrity_err())?;
    if content.entries.len() != expected_track_count {
        return Err(integrity_err());
    }

    Ok(content)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;

    #[tokio::test]
    async fn stores_and_verifies_gzip_queue_content_and_enforces_sequence_monotonicity() {
        let pool = DbPool::connect_memory().await.expect("open memory pool");
        run_migrations(&pool, None).await.expect("run migrations");

        sqlx::raw_sql(
            r"
            INSERT INTO roles VALUES ('user', 'Listener');
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
            VALUES ('u1', 'alice', 'hash', 'Alice', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
            ",
        )
        .execute(pool.inner())
        .await
        .expect("seed user");

        let library = LibraryService::new(pool.clone(), None);
        let service = QueueSyncService::new(pool.clone(), library);
        let now_ms = 1_790_000_000_000i64;

        let payload = json!({
            "version": 2,
            "entries": [
                { "entryId": "occ_1", "track": { "id": "md_track_1", "title": "Song A" } },
                { "entryId": "occ_2", "track": { "id": "md_track_2", "title": "Song B" } }
            ]
        });

        let (content_id, track_count) = service
            .store_content("u1", &payload, now_ms)
            .await
            .expect("store queue content");
        assert_eq!(content_id.len(), 64);
        assert_eq!(track_count, 2);

        let restored = service
            .get_content("u1", &content_id)
            .await
            .expect("decompress and verify queue");
        assert_eq!(restored.entries.len(), 2);

        let cp_v1 = QueueCheckpoint {
            index: 0,
            position: 12.5,
            repeat_one: false,
            shuffle: false,
            shuffle_seed: None,
            shuffle_mode: QueueShuffleMode::Standard,
            album_aware: false,
            volume: 0.8,
            was_playing: true,
            context: None,
            captured_at: now_ms,
        };

        let (saved_1, seq_1) = service
            .save_session_at("u1", "dev_1", "Desktop", &content_id, &cp_v1, 10, now_ms)
            .await
            .expect("save session seq 10");
        assert!(saved_1);
        assert_eq!(seq_1, 10);

        // Stale sequence (9 <= 10) must be rejected with `saved = false`
        let (saved_stale, kept_seq) = service
            .save_session_at("u1", "dev_1", "Desktop", &content_id, &cp_v1, 9, now_ms + 1000)
            .await
            .expect("stale sequence check");
        assert!(!saved_stale);
        assert_eq!(kept_seq, 10);

        pool.close().await;
    }
}
