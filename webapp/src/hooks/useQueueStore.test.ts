import { act, renderHook } from "@testing-library/react";
import { performance } from "perf_hooks";
import type { QueuePlaybackEngine } from "../services/audio/PlaybackEngine";
import type { PlaybackEngineEvent, PlaybackEngineEventMap, PlaybackEngineListener } from "../services/audio/types";
import {
  STATUS_TRANSITIONS,
  createQueueState,
  currentEntryOf,
  queueInvariantViolations,
  queueReducer,
  upcomingEntryOf,
  useQueueStore,
} from "./useQueueStore";
import type { QueueAction, QueueState } from "./useQueueStore";

type Track = { id: string; title: string };
const song = (id: string): Track => ({ id, title: `Song ${id}` });
const songs = (...ids: string[]) => ids.map(song);

function reduce(state: QueueState<Track>, ...actions: QueueAction<Track>[]) {
  return actions.reduce((current, action) => {
    const next = queueReducer(current, action);
    expect(queueInvariantViolations(next)).toEqual([]);
    return next;
  }, state);
}

const ids = (state: QueueState<Track>) => state.entries.map((entry) => entry.track.id);
const loaded = () => reduce(createQueueState<Track>(), {
  type: "SET_QUEUE",
  tracks: songs("a", "b", "c", "d"),
});

describe("queueReducer", () => {
  test("batch Play Next preserves selected order and duplicates without changing playback or history", () => {
    const state = reduce(loaded(), { type: "PLAY_NEXT" });
    const next = reduce(state, { type: "INJECT_NEXT_MANY", tracks: songs("x", "x", "y") });
    expect(ids(next)).toEqual(["a", "b", "x", "x", "y", "c", "d"]);
    expect(next.currentIndex).toBe(state.currentIndex);
    expect(next.loadRequest).toBe(state.loadRequest);
    expect(next.entries.slice(0, state.currentIndex + 1)).toEqual(state.entries.slice(0, state.currentIndex + 1));
    const back = reduce(next, { type: "PLAY_PREVIOUS", position: 0 });
    expect(currentEntryOf(back)?.track.id).toBe("a");
    const empty = reduce(createQueueState<Track>(), { type: "INJECT_NEXT_MANY", tracks: songs("x", "x") });
    expect(ids(empty)).toEqual(["x", "x"]);
    expect(empty.loadRequest?.autoplay).toBe(false);
    expect(reduce(empty, { type: "INJECT_NEXT_MANY", tracks: [] })).toBe(empty);
  });
  test("removing a recommendation entry preserves manually queued duplicates and the active load", () => {
    const state = reduce(createQueueState<Track>(), { type: "SET_QUEUE", tracks: songs("a", "a", "a") });
    const next = reduce(state, { type: "REMOVE_ENTRIES", ids: [state.entries[1].entryId] });
    expect(next.entries.map(({ entryId }) => entryId)).toEqual([state.entries[0].entryId, state.entries[2].entryId]);
    expect(next.loadRequest).toBe(state.loadRequest);
    expect(next.currentIndex).toBe(0);
  });
  test("SET_QUEUE assigns unique entry ids and requests the start track", () => {
    const state = reduce(createQueueState<Track>(), {
      type: "SET_QUEUE",
      tracks: songs("a", "a", "b"),
      startIndex: 1,
    });
    expect(state.entries.map((entry) => entry.entryId)).toEqual(["q0", "q1", "q2"]);
    expect(state.currentIndex).toBe(1);
    expect(state.loadRequest).toEqual({ sequence: 1, entryId: "q1", startAt: 0, autoplay: true });
    expect(state.status).toBe("BUFFERING");
  });

  test("PLAY_NEXT / PLAY_PREVIOUS / JUMP_TO_INDEX move the index atomically", () => {
    let state = loaded();
    state = reduce(state, { type: "PLAY_NEXT" }, { type: "PLAY_NEXT" });
    expect(currentEntryOf(state)?.track.id).toBe("c");
    expect(state.loadRequest?.entryId).toBe("q2");

    state = reduce(state, { type: "PLAY_PREVIOUS", position: 1 });
    expect(currentEntryOf(state)?.track.id).toBe("b");

    const restart = reduce(state, { type: "PLAY_PREVIOUS", position: 12 });
    expect(restart.currentIndex).toBe(state.currentIndex);
    expect(restart.loadRequest?.sequence).toBe((state.loadRequest?.sequence ?? 0) + 1);

    state = reduce(state, { type: "JUMP_TO_INDEX", index: 3 });
    expect(currentEntryOf(state)?.track.id).toBe("d");
    expect(reduce(state, { type: "PLAY_NEXT" })).toBe(state);
    expect(reduce(state, { type: "JUMP_TO_INDEX", index: 9 })).toBe(state);
    expect(reduce(state, { type: "JUMP_TO_INDEX", index: 1.5 })).toBe(state);
  });

  test("INJECT_NEXT inserts after the current entry without duplicating tracks", () => {
    let state = reduce(loaded(), { type: "PLAY_NEXT" });
    state = reduce(state, { type: "INJECT_NEXT", track: song("x") });
    expect(ids(state)).toEqual(["a", "b", "x", "c", "d"]);

    const moved = reduce(state, { type: "INJECT_NEXT", track: song("d") });
    expect(ids(moved)).toEqual(["a", "b", "d", "x", "c"]);
    expect(moved.entries[2].entryId).toBe(state.entries[4].entryId);

    expect(reduce(moved, { type: "INJECT_NEXT", track: song("d") })).toBe(moved);
    expect(reduce(moved, { type: "INJECT_NEXT", track: song("b") })).toBe(moved);
    expect(moved.loadRequest).toBe(state.loadRequest);
  });

  test("INJECT_NEXT on an empty queue cues the track without autoplay", () => {
    const state = reduce(createQueueState<Track>(), { type: "INJECT_NEXT", track: song("x") });
    expect(state.currentIndex).toBe(0);
    expect(state.loadRequest).toEqual(expect.objectContaining({ autoplay: false }));
    expect(state.status).toBe("PAUSED");
  });

  test("events from a skipped track are ignored", () => {
    let state = loaded();
    state = reduce(state, { type: "PLAY_NEXT" }, { type: "PLAY_NEXT" });
    const before = state;
    state = reduce(
      state,
      { type: "ENGINE_TRACK_END", key: "q0" },
      { type: "ENGINE_STATE", key: "q1", state: "playing" },
      { type: "ENGINE_BUFFER_STALL", key: "q1" },
      { type: "ENGINE_TRANSITION_COMMIT", fromKey: "q0", toKey: "q1" }
    );
    expect(state).toBe(before);
  });

  test("track end advances or stops at the end of the queue", () => {
    let state = reduce(loaded(), { type: "ENGINE_STATE", key: "q0", state: "playing" });
    state = reduce(state, { type: "ENGINE_TRACK_END", key: "q0" });
    expect(state.currentIndex).toBe(1);
    expect(state.loadRequest?.entryId).toBe("q1");

    state = reduce(state, { type: "JUMP_TO_INDEX", index: 3 }, { type: "ENGINE_STATE", key: "q3", state: "playing" });
    state = reduce(state, { type: "ENGINE_TRACK_END", key: "q3" });
    expect(state.currentIndex).toBe(3);
    expect(state.loadRequest).toBeNull();
    expect(state.status).toBe("PAUSED");
  });

  test("transition commit advances without a new load request", () => {
    let state = reduce(loaded(), { type: "ENGINE_STATE", key: "q0", state: "playing" });
    const request = state.loadRequest;
    state = reduce(state, { type: "ENGINE_TRANSITION_START", fromKey: "q0", toKey: "q1" });
    expect(state.status).toBe("TRANSITIONING");
    state = reduce(state, { type: "ENGINE_TRANSITION_COMMIT", fromKey: "q0", toKey: "q1" });
    expect(state.currentIndex).toBe(1);
    expect(state.status).toBe("PLAYING");
    expect(state.loadRequest).toBe(request);
  });

  test("a commit racing a queue edit keeps the audible track current and skips nothing", () => {
    let state = reduce(loaded(), { type: "ENGINE_STATE", key: "q0", state: "playing" });
    state = reduce(state, { type: "ENGINE_TRANSITION_START", fromKey: "q0", toKey: "q1" });
    state = reduce(state, { type: "INJECT_NEXT", track: song("x") });
    expect(ids(state)).toEqual(["a", "x", "b", "c", "d"]);
    state = reduce(state, { type: "ENGINE_TRANSITION_COMMIT", fromKey: "q0", toKey: "q1" });
    expect(ids(state)).toEqual(["a", "b", "x", "c", "d"]);
    expect(currentEntryOf(state)?.track.id).toBe("b");
    expect(upcomingEntryOf(state)?.track.id).toBe("x");
  });

  test("status follows the explicit transition table", () => {
    let state = reduce(loaded(), { type: "ENGINE_STATE", key: "q0", state: "playing" });
    expect(state.status).toBe("PLAYING");
    state = reduce(state, { type: "ENGINE_BUFFER_STALL", key: "q0" });
    expect(state.status).toBe("STALLED");
    state = reduce(state, { type: "ENGINE_STATE", key: "q0", state: "buffering" });
    expect(state.status).toBe("STALLED");
    state = reduce(state, { type: "ENGINE_STREAM_RECOVERED", key: "q0" });
    expect(state.status).toBe("BUFFERING");
    state = reduce(state, { type: "ENGINE_STATE", key: "q0", state: "playing" });
    expect(state.status).toBe("PLAYING");
    state = reduce(state, { type: "ENGINE_RECOVERY_FAILED", key: "q0" });
    expect(state.status).toBe("PAUSED");
    expect(state.lastError).toMatch(/Lost connection/);
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual(
      ["BUFFERING", "PAUSED", "PLAYING", "STALLED", "TRANSITIONING"]
    );
  });

  test("SET_QUEUE with deferLoad selects the start entry without an engine load", () => {
    const state = reduce(createQueueState<Track>(), {
      type: "SET_QUEUE", tracks: songs("a", "b"), startIndex: 1, deferLoad: true,
    });
    expect(currentEntryOf(state)?.track.id).toBe("b");
    expect(state.loadRequest).toBeNull();
    expect(state.status).toBe("PAUSED");
    const started = reduce(state, { type: "LOAD_CURRENT", startAt: 42 });
    expect(started.loadRequest).toMatchObject({ entryId: "q1", startAt: 42, autoplay: true });
  });

  test("APPEND dedupes, keeps entry ids unique and drops results for a replaced queue", () => {
    const state = loaded();
    const generation = state.generation;
    const appended = reduce(state, { type: "APPEND", tracks: songs("a", "e", "e", "f"), dedupe: true, generation });
    expect(ids(appended)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(appended.loadRequest).toBe(state.loadRequest);
    const replaced = reduce(appended, { type: "SET_QUEUE", tracks: songs("x") });
    expect(reduce(replaced, { type: "APPEND", tracks: songs("late"), generation })).toBe(replaced);
    const fromEmpty = reduce(createQueueState<Track>(), { type: "APPEND", tracks: songs("a") });
    expect(fromEmpty.currentIndex).toBe(0);
    expect(fromEmpty.loadRequest).toBeNull();
  });

  test("MOVE only reorders upcoming entries", () => {
    const state = reduce(loaded(), { type: "PLAY_NEXT" });
    expect(reduce(state, { type: "MOVE", from: 3, to: 2 }).entries.map((entry) => entry.track.id))
      .toEqual(["a", "b", "d", "c"]);
    for (const [from, to] of [[0, 2], [1, 2], [2, 1], [2, 9], [2, 2], [2.5, 3]]) {
      expect(reduce(state, { type: "MOVE", from, to })).toBe(state);
    }
  });

  test("SHUFFLE_UPCOMING is deterministic for given randoms and never moves the current entry", () => {
    const state = loaded();
    const shuffled = reduce(state, { type: "SHUFFLE_UPCOMING", randoms: [0, 0, 0] });
    expect(ids(shuffled)).toEqual(["a", "c", "d", "b"]);
    expect(reduce(state, { type: "SHUFFLE_UPCOMING", randoms: [0, 0, 0] }).entries)
      .toEqual(shuffled.entries);
    expect(currentEntryOf(shuffled)).toBe(currentEntryOf(state));
  });

  test("SMART_SHUFFLE_UPCOMING removes recent duplicates atomically while retaining current/history identities and loads", () => {
    const state = reduce(loaded(), { type: "PLAY_NEXT" }, { type: "APPEND", tracks: songs("a", "e", "e", "f") });
    const options = { seed: 123, now: 100_000, recentPlays: [{ id: "d", playedAt: 99_000 }], favoriteIds: ["f"] };
    const action: QueueAction<Track> = { type: "SMART_SHUFFLE_UPCOMING", options };
    const shuffled = reduce(state, action);
    expect(shuffled).toEqual(reduce(state, action));
    expect(shuffled.entries.slice(0, 2)).toEqual(state.entries.slice(0, 2));
    expect(shuffled.entries[0]).toBe(state.entries[0]);
    expect(shuffled.entries[1]).toBe(state.entries[1]);
    expect(shuffled.loadRequest).toBe(state.loadRequest);
    expect(shuffled.currentIndex).toBe(1);
    expect(shuffled.shuffleSeed).toBe(123);
    expect(shuffled.shuffleExcludedCount).toBe(2);
    expect(shuffled.entries.slice(2).map((entry) => entry.track.id).sort()).toEqual(["a", "c", "e", "f"]);
    const order = ids(shuffled);
    const navigated = reduce(shuffled, { type: "PLAY_NEXT" }, { type: "PLAY_NEXT" }, { type: "PLAY_PREVIOUS", position: 0 });
    expect(ids(navigated)).toEqual(order);
    expect(navigated.currentIndex).toBe(2);
    expect(navigated.shuffleSeed).toBe(123);
  });

  test("smart SET_QUEUE protects the requested track, including explicit recent selections, and never reuses filtered entry IDs", () => {
    const state = reduce(createQueueState<Track>(), {
      type: "SET_QUEUE", tracks: songs("a", "b", "c", "d", "e"),
      smartShuffle: {
        seed: 0, now: 10, favoriteIds: [],
        recentPlays: [{ id: "a", playedAt: 9 }, { id: "b", playedAt: 9 }, { id: "c", playedAt: 9 }],
      },
    });
    expect(state.entries[0].track.id).toBe("a");
    expect(state.entries.slice(1).map((entry) => entry.track.id).sort()).toEqual(["d", "e"]);
    expect(state.nextEntrySequence).toBe(5);
    expect(state.shuffleExcludedCount).toBe(2);
    const appended = reduce(state, { type: "APPEND", tracks: songs("new-1", "new-2", "new-3") });
    expect(queueInvariantViolations(appended)).toEqual([]);
    expect(appended.entries.slice(-3).map((entry) => entry.entryId)).toEqual(["q5", "q6", "q7"]);
  });

  test("smart exhaustion keeps the current track and rapid previous/next actions never resample the queue", () => {
    const state = loaded();
    const shuffled = reduce(state, { type: "SMART_SHUFFLE_UPCOMING", options: {
      seed: 7, now: 100, favoriteIds: [], recentPlays: songs("b", "c", "d").map((track) => ({ ...track, playedAt: 99 })),
    } });
    expect(ids(shuffled)).toEqual(["a"]);
    expect(reduce(shuffled, { type: "PLAY_NEXT" })).toBe(shuffled);
    expect(reduce(shuffled, { type: "PLAY_PREVIOUS", position: 0 }).entries).toBe(shuffled.entries);
  });

  test("the full smart queue action processes 5,000 tracks efficiently at p95", () => {
    const tracks = Array.from({ length: 5000 }, (_, index) => ({
      ...song(String(index)), artist: `Artist ${index % 600}`,
    }));
    const state = queueReducer(createQueueState<Track>(), { type: "SET_QUEUE", tracks });
    const options = {
      seed: 0, now: 100_000,
      recentPlays: Array.from({ length: 100 }, (_, index) => ({
        id: `heard-${index}`, artist: `Artist ${index}`, playedAt: 99_000 + index,
      })),
      favoriteIds: tracks.filter((_track, index) => index % 3 === 0).map((track) => track.id),
    };
    const run = (seed: number) => queueReducer(state, { type: "SMART_SHUFFLE_UPCOMING", options: { ...options, seed } });
    for (let seed = 0; seed < 15; seed++) run(seed);

    // Wall-clock thresholds are meaningless on a loaded CI runner, so measure a
    // warm baseline of a comparable O(n) pass and scale the budget by the
    // observed machine slowdown. The assertion then guards the algorithm's
    // relative efficiency (O(n log n) weighted draw) instead of a fixed number.
    const baseline: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      tracks.reduce((acc, track) => acc + track.id.length, 0);
      baseline.push(performance.now() - start);
    }
    baseline.sort((a, b) => a - b);
    const baseP95 = baseline[Math.ceil(baseline.length * .95) - 1];

    const timings: number[] = [];
    for (let seed = 0; seed < 50; seed++) {
      const start = performance.now();
      const next = run(seed);
      timings.push(performance.now() - start);
      expect(next.entries).toHaveLength(5000);
      expect(next.entries[0]).toBe(state.entries[0]);
      expect(next.loadRequest).toBe(state.loadRequest);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * .95) - 1];
    // On an unloaded machine the shuffle is ~7-8ms; allow generous headroom and
    // scale by the baseline so a slow/loaded runner doesn't produce false failures.
    const budget = Math.max(25, baseP95 * 40);
    console.info(`Smart queue action 5000 tracks: p95=${p95.toFixed(2)}ms max=${timings[timings.length - 1].toFixed(2)}ms baseline=${baseP95.toFixed(3)}ms budget=${budget.toFixed(1)}ms`);
    expect(p95).toBeLessThan(budget);
  });

  test("REMOVE_TRACKS keeps the current entry or stops on the one that followed it", () => {
    const state = reduce(loaded(), { type: "JUMP_TO_INDEX", index: 2 });
    const withoutHistory = reduce(state, { type: "REMOVE_TRACKS", ids: ["a"] });
    expect(ids(withoutHistory)).toEqual(["b", "c", "d"]);
    expect(currentEntryOf(withoutHistory)?.track.id).toBe("c");
    const withoutCurrent = reduce(state, { type: "REMOVE_TRACKS", ids: ["c"] });
    expect(currentEntryOf(withoutCurrent)?.track.id).toBe("d");
    expect(withoutCurrent.loadRequest).toBeNull();
    expect(withoutCurrent.status).toBe("PAUSED");
    const cleared = reduce(state, { type: "REMOVE_TRACKS", ids: ["c", "d"] });
    expect(cleared.entries).toEqual([]);
    expect(cleared.currentIndex).toBe(-1);
  });

  test("repeat-one reloads the finished entry and prepares no upcoming transition", () => {
    const state = reduce(loaded(), { type: "SET_REPEAT_ONE", enabled: true });
    expect(upcomingEntryOf(state)).toBeNull();
    const repeated = reduce(state, { type: "ENGINE_TRACK_END", key: "q0" });
    expect(repeated.currentIndex).toBe(0);
    expect(repeated.loadRequest?.sequence).toBe((state.loadRequest?.sequence ?? 0) + 1);
    expect(repeated.loadRequest?.entryId).toBe("q0");
    expect(reduce(repeated, { type: "PLAY_NEXT" }).currentIndex).toBe(1);
  });

  test("STOP clears the queue but never reuses entry ids", () => {
    const stopped = reduce(loaded(), { type: "STOP" });
    expect(stopped.entries).toEqual([]);
    const next = reduce(stopped, { type: "SET_QUEUE", tracks: songs("a") });
    expect(next.entries[0].entryId).toBe("q4");
  });

  test("invariants hold across a long random sequence of actions and engine events", () => {
    let seed = 1234567;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <V,>(values: readonly V[]) => values[Math.floor(random() * values.length)];
    const engineStates = ["playing", "paused", "buffering", "stalled", "error", "idle"] as const;
    let state = createQueueState<Track>();
    for (let step = 0; step < 3000; step += 1) {
      const key = () => (state.entries.length && random() < 0.7
        ? pick(state.entries).entryId
        : `q${Math.floor(random() * 50)}`);
      const actions: QueueAction<Track>[] = [
        { type: "SET_QUEUE", tracks: songs(...Array.from({ length: Math.floor(random() * 6) }, () => pick(["a", "b", "c", "d", "e"]))) },
        { type: "PLAY_NEXT" },
        { type: "PLAY_PREVIOUS", position: random() * 10 },
        { type: "JUMP_TO_INDEX", index: Math.floor(random() * 8) - 1 },
        { type: "INJECT_NEXT", track: song(pick(["a", "b", "c", "x", "y"])) },
        { type: "ENGINE_STATE", key: key(), state: pick(engineStates) },
        { type: "ENGINE_TRACK_END", key: key() },
        { type: "ENGINE_TRANSITION_START", fromKey: key(), toKey: key() },
        { type: "ENGINE_TRANSITION_COMMIT", fromKey: key(), toKey: key() },
        { type: "ENGINE_BUFFER_STALL", key: key() },
        { type: "APPEND", tracks: songs(pick(["a", "f", "g"])), dedupe: random() < 0.5 },
        { type: "MOVE", from: Math.floor(random() * 7) - 1, to: Math.floor(random() * 7) - 1 },
        { type: "SHUFFLE_UPCOMING", randoms: [random(), random(), random(), random(), random()] },
        { type: "REMOVE_TRACKS", ids: [pick(["a", "b", "c", "d", "e", "x"])] },
        { type: "SET_REPEAT_ONE", enabled: random() < 0.3 },
        { type: "LOAD_CURRENT", startAt: random() * 5 },
        { type: "STOP" },
        { type: "SET_QUEUE", tracks: songs("a", "b", "c"), startIndex: 1, deferLoad: true },
      ];
      state = queueReducer(state, pick(actions));
      expect(queueInvariantViolations(state)).toEqual([]);
    }
  });
});

class FakeEngine implements QueuePlaybackEngine {
  position = 0;
  load = jest.fn(() => Promise.resolve());
  setUpcoming = jest.fn();
  play = jest.fn(() => Promise.resolve());
  pause = jest.fn();
  seek = jest.fn();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  getPosition = () => this.position;

  on<K extends PlaybackEngineEvent>(event: K, listener: PlaybackEngineListener<K>) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener as (payload: unknown) => void);
    };
  }

  emit<K extends PlaybackEngineEvent>(event: K, payload: PlaybackEngineEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
}

describe("useQueueStore", () => {
  const toPlayable = ({ entryId, track }: { entryId: string; track: Track }) => ({
    key: entryId,
    src: `/stream/${track.id}`,
  });

  test("drives the engine from queue actions and tells it the upcoming entry", () => {
    const engine = new FakeEngine();
    const { result } = renderHook(() => useQueueStore<Track>(engine, { toPlayable }));

    act(() => result.current.setQueue(songs("a", "b", "c", "d")));
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.load).toHaveBeenLastCalledWith(
      { key: "q0", src: "/stream/a" },
      { startAt: 0, autoplay: true }
    );
    expect(engine.setUpcoming).toHaveBeenLastCalledWith({ key: "q1", src: "/stream/b" });
  });

  test("unplayable entries are never loaded or prepared and report their reason", () => {
    const engine = new FakeEngine();
    const unplayableReason = ({ track }: { track: Track }) => (track.id === "x" ? "Preview unavailable" : null);
    const { result } = renderHook(() => useQueueStore<Track>(engine, { toPlayable, unplayableReason }));

    act(() => result.current.setQueue(songs("a", "x")));
    expect(engine.setUpcoming).toHaveBeenLastCalledWith(null);
    act(() => result.current.playNext());
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(result.current.state.lastError).toBe("Preview unavailable");
    expect(result.current.state.status).toBe("PAUSED");
  });

  test("rapid skips batch into a single load of the final track", () => {
    const engine = new FakeEngine();
    const { result } = renderHook(() => useQueueStore<Track>(engine, { toPlayable }));
    act(() => result.current.setQueue(songs("a", "b", "c", "d")));

    act(() => {
      result.current.playNext();
      result.current.playNext();
      result.current.playNext();
    });

    expect(engine.load).toHaveBeenCalledTimes(2);
    expect(engine.load).toHaveBeenLastCalledWith(
      { key: "q3", src: "/stream/d" },
      { startAt: 0, autoplay: true }
    );
    act(() => engine.emit("trackEnd", { key: "q0" }));
    expect(result.current.state.currentIndex).toBe(3);
  });

  test("an engine-side transition advances the queue without reloading", () => {
    const engine = new FakeEngine();
    const { result } = renderHook(() => useQueueStore<Track>(engine, { toPlayable }));
    act(() => result.current.setQueue(songs("a", "b", "c")));

    act(() => {
      engine.emit("stateChange", { key: "q0", state: "playing" });
      engine.emit("transitionStart", { kind: "gapless", fromKey: "q0", toKey: "q1" });
      engine.emit("transitionCommit", { kind: "gapless", fromKey: "q0", toKey: "q1" });
    });

    expect(result.current.currentEntry?.track.id).toBe("b");
    expect(result.current.state.status).toBe("PLAYING");
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.setUpcoming).toHaveBeenLastCalledWith({ key: "q2", src: "/stream/c" });
  });

  test("previous restarts the track once it has played past the threshold", () => {
    const engine = new FakeEngine();
    const { result } = renderHook(() => useQueueStore<Track>(engine, { toPlayable }));
    act(() => result.current.setQueue(songs("a", "b"), 1));

    engine.position = 8;
    act(() => result.current.playPrevious());
    expect(result.current.currentEntry?.track.id).toBe("b");
    expect(engine.load).toHaveBeenCalledTimes(2);

    engine.position = 1;
    act(() => result.current.playPrevious());
    expect(result.current.currentEntry?.track.id).toBe("a");
  });

  test("unsubscribes from the engine on unmount", () => {
    const engine = new FakeEngine();
    const { result, unmount } = renderHook(() => useQueueStore<Track>(engine, { toPlayable }));
    act(() => result.current.setQueue(songs("a", "b")));
    unmount();
    expect(() => engine.emit("trackEnd", { key: "q0" })).not.toThrow();
  });
});
