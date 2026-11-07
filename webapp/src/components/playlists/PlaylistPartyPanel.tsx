import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { startVisualPolling } from "../../services/visualActivity";
import { useAuth } from "../../context/AuthContext";
import { usePlayer } from "../../context/PlayerContext";
import { getPartyState, controlPlaylistParty, requestPartyTrack, type PartyState, type PartyRequest } from "../../api/playlistCollaboration";
import { partyHost, partyDeviceId, partyRequestKey } from "../../services/playlists/PartyQueueClient";
import { toUnifiedTrack } from "../../types/track";
import "../../styles/playlist-collaboration.css";
export function PartyHostBridge() {
  const owner = useAuth()?.session?.id ?? null;
  useEffect(() => { partyHost.activate(owner); return () => partyHost.activate(null); }, [owner]);
  return null;
}
export default function PlaylistPartyPanel(props: { playlistId: string; canManage: boolean; selectedTracks: { id: string | number; title?: string }[] }) {
  const ownerId = useAuth()?.session?.id;
  return ownerId ? <PartyPanel key={`${ownerId}:${props.playlistId}`} {...props} ownerId={ownerId} /> : null;
}
function PartyPanel({ playlistId, canManage, selectedTracks, ownerId }: { playlistId: string; canManage: boolean; selectedTracks: { id: string | number; title?: string }[]; ownerId: string }) {
  const player = usePlayer(), hosting = useSyncExternalStore(partyHost.subscribe, partyHost.getSnapshot);
  const [state, setState] = useState<PartyState>({ party: null, requests: [] }), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const loadRequest = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null);
  const alive = useRef(true), attempts = useRef(new Map<string, string>()), queued = useRef(new Set<string>());
  const refresh = useCallback(() => {
    loadRequest.current?.abort(); const active = new AbortController(); loadRequest.current = active;
    void Promise.resolve().then(() => getPartyState(playlistId, partyDeviceId(), active.signal)).then(result => { if (!active.signal.aborted) setState(result); })
      .catch(reason => { if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not check party requests."); });
  }, [playlistId]);
  useEffect(() => {
    alive.current = true; const stopPolling = startVisualPolling(refresh, 10_000);
    try { const ids: unknown = JSON.parse(sessionStorage.getItem(`musicdeck:party-added:${ownerId}`) || "[]");
      if (Array.isArray(ids)) queued.current = new Set(ids.filter((id): id is string => typeof id === "string")); } catch { /* Start with no local acknowledgements. */ }
    return () => { alive.current = false; stopPolling(); loadRequest.current?.abort(); action.current?.abort(); };
  }, [refresh, ownerId]);
  const operate = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (action.current) return; const active = new AbortController(); action.current = active; setBusy(true); setError(""); setNotice("");
    try { await work(active.signal); if (!active.signal.aborted) refresh(); }
    catch (reason) { if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not update party requests."); }
    finally { if (action.current === active) action.current = null; if (alive.current && !active.signal.aborted) setBusy(false); }
  };
  const add = async (row: PartyRequest, signal: AbortSignal) => {
    if (!row.track || !player) throw new Error("This track is unavailable. Dismiss the request or retry later.");
    if (!queued.current.has(row.id)) {
      player.queueTracks([toUnifiedTrack(row.track, "party-request")]); queued.current.add(row.id);
      try { sessionStorage.setItem(`musicdeck:party-added:${ownerId}`, JSON.stringify([...queued.current].slice(-1000))); } catch { /* In-memory deduplication remains active. */ }
    }
    await controlPlaylistParty(playlistId, ownerId, partyDeviceId(), "QUEUED", row.id, signal);
    if (!signal.aborted) setNotice("Request added to the playback queue.");
  };
  return <details className="playlist-party-panel" data-track-selection-menu><summary>Party request queue{state.party ? ` · ${state.requests.length} pending` : ""}</summary>
    <p>Collaborators can request library tracks. The hosting player reviews requests before adding them to playback.</p>
    {canManage && !state.party && <button type="button" disabled={busy || !player?.currentSong} onClick={() => void operate(async signal => {
      await partyHost.start(playlistId, ownerId, signal); if (!signal.aborted) setNotice("Party requests are open on this player.");
    })}>Open party requests on this player</button>}
    {canManage && !state.party && !player?.currentSong && <p className="playlist-share-note">Start playback to open a party request queue.</p>}
    {state.party ? <>
      <button type="button" disabled={busy || selectedTracks.length === 0 || selectedTracks.length > 20} onClick={() => void operate(async signal => {
        for (const track of selectedTracks) {
          const id = String(track.id), requestKey = `${state.party!.id}:${id}`;
          let key = attempts.current.get(requestKey); if (!key) { key = partyRequestKey(); attempts.current.set(requestKey, key); }
          await requestPartyTrack(playlistId, ownerId, id, key, signal); if (signal.aborted) return;
        }
        for (const track of selectedTracks) attempts.current.delete(`${state.party!.id}:${String(track.id)}`);
        setNotice("Selected tracks sent to the party request queue.");
      })}>Request selected tracks ({selectedTracks.length})</button>
      <span className="playlist-share-note">Select up to 20 library tracks from this playlist.</span>
      {state.party.isHost && <button type="button" disabled={busy} onClick={() => void operate(async signal => { await partyHost.close(playlistId, ownerId, signal); })}>Close party requests</button>}
      <ul>{state.requests.map(row => <li key={row.id}><div><strong>{typeof row.track?.title === "string" ? row.track.title : "Unavailable track"}</strong><small>Requested by {row.requestedBy || "Former member"}</small></div>
        {state.party?.isHost && <span><button type="button" disabled={busy || !row.track} onClick={() => void operate(signal => add(row, signal))}>{queued.current.has(row.id) ? "Retry acknowledgement" : "Add to queue"}</button>
          <button type="button" disabled={busy} onClick={() => void operate(async signal => { await controlPlaylistParty(playlistId, ownerId, partyDeviceId(), "DISMISSED", row.id, signal); })}>Dismiss</button></span>}</li>)}</ul>
    </> : <p>No hosting player is connected for this playlist.</p>}
    {hosting.playlistId === playlistId && hosting.error && <p className="playlist-share-error" role="status">{hosting.error}</p>}
    {error && <p className="playlist-share-error" role="alert">{error} <button type="button" onClick={() => { setError(""); refresh(); }}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
