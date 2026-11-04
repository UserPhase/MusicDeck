import { downloadTransaction, readDownload } from "./offlineDatabase";
const HINT = "musicdeck:downloads-owner";
const KEY = "device:downloads-owner";

/** This selects locally saved files only; it is never a server session or credential. */
export async function rememberedDownloadOwner(): Promise<string | null> {
  try {
    const record = await readDownload<{ value: string | null }>("settings", KEY);
    if (record) return record.value;
  } catch { /* Fall back to the local hint if IndexedDB is unavailable. */ }
  try { return localStorage.getItem(HINT); } catch { return null; }
}
export async function rememberDownloadOwner(owner: string | null): Promise<void> {
  try { if (owner) localStorage.setItem(HINT, owner); else localStorage.removeItem(HINT); } catch { /* IndexedDB also stores the local identity hint. */ }
  try {
    await downloadTransaction<void>(["settings"], "readwrite", (tx) => {
      tx.objectStore("settings").put({ key: KEY, owner: "__device__", value: owner });
    });
  } catch { /* A storage error must never prevent sign-in or sign-out. */ }
}
