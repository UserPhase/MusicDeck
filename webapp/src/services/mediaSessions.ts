import type { PlaybackEngine } from "./audio/PlaybackEngine";

export interface MediaResumeContext {
  type: "album" | "playlist"; mediaId: string; title: string;
  trackIndex: number; trackCount: number; occurrenceId: string | null;
}
export interface MediaCheckpointInput extends MediaResumeContext {
  trackId: string; positionSeconds: number; durationSeconds: number | null;
  capturedAt: number; completed: boolean;
}
export interface MediaCheckpoint extends Omit<MediaCheckpointInput, "completed"> {
  progress: number; updatedAt: number;
}
export const MEDIA_CHECKPOINT_CHANGED = "musicdeck:media-checkpoint-changed";

export function resumeTrackIndex(
  checkpoint: MediaCheckpoint,
  tracks: readonly { id: string | number; playlistItemId?: string }[],
): number {
  if (checkpoint.occurrenceId) return tracks.findIndex((track) => track.playlistItemId === checkpoint.occurrenceId &&
    String(track.id) === checkpoint.trackId);
  if (String(tracks[checkpoint.trackIndex]?.id) === checkpoint.trackId) return checkpoint.trackIndex;
  return tracks.findIndex((track) => String(track.id) === checkpoint.trackId);
}

export function isMediaResumeContext(value: unknown): value is MediaResumeContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<MediaResumeContext>;
  return (context.type === "album" || context.type === "playlist") &&
    typeof context.mediaId === "string" && context.mediaId.length > 0 && context.mediaId.length <= 300 &&
    typeof context.title === "string" && context.title.trim().length > 0 && context.title.length <= 500 &&
    typeof context.trackIndex === "number" && Number.isInteger(context.trackIndex) && context.trackIndex >= 0 &&
    typeof context.trackCount === "number" && Number.isInteger(context.trackCount) && context.trackCount > context.trackIndex &&
    (context.occurrenceId === null || typeof context.occurrenceId === "string");
}

/** Subscribe without React time-tick renders. Capture identity and position
 * together; queue replacements cannot assign an old timestamp to a new track. */
export function createMediaSessionTracker({
  engine, getTrack, save, onError, now = Date.now,
}: {
  engine: Pick<PlaybackEngine, "on" | "getSnapshot" | "getPosition">;
  getTrack(key: string): { id: string | number; mediaResume?: unknown; duration?: number } | undefined;
  save(input: MediaCheckpointInput): Promise<void>;
  onError(error: unknown): void;
  now?: () => number;
}) {
  let latest: (MediaCheckpointInput & { key: string }) | null = null;
  let lastSent = 0;
  let lastCapture = 0;
  const capture = (key: string, position: number, duration: number) => {
    const track = getTrack(key);
    if (!track || !isMediaResumeContext(track.mediaResume) || !Number.isFinite(position) || position < 0) return null;
    const total = duration > 0 && Number.isFinite(duration) ? duration : Number(track.duration) > 0 ? Number(track.duration) : null;
    return {
      ...track.mediaResume, trackId: String(track.id), key,
      positionSeconds: total ? Math.min(position, total) : position,
      durationSeconds: total, capturedAt: Math.max(now(), lastCapture + 1), completed: false,
    };
  };
  const send = (value: typeof latest) => {
    if (!value) return;
    const { key: _key, ...input } = value;
    lastCapture = input.capturedAt;
    lastSent = now();
    void save(input).catch(onError);
  };
  const flush = () => {
    const snapshot = engine.getSnapshot();
    if (latest && snapshot.key === latest.key) {
      latest = capture(latest.key, engine.getPosition(), snapshot.duration) ?? latest;
    }
    send(latest);
  };
  const ended = (key: string) => {
    if (!latest || latest.key !== key) return;
    const snapshot = engine.getSnapshot();
    if (snapshot.key === key) latest = capture(key, engine.getPosition(), snapshot.duration) ?? latest;
    if (latest.trackIndex === latest.trackCount - 1) latest = { ...latest, completed: true, capturedAt: Math.max(now(), lastCapture + 1) };
    send(latest);
    latest = null;
  };
  const off = [
    engine.on("timeUpdate", ({ key, position, duration }) => {
      if (latest && latest.key !== key) send(latest);
      latest = capture(key, position, duration);
      if (latest && now() - lastSent >= 5000) send(latest);
    }),
    engine.on("stateChange", ({ key, state }) => {
      if (state === "paused" || state === "error") flush();
      if (key && (!latest || latest.key !== key)) {
        if (latest) send(latest);
        const snapshot = engine.getSnapshot();
        latest = capture(key, snapshot.position, snapshot.duration);
      }
    }),
    engine.on("trackEnd", ({ key }) => ended(key)),
    engine.on("transitionCommit", ({ fromKey }) => ended(fromKey)),
  ];
  const navigation = () => flush();
  window.addEventListener("pagehide", navigation);
  window.addEventListener("musicdeck:navigation", navigation);
  const visibility = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", visibility);
  return {
    flush,
    destroy() {
      off.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener("pagehide", navigation);
      window.removeEventListener("musicdeck:navigation", navigation);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
