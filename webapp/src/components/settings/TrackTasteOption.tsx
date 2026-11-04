import { useRef, useState } from "react";
import { useTasteProfile } from "../../hooks/useTasteProfile";
import { tasteProfileStore } from "../../services/TasteProfileStore";
import type { Track } from "../TrackRow";
export default function TrackTasteOption({ tracks, disabled = false }: { tracks: readonly Track[]; disabled?: boolean }) {
  const state = useTasteProfile(), [busy, setBusy] = useState(false), [error, setError] = useState(""), lock = useRef(false);
  if (!state.owner) return null;
  const excluded = tracks.length > 0 && tracks.every(track => state.excludedTrackIds?.includes(String(track.id)));
  return <><button type="button" role="menuitemcheckbox" aria-checked={excluded} disabled={disabled || busy} className="playlist-menu-item track-context-menu-item" onClick={() => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); let completed = 0;
    void (async () => { for (const track of tracks) { await tasteProfileStore.request("/track", { trackId: String(track.id), excluded: !excluded, title: track.title, artist: track.artist || track.artistName }); completed++; } })()
      .catch(reason => setError(`${completed ? `${completed} preference changes saved. ` : ""}${reason instanceof Error ? reason.message : "Could not update taste preferences."}`))
      .finally(() => { lock.current = false; setBusy(false); });
  }}><span aria-hidden="true">{excluded ? "✓" : "◇"}</span>{busy ? "Updating taste preferences…" : excluded ? "Include in taste profile" : "Exclude from taste profile"}</button>
    {error && <p role="alert" className="track-context-menu-error">{error}</p>}</>;
}
