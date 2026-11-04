import { useState } from "react";
import { createPortal } from "react-dom";
import { discoveryInput, useSavedDiscoveries } from "../hooks/useSavedDiscoveries";
import type { ExternalItemKind, ExternalMetadataItem } from "../services/externalActions";

export default function SaveDiscoveryButton({ kind, item, compact = false }: {
  kind: ExternalItemKind; item: ExternalMetadataItem; compact?: boolean;
}) {
  const saved = useSavedDiscoveries();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = discoveryInput(kind, item);
  if (!input || !saved.enabled) return null;
  const existing = saved.items.find((entry) => entry.provider === input.provider &&
    entry.type === input.type && entry.external_id === input.external_id);
  const title = item.title || item.name || "item";
  return <span className={`save-discovery-control${compact ? " save-discovery-control--compact" : ""}`}>
    <button type="button" className="external-album-action save-discovery-button"
      aria-pressed={Boolean(existing)} disabled={busy || saved.loading}
      title={`${existing ? "Remove from Saved" : "Save for later"}: ${title}`}
      aria-label={`${existing ? "Remove from Saved" : "Save for later"}: ${title}`}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        setFailed(false);
        const success = existing ? await saved.remove(existing.id) : await saved.save(input);
        setFailed(!success);
        setBusy(false);
      }}>{compact ? <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
        fill={existing ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
        <path d="M6 3h12v18l-6-4-6 4V3Z" />
      </svg> : busy ? "Saving..." : existing ? "Saved" : "Save for later"}</button>
    {failed && saved.error && (compact ? createPortal(<div role="alert" className="saved-discovery-toast">
      {saved.error}<button type="button" onClick={() => setFailed(false)}>Dismiss</button>
    </div>, document.body) : <span role="alert" className="external-album-error">{saved.error}</span>)}
    {!compact && !failed && saved.error && <span role="status" className="external-album-warning">{saved.error}
      <button type="button" onClick={() => { void saved.refresh(); }}>Retry</button>
    </span>}
  </span>;
}
