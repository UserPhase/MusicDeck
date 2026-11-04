import { useEffect, useState } from "react";
import { autoDownloadPolicies, AUTO_POLICIES_CHANGED } from "../services/storage/AutoDownloadPolicyManager";
import { AUTO_SYNC_TAG, networkConnection, offlineDownloadEngine, messageOf } from "../services/storage/OfflineDownloadEngine";

/** The foreground fallback works everywhere; a registered service worker may also
 * run a bounded reconciliation after this page closes. Browsers decide when. */
export default function useAutoDownloadSync(enabled: boolean): { error: string | null; syncing: boolean } {
  const [state, setState] = useState({ error: null as string | null, syncing: false });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, running = false, rerun = false;
    const sync = async () => {
      if (disposed) return;
      if (running) { rerun = true; return; }
      if (navigator.onLine === false) return;
      running = true; setState({ error: null, syncing: true });
      try {
        let backgroundError: string | null = null;
        await register().catch((error) => { backgroundError = `Background sync unavailable: ${messageOf(error)} Auto-downloads will sync while MusicDeck is open.`; });
        await autoDownloadPolicies.reconcile();
        offlineDownloadEngine.kick();
        if (!disposed) setState({ error: backgroundError, syncing: false });
      } catch (error) { if (!disposed) setState({ error: messageOf(error), syncing: false }); }
      finally { running = false; if (rerun) { rerun = false; void sync(); } }
    };
    const trigger = () => { void sync(); };
    const events = ["online", "focus", "playlistsChanged", "likedSongsChanged", "favoritesChanged", AUTO_POLICIES_CHANGED];
    for (const event of events) window.addEventListener(event, trigger);
    const visibility = () => { if (document.visibilityState === "visible") trigger(); };
    document.addEventListener("visibilitychange", visibility);
    const connection = networkConnection(); connection?.addEventListener("change", trigger);
    const workerMessage = (event: MessageEvent) => {
      if (event.data?.type === "MUSICDECK_DOWNLOAD_SYNC_COMPLETE") { void offlineDownloadEngine.refresh(); }
    };
    navigator.serviceWorker?.addEventListener("message", workerMessage);
    navigator.serviceWorker?.addEventListener("controllerchange", trigger);
    const register = async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      const syncManager = (registration as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined)?.sync;
      if (syncManager) await syncManager.register(AUTO_SYNC_TAG);
    };
    const interval = setInterval(trigger, 5 * 60_000);
    trigger();
    return () => {
      disposed = true; clearInterval(interval);
      for (const event of events) window.removeEventListener(event, trigger);
      connection?.removeEventListener("change", trigger);
      document.removeEventListener("visibilitychange", visibility);
      navigator.serviceWorker?.removeEventListener("message", workerMessage);
      navigator.serviceWorker?.removeEventListener("controllerchange", trigger);
    };
  }, [enabled]);
  return state;
}
