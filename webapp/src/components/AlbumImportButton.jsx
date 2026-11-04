import { useExternalAction } from "../services/externalActions";
import { usePrivacy } from "../context/PrivacyContext";

const labels = { IDLE: "Add to Library", QUEUED: "Queued…", IMPORTING: "Importing…", IN_LIBRARY: "In Library", FAILED: "Retry Import" };

export default function AlbumImportButton({ album, actions }) {
  const { canImport } = usePrivacy();
  const { snapshot, start } = useExternalAction("album", album, actions);
  if (!canImport) return null;
  const busy = snapshot.state === "QUEUED" || snapshot.state === "IMPORTING";
  return <>
    <button type="button" className="detail-secondary-action album-import-action"
      disabled={busy || snapshot.state === "IN_LIBRARY"} aria-busy={busy || undefined}
      onClick={() => { void start(); }}>
      <span aria-hidden="true">☁</span> {snapshot.state === "IMPORTING" && snapshot.progress != null ? `Importing ${snapshot.progress}%` : labels[snapshot.state]}
    </button>
    {snapshot.message && <p className={`album-import-status${snapshot.state === "FAILED" ? " error" : ""}`}
      role={snapshot.state === "FAILED" ? "alert" : "status"} aria-live="polite">{snapshot.message}</p>}
  </>;
}
