import { useCallback, useEffect, useRef, useState } from "react";
import { getVisualActivity, startVisualPolling } from "../services/visualActivity";
import { Link } from "react-router-dom";
import { getReleaseFeed, unfollowArtist, followsChanged, type NewRelease, type ReleaseFeed } from "../api/artistFollows";
import { request } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePrivacy } from "../context/PrivacyContext";
import { usePlayer } from "../context/PlayerContext";
import { useSavedDiscoveries, discoveryInput } from "../hooks/useSavedDiscoveries";
import { useExternalAction } from "../services/externalActions";
import { toUnifiedTrack } from "../types/track";
import "../styles/new-releases.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Could not load releases. Try again.";
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function ReleaseCard({ release }: { release: NewRelease }) {
  const { canMetadata, canImport, canArtwork } = usePrivacy();
  const player = usePlayer();
  const item = { ...release, metadata: { songCount: release.trackCount, year: Number(release.releaseDate.slice(0, 4)) }, source: { kind: "external", count: 0 } };
  const saved = useSavedDiscoveries();
  const input = discoveryInput("album", item);
  const existing = saved.items.find(entry => entry.type === "album" && entry.provider === release.provider && entry.external_id === release.providerId);
  const { snapshot, start } = useExternalAction("album", item);
  const [expanded, setExpanded] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [tracks, setTracks] = useState<ReturnType<typeof toUnifiedTrack>[] | null>(null), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => setArtworkFailed(false), [release.coverUrl]);
  useEffect(() => { if (!canMetadata) { controller.current?.abort(); setLoading(false); } }, [canMetadata]);
  const preview = async () => {
    if (expanded) { controller.current?.abort(); setLoading(false); setExpanded(false); return; }
    setExpanded(true); if (tracks) return;
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setLoading(true); setError("");
    try {
      const result = await request(`/api/albums/${encodeURIComponent(release.id)}/tracks`, { signal: active.signal });
      if (!active.signal.aborted) setTracks((result.tracks || []).map((track: unknown) => toUnifiedTrack(track, "new-releases")));
    } catch (reason) { if (!active.signal.aborted) { setError(message(reason)); setExpanded(false); } }
    finally { if (!active.signal.aborted) setLoading(false); }
  };
  const busy = snapshot.state === "QUEUED" || snapshot.state === "IMPORTING";
  return <article className="release-card" aria-label={`${release.title} by ${release.artist}`}>
    <Link className="release-cover" to={`/album/${encodeURIComponent(release.id)}`}>
      {canArtwork && release.coverUrl && !artworkFailed ? <img src={release.coverUrl} alt="" loading="lazy" decoding="async" onError={() => setArtworkFailed(true)} /> : <span aria-hidden="true">♫</span>}
      <span className="release-type">{release.albumType}</span>
    </Link>
    <div className="release-card-body">
      <time dateTime={release.releaseDate}>{dateLabel(release.releaseDate)}</time>
      <h3><Link to={`/album/${encodeURIComponent(release.id)}`}>{release.title}</Link></h3>
      <Link className="release-artist" to={`/artist/${encodeURIComponent(release.artistId)}`}>{release.artist}</Link>
      <div className="release-actions">
        <button type="button" disabled={!canMetadata} aria-expanded={expanded} onClick={() => void preview()}>{loading ? "Loading tracks…" : expanded ? "Close tracks" : "Preview tracks"}</button>
        <button type="button" aria-pressed={Boolean(existing)} disabled={!saved.enabled || saved.loading || saving || !input}
          onClick={async () => {
            if (!input || savingRef.current) return; savingRef.current = true; setSaving(true); setError("");
            try { const success = existing ? await saved.remove(existing.id) : await saved.save(input);
              if (!success && alive.current) setError("Could not update your wishlist. Try again."); }
            catch (reason) { if (alive.current) setError(message(reason)); }
            finally { savingRef.current = false; if (alive.current) setSaving(false); }
          }}>{saving ? "Saving…" : existing ? "In wishlist" : "Save to wishlist"}</button>
        <button type="button" disabled={!canImport || busy || snapshot.state === "IN_LIBRARY"} onClick={() => void start()}>
          {snapshot.state === "IN_LIBRARY" ? "In library" : busy ? snapshot.state === "QUEUED" ? "Import queued" : "Importing…" : snapshot.state === "FAILED" ? "Retry import" : "Import via spotDL"}</button>
      </div>
      {snapshot.message && <p role={snapshot.state === "FAILED" ? "alert" : "status"} className="release-status">{snapshot.message}</p>}
      {error && <p role="alert" className="release-error">{error}</p>}
      {expanded && <div className="release-preview" aria-label={`Tracks on ${release.title}`}>
        {!loading && !tracks?.length && <p>No track previews are available for this release.</p>}
        <ol>{tracks?.map((track, index) => <li key={`${track.id}:${index}`}>
          <button type="button" disabled={!canMetadata || !track.previewUrl} title={track.previewUrl ? "Play sample" : "No sample available"}
            onClick={async () => { try { if (!player) throw new Error("The player is unavailable. Refresh MusicDeck and try again.");
              await player.playSong(track); } catch (reason) { if (alive.current) setError(message(reason)); } }}>
            <span aria-hidden="true">▷</span> {track.title}</button>
        </li>)}</ol>
      </div>}
      {release.storeUrl && <a className="release-store-link" href={release.storeUrl} target="_blank" rel="noopener noreferrer">
        {release.provider === "itunes" ? "Listen on Apple Music ↗" : "Open in Deezer ↗"}</a>}
    </div>
  </article>;
}

function Feed({ ownerId, shelf = false }: { ownerId: string; shelf?: boolean }) {
  const { canMetadata } = usePrivacy();
  const [data, setData] = useState<ReleaseFeed>({ releases: [], artists: [], hasMore: false });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [offset, setOffset] = useState(0);
  const controller = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const limit = shelf ? 6 : 30;
  const load = useCallback(() => {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    void getReleaseFeed(offset, limit, active.signal).then(result => { if (!active.signal.aborted) { setData(result); setError(""); } })
      .catch(reason => { if (!active.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!active.signal.aborted) setLoading(false); });
  }, [offset, limit]);
  useEffect(() => {
    mounted.current = true; setLoading(true);
    const stopPolling = startVisualPolling(load, 30_000);
    const refresh = () => { if (getVisualActivity()) load(); };
    window.addEventListener("musicdeck:artist-follows-changed", refresh); window.addEventListener("online", refresh);
    return () => { mounted.current = false; controller.current?.abort(); action.current?.abort(); stopPolling();
      window.removeEventListener("musicdeck:artist-follows-changed", refresh); window.removeEventListener("online", refresh); };
  }, [load]);
  const operate = async (work: (signal: AbortSignal) => Promise<unknown>, success: string) => {
    if (action.current) return; const active = new AbortController(); action.current = active; setBusy(true); setError("");
    try { await work(active.signal); if (!active.signal.aborted) { setNotice(success); followsChanged(); load(); } }
    catch (reason) { if (!active.signal.aborted) setError(message(reason)); }
    finally { if (action.current === active) action.current = null; if (mounted.current && !active.signal.aborted) setBusy(false); }
  };
  const heading = "New Releases from Artists You Follow";
  if (shelf && data.releases.length === 0) return null;
  return <section className={`new-releases ${shelf ? "new-releases--shelf home-section" : "new-releases--library library-section"}`} aria-labelledby={shelf ? "home-releases-title" : "new-releases-title"}>
    <header className={shelf ? "release-feed-header" : "library-section-header release-library-header"}>
      <h2 id={shelf ? "home-releases-title" : "new-releases-title"}>{heading}</h2>
      {!shelf && <span>Last 30 days</span>}
      {shelf && <Link className="see-all" to="/new-releases">See all</Link>}
    </header>
    {!canMetadata && <p role="status">External metadata is disabled. Your cached feed remains available.</p>}
    {error && <p role="alert" className="release-error">{error} <button type="button" onClick={load}>Retry</button></p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p className="loading" role="status">Loading releases…</p> : data.releases.length ? <div className={shelf ? "release-grid" : "album-grid release-library-grid"}>
      {data.releases.map(release => <ReleaseCard key={release.id} release={release} />)}</div> : <div className="release-empty">
      <span aria-hidden="true">◎</span><h3>{data.artists.length ? "You're caught up" : "Your next favorite starts with a follow"}</h3>
      <p>{data.artists.length ? "No releases from the last 30 days are cached yet. New follows are checked in the background." : "Open an artist page and choose Follow artist. Owning a track never follows an artist automatically."}</p>
      <Link to="/search">Find artists</Link>
    </div>}
    {!shelf && (offset > 0 || data.hasMore) && <nav className="release-pagination" aria-label="Release pages">
      <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous</button>
      <span>Page {Math.floor(offset / limit) + 1}</span><button type="button" disabled={!data.hasMore || loading} onClick={() => setOffset(value => value + limit)}>Next</button>
    </nav>}
    {!shelf && data.artists.length > 0 && <details className="release-following"><summary>Following {data.artists.length} {data.artists.length === 1 ? "artist" : "artists"}</summary>
      <ul>{data.artists.map(artist => <li key={artist.key}><div><Link to={`/artist/${encodeURIComponent(artist.artistId)}`}>{artist.artistName}</Link>
        <small>{artist.error || (artist.checkedAt ? `Checked ${new Date(artist.checkedAt).toLocaleString()}` : "Waiting for first scan")}</small></div>
        <button type="button" disabled={busy} aria-label={`Unfollow ${artist.artistName}`}
          onClick={() => void operate(signal => unfollowArtist(ownerId, artist.key, signal), `Unfollowed ${artist.artistName}.`)}>Unfollow</button></li>)}</ul>
    </details>}
  </section>;
}
export function NewReleasesShelf() {
  const ownerId = useAuth()?.session?.id;
  return ownerId ? <Feed key={`${ownerId}:shelf`} ownerId={ownerId} shelf /> : null;
}
export default function NewReleasesView() {
  const ownerId = useAuth()?.session?.id;
  return ownerId ? <Feed key={ownerId} ownerId={ownerId} /> : <p>Sign in to see releases from artists you follow.</p>;
}
