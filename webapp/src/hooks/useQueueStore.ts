import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { readLocalQueue, writeLocalQueue, writeQueueCheckpoint, sanitizeQueueTrack, queueStorageError,
  type QueueCheckpoint, type QueueHead, type LocalQueue, type PersistedQueueEntry } from "../services/storage/QueueDatabase";
import type { QueuePlaybackEngine } from "../services/audio/PlaybackEngine";
import type { EngineState, PlayableTrack } from "../services/audio/types";
import { weightedShuffle } from "../utils/shuffle";
import type { ShuffleTrack, SmartShuffleOptions } from "../utils/shuffle";

export const PLAYBACK_STATUSES = [
  "PLAYING",
  "PAUSED",
  "BUFFERING",
  "STALLED",
  "TRANSITIONING",
] as const;
export type PlaybackStatus = (typeof PLAYBACK_STATUSES)[number];

export type StatusEvent =
  | "LOAD"
  | "CUE"
  | "PLAY"
  | "PAUSE"
  | "WAIT"
  | "STALL"
  | "RECOVER"
  | "TRANSITION_START"
  | "TRANSITION_END"
  | "END_OF_QUEUE"
  | "ERROR";

/** Events missing from a row are ignored in that state. */
export const STATUS_TRANSITIONS: Readonly<
  Record<PlaybackStatus, Readonly<Partial<Record<StatusEvent, PlaybackStatus>>>>
> = {
  PLAYING: {
    LOAD: "BUFFERING",
    CUE: "PAUSED",
    PAUSE: "PAUSED",
    WAIT: "BUFFERING",
    STALL: "STALLED",
    TRANSITION_START: "TRANSITIONING",
    END_OF_QUEUE: "PAUSED",
    ERROR: "PAUSED",
  },
  PAUSED: {
    LOAD: "BUFFERING",
    PLAY: "PLAYING",
    STALL: "STALLED",
  },
  BUFFERING: {
    LOAD: "BUFFERING",
    CUE: "PAUSED",
    PLAY: "PLAYING",
    PAUSE: "PAUSED",
    STALL: "STALLED",
    END_OF_QUEUE: "PAUSED",
    ERROR: "PAUSED",
  },
  STALLED: {
    LOAD: "BUFFERING",
    CUE: "PAUSED",
    PLAY: "PLAYING",
    PAUSE: "PAUSED",
    RECOVER: "BUFFERING",
    ERROR: "PAUSED",
  },
  TRANSITIONING: {
    LOAD: "BUFFERING",
    CUE: "PAUSED",
    PAUSE: "PAUSED",
    STALL: "STALLED",
    TRANSITION_END: "PLAYING",
    ERROR: "PAUSED",
  },
};

export function nextStatus(status: PlaybackStatus, event: StatusEvent): PlaybackStatus {
  return STATUS_TRANSITIONS[status][event] ?? status;
}

export type QueueTrackLike = ShuffleTrack;

export interface QueueEntry<T extends QueueTrackLike> {
  /** Stable, unique per position in the queue; doubles as the engine track key. */
  readonly entryId: string;
  readonly track: T;
}

export interface LoadRequest {
  readonly sequence: number;
  readonly entryId: string;
  readonly startAt: number;
  readonly autoplay: boolean;
}

export interface QueueState<T extends QueueTrackLike> {
  readonly entries: readonly QueueEntry<T>[];
  /** -1 only when `entries` is empty. */
  readonly currentIndex: number;
  readonly status: PlaybackStatus;
  /** Increments on every queue mutation. */
  readonly revision: number;
  /** Changes only when the queue is replaced or cleared; async appends tagged with an older generation are dropped. */
  readonly generation: number;
  /** Repeat-one: a finished track reloads instead of advancing, and no transition is prepared. */
  readonly repeatOne: boolean;
  /** The engine command the store owes; a new sequence means "load this now". */
  readonly loadRequest: LoadRequest | null;
  readonly lastError: string | null;
  readonly nextEntrySequence: number;
  readonly loadSequence: number;
  readonly shuffleSeed: number | null;
  readonly shuffleExcludedCount: number;
}

export type QueueAction<T extends QueueTrackLike> =
  | { type: "HYDRATE_QUEUE"; entries: readonly QueueEntry<T>[]; index: number; options?: SetQueueOptions }
  | {
    type: "SET_QUEUE";
    tracks: readonly T[];
    startIndex?: number;
    autoplay?: boolean;
    startAt?: number;
    /** Select the start entry without asking the engine to load it (e.g. a restored, paused queue). */
    deferLoad?: boolean;
    shuffleSeed?: number | null;
    smartShuffle?: SmartShuffleOptions;
  }
  | { type: "PLAY_NEXT" }
  | { type: "PLAY_PREVIOUS"; position: number; restartThresholdSeconds?: number }
  | { type: "JUMP_TO_INDEX"; index: number }
  | { type: "INJECT_NEXT"; track: T }
  | { type: "INJECT_NEXT_MANY"; tracks: readonly T[] }
  | { type: "APPEND"; tracks: readonly T[]; dedupe?: boolean; generation?: number }
  | { type: "MOVE"; from: number; to: number }
  /** `randoms` are precomputed values in [0, 1) so the reducer stays pure. */
  | { type: "SHUFFLE_UPCOMING"; randoms: readonly number[] }
  | { type: "SMART_SHUFFLE_UPCOMING"; options: SmartShuffleOptions }
  | { type: "REMOVE_TRACKS"; ids: readonly (string | number)[] }
  | { type: "REMOVE_ENTRIES"; ids: readonly string[] }
  | { type: "SET_REPEAT_ONE"; enabled: boolean }
  | { type: "LOAD_CURRENT"; startAt?: number; autoplay?: boolean }
  | { type: "STOP" }
  | { type: "ENGINE_STATE"; key: string | null; state: EngineState }
  | { type: "ENGINE_TRACK_END"; key: string }
  | { type: "ENGINE_BUFFER_STALL"; key: string }
  | { type: "ENGINE_STREAM_RECOVERED"; key: string }
  | { type: "ENGINE_RECOVERY_FAILED"; key: string }
  | { type: "ENGINE_TRANSITION_START"; fromKey: string; toKey: string }
  | { type: "ENGINE_TRANSITION_COMMIT"; fromKey: string; toKey: string }
  | { type: "ENGINE_TRANSITION_CANCEL"; fromKey: string; toKey: string }
  | { type: "ENGINE_ERROR"; key: string | null; message: string };

export const DEFAULT_RESTART_THRESHOLD_SECONDS = 3;
const RECOVERY_FAILED_MESSAGE = "Lost connection to the server. Press play to try again.";

export function createQueueState<T extends QueueTrackLike>(): QueueState<T> {
  return {
    entries: [],
    currentIndex: -1,
    status: "PAUSED",
    revision: 0,
    generation: 0,
    repeatOne: false,
    loadRequest: null,
    lastError: null,
    nextEntrySequence: 0,
    loadSequence: 0,
    shuffleSeed: null,
    shuffleExcludedCount: 0,
  };
}

/** An empty queue that keeps the counters, so entry ids and load sequences are never reused. */
function clearedState<T extends QueueTrackLike>(state: QueueState<T>): QueueState<T> {
  return {
    ...createQueueState<T>(),
    revision: state.revision + 1,
    generation: state.generation + 1,
    repeatOne: state.repeatOne,
    nextEntrySequence: state.nextEntrySequence,
    loadSequence: state.loadSequence,
  };
}

/**
 * Fisher–Yates over the entries after `currentIndex`, driven by caller-supplied
 * random values so the same inputs always produce the same order.
 */
export function shuffleUpcoming<E>(items: readonly E[], currentIndex: number, randoms: readonly number[]): E[] {
  const start = currentIndex + 1;
  if (currentIndex < 0 || items.length - start < 2) return [...items];
  const upcoming = items.slice(start);
  for (let index = upcoming.length - 1, step = 0; index > 0; index -= 1, step += 1) {
    const random = randoms[step] ?? 0;
    const swap = Math.min(index, Math.floor(Math.max(0, random) * (index + 1)));
    [upcoming[index], upcoming[swap]] = [upcoming[swap], upcoming[index]];
  }
  return [...items.slice(0, start), ...upcoming];
}

export function currentEntryOf<T extends QueueTrackLike>(state: QueueState<T>): QueueEntry<T> | null {
  return state.entries[state.currentIndex] ?? null;
}

export function upcomingEntryOf<T extends QueueTrackLike>(state: QueueState<T>): QueueEntry<T> | null {
  if (state.repeatOne) return null;
  return state.currentIndex >= 0 ? state.entries[state.currentIndex + 1] ?? null : null;
}

/** Invariants every reducer output satisfies; exported for tests and dev assertions. */
export function queueInvariantViolations<T extends QueueTrackLike>(state: QueueState<T>): string[] {
  const problems: string[] = [];
  const ids = new Set(state.entries.map((entry) => entry.entryId));
  if (ids.size !== state.entries.length) problems.push("duplicate entryId");
  if (state.entries.length === 0 && state.currentIndex !== -1) problems.push("index set on empty queue");
  if (
    state.entries.length > 0 &&
    (!Number.isInteger(state.currentIndex) ||
      state.currentIndex < 0 ||
      state.currentIndex >= state.entries.length)
  ) {
    problems.push("currentIndex out of range");
  }
  if (state.loadRequest && !ids.has(state.loadRequest.entryId)) problems.push("loadRequest for unknown entry");
  return problems;
}

function sameTrack(a: QueueTrackLike, b: QueueTrackLike): boolean {
  return String(a.id) === String(b.id);
}

function withStatus<T extends QueueTrackLike>(state: QueueState<T>, event: StatusEvent): QueueState<T> {
  const status = nextStatus(state.status, event);
  return status === state.status ? state : { ...state, status };
}

/** Moves `currentIndex` to `index` and asks the engine to start it. */
function loadIndex<T extends QueueTrackLike>(
  state: QueueState<T>,
  entries: readonly QueueEntry<T>[],
  index: number,
  startAt = 0,
  autoplay = true
): QueueState<T> {
  const entry = entries[index];
  const loadSequence = state.loadSequence + 1;
  return {
    ...state,
    entries,
    currentIndex: index,
    revision: state.revision + 1,
    loadSequence,
    loadRequest: { sequence: loadSequence, entryId: entry.entryId, startAt, autoplay },
    lastError: null,
    status: nextStatus(state.status, autoplay ? "LOAD" : "CUE"),
  };
}

function isCurrentKey<T extends QueueTrackLike>(state: QueueState<T>, key: string | null): boolean {
  return key !== null && currentEntryOf(state)?.entryId === key;
}

const ENGINE_STATE_EVENTS: Readonly<Partial<Record<EngineState, StatusEvent>>> = {
  loading: "LOAD",
  playing: "PLAY",
  paused: "PAUSE",
  idle: "PAUSE",
  buffering: "WAIT",
  stalled: "STALL",
  error: "ERROR",
};

/**
 * Pure queue state machine. Entries and the current index live in one object
 * and change together, so no interleaving of actions can desynchronize them.
 * Engine events carry the entry key they refer to; events for any entry other
 * than the current one are stale (e.g. from a track the user already skipped)
 * and are ignored.
 */
export function queueReducer<T extends QueueTrackLike>(
  state: QueueState<T>,
  action: QueueAction<T>
): QueueState<T> {
  switch (action.type) {
    case "HYDRATE_QUEUE": {
      if (!action.entries.length) return clearedState(state);
      if (action.index < 0 || action.index >= action.entries.length) return state;
      let nextEntrySequence = state.nextEntrySequence + action.entries.length;
      for (const entry of action.entries) if (/^q\d+$/.test(entry.entryId)) nextEntrySequence = Math.max(nextEntrySequence, Number(entry.entryId.slice(1)) + 1);
      const base = { ...state, entries: action.entries, currentIndex: action.index, revision: state.revision + 1,
        generation: state.generation + 1, nextEntrySequence, shuffleSeed: action.options?.shuffleSeed ?? null, lastError: null };
      return action.options?.deferLoad ? { ...base, status: "PAUSED", loadRequest: null }
        : loadIndex(base, action.entries, action.index, action.options?.startAt ?? 0, action.options?.autoplay ?? false);
    }
    case "SET_QUEUE": {
      if (action.tracks.length === 0) return clearedState(state);
      let entries = action.tracks.map((track, offset) => ({
        entryId: `q${state.nextEntrySequence + offset}`,
        track,
      }));
      const requested = action.startIndex ?? 0;
      const startIndex = Number.isInteger(requested) && requested >= 0 && requested < entries.length
        ? requested
        : 0;
      const result = action.smartShuffle ? weightedShuffle(entries.slice(startIndex + 1), {
        ...action.smartShuffle, currentTrack: entries[startIndex].track,
      }, (entry) => entry.track) : null;
      if (result) entries = [...entries.slice(0, startIndex + 1), ...result.tracks];
      const base = {
        ...state,
        generation: state.generation + 1,
        nextEntrySequence: state.nextEntrySequence + action.tracks.length,
        shuffleSeed: action.smartShuffle?.seed ?? action.shuffleSeed ?? null,
        shuffleExcludedCount: result?.excludedCount ?? 0,
      };
      if (action.deferLoad) {
        return {
          ...base,
          entries,
          currentIndex: startIndex,
          revision: state.revision + 1,
          loadRequest: null,
          lastError: null,
          status: "PAUSED",
        };
      }
      return loadIndex(
        base,
        entries,
        startIndex,
        Math.max(0, action.startAt ?? 0),
        action.autoplay ?? true
      );
    }

    case "PLAY_NEXT": {
      const nextIndex = state.currentIndex + 1;
      if (state.currentIndex < 0 || nextIndex >= state.entries.length) return state;
      return loadIndex(state, state.entries, nextIndex);
    }

    case "PLAY_PREVIOUS": {
      if (state.currentIndex < 0) return state;
      const threshold = action.restartThresholdSeconds ?? DEFAULT_RESTART_THRESHOLD_SECONDS;
      const restart = state.currentIndex === 0 || action.position > threshold;
      return loadIndex(state, state.entries, restart ? state.currentIndex : state.currentIndex - 1);
    }

    case "JUMP_TO_INDEX": {
      const { index } = action;
      if (!Number.isInteger(index) || index < 0 || index >= state.entries.length) return state;
      return loadIndex(state, state.entries, index);
    }

    case "INJECT_NEXT_MANY": {
      if (!action.tracks.length) return state;
      const injected = action.tracks.map((track, index) => ({ entryId: `q${state.nextEntrySequence + index}`, track }));
      const next = { ...state, nextEntrySequence: state.nextEntrySequence + injected.length };
      if (!currentEntryOf(state)) return loadIndex(next, injected, 0, 0, false);
      return {
        ...next, revision: state.revision + 1,
        entries: [...state.entries.slice(0, state.currentIndex + 1), ...injected, ...state.entries.slice(state.currentIndex + 1)],
      };
    }
    case "INJECT_NEXT": {
      const current = currentEntryOf(state);
      if (!current) {
        const entries = [{ entryId: `q${state.nextEntrySequence}`, track: action.track }];
        return loadIndex(
          { ...state, nextEntrySequence: state.nextEntrySequence + 1 },
          entries,
          0,
          0,
          false
        );
      }
      if (sameTrack(current.track, action.track)) return state;

      const history = state.entries.slice(0, state.currentIndex + 1);
      const upcoming = state.entries.slice(state.currentIndex + 1);
      const existing = upcoming.find((entry) => sameTrack(entry.track, action.track));
      if (existing && upcoming[0] === existing) return state;
      // Moving an already-queued entry keeps its entryId (and any prepared engine buffer).
      const injected = existing ?? { entryId: `q${state.nextEntrySequence}`, track: action.track };
      const remaining = upcoming.filter((entry) => entry !== existing);
      return {
        ...state,
        entries: [...history, injected, ...remaining],
        revision: state.revision + 1,
        nextEntrySequence: existing ? state.nextEntrySequence : state.nextEntrySequence + 1,
      };
    }

    case "APPEND": {
      if (action.generation !== undefined && action.generation !== state.generation) return state;
      const seen = new Set(state.entries.map((entry) => String(entry.track.id)));
      const tracks = action.dedupe
        ? action.tracks.filter((track) => {
          const id = String(track.id);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        : action.tracks;
      if (tracks.length === 0) return state;
      const appended = tracks.map((track, offset) => ({
        entryId: `q${state.nextEntrySequence + offset}`,
        track,
      }));
      return {
        ...state,
        entries: [...state.entries, ...appended],
        // Appending to an empty queue selects the first track without starting it.
        currentIndex: state.currentIndex < 0 ? 0 : state.currentIndex,
        revision: state.revision + 1,
        nextEntrySequence: state.nextEntrySequence + appended.length,
      };
    }

    case "MOVE": {
      const { from, to } = action;
      const length = state.entries.length;
      // Only upcoming entries move; history and the current entry keep their positions.
      if (
        !Number.isInteger(from) || !Number.isInteger(to) || from === to ||
        from <= state.currentIndex || to <= state.currentIndex ||
        from >= length || to >= length
      ) {
        return state;
      }
      const entries = [...state.entries];
      const [moved] = entries.splice(from, 1);
      entries.splice(to, 0, moved);
      return { ...state, entries, revision: state.revision + 1 };
    }

    case "SHUFFLE_UPCOMING": {
      if (state.entries.length - state.currentIndex - 1 < 2 || state.currentIndex < 0) return state;
      return {
        ...state,
        entries: shuffleUpcoming(state.entries, state.currentIndex, action.randoms),
        revision: state.revision + 1,
        shuffleSeed: null,
        shuffleExcludedCount: 0,
      };
    }

    case "SMART_SHUFFLE_UPCOMING": {
      const current = currentEntryOf(state);
      if (!current) return state;
      const result = weightedShuffle(state.entries.slice(state.currentIndex + 1), {
        ...action.options, currentTrack: current.track,
      }, (entry) => entry.track);
      return {
        ...state,
        entries: [...state.entries.slice(0, state.currentIndex + 1), ...result.tracks],
        revision: state.revision + 1,
        shuffleSeed: action.options.seed,
        shuffleExcludedCount: result.excludedCount,
      };
    }

    case "REMOVE_TRACKS":
    case "REMOVE_ENTRIES": {
      const ids = new Set(action.ids.map(String));
      const removed = (entry: QueueEntry<T>) => ids.has(action.type === "REMOVE_ENTRIES" ? entry.entryId : String(entry.track.id));
      if (!state.entries.some(removed)) return state;
      const current = currentEntryOf(state);
      const entries = state.entries.filter((entry) => !removed(entry));
      const keepsLoad = state.loadRequest && entries.some((entry) => entry.entryId === state.loadRequest?.entryId);
      if (!current || !removed(current)) {
        const removedBefore = state.entries
          .slice(0, state.currentIndex)
          .filter(removed).length;
        return {
          ...state,
          entries,
          currentIndex: state.currentIndex - removedBefore,
          revision: state.revision + 1,
          loadRequest: keepsLoad ? state.loadRequest : null,
        };
      }
      // The audible track is gone: stop on the entry that followed it, or clear the queue.
      const following = state.entries
        .slice(state.currentIndex + 1)
        .find((entry) => !removed(entry));
      if (!following) return clearedState(state);
      return {
        ...state,
        entries,
        currentIndex: entries.indexOf(following),
        revision: state.revision + 1,
        loadRequest: null,
        lastError: null,
        status: "PAUSED",
      };
    }

    case "SET_REPEAT_ONE":
      return state.repeatOne === action.enabled ? state : { ...state, repeatOne: action.enabled };

    case "LOAD_CURRENT": {
      if (state.currentIndex < 0) return state;
      return loadIndex(
        state,
        state.entries,
        state.currentIndex,
        Math.max(0, action.startAt ?? 0),
        action.autoplay ?? true
      );
    }

    case "STOP":
      return state.entries.length === 0 && state.loadRequest === null ? state : clearedState(state);

    case "ENGINE_STATE": {
      if (!isCurrentKey(state, action.key)) return state;
      const event = ENGINE_STATE_EVENTS[action.state];
      return event ? withStatus(state, event) : state;
    }

    case "ENGINE_TRACK_END": {
      if (!isCurrentKey(state, action.key)) return state;
      if (state.repeatOne) return loadIndex(state, state.entries, state.currentIndex);
      const nextIndex = state.currentIndex + 1;
      if (nextIndex < state.entries.length) return loadIndex(state, state.entries, nextIndex);
      return withStatus({ ...state, loadRequest: null }, "END_OF_QUEUE");
    }

    case "ENGINE_BUFFER_STALL":
      return isCurrentKey(state, action.key) ? withStatus(state, "STALL") : state;

    case "ENGINE_STREAM_RECOVERED":
      return isCurrentKey(state, action.key)
        ? withStatus({ ...state, lastError: null }, "RECOVER")
        : state;

    case "ENGINE_RECOVERY_FAILED":
      return isCurrentKey(state, action.key)
        ? withStatus({ ...state, lastError: RECOVERY_FAILED_MESSAGE }, "ERROR")
        : state;

    case "ENGINE_TRANSITION_START": {
      if (!isCurrentKey(state, action.fromKey)) return state;
      if (upcomingEntryOf(state)?.entryId !== action.toKey) return state;
      return withStatus(state, "TRANSITION_START");
    }

    case "ENGINE_TRANSITION_CANCEL":
      return isCurrentKey(state, action.fromKey) ? withStatus(state, "TRANSITION_END") : state;

    case "ENGINE_TRANSITION_COMMIT": {
      if (isCurrentKey(state, action.toKey)) return state;
      if (!isCurrentKey(state, action.fromKey)) return state;
      const toIndex = state.entries.findIndex((entry) => entry.entryId === action.toKey);
      if (toIndex === -1) {
        // The audible track was removed from the queue mid-transition: resync to the next entry.
        const nextIndex = state.currentIndex + 1;
        return nextIndex < state.entries.length
          ? loadIndex(state, state.entries, nextIndex)
          : withStatus({ ...state, loadRequest: null }, "END_OF_QUEUE");
      }
      let entries = state.entries;
      let currentIndex = state.currentIndex;
      if (toIndex !== currentIndex + 1) {
        // The queue changed while the engine was handing over: the audible entry
        // becomes current and nothing queued after the old current entry is skipped.
        const moved = entries[toIndex];
        const without = entries.filter((_, index) => index !== toIndex);
        currentIndex = toIndex < currentIndex ? currentIndex - 1 : currentIndex;
        entries = [...without.slice(0, currentIndex + 1), moved, ...without.slice(currentIndex + 1)];
      }
      return {
        ...state,
        entries,
        currentIndex: currentIndex + 1,
        revision: state.revision + 1,
        lastError: null,
        status: state.status === "TRANSITIONING"
          ? nextStatus(state.status, "TRANSITION_END")
          : "PLAYING",
      };
    }

    case "ENGINE_ERROR":
      if (action.key !== null && !isCurrentKey(state, action.key)) return state;
      return withStatus({ ...state, lastError: action.message }, "ERROR");

    default:
      return state;
  }
}

export interface UseQueueStoreOptions<T extends QueueTrackLike> {
  /** Maps a queue entry to an engine track; `key` must be `entry.entryId`. */
  toPlayable: (entry: QueueEntry<T>) => PlayableTrack;
  restartThresholdSeconds?: number;
  /**
   * Returns a user-facing reason when an entry has no playable source. Such an
   * entry is never handed to the engine: loading it pauses playback and
   * reports the reason, and it is never prepared as the upcoming track.
   */
  unplayableReason?: (entry: QueueEntry<T>) => string | null;
}

export interface SetQueueOptions {
  autoplay?: boolean;
  startAt?: number;
  deferLoad?: boolean;
  shuffleSeed?: number | null;
  smartShuffle?: SmartShuffleOptions;
}

export interface QueueStore<T extends QueueTrackLike> {
  hydrate: (entries: readonly QueueEntry<T>[], index: number, options?: SetQueueOptions) => void;
  state: QueueState<T>;
  currentEntry: QueueEntry<T> | null;
  upcomingEntry: QueueEntry<T> | null;
  setQueue: (tracks: readonly T[], startIndex?: number, options?: SetQueueOptions) => void;
  playNext: () => void;
  playPrevious: () => void;
  jumpToIndex: (index: number) => void;
  injectNext: (track: T) => void;
  injectNextMany: (tracks: readonly T[]) => void;
  append: (tracks: readonly T[], options?: { dedupe?: boolean; generation?: number }) => void;
  move: (from: number, to: number) => void;
  shuffleUpcoming: (randoms: readonly number[]) => void;
  smartShuffleUpcoming: (options: SmartShuffleOptions) => void;
  removeTracks: (ids: readonly (string | number)[]) => void;
  removeEntries: (ids: readonly string[]) => void;
  setRepeatOne: (enabled: boolean) => void;
  loadCurrent: (options?: { startAt?: number; autoplay?: boolean }) => void;
  stop: () => void;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
}

function playableFor<T extends QueueTrackLike>(
  entry: QueueEntry<T>,
  toPlayable: (entry: QueueEntry<T>) => PlayableTrack
): PlayableTrack {
  const playable = toPlayable(entry);
  return playable.key === entry.entryId ? playable : { ...playable, key: entry.entryId };
}

/**
 * React binding: engine events → reducer, reducer load requests → engine.
 * The engine is told about the upcoming entry so it can prepare a gapless
 * buffer or crossfade deck, and any queue edit re-targets that preparation.
 */
export function useQueueStore<T extends QueueTrackLike>(
  engine: QueuePlaybackEngine | null,
  options: UseQueueStoreOptions<T>
): QueueStore<T> {
  const [state, dispatch] = useReducer(
    queueReducer as (state: QueueState<T>, action: QueueAction<T>) => QueueState<T>,
    undefined,
    createQueueState as () => QueueState<T>
  );
  const toPlayableRef = useRef(options.toPlayable);
  const thresholdRef = useRef(options.restartThresholdSeconds);
  const unplayableRef = useRef(options.unplayableReason);
  const handledLoadRef = useRef(0);

  useEffect(() => {
    toPlayableRef.current = options.toPlayable;
    thresholdRef.current = options.restartThresholdSeconds;
    unplayableRef.current = options.unplayableReason;
  });

  useEffect(() => {
    if (!engine) return undefined;
    // A new engine instance has not loaded anything yet.
    handledLoadRef.current = 0;
    const unsubscribers = [
      engine.on("stateChange", ({ key, state: engineState }) =>
        dispatch({ type: "ENGINE_STATE", key, state: engineState })),
      engine.on("trackEnd", ({ key }) => dispatch({ type: "ENGINE_TRACK_END", key })),
      engine.on("bufferStall", ({ key }) => dispatch({ type: "ENGINE_BUFFER_STALL", key })),
      engine.on("streamRecovered", ({ key }) => dispatch({ type: "ENGINE_STREAM_RECOVERED", key })),
      engine.on("recoveryFailed", ({ key }) => dispatch({ type: "ENGINE_RECOVERY_FAILED", key })),
      engine.on("transitionStart", ({ fromKey, toKey }) =>
        dispatch({ type: "ENGINE_TRANSITION_START", fromKey, toKey })),
      engine.on("transitionCommit", ({ fromKey, toKey }) =>
        dispatch({ type: "ENGINE_TRANSITION_COMMIT", fromKey, toKey })),
      engine.on("transitionCancel", ({ fromKey, toKey }) =>
        dispatch({ type: "ENGINE_TRANSITION_CANCEL", fromKey, toKey })),
      engine.on("error", ({ key, message }) => dispatch({ type: "ENGINE_ERROR", key, message })),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [engine]);

  const { loadRequest, entries } = state;
  useEffect(() => {
    if (!engine || !loadRequest || loadRequest.sequence === handledLoadRef.current) return;
    const entry = entries.find((candidate) => candidate.entryId === loadRequest.entryId);
    if (!entry) return;
    handledLoadRef.current = loadRequest.sequence;
    const blocked = unplayableRef.current?.(entry) ?? null;
    if (blocked) {
      engine.pause();
      dispatch({ type: "ENGINE_ERROR", key: entry.entryId, message: blocked });
      return;
    }
    engine
      .load(playableFor(entry, toPlayableRef.current), {
        startAt: loadRequest.startAt,
        autoplay: loadRequest.autoplay,
      })
      .catch((error: unknown) => {
        dispatch({
          type: "ENGINE_ERROR",
          key: entry.entryId,
          message: error instanceof Error ? error.message : "Could not load this track.",
        });
      });
  }, [engine, loadRequest, entries]);

  const upcomingEntry = upcomingEntryOf(state);
  useEffect(() => {
    if (!engine) return;
    const playable = upcomingEntry && !unplayableRef.current?.(upcomingEntry)
      ? playableFor(upcomingEntry, toPlayableRef.current)
      : null;
    engine.setUpcoming(playable);
  }, [engine, upcomingEntry]);

  const actions = useMemo(() => ({
    hydrate: (hydrated: readonly QueueEntry<T>[], index: number, restoreOptions: SetQueueOptions = {}) =>
      dispatch({ type: "HYDRATE_QUEUE", entries: hydrated, index, options: restoreOptions }),
    setQueue: (tracks: readonly T[], startIndex = 0, queueOptions: SetQueueOptions = {}) =>
      dispatch({ type: "SET_QUEUE", tracks, startIndex, ...queueOptions }),
    playNext: () => dispatch({ type: "PLAY_NEXT" }),
    playPrevious: () => dispatch({
      type: "PLAY_PREVIOUS",
      position: engine?.getPosition() ?? 0,
      restartThresholdSeconds: thresholdRef.current,
    }),
    jumpToIndex: (index: number) => dispatch({ type: "JUMP_TO_INDEX", index }),
    injectNext: (track: T) => dispatch({ type: "INJECT_NEXT", track }),
    injectNextMany: (tracks: readonly T[]) => dispatch({ type: "INJECT_NEXT_MANY", tracks }),
    append: (tracks: readonly T[], appendOptions: { dedupe?: boolean; generation?: number } = {}) =>
      dispatch({ type: "APPEND", tracks, ...appendOptions }),
    move: (from: number, to: number) => dispatch({ type: "MOVE", from, to }),
    shuffleUpcoming: (randoms: readonly number[]) => dispatch({ type: "SHUFFLE_UPCOMING", randoms }),
    smartShuffleUpcoming: (shuffleOptions: SmartShuffleOptions) => dispatch({ type: "SMART_SHUFFLE_UPCOMING", options: shuffleOptions }),
    removeTracks: (ids: readonly (string | number)[]) => dispatch({ type: "REMOVE_TRACKS", ids }),
    removeEntries: (ids: readonly string[]) => dispatch({ type: "REMOVE_ENTRIES", ids }),
    setRepeatOne: (enabled: boolean) => dispatch({ type: "SET_REPEAT_ONE", enabled }),
    loadCurrent: (loadOptions: { startAt?: number; autoplay?: boolean } = {}) =>
      dispatch({ type: "LOAD_CURRENT", ...loadOptions }),
    stop: () => dispatch({ type: "STOP" }),
    play: () => {
      engine?.play().catch(() => undefined);
    },
    pause: () => engine?.pause(),
    seek: (seconds: number) => engine?.seek(seconds),
  }), [engine]);

  return {
    state,
    currentEntry: currentEntryOf(state),
    upcomingEntry,
    ...actions,
  };
}

/** Account-scoped asynchronous persistence. Large content is encoded only when
 * entries change; progress writes update a separate small IndexedDB record. */
export function usePersistentQueue<T extends QueueTrackLike>(store: QueueStore<T>, binding: {
  ownerId: string | null; checkpointKey?: unknown; getCheckpoint(): QueueCheckpoint;
  onRestore(saved: LocalQueue): SetQueueOptions; onReady(owner: string): void; onError(message: string): void;
}) {
  const [readyOwner, setReadyOwner] = useState<string | null>(null);
  const latest = useRef({ store, binding }); latest.current = { store, binding };
  const head = useRef<QueueHead | null>(null), savedEntries = useRef<readonly QueueEntry<T>[] | null>(null);
  const epoch = useRef(0), previousOwner = useRef<string | null>(null), tail = useRef<Promise<QueueHead | null>>(Promise.resolve(null));
  useLayoutEffect(() => {
    const owner = binding.ownerId, version = ++epoch.current;
    const reset = previousOwner.current !== null && previousOwner.current !== owner;
    previousOwner.current = owner; head.current = null; savedEntries.current = null; setReadyOwner(null);
    const current = latest.current.store.state;
    const baseline = current.generation + (reset && (current.entries.length > 0 || current.loadRequest !== null) ? 1 : 0);
    if (reset) { latest.current.store.pause(); latest.current.store.stop(); }
    if (!owner) return;
    void readLocalQueue(owner).then(saved => {
      if (version !== epoch.current) return;
      if (saved && latest.current.store.state.generation === baseline) {
        const options = latest.current.binding.onRestore(saved);
        const entries = saved.content.entries as unknown as readonly QueueEntry<T>[];
        latest.current.store.hydrate(entries, saved.head.checkpoint.index, options);
        head.current = saved.head; savedEntries.current = entries;
      }
    }).catch(error => { if (version === epoch.current) latest.current.binding.onError(queueStorageError(error)); })
      .finally(() => { if (version === epoch.current) { setReadyOwner(owner); latest.current.binding.onReady(owner); } });
    return () => { epoch.current = version + 1; };
    // Product callbacks live in refs; changing playback position must not restart hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding.ownerId]);
  const flush = useCallback((): Promise<QueueHead | null> => {
    const owner = latest.current.binding.ownerId, version = epoch.current;
    if (!owner || readyOwner !== owner) return Promise.resolve(null);
    const task = tail.current.catch(() => null).then(async () => {
      if (version !== epoch.current || latest.current.binding.ownerId !== owner) return null;
      const entries = latest.current.store.state.entries;
      if (!entries.length && !head.current) return null;
      if (savedEntries.current !== entries) {
        const encoded: PersistedQueueEntry[] = [];
        for (let index = 0; index < entries.length; index++) {
          encoded.push({ entryId: entries[index].entryId, track: sanitizeQueueTrack(entries[index].track) });
          if (index > 0 && index % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          if (version !== epoch.current || latest.current.store.state.entries !== entries) return null;
        }
        const next = await writeLocalQueue(owner, { version: 2, entries: encoded }, latest.current.binding.getCheckpoint());
        if (version === epoch.current && latest.current.store.state.entries === entries) { head.current = next; savedEntries.current = entries; }
        return next;
      }
      if (!head.current) return null;
      const next = await writeQueueCheckpoint(owner, head.current.contentKey, latest.current.binding.getCheckpoint());
      if (version === epoch.current && next) head.current = next; return next;
    });
    tail.current = task;
    void task.catch(error => { if (version === epoch.current) latest.current.binding.onError(queueStorageError(error)); });
    return task;
  }, [readyOwner]);
  useEffect(() => {
    if (!binding.ownerId || readyOwner !== binding.ownerId) return;
    const timer = setTimeout(() => { void flush().catch(() => undefined); }, 100);
    return () => clearTimeout(timer);
  }, [binding.ownerId, binding.checkpointKey, readyOwner, store.state.entries, store.state.currentIndex, store.state.repeatOne, store.state.status, flush]);
  return { ready: readyOwner === binding.ownerId, flush,
    getHead: () => savedEntries.current === latest.current.store.state.entries ? head.current : null };
}
