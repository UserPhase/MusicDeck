import { useSyncExternalStore } from "react";
import "../styles/offline-storage.css";

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
}
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine !== false, () => true);
}
export default function OfflineStatusBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return <aside className="offline-status-banner" role="status" aria-live="polite">
    <span className="offline-status-dot" aria-hidden="true" />
    <strong>Offline / Web mode</strong>
    <span>Play verified saved music in <a href="/downloads">Downloads</a>. Browsing and sign-in require your server.
      Browser storage limits still apply; clearing site data removes downloads.</span>
  </aside>;
}
