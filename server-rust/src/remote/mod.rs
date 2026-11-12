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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;
use uuid::Uuid;

/// Canonical WebSocket path for the Remote Control Hub.
pub const REMOTE_WS_PATH: &str = "/api/v1/remote";

/// Maximum concurrent remote WebSocket connections per user account (`16`).
pub const MAX_CLIENTS_PER_USER: usize = 16;

/// Maximum pending unacknowledged commands per controller (`64`).
pub const MAX_PENDING_COMMANDS_PER_CONTROLLER: usize = 64;

/// Registration deadline (`10,000` ms) before an unregistered socket is closed (`4000`).
pub const REGISTRATION_TIMEOUT_MS: u64 = 10_000;

/// Command acknowledgement timeout (`8,000` ms).
pub const COMMAND_TIMEOUT_MS: u64 = 8_000;

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
}

impl RemoteCommand {
    fn valid_queue_command(&self) -> bool {
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
    },
    /// Report updated playback state (and optionally claim active player status).
    State {
        /// Current playback state.
        state: RemotePlaybackState,
        /// If `true`, claims active player ownership for the user account.
        claim: bool,
    },
    /// Dispatch a remote transport command to `target_id` (or the current active player).
    Command {
        /// Client correlation ID.
        #[serde(rename = "requestId")]
        request_id: String,
        /// Optional explicit target device ID.
        #[serde(rename = "targetId")]
        target_id: Option<String>,
        /// Command payload.
        command: RemoteCommand,
    },
    /// Acknowledge execution of a received `EXECUTE` command.
    CommandResult {
        /// Command correlation ID assigned by the hub.
        #[serde(rename = "requestId")]
        request_id: String,
        /// Whether execution succeeded.
        ok: bool,
        /// Optional error/diagnostic message.
        message: Option<String>,
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
    },
    /// Abort an in-flight transfer due to a client-side error.
    TransferFailed {
        /// Active transfer ID.
        #[serde(rename = "transferId")]
        transfer_id: String,
        /// Failure reason (`<= 500` chars).
        message: String,
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
}

#[derive(Debug)]
struct ConnectedClient {
    conn_id: String,
    user_id: String,
    #[allow(dead_code)]
    session_id: String,
    device_id: Option<String>,
    queue_device_id: Option<String>,
    device_name: String,
    device_type: RemoteDeviceType,
    can_receive: bool,
    state: RemotePlaybackState,
    tx: mpsc::Sender<Value>,
    tokens: f64,
    last_refill_ms: u64,
}

#[derive(Debug)]
struct PendingCommand {
    controller_conn_id: String,
    target_conn_id: String,
    client_request_id: String,
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
}

#[derive(Debug, Default)]
struct HubState {
    clients: HashMap<String, ConnectedClient>,
    active_player_by_user: HashMap<String, String>,
    commands: HashMap<String, PendingCommand>,
    transfers_by_user: HashMap<String, ActiveTransfer>,
}

/// Thread-safe, user-isolated WebSocket control plane coordinating device discovery,
/// command forwarding, and the 4-stage playback transfer handshake.
#[derive(Debug, Clone, Default)]
pub struct RemoteControlHub {
    state: Arc<Mutex<HubState>>,
}

impl RemoteControlHub {
    /// Creates a new [`RemoteControlHub`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
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
                tx,
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

        let Some(user_id) = guard.clients.get(conn_id).map(|c| c.user_id.clone()) else {
            return;
        };

        match message {
            RemoteClientMessage::Register {
                device_id,
                queue_device_id,
                device_name,
                device_type,
                can_receive,
                mut state,
            } => {
                let clean_name = device_name.trim().to_owned();
                if device_id.is_empty()
                    || device_id.len() > 160
                    || queue_device_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 300)
                    || clean_name.is_empty()
                    || clean_name.chars().count() > 80
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

                let duplicate_conn_id = guard
                    .clients
                    .values()
                    .find(|peer| {
                        peer.conn_id != conn_id
                            && peer.user_id == user_id
                            && peer.device_id.as_deref() == Some(device_id.as_str())
                    })
                    .map(|p| p.conn_id.clone());

                if let Some(dup_id) = duplicate_conn_id {
                    Self::remove_client_locked(&mut guard, &dup_id);
                }

                let has_track = state.current_track.is_some();
                if state.playing
                    && guard
                        .active_player_by_user
                        .get(&user_id)
                        .is_some_and(|active| active != conn_id)
                    && !guard.transfers_by_user.contains_key(&user_id)
                {
                    // A reconnecting player follows the device that still owns playback.
                    state.playing = false;
                    Self::send_frame_locked(&guard, conn_id, json!({ "type": "DEACTIVATE" }));
                }
                if let Some(client) = guard.clients.get_mut(conn_id) {
                    client.device_id = Some(device_id);
                    client.queue_device_id = queue_device_id;
                    client.device_name = clean_name;
                    client.device_type = device_type;
                    client.can_receive = can_receive;
                    client.state = state;
                }

                if !guard.active_player_by_user.contains_key(&user_id) && has_track {
                    guard
                        .active_player_by_user
                        .insert(user_id.clone(), conn_id.to_owned());
                }

                Self::broadcast_devices_locked(&guard, &user_id);
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
                    RemoteClientMessage::State { state, claim } => {
                        let has_track = state.current_track.is_some();
                        if let Some(client) = guard.clients.get_mut(conn_id) {
                            client.state = state;
                        }

                        if claim && has_track && !guard.transfers_by_user.contains_key(&user_id) {
                            if let Some(old_active) = guard.active_player_by_user.get(&user_id)
                                && old_active != conn_id
                            {
                                Self::send_frame_locked(
                                    &guard,
                                    old_active,
                                    json!({ "type": "DEACTIVATE" }),
                                );
                            }
                            guard
                                .active_player_by_user
                                .insert(user_id.clone(), conn_id.to_owned());
                        }

                        if !guard.active_player_by_user.contains_key(&user_id) && has_track {
                            guard
                                .active_player_by_user
                                .insert(user_id.clone(), conn_id.to_owned());
                        }

                        Self::broadcast_devices_locked(&guard, &user_id);
                    }
                    RemoteClientMessage::Command {
                        request_id,
                        target_id,
                        command,
                    } => {
                        if !command.valid_queue_command() {
                            Self::send_error_locked(&guard, conn_id, "Invalid queue command", Some(&request_id));
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
                            active_conn.clone()
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

                        let pending_for_controller = guard
                            .commands
                            .values()
                            .filter(|cmd| cmd.controller_conn_id == conn_id)
                            .count();
                        if pending_for_controller >= MAX_PENDING_COMMANDS_PER_CONTROLLER {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Too many pending commands",
                                Some(&request_id),
                            );
                            return;
                        }

                        let cmd_id = Uuid::new_v4().to_string();
                        guard.commands.insert(
                            cmd_id.clone(),
                            PendingCommand {
                                controller_conn_id: conn_id.to_owned(),
                                target_conn_id: target_conn.clone(),
                                client_request_id: request_id,
                            },
                        );

                        Self::send_frame_locked(
                            &guard,
                            &target_conn,
                            json!({
                                "type": "EXECUTE",
                                "requestId": cmd_id,
                                "command": command,
                            }),
                        );
                    }
                    RemoteClientMessage::CommandResult {
                        request_id,
                        ok,
                        message,
                    } => {
                        let is_valid_target = guard
                            .commands
                            .get(&request_id)
                            .is_some_and(|cmd| cmd.target_conn_id == conn_id);
                        if !is_valid_target {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "Unknown command acknowledgement",
                                None,
                            );
                            return;
                        }
                        if let Some(cmd) = guard.commands.remove(&request_id) {
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
                        }
                    }
                    RemoteClientMessage::TransferPlayback {
                        request_id,
                        target_id,
                    } => {
                        if guard.transfers_by_user.contains_key(&user_id) {
                            Self::send_error_locked(
                                &guard,
                                conn_id,
                                "A playback transfer is already in progress",
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
                            guard
                                .active_player_by_user
                                .insert(user_id.clone(), target_conn);
                            Self::broadcast_devices_locked(&guard, &user_id);
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
                                deadline: Instant::now()
                                    + Duration::from_millis(TRANSFER_TIMEOUT_MS),
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
        Self::remove_client_locked(&mut guard, conn_id);
    }

    pub(crate) fn transfer_deadline(&self, conn_id: &str) -> Option<Instant> {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let user_id = &guard.clients.get(conn_id)?.user_id;
        let transfer = guard.transfers_by_user.get(user_id)?;
        (transfer.controller_conn_id == conn_id).then_some(transfer.deadline)
    }

    pub(crate) fn expire_transfer(&self, conn_id: &str, now: Instant) {
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
        if let Some(transfer) = guard.transfers_by_user.get(&user_id)
            && transfer.controller_conn_id == conn_id
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
            | RemoteClientMessage::Started { transfer_id }
            | RemoteClientMessage::TransferFailed { transfer_id, .. } => transfer_id.as_str(),
            _ => return,
        };

        let is_matching_transfer = guard
            .transfers_by_user
            .get(user_id)
            .is_some_and(|t| t.id == msg_transfer_id);

        if !is_matching_transfer {
            Self::send_error_locked(guard, conn_id, "Stale playback transfer", None);
            return;
        }

        match message {
            RemoteClientMessage::TransferFailed { message: msg, .. } => {
                let (is_participant, resume_source) = {
                    let t = guard.transfers_by_user.get(user_id).unwrap();
                    let part = conn_id == t.source_conn_id || conn_id == t.target_conn_id;
                    let resume = conn_id == t.target_conn_id && t.stage == TransferStage::Start;
                    (part, resume)
                };
                if !is_participant {
                    Self::send_error_locked(
                        guard,
                        conn_id,
                        "Not a participant in this transfer",
                        None,
                    );
                    return;
                }
                Self::abort_transfer_locked(guard, user_id, &msg, resume_source);
            }
            RemoteClientMessage::Snapshot { snapshot, .. } => {
                if !snapshot.validate() {
                    Self::send_error_locked(guard, conn_id, "Invalid remote message", None);
                    return;
                }
                let target_conn_opt = {
                    let t = guard.transfers_by_user.get_mut(user_id).unwrap();
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
                let source_conn_opt = {
                    let t = guard.transfers_by_user.get_mut(user_id).unwrap();
                    if conn_id == t.target_conn_id && t.stage == TransferStage::Prepare {
                        t.stage = TransferStage::Pause;
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
                    let t = guard.transfers_by_user.get_mut(user_id).unwrap();
                    if conn_id == t.source_conn_id && t.stage == TransferStage::Pause {
                        let drifted = t.snapshot.as_ref().is_none_or(|prev| {
                            prev.track_id != snapshot.track_id
                                || serde_json::to_string(&prev.queue_state).ok()
                                    != serde_json::to_string(&snapshot.queue_state).ok()
                        });
                        t.snapshot = Some(snapshot.clone());
                        if drifted {
                            Some(Err(()))
                        } else {
                            t.stage = TransferStage::Start;
                            Some(Ok((t.target_conn_id.clone(), t.id.clone())))
                        }
                    } else {
                        None
                    }
                };

                match step {
                    Some(Ok((target_conn, tid))) => {
                        Self::send_frame_locked(
                            guard,
                            &target_conn,
                            json!({
                                "type": "START_TRANSFER",
                                "transferId": tid,
                                "snapshot": snapshot,
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
            RemoteClientMessage::Started { .. } => {
                let can_complete = guard.transfers_by_user.get(user_id).is_some_and(|t| {
                    conn_id == t.target_conn_id
                        && t.stage == TransferStage::Start
                        && t.snapshot.is_some()
                });
                if !can_complete {
                    Self::send_error_locked(
                        guard,
                        conn_id,
                        "Unexpected playback transfer acknowledgement",
                        None,
                    );
                    return;
                }

                let transfer = guard.transfers_by_user.remove(user_id).unwrap();
                let snapshot = transfer.snapshot.unwrap();

                guard
                    .active_player_by_user
                    .insert(user_id.to_owned(), transfer.target_conn_id.clone());

                let source = guard.clients.get(&transfer.source_conn_id);
                let source_duration = source.map_or(0.0, |c| c.state.duration_ms);
                let source_track = source
                    .and_then(|c| c.state.current_track.clone())
                    .filter(|track| track.id == snapshot.track_id);

                if let Some(src) = guard.clients.get_mut(&transfer.source_conn_id) {
                    src.state.playing = false;
                }

                if let Some(tgt) = guard.clients.get_mut(&transfer.target_conn_id) {
                    let entry = &snapshot.queue_state.entries[snapshot.queue_state.index];
                    let dur = if tgt.state.duration_ms > 0.0 {
                        tgt.state.duration_ms
                    } else {
                        source_duration
                    };
                    tgt.state = RemotePlaybackState {
                        current_track: Some(source_track.unwrap_or_else(|| RemoteTrackSummary {
                            id: snapshot.track_id,
                            title: entry.title.clone(),
                            artist: Some(entry.artist.clone()),
                            album: Some(entry.album.clone()),
                            cover_art: None,
                        })),
                        position_ms: snapshot.exact_position_ms,
                        duration_ms: dur,
                        playing: snapshot.playing,
                        volume: snapshot.volume,
                    };
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
        let Some(transfer) = guard.transfers_by_user.remove(user_id) else {
            return;
        };

        let should_resume =
            resume_source && transfer.snapshot.as_ref().is_some_and(|s| s.playing);

        Self::send_frame_locked(
            guard,
            &transfer.target_conn_id,
            json!({
                "type": "ABORT_TRANSFER",
                "transferId": transfer.id,
            }),
        );
        Self::send_frame_locked(
            guard,
            &transfer.source_conn_id,
            json!({
                "type": "ABORT_TRANSFER",
                "transferId": transfer.id,
                "resume": should_resume,
            }),
        );

        let detail = if !resume_source
            && matches!(transfer.stage, TransferStage::Pause | TransferStage::Start)
        {
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

    fn remove_client_locked(guard: &mut HubState, conn_id: &str) {
        let Some(removed) = guard.clients.remove(conn_id) else {
            return;
        };
        let user_id = removed.user_id;

        if guard.transfers_by_user.get(&user_id).is_some_and(|t| {
            t.source_conn_id == conn_id
                || t.target_conn_id == conn_id
                || t.controller_conn_id == conn_id
        }) {
            Self::abort_transfer_locked(
                guard,
                &user_id,
                "A participating device disconnected. Playback may need to be resumed manually.",
                false,
            );
        }

        let affected_cmds: Vec<(String, String, String)> = guard
            .commands
            .iter()
            .filter(|(_, cmd)| cmd.controller_conn_id == conn_id || cmd.target_conn_id == conn_id)
            .map(|(cid, cmd)| {
                (
                    cid.clone(),
                    cmd.controller_conn_id.clone(),
                    cmd.client_request_id.clone(),
                )
            })
            .collect();

        for (cid, controller_conn, req_id) in affected_cmds {
            guard.commands.remove(&cid);
            if controller_conn != conn_id {
                Self::send_error_locked(
                    guard,
                    &controller_conn,
                    "The player disconnected",
                    Some(&req_id),
                );
            }
        }

        if guard.active_player_by_user.get(&user_id).map(String::as_str) == Some(conn_id) {
            guard.active_player_by_user.remove(&user_id);
        }

        Self::broadcast_devices_locked(guard, &user_id);
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
        });

        for peer in peers {
            let _ = peer.tx.try_send(payload.clone());
        }
    }

    fn send_error_locked(
        guard: &HubState,
        conn_id: &str,
        message: &str,
        request_id: Option<&str>,
    ) {
        let mut obj = json!({
            "type": "ERROR",
            "message": message,
        });
        if let Some(req_id) = request_id
            && let Value::Object(ref mut map) = obj
        {
            map.insert(
                String::from("requestId"),
                Value::String(req_id.to_owned()),
            );
        }
        Self::send_frame_locked(guard, conn_id, obj);
    }

    fn send_frame_locked(guard: &HubState, conn_id: &str, payload: Value) {
        if let Some(client) = guard.clients.get(conn_id) {
            let _ = client.tx.try_send(payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        hub.expire_transfer(&phone, hub.transfer_deadline(&phone).unwrap());
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
        let (_active, mut player) = register("desktop", json!({"id": "old", "title": "Old track"}));
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
