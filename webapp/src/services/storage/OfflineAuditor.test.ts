import { OfflineAuditor, offlineDisplayStatus } from "./OfflineAuditor";
import type { OfflineAuditorStorage, StoredOfflineRecord } from "./OfflineAuditor";

function memoryStorage(initial: Record<string, StoredOfflineRecord> = {}) {
  const records = new Map(Object.entries(initial));
  const storage: OfflineAuditorStorage & { records: typeof records; reads: string[] } = {
    records,
    reads: [],
    read: async (trackId) => {
      storage.reads.push(trackId);
      return records.get(trackId) ?? null;
    },
    remove: async (trackId) => {
      records.delete(trackId);
    },
  };
  return storage;
}

const intact = (bytes = "audio"): StoredOfflineRecord => ({
  trackId: "t", quality: "320kbps", size: bytes.length, blob: new Blob([bytes]),
});

function unreadableBlob(size: number): Blob {
  // Mimics a Blob whose backing file was evicted: metadata is fine but reads fail.
  const blob = new Blob(["x".repeat(size)]);
  Object.defineProperty(blob, "slice", {
    value: () => ({
      arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
    }),
  });
  return blob;
}

beforeEach(() => {
  window.localStorage.clear();
});

test("verifies an intact record and reports the stored size", async () => {
  const storage = memoryStorage({ a: intact() });
  const auditor = new OfflineAuditor({ storage, indexKey: null });
  await expect(auditor.audit("a")).resolves.toEqual(expect.objectContaining({ status: "verified", size: 5 }));
  expect(offlineDisplayStatus(auditor.getSnapshot("a"), false)).toBe("downloaded");
});

test("reset invalidates old in-flight verification so purge cannot resurrect a downloaded badge", async () => {
  let complete: (record: StoredOfflineRecord) => void = () => {};
  const storage: OfflineAuditorStorage = {
    read: () => new Promise((resolve) => { complete = resolve; }), remove: async () => {},
  };
  const auditor = new OfflineAuditor({ storage, indexKey: null });
  const pending = auditor.audit("a");
  auditor.reset();
  complete(intact());
  await pending;
  expect(auditor.getSnapshot("a").status).toBe("absent");
});

test.each([
  ["truncated", { ...intact("audio"), size: 9 }, "corrupt"],
  ["shorter than Content-Length", { ...intact("audio"), expectedSize: 9 }, "corrupt"],
  ["empty", { ...intact(""), size: 0 }, "corrupt"],
  ["not a blob", { quality: "320kbps", size: 3, blob: {} as Blob }, "corrupt"],
  ["metadata only (legacy localStorage fallback)", { quality: "320kbps", size: 5 }, "missing"],
  ["unreadable bytes", { quality: "320kbps", size: 4, blob: unreadableBlob(4) }, "corrupt"],
] as const)("strips a %s record and offers a re-download", async (_label, record, status) => {
  const storage = memoryStorage({ a: record as StoredOfflineRecord });
  const auditor = new OfflineAuditor({ storage, indexKey: null });
  const result = await auditor.audit("a");
  expect(result.status).toBe(status);
  expect(storage.records.has("a")).toBe(false);
  expect(offlineDisplayStatus(result, false)).toBe("needs-redownload");
});

test("an evicted file that was stored before is missing; one never stored is absent", async () => {
  const storage = memoryStorage({ a: intact() });
  const auditor = new OfflineAuditor({ storage, verifiedTtlMs: 0 });
  expect((await auditor.audit("a")).status).toBe("verified");
  storage.records.clear();
  expect((await auditor.audit("a")).status).toBe("missing");
  expect((await auditor.audit("b")).status).toBe("absent");

  // The index survives a reload, so the loss is still reported after navigation.
  const reloaded = new OfflineAuditor({ storage });
  expect((await reloaded.audit("a")).status).toBe("missing");
  reloaded.forget("a");
  expect(reloaded.getSnapshot("a").status).toBe("absent");
});

test("storage failures never reject and never claim a download", async () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const auditor = new OfflineAuditor({
    storage: { read: () => Promise.reject(new Error("IndexedDB blocked")), remove: async () => undefined },
    indexKey: null,
  });
  const result = await auditor.audit("a");
  expect(result.status).toBe("unknown");
  expect(offlineDisplayStatus(result, false)).toBe("not-downloaded");
  consoleError.mockRestore();
});

test("deduplicates in-flight audits, caches results and re-checks verified files after the TTL", async () => {
  let now = 1000;
  const storage = memoryStorage({ a: intact() });
  const auditor = new OfflineAuditor({ storage, indexKey: null, verifiedTtlMs: 500, now: () => now });
  const [first, second] = [auditor.audit("a"), auditor.audit("a")];
  expect(first).toBe(second);
  await first;
  await auditor.audit("a");
  expect(storage.reads).toEqual(["a"]);
  now += 501;
  await auditor.audit("a");
  expect(storage.reads).toEqual(["a", "a"]);
});

test("limits concurrent storage reads for large virtual windows", async () => {
  let active = 0;
  let peak = 0;
  const auditor = new OfflineAuditor({
    indexKey: null,
    maxConcurrent: 2,
    storage: {
      read: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return null;
      },
      remove: async () => undefined,
    },
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => auditor.audit(String(index))));
  expect(peak).toBe(2);
});

test("notifies only the affected track and re-verifies after a download event", async () => {
  const storage = memoryStorage();
  const auditor = new OfflineAuditor({ storage, indexKey: null });
  const own = jest.fn();
  const sibling = jest.fn();
  const unsubscribe = auditor.subscribe("452", own);
  const unsubscribeSibling = auditor.subscribe("453", sibling);
  await Promise.all([auditor.audit("452"), auditor.audit("453")]);
  own.mockClear();
  sibling.mockClear();

  storage.records.set("452", intact());
  window.dispatchEvent(new CustomEvent("musicdeck:offline-download", { detail: { trackId: "452" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await auditor.audit("452");

  expect(auditor.getSnapshot("452").status).toBe("verified");
  expect(own).toHaveBeenCalledTimes(1);
  expect(sibling).not.toHaveBeenCalled();
  unsubscribe();
  unsubscribeSibling();
  auditor.dispose();
});

test("an in-progress download takes precedence in the display status", () => {
  expect(offlineDisplayStatus({ status: "corrupt", checkedAt: 0 }, true)).toBe("downloading");
  expect(offlineDisplayStatus({ status: "unchecked", checkedAt: 0 }, false)).toBe("not-downloaded");
});
