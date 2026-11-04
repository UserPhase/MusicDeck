import { afterEach } from "@jest/globals";
import { waitFor } from "@testing-library/react";
import {
  downloadToDevice, getDeviceDownloadUrl, isDownloadedToDevice, normalizeDownloadQuality, OfflineDownloadError,
  isDeviceDownloadPending, subscribeDeviceDownload,
  purgeDeviceDownloads,
} from "./downloadManager";

test("maps bitrate preferences to transcoded stream URLs", () => {
  expect(normalizeDownloadQuality("128")).toBe("128kbps");
  expect(normalizeDownloadQuality("320kbps")).toBe("320kbps");
  expect(getDeviceDownloadUrl("track-1", "320kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=320");
  expect(getDeviceDownloadUrl("track-1", "256kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=256");
  expect(getDeviceDownloadUrl("track-1", "192kbps"))
    .toBe("/api/tracks/track-1/stream?maxBitRate=192");
});

test("requests the raw stream for lossless downloads", () => {
  expect(normalizeDownloadQuality("original")).toBe("lossless");
  expect(getDeviceDownloadUrl("track-1", "lossless"))
    .toBe("/api/tracks/track-1/stream");
});

function installIndexedDb({ failRead = false, abortWrite = false, closeError = null, transactionError = new Error("transaction failed"), storedCount = 0 } = {}) {
  const clear = jest.fn();
  const database = {
    objectStoreNames: { contains: () => true },
    close: jest.fn(() => {
      if (closeError) throw closeError;
    }),
    transaction: jest.fn((_, mode) => {
      const transaction = {
        error: transactionError,
        objectStore: () => ({
          get: () => {
            const request = { error: transactionError, result: null };
            queueMicrotask(() => {
              if (failRead) {
                request.onerror?.();
                transaction.onerror?.();
              } else {
                request.onsuccess?.();
                transaction.oncomplete?.();
              }
            });
            return request;
          },
          put: jest.fn(),
          count: () => {
            const request = { result: storedCount };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          clear,
        }),
      };
      if (mode === "readwrite") {
        queueMicrotask(() => queueMicrotask(() => {
          if (abortWrite) {
            transaction.onabort?.();
          } else {
            transaction.oncomplete?.();
          }
        }));
      }
      return transaction;
    }),
  };
  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request = { result: database };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
  });
  return { ...database, clear };
}

afterEach(() => {
  delete window.indexedDB;
  jest.restoreAllMocks();
});

test("closes the IndexedDB connection after a failed read without replacing the transaction error", async () => {
  const database = installIndexedDb({ failRead: true, closeError: new Error("close failed") });
  await expect(isDownloadedToDevice("track-1")).rejects.toThrow("transaction failed");
  expect(database.close).toHaveBeenCalledTimes(1);
});

test("purges audio records and legacy indexes without touching preferences or the auth session", async () => {
  const database = installIndexedDb({ storedCount: 4 });
  localStorage.setItem("playerVolume", "0.5");
  localStorage.setItem("session", "local-fixture");
  localStorage.setItem("musicdeckOfflineIndex", '["a"]');
  localStorage.setItem("musicdeckOfflineTrackMetadata", '{"a":{}}');
  const notification = jest.fn();
  window.addEventListener("musicdeck:offline-purged", notification);
  try {
    await expect(purgeDeviceDownloads()).resolves.toBe(4);
    expect(database.clear).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("playerVolume")).toBe("0.5");
    expect(localStorage.getItem("session")).toBe("local-fixture");
    expect(localStorage.getItem("musicdeckOfflineIndex")).toBeNull();
    expect(localStorage.getItem("musicdeckOfflineTrackMetadata")).toBeNull();
    expect(notification).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("musicdeck:offline-purged", notification); }
});

test("purge aborts in-flight downloads and blocks new ones until cleanup commits", async () => {
  const database = installIndexedDb({ storedCount: 0 });
  let started = false;
  global.fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    started = true;
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const download = downloadToDevice("purging-track");
  const rejected = expect(download).rejects.toBeInstanceOf(OfflineDownloadError);
  await waitFor(() => expect(started).toBe(true));
  const purge = purgeDeviceDownloads();
  await expect(downloadToDevice("blocked-during-purge")).rejects.toMatchObject({ code: "storage-busy" });
  await purge;
  await rejected;
  expect(database.clear).toHaveBeenCalledTimes(1);
  expect(isDeviceDownloadPending("purging-track")).toBe(false);
});

test("failed purge transactions surface an error and preserve the legacy index", async () => {
  installIndexedDb({ abortWrite: true });
  localStorage.setItem("musicdeckOfflineIndex", '["a"]');
  await expect(purgeDeviceDownloads()).rejects.toThrow("transaction failed");
  expect(localStorage.getItem("musicdeckOfflineIndex")).toBe('["a"]');
});

test("closes IndexedDB connections after read and aborted write transactions", async () => {
  const database = installIndexedDb({ abortWrite: true });
  global.fetch = jest.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
    headers: { get: () => "audio/mpeg" },
  }));

  await expect(downloadToDevice("track-1")).rejects.toThrow("transaction failed");
  expect(database.close).toHaveBeenCalledTimes(2);
});

test("deduplicates in-flight downloads across row unmounts and notifies only the owning track", async () => {
  installIndexedDb();
  let complete;
  global.fetch = jest.fn(() => new Promise((resolve) => { complete = resolve; }));
  const changes = jest.fn();
  const siblingChanges = jest.fn();
  const unsubscribe = subscribeDeviceDownload("452", changes);
  const unsubscribeSibling = subscribeDeviceDownload("453", siblingChanges);
  const first = downloadToDevice("452");
  expect(isDeviceDownloadPending("452")).toBe(true);
  expect(changes).toHaveBeenCalledTimes(1);
  unsubscribe();
  const second = downloadToDevice("452");
  expect(first).toBe(second);
  const remounted = jest.fn();
  const unsubscribeRemounted = subscribeDeviceDownload("452", remounted);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  complete({
    ok: true, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
    headers: { get: () => "audio/mpeg" },
  });
  await first;
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(isDeviceDownloadPending("452")).toBe(false);
  expect(remounted).toHaveBeenCalledTimes(1);
  expect(siblingChanges).not.toHaveBeenCalled();
  unsubscribeRemounted();
  unsubscribeSibling();
});


function audioResponse(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([body], { type: "audio/mpeg" }),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

test("rejects a truncated body instead of storing a partial file", async () => {
  const database = installIndexedDb();
  global.fetch = jest.fn(async () => audioResponse("aud", { "content-length": "5" }));
  const error = await downloadToDevice("truncated", "lossless").catch((reason) => reason);
  expect(error).toBeInstanceOf(OfflineDownloadError);
  expect(error).toEqual(expect.objectContaining({ code: "incomplete", message: expect.stringMatching(/incomplete/) }));
  expect(database.transaction).not.toHaveBeenCalledWith("tracks", "readwrite");
});

test("never records a metadata-only download when IndexedDB is unavailable", async () => {
  global.fetch = jest.fn(async () => audioResponse("audio"));
  await expect(downloadToDevice("no-idb")).rejects.toEqual(expect.objectContaining({ code: "storage-unavailable" }));
  expect(window.localStorage.getItem("musicdeckOfflineTrackMetadata")).toBeNull();
});

test("explains a full device instead of surfacing a raw quota error", async () => {
  const quota = new DOMException("Quota exceeded", "QuotaExceededError");
  installIndexedDb({ abortWrite: true, transactionError: quota });
  global.fetch = jest.fn(async () => audioResponse("audio", { "content-length": "5" }));
  await expect(downloadToDevice("quota")).rejects.toEqual(expect.objectContaining({
    code: "quota-exceeded",
    message: "Not enough storage on this device. Remove some offline downloads and try again.",
  }));
});

test.each([
  [() => Promise.reject(new TypeError("Failed to fetch")), "network", /Couldn't reach the server/],
  [async () => ({ ok: false, status: 404, headers: { get: () => null } }), "http", /no longer on the server/],
  [async () => ({ ok: false, status: 401, headers: { get: () => null } }), "http", /Sign in again/],
])("turns fetch failures into readable errors (%#)", async (fetchImpl, code, message) => {
  installIndexedDb();
  global.fetch = jest.fn(fetchImpl);
  await expect(downloadToDevice(`failure-${code}-${String(message)}`)).rejects.toEqual(
    expect.objectContaining({ code, message: expect.stringMatching(message) })
  );
});
