//! # Ephemeral User-Isolated WebSocket Remote Control Hub (`remote`)
//!
//! Complete Rust port of `server/src/services/RemoteControlHub.ts`.
//!
//! ## Protocol & Security Architecture (`/api/v1/remote`)
//! 1. **Upgrade & Admission Guardrails**:
//!    - Non-WebSocket `GET /api/v1/remote` requests return `HTTP 426 Upgrade Required`
//!      (`UPGRADE_REQUIRED`).
//!    - Verifies the `Origin` header matches `config.public_url` or `config.cors_origin` (`403 Forbidden`).
//!    - Verifies the `musicdeck_session` cookie resolves to an active user (`401 Unauthorized`).
//!    - Caps concurrent WebSocket connections per user at [`MAX_CLIENTS_PER_USER`] (`16`, `429 Too Many Requests`).
//!    - Enforces a `1 MiB` max inbound payload and a `64`-slot outbound channel buffer
//!      (closing slow consumers with code `4008 "Slow remote consumer"`).
//!    - Requires a `REGISTER` frame within `10,000` ms (`4000 "Registration timeout"`).
//!    - Reconnecting with an already-connected `device_id` closes the previous socket with
//!      `4009 "Device reconnected"`.
//! 2. **Token-Bucket Command Rate Limiting**:
//!    - Each connection starts with `120.0` tokens and refills at `0.06` tokens/ms (`60` msg/sec).
//!    - Exceeding the bucket closes the socket with `4008 "Remote command rate exceeded"`.
//! 3. **4-Stage Playback Transfer Handshake State Machine**:
//!    - **Stage 1 (`Snapshot`)**: Controller sends `TRANSFER_PLAYBACK { requestId, targetId }` $\rightarrow$
//!      Hub sends `REQUEST_SNAPSHOT { transferId }` to `source`.
//!    - **Stage 2 (`Prepare`)**: `source` replies with `SNAPSHOT { transferId, snapshot }` $\rightarrow$
//!      Hub sends `INITIALIZE_PLAYER { transferId, snapshot }` to `target`.
//!    - **Stage 3 (`Pause`)**: `target` replies with `READY { transferId }` $\rightarrow$
//!      Hub sends `PAUSE_FOR_TRANSFER { transferId }` to `source`.
//!    - **Stage 4 (`Start`)**: `source` freezes its buffer and replies with `SOURCE_PAUSED { transferId, snapshot }` $\rightarrow$
//!      Hub verifies the queue/track did not drift and sends `START_TRANSFER { transferId, snapshot }` to `target`.
//!      When `target` replies with `STARTED { transferId }`, Hub promotes `target` to active player,
//!      sends `TRANSFER_COMPLETE` to both peers, sends `TRANSFER_RESULT { requestId, ok: true }` to `controller`,
//!      and broadcasts updated `DEVICES`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::Instant;
use uuid::Uuid;

/// Canonical WebSocket path for the Remote Control Hub.
pub const REMOTE_WS_PATH: &str = "/api/v1/remote";

/// Maximum concurrent remote WebSocket connections per user account (`16`).
pub const MAX_CLIENTS_PER_USER: usize = 16;

/// Maximum pending unacknowledged commands per account (`64`).
pub const MAX_PENDING_COMMANDS_PER_ACCOUNT: usize = 64;
/// Legacy name for the pending command limit.
pub const MAX_PENDING_COMMANDS_PER_CONTROLLER: usize = MAX_PENDING_COMMANDS_PER_ACCOUNT;

/// Registration deadline (`10,000` ms) before an unregistered socket is closed (`4000`).
pub const REGISTRATION_TIMEOUT_MS: u64 = 10_000;

/// Command acknowledgement timeout (`8,000` ms).
pub const COMMAND_TIMEOUT_MS: u64 = 8_000;
const COMMAND_LIFETIME_MS: u64 = 10_000;
const ROLLBACK_TIMEOUT: Duration = Duration::from_secs(4);
const PLAYBACK_LEASE_MS: u64 = 5_000;

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 4-stage playback transfer handshake timeout (`20,000` ms).
pub const TRANSFER_TIMEOUT_MS: u64 = 20_000;

/// Device form-factor classification (`computer`, `phone`, `tablet`, `web`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteDeviceType {
    /// Desktop application or desktop OS player.
    Computer,
    /// Mobile phone client.
    Phone,
    /// Tablet client.
    Tablet,
    /// Browser web player.
    #[default]
    Web,
}

/// Currently loaded track summary inside [`RemotePlaybackState`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteTrackSummary {
    /// Track ID (`1..=160` chars).
    pub id: String,
    /// Track title (`<= 500` chars).
    pub title: String,
    /// Display artist name, when known by the player.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// Display album name, when known by the player.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    /// MusicDeck artwork identifier, never a stream URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_art: Option<String>,
}

/// Real-time player transport state reported by a connected device (`stateSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemotePlaybackState {
    /// Active track, or `None` when stopped/empty.
    pub current_track: Option<RemoteTrackSummary>,
    /// Playback position in milliseconds (`0..=604_800_000`).
    pub position_ms: f64,
    /// Track duration in milliseconds (`0..=604_800_000`).
    pub duration_ms: f64,
    /// `true` if audio is actively playing.
    pub playing: bool,
    /// Player volume in `[0.0, 1.0]`.
    pub volume: f64,
}

impl Default for RemotePlaybackState {
    fn default() -> Self {
        Self {
            current_track: None,
            position_ms: 0.0,
            duration_ms: 0.0,
            playing: false,
            volume: 1.0,
        }
    }
}

impl RemotePlaybackState {
    fn validate(&self) -> bool {
        (0.0..=604_800_000.0).contains(&self.position_ms)
            && (0.0..=604_800_000.0).contains(&self.duration_ms)
            && (0.0..=1.0).contains(&self.volume)
            && self.current_track.as_ref().is_none_or(|track| {
                !track.id.is_empty() && track.id.len() <= 1024 && track.title.chars().count() <= 500
            })
    }
}

/// Remote transport command payload (`commandSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteCommand {
    /// Resume playback.
    Play,
    /// Pause playback.
    Pause,
    /// Skip to `next` or `previous` track.
    Skip {
        /// `"next"` or `"previous"`.
        direction: String,
    },
    /// Seek to `position_ms`.
    Seek {
        /// Target playback position in milliseconds.
        position_ms: f64,
    },
    /// Adjust player volume to `volume` (`0.0..=1.0`).
    SetVolume {
        /// Target volume level.
        volume: f64,
    },
    /// Toggle shuffle on the active device.
    ToggleShuffle,
    /// Toggle repeat-one on the active device.
    ToggleRepeat,
    /// Set whether the selected playlist repeats on the active device.
    SetPlaylistLoop { playlist_id: String, enabled: bool },
    /// Play a specific occurrence in the active queue.
    PlayQueueEntry { entry_id: String },
    /// Reorder the active queue using occurrence identities.
    MoveQueueEntry { entry_id: String, target_id: String },
    /// Replace the active queue with a selection made on a controller.
    PlaySelection {
        tracks: Vec<Value>,
        start_index: usize,
        from_here: bool,
        context: Option<RemoteSelectionContext>,
    },
    /// Play one selected track. Routed through the same queue path as PLAY_SELECTION.
    PlayTrack { track: Value },
    /// Add tracks to the active queue.
    Enqueue {
        tracks: Vec<Value>,
        next: bool,
        dedupe: bool,
    },
}

/// Collection information associated with a new remote selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSelectionContext {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub name: String,
    pub cover_art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playlist_loop_id: Option<String>,
}

impl RemoteCommand {
    fn valid(&self) -> bool {
        let valid_id = |id: &str| !id.is_empty() && id.len() <= 160;
        let valid_tracks = |tracks: &[Value]| {
            !tracks.is_empty()
                && tracks.len() <= 1000
                && tracks.iter().all(|track| {
                    track
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty() && id.len() <= 1024)
                })
        };
        match self {
            Self::Skip { direction } => matches!(direction.as_str(), "next" | "previous"),
            Self::Seek { position_ms } => (0.0..=604_800_000.0).contains(position_ms),
            Self::SetVolume { volume } => (0.0..=1.0).contains(volume),
            Self::SetPlaylistLoop { playlist_id, .. } => !playlist_id.is_empty() && playlist_id.len() <= 1024,
            Self::PlayQueueEntry { entry_id } => valid_id(entry_id),
            Self::MoveQueueEntry {
                entry_id,
                target_id,
            } => valid_id(entry_id) && valid_id(target_id),
            Self::PlaySelection {
                tracks,
                start_index,
                context,
                ..
            } => {
                valid_tracks(tracks)
                    && *start_index < tracks.len()
                    && context.as_ref().is_none_or(|context| {
                        context.kind.len() <= 80
                            && context.id.len() <= 1024
                            && context.name.len() <= 500
                            && context.playlist_loop_id.as_ref().is_none_or(|id| context.kind == "collection" && id == &context.id)
                            && context
                                .cover_art
                                .as_ref()
                                .is_none_or(|art| art.len() <= 2048)
                    })
            }
            Self::Enqueue { tracks, .. } => valid_tracks(tracks),
            _ => true,
        }
    }
}

/// Queue entry inside a [`TransferQueueState`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferQueueEntry {
    /// Unique occurrence ID (`1..=160` chars).
    pub occurrence_id: String,
    /// Original position of a shuffled occurrence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unshuffled_index: Option<usize>,
    /// Track ID (`1..=160` chars).
    pub track_id: String,
    /// Track title.
    pub title: String,
    /// Artist name.
    pub artist: String,
    /// Album title.
    pub album: String,
    /// Track duration in seconds (`0..=604800`).
    pub duration: f64,
    /// Optional album playback correlation ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_playback_id: Option<String>,
    /// Optional album track index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_track_index: Option<usize>,
    /// Optional resumable media bookmark descriptor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<Value>,
}

/// Queue state carried inside a [`TransferSnapshot`] (`queueSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferQueueState {
    /// Non-empty list of queue entries (`1..=5000`) with unique `occurrenceId`s.
    pub entries: Vec<TransferQueueEntry>,
    /// Active entry index (`< entries.len()`).
    pub index: usize,
    /// Repeat-one toggle.
    pub repeat_one: bool,
    /// Repeat the queue at its end. Absent for older clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_all: Option<bool>,
    /// Playlist selected for scoped repeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_playlist_id: Option<String>,
    /// Shuffle toggle.
    pub shuffle: bool,
    /// Shuffle mode (`"standard"` or `"smart"`).
    pub shuffle_mode: String,
    /// Optional shuffle seed.
    pub shuffle_seed: Option<i64>,
    /// Album-aware toggle.
    pub album_aware: bool,
    /// Optional playback context.
    pub context: Option<Value>,
}

/// Authoritative account state. Queue entries retain occurrence IDs for duplicate tracks.
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackState {
    pub device_id: Option<String>,
    pub track: Option<RemoteTrackSummary>,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub is_playing: bool,
    pub volume: f32,
    pub updated_at: u64,
    pub revision: u64,
    // Sent separately on initialization and on queue changes.
    #[serde(skip)]
    pub queue: Option<Arc<TransferQueueState>>,
}

/// Full playback & queue snapshot exchanged during the 4-stage transfer handshake (`snapshotSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSnapshot {
    /// Complete queue state.
    pub queue_state: TransferQueueState,
    /// Active track ID (must equal `queue_state.entries[queue_state.index].track_id`).
    pub track_id: String,
    /// Exact playback position in milliseconds.
    pub exact_position_ms: f64,
    /// Whether the source was playing when the transfer started.
    pub playing: bool,
    /// Source player volume (`0.0..=1.0`).
    pub volume: f64,
}

impl TransferSnapshot {
    /// Validates all structural invariants of a [`TransferSnapshot`] (`snapshotSchema`).
    pub fn validate(&self) -> bool {
        if self.queue_state.entries.is_empty()
            || self.queue_state.entries.len() > 5000
            || self.queue_state.index >= self.queue_state.entries.len()
        {
            return false;
        }
        let mut seen = std::collections::HashSet::with_capacity(self.queue_state.entries.len());
        for entry in &self.queue_state.entries {
            if entry.occurrence_id.is_empty()
                || entry.occurrence_id.len() > 160
                || !seen.insert(entry.occurrence_id.as_str())
            {
                return false;
            }
        }
        self.queue_state.entries[self.queue_state.index].track_id == self.track_id
            && self.exact_position_ms.is_finite()
            && (0.0..=604_800_000.0).contains(&self.exact_position_ms)
            && self.volume.is_finite()
            && (0.0..=1.0).contains(&self.volume)
    }
}

/// Inbound WebSocket message sent by a remote client (`messageSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteClientMessage {
    /// Register device identity and capabilities on connection startup.
    Register {
        /// Stable device ID (`1..=160` chars).
        device_id: String,
        /// Persistent queue identity for clients that follow account queue changes.
        #[serde(default)]
        queue_device_id: Option<String>,
        /// Human-readable device name (`1..=80` trimmed chars).
        device_name: String,
        /// Device form factor.
        device_type: RemoteDeviceType,
        /// Whether this device can receive remote commands and playback transfers.
        can_receive: bool,
        /// Initial playback state.
        state: RemotePlaybackState,
        /// Opts into account state frames. Older clients still receive DEVICES.
        #[serde(default)]
        live_sync: bool,
        #[serde(default)]
        command_deadlines: bool,
        /// Opt in to renewable playback ownership across transient disconnects.
        #[serde(default)]
        playback_lease: bool,
        #[serde(default, rename = "playbackLeaseProtocol")]
        playback_lease_protocol: Option<u8>,
        #[serde(default, rename = "leaseGeneration")]
        lease_generation: Option<Uuid>,
        #[serde(default, rename = "leaseServerId")]
        lease_server_id: Option<Uuid>,
    },
    /// Request a lease acknowledgement for the active output.
    RenewPlaybackLease {
        /// Monotonic browser correlation counter.
        sequence: u64,
        device_id: String,
        #[serde(rename = "leaseGeneration")]
        lease_generation: Uuid,
    },
    ReleasePlaybackLease {
        device_id: String,
        #[serde(rename = "leaseGeneration")]
        lease_generation: Uuid,
    },
    /// Report updated playback state and optionally select this player if no device is active.
    State {
        /// Current playback state.
        state: RemotePlaybackState,
        /// Legacy client hint. Ownership now follows reported playback only when no player is selected.
        #[serde(default, rename = "claim")]
        _claim: bool,
        /// Latest queue when it changes. Omission preserves the previous queue.
        #[serde(default)]
        queue: Option<TransferQueueState>,
        #[serde(default)]
        clear_queue: bool,
    },
    /// Dispatch a remote transport command to `target_id` (or the current active player).
    Command {
        /// Client correlation ID.
        #[serde(rename = "requestId")]
        request_id: String,
        /// Optional explicit target device ID.
        #[serde(rename = "targetId")]
        target_id: Option<String>,
        #[serde(default, rename = "expiresAt")]
        expires_at: Option<u64>,
        /// Command payload.
        command: RemoteCommand,
    },
    /// Acknowledge execution of a received `EXECUTE` command.
    CommandResult {
        /// Command correlation ID assigned by the hub.
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(default, rename = "expiresAt")]
        expires_at: Option<u64>,
        /// Whether execution succeeded.
        ok: bool,
        /// Optional error/diagnostic message.
        message: Option<String>,
        #[serde(default)]
        state: Option<RemotePlaybackState>,
    },
    /// Initiate a 4-stage playback transfer to `target_id` (Stage 1 trigger).
    TransferPlayback {
        /// Controller request correlation ID.
        #[serde(rename = "requestId")]
        request_id: String,
        /// Target device ID.
        #[serde(rename = "targetId")]
        target_id: String,
    },
    /// Stage 2: Source device provides its current [`TransferSnapshot`].
    Snapshot {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
        /// Captured queue and playback snapshot.
        snapshot: TransferSnapshot,
    },
    /// Stage 3: Target device confirms its audio element/buffer is initialized and ready.
    Ready {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
    /// Stage 4a: Source device confirms it has paused local output and provides its final frozen snapshot.
    SourcePaused {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
        /// Frozen snapshot at the instant of pause.
        snapshot: TransferSnapshot,
    },
    /// Stage 4b: Target device confirms playback has started seamlessly.
    Started {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
        #[serde(default)]
        queue: Option<TransferQueueState>,
    },
    /// Abort an in-flight transfer due to a client-side error.
    TransferFailed {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
        /// Failure reason (`<= 500` chars).
        message: String,
    },
    TransferRolledBack {
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
}

/// Stage of an in-flight 4-stage playback transfer handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferStage {
    /// Waiting for `SNAPSHOT` from `source`.
    Snapshot,
    /// Waiting for `READY` from `target`.
    Prepare,
    /// Waiting for `SOURCE_PAUSED` from `source`.
    Pause,
    /// Waiting for `STARTED` from `target`.
    Start,
    Rollback,
}

#[derive(Debug)]
struct ConnectedClient {
    conn_id: String,
    user_id: String,
    session_id: String,
    device_id: Option<String>,
    queue_device_id: Option<String>,
    device_name: String,
    device_type: RemoteDeviceType,
    can_receive: bool,
    state: RemotePlaybackState,
    live_sync: bool,
    command_deadlines: bool,
    playback_lease: bool,
    lease: Option<PlayerLease>,
    must_report_stopped: bool,
    queue: Option<Arc<TransferQueueState>>,
    tx: mpsc::Sender<Value>,
    disconnected: watch::Sender<bool>,
    deadline_changed: Arc<Notify>,
    tokens: f64,
    last_refill_ms: u64,
}

#[derive(Debug)]
struct PendingCommand {
    id: String,
    controller_conn_id: String,
    target_conn_id: String,
    client_request_id: String,
    command: RemoteCommand,
    expires: Instant,
    expires_at: u64,
    deadline: Option<Instant>,
}

#[derive(Debug)]
struct ActiveTransfer {
    id: String,
    request_id: String,
    controller_conn_id: String,
    source_conn_id: String,
    target_conn_id: String,
    stage: TransferStage,
    snapshot: Option<TransferSnapshot>,
    deadline: Instant,
    target_playback_until: Option<Instant>,
    failure: Option<String>,
}

#[derive(Debug)]
struct DetachedPlayer {
    session_id: String,
    device_id: String,
    lease: PlayerLease,
    state: RemotePlaybackState,
    queue: Option<Arc<TransferQueueState>>,
    paused_transfer: Option<String>,
}

#[derive(Debug)]
struct PlayerLease {
    generation: Uuid,
    expires: Instant,
    last_sequence: u64,
}

impl PlayerLease {
    fn new() -> Self {
        Self {
            generation: Uuid::new_v4(),
            expires: Instant::now() + Duration::from_millis(PLAYBACK_LEASE_MS),
            last_sequence: 0,
        }
    }
}

#[derive(Debug, Default)]
struct HubState {
    server_id: Uuid,
    clients: HashMap<String, ConnectedClient>,
    active_player_by_user: HashMap<String, String>,
    detached_players: HashMap<String, DetachedPlayer>,
    playback_by_user: HashMap<String, PlaybackState>,
    commands: HashMap<String, VecDeque<PendingCommand>>,
    transfers_by_user: HashMap<String, ActiveTransfer>,
}

/// Thread-safe, user-isolated WebSocket control plane coordinating device discovery,
/// command forwarding, and the 4-stage playback transfer handshake.
#[derive(Debug, Clone)]
pub struct RemoteControlHub {
    state: Arc<Mutex<HubState>>,
}

impl Default for RemoteControlHub {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteControlHub {
    /// Creates a new [`RemoteControlHub`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState {
                server_id: Uuid::new_v4(),
                ..HubState::default()
            })),
        }
    }

    /// Admits a new authenticated WebSocket connection for `(user_id, session_id)`,
    /// enforcing the 16-connection-per-user limit (`MAX_CLIENTS_PER_USER`).
    pub fn connect_client(
        &self,
        user_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> Result<(String, mpsc::Receiver<Value>), &'static str> {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let user_conn_count = guard
            .clients
            .values()
            .filter(|c| c.user_id == user_id)
            .count();
        if user_conn_count >= MAX_CLIENTS_PER_USER {
            return Err("Too Many Requests");
        }

        let conn_id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel(64);

        guard.clients.insert(
            conn_id.clone(),
            ConnectedClient {
                conn_id: conn_id.clone(),
                user_id: user_id.to_owned(),
                session_id: session_id.to_owned(),
                device_id: None,
                queue_device_id: None,
                device_name: String::new(),
                device_type: RemoteDeviceType::Web,
                can_receive: false,
                state: RemotePlaybackState::default(),
                live_sync: false,
                command_deadlines: false,
                playback_lease: false,
                lease: None,
                must_report_stopped: false,
                queue: None,
                tx,
                disconnected: watch::channel(false).0,
                deadline_changed: Arc::new(Notify::new()),
                tokens: 120.0,
                last_refill_ms: now_ms,
            },
        );

        Ok((conn_id, rx))
    }

    /// Returns `true` if `conn_id` has completed its `REGISTER` handshake.
    #[must_use]
    pub fn is_registered(&self, conn_id: &str) -> bool {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .clients
            .get(conn_id)
            .is_some_and(|c| c.device_id.is_some())
    }

    pub(crate) fn disconnect_signal(&self, conn_id: &str) -> Option<watch::Receiver<bool>> {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Some(guard.clients.get(conn_id)?.disconnected.subscribe())
    }

    pub(crate) fn deadline_signal(&self, conn_id: &str) -> Option<Arc<Notify>> {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Some(Arc::clone(&guard.clients.get(conn_id)?.deadline_changed))
    }

    pub(crate) fn supports_control_watchdog(&self, conn_id: &str) -> bool {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .clients
            .get(conn_id)
            .is_some_and(|client| client.command_deadlines)
    }

    /// Consumes 1 rate-limit token from `conn_id`, returning `false` if the client exceeded
    /// its token bucket (`120` burst, `60`/sec refill).
    pub fn consume_rate_token(&self, conn_id: &str, now_ms: u64) -> bool {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(client) = guard.clients.get_mut(conn_id) else {
            return false;
        };

        let elapsed = now_ms.saturating_sub(client.last_refill_ms) as f64;
        client.tokens = (client.tokens + elapsed * 0.06).min(120.0) - 1.0;
        client.last_refill_ms = now_ms;
        client.tokens >= 0.0
    }

    /// Processes a validated [`RemoteClientMessage`] from `conn_id`.
    pub fn handle_message(&self, conn_id: &str, message: RemoteClientMessage) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let Some(user_id) = guard
            .clients
            .get(conn_id)
            .filter(|client| !*client.disconnected.borrow())
            .map(|client| client.user_id.clone())
        else {
            return;
        };

        Self::expire_playback_lease_locked(&mut guard, &user_id);
        match message {
            RemoteClientMessage::Register {
                device_id,
                queue_device_id,
                device_name,
                device_type,
                can_receive,
                mut state,
                live_sync,
                command_deadlines,
                playback_lease,
                playback_lease_protocol,
                lease_generation,
                lease_server_id: _,
            } => {
                // Sequence-only clients cannot prove ownership across sockets.
                let playback_lease = playback_lease && playback_lease_protocol == Some(1);
                let clean_name = device_name.trim().to_owned();
                if device_id.is_empty()
                    || device_id.len() > 160
                    || queue_device_id
                        .as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 300)
                    || clean_name.is_empty()
                    || clean_name.chars().count() > 80
                    || !state.validate()
                {
                    Self::send_error_locked(&guard, conn_id, "Invalid remote message", None);
                    return;
                }

                if let Some(existing_dev) = guard
                    .clients
                    .get(conn_id)
                    .and_then(|c| c.device_id.as_deref())
                    && existing_dev != device_id
                {
                    Self::send_error_locked(
                        &guard,
                        conn_id,
                        "Device identity cannot change on an open connection",
                        None,
                    );
                    return;
                }

                let Some(client) = guard.clients.get(conn_id) else { return };
                let session_id = client.session_id.clone();
                if guard.detached_players.get(&user_id).is_some_and(|owner| {
                    owner.device_id == device_id
                        && (!playback_lease
                            || owner.session_id != session_id
                            || lease_generation != Some(owner.lease.generation))
                }) {
                    Self::send_frame_locked(&guard, conn_id, json!({ "type": "DEACTIVATE" }));
                    return;
                }
                let duplicate = guard.clients.values().find(|peer| {
                    peer.conn_id != conn_id
                        && peer.user_id == user_id
                        && peer.device_id.as_deref() == Some(device_id.as_str())
                });
                if duplicate.is_some_and(|peer| peer.session_id != session_id) {
                    Self::send_error_locked(
                        &guard,
                        conn_id,
                        "Device identity belongs to another session",
                        None,
                    );
                    return;
                }
                if duplicate.is_some_and(|peer| {
                    peer.lease.as_ref().is_some_and(|lease| {
                        !playback_lease || lease_generation != Some(lease.generation)
                    })
                }) {
                    Self::send_frame_locked(&guard, conn_id, json!({ "type": "DEACTIVATE" }));
                    return;
                }
                let duplicate_id = duplicate.map(|peer| peer.conn_id.clone());
                let can_rejoin_detached = guard.detached_players.get(&user_id).is_some_and(|owner| {
                    playback_lease
                        && owner.device_id == device_id
                        && owner.session_id == session_id
                        && lease_generation == Some(owner.lease.generation)
                });
                let mut retained_queue = None;
                let mut retained_lease = None;
                let mut paused_transfer = None;
                if can_rejoin_detached {
                    if let Some(owner) = guard.detached_players.remove(&user_id) {
                        retained_queue = owner.queue;
                        retained_lease = Some(owner.lease);
                        paused_transfer = owner.paused_transfer;
                        guard.active_player_by_user.insert(user_id.clone(), conn_id.to_owned());
                    }
                } else if let Some(old) = duplicate_id.as_ref()
                    .filter(|old| guard.active_player_by_user.get(&user_id) == Some(*old))
                    && let Some(previous) = guard.clients.get_mut(old)
                {
                    retained_queue = previous.queue.clone();
                    retained_lease = previous.lease.take();
                    guard.active_player_by_user.insert(user_id.clone(), conn_id.to_owned());
                }

                let Some(client) = guard.clients.get(conn_id) else { return };
                // A fresh socket can reclaim an unowned account after a long outage or restart.
                // A live/detached player or a transfer fence must still be respected.
                let unowned_reconnect = playback_lease
                    && client.device_id.is_none()
                    && !guard.active_player_by_user.contains_key(&user_id)
                    && !guard.detached_players.contains_key(&user_id)
                    && !guard.transfers_by_user.contains_key(&user_id);
                let reported_stopped = !state.playing;
                if state.playing
                    && (guard
                        .active_player_by_user
                        .get(&user_id)
                        .is_some_and(|active| active != conn_id)
                        || (lease_generation.is_some()
                            && retained_lease.is_none()
                            && !unowned_reconnect
                            && client.lease.as_ref().map(|lease| lease.generation) != lease_generation)
                        || client.must_report_stopped
                        || Self::handoff_blocks_playback(&guard, &user_id, conn_id))
                    && !Self::is_starting_transfer_target(&guard, &user_id, conn_id)
                {
                    // A reconnecting player follows the device that still owns playback.
                    state.playing = false;
                    Self::send_frame_locked(&guard, conn_id, json!({ "type": "DEACTIVATE" }));
                    if let Some(client) = guard.clients.get_mut(conn_id) {
                        client.must_report_stopped = true;
                    }
                }
                let is_playing = state.playing && state.current_track.is_some();
                let initialize = guard
                    .clients
                    .get(conn_id)
                    .is_some_and(|c| live_sync && !c.live_sync);
                if let Some(client) = guard.clients.get_mut(conn_id) {
                    client.device_id = Some(device_id);
                    client.queue_device_id = queue_device_id;
                    client.device_name = clean_name;
                    client.device_type = device_type;
                    client.can_receive = can_receive;
                    client.state = state;
                    client.live_sync = live_sync;
                    client.command_deadlines = command_deadlines;
                    client.playback_lease = playback_lease;
                    if reported_stopped {
                        client.must_report_stopped = false;
                    }
                    if let Some(lease) = retained_lease {
                        client.lease = Some(lease);
                        client.deadline_changed.notify_one();
                    }
                    if retained_queue.is_some() {
                        client.queue = retained_queue;
                    }
                }
                if let Some(id) = duplicate_id {
                    Self::remove_client_locked(&mut guard, &id, false);
                }

                if !guard.active_player_by_user.contains_key(&user_id)
                    && !guard.transfers_by_user.contains_key(&user_id)
                    && is_playing
                {
                    Self::select_player_locked(&mut guard, &user_id, conn_id);
                }

                Self::broadcast_devices_locked(&guard, &user_id);
                Self::sync_playback_locked(&mut guard, &user_id, initialize.then_some(conn_id));
                if let Some(transfer_id) = paused_transfer {
                    match guard.transfers_by_user.get_mut(&user_id) {
                        Some(transfer) if transfer.id == transfer_id && transfer.stage == TransferStage::Rollback => {
                            // Keep the target's provisional fence. Its rollback acknowledgement
                            // or deadline will resume the verified source on its new socket.
                            transfer.source_conn_id = conn_id.to_owned();
                        }
                        None => {
                            Self::send_frame_locked(&guard, conn_id, json!({
                                "type": "ABORT_TRANSFER", "transferId": transfer_id, "resume": true,
                            }));
                        }
                        _ => {}
                    }
                }
            }
            other => {
                if !guard
                    .clients
                    .get(conn_id)
                    .is_some_and(|c| c.device_id.is_some())
                {
                    Self::send_error_locked(&guard, conn_id, "Register this device first", None);
                    return;
                }

                match other {
                    RemoteClientMessage::Register { .. } => {}
                    RemoteClientMessage::RenewPlaybackLease {
                        sequence,
                        device_id,
                        lease_generation,
                    } => {
                        if let Some(lease) = Self::lease_for_client(
                            &mut guard,
                            &user_id,
                            conn_id,
                            &device_id,
                            lease_generation,
                        ) && sequence > lease.last_sequence
                        {
                            lease.last_sequence = sequence;
                            lease.expires =
                                Instant::now() + Duration::from_millis(PLAYBACK_LEASE_MS);
                            if let Some(client) = guard.clients.get(conn_id) {
                                client.deadline_changed.notify_one();
                            }
                            Self::send_frame_locked(
                                &guard,
                                conn_id,
                                json!({
                                    "type": "PLAYBACK_LEASE", "sequence": sequence, "leaseMs": PLAYBACK_LEASE_MS,
                                    "device_id": device_id, "leaseGeneration": lease_generation,
                                }),
                            );
                        }
                    }
                    RemoteClientMessage::ReleasePlaybackLease {
                        device_id,
                        lease_generation,
                    } => {
                        if Self::lease_for_client(
                            &mut guard,
                            &user_id,
                            conn_id,
                            &device_id,
                            lease_generation,
                        )
                        .is_some()
                        {
                            Self::release_player_locked(&mut guard, &user_id, conn_id, false);
                        }
                    }
                    RemoteClientMessage::State {
                        state,
                        queue,
                        clear_queue,
                        ..
                    } => {
                        Self::update_player_locked(
                            &mut guard,
                            conn_id,
                            &user_id,
                            state,
                            queue,
                            clear_queue,
                        );
                    }
                    RemoteClientMessage::Command {
                        request_id,
                        target_id,
                        expires_at,
                        command,
                    } => {
                        let now_ms = epoch_ms();
                        let expires_at = expires_at
                            .unwrap_or(now_ms + COMMAND_LIFETIME_MS)
                            .min(now_ms + COMMAND_LIFETIME_MS);
                        if expires_at <= now_ms {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Playback command expired",
                                Some(&request_id),
                            );
                            return;
                        }
                        let command = match command {
                            RemoteCommand::PlayTrack { track } => RemoteCommand::PlaySelection {
                                tracks: vec![track],
                                start_index: 0,
                                from_here: false,
                                context: None,
                            },
                            command => command,
                        };
                        if !command.valid() {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Invalid playback command",
                                Some(&request_id),
                            );
                            return;
                        }
                        if guard.transfers_by_user.contains_key(&user_id) {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Playback transfer is in progress",
                                Some(&request_id),
                            );
                            return;
                        }

                        let active_conn = guard.active_player_by_user.get(&user_id).cloned();
                        let target_conn = if let Some(ref tid) = target_id {
                            guard
                                .clients
                                .values()
                                .find(|c| {
                                    c.user_id == user_id && c.device_id.as_deref() == Some(tid)
                                })
                                .map(|c| c.conn_id.clone())
                        } else {
                            active_conn
                                .clone()
                                .filter(|id| guard.clients.contains_key(id))
                        };

                        let Some(target_conn) = target_conn else {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "No active player is connected",
                                Some(&request_id),
                            );
                            return;
                        };

                        if active_conn.as_deref() != Some(target_conn.as_str())
                            && !matches!(command, RemoteCommand::SetVolume { .. })
                        {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Select the active player first",
                                Some(&request_id),
                            );
                            return;
                        }

                        let commands = guard.commands.entry(user_id.clone()).or_default();
                        if commands.len() >= MAX_PENDING_COMMANDS_PER_ACCOUNT {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Too many pending account commands",
                                Some(&request_id),
                            );
                            return;
                        }
                        commands.push_back(PendingCommand {
                            id: Uuid::new_v4().to_string(),
                            controller_conn_id: conn_id.to_owned(),
                            target_conn_id: target_conn,
                            client_request_id: request_id,
                            command,
                            expires: Instant::now() + Duration::from_millis(expires_at - now_ms),
                            expires_at,
                            deadline: None,
                        });
                        Self::dispatch_command_locked(&mut guard, &user_id);
                    }
                    RemoteClientMessage::CommandResult {
                        request_id,
                        expires_at,
                        ok,
                        message,
                        state,
                    } => {
                        let command = guard
                            .commands
                            .get(&user_id)
                            .and_then(VecDeque::front)
                            .filter(|cmd| {
                                cmd.id == request_id
                                    && cmd.target_conn_id == conn_id
                                    && cmd.deadline.is_some()
                            });
                        let target_uses_deadlines = guard
                            .clients
                            .get(conn_id)
                            .is_some_and(|c| c.command_deadlines);
                        let Some(command) = command.filter(|cmd| {
                            expires_at == Some(cmd.expires_at)
                                || (!target_uses_deadlines && expires_at.is_none())
                        }) else {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Unknown command acknowledgement",
                                None,
                            );
                            return;
                        };
                        if command.expires_at <= epoch_ms()
                            || command
                                .deadline
                                .is_some_and(|deadline| deadline <= Instant::now())
                        {
                            Self::expire_command_locked(&guard, command);
                            return;
                        }
                        if let Some(cmd) = guard
                            .commands
                            .get_mut(&user_id)
                            .and_then(VecDeque::pop_front)
                        {
                            let ok = ok && state.as_ref().is_none_or(RemotePlaybackState::validate);
                            if ok && let Some(state) = state {
                                Self::update_player_locked(
                                    &mut guard, conn_id, &user_id, state, None, false,
                                );
                            }
                            Self::send_frame_locked(
                                &guard,
                                &cmd.controller_conn_id,
                                json!({
                                    "type": "COMMAND_RESULT",
                                    "requestId": cmd.client_request_id,
                                    "ok": ok,
                                    "message": message,
                                }),
                            );
                            Self::dispatch_command_locked(&mut guard, &user_id);
                        }
                    }
                    RemoteClientMessage::TransferPlayback {
                        request_id,
                        target_id,
                    } => {
                        if guard.transfers_by_user.contains_key(&user_id)
                            || guard
                                .commands
                                .get(&user_id)
                                .is_some_and(|commands| !commands.is_empty())
                        {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Wait for the current playback command or transfer to finish",
                                Some(&request_id),
                            );
                            return;
                        }

                        let target_conn = guard
                            .clients
                            .values()
                            .find(|c| {
                                c.user_id == user_id
                                    && c.device_id.as_deref() == Some(target_id.as_str())
                                    && c.can_receive
                            })
                            .map(|c| c.conn_id.clone());

                        let Some(target_conn) = target_conn else {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Choose an online device with playback enabled",
                                Some(&request_id),
                            );
                            return;
                        };

                        if guard.detached_players.contains_key(&user_id) {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "The active player is reconnecting",
                                Some(&request_id),
                            );
                            return;
                        }
                        let source_conn = guard
                            .active_player_by_user
                            .get(&user_id)
                            .filter(|source| {
                                *source != &target_conn
                                    && guard
                                        .clients
                                        .get(*source)
                                        .is_some_and(|client| client.state.current_track.is_some())
                            })
                            .cloned();
                        let Some(source_conn) = source_conn else {
                            Self::select_player_locked(&mut guard, &user_id, &target_conn);
                            Self::broadcast_devices_locked(&guard, &user_id);
                            Self::sync_playback_locked(&mut guard, &user_id, None);
                            Self::send_frame_locked(
                                &guard,
                                conn_id,
                                json!({
                                    "type": "TRANSFER_RESULT", "requestId": request_id, "ok": true,
                                }),
                            );
                            return;
                        };

                        let transfer_id = Uuid::new_v4().to_string();
                        guard.transfers_by_user.insert(
                            user_id,
                            ActiveTransfer {
                                id: transfer_id.clone(),
                                request_id,
                                controller_conn_id: conn_id.to_owned(),
                                source_conn_id: source_conn.clone(),
                                target_conn_id: target_conn,
                                stage: TransferStage::Snapshot,
                                snapshot: None,
                                failure: None,
                                deadline: Instant::now()
                                    + Duration::from_millis(TRANSFER_TIMEOUT_MS),
                                target_playback_until: None,
                            },
                        );

                        Self::send_frame_locked(
                            &guard,
                            &source_conn,
                            json!({
                                "type": "REQUEST_SNAPSHOT",
                                "transferId": transfer_id,
                            }),
                        );
                    }
                    transfer_msg => {
                        Self::handle_transfer_step_locked(
                            &mut guard,
                            conn_id,
                            &user_id,
                            transfer_msg,
                        );
                    }
                }
            }
        }
    }

    /// Removes a disconnected client socket, aborting any in-flight transfer or pending
    /// commands involving the client and broadcasting the updated `DEVICES` list.
    pub fn disconnect_client(&self, conn_id: &str) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lease = Self::remove_client_locked(&mut guard, conn_id, true);
        drop(guard);
        if let Some((user_id, expires)) = lease {
            self.schedule_detached_expiry(user_id, expires);
        }
    }

    fn schedule_detached_expiry(&self, user_id: String, mut deadline: Instant) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let hub = self.clone();
        runtime.spawn(async move {
            loop {
                tokio::time::sleep_until(deadline).await;
                let mut guard = hub
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                Self::expire_playback_lease_locked(&mut guard, &user_id);
                let Some(next) = Self::detached_deadline(&guard, &user_id) else {
                    break;
                };
                deadline = next;
            }
        });
    }

    fn detached_deadline(guard: &HubState, user_id: &str) -> Option<Instant> {
        guard
            .detached_players
            .get(user_id)
            .map(|owner| owner.lease.expires)
            .into_iter()
            .chain(
                guard
                    .transfers_by_user
                    .get(user_id)
                    .filter(|transfer| {
                        transfer.stage == TransferStage::Rollback
                            && transfer.target_playback_until.is_some()
                    })
                    .map(|transfer| transfer.deadline),
            )
            .min()
    }

    pub(crate) fn revoke_sessions(&self, user_id: Option<&str>, matches: impl Fn(&str) -> bool) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let connections: Vec<_> = guard
            .clients
            .values()
            .filter(|client| {
                user_id.is_none_or(|user| client.user_id == user) && matches(&client.session_id)
            })
            .map(|client| client.conn_id.clone())
            .collect();
        let deadlines: Vec<_> = connections
            .into_iter()
            .filter_map(|conn_id| Self::remove_client_locked(&mut guard, &conn_id, false))
            .collect();
        let detached: Vec<_> = guard
            .detached_players
            .iter()
            .filter(|(user, owner)| {
                user_id.is_none_or(|id| user.as_str() == id) && matches(&owner.session_id)
            })
            .map(|(user, _)| user.clone())
            .collect();
        for user in detached {
            if let Some(conn_id) = guard.active_player_by_user.get(&user).cloned() {
                Self::release_player_locked(&mut guard, &user, &conn_id, false);
            }
        }
        drop(guard);
        for (user, deadline) in deadlines {
            self.schedule_detached_expiry(user, deadline);
        }
    }

    fn expire_playback_lease_locked(guard: &mut HubState, user_id: &str) {
        if let Some(transfer) = guard.transfers_by_user.get(user_id)
            && transfer.stage == TransferStage::Rollback
            && transfer.deadline <= Instant::now()
        {
            Self::abort_transfer_locked(guard, user_id, "Playback transfer timed out", true);
        }
        let Some(conn_id) = guard.active_player_by_user.get(user_id).cloned() else {
            return;
        };
        let expires = guard
            .detached_players
            .get(user_id)
            .map(|owner| owner.lease.expires)
            .or_else(|| {
                guard
                    .clients
                    .get(&conn_id)
                    .and_then(|client| client.lease.as_ref())
                    .map(|lease| lease.expires)
            });
        if expires.is_some_and(|expires| expires <= Instant::now()) {
            Self::release_player_locked(guard, user_id, &conn_id, true);
        }
    }

    fn lease_for_client<'a>(
        guard: &'a mut HubState,
        user_id: &str,
        conn_id: &str,
        device_id: &str,
        generation: Uuid,
    ) -> Option<&'a mut PlayerLease> {
        if guard.active_player_by_user.get(user_id).map(String::as_str) != Some(conn_id) {
            return None;
        }
        let client = guard.clients.get_mut(conn_id)?;
        if client.device_id.as_deref() != Some(device_id) {
            return None;
        }
        client
            .lease
            .as_mut()
            .filter(|lease| lease.generation == generation)
    }

    fn select_player_locked(guard: &mut HubState, user_id: &str, conn_id: &str) {
        if !guard.clients.contains_key(conn_id) { return; }
        if let Some(previous) = guard
            .active_player_by_user
            .insert(user_id.to_owned(), conn_id.to_owned())
            && previous != conn_id
            && let Some(client) = guard.clients.get_mut(&previous)
        {
            client.lease = None;
        }
        if let Some(client) = guard.clients.get_mut(conn_id)
            && client.playback_lease && client.lease.is_none() {
            client.lease = Some(PlayerLease::new());
            client.deadline_changed.notify_one();
        }
    }

    fn release_player_locked(guard: &mut HubState, user_id: &str, conn_id: &str, expired: bool) {
        guard.active_player_by_user.remove(user_id);
        guard.detached_players.remove(user_id);
        if guard
            .transfers_by_user
            .get(user_id)
            .is_some_and(|transfer| transfer.source_conn_id == conn_id)
        {
            Self::abort_transfer_locked(
                guard,
                user_id,
                "The active player released ownership",
                false,
            );
        }
        if let Some(client) = guard.clients.get_mut(conn_id) {
            let generation = client.lease.take().map(|lease| lease.generation);
            client.state.playing = false;
            client.must_report_stopped = !expired;
            if expired {
                Self::send_to_client(
                    client,
                    json!({ "type": "PLAYBACK_LEASE_EXPIRED", "leaseGeneration": generation }),
                );
            }
        }
        if let Some(command) = guard.commands.get(user_id).and_then(VecDeque::front)
            .filter(|command| command.target_conn_id == conn_id && command.deadline.is_some()
                && !matches!(command.command, RemoteCommand::SetVolume { .. }))
        {
            Self::expire_command_locked(guard, command);
        } else {
            Self::dispatch_command_locked(guard, user_id);
        }
        Self::broadcast_devices_locked(guard, user_id);
        Self::sync_playback_locked(guard, user_id, None);
        if !guard
            .clients
            .values()
            .any(|client| client.user_id == user_id)
        {
            guard.playback_by_user.remove(user_id);
        }
    }

    fn update_player_locked(
        guard: &mut HubState,
        conn_id: &str,
        user_id: &str,
        mut state: RemotePlaybackState,
        queue: Option<TransferQueueState>,
        clear_queue: bool,
    ) {
        if !state.validate() {
            Self::send_error_locked(guard, conn_id, "Invalid playback state", None);
            return;
        }
        // During handoff, the target starts before the server commits ownership.
        let Some(client) = guard.clients.get(conn_id) else { return };
        let reported_stopped = !state.playing;
        if state.playing
            && (guard
                .active_player_by_user
                .get(user_id)
                .is_some_and(|active| active != conn_id)
                || client.must_report_stopped
                || Self::handoff_blocks_playback(guard, user_id, conn_id))
            && !Self::is_starting_transfer_target(guard, user_id, conn_id)
        {
            state.playing = false;
            Self::send_frame_locked(guard, conn_id, json!({ "type": "DEACTIVATE" }));
        }
        let is_playing = state.playing && state.current_track.is_some();
        if let Some(client) = guard.clients.get_mut(conn_id) {
            if reported_stopped && client.must_report_stopped {
                // Wait for a real stopped report, rather than a rejected playing report.
                client.must_report_stopped = false;
            }
            if let Some(queue) = queue.filter(Self::valid_live_queue) {
                client.queue = Some(Arc::new(queue));
            } else if clear_queue {
                client.queue = None;
            }
            client.state = state;
        }

        if !guard.active_player_by_user.contains_key(user_id)
            && !guard.transfers_by_user.contains_key(user_id)
            && is_playing
        {
            Self::select_player_locked(guard, user_id, conn_id);
        }

        Self::broadcast_devices_locked(guard, user_id);
        Self::sync_playback_locked(guard, user_id, None);
    }

    fn dispatch_command_locked(guard: &mut HubState, user_id: &str) {
        loop {
            let Some(cmd) = guard.commands.get(user_id).and_then(VecDeque::front) else {
                guard.commands.remove(user_id);
                return;
            };
            let now = Instant::now();
            let now_ms = epoch_ms();
            if let Some(deadline) = cmd.deadline {
                if deadline <= now || cmd.expires_at <= now_ms {
                    Self::expire_command_locked(guard, cmd);
                }
                return;
            }
            let expired = cmd.expires <= now || cmd.expires_at <= now_ms;
            let connected = guard.clients.get(&cmd.target_conn_id)
                .is_some_and(|client| !*client.disconnected.borrow());
            let still_active = matches!(cmd.command, RemoteCommand::SetVolume { .. })
                || guard.active_player_by_user.get(user_id) == Some(&cmd.target_conn_id);
            if expired || !connected || !still_active {
                let Some(rejected) = guard.commands.get_mut(user_id).and_then(VecDeque::pop_front) else {
                    return;
                };
                let message = if expired {
                    "Playback command expired in the queue"
                } else if !connected {
                    "The selected device is no longer connected"
                } else {
                    "The selected device is no longer the active player"
                };
                Self::send_error_locked(guard, &rejected.controller_conn_id, message, Some(&rejected.client_request_id));
                continue;
            }
            let Some(cmd) = guard.commands.get_mut(user_id).and_then(VecDeque::front_mut) else {
                return;
            };
            let budget = cmd
                .expires
                .saturating_duration_since(now)
                .min(Duration::from_millis(
                    (cmd.expires_at - now_ms).min(COMMAND_TIMEOUT_MS),
                ));
            cmd.deadline = Some(now + budget);
            let target = cmd.target_conn_id.clone();
            let payload = json!({
                "type": "EXECUTE", "requestId": cmd.id, "command": cmd.command,
                "expiresAt": cmd.expires_at, "deadlineAt": now_ms + budget.as_millis() as u64,
                "timeoutMs": budget.as_millis() as u64,
            });
            if let Some(client) = guard.clients.get(&target) {
                client.deadline_changed.notify_one();
            }
            Self::send_frame_locked(guard, &target, payload);
            return;
        }
    }

    fn expire_command_locked(guard: &HubState, command: &PendingCommand) {
        if let Some(target) = guard.clients.get(&command.target_conn_id) {
            if target.disconnected.send_replace(true) {
                return;
            }
        }
        Self::send_error_locked(
            guard,
            &command.controller_conn_id,
            "Playback command expired during execution",
            Some(&command.client_request_id),
        );
    }

    fn is_starting_transfer_target(guard: &HubState, user_id: &str, conn_id: &str) -> bool {
        guard
            .transfers_by_user
            .get(user_id)
            .is_some_and(|transfer| {
                transfer.target_conn_id == conn_id && transfer.stage == TransferStage::Start
            })
    }

    fn handoff_blocks_playback(guard: &HubState, user_id: &str, conn_id: &str) -> bool {
        guard
            .transfers_by_user
            .get(user_id)
            .is_some_and(|transfer| {
                transfer.stage == TransferStage::Rollback
                    || (transfer.stage == TransferStage::Start
                        && transfer.target_conn_id != conn_id)
            })
    }

    fn source_can_resume(guard: &HubState, user_id: &str, source: &str) -> bool {
        guard.active_player_by_user.get(user_id).map(String::as_str) == Some(source)
            && guard.clients.get(source).is_some_and(|client| {
                !*client.disconnected.borrow()
                    && client
                        .lease
                        .as_ref()
                        .is_none_or(|lease| lease.expires > Instant::now())
            })
    }

    pub(crate) fn operation_deadline(&self, conn_id: &str) -> Option<Instant> {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let client = guard.clients.get(conn_id)?;
        let user_id = &client.user_id;
        guard
            .transfers_by_user
            .get(user_id)
            .filter(|transfer| Self::transfer_deadline_owner(transfer) == conn_id)
            .map(|transfer| transfer.deadline)
            .into_iter()
            .chain(
                guard
                    .commands
                    .get(user_id)
                    .and_then(VecDeque::front)
                    .filter(|cmd| cmd.target_conn_id == conn_id)
                    .and_then(|cmd| cmd.deadline),
            )
            .chain(
                client.lease
                    .as_ref()
                    .map(|lease| lease.expires),
            )
            .min()
    }

    fn transfer_deadline_owner(transfer: &ActiveTransfer) -> &str {
        if transfer.stage == TransferStage::Rollback {
            &transfer.source_conn_id
        } else {
            &transfer.controller_conn_id
        }
    }

    pub(crate) fn expire_operations(&self, conn_id: &str, now: Instant) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(user_id) = guard
            .clients
            .get(conn_id)
            .map(|client| client.user_id.clone())
        else {
            return;
        };
        Self::expire_playback_lease_locked(&mut guard, &user_id);
        if let Some(transfer) = guard.transfers_by_user.get(&user_id)
            && Self::transfer_deadline_owner(transfer) == conn_id
            && transfer.deadline <= now
        {
            let resume_source =
                matches!(transfer.stage, TransferStage::Pause | TransferStage::Start);
            Self::abort_transfer_locked(
                &mut guard,
                &user_id,
                "Playback transfer timed out",
                resume_source,
            );
        }
        if let Some(command) = guard
            .commands
            .get(&user_id)
            .and_then(VecDeque::front)
            .filter(|cmd| {
                cmd.target_conn_id == conn_id
                    && cmd.deadline.is_some_and(|deadline| deadline <= now)
            })
        {
            Self::expire_command_locked(&guard, command);
        }
    }

    fn handle_transfer_step_locked(
        guard: &mut HubState,
        conn_id: &str,
        user_id: &str,
        message: RemoteClientMessage,
    ) {
        let msg_transfer_id = match &message {
            RemoteClientMessage::Snapshot { transfer_id, .. }
            | RemoteClientMessage::Ready { transfer_id }
            | RemoteClientMessage::SourcePaused { transfer_id, .. }
            | RemoteClientMessage::Started { transfer_id, .. }
            | RemoteClientMessage::TransferFailed { transfer_id, .. }
            | RemoteClientMessage::TransferRolledBack { transfer_id } => transfer_id.as_str(),
            _ => return,
        };

        let Some(transfer) = guard.transfers_by_user.get(user_id)
            .filter(|transfer| transfer.id == msg_transfer_id) else {
            Self::send_error_locked(guard, conn_id, "Stale playback transfer", None);
            return;
        };
        if conn_id != transfer.source_conn_id && conn_id != transfer.target_conn_id {
            Self::send_error_locked(guard, conn_id, "Not a participant in this transfer", None);
            return;
        }
        if transfer.deadline <= Instant::now() {
            let resume = matches!(transfer.stage, TransferStage::Pause | TransferStage::Start);
            Self::abort_transfer_locked(guard, user_id, "Playback transfer timed out", resume);
            return;
        }
        if transfer.stage == TransferStage::Rollback {
            if matches!(message, RemoteClientMessage::TransferRolledBack { .. })
                && conn_id == transfer.target_conn_id
            {
                let Some(transfer) = guard.transfers_by_user.remove(user_id) else { return };
                let detail = transfer
                    .failure
                    .as_deref()
                    .unwrap_or("Playback transfer cancelled");
                let resume = Self::source_can_resume(guard, user_id, &transfer.source_conn_id);
                Self::finish_transfer_abort(guard, &transfer, detail, resume);
            }
            return;
        }

        match message {
            RemoteClientMessage::TransferFailed { message: msg, .. } => {
                let resume_source = conn_id == transfer.target_conn_id
                    && matches!(transfer.stage, TransferStage::Pause | TransferStage::Start);
                Self::abort_transfer_locked(guard, user_id, &msg, resume_source);
            }
            RemoteClientMessage::Snapshot { snapshot, .. } => {
                if !snapshot.validate() {
                    Self::send_error_locked(guard, conn_id, "Invalid remote message", None);
                    return;
                }
                let target_conn_opt = {
                    let Some(t) = guard.transfers_by_user.get_mut(user_id) else { return };
                    if conn_id == t.source_conn_id && t.stage == TransferStage::Snapshot {
                        t.snapshot = Some(snapshot.clone());
                        t.stage = TransferStage::Prepare;
                        Some((t.target_conn_id.clone(), t.id.clone()))
                    } else {
                        None
                    }
                };
                if let Some((target_conn, tid)) = target_conn_opt {
                    Self::send_frame_locked(
                        guard,
                        &target_conn,
                        json!({
                            "type": "INITIALIZE_PLAYER",
                            "transferId": tid,
                            "snapshot": snapshot,
                        }),
                    );
                } else {
                    Self::send_error_locked(
                        guard,
                        conn_id,
                        "Unexpected playback transfer acknowledgement",
                        None,
                    );
                }
            }
            RemoteClientMessage::Ready { .. } => {
                let playback_until = guard.clients.get(conn_id)
                    .is_some_and(|client| client.playback_lease)
                    .then(|| Instant::now() + Duration::from_millis(PLAYBACK_LEASE_MS));
                let source_conn_opt = {
                    let Some(t) = guard.transfers_by_user.get_mut(user_id) else { return };
                    if conn_id == t.target_conn_id && t.stage == TransferStage::Prepare {
                        t.stage = TransferStage::Pause;
                        t.target_playback_until = playback_until;
                        Some((t.source_conn_id.clone(), t.id.clone()))
                    } else {
                        None
                    }
                };
                if let Some((source_conn, tid)) = source_conn_opt {
                    Self::send_frame_locked(
                        guard,
                        &source_conn,
                        json!({
                            "type": "PAUSE_FOR_TRANSFER",
                            "transferId": tid,
                        }),
                    );
                } else {
                    Self::send_error_locked(
                        guard,
                        conn_id,
                        "Unexpected playback transfer acknowledgement",
                        None,
                    );
                }
            }
            RemoteClientMessage::SourcePaused { snapshot, .. } => {
                if !snapshot.validate() {
                    Self::send_error_locked(guard, conn_id, "Invalid remote message", None);
                    return;
                }
                let step = {
                    let Some(t) = guard.transfers_by_user.get_mut(user_id) else { return };
                    if conn_id == t.source_conn_id && t.stage == TransferStage::Pause {
                        let drifted = t.snapshot.as_ref().is_none_or(|prev| {
                            prev.track_id != snapshot.track_id
                                || serde_json::to_string(&prev.queue_state).ok()
                                    != serde_json::to_string(&snapshot.queue_state).ok()
                        });
                        t.snapshot = Some(snapshot.clone());
                        if drifted
                            || t.target_playback_until
                                .is_some_and(|until| until <= Instant::now())
                        {
                            Some(Err(()))
                        } else {
                            t.stage = TransferStage::Start;
                            if let Some(until) = t.target_playback_until {
                                t.deadline = t.deadline.min(until);
                            }
                            Some(Ok((
                                t.target_conn_id.clone(),
                                t.id.clone(),
                                t.target_playback_until.is_some(),
                            )))
                        }
                    } else {
                        None
                    }
                };

                match step {
                    Some(Ok((target_conn, tid, bounded))) => {
                        if let Some(controller) = guard.transfers_by_user.get(user_id)
                            .and_then(|transfer| guard.clients.get(&transfer.controller_conn_id))
                        {
                            controller.deadline_changed.notify_one();
                        }
                        if let Some(source) = guard.clients.get_mut(conn_id) {
                            source.state.playing = false;
                        }
                        Self::broadcast_devices_locked(guard, user_id);
                        Self::sync_playback_locked(guard, user_id, None);
                        Self::send_frame_locked(
                            guard,
                            &target_conn,
                            json!({
                                "type": "START_TRANSFER",
                                "transferId": tid,
                                "snapshot": snapshot,
                                "playbackLeaseMs": bounded.then_some(PLAYBACK_LEASE_MS),
                            }),
                        );
                    }
                    Some(Err(())) => {
                        Self::abort_transfer_locked(
                            guard,
                            user_id,
                            "The active track changed during transfer. Try transferring again",
                            true,
                        );
                    }
                    None => {
                        Self::send_error_locked(
                            guard,
                            conn_id,
                            "Unexpected playback transfer acknowledgement",
                            None,
                        );
                    }
                }
            }
            RemoteClientMessage::Started { queue, .. } => {
                let Some(entry) = transfer.snapshot.as_ref().filter(|snapshot| {
                    transfer.target_conn_id == conn_id && transfer.stage == TransferStage::Start
                        && snapshot.track_id == snapshot.queue_state.entries.get(snapshot.queue_state.index)
                            .map_or("", |entry| entry.track_id.as_str())
                }).and_then(|snapshot| snapshot.queue_state.entries.get(snapshot.queue_state.index)).cloned() else {
                    Self::send_error_locked(guard, conn_id, "Unexpected playback transfer acknowledgement", None);
                    return;
                };
                let Some(transfer) = guard.transfers_by_user.remove(user_id) else { return };
                let Some(snapshot) = transfer.snapshot.as_ref() else { return };

                Self::select_player_locked(guard, user_id, &transfer.target_conn_id);

                let source = guard.clients.get(&transfer.source_conn_id);
                let source_duration = source.map_or(0.0, |c| c.state.duration_ms);
                let source_track = source
                    .and_then(|c| c.state.current_track.clone())
                    .filter(|track| track.id == snapshot.track_id);

                if let Some(src) = guard.clients.get_mut(&transfer.source_conn_id) {
                    src.state.playing = false;
                }

                if let Some(tgt) = guard.clients.get_mut(&transfer.target_conn_id) {
                    let dur = if tgt.state.duration_ms > 0.0 {
                        tgt.state.duration_ms
                    } else {
                        source_duration
                    };
                    tgt.state = RemotePlaybackState {
                        current_track: Some(source_track.unwrap_or_else(|| RemoteTrackSummary {
                            id: snapshot.track_id.clone(),
                            title: entry.title,
                            artist: Some(entry.artist),
                            album: Some(entry.album),
                            cover_art: None,
                        })),
                        position_ms: snapshot.exact_position_ms,
                        duration_ms: dur,
                        playing: snapshot.playing,
                        volume: snapshot.volume,
                    };
                    // The receiving device reports its own queue with its local occurrence IDs.
                    tgt.queue = queue.filter(Self::valid_live_queue).map(Arc::new);
                }

                Self::send_frame_locked(
                    guard,
                    &transfer.source_conn_id,
                    json!({
                        "type": "TRANSFER_COMPLETE",
                        "transferId": transfer.id,
                    }),
                );
                Self::send_frame_locked(
                    guard,
                    &transfer.target_conn_id,
                    json!({
                        "type": "TRANSFER_COMPLETE",
                        "transferId": transfer.id,
                    }),
                );
                Self::send_frame_locked(
                    guard,
                    &transfer.controller_conn_id,
                    json!({
                        "type": "TRANSFER_RESULT",
                        "requestId": transfer.request_id,
                        "ok": true,
                    }),
                );
                Self::broadcast_devices_locked(guard, user_id);
                Self::sync_playback_locked(guard, user_id, None);
            }
            _ => {}
        }
    }

    fn abort_transfer_locked(
        guard: &mut HubState,
        user_id: &str,
        message: &str,
        resume_source: bool,
    ) {
        let Some(mut transfer) = guard.transfers_by_user.remove(user_id) else {
            return;
        };

        let should_resume = resume_source && transfer.snapshot.as_ref().is_some_and(|s| s.playing);
        let source_still_owns = Self::source_can_resume(guard, user_id, &transfer.source_conn_id);

        if transfer.stage != TransferStage::Rollback {
            Self::send_frame_locked(
                guard,
                &transfer.target_conn_id,
                json!({
                    "type": "ABORT_TRANSFER", "transferId": transfer.id,
                }),
            );
        }
        if transfer.stage == TransferStage::Pause
            && !guard.clients.contains_key(&transfer.target_conn_id)
        {
            Self::finish_transfer_abort(
                guard,
                &transfer,
                message,
                should_resume && source_still_owns,
            );
            return;
        }
        if matches!(
            transfer.stage,
            TransferStage::Start | TransferStage::Rollback
        ) && let Some(until) = transfer.target_playback_until
        {
            if until > Instant::now() {
                // A disconnected target may still be audible. Retain the fence
                // even if neither participant has a socket to acknowledge rollback.
                transfer.stage = TransferStage::Rollback;
                transfer.deadline = until;
                transfer.failure.get_or_insert_with(|| message.to_owned());
                if let Some(source) = guard.clients.get(&transfer.source_conn_id) {
                    source.deadline_changed.notify_one();
                }
                guard.transfers_by_user.insert(user_id.to_owned(), transfer);
            } else {
                let detail = transfer.failure.as_deref().unwrap_or(message);
                Self::finish_transfer_abort(
                    guard,
                    &transfer,
                    detail,
                    transfer
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.playing)
                        && source_still_owns,
                );
            }
            return;
        }
        if should_resume
            && transfer.stage != TransferStage::Rollback
            && guard.clients.contains_key(&transfer.target_conn_id)
            && let Some(source) = guard.clients.get(&transfer.source_conn_id)
        {
            transfer.stage = TransferStage::Rollback;
            transfer.deadline = Instant::now() + ROLLBACK_TIMEOUT;
            transfer.failure = Some(message.to_owned());
            source.deadline_changed.notify_one();
            guard.transfers_by_user.insert(user_id.to_owned(), transfer);
            return;
        }
        Self::finish_transfer_abort(guard, &transfer, message, false);
    }

    fn finish_transfer_abort(
        guard: &HubState,
        transfer: &ActiveTransfer,
        message: &str,
        resume_source: bool,
    ) {
        Self::send_frame_locked(
            guard,
            &transfer.source_conn_id,
            json!({
                "type": "ABORT_TRANSFER",
                "transferId": transfer.id,
                "resume": resume_source,
            }),
        );

        let detail = if !resume_source
            && matches!(
                transfer.stage,
                TransferStage::Pause | TransferStage::Start | TransferStage::Rollback
            ) {
            format!("{message}. Check both devices and resume manually if needed.")
        } else {
            message.to_owned()
        };

        Self::send_frame_locked(
            guard,
            &transfer.controller_conn_id,
            json!({
                "type": "TRANSFER_RESULT",
                "requestId": transfer.request_id,
                "ok": false,
                "message": detail,
            }),
        );
    }

    fn remove_client_locked(
        guard: &mut HubState,
        conn_id: &str,
        keep_lease: bool,
    ) -> Option<(String, Instant)> {
        let removed = guard.clients.remove(conn_id)?;
        let user_id = removed.user_id;
        removed.disconnected.send_replace(true);

        let paused_transfer = guard.transfers_by_user.get(&user_id)
            .filter(|transfer| transfer.source_conn_id == conn_id
                && matches!(transfer.stage, TransferStage::Pause | TransferStage::Start | TransferStage::Rollback)
                && transfer.snapshot.as_ref().is_some_and(|snapshot| snapshot.playing))
            .map(|transfer| transfer.id.clone());
        if let Some(transfer) = guard.transfers_by_user.get(&user_id)
            && (transfer.source_conn_id == conn_id
                || transfer.target_conn_id == conn_id
                || (transfer.controller_conn_id == conn_id
                    && transfer.stage != TransferStage::Rollback))
        {
            let resume_source = transfer.source_conn_id != conn_id
                && matches!(transfer.stage, TransferStage::Pause | TransferStage::Start);
            Self::abort_transfer_locked(
                guard,
                &user_id,
                "A participating device disconnected",
                resume_source,
            );
        }

        let mut lost_targets = Vec::new();
        if let Some(commands) = guard.commands.get_mut(&user_id) {
            commands.retain(|cmd| {
                if cmd.target_conn_id == conn_id {
                    lost_targets.push((
                        cmd.controller_conn_id.clone(),
                        cmd.client_request_id.clone(),
                    ));
                    return false;
                }
                // A controller may close after its command was sent. Keep its place
                // until the target acknowledges it so subsequent commands stay ordered.
                cmd.controller_conn_id != conn_id || cmd.deadline.is_some()
            });
        }
        for (controller, request) in lost_targets {
            Self::send_error_locked(
                guard,
                &controller,
                "The player disconnected",
                Some(&request),
            );
        }
        Self::dispatch_command_locked(guard, &user_id);

        if guard
            .active_player_by_user
            .get(&user_id)
            .is_some_and(|id| id == conn_id)
        {
            if keep_lease
                && let Some(device_id) = removed.device_id
                && let Some(lease) = removed.lease.filter(|lease| lease.expires > Instant::now())
            {
                guard.detached_players.insert(
                    user_id.clone(),
                    DetachedPlayer {
                        session_id: removed.session_id,
                        device_id,
                        lease,
                        state: removed.state,
                        queue: removed.queue,
                        paused_transfer,
                    },
                );
            } else {
                guard.active_player_by_user.remove(&user_id);
            }
        }

        Self::broadcast_devices_locked(guard, &user_id);
        Self::sync_playback_locked(guard, &user_id, None);
        let deadline =
            Self::detached_deadline(guard, &user_id).map(|until| (user_id.clone(), until));
        if deadline.is_none()
            && !guard
                .clients
                .values()
                .any(|client| client.user_id == user_id)
        {
            guard.playback_by_user.remove(&user_id);
        }
        deadline
    }

    /// Notifies other queue-aware devices that a committed account snapshot changed.
    pub fn queue_changed(&self, user_id: &str, device_id: &str) {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let shared_device = guard
            .clients
            .values()
            .filter(|client| {
                client.user_id == user_id && client.queue_device_id.as_deref() == Some(device_id)
            })
            .take(2)
            .count()
            == 2;
        for client in guard.clients.values().filter(|client| {
            client.user_id == user_id
                && client
                    .queue_device_id
                    .as_deref()
                    .is_some_and(|id| id != device_id || shared_device)
        }) {
            let _ = client.tx.try_send(json!({ "type": "QUEUE_CHANGED" }));
        }
    }

    fn valid_live_queue(queue: &TransferQueueState) -> bool {
        if queue.entries.len() > 5000
            || (!queue.entries.is_empty() && queue.index >= queue.entries.len())
        {
            return false;
        }
        let mut ids = std::collections::HashSet::with_capacity(queue.entries.len());
        queue.entries.iter().all(|entry| {
            !entry.occurrence_id.is_empty()
                && entry.occurrence_id.len() <= 160
                && ids.insert(&entry.occurrence_id)
                && !entry.track_id.is_empty()
                && entry.track_id.len() <= 1024
                && (0.0..=604_800.0).contains(&entry.duration)
        })
    }

    fn sync_playback_locked(guard: &mut HubState, user_id: &str, initialize: Option<&str>) {
        let player = guard
            .active_player_by_user
            .get(user_id)
            .and_then(|id| guard.clients.get(id));
        let detached = guard.detached_players.get(user_id);
        let state = player
            .map(|client| &client.state)
            .or_else(|| detached.map(|lease| &lease.state));
        let current_id = state
            .and_then(|state| state.current_track.as_ref())
            .map(|track| track.id.as_str());
        let queue = player
            .and_then(|client| client.queue.clone())
            .or_else(|| detached.and_then(|lease| lease.queue.clone()))
            .filter(|queue| {
                queue
                    .entries
                    .get(queue.index)
                    .map(|entry| entry.track_id.as_str())
                    == current_id
            });
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let previous = guard.playback_by_user.get(user_id);
        let queue_changed = previous.is_none_or(|old| match (&old.queue, &queue) {
            (Some(old), Some(next)) => !Arc::ptr_eq(old, next) && old != next,
            (None, None) => false,
            _ => true,
        });
        let device_id = player
            .and_then(|client| client.device_id.clone())
            .or_else(|| detached.map(|lease| lease.device_id.clone()));
        let track = state.and_then(|state| state.current_track.clone());
        let position_ms = state.map_or(0.0, |state| state.position_ms);
        let duration_ms = state.map_or(0.0, |state| state.duration_ms);
        let is_playing = state.is_some_and(|state| state.playing);
        let volume = state.map_or(1.0, |state| state.volume as f32);
        let changed = queue_changed
            || previous.is_none_or(|old| {
                old.device_id != device_id
                    || old.track != track
                    || old.position_ms != position_ms
                    || old.duration_ms != duration_ms
                    || old.is_playing != is_playing
                    || old.volume != volume
            });
        if changed {
            let revision = previous.map_or(1, |old| old.revision + 1);
            guard.playback_by_user.insert(
                user_id.to_owned(),
                PlaybackState {
                    device_id,
                    track,
                    position_ms,
                    duration_ms,
                    is_playing,
                    volume,
                    updated_at: now,
                    revision,
                    queue,
                },
            );
        }
        let Some(playback) = guard.playback_by_user.get(user_id) else { return };
        let owner = guard
            .active_player_by_user
            .get(user_id)
            .and_then(|id| guard.clients.get(id));
        let generation = |conn_id: &str| {
            owner
                .filter(|owner| owner.conn_id == conn_id)
                .and_then(|owner| owner.lease.as_ref())
                .map(|lease| lease.generation)
        };
        if let Some(conn_id) = initialize {
            let supports_watchdog = guard
                .clients
                .get(conn_id)
                .is_some_and(|client| client.command_deadlines);
            Self::send_frame_locked(
                guard,
                conn_id,
                json!({
                    "type": "INITIAL_STATE", "state": playback, "server_time": now,
                    "queue": playback.queue.as_deref(),
                    "controlTimeoutMs": supports_watchdog.then_some(25_000),
                    "playbackLeaseMs": guard.clients.get(conn_id).is_some_and(|client| client.playback_lease)
                        .then_some(PLAYBACK_LEASE_MS),
                    "playbackLeaseProtocol": guard.clients.get(conn_id).is_some_and(|client| client.playback_lease)
                        .then_some(1),
                    "leaseGeneration": generation(conn_id),
                    "leaseServerId": guard.server_id,
                }),
            );
        }
        if changed {
            let mut payload =
                json!({ "type": "STATE_SYNC", "state": playback, "server_time": now });
            if queue_changed {
                payload["queue"] = json!(playback.queue.as_deref());
            }
            for client in guard.clients.values().filter(|c| {
                c.user_id == user_id && c.live_sync && Some(c.conn_id.as_str()) != initialize
            }) {
                let mut frame = payload.clone();
                if let Some(generation) = generation(&client.conn_id) {
                    frame["leaseGeneration"] = json!(generation);
                }
                Self::send_to_client(client, frame);
            }
        }
    }

    fn broadcast_devices_locked(guard: &HubState, user_id: &str) {
        let active_conn = guard.active_player_by_user.get(user_id).map(String::as_str);
        let peers: Vec<&ConnectedClient> = guard
            .clients
            .values()
            .filter(|c| c.user_id == user_id && c.device_id.is_some())
            .collect();

        let devices: Vec<Value> = peers
            .iter()
            .map(|c| {
                json!({
                    "device_id": c.device_id,
                    "queue_device_id": c.queue_device_id,
                    "device_name": c.device_name,
                    "device_type": c.device_type,
                    "is_active_player": active_conn == Some(c.conn_id.as_str()),
                    "can_receive": c.can_receive,
                    "current_track": c.state.current_track,
                    "position_ms": c.state.position_ms,
                    "duration_ms": c.state.duration_ms,
                    "playing": c.state.playing,
                    "volume": c.state.volume,
                })
            })
            .collect();

        let payload = json!({
            "type": "DEVICES",
            "devices": devices,
            "live_state_protocol": true,
        });

        for peer in peers {
            Self::send_to_client(peer, payload.clone());
        }
    }

    fn send_error_locked(guard: &HubState, conn_id: &str, message: &str, request_id: Option<&str>) {
        let mut obj = json!({
            "type": "ERROR",
            "message": message,
        });
        if let Some(req_id) = request_id
            && let Value::Object(ref mut map) = obj
        {
            map.insert(String::from("requestId"), Value::String(req_id.to_owned()));
        }
        Self::send_frame_locked(guard, conn_id, obj);
    }

    fn send_frame_locked(guard: &HubState, conn_id: &str, payload: Value) {
        if let Some(client) = guard.clients.get(conn_id) {
            Self::send_to_client(client, payload);
        }
    }

    fn send_to_client(client: &ConnectedClient, payload: Value) {
        if client.tx.try_send(payload).is_err() {
            client.disconnected.send_replace(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarted_hub_accepts_the_inflight_owner_only_while_uncontested() {
        let register = |device: &str, last: Option<&Value>| {
            serde_json::from_value(json!({
                "type": "REGISTER", "device_id": device, "device_type": "web", "device_name": device,
                "can_receive": true, "live_sync": true, "playback_lease": true, "playbackLeaseProtocol": 1,
                "leaseGeneration": last.map(|frame| &frame["leaseGeneration"]),
                "leaseServerId": last.map(|frame| &frame["leaseServerId"]),
                "state": {"playing": true, "current_track": {"id": "track", "title": "Track"},
                    "position_ms": 1000, "duration_ms": 100000, "volume": 1}
            })).unwrap()
        };
        let previous = RemoteControlHub::new();
        let (source, mut frames) = previous.connect_client("alice", "player-session", 0).unwrap();
        previous.handle_message(&source, register("desk", None));
        let initial = std::iter::from_fn(|| frames.try_recv().ok())
            .find(|frame| frame["type"] == "INITIAL_STATE").unwrap();

        let restarted = RemoteControlHub::new();
        let (source, mut frames) = restarted.connect_client("alice", "player-session", 0).unwrap();
        restarted.handle_message(&source, register("desk", Some(&initial)));
        let frames: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok()).collect();
        assert!(!frames.iter().any(|frame| frame["type"] == "DEACTIVATE"));
        let active = frames.iter().find(|frame| frame["type"] == "INITIAL_STATE").unwrap();
        assert_ne!(active["leaseServerId"], initial["leaseServerId"]);
        assert_ne!(active["leaseGeneration"], initial["leaseGeneration"]);
        assert_eq!(active["state"]["is_playing"], true);

        let (other, mut frames) = restarted.connect_client("alice", "other-session", 0).unwrap();
        restarted.handle_message(&other, register("phone", Some(&initial)));
        assert!(std::iter::from_fn(|| frames.try_recv().ok()).any(|frame| frame["type"] == "DEACTIVATE"));
    }

    #[test]
    fn queued_commands_and_reordered_acknowledgements_cannot_outlive_their_deadlines() {
        let hub = RemoteControlHub::new();
        let send =
            |conn: &str, frame| hub.handle_message(conn, serde_json::from_value(frame).unwrap());
        let register = |device: &str| {
            let (conn, rx) = hub.connect_client("alice", device, 0).unwrap();
            send(
                &conn,
                json!({
                    "type": "REGISTER", "device_id": device, "device_name": device,
                    "device_type": "computer", "can_receive": true, "command_deadlines": true,
                    "state": RemotePlaybackState::default(),
                }),
            );
            (conn, rx)
        };
        let (desk, mut desk_rx) = register("desk");
        let (phone, mut phone_rx) = register("phone");
        send(
            &desk,
            json!({ "type": "STATE", "state": {
                "current_track": { "id": "track", "title": "Track" }, "position_ms": 0.0,
                "duration_ms": 60_000.0, "playing": true, "volume": 1.0,
            }}),
        );
        let receive = |rx: &mut mpsc::Receiver<Value>, name: &str| loop {
            let frame = rx.try_recv().unwrap();
            if frame["type"] == name {
                break frame;
            }
        };
        let command = |request_id, expires| {
            send(
                &phone,
                json!({
                    "type": "COMMAND", "requestId": request_id, "expiresAt": expires,
                    "command": { "type": "PAUSE" },
                }),
            )
        };
        command("admission-expired", epoch_ms().saturating_sub(1));
        assert_eq!(
            receive(&mut phone_rx, "ERROR")["requestId"],
            "admission-expired"
        );
        send(&phone, json!({
            "type": "COMMAND", "requestId": "invalid-skip", "command": { "type": "SKIP", "direction": "sideways" },
        }));
        assert_eq!(receive(&mut phone_rx, "ERROR")["requestId"], "invalid-skip");
        command("first", epoch_ms() + 10_000);
        command("queued", epoch_ms() + 10_000);
        let first = receive(&mut desk_rx, "EXECUTE");
        {
            let mut state = hub.state.lock().unwrap();
            state.commands.get_mut("alice").unwrap()[1].expires = Instant::now();
        }
        send(
            &desk,
            json!({
                "type": "COMMAND_RESULT", "requestId": first["requestId"], "expiresAt": 1, "ok": true,
            }),
        );
        assert_eq!(
            receive(&mut desk_rx, "ERROR")["message"],
            "Unknown command acknowledgement"
        );
        send(
            &desk,
            json!({
                "type": "COMMAND_RESULT", "requestId": first["requestId"],
                "expiresAt": first["expiresAt"], "ok": true,
            }),
        );
        assert_eq!(
            receive(&mut phone_rx, "COMMAND_RESULT")["requestId"],
            "first"
        );
        assert_eq!(receive(&mut phone_rx, "ERROR")["requestId"], "queued");
        assert!(desk_rx.try_recv().is_err());

        command("late", epoch_ms() + 10_000);
        let late = receive(&mut desk_rx, "EXECUTE");
        {
            let mut state = hub.state.lock().unwrap();
            state.commands.get_mut("alice").unwrap()[0].deadline = Some(Instant::now());
        }
        let disconnected = hub.disconnect_signal(&desk).unwrap();
        send(
            &desk,
            json!({
                "type": "COMMAND_RESULT", "requestId": late["requestId"],
                "expiresAt": late["expiresAt"], "ok": true,
            }),
        );
        assert_eq!(receive(&mut phone_rx, "ERROR")["requestId"], "late");
        assert!(*disconnected.borrow());
    }

    #[test]
    fn rollback_requires_the_target_confirmation_before_the_source_can_resume() {
        let hub = RemoteControlHub::new();
        let (source, mut source_rx) = hub.connect_client("alice", "desk", 0).unwrap();
        let (target, mut target_rx) = hub.connect_client("alice", "phone", 0).unwrap();
        let send =
            |conn: &str, frame| hub.handle_message(conn, serde_json::from_value(frame).unwrap());
        let register = |conn, device| {
            send(
                conn,
                json!({
                    "type": "REGISTER", "device_id": device, "device_name": device,
                    "device_type": "computer", "can_receive": true, "state": RemotePlaybackState::default(),
                }),
            )
        };
        register(&source, "desk");
        register(&target, "phone");
        while source_rx.try_recv().is_ok() {}
        while target_rx.try_recv().is_ok() {}
        {
            let mut state = hub.state.lock().unwrap();
            state.active_player_by_user.insert("alice".into(), source.clone());
            state.transfers_by_user.insert("alice".into(), ActiveTransfer {
                id: "transfer".into(),
                request_id: "switch".into(),
                controller_conn_id: source.clone(),
                source_conn_id: source.clone(),
                target_conn_id: target.clone(),
                stage: TransferStage::Start,
                deadline: Instant::now() + Duration::from_secs(10),
                target_playback_until: None,
                failure: None,
                snapshot: Some(serde_json::from_value(json!({
                    "trackId": "track", "exactPositionMs": 1000, "volume": 1.0, "playing": true,
                    "queueState": { "entries": [], "index": 0, "repeatOne": false, "shuffle": false,
                        "shuffleMode": "standard", "shuffleSeed": null, "albumAware": false, "context": null },
                })).unwrap()),
            });
        }
        send(
            &target,
            json!({ "type": "TRANSFER_FAILED", "transferId": "transfer", "message": "The target failed" }),
        );
        assert_eq!(target_rx.try_recv().unwrap()["type"], "ABORT_TRANSFER");
        assert!(source_rx.try_recv().is_err());
        send(
            &source,
            json!({ "type": "TRANSFER_ROLLED_BACK", "transferId": "transfer" }),
        );
        assert!(source_rx.try_recv().is_err());
        send(
            &target,
            json!({ "type": "TRANSFER_ROLLED_BACK", "transferId": "transfer" }),
        );
        assert_eq!(source_rx.try_recv().unwrap()["resume"], true);
        assert_eq!(source_rx.try_recv().unwrap()["ok"], false);
    }

    #[tokio::test]
    async fn disconnected_handoff_target_blocks_resume_until_its_provisional_lease_expires() {
        let hub = RemoteControlHub::new();
        let (source, mut source_rx) = hub.connect_client("alice", "source-session", 0).unwrap();
        let (target, _target_rx) = hub.connect_client("alice", "target-session", 0).unwrap();
        let safe_after = Instant::now() + Duration::from_millis(PLAYBACK_LEASE_MS);
        {
            let mut state = hub.state.lock().unwrap();
            state.active_player_by_user.insert("alice".into(), source.clone());
            state.transfers_by_user.insert("alice".into(), ActiveTransfer {
                id: "transfer".into(), request_id: "switch".into(), controller_conn_id: source.clone(),
                source_conn_id: source.clone(), target_conn_id: target.clone(), stage: TransferStage::Start,
                deadline: safe_after, target_playback_until: Some(safe_after), failure: None,
                snapshot: Some(serde_json::from_value(json!({
                    "trackId": "track", "exactPositionMs": 1000, "volume": 1.0, "playing": true,
                    "queueState": { "entries": [], "index": 0, "repeatOne": false, "shuffle": false,
                        "shuffleMode": "standard", "shuffleSeed": null, "albumAware": false, "context": null },
                })).unwrap()),
            });
        }
        hub.disconnect_client(&target);
        assert!(source_rx.try_recv().is_err());
        hub.handle_message(&target, serde_json::from_value(json!({
            "type": "STARTED", "transferId": "transfer",
        })).unwrap());
        {
            let mut state = hub.state.lock().unwrap();
            let handoff = state.transfers_by_user.get_mut("alice").unwrap();
            assert_eq!(handoff.stage, TransferStage::Rollback);
            assert_eq!(handoff.deadline, safe_after);
            handoff.deadline = Instant::now();
            handoff.target_playback_until = Some(handoff.deadline);
        }
        hub.expire_operations(&source, Instant::now());
        assert_eq!(source_rx.try_recv().unwrap()["resume"], true);
        assert_eq!(source_rx.try_recv().unwrap()["ok"], false);
        assert!(hub.state.lock().unwrap().transfers_by_user.is_empty());
    }

    #[test]
    fn explicit_session_revocation_clears_detached_ownership_immediately() {
        let hub = RemoteControlHub::new();
        let (owner, _owner_rx) = hub.connect_client("alice", "revoked", 0).unwrap();
        let register = |conn: &str, device: &str| {
            hub.handle_message(conn, serde_json::from_value(json!({
                "type": "REGISTER", "device_id": device, "device_name": device,
                "device_type": "computer", "can_receive": true, "playback_lease": true, "playbackLeaseProtocol": 1, "live_sync": true,
                "state": { "current_track": { "id": "track", "title": "Track" },
                    "position_ms": 0, "duration_ms": 10000, "playing": true, "volume": 1 },
            })).unwrap());
        };
        register(&owner, "desk");
        hub.disconnect_client(&owner);
        assert!(hub.state.lock().unwrap().detached_players.contains_key("alice"));
        crate::auth::SessionEventBus::default()
            .with_remote_hub(hub.clone())
            .publish(crate::auth::SessionEvent::SessionRevoked {
                session_id: "revoked".into(),
            });
        let (second, _second_rx) = hub.connect_client("alice", "valid", 0).unwrap();
        register(&second, "phone");
        assert_eq!(hub.state.lock().unwrap().active_player_by_user["alice"], second);
    }

    #[test]
    fn live_state_is_account_scoped_and_commands_commit_in_arrival_order() {
        let hub = RemoteControlHub::new();
        let register = |user: &str, device: &str| {
            let (conn, rx) = hub.connect_client(user, device, 0).unwrap();
            hub.handle_message(
                &conn,
                serde_json::from_value(json!({
                    "type": "REGISTER", "device_id": device, "device_name": device,
                    "device_type": "computer", "can_receive": true, "live_sync": true,
                    "state": RemotePlaybackState::default()
                }))
                .unwrap(),
            );
            (conn, rx)
        };
        let send =
            |conn: &str, frame| hub.handle_message(conn, serde_json::from_value(frame).unwrap());
        let receive = |rx: &mut mpsc::Receiver<Value>, kind: &str| loop {
            let frame = rx.try_recv().unwrap();
            if frame["type"] == kind {
                break frame;
            }
        };
        let (desktop, mut audio) = register("alice", "desktop");
        let (phone, mut controller) = register("alice", "phone");
        let (_, mut outsider) = register("bob", "other");
        assert!(receive(&mut outsider, "INITIAL_STATE")["state"]["device_id"].is_null());
        assert!(receive(&mut controller, "INITIAL_STATE")["state"]["device_id"].is_null());
        let state = |track_id, position_ms, playing| {
            json!({
                "current_track": { "id": track_id, "title": "Song" },
                "position_ms": position_ms, "duration_ms": 60000, "playing": playing, "volume": 0.5,
            })
        };
        let queue = json!({
            "entries": [
                { "occurrenceId": "entry", "trackId": "one", "title": "Song", "artist": "", "album": "", "duration": 60.0 },
                { "occurrenceId": "next", "trackId": "two", "title": "Song", "artist": "", "album": "", "duration": 60.0, "unshuffledIndex": 1 },
            ],
            "index": 0, "repeatOne": false, "loopPlaylistId": "playlist-1", "shuffle": true, "shuffleMode": "standard",
            "shuffleSeed": null, "albumAware": false, "context": null,
        });
        send(
            &desktop,
            json!({ "type": "STATE", "state": state("one", 1000, true), "queue": queue }),
        );
        let first = receive(&mut controller, "STATE_SYNC");
        assert_eq!(first["state"]["device_id"], "desktop");
        assert_eq!(first["queue"], queue);
        assert!(outsider.try_recv().is_err());

        send(&phone, json!({ "type": "COMMAND", "requestId": "loop", "command": {
            "type": "SET_PLAYLIST_LOOP", "playlist_id": "playlist-1", "enabled": true,
        } }));
        let loop_command = receive(&mut audio, "EXECUTE");
        assert_eq!(loop_command["command"]["playlist_id"], "playlist-1");
        assert_eq!(loop_command["command"]["enabled"], true);
        send(&desktop, json!({ "type": "COMMAND_RESULT", "requestId": loop_command["requestId"],
            "ok": true, "state": state("one", 1000, true) }));

        send(
            &phone,
            json!({ "type": "COMMAND", "requestId": "skip", "command": { "type": "SKIP", "direction": "next" } }),
        );
        send(
            &desktop,
            json!({ "type": "COMMAND", "requestId": "pause", "command": { "type": "PAUSE" } }),
        );
        let skip = receive(&mut audio, "EXECUTE");
        assert_eq!(skip["command"]["type"], "SKIP");
        assert!(audio.try_recv().is_err());
        let mut next_queue = queue.clone();
        next_queue["index"] = json!(1);
        send(
            &desktop,
            json!({ "type": "STATE", "state": state("two", 0, true), "queue": next_queue }),
        );
        send(
            &desktop,
            json!({ "type": "COMMAND_RESULT", "requestId": skip["requestId"], "ok": true, "state": state("two", 0, true) }),
        );
        let second = receive(&mut controller, "STATE_SYNC");
        assert_eq!(second["state"]["track"]["id"], "two");
        assert_eq!(second["queue"], next_queue);
        assert_eq!(receive(&mut audio, "STATE_SYNC")["state"], second["state"]);
        let pause = receive(&mut audio, "EXECUTE");
        assert_eq!(pause["command"]["type"], "PAUSE");
        send(
            &desktop,
            json!({ "type": "COMMAND_RESULT", "requestId": pause["requestId"], "ok": true, "state": state("two", 0, false) }),
        );
        let paused = receive(&mut controller, "STATE_SYNC");
        assert_eq!(paused["state"]["is_playing"], false);
        assert_eq!(paused["state"]["track"]["id"], "two");
        assert_eq!(receive(&mut audio, "STATE_SYNC")["state"], paused["state"]);
        assert!(paused["state"]["revision"].as_u64() > first["state"]["revision"].as_u64());
        let (_, mut rejoined) = register("alice", "rejoined");
        let initial = receive(&mut rejoined, "INITIAL_STATE");
        assert_eq!(initial["state"], paused["state"]);
        assert_eq!(initial["queue"], next_queue);
    }

    #[test]
    fn a_browser_restoring_its_queue_cannot_take_over_from_the_playing_desktop() {
        let hub = RemoteControlHub::new();
        let (desktop, mut desktop_rx) = hub.connect_client("alice", "desktop", 0).unwrap();
        let (browser, mut browser_rx) = hub.connect_client("alice", "browser", 0).unwrap();
        let state = |id: &str, playing: bool| {
            json!({
                "current_track": { "id": id, "title": id },
                "position_ms": 0, "duration_ms": 180000, "playing": playing, "volume": 1,
            })
        };
        let send = |conn: &str, payload| {
            hub.handle_message(conn, serde_json::from_value(payload).unwrap())
        };
        let register = |conn: &str, device: &str, playback| {
            send(
                conn,
                json!({
                    "type": "REGISTER", "device_id": device, "device_name": device,
                    "device_type": "computer", "can_receive": true, "state": playback,
                }),
            )
        };
        register(&browser, "browser", state("old song", false));
        assert_eq!(
            browser_rx.try_recv().unwrap()["devices"][0]["is_active_player"],
            false
        );

        register(&desktop, "desktop", state("first desktop song", true));
        while browser_rx.try_recv().is_ok() {}
        while desktop_rx.try_recv().is_ok() {}

        send(
            &browser,
            json!({ "type": "STATE", "state": state("old song", true), "claim": true }),
        );
        assert_eq!(browser_rx.try_recv().unwrap()["type"], "DEACTIVATE");
        assert_eq!(desktop_rx.try_recv().unwrap()["type"], "DEVICES");

        send(
            &desktop,
            json!({ "type": "STATE", "state": state("next desktop song", true) }),
        );
        assert_eq!(desktop_rx.try_recv().unwrap()["type"], "DEVICES");
        hub.disconnect_client(&browser);
        let remaining = &desktop_rx.try_recv().unwrap()["devices"][0];
        assert_eq!(remaining["device_id"], "desktop");
        assert_eq!(remaining["is_active_player"], true);
        assert_eq!(remaining["playing"], true);
        assert_eq!(remaining["current_track"]["id"], "next desktop song");
    }

    #[tokio::test]
    async fn a_disconnected_owner_can_reclaim_its_lease_but_cannot_take_over_after_expiry() {
        let hub = RemoteControlHub::new();
        let send = |conn: &str, payload| {
            hub.handle_message(conn, serde_json::from_value(payload).unwrap());
        };
        let playing = json!({
            "current_track": { "id": "track", "title": "Track" },
            "position_ms": 0, "duration_ms": 10000, "playing": true, "volume": 1,
        });
        let register = |session, device, generation: Option<&str>| {
            let (conn, rx) = hub.connect_client("alice", session, 0).unwrap();
            send(
                &conn,
                json!({
                    "type": "REGISTER", "device_id": device, "device_name": device,
                    "device_type": "computer", "can_receive": true, "live_sync": true,
                    "playback_lease": true, "playbackLeaseProtocol": 1, "leaseGeneration": generation, "state": playing,
                }),
            );
            (conn, rx)
        };
        let active = || {
            hub.state
                .lock()
                .unwrap()
                .active_player_by_user
                .get("alice")
                .cloned()
        };
        let receive = |rx: &mut mpsc::Receiver<Value>, kind: &str| loop {
            let frame = rx.try_recv().unwrap();
            if frame["type"] == kind {
                break frame;
            }
        };

        let (original, mut original_rx) = register("session", "desk", None);
        let initial = receive(&mut original_rx, "INITIAL_STATE");
        let generation = initial["leaseGeneration"].as_str().unwrap();
        let original_deadline = hub.state.lock().unwrap().clients[&original].lease.as_ref().unwrap().expires;
        hub.disconnect_client(&original);
        assert_eq!(active(), Some(original));
        assert_eq!(hub.state.lock().unwrap().detached_players["alice"].lease.expires, original_deadline);

        let (competitor, mut competitor_rx) = register("other-session", "phone", None);
        receive(&mut competitor_rx, "DEACTIVATE");
        let (_, mut impostor_rx) = register("foreign-session", "desk", Some(generation));
        receive(&mut impostor_rx, "DEACTIVATE");
        let wrong_generation = Uuid::new_v4().to_string();
        let (stale, mut stale_rx) = register("session", "desk", Some(&wrong_generation));
        receive(&mut stale_rx, "DEACTIVATE");
        hub.disconnect_client(&stale);
        send(
            &competitor,
            json!({ "type": "TRANSFER_PLAYBACK", "requestId": "early", "targetId": "phone" }),
        );
        assert_eq!(receive(&mut competitor_rx, "ERROR")["requestId"], "early");

        let (reattached, mut desk_rx) = register("session", "desk", Some(generation));
        assert_eq!(
            receive(&mut desk_rx, "INITIAL_STATE")["state"]["device_id"],
            "desk"
        );
        assert_eq!(active(), Some(reattached.clone()));
        for (device, token) in [("phone", generation), ("desk", wrong_generation.as_str())] {
            send(&reattached, json!({ "type": "RENEW_PLAYBACK_LEASE", "sequence": 1,
                "device_id": device, "leaseGeneration": token }));
        }
        assert!(desk_rx.try_recv().is_err());
        assert_eq!(hub.state.lock().unwrap().clients[&reattached].lease.as_ref().unwrap().expires, original_deadline);
        send(
            &reattached,
            json!({ "type": "RENEW_PLAYBACK_LEASE", "sequence": 1,
                "device_id": "desk", "leaseGeneration": generation }),
        );
        let grant = receive(&mut desk_rx, "PLAYBACK_LEASE");
        assert_eq!(grant["leaseMs"], PLAYBACK_LEASE_MS);
        assert_eq!(grant["leaseGeneration"], generation);
        send(&reattached, json!({ "type": "RENEW_PLAYBACK_LEASE", "sequence": 1,
            "device_id": "desk", "leaseGeneration": generation }));
        assert!(desk_rx.try_recv().is_err());

        hub.disconnect_client(&reattached);
        hub.state
            .lock()
            .unwrap()
            .detached_players
            .get_mut("alice")
            .unwrap()
            .lease
            .expires = Instant::now();
        send(&competitor, json!({ "type": "STATE", "state": RemotePlaybackState::default() }));
        send(&competitor, json!({ "type": "STATE", "state": playing }));
        assert_eq!(active(), Some(competitor));
        let (_, mut stale_rx) = register("session", "desk", Some(generation));
        receive(&mut stale_rx, "DEACTIVATE");
        let initial = receive(&mut stale_rx, "INITIAL_STATE");
        assert_eq!(initial["state"]["device_id"], "phone");
        assert_eq!(initial["state"]["is_playing"], true);
    }

    #[tokio::test]
    async fn uncontested_reconnect_after_expiry_keeps_playing_with_a_fresh_lease() {
        let hub = RemoteControlHub::new();
        let register = |conn: &str, lease: Value| {
            hub.handle_message(conn, serde_json::from_value(json!({
                "type": "REGISTER", "device_id": "desk", "device_name": "Desk", "device_type": "computer",
                "can_receive": true, "live_sync": true, "playback_lease": true, "playbackLeaseProtocol": 1,
                "leaseGeneration": lease, "state": {
                    "current_track": { "id": "track", "title": "Track" }, "position_ms": 30000,
                    "duration_ms": 60000, "playing": true, "volume": 1.0,
                },
            })).unwrap());
        };
        let (old, mut frames) = hub.connect_client("alice", "session", 0).unwrap();
        register(&old, Value::Null);
        let lease = std::iter::from_fn(|| frames.try_recv().ok())
            .find(|frame| frame["type"] == "INITIAL_STATE").unwrap()["leaseGeneration"].clone();
        hub.disconnect_client(&old);
        hub.state.lock().unwrap().detached_players.get_mut("alice").unwrap().lease.expires = Instant::now();

        let (new, mut frames) = hub.connect_client("alice", "session", 0).unwrap();
        register(&new, lease.clone());
        let events: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok()).collect();
        assert!(events.iter().all(|frame| frame["type"] != "DEACTIVATE"));
        let initial = events.iter().find(|frame| frame["type"] == "INITIAL_STATE").unwrap();
        assert_eq!(initial["state"]["device_id"], "desk");
        assert_eq!(initial["state"]["is_playing"], true);
        assert_ne!(initial["leaseGeneration"], lease);
        assert!(initial["leaseGeneration"].is_string());
    }

    #[tokio::test]
    async fn paused_handoff_source_rejoins_before_confirmed_target_rollback() {
        let hub = RemoteControlHub::new();
        let (source, mut source_frames) = hub.connect_client("alice", "desk-session", 0).unwrap();
        let (target, mut target_frames) = hub.connect_client("alice", "phone-session", 0).unwrap();
        let send = |conn: &str, msg: Value| hub.handle_message(conn, serde_json::from_value(msg).unwrap());
        let register = |conn: &str, device: &str, playing: bool, lease: Value| send(conn, json!({
            "type": "REGISTER", "device_id": device, "device_name": device, "device_type": "computer",
            "can_receive": true, "live_sync": true, "playback_lease": true, "playbackLeaseProtocol": 1,
            "leaseGeneration": lease, "state": {
                "current_track": { "id": "track", "title": "Track" }, "position_ms": 30000,
                "duration_ms": 60000, "playing": playing, "volume": 1.0,
            },
        }));
        register(&source, "desk", true, Value::Null);
        let lease = std::iter::from_fn(|| source_frames.try_recv().ok())
            .find(|frame| frame["type"] == "INITIAL_STATE").unwrap()["leaseGeneration"].clone();
        register(&target, "phone", false, Value::Null);
        send(&source, json!({ "type": "TRANSFER_PLAYBACK", "targetId": "phone", "requestId": "switch" }));
        let transfer_id = std::iter::from_fn(|| source_frames.try_recv().ok())
            .find(|frame| frame["type"] == "REQUEST_SNAPSHOT").unwrap()["transferId"].clone();
        let snapshot = json!({
            "trackId": "track", "exactPositionMs": 30000, "volume": 1.0, "playing": true,
            "queueState": {
                "entries": [{ "occurrenceId": "first", "trackId": "track", "title": "Track",
                    "artist": "", "album": "", "duration": 60.0 }],
                "index": 0, "repeatOne": false, "shuffle": false, "shuffleMode": "standard",
                "shuffleSeed": null, "albumAware": false, "context": null,
            },
        });
        send(&source, json!({ "type": "SNAPSHOT", "transferId": transfer_id, "snapshot": snapshot }));
        send(&target, json!({ "type": "READY", "transferId": transfer_id }));
        send(&source, json!({ "type": "SOURCE_PAUSED", "transferId": transfer_id, "snapshot": snapshot }));
        assert!(std::iter::from_fn(|| target_frames.try_recv().ok()).any(|frame| frame["type"] == "START_TRANSFER"));

        hub.disconnect_client(&source);
        assert!(std::iter::from_fn(|| target_frames.try_recv().ok()).any(|frame| frame["type"] == "ABORT_TRANSFER"));
        let (rejoined, mut frames) = hub.connect_client("alice", "desk-session", 0).unwrap();
        register(&rejoined, "desk", false, lease);
        assert!(std::iter::from_fn(|| frames.try_recv().ok()).all(|frame| frame["type"] != "ABORT_TRANSFER"));
        send(&target, json!({ "type": "TRANSFER_ROLLED_BACK", "transferId": transfer_id }));
        let resumed = std::iter::from_fn(|| frames.try_recv().ok()).find(|frame| frame["type"] == "ABORT_TRANSFER").unwrap();
        assert_eq!(resumed["transferId"], transfer_id);
        assert_eq!(resumed["resume"], true);
    }

    #[test]
    fn picks_an_idle_output_and_hands_off_the_live_track_only_after_the_target_starts() {
        let hub = RemoteControlHub::new();
        let send = |conn: &str, message: Value| {
            hub.handle_message(conn, serde_json::from_value(message).unwrap())
        };
        let register = |device: &str| {
            let (conn, receiver) = hub.connect_client("alice", "session", 0).unwrap();
            send(
                &conn,
                json!({
                    "type": "REGISTER", "device_id": device, "device_name": device, "device_type": "computer",
                    "can_receive": true, "state": RemotePlaybackState::default()
                }),
            );
            (conn, receiver)
        };
        let (desktop, mut desktop_rx) = register("desktop");
        let (phone, mut phone_rx) = register("phone");
        let receive = |rx: &mut mpsc::Receiver<Value>, kind: &str| loop {
            let msg = rx.try_recv().unwrap();
            if msg["type"] == kind {
                break msg;
            }
        };
        let choose = |target: &str| {
            send(
                &phone,
                json!({
                    "type": "TRANSFER_PLAYBACK", "requestId": "choose-output", "targetId": target,
                }),
            )
        };
        let active = |devices: Value| {
            devices["devices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|device| device["is_active_player"] == true)
                .cloned()
        };
        while phone_rx.try_recv().is_ok() {}
        choose("desktop");
        assert_eq!(
            active(receive(&mut phone_rx, "DEVICES")).unwrap()["device_id"],
            "desktop"
        );
        assert_eq!(receive(&mut phone_rx, "TRANSFER_RESULT")["ok"], true);

        let track = json!({"id": "one", "title": "Set", "artist": "DJ", "cover_art": "mdart_one"});
        send(
            &desktop,
            json!({ "type": "STATE", "claim": true, "state": {
                "current_track": track, "position_ms": 42000, "duration_ms": 600000, "playing": true, "volume": 0.7
            }}),
        );
        assert_eq!(
            active(receive(&mut phone_rx, "DEVICES")).unwrap()["current_track"],
            track
        );
        send(
            &phone,
            json!({ "type": "COMMAND", "requestId": "pause", "command": {"type": "PAUSE"} }),
        );
        let pause = receive(&mut desktop_rx, "EXECUTE");
        assert_eq!(pause["command"]["type"], "PAUSE");
        send(
            &desktop,
            json!({ "type": "COMMAND_RESULT", "requestId": pause["requestId"], "ok": true }),
        );
        assert_eq!(
            receive(&mut phone_rx, "COMMAND_RESULT")["requestId"],
            "pause"
        );

        choose("phone");
        let stalled = receive(&mut desktop_rx, "REQUEST_SNAPSHOT");
        hub.expire_operations(&phone, hub.operation_deadline(&phone).unwrap());
        assert_eq!(receive(&mut phone_rx, "TRANSFER_RESULT")["ok"], false);
        choose("phone");
        let transfer_id = receive(&mut desktop_rx, "REQUEST_SNAPSHOT")["transferId"].clone();
        assert_ne!(transfer_id, stalled["transferId"]);
        let mut snapshot = json!({
            "trackId": "one", "exactPositionMs": 42000.125, "playing": true, "volume": 0.7,
            "queueState": { "entries": [{ "occurrenceId": "first", "trackId": "one", "title": "Set",
                "artist": "DJ", "album": "Live", "duration": 600.0 }], "index": 0,
                "repeatOne": false, "shuffle": false, "shuffleMode": "standard", "shuffleSeed": null,
                "albumAware": false, "context": null }
        });
        send(
            &desktop,
            json!({ "type": "SNAPSHOT", "transferId": transfer_id, "snapshot": snapshot }),
        );
        assert_eq!(
            receive(&mut phone_rx, "INITIALIZE_PLAYER")["snapshot"],
            snapshot
        );
        send(
            &phone,
            json!({ "type": "READY", "transferId": transfer_id }),
        );
        assert_eq!(
            receive(&mut desktop_rx, "PAUSE_FOR_TRANSFER")["transferId"],
            transfer_id
        );
        snapshot["exactPositionMs"] = json!(42999.625);
        send(
            &desktop,
            json!({ "type": "SOURCE_PAUSED", "transferId": transfer_id, "snapshot": snapshot }),
        );
        assert_eq!(
            receive(&mut phone_rx, "START_TRANSFER")["snapshot"],
            snapshot
        );
        send(
            &phone,
            json!({ "type": "STARTED", "transferId": transfer_id }),
        );
        assert_eq!(receive(&mut phone_rx, "TRANSFER_RESULT")["ok"], true);
        let selected = active(receive(&mut phone_rx, "DEVICES")).unwrap();
        assert_eq!(selected["device_id"], "phone");
        assert_eq!(selected["position_ms"], 42999.625);
        assert_eq!(selected["current_track"], track);
        assert_eq!(selected["playing"], true);
    }

    #[test]
    fn forwards_play_selection_to_the_active_player_and_rejects_invalid_indexes() {
        let hub = RemoteControlHub::new();
        let register = |device: &str, current_track: Value| {
            let (id, receiver) = hub.connect_client("alice", "fixture-session", 0).unwrap();
            let message = serde_json::from_value(json!({
                "type": "REGISTER", "device_id": device, "device_name": device,
                "device_type": "computer", "can_receive": true,
                "state": { "current_track": current_track, "position_ms": 0, "duration_ms": 0, "playing": false, "volume": 1 }
            })).unwrap();
            hub.handle_message(&id, message);
            (id, receiver)
        };
        let (active, mut player) = register("desktop", json!({"id": "old", "title": "Old track"}));
        hub.handle_message(
            &active,
            serde_json::from_value(json!({
                "type": "STATE", "state": {
                    "current_track": {"id": "old", "title": "Old track"},
                    "position_ms": 0, "duration_ms": 0, "playing": true, "volume": 1
                }
            }))
            .unwrap(),
        );
        let (controller, mut browser) = register("browser", Value::Null);
        while player.try_recv().is_ok() {}
        while browser.try_recv().is_ok() {}

        let command = |index| {
            json!({
                "type": "COMMAND", "requestId": "choose-track",
                "command": { "type": "PLAY_SELECTION", "tracks": [{"id":"first"}, {"id":"second"}],
                    "start_index": index, "from_here": true, "context": null }
            })
        };
        hub.handle_message(&controller, serde_json::from_value(command(1)).unwrap());
        let forwarded = player.try_recv().unwrap();
        assert_eq!(forwarded["type"], "EXECUTE");
        assert_eq!(forwarded["command"], command(1)["command"]);
        assert!(browser.try_recv().is_err());

        hub.handle_message(&controller, serde_json::from_value(command(2)).unwrap());
        assert_eq!(browser.try_recv().unwrap()["type"], "ERROR");
        assert!(player.try_recv().is_err());
    }

    #[test]
    fn queue_notifications_only_reach_other_queue_aware_clients_on_the_account() {
        let hub = RemoteControlHub::new();
        let register = |user: &str, device: &str, queue_device_id: Option<&str>| {
            let (id, receiver) = hub.connect_client(user, "fixture-session", 0).unwrap();
            let message = serde_json::from_value(json!({
                "type": "REGISTER", "device_id": device, "queue_device_id": queue_device_id,
                "device_name": device, "device_type": "computer", "can_receive": false,
                "state": { "current_track": null, "position_ms": 0, "duration_ms": 0, "playing": false, "volume": 1 }
            })).unwrap();
            hub.handle_message(&id, message);
            receiver
        };
        let mut source = register("alice", "desktop", Some("desktop-queue"));
        let mut follower = register("alice", "phone", Some("phone-queue"));
        let mut legacy = register("alice", "legacy", None);
        let mut outsider = register("bob", "tablet", Some("tablet-queue"));
        for receiver in [&mut source, &mut follower, &mut legacy, &mut outsider] {
            while receiver.try_recv().is_ok() {}
        }

        hub.queue_changed("alice", "desktop-queue");
        assert_eq!(
            follower.try_recv().unwrap(),
            json!({"type": "QUEUE_CHANGED"})
        );
        assert!(source.try_recv().is_err());
        assert!(legacy.try_recv().is_err());
        assert!(outsider.try_recv().is_err());
    }
}
