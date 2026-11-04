export type TransitionMode = "off" | "gapless" | "crossfade";
export type TransitionKind = "gapless" | "crossfade";
export type CrossfadeCurve = "linear" | "equal-power";

/**
 * Per-track output processing. Values that resolve after a track starts
 * (loudness analysis, silence detection) are applied with
 * `PlaybackEngine.updateTrack`; `undefined` leaves a value unchanged.
 */
export interface TrackAudioSettings {
  /** Linear level for ReplayGain/loudness normalization (1 = unchanged, clamped to 0–4). */
  readonly gain?: number;
  /** Leading silence to skip, in seconds. */
  readonly trimStart?: number;
  /** Where audible content ends, in seconds; `null` plays to the end of the file. */
  readonly trimEnd?: number | null;
}

export interface PlayableTrack extends TrackAudioSettings {
  readonly offlineTrackId?: string;
  readonly offlineOnly?: boolean;
  readonly cast?: {
    trackId: string; title: string; artist: string; album: string;
    maxBitRate?: number;
  };
  /** Explicit ordered-album queue membership; never inferred from a title. */
  readonly albumPlaybackId?: string;
  readonly albumTrackIndex?: number;
  /**
   * Unique per queue entry, not per song: the same song queued twice must use
   * two keys so stale engine events can never be applied to the wrong entry.
   */
  readonly key: string;
  readonly src: string;
  /** Server-reported duration, used when the stream cannot report one (live transcodes). */
  readonly durationHint?: number | null;
}

export type EngineState =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "stalled"
  | "transitioning"
  | "error";

export interface PlaybackEngineEventMap {
  stateChange: { key: string | null; state: EngineState };
  timeUpdate: { key: string; position: number; duration: number };
  /** The track finished and no transition took over; the queue decides what plays next. */
  trackEnd: { key: string };
  sleepStop: { key: string | null };
  bufferStall: { key: string; position: number; attempt: number; maxAttempts: number };
  streamRecovered: {
    key: string;
    position: number;
    attempts: number;
    restartedFromBeginning: boolean;
  };
  recoveryFailed: { key: string; position: number; attempts: number };
  transitionStart: { kind: TransitionKind; fromKey: string; toKey: string };
  /** The incoming track is now the audible, active track. Replaces `trackEnd` for the outgoing one. */
  transitionCommit: { kind: TransitionKind; fromKey: string; toKey: string };
  transitionCancel: { kind: TransitionKind; fromKey: string; toKey: string; reason: string };
  error: { key: string | null; message: string };
}

export type PlaybackEngineEvent = keyof PlaybackEngineEventMap;
export type PlaybackEngineListener<K extends PlaybackEngineEvent> = (
  payload: PlaybackEngineEventMap[K]
) => void;

export interface LoadOptions {
  startAt?: number;
  autoplay?: boolean;
}

export interface PlaybackSnapshot {
  key: string | null;
  state: EngineState;
  position: number;
  duration: number;
  mode: TransitionMode;
  transition: TransitionKind | null;
}
