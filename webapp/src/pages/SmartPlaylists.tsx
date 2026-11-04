import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSmartPlaylist, getSmartPlaylist, getSmartPlaylistTracks, listSmartPlaylists } from "../api/musicdeck";
import type { SmartPlaylist, SmartPreview, SmartTrack } from "../api/smartPlaylists";
import SmartPlaylistBuilder from "../components/SmartPlaylistBuilder";
import { usePlayer } from "../context/PlayerContext";
import { Link, Navigate, useParams } from "react-router-dom";

export default function SmartPlaylists() {
  const { id } = useParams();
  const [items, setItems] = useState<SmartPlaylist[]>([]);
  const [selected, setSelected] = useState<SmartPlaylist | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState("");
  const [removed, setRemoved] = useState(false);
  const [fixedId, setFixedId] = useState("");
  const alive = useRef(true);
  const operation = useRef(0);
  const loadRequest = useRef(0);
  const player = usePlayer();

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError("");
    try {
      const result: { playlists: SmartPlaylist[] } = id
        ? { playlists: [(await getSmartPlaylist(id)).playlist] } : await listSmartPlaylists();
      if (alive.current && request === loadRequest.current) {
        setItems(result.playlists);
        if (id) {
          const match = result.playlists.find((item) => item.id === id);
          setSelected(match);
          if (!match) setError("This smart playlist could not be found.");
        }
      }
    } catch (failure) {
      if (alive.current && request === loadRequest.current) setError(failure instanceof TypeError ? "Can't reach MusicDeck. Check your connection and retry."
        : failure instanceof Error ? failure.message : "Could not load smart playlists.");
    } finally {
      if (alive.current && request === loadRequest.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    alive.current = true;
    setRemoved(false); setSelected(undefined); setPlaying(false); setConfirmDelete(false); setNotice("");
    void load();
    return () => { alive.current = false; operation.current += 1; loadRequest.current += 1; };
  }, [load]);
  function choose(item?: SmartPlaylist) {
    operation.current += 1;
    setSelected(item);
    setPlaying(false);
    setConfirmDelete(false);
    setError("");
    setNotice("");
  }
  async function playMatches() {
    if (!selected || playing) return;
    const version = ++operation.current;
    setPlaying(true);
    setError("");
    try {
      const tracks: SmartTrack[] = [];
      const ids = new Set<string>();
      let offset = 0;
      let total = Infinity;
      while (offset < total) {
        const result: SmartPreview = await getSmartPlaylistTracks(selected.id, offset, 500);
        if (!alive.current || version !== operation.current) return;
        if (!result.refreshedAt) throw new Error("The local catalog is still loading. Try again shortly.");
        if (result.warning) setNotice(result.warning);
        total = result.total;
        for (const track of result.tracks) if (!ids.has(track.id)) { tracks.push(track); ids.add(track.id); }
        if (!result.tracks.length) break;
        offset += result.tracks.length;
      }
      if (!tracks.length) { setNotice("No tracks currently match this playlist."); return; }
      if (!player) throw new Error("The player is unavailable. Reload MusicDeck and try again.");
      player.playQueue(tracks, 0);
    } catch (failure) {
      if (alive.current && version === operation.current) setError(failure instanceof TypeError
        ? "Can't reach MusicDeck. Your current playback has not been changed."
        : failure instanceof Error ? failure.message : "Could not play smart playlist.");
    } finally {
      if (alive.current && version === operation.current) setPlaying(false);
    }
  }
  async function remove() {
    if (!selected || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await deleteSmartPlaylist(selected.id);
      if (!alive.current) return;
      setItems((previous) => previous.filter((item) => item.id !== selected.id));
      choose();
      setNotice("Smart playlist removed. Library tracks have not been deleted.");
      window.dispatchEvent(new Event("smartPlaylistsChanged"));
      setRemoved(true);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "Could not delete smart playlist.");
    } finally {
      if (alive.current) setDeleting(false);
    }
  }

  if (id && removed) return <Navigate to="/library/playlists" replace />;
  if (fixedId) return <Navigate to={`/playlist/${encodeURIComponent(fixedId)}`} />;
  return <section className="smart-playlists-page" aria-labelledby="smart-playlists-title">
    <header className="smart-collections-heading"><div><p>YOUR LIBRARY / ALWAYS CURRENT</p>
      <h2 id="smart-playlists-title">{id ? selected?.name || "Smart Playlist" : "Smart Playlists"}</h2>
      <p>Smart playlist · Songs from your library, kept up to date.</p></div>
      {id ? <Link to="/library/playlists">Back to playlists</Link> : <button type="button" disabled={deleting} onClick={() => choose()}>+ New smart playlist</button>}
    </header>
    {error && <div role="alert">{error}<button type="button" onClick={() => { void load(); }}>Reload playlists</button></div>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Loading smart playlists...</p>}
    {!id && <nav className="smart-collection-tabs" aria-label="Saved smart playlists">
      {items.map((item) => <button type="button" key={item.id} aria-pressed={item.id === selected?.id} disabled={deleting}
        onClick={() => choose(item)}>{item.name}</button>)}
    </nav>}
    {selected && <div className="smart-collection-actions">
      <span className="smart-builder-note">Playback uses the last saved conditions.</span>
      <button type="button" disabled={playing || deleting} className="smart-primary" onClick={() => { void playMatches(); }}>
        {playing ? "Loading matching tracks..." : "Play matching tracks"}
      </button>
      {!confirmDelete ? <button type="button" disabled={deleting} onClick={() => setConfirmDelete(true)}>Delete smart playlist</button>
        : <div role="group" aria-label="Confirm smart playlist deletion">
          <span>Delete this collection? Your tracks stay in the library.</span>
          <button type="button" disabled={deleting} onClick={() => { void remove(); }}>{deleting ? "Deleting..." : "Confirm delete"}</button>
          <button type="button" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>}
    </div>}
    {(!id || selected) && <SmartPlaylistBuilder key={selected?.id || "new"} playlist={selected} onSaved={(item, kind) => {
      if (kind === "playlist") { setFixedId(item.id); return; }
      setItems((previous) => [item, ...previous.filter((entry) => entry.id !== item.id)]);
      setSelected(item);
      setNotice(`Saved "${item.name}".`);
    }} />}
  </section>;
}
