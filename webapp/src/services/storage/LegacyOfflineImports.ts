import { openOfflineDatabase, describeOfflineRecordProblem } from "../../utils/downloadManager";
import { offlineDownloadEngine, messageOf } from "./OfflineDownloadEngine";

interface LegacyRecord { trackId: string; blob: Blob; quality?: string; downloadedAt?: string; title?: string; artist?: string; album?: string }
async function legacyKeys(): Promise<IDBValidKey[]> {
  const db = await openOfflineDatabase();
  if (!db) return [];
  try {
    return await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction("tracks", "readonly"), request = tx.objectStore("tracks").getAllKeys();
      let result: IDBValidKey[] = [];
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not inspect older downloads."));
    });
  } finally { db.close(); }
}
async function readLegacy(key: IDBValidKey): Promise<LegacyRecord | undefined> {
  const db = await openOfflineDatabase();
  if (!db) return undefined;
  try {
    return await new Promise<LegacyRecord | undefined>((resolve, reject) => {
      const tx = db.transaction("tracks", "readonly"), request = tx.objectStore("tracks").get(key);
      let record: LegacyRecord | undefined;
      request.onsuccess = () => { record = request.result; };
      tx.oncomplete = () => resolve(record);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not read an older download."));
    });
  } finally { db.close(); }
}
export async function countLegacyDownloads(): Promise<number> { return (await legacyKeys()).length; }
export async function importLegacyDownloads(): Promise<{ imported: number; failed: number; errors: string[] }> {
  const owner = offlineDownloadEngine.getOwner();
  if (!owner) throw new Error("Open the offline account before importing older files.");
  const report = { imported: 0, failed: 0, errors: [] as string[] };
  for (const key of await legacyKeys()) {
    if (owner !== offlineDownloadEngine.getOwner()) throw new Error("The offline account changed during import.");
    try {
      const record = await readLegacy(key);
      if (!record || describeOfflineRecordProblem(record)) throw new Error(`Older file ${key} is missing or damaged.`);
      await offlineDownloadEngine.importLocalBlob({ id: String(record.trackId || key), title: record.title || `Track ${record.trackId || key}`,
        artist: record.artist || "Unknown artist", album: record.album, source: { kind: "library" }, availability: { libraryAvailable: true } }, record.blob, record.quality || "320kbps", record.downloadedAt);
      report.imported++;
    } catch (error) { report.failed++; report.errors.push(messageOf(error)); }
  }
  // Retain the original files: migration between databases cannot be one transaction.
  return report;
}
