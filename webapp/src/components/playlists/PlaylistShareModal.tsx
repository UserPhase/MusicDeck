import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../context/AuthContext";
import { getPlaylistSharing, searchSharingUsers, savePlaylistSharing, createPlaylistInvitation, revokePlaylistInvitation,
  type SharingState, type HouseholdUser, type PlaylistGrant, type PlaylistVisibility, type CollaboratorRole } from "../../api/playlistCollaboration";
import "../../styles/playlist-collaboration.css";
const message = (error: unknown) => error instanceof Error ? error.message : "Could not update playlist sharing. Try again.";
const modeOptions: [PlaylistVisibility, string, string][] = [
  ["PRIVATE", "Private", "Only you can view and edit this playlist."],
  ["SHARED_READ", "Shared with viewers", "Selected members can listen. You manage the tracks."],
  ["COLLABORATIVE", "Collaborative", "Give selected members viewer or collaborator access."],
  ["PUBLIC_SERVER", "Everyone on this server", "All signed-in accounts can listen. You manage the tracks."],
];
export function ContributorAvatar({ user, label }: { user: { displayName: string; avatarUrl: string | null }; label?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user.avatarUrl]);
  const words = user.displayName.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : user.displayName.trim().slice(0, 2)).toLocaleUpperCase();
  return <span className="playlist-contributor" title={label || user.displayName} aria-label={label || user.displayName}>
    {user.avatarUrl && !failed ? <img src={user.avatarUrl} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials || "?"}
  </span>;
}
export default function PlaylistShareModal({ playlistId, playlistName, onClose, onSaved }: {
  playlistId: string; playlistName: string; onClose(): void; onSaved?(state: SharingState): void;
}) {
  const ownerId = useAuth()?.session?.id;
  return ownerId ? <ShareDialog key={`${ownerId}:${playlistId}`} ownerId={ownerId} playlistId={playlistId} playlistName={playlistName} onClose={onClose} onSaved={onSaved} /> : null;
}
function ShareDialog({ ownerId, playlistId, playlistName, onClose, onSaved }: {
  ownerId: string; playlistId: string; playlistName: string; onClose(): void; onSaved?(state: SharingState): void;
}) {
  const [state, setState] = useState<SharingState | null>(null), [mode, setMode] = useState<PlaylistVisibility>("PRIVATE");
  const [grants, setGrants] = useState<PlaylistGrant[]>([]), [users, setUsers] = useState<HouseholdUser[]>([]);
  const [query, setQuery] = useState(""), [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [invitation, setInvitation] = useState("");
  const dialog = useRef<HTMLDivElement>(null), controller = useRef<AbortController | null>(null), searchController = useRef<AbortController | null>(null);
  const alive = useRef(true), locked = useRef(false), closeRef = useRef(onClose); closeRef.current = onClose;
  const load = useCallback(async () => {
    controller.current?.abort(); const active = new AbortController(); controller.current = active; setLoading(true); setError("");
    try { const result = await getPlaylistSharing(playlistId, active.signal); if (!active.signal.aborted) { setState(result); setMode(result.mode); setGrants(result.grants); setRecipient(""); setInvitation(""); } }
    catch (reason) { if (!active.signal.aborted) setError(message(reason)); }
    finally { if (!active.signal.aborted) setLoading(false); }
  }, [playlistId]);
  useEffect(() => {
    alive.current = true; void load(); const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; dialog.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!locked.current) closeRef.current(); }
      if (event.key !== "Tab") return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])];
      if (!items.length) { event.preventDefault(); return; }
      if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0]).focus(); }
      else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => { alive.current = false; controller.current?.abort(); searchController.current?.abort(); document.removeEventListener("keydown", keys); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [load]);
  useEffect(() => {
    searchController.current?.abort();
    if (mode !== "SHARED_READ" && mode !== "COLLABORATIVE") return;
    const active = new AbortController(); searchController.current = active;
    const timer = window.setTimeout(() => { void searchSharingUsers(playlistId, query, active.signal).then(result => {
      if (!active.signal.aborted) setUsers(result.users);
    }).catch(reason => { if (!active.signal.aborted) setError(message(reason)); }); }, 150);
    return () => { window.clearTimeout(timer); active.abort(); };
  }, [query, mode, playlistId]);
  const encoded = (list: PlaylistGrant[]) => JSON.stringify(list.map(({ userId, role }) => ({ userId, role })).sort((a, b) => a.userId.localeCompare(b.userId)));
  const dirty = Boolean(state && (mode !== state.mode || encoded(grants) !== encoded(state.grants)));
  const operate = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (locked.current) return; locked.current = true; setBusy(true); setError(""); setNotice("");
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    try { await work(active.signal); } catch (reason) { if (!active.signal.aborted) setError(message(reason)); }
    finally { locked.current = false; if (alive.current && !active.signal.aborted) setBusy(false); }
  };
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); if (alive.current) setNotice("Link copied."); }
    catch { if (alive.current) { setInvitation(value); setNotice("Select and copy the link below."); } } };
  return createPortal(<div className="playlist-share-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !locked.current) onClose(); }}>
    <div className="playlist-share-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-share-title" ref={dialog} tabIndex={-1}>
      <header><div><p className="playlist-share-eyebrow">HOUSEHOLD COLLABORATION</p><h2 id="playlist-share-title">Share {playlistName}</h2></div>
        <button type="button" aria-label="Close playlist sharing" disabled={busy} onClick={onClose}>×</button></header>
      {loading ? <p role="status">Loading sharing settings…</p> : state && <>
        <fieldset disabled={busy} className="playlist-share-modes"><legend>Who has access?</legend>
          {modeOptions.map(([value, label, description]) => <label key={value} className={mode === value ? "is-active" : ""}>
            <input type="radio" name="playlist-visibility" value={value} checked={mode === value} onChange={() => {
              setMode(value); setInvitation("");
              if (value === "PRIVATE" || value === "PUBLIC_SERVER") setGrants([]);
              else if (value === "SHARED_READ") setGrants(rows => rows.map(row => ({ ...row, role: "VIEWER" })));
            }} /><span><strong>{label}</strong><small>{description}</small></span></label>)}
        </fieldset>
        {(mode === "SHARED_READ" || mode === "COLLABORATIVE") && <section className="playlist-share-members" aria-label="Playlist members">
          <label htmlFor="playlist-member-search">Add household members</label><input id="playlist-member-search" type="search" value={query} disabled={busy} maxLength={100}
            placeholder="Search names or usernames" onChange={event => setQuery(event.target.value)} />
          <ul>{grants.map(member => <li key={member.userId}><ContributorAvatar user={member} /><div className="playlist-share-member-name"><strong>{member.displayName}</strong><small>@{member.username}{member.disabled ? " · Account disabled" : ""}</small></div>
            <select aria-label={`Role for ${member.displayName}`} disabled={busy || mode === "SHARED_READ"} value={member.role} onChange={event => setGrants(rows => rows.map(row => row.userId === member.userId ? { ...row, role: event.target.value as CollaboratorRole } : row))}>
              <option value="VIEWER">Viewer</option><option value="COLLABORATOR">Collaborator</option></select>
            <button type="button" disabled={busy} aria-label={`Remove ${member.displayName}`} onClick={() => setGrants(rows => rows.filter(row => row.userId !== member.userId))}>×</button></li>)}</ul>
          <div className="playlist-share-user-results" aria-label="Matching household members">{users.filter(user => !grants.some(grant => grant.userId === user.id)).map(user =>
            <button type="button" key={user.id} disabled={busy || grants.length >= 100} onClick={() => setGrants(rows => [...rows, { userId: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, role: "VIEWER" }])}>
              <ContributorAvatar user={user} /><span>{user.displayName}<small>@{user.username}</small></span><span aria-hidden="true">＋</span></button>)}</div>
          <p className="playlist-share-note">Collaborators can add, reorder, and remove tracks. Sharing, details, and deletion stay with the owner.</p>
        </section>}
        <section className="playlist-share-links" aria-label="Sharing links"><h3>Sharing links</h3>
          <p>Invitations expire in 7 days and require the recipient’s account. Links never grant extra permissions.</p>
          <button type="button" disabled={busy} onClick={() => void copy(new URL(`/playlist/${encodeURIComponent(playlistId)}`, window.location.origin).href)}>Copy playlist link</button>
          {state.mode !== "PRIVATE" && <div className="playlist-invitation-row">
            <select aria-label="Invitation recipient" value={recipient} disabled={busy || dirty} onChange={event => setRecipient(event.target.value)}>
              <option value="">{state.mode === "PUBLIC_SERVER" ? "Any server account" : "Choose a playlist member"}</option>
              {state.grants.filter(member => !member.disabled).map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
            </select><button type="button" disabled={busy || dirty || (state.mode !== "PUBLIC_SERVER" && !recipient)} onClick={() => void operate(async signal => {
              const result = await createPlaylistInvitation(playlistId, ownerId, recipient || null, signal); if (signal.aborted) return;
              const url = new URL("/playlist-share", window.location.origin); url.hash = `token=${result.token}`; setInvitation(url.href);
              const updated = await getPlaylistSharing(playlistId, signal); if (!signal.aborted) { setState(updated); await copy(url.href); }
            })}>Create invitation</button></div>}
          {dirty && <p className="playlist-share-note">Save your changes before creating an invitation. Saving revokes previous invitations.</p>}
          {invitation && <label className="playlist-share-copy">Invitation link<input aria-label="Invitation link" readOnly value={invitation} onFocus={event => event.target.select()} /></label>}
          <ul>{state.links.map(link => <li key={link.id}><span>{link.recipientName || "Any server account"}<small>Expires {new Date(link.expiresAt).toLocaleDateString()}</small></span>
            <button type="button" disabled={busy} aria-label={`Revoke invitation for ${link.recipientName || "any server account"}`} onClick={() => void operate(async signal => {
              await revokePlaylistInvitation(playlistId, ownerId, link.id, signal); if (!signal.aborted) { setState(old => old ? { ...old, links: old.links.filter(row => row.id !== link.id) } : old); setInvitation(""); setNotice("Invitation revoked."); }
            })}>Revoke</button></li>)}</ul>
        </section>
      </>}
      {error && <p className="playlist-share-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => void load()}>Reload settings</button></p>}
      {notice && <p role="status">{notice}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Done</button><button type="button" className="playlist-share-primary" disabled={busy || loading || !state || !dirty}
        onClick={() => state && void operate(async signal => {
          const updated = await savePlaylistSharing(playlistId, ownerId, state.revision, mode, grants.map(({ userId, role }) => ({ userId, role })), signal);
          if (!signal.aborted) { setState(updated); setMode(updated.mode); setGrants(updated.grants); setInvitation(""); setNotice("Sharing updated.");
            onSaved?.(updated); window.dispatchEvent(new CustomEvent("playlistsChanged", { detail: { playlistId } })); }
        })}>{busy ? "Saving…" : "Save sharing"}</button></footer>
    </div>
  </div>, document.body);
}
