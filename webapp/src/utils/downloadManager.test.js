import { afterEach } from "@jest/globals";
import { downloadToDevice, getDeviceDownloadUrl, isDownloadedToDevice, normalizeDownloadQuality } from "./downloadManager";

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

function installIndexedDb({ failRead = false, abortWrite = false, closeError = null } = {}) {
  const transactionError = new Error("transaction failed");
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
        }),
      };
      if (mode === "readwrite") {
        queueMicrotask(() => {
          if (abortWrite) {
            transaction.onabort?.();
          } else {
            transaction.oncomplete?.();
          }
        });
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
  return database;
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
