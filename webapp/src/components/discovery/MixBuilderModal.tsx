import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { usePrivacy } from "../../context/PrivacyContext";
import { usePlayer } from "../../context/PlayerContext";
import { toUnifiedTrack } from "../../types/track";
import { mixRequest, type MixCandidate, type MixPreview, type MixScope, type MixSeed } from "../../api/similarMixes";
import "../../styles/similar-mixes.css";

export interface MixBuilderModalProps { open: boolean; onClose(): void; initialSeeds?: MixSeed[] }
const failure = (error: unknown) => error instanceof Error ? error.message : "The mix could not be updated. Try again.";
const SCOPES: Array<{ value: MixScope; label: string; description: string }> = [
  { value: "LIBRARY_ONLY", label: "My library", description: "Songs you already have" },
  { value: "HYBRID_MIX", label: "A little of both", description: "Familiar songs + discoveries" },
  { value: "DISCOVERY_ONLY", label: "Discoveries", description: "Songs outside your library" },
];

function Builder({ onClose, initialSeeds = [], owner }: Omit<MixBuilderModalProps, "open"> & { owner: string }) {
  const { canMetadata } = usePrivacy(), player = usePlayer(), titleId = useId(), sliderId = useId();
  const [seeds, setSeeds] = useState<MixSeed[]>(() => [...new Map(initialSeeds.map(seed => [seed.id, seed])).values()].slice(0, 5));
  const [scope, setScope] = useState<MixScope>(canMetadata ? "HYBRID_MIX" : "LIBRARY_ONLY"), [adventure, setAdventure] = useState(0.4);
  const [mode, setMode] = useState<"library" | "external">("library"), [query, setQuery] = useState("");
  const [matches, setMatches] = useState<MixSeed[]>([]), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState("");
  const [externalTitle, setExternalTitle] = useState(""), [externalArtist, setExternalArtist] = useState("");
  const [preview, setPreview] = useState<MixPreview | null>(null), [locks, setLocks] = useState<Set<string>>(new Set());
  const [exclusions, setExclusions] = useState<string[]>([]), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [name, setName] = useState("My similar-song mix"), [savedId, setSavedId] = useState<string | null>(null);
  const [audition, setAudition] = useState<{ id: string; title: string; url: string } | null>(null), [previewing, setPreviewing] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null), audio = useRef<HTMLAudioElement>(null), mounted = useRef(false), locked = useRef(false);
  const controllers = useRef(new Set<AbortController>()), auditionEpoch = useRef(0);
  const current = useRef({ owner, player, canMetadata }); current.current = { owner, player, canMetadata };
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow, activeControllers = controllers.current;
    document.body.style.overflow = "hidden"; dialog.current?.focus();
    return () => { mounted.current = false; activeControllers.forEach(controller => controller.abort()); activeControllers.clear();
      document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (!canMetadata) { setScope("LIBRARY_ONLY"); setMode("library"); setDirty(true); auditionEpoch.current++; setPreviewing(null); setAudition(null); } }, [canMetadata]);
  useEffect(() => {
    if (mode !== "library" || query.trim().length < 2 || seeds.length >= 5) { setMatches([]); setSearching(false); return; }
    const controller = new AbortController(), activeControllers = controllers.current; activeControllers.add(controller); setSearching(true); setSearchError("");
    const timer = window.setTimeout(() => { void mixRequest<{ tracks: MixSeed[] }>(`seeds?${new URLSearchParams({ q: query.trim() })}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setMatches(result.tracks); })
      .catch(reason => { if (!controller.signal.aborted) { setMatches([]); setSearchError(failure(reason)); } })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); }); }, 250);
    return () => { clearTimeout(timer); controller.abort(); activeControllers.delete(controller); };
  }, [query, mode, seeds.length]);
  useEffect(() => {
    if (!audition || !audio.current) return;
    const element = audio.current;
    void element.play().catch(() => { if (mounted.current) setNotice("Press Play in the preview player to listen."); });
    return () => { element.pause(); };
  }, [audition]);
  const addSeed = (seed: MixSeed) => {
    if (seeds.some(row => row.id === seed.id)) { setSearchError("That song is already a seed."); return; }
    setSeeds(rows => [...rows, seed].slice(0, 5)); setQuery(""); setMatches([]); setDirty(true); setError(""); setLocks(new Set()); setExclusions([]);
  };
  async function operation(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(label); setError(""); setNotice("");
    const controller = new AbortController(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try { await work(controller.signal); }
    catch (reason) { if (mounted.current) setError(controller.signal.aborted ? "The request timed out. For a save, retry this preview to check the saved result without creating a duplicate." : failure(reason)); }
    finally { clearTimeout(timer); controllers.current.delete(controller); locked.current = false; if (mounted.current) setBusy(""); }
  }
  const addExternal = () => operation("Adding seed…", async signal => {
    const result = await mixRequest<{ track: MixSeed }>("seeds", signal, { ownerId: owner, title: externalTitle, artist: externalArtist });
    if (mounted.current) { addSeed(result.track); setExternalTitle(""); setExternalArtist(""); }
  });
  const generate = (swapId?: string) => operation(swapId ? "Finding a replacement…" : "Building your mix…", async signal => {
    const previous = preview?.tracks ?? [], preserve = swapId ? previous.filter(row => row.id !== swapId).map(row => row.id) : [...locks];
    const exclude = swapId ? [...exclusions, swapId].slice(-1000) : exclusions;
    const result = await mixRequest<MixPreview>("preview", signal, { ownerId: owner, seedTrackIds: seeds.map(seed => seed.id), scope,
      adventurousness: adventure, lockedTrackIds: preserve, excludeTrackIds: exclude });
    if (!mounted.current) return;
    if (!current.current.canMetadata && scope !== "LIBRARY_ONLY") throw new Error("External discovery was disabled. Choose a library-only mix and try again.");
    const retained = new Set(preserve), candidates = new Map(result.tracks.map(row => [row.id, row]));
    const rest = result.tracks.filter(row => !retained.has(row.id));
    // Locked rows retain their slots; a swap changes exactly its selected row.
    previous.forEach((old, index) => { if (retained.has(old.id) && candidates.has(old.id)) rest.splice(Math.min(index, rest.length), 0, candidates.get(old.id)!); });
    setPreview({ ...result, tracks: rest }); setExclusions(exclude); setDirty(false); setSavedId(null);
  });
  const selection = async (signal: AbortSignal) => {
    if (!preview || dirty) throw new Error("Update the preview before using this mix.");
    return mixRequest<{ tracks: Record<string, any>[] }>("selection", signal, { ownerId: owner, previewId: preview.previewId, trackIds: preview.tracks.map(row => row.id) });
  };
  const queue = () => operation("Adding to queue…", async signal => {
    if (!player) throw new Error("The player is not available. Reload MusicDeck and try again.");
    const result = await selection(signal);
    if (!mounted.current) return;
    player.queueTracks(result.tracks.map(track => toUnifiedTrack(track, "similar-mix")));
    const missing = result.tracks.filter(track => track.external && !track.previewUrl).length;
    setNotice(`${result.tracks.length} songs added to your queue.${result.tracks.some(track => track.external) ? " External songs use previews until imported." : ""}${missing ? ` ${missing} discoveries have no preview and need importing before playback.` : ""}`);
  });
  const save = () => operation("Saving playlist…", async signal => {
    if (!preview || dirty) throw new Error("Update the preview before saving this mix.");
    const result = await mixRequest<{ playlist: { id: string } }>("save", signal, { ownerId: owner, previewId: preview.previewId, trackIds: preview.tracks.map(row => row.id), name });
    if (!mounted.current) return;
    setSavedId(result.playlist.id); setNotice("Your mix is saved as an editable playlist."); window.dispatchEvent(new Event("playlistsChanged"));
  });
  async function listen(row: MixCandidate) {
    const token = ++auditionEpoch.current; setPreviewing(row.id); setNotice(""); setError("");
    const controller = new AbortController(); controllers.current.add(controller); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      let url = row.inLibrary ? `/api/tracks/${encodeURIComponent(row.id)}/stream` : "";
      if (!row.inLibrary) {
        if (!current.current.canMetadata) throw new Error("External previews are disabled by your server's privacy settings.");
        const response = await fetch("/api/discovery/external/previews", { method: "POST", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracks: [{ id: row.id, title: row.title, artist: row.artist, album: row.album || null, previewUrl: null, coverUrl: null, isrc: null }] }) });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message || "Could not load this preview.");
        const found = data?.tracks?.find((track: { id: string }) => track.id === row.id)?.previewUrl;
        if (typeof found === "string" && found.startsWith("https://")) url = found;
        if (!url) throw new Error("No audio preview is available for this discovery. You can still save it or choose a replacement.");
      }
      if (mounted.current && token === auditionEpoch.current) setAudition({ id: row.id, title: `${row.title} — ${row.artist}`, url });
    } catch (reason) { if (mounted.current && token === auditionEpoch.current) setError(failure(reason)); }
    finally { clearTimeout(timer); controllers.current.delete(controller); if (mounted.current && token === auditionEpoch.current) setPreviewing(null); }
  }
  const close = () => { if (!busy) onClose(); };
  return createPortal(<div className="mix-builder-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="mix-builder" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),audio[controls],[tabindex="0"]') ?? [])];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="mix-builder-heading"><div><span className="mix-eyebrow">MUSICDECK / DISCOVERY LAB</span><h2 id={titleId}>Follow the sound.</h2><p>A few starting points. A mix that connects them.</p></div>
        <button type="button" className="mix-close" aria-label="Close mix builder" disabled={Boolean(busy)} onClick={close}>×</button></header>
      <div className="mix-builder-body"><section className="mix-controls" aria-label="Mix settings">
        <div className="mix-step"><span>01</span><h3>Plant your seeds</h3><small>{seeds.length} / 5 songs</small></div>
        <ul className="mix-seeds" aria-label="Seed songs">{seeds.map(seed => <li key={seed.id}><div><strong>{seed.title}</strong><small>{seed.artist}</small></div><button type="button" disabled={Boolean(busy)} aria-label={`Remove seed ${seed.title}`} onClick={() => {
          setSeeds(rows => rows.filter(row => row.id !== seed.id)); setDirty(true); setLocks(new Set()); setExclusions([]);
        }}>×</button></li>)}</ul>
        <div className="mix-seed-modes" role="group" aria-label="Seed source"><button type="button" aria-pressed={mode === "library"} disabled={Boolean(busy)} onClick={() => setMode("library")}>Library song</button>
          <button type="button" aria-pressed={mode === "external"} disabled={Boolean(busy) || !canMetadata} onClick={() => setMode("external")}>External song</button></div>
        {mode === "library" ? <div className="mix-seed-search"><label>Find a song<input type="search" placeholder="Search title or artist" maxLength={300} value={query} disabled={Boolean(busy) || seeds.length === 5} onChange={event => setQuery(event.target.value)} /></label>
          {searching && <p role="status">Searching your library…</p>}{searchError && <p role="alert">{searchError}</p>}
          {matches.length > 0 && <ul aria-label="Matching seed songs">{matches.map(seed => <li key={seed.id}><button type="button" disabled={Boolean(busy) || seeds.some(row => row.id === seed.id)} onClick={() => addSeed(seed)}><strong>{seed.title}</strong><small>{seed.artist}</small><span aria-hidden="true">＋</span></button></li>)}</ul>}
          {!searching && !searchError && query.trim().length >= 2 && !matches.length && <p>No matching library songs.</p>}
        </div> : <form className="mix-external-seed" onSubmit={event => { event.preventDefault(); void addExternal(); }}>
          <label>Song title<input value={externalTitle} maxLength={300} required disabled={Boolean(busy) || seeds.length === 5} onChange={event => setExternalTitle(event.target.value)} /></label>
          <label>Artist<input value={externalArtist} maxLength={300} required disabled={Boolean(busy) || seeds.length === 5} onChange={event => setExternalArtist(event.target.value)} /></label>
          <button type="submit" disabled={Boolean(busy) || seeds.length === 5 || !externalTitle.trim() || !externalArtist.trim()}>Add external seed</button></form>}
        <div className="mix-step"><span>02</span><h3>Choose your territory</h3></div>
        <div className="mix-scopes" role="group" aria-label="Mix scope">{SCOPES.map(item => <button type="button" key={item.value} aria-pressed={scope === item.value} disabled={Boolean(busy) || (!canMetadata && item.value !== "LIBRARY_ONLY")}
          onClick={() => { setScope(item.value); setDirty(true); setLocks(new Set()); }}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>
        <label className="mix-slider-label" htmlFor={sliderId}>Adventurousness <strong>{Math.round(adventure * 100)}%</strong></label>
        <input className="mix-adventure" id={sliderId} type="range" min={0} max={1} step={0.05} value={adventure} aria-valuetext={`${Math.round(adventure * 100)} percent adventurous`} disabled={Boolean(busy)} onChange={event => { setAdventure(Number(event.target.value)); setDirty(true); }} />
        <div className="mix-slider-ends"><span>Close to home</span><span>Into the unknown</span></div>
        <p className="mix-policy-copy">{canMetadata ? "Similarity comes from Last.fm listening patterns. Discovery entries are metadata with short previews when available; import them for full audio." : "External lookups are disabled. This mix uses cached similarities and your local library."}</p>
        <button type="button" className="mix-primary" disabled={Boolean(busy) || !seeds.length} onClick={() => { void generate(); }}>{busy || (preview ? dirty ? "Update preview" : "Refresh mix" : "Build my mix")}</button>
      </section>
      <section className="similar-mix-preview" aria-label="Mix preview" aria-busy={Boolean(busy)}>
        <div className="mix-step"><span>03</span><h3>Your next 25</h3><small>{preview ? `${preview.tracks.length} songs` : "PREVIEW"}</small></div>
        <p className="mix-preview-hint">Lock the keepers. Swap anything that doesn’t fit.</p>
        {dirty && preview && <p className="mix-message" role="status">Settings changed. Update the preview before saving or queueing.</p>}
        {error && <p className="mix-error" role="alert">{error}</p>}{notice && <p className="mix-message" role="status">{notice}</p>}
        {preview?.warnings.map(warning => <p className="mix-message" key={warning}>{warning}</p>)}
        {!preview ? <div className="mix-preview-empty"><span aria-hidden="true">◎</span><h3>A connection waiting to happen</h3><p>Choose up to five songs and build a mix around their sound.</p></div> : <ol className="mix-candidates">{preview.tracks.map((row, index) => <li key={row.id} className={locks.has(row.id) ? "is-locked" : ""}>
          <span className="mix-track-number">{String(index + 1).padStart(2, "0")}</span><div className="mix-track-copy"><strong>{row.title}</strong><span>{row.artist}</span><small title={row.reason}>{row.inLibrary ? "IN YOUR LIBRARY" : "DISCOVERY"} · {row.reason}</small></div>
          <div className="mix-track-actions"><button type="button" aria-label={`Preview ${row.title}`} disabled={Boolean(previewing)} onClick={() => { void listen(row); }}>{previewing === row.id ? "…" : "▶"}</button>
            <button type="button" aria-label={`${locks.has(row.id) ? "Unlock" : "Lock"} ${row.title}`} aria-pressed={locks.has(row.id)} disabled={Boolean(busy)} onClick={() => setLocks(currentLocks => { const next = new Set(currentLocks); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}>{locks.has(row.id) ? "◆" : "◇"}</button>
            <button type="button" aria-label={`Swap ${row.title}`} disabled={Boolean(busy) || dirty || locks.has(row.id)} onClick={() => { void generate(row.id); }}>↻</button></div></li>)}</ol>}
        {audition && <div className="mix-audition"><span>PREVIEW / {audition.title}</span><audio key={audition.url} ref={audio} src={audition.url} controls preload="none" aria-label={`Audio preview: ${audition.title}`}
          onPlay={() => { if (current.current.player?.isPlaying) current.current.player.togglePlay(); }} onTimeUpdate={event => { if (event.currentTarget.currentTime >= 30) event.currentTarget.pause(); }}
          onError={() => setError("This audio preview could not be played. Try another song or check your connection.")} /></div>}
      </section></div>
      <footer className="mix-builder-footer"><label>Playlist name<input value={name} maxLength={200} disabled={Boolean(busy)} onChange={event => setName(event.target.value)} /></label>
        {savedId ? <Link to={`/playlist/${encodeURIComponent(savedId)}`} onClick={onClose}>Open saved playlist ↗</Link> : <button type="button" disabled={Boolean(busy) || dirty || !preview?.tracks.length || !name.trim()} onClick={() => { void save(); }}>Save as playlist</button>}
        <button type="button" className="mix-primary" disabled={Boolean(busy) || dirty || !preview?.tracks.length} onClick={() => { void queue(); }}>Add to queue</button></footer>
    </div></div>, document.body);
}

/** Account changes remount the entire session before private preview state can render. */
export default function MixBuilderModal(props: MixBuilderModalProps) {
  const owner = useAuth()?.session?.id;
  return props.open && owner ? <Builder key={owner} {...props} owner={String(owner)} /> : null;
}
