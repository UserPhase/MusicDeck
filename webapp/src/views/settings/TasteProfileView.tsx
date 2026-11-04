import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useTasteProfile } from "../../hooks/useTasteProfile";
import { tasteProfileStore, TASTE_CHANGED, type TastePreferences } from "../../services/TasteProfileStore";
import "../../styles/taste-profile.css";

interface HiddenItem { id: string; type: "track" | "artist" | "album"; title: string; artist: string; album: string; aliases: number }
interface Overview extends TastePreferences {
  hidden: HiddenItem[]; trackExclusions: Array<{ id: string; title: string; artist: string }>;
  playlistExclusions: Array<{ id: string; name: string }>; eligibleListens: number;
}
const folded = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
function TasteDashboard({ embedded }: { embedded: boolean }) {
  const preferences = useTasteProfile(), [data, setData] = useState<Overview | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState(""), [type, setType] = useState("all"), [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(""), [confirming, setConfirming] = useState(false), [confirmation, setConfirmation] = useState("");
  const alive = useRef(false), sequence = useRef(0), lock = useRef(false);
  const load = useCallback(async (clearError = true) => {
    const request = ++sequence.current;
    try { const result = await tasteProfileStore.request<Overview>(""); if (alive.current && request === sequence.current) { setData(result); if (clearError) setError(""); } }
    catch (reason) { if (alive.current && request === sequence.current) setError(reason instanceof Error ? reason.message : "Could not load your taste profile."); }
    finally { if (alive.current && request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void load(); const changed = () => { void load(); };
    window.addEventListener(TASTE_CHANGED, changed);
    return () => { alive.current = false; window.removeEventListener(TASTE_CHANGED, changed); };
  }, [load]);
  async function mutate(key: string, action: string, body: Record<string, unknown>, success: string) {
    if (lock.current) return; lock.current = true; setBusy(key); setError(""); setNotice("");
    try {
      const result = await tasteProfileStore.request<Overview>(action, body);
      if (alive.current) { sequence.current++; setData(result); setNotice(success); if (action === "/reset") { setConfirming(false); setConfirmation(""); } }
    } catch (reason) { if (alive.current) { setError(reason instanceof Error ? reason.message : "Could not update your taste profile."); void load(false); } }
    finally { lock.current = false; if (alive.current) setBusy(""); }
  }
  const filtered = (data?.hidden ?? []).filter(item => (type === "all" || item.type === type) && folded(`${item.title} ${item.artist} ${item.album}`).includes(folded(query.trim())));
  return <section className={`taste-profile-view${embedded ? " is-embedded" : ""}`} aria-label="Taste and feedback manager">
    <header className="taste-heading"><div><span className="taste-eyebrow">MUSICDECK / YOUR SIGNAL</span>{embedded ? <h2>Taste &amp; feedback</h2> : <h1>Taste &amp; feedback</h1>}<p>Keep the listening that feels like you. Leave the rest out of your recommendations.</p></div>
      <button type="button" disabled={Boolean(busy) || loading} onClick={() => { setLoading(true); void load(); }}>Refresh</button></header>
    {error && <p role="alert" className="taste-error">{error}</p>}{notice && <p role="status" className="taste-notice">{notice}</p>}
    <article className="taste-private-card"><div><span className="taste-eyebrow">PRIVATE LISTENING</span><h3>Listen without shaping your taste.</h3><p>History and enabled scrobbling keep working. Private sessions stay out of recommendations, smart listening counts, and automatic queue extensions.</p></div>
      <div><button type="button" role="switch" aria-label="Private listening mode" aria-checked={preferences.privateListening} className="taste-switch" onClick={() => { void preferences.setPrivate(!preferences.privateListening).catch(reason => setError(reason instanceof Error ? reason.message : "Could not update private listening.")); }}><span aria-hidden="true" />{preferences.privateListening ? "On" : "Off"}</button>
        {preferences.pending && <small role="status">Saved on this device. Waiting to sync.</small>}{preferences.error && <small role="status" className="taste-error">{preferences.error}</small>}</div></article>
    <div className="taste-metrics"><div><strong>{data?.eligibleListens ?? "—"}</strong><span>eligible listens</span></div><div><strong>{data?.hidden.length ?? "—"}</strong><span>hidden items</span></div><div><strong>{(data?.trackExclusions.length ?? 0) + (data?.playlistExclusions.length ?? 0)}</strong><span>taste exclusions</span></div></div>
    <section className="taste-panel" aria-labelledby="taste-hidden-title"><div className="taste-panel-heading"><div><h3 id="taste-hidden-title">Hidden from recommendations</h3><p>These choices apply across your library and external discoveries. Restore an item to let it appear again.</p></div></div>
      <div className="taste-filter"><input type="search" aria-label="Search hidden items" placeholder="Find an artist, album, or song" value={query} onChange={event => { setQuery(event.target.value); setLimit(50); }} />
        <select aria-label="Hidden item type" value={type} onChange={event => { setType(event.target.value); setLimit(50); }}><option value="all">All items</option><option value="artist">Artists</option><option value="album">Albums</option><option value="track">Tracks</option></select></div>
      {loading ? <p role="status">Loading your taste profile…</p> : !filtered.length ? <p className="taste-empty">{query || type !== "all" ? "No matching hidden items." : "Nothing hidden. Your next discovery is wide open."}</p> : <ul className="taste-items">{filtered.slice(0, limit).map(item => <li key={`${item.type}:${item.id}`}><span className="taste-kind">{item.type === "track" ? "SONG" : item.type.toUpperCase()}</span><div><strong>{item.title}</strong><span>{item.type === "artist" ? "Artist hidden across providers" : [item.artist, item.album].filter(Boolean).join(" · ") || "Metadata unavailable"}{item.aliases > 1 ? ` · ${item.aliases} saved rules` : ""}</span></div>
        <button type="button" disabled={Boolean(busy)} aria-label={`Restore ${item.title}`} onClick={() => { void mutate(`${item.type}:${item.id}`, "/restore", { type: item.type, id: item.id }, `${item.title} can appear in recommendations again.`); }}>{busy === `${item.type}:${item.id}` ? "Restoring…" : "Restore"}</button></li>)}</ul>}
      {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)}>Show more ({filtered.length - limit} remaining)</button>}
    </section>
    <section className="taste-panel" aria-labelledby="taste-excluded-title"><h3 id="taste-excluded-title">Excluded from your taste</h3><p className="taste-help">Excluded songs can still be played and recommended. Their listening activity adds no taste signals. Playlist exclusions apply to plays started from that playlist.</p>
      {!data?.trackExclusions.length && !data?.playlistExclusions.length && <p className="taste-empty">Use a song or playlist menu to exclude its listening activity.</p>}
      <ul className="taste-items">{data?.playlistExclusions.map(item => <li key={`playlist:${item.id}`}><span className="taste-kind">PLAYLIST</span><div><Link to={`/playlist/${encodeURIComponent(item.id)}`}>{item.name}</Link><span>Listening from this playlist is excluded</span></div><button type="button" disabled={Boolean(busy)} onClick={() => { void mutate(item.id, "/playlist", { playlistId: item.id, excluded: false }, `${item.name} can shape future recommendations.`); }}>Include again</button></li>)}
        {data?.trackExclusions.map(item => <li key={`track:${item.id}`}><span className="taste-kind">SONG</span><div><strong>{item.title}</strong><span>{item.artist}</span></div><button type="button" disabled={Boolean(busy)} aria-label={`Include ${item.title} in taste`} onClick={() => { void mutate(item.id, "/track", { trackId: item.id, excluded: false }, `${item.title} is included in your taste profile.`); }}>Include again</button></li>)}</ul>
      <p className="taste-help">A listening session that becomes private stays excluded for that whole session, including offline retries. Turning privacy off applies to new sessions.</p>
    </section>
    <section className="taste-reset-panel"><div><span className="taste-eyebrow">A FRESH START</span><h3>Reset taste profile history</h3><p>Clear past listening influence for your account. Your full history, scrobbles, playlists, favorites, and hidden-item choices stay saved. New listening can build your taste again.</p>{data?.resetBefore && <small>Last reset: {new Date(data.resetBefore).toLocaleString()}</small>}</div>
      {!confirming ? <button type="button" disabled={Boolean(busy) || !data} onClick={() => setConfirming(true)}>Reset listening influence</button> : <form onSubmit={event => { event.preventDefault(); if (data && confirmation === "RESET") void mutate("reset", "/reset", { revision: data.revision, confirmation }, "Past listening influence has been reset. Your saved music and history are preserved."); }}>
        <label>Type RESET to confirm<input aria-label="Confirm taste reset" value={confirmation} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label><div><button type="submit" disabled={Boolean(busy) || confirmation !== "RESET"}>Confirm reset</button><button type="button" disabled={Boolean(busy)} onClick={() => { setConfirming(false); setConfirmation(""); }}>Cancel</button></div></form>}
    </section>
  </section>;
}
export default function TasteProfileView({ embedded = false }: { embedded?: boolean }) {
  const owner = useAuth()?.session?.id;
  return owner ? <TasteDashboard key={owner} embedded={embedded} /> : null;
}
