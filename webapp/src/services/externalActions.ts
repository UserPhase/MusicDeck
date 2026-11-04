import { useCallback, useEffect, useSyncExternalStore } from "react";

import { createAcquisition, getAcquisition, getAcquisitions } from "../api/musicdeck";
import { isBrowserIntegrationAllowed } from "./privacyPolicy";

/**
 * Unified lifecycle for importing external (Deezer/iTunes) metadata items
 * into the library through the server's acquisition queue (spotDL).
 *
 *   IDLE → QUEUED → IMPORTING → IN_LIBRARY
 *                 ↘ FAILED (retry is safe: the server reuses unfinished jobs)
 *
 * State is keyed per item (`album:<id>` / `track:<id>`), so every card showing
 * the same item agrees, and only cards for that key re-render on change.
 */
export type ExternalActionState = "IDLE" | "QUEUED" | "IMPORTING" | "IN_LIBRARY" | "FAILED";
export type ExternalItemKind = "album" | "track";

export type ExternalActionSnapshot = {
  state: ExternalActionState;
  jobId: string | null;
  /** 0–100 while importing, when the server reports it. */
  progress: number | null;
  /** Plain-language status or error text for the item's live region. */
  message: string | null;
  /** True while the latest status poll failed; the job may still be running. */
  connectionLost: boolean;
};

export type ExternalMetadataItem = {
  id: string;
  title?: string | null;
  name?: string | null;
  artist?: string | null;
  album?: string | null;
  provider?: string | null;
  source?: { kind?: string; count?: number } | null;
  metadata?: Record<string, unknown> | null;
};

type AcquisitionJobLike = {
  id?: string;
  status?: string;
  requestedTrackId?: string;
  requestedAlbumId?: string;
  errorMessage?: string;
  progress?: { percent?: number } | null;
};

type CreateResponse = { jobId?: string; status?: string; job?: AcquisitionJobLike } | null | undefined;

export type ExternalActionDeps = {
  create: (payload: unknown) => Promise<CreateResponse>;
  get: (jobId: string) => Promise<AcquisitionJobLike | null | undefined>;
  list: () => Promise<AcquisitionJobLike[]>;
  isOnline: () => boolean;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
};

const IDLE: ExternalActionSnapshot = Object.freeze({
  state: "IDLE",
  jobId: null,
  progress: null,
  message: null,
  connectionLost: false,
}) as ExternalActionSnapshot;

const ACTIVE_STATES = new Set<ExternalActionState>(["QUEUED", "IMPORTING"]);
const POLL_BASE_MS = 1500;
const POLL_MAX_MS = 15000;
const MAX_POLL_FAILURES = 6;
const PROVIDERS = new Set(["library", "musicdeck", "plugin", "external", "deezer", "itunes", "spotify"]);
// Mirrors the server's strict acquisition metadata schema; anything else would be rejected.
const METADATA_KEYS = ["durationSeconds", "artistId", "albumId", "isrc", "year", "songCount", "deezerTrackId", "itunesTrackId"];

export const OFFLINE_MESSAGE = "You're offline. Reconnect, then try again.";
const UNREACHABLE_MESSAGE = "Can't reach MusicDeck. Check your connection and try again.";
const LOST_CONTACT_MESSAGE = "Connection lost. The import continues on the server; checking again shortly…";
const GAVE_UP_MESSAGE = "Couldn't confirm the import status. Check your connection, then select Retry. It won't start a duplicate import.";

export const externalActionKey = (kind: ExternalItemKind, id: string) => `${kind}:${id}`;

export function stateForJobStatus(status: string | undefined): ExternalActionState {
  switch (status) {
    case "queued":
      return "QUEUED";
    case "discovering":
    case "downloading":
    case "processing":
    case "importing":
      return "IMPORTING";
    case "completed":
      return "IN_LIBRARY";
    case "failed":
      return "FAILED";
    default:
      return "IDLE";
  }
}

function snapshotForJob(job: AcquisitionJobLike, title: string): ExternalActionSnapshot {
  const state = stateForJobStatus(job.status);
  const percent = job.progress?.percent;
  const progress = state === "IMPORTING" && typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : null;
  const messages: Record<ExternalActionState, string | null> = {
    IDLE: job.status === "cancelled" ? `Import of ${title} was cancelled.` : null,
    QUEUED: `${title} is queued for import.`,
    IMPORTING: progress === null ? `Importing ${title}…` : `Importing ${title}… ${progress}%`,
    IN_LIBRARY: `${title} is in your library.`,
    FAILED: job.errorMessage ? `Import failed: ${job.errorMessage}` : `Import of ${title} failed. Try again.`,
  };
  return { state, jobId: job.id ?? null, progress, message: messages[state], connectionLost: false };
}

function friendlyError(error: unknown, isOnline: boolean) {
  if (!isOnline) return OFFLINE_MESSAGE;
  // fetch() rejects with a TypeError when the network request never completes.
  if (error instanceof TypeError) return UNREACHABLE_MESSAGE;
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? `Couldn't start the import: ${message}` : "Couldn't start the import. Try again.";
}

function titleOf(item: ExternalMetadataItem) {
  return item.title || item.name || "This item";
}

export function acquisitionPayload(kind: ExternalItemKind, item: ExternalMetadataItem) {
  const provider = item.provider && PROVIDERS.has(item.provider) ? item.provider : "external";
  const metadata: Record<string, unknown> = {};
  for (const key of METADATA_KEYS) {
    const value = item.metadata?.[key];
    if (value !== undefined) metadata[key] = value;
  }
  return {
    result: {
      id: item.id,
      type: kind,
      title: titleOf(item),
      artist: item.artist || "",
      ...(kind === "track" ? { album: item.album || "" } : {}),
      provider,
      source: { kind: "external", count: Math.max(0, Number(item.source?.count) || 0) },
      metadata,
    },
    ...(kind === "album" ? { albumId: item.id } : { trackId: item.id }),
    sourceProvider: "spotdl",
  };
}

const defaultDeps: ExternalActionDeps = {
  create: createAcquisition,
  get: getAcquisition,
  list: getAcquisitions,
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createExternalActions(deps: ExternalActionDeps = defaultDeps) {
  const entries = new Map<string, ExternalActionSnapshot>();
  const titles = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const starting = new Map<string, Promise<ExternalActionSnapshot>>();
  const timers = new Map<string, unknown>();
  let hydration: Promise<void> | null = null;

  const getSnapshot = (key: string) => entries.get(key) ?? IDLE;

  function set(key: string, snapshot: ExternalActionSnapshot) {
    entries.set(key, snapshot);
    listeners.get(key)?.forEach((listener) => listener());
  }

  function subscribe(key: string, listener: () => void) {
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (!set?.size) listeners.delete(key);
    };
  }

  function stopPolling(key: string) {
    const handle = timers.get(key);
    if (handle !== undefined) deps.cancel(handle);
    timers.delete(key);
  }

  function track(key: string, job: AcquisitionJobLike) {
    const next = snapshotForJob(job, titles.get(key) || "This item");
    set(key, next);
    if (ACTIVE_STATES.has(next.state) && next.jobId) poll(key, next.jobId, 0);
    else stopPolling(key);
    return next;
  }

  function poll(key: string, jobId: string, failures: number) {
    stopPolling(key);
    const delay = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** failures);
    timers.set(key, deps.schedule(() => {
      timers.delete(key);
      deps.get(jobId).then(
        (job) => {
          // A newer action for this key replaced the job being polled.
          if (getSnapshot(key).jobId !== jobId) return;
          if (!job) {
            set(key, { ...IDLE, state: "FAILED", message: "This import is no longer available. Try again." });
            return;
          }
          track(key, job);
        },
        () => {
          const current = getSnapshot(key);
          if (current.jobId !== jobId || !ACTIVE_STATES.has(current.state)) return;
          if (failures + 1 >= MAX_POLL_FAILURES) {
            set(key, { ...current, state: "FAILED", connectionLost: true, message: GAVE_UP_MESSAGE });
            return;
          }
          set(key, { ...current, connectionLost: true, message: deps.isOnline() ? LOST_CONTACT_MESSAGE : OFFLINE_MESSAGE });
          poll(key, jobId, failures + 1);
        },
      );
    }, delay));
  }

  /** Starts (or joins) the import for an item. Never rejects. */
  function run(kind: ExternalItemKind, item: ExternalMetadataItem): Promise<ExternalActionSnapshot> {
    const key = externalActionKey(kind, item.id);
    if (!isBrowserIntegrationAllowed("imports")) {
      const failed = { ...IDLE, state: "FAILED" as const, message: "Imports are disabled by server privacy policy." };
      set(key, failed);
      return Promise.resolve(failed);
    }
    titles.set(key, titleOf(item));
    const current = getSnapshot(key);
    // Duplicate clicks and other cards for the same item join the active job.
    if (ACTIVE_STATES.has(current.state) || current.state === "IN_LIBRARY") return Promise.resolve(current);
    const pending = starting.get(key);
    if (pending) return pending;

    if (!deps.isOnline()) {
      const failed = { ...IDLE, state: "FAILED" as const, message: OFFLINE_MESSAGE };
      set(key, failed);
      return Promise.resolve(failed);
    }

    set(key, { ...IDLE, state: "QUEUED", message: `Sending ${titleOf(item)} to the import queue…` });
    const request = Promise.resolve()
      .then(() => deps.create(acquisitionPayload(kind, item)))
      .then(
        (response) => {
          const job = response?.job ?? { id: response?.jobId, status: response?.status };
          if (!job.status) throw new Error("The server did not confirm the import.");
          return track(key, job);
        },
      )
      .catch((error: unknown) => {
        const failed = { ...IDLE, state: "FAILED" as const, message: friendlyError(error, deps.isOnline()) };
        set(key, failed);
        return failed;
      })
      .finally(() => {
        starting.delete(key);
      });
    starting.set(key, request);
    return request;
  }

  /**
   * Restores lifecycle state for imports started earlier (another tab, a
   * reload). Runs once; a failed load can be retried by the next caller.
   */
  function hydrate(): Promise<void> {
    if (hydration) return hydration;
    hydration = Promise.resolve()
      .then(() => deps.list())
      .then((jobs) => {
        // Jobs are newest first, so the first match per key wins.
        const seen = new Set<string>();
        for (const job of jobs || []) {
          const kind: ExternalItemKind | null = job.requestedTrackId ? "track" : job.requestedAlbumId ? "album" : null;
          const id = job.requestedTrackId || job.requestedAlbumId;
          if (!kind || !id) continue;
          const key = externalActionKey(kind, id);
          if (seen.has(key)) continue;
          seen.add(key);
          const state = stateForJobStatus(job.status);
          if (getSnapshot(key).state !== "IDLE" || starting.has(key)) continue;
          if (ACTIVE_STATES.has(state) || state === "IN_LIBRARY") track(key, job);
        }
      })
      .catch(() => {
        // Without history every card simply starts IDLE; allow a later retry.
        hydration = null;
      });
    return hydration;
  }

  function reset() {
    timers.forEach((handle) => deps.cancel(handle));
    timers.clear();
    entries.clear();
    titles.clear();
    starting.clear();
    hydration = null;
    listeners.forEach((set) => set.forEach((listener) => listener()));
  }

  return {
    getSnapshot,
    subscribe,
    hydrate,
    reset,
    saveExternalAlbum: (album: ExternalMetadataItem) => run("album", album),
    importExternalTrack: (track: ExternalMetadataItem) => run("track", track),
  };
}

export type ExternalActions = ReturnType<typeof createExternalActions>;

export const externalActions = createExternalActions();

/** Subscribes a component to one item's lifecycle only. */
export function useExternalAction(
  kind: ExternalItemKind,
  item: ExternalMetadataItem,
  actions: ExternalActions = externalActions,
) {
  const key = externalActionKey(kind, item.id);
  const subscribe = useCallback((listener: () => void) => actions.subscribe(key, listener), [actions, key]);
  const getSnapshot = useCallback(() => actions.getSnapshot(key), [actions, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void actions.hydrate();
  }, [actions]);

  const start = useCallback(
    () => (kind === "album" ? actions.saveExternalAlbum(item) : actions.importExternalTrack(item)),
    [actions, kind, item],
  );
  return { snapshot, start };
}
