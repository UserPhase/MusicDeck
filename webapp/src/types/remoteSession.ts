import type { MediaResumeContext } from "../services/mediaSessions";

export type RemoteCommand =
  | { type: "PLAY" } | { type: "PAUSE" }
  | { type: "SKIP"; direction: "next" | "previous" }
  | { type: "SEEK"; position_ms: number }
  | { type: "SET_VOLUME"; volume: number };
export interface RemotePlayerState {
  current_track: { id: string; title: string } | null;
  position_ms: number; duration_ms: number; playing: boolean; volume: number;
}
export interface RemoteDevice extends RemotePlayerState {
  device_id: string; device_name: string; device_type: "computer" | "phone" | "tablet" | "web";
  is_active_player: boolean; can_receive: boolean;
}
export interface RemotePlaybackSnapshot {
  queueState: {
    entries: { occurrenceId: string; trackId: string; title: string; artist: string; album: string; duration: number;
      albumPlaybackId?: string; albumTrackIndex?: number; resume?: MediaResumeContext }[];
    index: number; repeatOne: boolean; shuffle: boolean; shuffleMode: "standard" | "smart"; shuffleSeed: number | null;
    albumAware: boolean;
    context: { type: string; id: string; name: string; coverArt: string | null } | null;
  };
  trackId: string; exactPositionMs: number; playing: boolean; volume: number;
}
export interface RemotePlayerAdapter {
  state(): RemotePlayerState;
  capture(): RemotePlaybackSnapshot;
  command(command: RemoteCommand): Promise<void>;
  prepare(snapshot: RemotePlaybackSnapshot, signal: AbortSignal): Promise<void>;
  start(snapshot: RemotePlaybackSnapshot): Promise<void>;
  pause(): void;
  enable(): Promise<void>;
}
export interface RemoteSessionValue {
  status: "unavailable" | "connecting" | "connected" | "reconnecting";
  deviceId: string;
  devices: RemoteDevice[];
  activeDevice: RemoteDevice | null;
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
