import { useState } from "react";
import { tasteProfileStore } from "../../services/TasteProfileStore";
export default function PlaylistTasteOption({ id, excluded, onChanged }: { id: string; excluded: boolean; onChanged(value: boolean): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <><button type="button" role="menuitemcheckbox" aria-checked={excluded} className="playlist-menu-item" disabled={busy} onClick={() => {
    setBusy(true); setError(""); void tasteProfileStore.request("/playlist", { playlistId: id, excluded: !excluded }).then(() => {
      onChanged(!excluded); window.dispatchEvent(new Event("playlistsChanged"));
    }).catch(reason => setError(reason instanceof Error ? reason.message : "Could not update this playlist's taste preference.")).finally(() => setBusy(false));
  }}><span aria-hidden="true">{excluded ? "✓" : "◇"}</span>{busy ? "Updating taste preference…" : "Exclude from taste profile"}</button>{error && <p role="alert" className="track-context-menu-error">{error}</p>}</>;
}
