import { IDBFactory } from "fake-indexeddb";
import { waitFor } from "@testing-library/react";
import { OfflineDownloadEngine, checksumBlob, permitsAutomaticDownload } from "./OfflineDownloadEngine";
import { downloadKey, downloadTransaction, listDownloads, readDownload } from "./offlineDatabase";

// Use real platform Blobs/streams and a transactional IndexedDB implementation.
const platform = require("vm").runInThisContext("({ Blob, Response, ReadableStream, structuredClone, crypto })");
const instances = [];
const track = { id: "one", title: "Offline song", albumId: "album", source: { kind: "library" } };
function engine() { const instance = new OfflineDownloadEngine(); instances.push(instance); return instance; }
function response(body = "audio", status = 200, headers = {}) {
  return new platform.Response(body, { status, headers: { "content-type": "audio/mpeg", "content-length": String(body.length), ...headers } });
}
beforeEach(() => {
  Object.defineProperty(global, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(global, "Blob", { configurable: true, value: platform.Blob });
  Object.defineProperty(global, "structuredClone", { configurable: true, value: platform.structuredClone });
  Object.defineProperty(global, "crypto", { configurable: true, value: platform.crypto });
  Object.defineProperty(global, "BroadcastChannel", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(navigator, "connection", { configurable: true, value: { type: "wifi" } });
  URL.createObjectURL = jest.fn(() => "blob:offline-audio"); URL.revokeObjectURL = jest.fn();
  global.fetch = jest.fn(async () => response());
});
afterEach(async () => {
  for (const instance of instances.splice(0)) { await instance.activate(null, false); await instance.drain(); }
  jest.restoreAllMocks();
});

test("commits the complete blob and checksum manifest, then removes the queue job", async () => {
  const instance = engine(); await instance.activate("alice");
  await instance.enqueueDownload(track, "192kbps"); await instance.drain();
  const record = await instance.readVerifiedTrack("one");
  expect(await record.blob.text()).toBe("audio");
  expect(record).toMatchObject({ track_id: "one", file_size: 5, bitrate: 192, status: "verified", checksum: await checksumBlob(new Blob(["audio"])) });
  expect(instance.getSnapshot().jobs).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("queues a batch atomically, validates every ID before writing, and deduplicates repeated tracks", async () => {
  const instance = engine(); await instance.activate("alice", false);
  await expect(instance.enqueueDownloads([track, { id: "" }])).rejects.toThrow("track ID");
  expect(await listDownloads("queue", "alice")).toHaveLength(0);
  await instance.enqueueDownloads([track, { ...track, id: "two" }, track], "192kbps");
  const queued = await listDownloads("queue", "alice");
  expect(queued.map((item) => item.track.id).sort()).toEqual(["one", "two"]);
  expect(queued.every((item) => item.quality === "192kbps" && item.state === "queued")).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test("an aborted media/manifest transaction publishes neither record", async () => {
  const key = downloadKey("alice", "one");
  await expect(downloadTransaction(["media", "manifest"], "readwrite", (tx) => {
    tx.objectStore("media").put({ key, owner: "alice", blob: new Blob(["audio"]) });
    tx.objectStore("manifest").put({ key, owner: "alice", track_id: "one" });
    tx.abort();
  })).rejects.toThrow();
  expect(await readDownload("media", key)).toBeUndefined();
  expect(await readDownload("manifest", key)).toBeUndefined();
});

test("cancellation during a request cannot resurrect audio or its queue entry", async () => {
  fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")))));
  const instance = engine(); await instance.activate("alice"); await instance.enqueueDownload(track);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await instance.cancelDownload("one"); await instance.drain();
  expect(await listDownloads("queue", "alice")).toEqual([]);
  expect(await listDownloads("manifest", "alice")).toEqual([]);
  expect(await listDownloads("media", "alice")).toEqual([]);
});

test("reopens a persistent queue and plays its saved file with the network disabled", async () => {
  const first = engine(); await first.activate("alice", false); await first.enqueueDownload(track);
  expect(fetch).not.toHaveBeenCalled(); await first.activate(null, false);
  const reopened = engine(); await reopened.activate("alice"); await reopened.drain();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  fetch.mockClear();
  expect(await reopened.localPlaybackUrl("one")).toBe("blob:offline-audio");
  expect(fetch).not.toHaveBeenCalled();
  await reopened.activate("bob", false);
  expect(await reopened.readVerifiedTrack("one")).toBeNull();
  expect(reopened.getSnapshot().tracks).toEqual([]);
});

test("two tabs lease a queued track so only one network download runs", async () => {
  const first = engine(), second = engine();
  await first.activate("alice", false); await second.activate("alice", false);
  await first.enqueueDownload(track);
  await Promise.all([first.activate("alice"), second.activate("alice")]);
  await Promise.all([first.drain(), second.drain()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await first.readVerifiedTrack("one")).not.toBeNull();
});

test("detects same-size corruption using SHA-256 and retains a repairable manifest", async () => {
  const instance = engine(); await instance.activate("alice"); await instance.enqueueDownload(track); await instance.drain();
  const key = downloadKey("alice", "one");
  await downloadTransaction(["media"], "readwrite", (tx) => { tx.objectStore("media").put({ key, owner: "alice", blob: new Blob(["spoof"]) }); });
  expect(await instance.readVerifiedTrack("one")).toBeNull();
  expect((await readDownload("manifest", key)).status).toBe("corrupt");
  expect(await instance.verifyIntegrity()).toEqual({ verified: 0, damaged: 1 });
});

test("resumes a persisted partial blob only with a validated byte range", async () => {
  const instance = engine(); await instance.activate("alice", false); await instance.enqueueDownload(track);
  const key = downloadKey("alice", "one"), job = await readDownload("queue", key);
  await downloadTransaction(["queue"], "readwrite", (tx) => {
    tx.objectStore("queue").put({ ...job, partial: new Blob(["abc"]), received: 3, validator: '"v1"' });
  });
  fetch.mockResolvedValue(response("def", 206, { "content-range": "bytes 3-5/6", etag: '"v1"' }));
  await instance.activate("alice"); await instance.drain();
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ Range: "bytes=3-", "If-Range": '"v1"' });
  expect(await (await instance.readVerifiedTrack("one")).blob.text()).toBe("abcdef");
});

test("rejects HTML responses and never presents them as offline audio", async () => {
  fetch.mockResolvedValue(new platform.Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  const instance = engine(); await instance.activate("alice"); await instance.enqueueDownload(track); await instance.drain();
  expect(instance.getSnapshot().tracks).toEqual([]);
  expect(instance.getSnapshot().jobs[0]).toMatchObject({ state: "failed", error: "The server returned a non-audio file." });
});

test("does not treat a fast cellular or unknown connection as unmetered", () => {
  Object.defineProperty(navigator, "connection", { configurable: true, value: { type: "cellular", effectiveType: "4g" } });
  expect(permitsAutomaticDownload(true)).toBe(false);
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
  expect(permitsAutomaticDownload()).toBe(false);
  expect(permitsAutomaticDownload(true)).toBe(true);
  Object.defineProperty(navigator, "connection", { configurable: true, value: { type: "wifi", saveData: true } });
  expect(permitsAutomaticDownload(true)).toBe(false);
});

test("persists an entire collection queue and its original order before any network is available", async () => {
  const instance = engine(); await instance.activate("alice", false);
  const second = { ...track, id: "two" };
  await instance.enqueueCollection({ id: "p", kind: "playlist", name: "Road trip", trackIds: ["one", "two", "one", "external"] }, [track, second]);
  expect((await listDownloads("queue", "alice")).map((job) => job.track.id).sort()).toEqual(["one", "two"]);
  expect((await listDownloads("collections", "alice"))[0].trackIds).toEqual(["one", "two", "one", "external"]);
  expect(fetch).not.toHaveBeenCalled();
});

test("imports an older local Blob without a server and verifies it in its new account scope", async () => {
  const instance = engine(); await instance.activate("alice", false);
  await instance.importLocalBlob(track, new Blob(["legacy audio"], { type: "audio/mpeg" }), "lossless", "2026-01-01T00:00:00.000Z");
  expect(await (await instance.readVerifiedTrack("one")).blob.text()).toBe("legacy audio");
  expect(fetch).not.toHaveBeenCalled();
});
