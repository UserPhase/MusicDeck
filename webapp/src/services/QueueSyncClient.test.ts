import "fake-indexeddb/auto";
import { waitFor } from "@testing-library/react";
import { request } from "../api/musicdeck";
import { QueueSyncClient, queueDeviceId } from "./QueueSyncClient";
import { clearLocalQueue, readLocalQueue, writeLocalQueue, writeQueueCheckpoint, type QueueCheckpoint } from "./storage/QueueDatabase";
jest.mock("../api/musicdeck", () => ({ request: jest.fn() }));
global.structuredClone = require("vm").runInThisContext("structuredClone");
const mocked = request as jest.Mock, hash = "a".repeat(64), base = "/api/v1/user/queue-session";
const checkpoint = (): QueueCheckpoint => ({ index: 9999, position: 72.875, repeatOne: false, shuffle: false, shuffleSeed: null, shuffleMode: "standard", albumAware: false, volume: 1, wasPlaying: false, context: null, capturedAt: Date.now() });
let client: QueueSyncClient;
beforeEach(async () => {
  localStorage.clear(); await clearLocalQueue("alice"); await clearLocalQueue("bob"); jest.clearAllMocks();
  mocked.mockImplementation(async (url, options = {}) => url.includes("/content?") ? { contentId: hash }
    : options.method === "PUT" ? { saved: true, sequence: JSON.parse(options.body).sequence } : { sessions: [], namedQueues: [] });
  global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch;
  client = new QueueSyncClient();
});
afterEach(() => { client.bind(null); client.activate(null); });
async function seed() { return writeLocalQueue("alice", { version: 2, entries: Array.from({ length: 10_000 }, (_, i) => ({ entryId: `q${i}`, track: { id: `song-${i % 2}` } })) }, checkpoint()); }
test("bulk content uploads once; pause and exit send only a small checkpoint", async () => {
  await seed(); client.activate("alice"); await client.sync();
  const local = (await readLocalQueue("alice"))!;
  await writeQueueCheckpoint("alice", local.head.contentKey, { ...checkpoint(), position: 91.125 }); await client.sync();
  expect(mocked.mock.calls.filter(([url]) => url.includes("/content?"))).toHaveLength(1);
  const updates = mocked.mock.calls.filter(([, options]) => options?.method === "PUT"); expect(updates).toHaveLength(2);
  expect(JSON.parse(updates[1][1].body)).toMatchObject({ contentId: hash, checkpoint: { index: 9999, position: 91.125 } });
  client.exitCheckpoint({ ...checkpoint(), position: 123.875 }, (await readLocalQueue("alice"))!.head);
  const options = (global.fetch as jest.Mock).mock.calls[0][1]; expect(options.keepalive).toBe(true); expect(options.body.length).toBeLessThan(2000);
  expect(JSON.parse(options.body).checkpoint.position).toBe(123.875);
  client.exitCheckpoint(checkpoint(), null); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test("a rejected upload leaves the local queue intact and never sends a dependent checkpoint", async () => {
  await seed(); mocked.mockImplementation(async (url) => { if (url.includes("/content?")) throw Object.assign(new Error("Storage budget exceeded"), { status: 413 }); return { sessions: [], namedQueues: [] }; });
  client.activate("alice"); await expect(client.sync()).rejects.toThrow("Storage budget");
  expect(client.getSnapshot().error).toContain("Storage budget"); expect((await readLocalQueue("alice"))!.content.entries).toHaveLength(10_000);
  expect(mocked.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  client.exitCheckpoint(checkpoint(), (await readLocalQueue("alice"))!.head); expect(global.fetch).not.toHaveBeenCalled();
});
test("late responses from the old account cannot expose its saved queues or trigger a restore", async () => {
  let complete!: (data: unknown) => void;
  mocked.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  client.activate("alice"); client.activate("bob");
  complete({ sessions: [{ deviceName: "Alice desktop" }], namedQueues: [{ name: "Private" }] });
  await waitFor(() => expect(client.getSnapshot()).toMatchObject({ owner: "bob", sessions: [], named: [] }));
  let finish!: (data: unknown) => void; mocked.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const loading = client.load(hash, checkpoint()); client.activate(null); finish({ version: 2, entries: [] });
  await expect(loading).rejects.toThrow("account changed");
});
test("a recreated local database advances beyond this browser's existing server sequence", async () => {
  await seed(); mocked.mockImplementation(async (_url, options = {}) => options.method === "PUT" ? { saved: true, sequence: JSON.parse(options.body).sequence }
    : options.method === "POST" ? { contentId: hash } : { sessions: [{ deviceId: queueDeviceId(), sequence: 500 }], namedQueues: [] });
  client.activate("alice"); await client.refresh(); await client.sync();
  const update = mocked.mock.calls.find(([, options]) => options?.method === "PUT")!;
  expect(JSON.parse(update[1].body).sequence).toBe(501);
});
test("expired server contents are reuploaded from the complete local queue on retry", async () => {
  await seed(); client.activate("alice"); await client.sync();
  mocked.mockRejectedValueOnce(Object.assign(new Error("Queue unavailable"), { status: 404 }));
  await expect(client.sync()).rejects.toThrow("snapshot expired");
  expect((await readLocalQueue("alice"))!.head.serverContentId).toBeUndefined();
  await client.sync(); expect(mocked.mock.calls.filter(([url]) => url.includes("/content?"))).toHaveLength(2);
  expect((await readLocalQueue("alice"))!.content.entries).toHaveLength(10_000);
});
test("failed named save retries keep the supplied operation identity and all occurrences", async () => {
  await seed(); client.activate("alice"); let saves = 0;
  mocked.mockImplementation(async (url, options = {}) => {
    if (url.includes("/content?")) return { contentId: hash };
    if (url === `${base}/named`) { if (++saves === 1) throw new Error("Connection lost"); return { id: "named-1" }; }
    return options.method === "PUT" ? { saved: true, sequence: 1 } : { sessions: [], namedQueues: [] };
  });
  await expect(client.saveNamed("Late Night", "retry-same-operation")).rejects.toThrow("Connection lost");
  expect(await client.saveNamed("Late Night", "retry-same-operation")).toEqual({ id: "named-1" });
  const requests = mocked.mock.calls.filter(([url]) => url === `${base}/named`).map(([, options]) => JSON.parse(options.body));
  expect(requests[0]).toEqual(requests[1]); expect(requests[0].checkpoint.index).toBe(9999);
});
