const PRESERVED_LOCAL_STORAGE_KEYS = new Set([
  "userPreferences",
  "recentlyPlayed",
  "playerVolume",
  "playerCrossfadeDuration",
  "playerStreamQuality",
  "playerReplayGainEnabled",
  "playerLayoutDensity",
  "playerAccentColor",
  "playerAutoOpenSidebar",
  "playerAutoplayEnabled",
  "playerAutoDownloadLiked",
]);

const PRESERVED_STORAGE_KEY = /(?:preferences?|settings?|theme|auth|session|token|jwt)/i;
const PRESERVED_DATABASE = /(?:preferences?|settings?|auth|session|token|jwt)/i;
const CACHE_STORAGE_KEY = /(?:cache|cached|artwork|normalized|trackmetadata|apiresponse)/i;
const CACHE_DATABASE = /(?:^musicdeck(?:-|$)|cache|artwork|normalized|metadata|track-data|api-response)/i;
const KNOWN_CACHE_DATABASES = [
  "musicdeck-cache",
  "musicdeck-artwork",
  "musicdeck-track-cache",
  "musicdeck-normalized-tracks",
];

function canUseLocalStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function shouldPreserveStorageKey(key) {
  return PRESERVED_LOCAL_STORAGE_KEYS.has(key) || PRESERVED_STORAGE_KEY.test(key);
}

function shouldClearStorageKey(key) {
  return !shouldPreserveStorageKey(key) && CACHE_STORAGE_KEY.test(key);
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    if (!name || typeof indexedDB === "undefined") {
      resolve(false);
      return;
    }

    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getBrowserStorageUsage() {
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== "function"
  ) {
    return { supported: false, usage: null, quota: null };
  }

  try {
    const { usage = null, quota = null } = await navigator.storage.estimate();
    return {
      supported: typeof usage === "number" && typeof quota === "number",
      usage,
      quota,
    };
  } catch {
    return { supported: false, usage: null, quota: null };
  }
}

export function formatStorageSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "Unavailable";
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Remove browser-resident media and API caches without touching preferences
 * or authentication/session storage. Returns counts for the UI notification.
 */
export async function clearLocalBrowserCache() {
  let removedLocalStorageKeys = 0;
  let removedDatabases = 0;
  let removedCacheBuckets = 0;

  if (canUseLocalStorage()) {
    const keys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter(Boolean);

    for (const key of keys) {
      if (shouldClearStorageKey(key)) {
        window.localStorage.removeItem(key);
        removedLocalStorageKeys += 1;
      }
    }
  }

  if (typeof indexedDB !== "undefined") {
    let databaseNames = KNOWN_CACHE_DATABASES;

    if (typeof indexedDB.databases === "function") {
      try {
        const databases = await indexedDB.databases();
        databaseNames = databases
          .map((database) => database.name)
          .filter((name) =>
            name &&
            !PRESERVED_DATABASE.test(name) &&
            CACHE_DATABASE.test(name)
          );
      } catch {
        // Fall back to the known MusicDeck cache databases below.
      }
    }

    const removed = await Promise.all(
      [...new Set(databaseNames)].map(deleteDatabase),
    );
    removedDatabases = removed.filter(Boolean).length;
  }

  if (typeof caches !== "undefined" && typeof caches.keys === "function") {
    try {
      const cacheNames = (await caches.keys()).filter((name) =>
        CACHE_DATABASE.test(name)
      );
      const removed = await Promise.all(cacheNames.map((name) => caches.delete(name)));
      removedCacheBuckets = removed.filter(Boolean).length;
    } catch {
      // Cache Storage is optional; local and IndexedDB cleanup still succeeds.
    }
  }

  return { removedLocalStorageKeys, removedDatabases, removedCacheBuckets };
}
