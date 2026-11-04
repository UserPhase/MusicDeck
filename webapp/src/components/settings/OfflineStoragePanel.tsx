import { useCallback, useEffect, useRef, useState } from "react";
import {
  calculateStorageUsage, clearImageCache, purgeOfflineTracks, purgeStaleWebCache,
  type StorageUsage,
} from "../../services/storage/StorageManager";
import { formatStorageSize } from "../../utils/browserCache";
import { useOnlineStatus } from "../OfflineStatusBanner";
import "../../styles/offline-storage.css";

export default function OfflineStoragePanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmPurge, setConfirmPurge] = useState(false);
  const mounted = useRef(false);
  const operation = useRef(false);
  const inspection = useRef(0);
  const online = useOnlineStatus();
  const refresh = useCallback(async () => {
    const request = ++inspection.current;
    const next = await calculateStorageUsage();
    if (mounted.current && request === inspection.current) setUsage(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((failure: unknown) => {
      console.error("Could not inspect browser storage:", failure);
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not inspect browser storage.");
    });
    const changed = () => { void refresh().catch((failure: unknown) => {
      console.error("Could not refresh browser storage:", failure);
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not refresh browser storage.");
    }); };
    window.addEventListener("musicdeck:offline-download", changed);
    window.addEventListener("musicdeck:offline-purged", changed);
    return () => {
      mounted.current = false;
      window.removeEventListener("musicdeck:offline-download", changed);
      window.removeEventListener("musicdeck:offline-purged", changed);
    };
  }, [refresh]);

  async function run(label: string, action?: () => Promise<number>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label); setError(""); setNotice("");
    try {
      const removed = action ? await action() : null;
      if (mounted.current && action) {
        setNotice(`${label} complete. ${removed} ${label === "Purge offline tracks" ? "track records" : "cache buckets"} removed. Preferences and login are unchanged.`);
        setConfirmPurge(false);
      }
      await refresh();
    } catch (failure) {
      console.error(`Browser storage action failed (${label}):`, failure);
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Storage action failed. Please retry.");
    } finally { operation.current = false; if (mounted.current) setBusy(""); }
  }
  const percent = usage?.supported && usage.quota && usage.usage !== null
    ? Math.min(100, Math.max(0, usage.usage / usage.quota * 100)) : 0;
  return <section className="settings-section offline-storage-panel" aria-labelledby="offline-storage-title">
    <div className="settings-section-heading"><span aria-hidden="true">WEB</span><h2 id="offline-storage-title">Offline Storage</h2></div>
    <div className="offline-storage-heading"><div><span className="offline-storage-eyebrow">THIS BROWSER / THIS ORIGIN</span>
      <h3>Know what stays on your device.</h3></div><span className="offline-storage-connection">{online ? "Online" : "Offline"}</span></div>
    <div className="settings-storage-card">
      <div className="settings-storage-card-header"><p>Browser-reported usage and quota, including IndexedDB and web caches.</p>
        <button type="button" className="settings-storage-refresh" disabled={Boolean(busy)} onClick={() => { void run("Refresh"); }}>Refresh storage</button></div>
      {usage?.supported ? <><div className="settings-storage-amount"><strong>{formatStorageSize(usage.usage)}</strong>
        <span>used of {formatStorageSize(usage.quota)} total quota</span></div>
        <div className="settings-storage-meter" role="progressbar" aria-label="Local browser storage usage"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
          aria-valuetext={`${formatStorageSize(usage.usage)} used of ${formatStorageSize(usage.quota)} total quota`}>
          <span style={{ width: `${percent}%` }} /></div></>
        : <p>{usage ? "Storage usage estimates are unavailable in this browser." : "Inspecting browser storage..."}</p>}
      <p className="offline-storage-detail">{usage?.offlineTracks == null ? "Offline track inventory unavailable."
        : `${usage.offlineTracks} stored track records / ${formatStorageSize(usage.offlineBytes)} of audio blobs.`}
        {" "}Estimates can include browser padding and other apps on this origin; quota is not free disk space.</p>
    </div>
    <div className="offline-storage-actions">
      <article><h3>Cover art</h3><p>Remove cached covers and portraits. They load again when needed; audio downloads stay intact.</p>
        <button type="button" className="settings-cache-button" disabled={Boolean(busy)}
          onClick={() => { void run("Clear Cover Art Cache", clearImageCache); }}>Clear Cover Art Cache</button></article>
      <article><h3>Stale web assets</h3><p>Remove cached catalog metadata and obsolete MusicDeck PWA cache versions. Keep the current app shell and all explicit downloads.</p>
        <button type="button" className="settings-cache-button" disabled={Boolean(busy)}
          onClick={() => { void run("Purge Stale Web Cache", purgeStaleWebCache); }}>Purge Stale Web Cache</button></article>
      <article><h3>Explicit audio downloads</h3><p>Remove downloaded audio and queued downloads for this account, including damaged records. Enabled auto-download rules may save music again.</p>
        {!confirmPurge ? <button type="button" className="settings-cache-button" disabled={Boolean(busy)} onClick={() => setConfirmPurge(true)}>Remove offline tracks</button>
          : <div className="offline-storage-confirm"><p>Remove all offline audio? Reconnecting and downloading again will be required.</p>
            <button type="button" className="settings-cache-button" disabled={Boolean(busy)} onClick={() => { void run("Purge offline tracks", purgeOfflineTracks); }}>Confirm removal</button>
            <button type="button" className="settings-storage-refresh" disabled={Boolean(busy)} onClick={() => setConfirmPurge(false)}>Keep downloads</button></div>}</article>
    </div>
    <p className="offline-storage-detail">The installable web app saves its shell. Verified, explicitly saved audio plays from Downloads without your server.
      Audio is stored separately from the service worker cache. Browser eviction and clearing site data can remove downloads;
      native clients require a separate file store for stronger retention guarantees. Installation requires HTTPS or localhost.</p>
    {busy && <p role="status" aria-live="polite">{busy}...</p>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
