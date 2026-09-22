import { getStreamUrl } from "../api/musicdeck";

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

function openOfflineDatabase() {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        database.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "trackId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open offline storage"));
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

async function readOfflineTrack(trackId) {
  const database = await openOfflineDatabase();

  if (!database) {
    return readFallbackMetadata()[String(trackId)] || null;
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OFFLINE_STORE_NAME, "readonly");
    const request = transaction.objectStore(OFFLINE_STORE_NAME).get(String(trackId));

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read offline track"));
    transaction.oncomplete = () => database.close();
  });
}

async function saveOfflineTrack(record) {
  const database = await openOfflineDatabase();

  if (!database) {
    const metadata = readFallbackMetadata();
    metadata[record.trackId] = {
      trackId: record.trackId,
      quality: record.quality,
      downloadedAt: record.downloadedAt,
      size: record.size,
    };
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(metadata));
    return;
  }

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(OFFLINE_STORE_NAME, "readwrite");
    transaction.objectStore(OFFLINE_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not save offline track"));
    transaction.onabort = () => reject(transaction.error || new Error("Offline download was cancelled"));
  });

  database.close();
}

export async function isDownloadedToDevice(trackId) {
  if (!trackId) return false;
  return Boolean(await readOfflineTrack(trackId));
}

export async function downloadToDevice(trackId, quality = "320kbps") {
  if (!trackId) {
    throw new Error("A track ID is required for an offline download");
  }

  const normalizedQuality = normalizeDownloadQuality(quality);
  const existing = await readOfflineTrack(trackId);

  if (existing?.quality === normalizedQuality) {
    return { ...existing, cached: true };
  }

  const url = getDeviceDownloadUrl(trackId, normalizedQuality);
  const response = await fetch(url, { credentials: "include" });

  if (!response.ok) {
    throw new Error(`Offline download failed with status ${response.status}`);
  }

  const audioBlob = await response.blob();
  const record = {
    trackId: String(trackId),
    quality: normalizedQuality,
    downloadedAt: new Date().toISOString(),
    contentType: audioBlob.type || response.headers.get("content-type") || "audio/mpeg",
    size: audioBlob.size,
    blob: audioBlob,
  };

  await saveOfflineTrack(record);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("musicdeck:offline-download", {
      detail: { trackId: String(trackId), quality: normalizedQuality },
    }));
  }

  return record;
}
