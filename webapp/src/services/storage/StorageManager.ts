import { openOfflineDatabase, purgeDeviceDownloads } from "../../utils/downloadManager";
import { offlineAuditor } from "./OfflineAuditor";
import { isArtworkCache, isPurgeableWebCache } from "./cachePolicy";
import { offlineDownloadEngine } from "./OfflineDownloadEngine";

export interface StorageUsage {
  supported: boolean;
  usage: number | null;
  quota: number | null;
  offlineTracks: number | null;
  offlineBytes: number | null;
}

async function inspectOfflineTracks(): Promise<{ count: number | null; bytes: number | null }> {
  if (offlineDownloadEngine.getOwner()) {
    await offlineDownloadEngine.refresh();
    const snapshot = offlineDownloadEngine.getSnapshot();
    if (snapshot.error) throw new Error(snapshot.error);
    return { count: snapshot.tracks.length, bytes: snapshot.tracks.reduce((sum, track) => sum + track.file_size, 0) };
  }
  const database = await openOfflineDatabase();
  if (!database) return { count: null, bytes: null };
  try {
    return await new Promise((resolve, reject) => {
      let count = 0;
      let bytes = 0;
      const transaction = database.transaction("tracks", "readonly");
      const cursor = transaction.objectStore("tracks").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        count++;
        const record: { blob?: Blob } = entry.value;
        if (record.blob instanceof Blob) bytes += record.blob.size;
        entry.continue();
      };
      transaction.oncomplete = () => resolve({ count, bytes });
      transaction.onerror = () => reject(transaction.error || new Error("Could not inspect offline storage"));
      transaction.onabort = () => reject(transaction.error || new Error("Offline storage inspection was cancelled"));
    });
  } finally { database.close(); }
}
function metric(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export async function calculateStorageUsage(): Promise<StorageUsage> {
  const [estimate, tracks] = await Promise.all([
    navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve<StorageEstimate>({}),
    inspectOfflineTracks(),
  ]);
  const usage = metric(estimate.usage);
  const quota = metric(estimate.quota);
  return { supported: usage !== null && quota !== null, usage, quota, offlineTracks: tracks.count, offlineBytes: tracks.bytes };
}

async function clearManagedCaches(command: "MUSICDECK_CLEAR_IMAGES" | "MUSICDECK_PURGE_STALE"): Promise<number> {
  const worker = navigator.serviceWorker?.controller;
  if (worker) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error("The offline cache did not respond. Close other MusicDeck tabs and retry."));
      }, 10000);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        window.clearTimeout(timer);
        channel.port1.close();
        const result = event.data;
        if (result && typeof result === "object" && "removed" in result && typeof result.removed === "number") resolve(result.removed);
        else reject(new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "Invalid response from the offline cache"));
      };
      try { worker.postMessage({ type: command }, [channel.port2]); }
      catch (error) { window.clearTimeout(timer); channel.port1.close(); reject(error); }
    });
  }
  if (typeof caches === "undefined") throw new Error("Cache Storage is unavailable. Use HTTPS or localhost to manage the web cache.");
  const names = (await caches.keys()).filter(command === "MUSICDECK_CLEAR_IMAGES" ? isArtworkCache : isPurgeableWebCache);
  let removed = 0;
  for (const name of names) if (await caches.delete(name)) removed++;
  return removed;
}
export const clearImageCache = () => clearManagedCaches("MUSICDECK_CLEAR_IMAGES");
export const purgeStaleWebCache = () => clearManagedCaches("MUSICDECK_PURGE_STALE");
export async function purgeOfflineTracks(): Promise<number> {
  const removed = await purgeDeviceDownloads();
  offlineAuditor.reset();
  return removed;
}
