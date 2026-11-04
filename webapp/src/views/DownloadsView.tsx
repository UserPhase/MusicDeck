import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { getPlaylists } from "../api/playlists";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import TrackRow from "../components/TrackRow";
import { useOnlineStatus } from "../components/OfflineStatusBanner";
import { autoDownloadPolicies, AUTO_POLICIES_CHANGED, type AutoDownloadPolicy } from "../services/storage/AutoDownloadPolicyManager";
import { offlineDownloadEngine as engine, storageBoundary, messageOf, permitsAutomaticDownload, type StorageBoundary, type OfflineManifest } from "../services/storage/OfflineDownloadEngine";
import { countLegacyDownloads, importLegacyDownloads } from "../services/storage/LegacyOfflineImports";
import { formatStorageSize } from "../utils/browserCache";
import ServerDownloads from "./ServerDownloads";
import "../styles/downloads.css";

type PlaylistChoice = { id: string; name: string };
export default function DownloadsView() {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const { isAuthenticated, session } = useAuth()!;
  const { playContext } = usePlayer()!;
  const online = useOnlineStatus();
  const [verified, setVerified] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boundary, setBoundary] = useState<StorageBoundary | null>(null);
  const [policies, setPolicies] = useState<AutoDownloadPolicy[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistChoice[]>([]);
  const [unknownAllowed, setUnknownAllowed] = useState(false);
  const [tab, setTab] = useState<"tracks" | "albums" | "playlists">("tracks");
  const [filter, setFilter] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [legacyCount, setLegacyCount] = useState(0);
  const signature = snapshot.tracks.map((track) => `${track.key}:${track.checksum}:${track.status}`).join("|");

  const loadSettings = useCallback(async () => {
    const [rules, allowUnknown, usage] = await Promise.all([autoDownloadPolicies.list(), autoDownloadPolicies.allowsUnknownNetwork(), storageBoundary()]);
    setPolicies(rules); setUnknownAllowed(allowUnknown); setBoundary(usage);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void countLegacyDownloads().then((count) => { if (!cancelled) setLegacyCount(count); }).catch((reason) => { if (!cancelled) setError(messageOf(reason)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    void (async () => {
      const ids = new Set<string>();
      for (const track of engine.getSnapshot().tracks) {
        if (cancelled) return;
        if (await engine.readVerifiedTrack(track.track_id)) ids.add(track.track_id);
      }
      if (!cancelled) { setVerified(ids); setChecking(false); }
    })().catch((reason) => { if (!cancelled) { setError(messageOf(reason)); setChecking(false); } });
    return () => { cancelled = true; };
  }, [signature]);
  useEffect(() => {
    let disposed = false;
    const load = () => { void loadSettings().catch((reason) => { if (!disposed) setError(messageOf(reason)); }); };
    load();
    window.addEventListener(AUTO_POLICIES_CHANGED, load);
    window.addEventListener("musicdeck:downloads-changed", load);
    if (isAuthenticated && online) {
      void getPlaylists().then((items) => { if (!disposed) setPlaylists(items.map((item: PlaylistChoice) => ({ id: String(item.id), name: item.name }))); })
        .catch((reason) => { if (!disposed) setError(`Could not load playlist choices: ${messageOf(reason)}`); });
    }
    return () => { disposed = true; window.removeEventListener(AUTO_POLICIES_CHANGED, load); window.removeEventListener("musicdeck:downloads-changed", load); };
  }, [loadSettings, isAuthenticated, online]);

  const tracks = useMemo(() => snapshot.tracks.filter((track) => verified.has(track.track_id) && track.status === "verified"), [snapshot.tracks, verified]);
  const shown = tracks.filter((track) => `${track.track.title || ""} ${track.track.artist || ""} ${track.track.album || ""}`.toLowerCase().includes(filter.toLowerCase()));
  const totalBytes = snapshot.tracks.filter((track) => track.status !== "missing").reduce((sum, track) => sum + track.file_size, 0) + snapshot.jobs.reduce((sum, job) => sum + job.received, 0);
  const byId = new Map(tracks.map((track) => [track.track_id, track]));
  const collections = snapshot.collections.filter((item) => tab === "albums" ? item.kind === "album" : item.kind !== "album");
  const playlistChoices = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  for (const rule of policies) if (rule.kind === "playlist" && !playlistChoices.has(rule.id)) playlistChoices.set(rule.id, { id: rule.id, name: rule.name });
  async function action(operation: () => Promise<unknown>, success = "") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await operation(); if (success) setNotice(success); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }
  function play(items: OfflineManifest[], start = 0) {
    void action(async () => {
      const available = [];
      for (const item of items) {
        if (!await engine.readVerifiedTrack(item.track_id)) throw new Error("An offline file is missing or damaged. Verify your files and download it again.");
        available.push({ ...item.track, id: item.track_id, offlineOnly: true, availability: { libraryAvailable: true }, source: { kind: "library" } });
      }
      await playContext(available, start, { type: "downloads", id: "device", name: "Downloads", coverArt: null });
    });
  }
  const policyEnabled = (kind: string, id: string) => policies.some((rule) => rule.kind === kind && rule.id === id && rule.enabled);
  function togglePolicy(kind: "favorites" | "playlist", id: string, name: string, enabled: boolean) {
    void action(() => autoDownloadPolicies.setPolicy({ kind, id, name, enabled }), enabled ? `${name} will download on an eligible connection.` : `Auto-download disabled for ${name}. Saved audio is retained.`);
  }

  return <main className="downloads-view" aria-labelledby="downloads-title">
    <header className="downloads-hero">
      <div><span className="downloads-eyebrow">YOUR MUSIC</span><h1 id="downloads-title">Downloads<span aria-hidden="true"> ↓</span></h1>
        <p>{checking ? "Checking saved audio…" : `${tracks.length} verified tracks`} <span aria-hidden="true">/</span> {formatStorageSize(totalBytes)} used on this device</p></div>
      <button className="downloads-primary" type="button" disabled={busy || checking || !tracks.length} onClick={() => play(tracks)}><span aria-hidden="true">▶ </span>Play downloads</button>
    </header>

    {isAuthenticated && session?.id && <ServerDownloads key={session.id} online={online} />}

    <section className="downloads-boundary" aria-label="Browser storage status">
      <strong>WEB / PWA STORAGE</strong>
      <p>Saved audio plays without your server. Downloads belong to this browser and origin; clearing site data removes them.
        Browser quotas and eviction still apply. Native clients require a separate file store and operating-system download service for stronger retention and background execution.</p>
      <div className="downloads-quota"><span>{boundary?.quota != null ? `${formatStorageSize(boundary.usage)} of ${formatStorageSize(boundary.quota)} origin quota used` : "Browser quota estimate unavailable"}</span>
        <span>{boundary?.persistent ? "Browser persistence granted" : "Browser persistence not granted"}</span></div>
      {boundary?.quota != null && boundary.quota > 0 && <meter min={0} max={boundary.quota} value={boundary.usage || 0} aria-label="Browser origin storage usage" />}
      <div className="downloads-actions">
        <button type="button" disabled={busy || !navigator.storage?.persist || boundary?.persistent} onClick={() => { void action(async () => {
          const granted = await navigator.storage.persist(); await loadSettings();
          setNotice(granted ? "Browser persistence granted. Clearing site data can still remove downloads." : "The browser did not grant persistence. You can still download within its storage limits.");
        }); }}>Request browser persistence</button>
        <button type="button" disabled={busy || checking} onClick={() => { void action(async () => {
          const report = await engine.verifyIntegrity(); setNotice(`${report.verified} files verified. ${report.damaged} files need downloading again.`);
        }); }}>{busy ? "Working…" : "Verify Offline Files Integrity"}</button>
      </div>
    </section>

    {(error || snapshot.error) && <p className="downloads-error" role="alert">{error || snapshot.error}</p>}
    {notice && <p className="downloads-notice" role="status">{notice}</p>}
    {!isAuthenticated && <p className="downloads-notice">Local Downloads mode. <Link to="/login">Sign in</Link> when your server is available to add music or change auto-download rules.</p>}
    {legacyCount > 0 && <section className="downloads-notice"><p>{legacyCount} older downloads are stored without account labels. Importing copies them into this account’s Downloads. Original files are retained and may use extra browser space.</p>
      <button type="button" disabled={busy || !engine.getOwner()} onClick={() => { void action(async () => {
        const report = await importLegacyDownloads(); setNotice(`${report.imported} older downloads imported. ${report.failed} files could not be imported.${report.errors.length ? ` ${report.errors[0]}` : ""}`);
        setLegacyCount(report.failed);
      }); }}>Import older downloads into this account</button></section>}

    <details className="downloads-policies"><summary>Auto-download rules <span>{policies.filter((rule) => rule.enabled).length} enabled</span></summary>
      <p>New favorites and playlist additions are checked every five minutes while MusicDeck is open, on reconnect, and by background sync where the browser supports it. Removed collection items keep their saved audio until you remove it.</p>
      <p>Auto-downloads require a known Wi-Fi or unmetered connection. Browsers that do not expose connection cost pause automatically.</p>
      <label><input type="checkbox" disabled={busy || !isAuthenticated} checked={unknownAllowed} onChange={(event) => { const checked = event.target.checked; void action(() => autoDownloadPolicies.setAllowUnknownNetwork(checked)); }} /> Allow auto-downloads when connection cost is unknown</label>
      <label><input type="checkbox" disabled={busy || !isAuthenticated} checked={policyEnabled("favorites", "favorites")} onChange={(event) => togglePolicy("favorites", "favorites", "Favorites", event.target.checked)} /> Auto-download Favorites</label>
      {Array.from(playlistChoices.values()).map((playlist) => <label key={playlist.id}><input type="checkbox" disabled={busy || !isAuthenticated} checked={policyEnabled("playlist", playlist.id)} onChange={(event) => togglePolicy("playlist", playlist.id, playlist.name, event.target.checked)} /> Auto-download {playlist.name}</label>)}
    </details>

    {snapshot.jobs.length > 0 && <section className="downloads-queue" aria-label="Download queue"><h2>Download queue <span>{snapshot.jobs.length}</span></h2>
      {snapshot.jobs.map((job) => <article key={job.key}><div><strong>{job.track.title || `Track ${job.track.id}`}</strong>
        <p>{job.state === "failed" ? "Needs attention" : !online ? "Waiting for connection" : job.automatic && !permitsAutomaticDownload(unknownAllowed) ? "Waiting for Wi-Fi or an unmetered connection" : job.state === "downloading" ? "Downloading" : "Queued"} · {formatStorageSize(job.received)}{job.total ? ` / ${formatStorageSize(job.total)}` : ""}</p>
        {job.error && <p className="downloads-error">{job.error}</p>}
        {job.total != null && <progress value={job.received} max={job.total} aria-label={`Download progress for ${job.track.title || job.track.id}`} />}</div>
        {job.state === "failed" && <button type="button" disabled={busy || !isAuthenticated} onClick={() => { void action(() => engine.enqueueDownload(job.track, job.quality)); }}>Retry</button>}
        <button type="button" disabled={busy} onClick={() => { void action(() => engine.cancelDownload(String(job.track.id))); }}>Cancel</button></article>)}
    </section>}

    <div className="downloads-toolbar"><div className="downloads-tabs" role="group" aria-label="Download type">
      {(["tracks", "albums", "playlists"] as const).map((type) => <button key={type} type="button" aria-pressed={tab === type} onClick={() => setTab(type)}>{type[0].toUpperCase() + type.slice(1)}</button>)}</div>
      <input type="search" aria-label="Filter downloads" placeholder="Find saved music" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    {checking && <p role="status">Verifying audio on this device…</p>}
    {!checking && tab === "tracks" && !shown.length && <div className="downloads-empty"><span aria-hidden="true">↓</span><h2>{filter ? "No matching downloads" : "Take your music with you"}</h2><p>{filter ? "Try another title, artist, or album." : "Choose Download to device from a track menu, or download a whole album or playlist. Verified audio will appear here."}</p></div>}
    {tab === "tracks" && <div className="downloads-tracks track-list" role="table" aria-label="Verified offline tracks">{shown.map((item, index) => <TrackRow key={item.key} song={item.track} index={index} onPlay={() => play(shown, index)} preserveDeleted showImportAction={false}
      action={<button type="button" className="downloads-remove" disabled={busy} aria-label={`Remove ${item.track.title || "track"} from downloads`} onClick={() => setConfirmRemove(item.track_id)}>Remove</button>} />)}</div>}
    {tab !== "tracks" && <div className="downloads-collections">{collections.filter((collection) => collection.name.toLowerCase().includes(filter.toLowerCase())).map((collection) => {
      const available = collection.trackIds.map((id) => byId.get(id)).filter((item): item is OfflineManifest => Boolean(item));
      return <article key={collection.key}><span className="downloads-eyebrow">{collection.kind.toUpperCase()}</span><h2>{collection.name}</h2>
        <p>{available.length} / {collection.trackIds.length} tracks verified · {available.length === collection.trackIds.length && available.length ? "Available offline" : "Partially downloaded"}</p>
        <button type="button" disabled={busy || checking || !available.length} onClick={() => play(available)}>▶ Play saved tracks</button></article>;
    })}{!collections.length && <p>No saved {tab} yet. Download a collection from its page.</p>}</div>}
    {snapshot.tracks.some((track) => track.status !== "verified") && <section aria-label="Damaged downloads"><h2>Files needing attention</h2>
      {snapshot.tracks.filter((track) => track.status !== "verified").map((track) => <article className="downloads-damaged" key={track.key}><span>{track.track.title || track.track_id} · {track.status}</span>
        <button type="button" disabled={busy || !online || !isAuthenticated} onClick={() => { void action(() => engine.enqueueDownload(track.track, track.quality)); }}>Download again</button>
        <button type="button" disabled={busy} onClick={() => setConfirmRemove(track.track_id)}>Remove</button></article>)}
    </section>}
    {confirmRemove && <div className="downloads-confirm" role="alert"><p>Remove this track’s audio from this device?</p><button type="button" disabled={busy} onClick={() => { const id = confirmRemove; setConfirmRemove(null); void action(() => engine.purgeDownloadedTrack(id), "Offline audio removed."); }}>Remove download</button><button type="button" onClick={() => setConfirmRemove(null)}>Keep download</button></div>}
  </main>;
}
