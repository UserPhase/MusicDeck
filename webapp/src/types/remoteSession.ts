import type { MediaResumeContext } from "../services/mediaSessions";
import type { PersistedQueueTrack, QueueCheckpoint } from "../services/storage/QueueDatabase";

export type RemoteCommand =
  | { type: "PLAY" } | { type: "PAUSE" }
  | { type: "PLAY_TRACK"; track: PersistedQueueTrack }
  | { type: "SKIP"; direction: "next" | "previous" }
  | { type: "SEEK"; position_ms: number }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "TOGGLE_SHUFFLE" | "TOGGLE_REPEAT" }
  | { type: "SET_PLAYLIST_LOOP"; playlist_id: string; enabled: boolean }
  | { type: "PLAY_QUEUE_ENTRY"; entry_id: string }
  | { type: "MOVE_QUEUE_ENTRY"; entry_id: string; target_id: string }
  | { type: "PLAY_SELECTION"; tracks: PersistedQueueTrack[]; start_index: number; from_here: boolean; context: QueueCheckpoint["context"] }
  | { type: "ENQUEUE"; tracks: PersistedQueueTrack[]; next: boolean; dedupe: boolean };
export interface RemotePlayerState {
  current_track: { id: string; title: string; artist?: string; album?: string; cover_art?: string } | null;
  position_ms: number; duration_ms: number; playing: boolean; volume: number;
}
export interface RemoteDevice extends RemotePlayerState {
  device_id: string; device_name: string; device_type: "computer" | "phone" | "tablet" | "web";
  queue_device_id?: string | null;
  is_active_player: boolean; can_receive: boolean;
}
export interface PlaybackState {
  device_id: string | null;
  track: RemotePlayerState["current_track"];
  position_ms: number;
  duration_ms: number;
  is_playing: boolean;
  volume: number;
  updated_at: number;
  revision: number;
  queue: RemotePlaybackSnapshot["queueState"] | null;
}
export interface RemotePlaybackSnapshot {
  queueState: {
    entries: { occurrenceId: string; trackId: string; title: string; artist: string; album: string; duration: number;
      albumPlaybackId?: string; albumTrackIndex?: number; resume?: MediaResumeContext; unshuffledIndex?: number }[];
    index: number; repeatOne: boolean; repeatAll?: boolean; shuffle: boolean; shuffleMode: "standard" | "smart"; shuffleSeed: number | null;
    loopPlaylistId?: string;
    albumAware: boolean;
    context: QueueCheckpoint["context"];
  };
  trackId: string; exactPositionMs: number; playing: boolean; volume: number;
}
export interface RemotePlayerAdapter {
  state(): RemotePlayerState;
  queue?(): RemotePlaybackSnapshot["queueState"];
  capture(): RemotePlaybackSnapshot;
  command(command: RemoteCommand, signal?: AbortSignal): Promise<void>;
  prepare(snapshot: RemotePlaybackSnapshot, signal: AbortSignal): Promise<void>;
  start(snapshot: RemotePlaybackSnapshot, signal?: AbortSignal): Promise<void>;
  commitTransfer?(signal: AbortSignal): void;
  pause(): void;
  enable(): Promise<void>;
}
export interface RemoteSessionValue {
  status: "unavailable" | "connecting" | "connected" | "reconnecting";
  deviceId: string;
  devices: RemoteDevice[];
  activeDevice: RemoteDevice | null;
  playback?: PlaybackState | null;
  readPosition?: () => number;
  publishPosition?: () => void;
  ordersCommands?: boolean;
  isRemote: boolean;
  enabled: boolean;
  busy: boolean;
  error: string;
  name: string;
  enable(): Promise<void>;
  rename(name: string): void;
  transfer(targetId: string): Promise<void>;
  command(command: RemoteCommand, targetId?: string): Promise<void>;
  clearError(): void;
}
