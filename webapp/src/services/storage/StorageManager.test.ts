import { calculateStorageUsage, clearImageCache, purgeOfflineTracks, purgeStaleWebCache } from "./StorageManager";
import { openOfflineDatabase, purgeDeviceDownloads } from "../../utils/downloadManager";
import { offlineAuditor } from "./OfflineAuditor";
import { ARTWORK_CACHE_PREFIX, CATALOG_CACHE_PREFIX, SHELL_CACHE, STATIC_CACHE, METADATA_CACHE } from "./cachePolicy";

jest.mock("../../utils/downloadManager", () => ({ openOfflineDatabase: jest.fn(), purgeDeviceDownloads: jest.fn() }));
jest.mock("./OfflineAuditor", () => ({ offlineAuditor: { reset: jest.fn() } }));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(openOfflineDatabase).mockResolvedValue(null);
  Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: jest.fn(async () => ({ usage: 100, quota: 1000 })) } });
});
afterEach(() => { delete (globalThis as { caches?: CacheStorage }).caches; });
test("returns browser-provided usage and quota without manufacturing offline totals", async () => {
  await expect(calculateStorageUsage()).resolves.toEqual({ supported: true, usage: 100, quota: 1000, offlineTracks: null, offlineBytes: null });
});
test("inspects audio one cursor record at a time and closes the database", async () => {
  const records = [{ blob: new Blob(["audio"]) }, { blob: new Blob(["more"]) }, { size: 200 }];
  const close = jest.fn();
  const database = {
    close,
    transaction: () => {
      const transaction: { oncomplete?: () => void; objectStore: () => { openCursor: () => object } } = {
        objectStore: () => ({
          openCursor: () => {
            let index = 0;
            const request: { onsuccess?: () => void; result?: { value: object; continue(): void } | null } = {};
            const next = () => {
              const value = records[index++];
              request.result = value ? { value, continue: () => queueMicrotask(next) } : null;
              request.onsuccess?.();
              if (!value) transaction.oncomplete?.();
            };
            queueMicrotask(next);
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  jest.mocked(openOfflineDatabase).mockResolvedValue(database);
  await expect(calculateStorageUsage()).resolves.toMatchObject({ offlineTracks: 3, offlineBytes: 9 });
  expect(close).toHaveBeenCalledTimes(1);
});
test("reports unsupported estimation and propagates actual storage failures", async () => {
  Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  await expect(calculateStorageUsage()).resolves.toMatchObject({ supported: false, usage: null, quota: null });
  Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => { throw new Error("Storage blocked"); } } });
  await expect(calculateStorageUsage()).rejects.toThrow("Storage blocked");
});
test("only removes MusicDeck artwork buckets, never the shell, audio or another app's caches", async () => {
  const remove = jest.fn(async (_name: string) => true);
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    keys: async () => [`${ARTWORK_CACHE_PREFIX}admin`, "musicdeck-pwa-artwork-v0-user", SHELL_CACHE, STATIC_CACHE, METADATA_CACHE, "other-app", "musicdeck-offline"],
    delete: remove,
  } });
  await expect(clearImageCache()).resolves.toBe(2);
  expect(remove.mock.calls.map((call) => call[0])).toEqual([`${ARTWORK_CACHE_PREFIX}admin`, "musicdeck-pwa-artwork-v0-user"]);
});
test("purges only obsolete PWA cache versions and preserves current artwork and app shell", async () => {
  const remove = jest.fn(async (_name: string) => true);
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    keys: async () => [`${ARTWORK_CACHE_PREFIX}admin`, SHELL_CACHE, STATIC_CACHE, METADATA_CACHE, `${CATALOG_CACHE_PREFIX}admin-local`, "musicdeck-pwa-shell-v0", "other-app"],
    delete: remove,
  } });
  await expect(purgeStaleWebCache()).resolves.toBe(2);
  expect(remove).toHaveBeenCalledWith("musicdeck-pwa-shell-v0");
  expect(remove).toHaveBeenCalledWith(`${CATALOG_CACHE_PREFIX}admin-local`);
});
test("invalidates verified badges only after an audio purge succeeds", async () => {
  jest.mocked(purgeDeviceDownloads).mockResolvedValue(7);
  await expect(purgeOfflineTracks()).resolves.toBe(7);
  expect(offlineAuditor.reset).toHaveBeenCalledTimes(1);
  jest.mocked(purgeDeviceDownloads).mockRejectedValue(new Error("Transaction aborted"));
  await expect(purgeOfflineTracks()).rejects.toThrow("Transaction aborted");
  expect(offlineAuditor.reset).toHaveBeenCalledTimes(1);
});
