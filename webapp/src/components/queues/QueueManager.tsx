import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { usePlayer } from "../../context/PlayerContext";
import { queueSyncClient, useQueueSync, queueDeviceId, newQueueOperationId, type NamedQueueSummary, type QueueSessionSummary } from "../../services/QueueSyncClient";
import "../../styles/queue-manager.css";
const message = (error: unknown) => error instanceof Error ? error.message : "Could not update the saved queue.";
export default function QueueManager() {
  const ownerId = useAuth()?.session?.id, player = usePlayer();
  return ownerId && player ? <Manager key={ownerId} ownerId={ownerId} /> : null;
}
function Manager({ ownerId }: { ownerId: string }) {
  const player = usePlayer()!, state = useQueueSync();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [playlistId, setPlaylistId] = useState("");
  const alive = useRef(true), lock = useRef(false), operation = useRef<{ name: string; kind: string; id: string } | null>(null);
  useEffect(() => { alive.current = true; void queueSyncClient.refresh(); return () => { alive.current = false; }; }, [ownerId]);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (reason) { if (alive.current) setError(message(reason)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const save = async (kind: "named" | "playlist") => {
    const title = name.trim(); if (!title) { setError("Give this queue a name first."); return; }
    if (!operation.current || operation.current.name !== title || operation.current.kind !== kind) operation.current = { name: title, kind, id: newQueueOperationId() };
    const args = [title, operation.current.id] as const;
    const source = player.accountQueueSource;
    if (kind === "named") await (source ? queueSyncClient.saveNamed(...args, source) : queueSyncClient.saveNamed(...args));
    else { const result = await (source ? queueSyncClient.savePlaylist(...args, source) : queueSyncClient.savePlaylist(...args)); if (alive.current) setPlaylistId(result.playlistId); window.dispatchEvent(new Event("playlistsChanged")); }
    if (alive.current) { setNotice(kind === "named" ? "Named queue saved." : "Every queued occurrence was saved to a new playlist."); operation.current = null; }
  };
  const restore = async (row: NamedQueueSummary | QueueSessionSummary) => {
    const saved = await queueSyncClient.load(row.contentId, row.checkpoint);
    if (alive.current) { player.restoreSavedQueue(saved.content, saved.checkpoint); setNotice("Queue restored, ready to play."); }
  };
  const sessions = state.owner === ownerId ? state.sessions.filter(row => row.deviceId !== queueDeviceId()) : [];
  const named = state.owner === ownerId ? state.named : [];
  return <details className="queue-manager"><summary>Save & restore queues</summary>
    <label htmlFor="queue-save-name">Queue name</label><input id="queue-save-name" value={name} maxLength={200} placeholder="Late Night Chill Queue" onChange={event => setName(event.target.value)} disabled={busy} />
    <div className="queue-manager-actions"><button type="button" disabled={busy || !player.queue.length} onClick={() => void run(() => save("playlist"))}>Save Queue as Playlist</button>
      <button type="button" disabled={busy || !player.queue.length} onClick={() => void run(() => save("named"))}>Save named queue</button>
      <button type="button" disabled={busy || state.syncing} onClick={() => void run(async () => { await queueSyncClient.sync(); await queueSyncClient.refresh(); if (alive.current) setNotice("Queue synced to your account."); })}>{state.syncing ? "Syncing…" : "Sync queue now"}</button></div>
    {playlistId && <Link to={`/playlist/${encodeURIComponent(playlistId)}`}>Open saved playlist →</Link>}
    <h4>Named queues</h4>{named.length ? <ul>{named.map(row => <li key={row.id}><span><strong>{row.name}</strong><small>{row.trackCount.toLocaleString()} tracks</small></span>
      <button type="button" disabled={busy} aria-label={`Load ${row.name}`} onClick={() => void run(() => restore(row))}>Load</button>
      <button type="button" disabled={busy} aria-label={`Delete ${row.name}`} onClick={() => void run(async () => { await queueSyncClient.removeNamed(row); })}>Delete</button></li>)}</ul> : <p>No named queues saved yet.</p>}
    <h4>Other device queues</h4>{sessions.length ? <ul>{sessions.map(row => <li key={row.deviceId}><span><strong>{row.deviceName}</strong><small>{row.trackCount.toLocaleString()} tracks · {new Date(row.updatedAt).toLocaleString()}</small></span>
      <button type="button" disabled={busy} aria-label={`Restore queue from ${row.deviceName}`} onClick={() => void run(() => restore(row))}>Restore</button>
      <button type="button" disabled={busy} aria-label={`Remove queue from ${row.deviceName}`} onClick={() => void run(async () => { await queueSyncClient.removeDevice(row.deviceId); })}>Remove</button></li>)}</ul> : <p>No queues from other devices.</p>}
    <p className="queue-manager-note">Restoring replaces this device’s queue and leaves playback paused.</p>
    {(error || player.queuePersistenceError) && <p role="alert" className="queue-manager-error">{error || player.queuePersistenceError}</p>}
    {state.owner === ownerId && state.error && <p role="status" className="queue-manager-error">{state.error} <button type="button" onClick={() => void queueSyncClient.refresh()}>Refresh</button></p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
