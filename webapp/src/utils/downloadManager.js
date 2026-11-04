import { getStreamUrl } from "../api/musicdeck";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";

const OFFLINE_DB_NAME = "musicdeck-offline";
const OFFLINE_STORE_NAME = "tracks";
const OFFLINE_DB_VERSION = 1;
const FALLBACK_STORAGE_KEY = "musicdeckOfflineTrackMetadata";

export function normalizeDownloadQuality(quality) {
  const normalized = String(quality || "320kbps").toLowerCase();

  if (["lossless", "original", "raw"].includes(normalized)) {
    return "lossless";
  }

  const bitrate = ["128", "192", "256", "320"].find((value) => normalized.startsWith(value));
  return bitrate ? `${bitrate}kbps` : "320kbps";
}

export function getDeviceDownloadUrl(trackId, quality) {
  const normalizedQuality = normalizeDownloadQuality(quality);
  const streamQuality = normalizedQuality === "lossless"
    ? "original"
    : normalizedQuality.replace("kbps", "");

  // `original` makes getStreamUrl omit maxBitRate, requesting the raw file.
  return getStreamUrl(trackId, null, streamQuality);
}

export function openOfflineDatabase() {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    let blocked = false;

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        database.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "trackId" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (blocked) database.close();
      else resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("Could not open offline storage"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Offline storage is blocked by another tab. Close other MusicDeck tabs and retry."));
    };
  });
}

function readFallbackMetadata() {
  if (typeof window === "undefined") return {};

  try {
    return JSON.parse(window.localStorage.getItem(FALLBACK_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeFallbackMetadata(metadata) {
  try {
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(metadata));
  } catch {
    // Legacy cleanup only; nothing depends on this write succeeding.
  }
}

export class OfflineDownloadError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "OfflineDownloadError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (error?.name === "UnknownError" && /quota|space/i.test(String(error?.message)));
}

/**
 * Synchronous structural check of a stored record. Returns null when the record
 * looks intact, otherwise "missing" (no audio stored) or "corrupt".
 * Legacy localStorage fallback records carry metadata but no audio, so they are
 * "missing" rather than downloaded.
 */
export function describeOfflineRecordProblem(record) {
  if (!record) return "missing";
  const blob = record.blob;
  if (!blob) return "missing";
  if (typeof blob.size !== "number" || typeof blob.slice !== "function") return "corrupt";
  if (blob.size <= 0) return "corrupt";
  if (typeof record.size === "number" && record.size !== blob.size) return "corrupt";
  if (typeof record.expectedSize === "number" && record.expectedSize !== blob.size) return "corrupt";
  return null;
}

export async function readOfflineTrack(trackId) {
  if (offlineDownloadEngine.getOwner()) return offlineDownloadEngine.readVerifiedTrack(String(trackId));
  const database = await openOfflineDatabase();

  if (!database) {
    return readFallbackMetadata()[String(trackId)] || null;
  }

  let failed = false;
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_STORE_NAME, "readonly");
      const request = transaction.objectStore(OFFLINE_STORE_NAME).get(String(trackId));
      let result = null;
      const fail = () => reject(transaction.error || request.error || new Error("Could not read offline track"));

      request.onsuccess = () => { result = request.result || null; };
      request.onerror = fail;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      database.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function saveOfflineTrack(record) {
  const database = await openOfflineDatabase();

  if (!database) {
    // localStorage cannot hold audio, so recording metadata here would fake a download.
    throw new OfflineDownloadError(
      "This browser doesn't allow offline storage here (for example in private browsing).",
      "storage-unavailable"
    );
  }

  let failed = false;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_STORE_NAME, "readwrite");
      transaction.objectStore(OFFLINE_STORE_NAME).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save offline track"));
      transaction.onabort = () => reject(transaction.error || new Error("Offline download was cancelled"));
    });
  } catch (error) {
    failed = true;
    if (isQuotaError(error)) {
      throw new OfflineDownloadError(
        "Not enough storage on this device. Remove some offline downloads and try again.",
        "quota-exceeded",
        error
      );
    }
    throw error;
  } finally {
    try {
      database.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

/** Removes a stored offline track (IndexedDB record and any legacy metadata). */
export async function deleteOfflineTrack(trackId) {
  if (offlineDownloadEngine.getOwner()) return offlineDownloadEngine.purgeDownloadedTrack(String(trackId));
  const key = String(trackId);
  const metadata = readFallbackMetadata();
  if (metadata[key]) {
    delete metadata[key];
    writeFallbackMetadata(metadata);
  }

  const database = await openOfflineDatabase();
  if (!database) return;

  let failed = false;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_STORE_NAME, "readwrite");
      transaction.objectStore(OFFLINE_STORE_NAME).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not remove offline track"));
      transaction.onabort = () => reject(transaction.error || new Error("Removing the offline track was cancelled"));
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      database.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

/** Structural check only; UI state should come from services/storage/OfflineAuditor. */
export async function isDownloadedToDevice(trackId) {
  if (!trackId) return false;
  return describeOfflineRecordProblem(await readOfflineTrack(trackId)) === null;
}

const activeDownloads = new Map();
const downloadListeners = new Map();
const downloadControllers = new Set();
let purgeInProgress = false;
let downloadGeneration = 0;

export function isDeviceDownloadPending(trackId) {
  if (offlineDownloadEngine.getOwner()) return offlineDownloadEngine.getSnapshot().jobs.some((job) => String(job.track.id) === String(trackId) && job.state !== "failed");
  return Boolean(activeDownloads.get(String(trackId))?.size);
}

export function subscribeDeviceDownload(trackId, listener) {
  if (offlineDownloadEngine.getOwner()) return offlineDownloadEngine.subscribe(listener);
  const key = String(trackId);
  const listeners = downloadListeners.get(key) || new Set();
  listeners.add(listener);
  downloadListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) downloadListeners.delete(key);
  };
}

function notifyDeviceDownload(trackId) {
  downloadListeners.get(String(trackId))?.forEach((listener) => listener());
}

// An in-flight download belongs to the track, not to its virtual row lifetime.
/** @param {string | number} trackId @param {string} quality @param {import('../services/storage/OfflineDownloadEngine').DownloadTrack | null} track */
export function downloadToDevice(trackId, quality = "320kbps", track = null) {
  if (offlineDownloadEngine.getOwner()) {
    const owner = offlineDownloadEngine.getOwner();
    return (async () => {
      await offlineDownloadEngine.enqueueDownload(track || { id: String(trackId) }, quality);
      return new Promise((resolve, reject) => {
        const check = () => {
          if (owner !== offlineDownloadEngine.getOwner()) { unsubscribe(); reject(new OfflineDownloadError("The offline account changed. Download cancelled.", "cancelled")); return; }
          const snapshot = offlineDownloadEngine.getSnapshot();
          const job = snapshot.jobs.find((item) => String(item.track.id) === String(trackId));
          if (job?.state === "failed") { unsubscribe(); reject(new OfflineDownloadError(job.error || "Download failed.", "download-failed")); }
          else if (!job) {
            unsubscribe();
            offlineDownloadEngine.readVerifiedTrack(String(trackId)).then((record) => record ? resolve(record) : reject(new OfflineDownloadError("Download cancelled or unavailable.", "cancelled")), reject);
          }
        };
        const unsubscribe = offlineDownloadEngine.subscribe(check);
        check();
      });
    })();
  }
  if (purgeInProgress) return Promise.reject(new OfflineDownloadError("Offline storage is being purged. Try again when cleanup finishes.", "storage-busy"));
  const key = String(trackId);
  const normalizedQuality = normalizeDownloadQuality(quality);
  const jobs = activeDownloads.get(key) || new Map();
  if (jobs.has(normalizedQuality)) return jobs.get(normalizedQuality);
  const controller = new AbortController();
  downloadControllers.add(controller);
  const generation = downloadGeneration;
  const job = performDeviceDownload(trackId, normalizedQuality, controller.signal, generation).finally(() => {
    downloadControllers.delete(controller);
    jobs.delete(normalizedQuality);
    if (!jobs.size) activeDownloads.delete(key);
    notifyDeviceDownload(key);
  });
  jobs.set(normalizedQuality, job);
  activeDownloads.set(key, jobs);
  notifyDeviceDownload(key);
  return job;
}

async function performDeviceDownload(trackId, quality, signal, generation) {
  if (!trackId) {
    throw new Error("A track ID is required for an offline download");
  }

  const normalizedQuality = normalizeDownloadQuality(quality);
  const existing = await readOfflineTrack(trackId);

  if (existing?.quality === normalizedQuality && describeOfflineRecordProblem(existing) === null) {
    return { ...existing, cached: true };
  }

  const url = getDeviceDownloadUrl(trackId, normalizedQuality);
  let response;
  try {
    if (signal.aborted) throw new DOMException("Offline download cancelled", "AbortError");
    response = await fetch(url, { credentials: "include", signal });
  } catch (error) {
    throw new OfflineDownloadError(
      "Couldn't reach the server. Check your connection and try again.",
      "network",
      error
    );
  }

  if (!response.ok) {
    throw new OfflineDownloadError(
      response.status === 401 || response.status === 403
        ? "Your session expired. Sign in again to download this track."
        : response.status === 404
          ? "This track is no longer on the server."
          : `The server couldn't send this track (error ${response.status}).`,
      "http"
    );
  }

  let audioBlob;
  try {
    audioBlob = await response.blob();
  } catch (error) {
    throw new OfflineDownloadError(
      "The download was interrupted. Check your connection and try again.",
      "network",
      error
    );
  }

  // A shorter body than the declared length is a truncated download. Encoded
  // responses report the compressed length, so they can't be compared.
  const declaredLength = Number(response.headers?.get?.("content-length"));
  const expectedSize = !response.headers?.get?.("content-encoding") &&
    Number.isFinite(declaredLength) && declaredLength > 0
    ? declaredLength
    : undefined;
  if (!audioBlob.size || (expectedSize !== undefined && audioBlob.size !== expectedSize)) {
    throw new OfflineDownloadError(
      "The download was incomplete. Check your connection and try again.",
      "incomplete"
    );
  }

  const record = {
    trackId: String(trackId),
    quality: normalizedQuality,
    downloadedAt: new Date().toISOString(),
    contentType: audioBlob.type || response.headers.get("content-type") || "audio/mpeg",
    size: audioBlob.size,
    ...(expectedSize !== undefined ? { expectedSize } : {}),
    blob: audioBlob,
  };

  if (signal.aborted) throw new OfflineDownloadError("Offline download cancelled by storage cleanup.", "cancelled");
  if (generation !== downloadGeneration) throw new OfflineDownloadError("Offline download cancelled by storage cleanup.", "cancelled");
  await saveOfflineTrack(record);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("musicdeck:offline-download", {
      detail: { trackId: String(trackId), quality: normalizedQuality },
    }));
  }

  return record;
}

/** Clear only audio records, retaining the database schema and all user settings. */
export async function purgeDeviceDownloads() {
  if (offlineDownloadEngine.getOwner()) return offlineDownloadEngine.purgeAll();
  if (purgeInProgress) throw new Error("Offline storage cleanup is already running");
  purgeInProgress = true;
  downloadGeneration++;
  try {
    for (const controller of downloadControllers) controller.abort();
    await Promise.allSettled([...activeDownloads.values()].flatMap((jobs) => [...jobs.values()]));
    const database = await openOfflineDatabase();
    if (!database) throw new Error("IndexedDB offline storage is unavailable in this browser");
    let removed = 0;
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(OFFLINE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(OFFLINE_STORE_NAME);
        const count = store.count();
        count.onsuccess = () => { removed = count.result; };
        store.clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not purge offline tracks"));
        transaction.onabort = () => reject(transaction.error || new Error("Offline purge was cancelled"));
      });
    } finally { database.close(); }
    try {
      window.localStorage.removeItem(FALLBACK_STORAGE_KEY);
      window.localStorage.removeItem("musicdeckOfflineIndex");
    } finally { window.dispatchEvent(new Event("musicdeck:offline-purged")); }
    return removed;
  } finally { purgeInProgress = false; }
}
