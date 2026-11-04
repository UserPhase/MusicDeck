import "fake-indexeddb/auto";
import { clearLocalQueue, decodeQueueContent, openQueueDatabase, readLocalQueue, sanitizeQueueTrack, writeLocalQueue, writeQueueCheckpoint, markQueueSynced, type QueueCheckpoint, type QueueContent } from "./QueueDatabase";
import { createQueueSnapshot, queueStorageKey } from "../../utils/queuePersistence";
global.structuredClone = require("vm").runInThisContext("structuredClone");
const checkpoint = (index: number): QueueCheckpoint => ({ index, position: 42.875, repeatOne: true, shuffle: true, shuffleSeed: 0, shuffleMode: "smart", albumAware: true, volume: 0.4, wasPlaying: false, context: null, capturedAt: Date.now() });
const content = (count: number): QueueContent => ({ version: 2, entries: Array.from({ length: count }, (_, i) => ({ entryId: `q${i}`, track: { id: `track-${i % 3}`, title: `Occurrence ${i}` } })) });
beforeEach(async () => { await clearLocalQueue("alice"); await clearLocalQueue("bob"); localStorage.clear(); });
test("10,000 ordered occurrences and exact position survive an IndexedDB close/reopen", async () => {
  const original = content(10_000); const head = await writeLocalQueue("alice", original, checkpoint(9999));
  const db = await openQueueDatabase(); db.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
  const saved = (await readLocalQueue("alice"))!;
  expect(saved.content).toEqual(original); expect(saved.head.checkpoint).toMatchObject({ index: 9999, position: 42.875, shuffleSeed: 0 });
  expect(saved.head.contentKey).toBe(head.contentKey); expect(await readLocalQueue("bob")).toBeNull();
});
test("progress-only writes retain the content identity and reject stale content checkpoints", async () => {
  const head = await writeLocalQueue("alice", content(5000), checkpoint(4999)); await markQueueSynced("alice", head.contentKey, "server-hash");
  await writeQueueCheckpoint("alice", head.contentKey, { ...checkpoint(4999), position: 91.125 });
  const saved = (await readLocalQueue("alice"))!; expect(saved.head.serverContentId).toBe("server-hash"); expect(saved.head.contentKey).toBe(head.contentKey);
  expect(saved.head.checkpoint.position).toBe(91.125); expect(saved.head.sequence).toBe(head.sequence + 1);
  expect(await writeQueueCheckpoint("alice", "old-content", checkpoint(1))).toBeNull();
  expect(await writeQueueCheckpoint("alice", head.contentKey, { ...checkpoint(1), capturedAt: 0 })).toBeNull();
});
test("legacy queues migrate once without truncating or removing the original until committed", async () => {
  const queue = content(601).entries.map(entry => entry.track);
  localStorage.setItem(queueStorageKey("alice"), JSON.stringify(createQueueSnapshot({ queue, currentSong: queue[600], queueIndex: 600, currentTime: 17.5, volume: 1, isShuffleEnabled: false, isLooping: false })));
  const saved = (await readLocalQueue("alice"))!; expect(saved.content.entries).toHaveLength(601); expect(saved.head.checkpoint).toMatchObject({ index: 600, position: 17.5 });
  expect(localStorage.getItem(queueStorageKey("alice"))).toBeNull(); expect((await readLocalQueue("alice"))!.head.contentKey).toBe(saved.head.contentKey);
});
test("invalid content and mismatched manifests are surfaced without silently discarding data", async () => {
  const duplicate = content(2); duplicate.entries[1].entryId = "q0";
  expect(() => decodeQueueContent(JSON.stringify(duplicate))).toThrow("duplicate");
  const head = await writeLocalQueue("alice", content(1), checkpoint(0));
  const db = await openQueueDatabase(), tx = db.transaction("heads", "readwrite"); tx.objectStore("heads").put({ ...head, contentKey: "broken" });
  await new Promise(resolve => { tx.oncomplete = resolve; });
  await expect(readLocalQueue("alice")).rejects.toThrow("incomplete");
});
test("serialization retains taste/resume/gain metadata and strips credentials and unsafe stream references", () => {
  const saved = sanitizeQueueTrack({ id: "song", ...{ title: "Track", streamUrl: "https://secret/token", previewUrl: "http://evil.test/audio", excludeFromTaste: true, tastePlaylistId: "party", replayGain: { trackGain: "-6.2 dB" }, duration: -1, source: { kind: "library", count: -1 } } });
  expect(saved).toMatchObject({ id: "song", excludeFromTaste: true, tastePlaylistId: "party", replayGain: { trackGainDb: -6.2 }, source: { kind: "library", count: 0 } });
  expect(saved).not.toHaveProperty("streamUrl"); expect(saved).not.toHaveProperty("previewUrl"); expect(saved).not.toHaveProperty("duration");
});
