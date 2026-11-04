export const DOWNLOAD_DATABASE = "musicdeck-downloads";
export const DOWNLOAD_STORES = ["media", "manifest", "queue", "collections", "policies", "settings"] as const;
export type DownloadStore = typeof DOWNLOAD_STORES[number];

export function downloadKey(owner: string, id: string): string { return JSON.stringify([owner, id]); }

export function openDownloadDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Offline audio storage is unavailable. Use a browser with IndexedDB on HTTPS or localhost."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DOWNLOAD_DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of DOWNLOAD_STORES) {
        if (request.result.objectStoreNames.contains(name)) continue;
        const store = request.result.createObjectStore(name, { keyPath: "key" });
        store.createIndex("owner", "owner");
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open downloads storage."));
    request.onblocked = () => { blocked = true; reject(new Error("Close other MusicDeck tabs to upgrade offline storage.")); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close(); else resolve(db);
    };
  });
}

/** No network, hashing or other asynchronous work may run inside this callback. */
export async function downloadTransaction<T>(stores: DownloadStore[], mode: IDBTransactionMode,
  operation: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDownloadDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Offline storage transaction failed."));
      try { operation(tx, (value) => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export function readDownload<T>(store: DownloadStore, key: string): Promise<T | undefined> {
  return downloadTransaction([store], "readonly", (tx, done) => {
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => done(request.result);
  });
}
export function listDownloads<T>(store: DownloadStore, owner: string): Promise<T[]> {
  return downloadTransaction([store], "readonly", (tx, done) => {
    const request = tx.objectStore(store).index("owner").getAll(owner);
    request.onsuccess = () => done(request.result);
  });
}
