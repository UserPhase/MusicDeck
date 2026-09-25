import { createQueueSnapshot, queueStorageKey, readQueueSnapshot } from "./queuePersistence";

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
