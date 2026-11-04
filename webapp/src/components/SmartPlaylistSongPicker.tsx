import { useEffect, useState } from "react";
import { findSmartPlaylistSeeds } from "../api/musicdeck";
import type { SmartTrack } from "../api/smartPlaylists";

export default function SmartPlaylistSongPicker({ value, onChange, path, disabled }: {
  value: string; onChange(id: string): void; path: string; disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SmartTrack | null>(null);
  const [results, setResults] = useState<SmartTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!value || selected?.id === value) return;
    const controller = new AbortController();
    findSmartPlaylistSeeds("", controller.signal, value).then((data: { tracks: SmartTrack[] }) => {
      if (!controller.signal.aborted) {
        setSelected(data.tracks[0] || null);
        setError(data.tracks.length ? "" : "This song is no longer in the library. Choose another song.");
      }
    }).catch(() => { if (!controller.signal.aborted) setError("Could not load the selected song. Try searching again."); });
    return () => controller.abort();
  }, [value, selected?.id]);
  useEffect(() => {
    if (value || query.trim().length < 2) { setResults([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(""); setResults([]);
    const timer = window.setTimeout(() => {
      findSmartPlaylistSeeds(query.trim(), controller.signal).then((data: { tracks: SmartTrack[] }) => {
        if (!controller.signal.aborted) setResults(data.tracks);
      }).catch(() => { if (!controller.signal.aborted) setError("Could not search your library. Try again."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, value]);
  return <div className="smart-song-picker">
    {value && selected?.id === value ? <div className="smart-song-selected"><span><strong>{selected.title}</strong><small>{selected.artist}</small></span>
      <button type="button" disabled={disabled} onClick={() => { setSelected(null); setQuery(""); setError(""); onChange(""); }}>Change song</button>
    </div> : <>
      <input type="search" aria-label={`Find song ${path}`} placeholder="Search a song in your library" value={query} maxLength={300}
        disabled={disabled} onChange={(event) => { if (value) onChange(""); setQuery(event.target.value); }} />
      {loading && <span role="status">Searching your library…</span>}
      {!loading && query.trim().length >= 2 && !results.length && !error && <span role="status">No songs found. Try a title or artist.</span>}
      {results.length > 0 && <ul aria-label={`Matching songs ${path}`}>{results.map((track) => <li key={track.id}>
        <button type="button" disabled={disabled} aria-label={`Use song: ${track.title} — ${track.artist}`}
          onClick={() => { setSelected(track); setResults([]); setError(""); onChange(track.id); }}>
          <strong>{track.title}</strong><small>{track.artist}</small>
        </button>
      </li>)}</ul>}
    </>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
