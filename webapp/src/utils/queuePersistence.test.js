import { createQueueSnapshot, queueStorageKey, readQueueSnapshot } from "./queuePersistence";

test("album context and parsed ReplayGain tags survive reload without losing album dynamics", () => {
  const song = {
    id: "album-song", albumPlaybackId: "record", albumTrackIndex: 2,
    replayGain: { albumGainDb: "-6 dB", trackGainDb: "-12 dB", albumPeak: "0.9", trackPeak: NaN },
  };
  const snapshot = createQueueSnapshot({ currentSong: song, queue: [song], queueIndex: 0 });
  localStorage.setItem(queueStorageKey("album"), JSON.stringify(snapshot));
  expect(readQueueSnapshot(localStorage, "album").queueItems[0]).toMatchObject({
    albumPlaybackId: "record", albumTrackIndex: 2, replayGain: { albumGainDb: -6, trackGainDb: -12, albumPeak: .9 },
  });
});

test("retains the materialized shuffle order and deterministic seed without reshuffling on restore", () => {
  const snapshot = createQueueSnapshot({
    currentSong: { id: "b" }, queue: [{ id: "a" }, { id: "b" }, { id: "d" }, { id: "c" }],
    queueIndex: 1, isShuffleEnabled: true, shuffleSeed: 4294967295,
  });
  localStorage.setItem(queueStorageKey("shuffle-user"), JSON.stringify(snapshot));
  expect(readQueueSnapshot(localStorage, "shuffle-user")).toMatchObject({
    queueTrackIds: ["a", "b", "d", "c"], queueIndex: 1, shuffleSeed: 4294967295,
  });
  localStorage.setItem(queueStorageKey("shuffle-user"), JSON.stringify({ ...snapshot, shuffleSeed: -1 }));
  expect(readQueueSnapshot(localStorage, "shuffle-user").shuffleSeed).toBeNull();
});

test("retains recommendation provenance and explanations across reloads", () => {
  const snapshot = createQueueSnapshot({
    currentSong: { id: "a" }, queueIndex: 0,
    queue: [{ id: "a", recommendationGenerated: true, autoplayGenerated: true,
      metadata: { recommendationReason: "Based on synthwave" } }],
  });
  localStorage.setItem(queueStorageKey("autoplay-user"), JSON.stringify(snapshot));
  expect(readQueueSnapshot(localStorage, "autoplay-user").queueItems[0]).toMatchObject({
    recommendationGenerated: true, autoplayGenerated: true,
    metadata: { recommendationReason: "Based on synthwave" },
  });
});
test("retains import-measured gain across reloads and rejects invalid stored levels", () => {
  const snapshot = createQueueSnapshot({
    currentSong: { id: "a" }, queueIndex: 0,
    queue: [{ id: "a", metadata: { normalizationGainDb: -6 } }, { id: "b", normalizationGainDb: 100 }],
  });
  localStorage.setItem(queueStorageKey("measured-user"), JSON.stringify(snapshot));
  const restored = readQueueSnapshot(localStorage, "measured-user");
  expect(restored.queueItems[0].normalizationGainDb).toBe(-6);
  expect(restored.queueItems[1].normalizationGainDb).toBeUndefined();
});

test("stores IDs and a bounded, resumable queue snapshot", () => {
  const storage = window.localStorage;
  storage.clear();
  const snapshot = createQueueSnapshot({
    currentSong: { id: "b" },
    queue: [{ id: "a", title: "First" }, { id: "b", title: "Second", artist: "GEMS", duration: 240 }],
    queueIndex: 1,
    isShuffleEnabled: true,
    isLooping: true,
    volume: 0.4,
    currentTime: 43.7,
    wasPlaying: true,
  });
  storage.setItem(queueStorageKey("user-1"), JSON.stringify(snapshot));
  expect(readQueueSnapshot(storage, "user-1")).toMatchObject({
    currentTrackId: "b",
    queueTrackIds: ["a", "b"],
    queueIndex: 1,
    shuffleEnabled: true,
    repeatMode: "one",
    volume: 0.4,
    playbackProgressSeconds: 43.7,
    wasPlaying: true,
  });
});

test("legacy snapshots without playback intent remain paused", () => {
  const storage = window.localStorage;
  storage.clear();
  const snapshot = createQueueSnapshot({
    currentSong: { id: "a" }, queue: [{ id: "a" }], queueIndex: 0,
    volume: 1, currentTime: 15,
  });
  delete snapshot.wasPlaying;
  storage.setItem(queueStorageKey("user-1"), JSON.stringify(snapshot));
  expect(readQueueSnapshot(storage, "user-1").wasPlaying).toBe(false);
});

test("rejects corrupt queue IDs instead of restoring a mismatched track", () => {
  const storage = window.localStorage;
  storage.clear();
  storage.setItem(queueStorageKey("user-1"), JSON.stringify({
    version: 1, currentTrackId: "a", queueTrackIds: ["a"], queueItems: [{ id: "b" }],
  }));
  expect(readQueueSnapshot(storage, "user-1")).toBeNull();
});

test("restores the active duplicate occurrence rather than the first matching song", () => {
  const snapshot = createQueueSnapshot({
    currentSong: { id: "a" }, queue: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }],
    queueIndex: 2, volume: 1, currentTime: 42,
  });
  localStorage.setItem(queueStorageKey("duplicates"), JSON.stringify(snapshot));
  expect(snapshot.queueIndex).toBe(2);
  expect(readQueueSnapshot(localStorage, "duplicates").queueIndex).toBe(2);
});
