import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { savedDiscoveryItem, useSavedDiscoveries, type SavedDiscovery } from "../hooks/useSavedDiscoveries";
import { externalActionKey, externalActions, useExternalAction } from "../services/externalActions";
import { externalDiscoveryService } from "../services/externalDiscovery";
import { getAlbum } from "../api/musicdeck";
import { toUnifiedTrack } from "../types/track";
import { usePlayer, type Song } from "../context/PlayerContext";
import { DiscoveryArtwork } from "./DiscoveryCards";
import { usePrivacy } from "../context/PrivacyContext";
import LightHero from "./Layout/LightHero";
import "../styles/saved-discoveries.css";

function canSelect(item: SavedDiscovery) {
  const live = externalActions.getSnapshot(externalActionKey(item.type, savedDiscoveryItem(item).id)).state;
  return !item.inLibrary && !["QUEUED", "IMPORTING", "IN_LIBRARY"].includes(item.status || "")
    && !["QUEUED", "IMPORTING", "IN_LIBRARY"].includes(live);
}

function SavedCard({ item, selected, onSelect, onRemove, onStatusChange, selectionLocked }: {
  item: SavedDiscovery; selected: boolean; onSelect(): void; onRemove(): Promise<boolean>;
  onStatusChange(): Promise<void>; selectionLocked: boolean;
}) {
  const metadata = savedDiscoveryItem(item);
  const { snapshot, start } = useExternalAction(item.type, metadata);
  const { canImport, canMetadata } = usePrivacy();
  const player = usePlayer();
  const [removing, setRemoving] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const previewTracks = useRef<Song[] | null>(null);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current++; }, []);
  useEffect(() => {
    if (snapshot.state !== "IDLE") void onStatusChange();
  }, [snapshot.state, onStatusChange]);
  const state = item.inLibrary || snapshot.state === "IN_LIBRARY" ? "IN_LIBRARY"
    : snapshot.state !== "IDLE" ? snapshot.state : item.status || "IDLE";
  const importing = state === "QUEUED" || state === "IMPORTING";
  const inLibrary = state === "IN_LIBRARY";
  const activePreview = Boolean(player?.isPreview && player.currentSong
    && previewIds.includes(String(player.currentSong.id)));
  const playingPreview = activePreview && player?.isPlaying;
  const albumUrl = `/album/${encodeURIComponent(metadata.id)}`;

  async function listen() {
    if (loadingPreview) return;
    if (activePreview) { player?.togglePlay(); return; }
    const operation = ++previewRequest.current;
    setLoadingPreview(true);
    setPreviewError("");
    try {
      if (!player) throw new Error("The player is unavailable. Try reloading MusicDeck.");
      if (!canMetadata) throw new Error("External previews are disabled in your privacy settings.");
      let tracks = previewTracks.current;
      if (!tracks) {
        if (item.type === "album") {
          const details = await getAlbum(metadata.id);
          tracks = (details.song || []).filter((song: Song) => song.previewUrl && !song.isDownloaded)
            .map((song: Song) => toUnifiedTrack(song, "saved-discoveries"));
        } else {
          const track = toUnifiedTrack(metadata, "saved-discoveries");
          const resolved = await externalDiscoveryService.hydrateMissingPreviews([track]);
          tracks = resolved.filter((song: Song) => song.previewUrl)
            .map((song: Song) => toUnifiedTrack(song, "saved-discoveries"));
        }
      }
      if (operation !== previewRequest.current) return;
      if (!tracks?.length) throw new Error(item.type === "album"
        ? "No previews are available for this album." : "Preview unavailable for this track");
      previewTracks.current = tracks;
      setPreviewIds(tracks.map((track) => String(track.id)));
      if (item.type === "album") player.playQueue(tracks, 0);
      else player.playSong(tracks[0]);
    } catch (failure) {
      if (operation === previewRequest.current) setPreviewError(failure instanceof Error ? failure.message : "Could not load this preview. Try again.");
    } finally {
      if (operation === previewRequest.current) setLoadingPreview(false);
    }
  }

  return <article className={`saved-discovery-card${selected ? " is-selected" : ""}`} data-state={state}>
    <div className="saved-discovery-artwork">
      {item.type === "album" ? <Link to={albumUrl} aria-label={`Open ${item.title}`}>
        <DiscoveryArtwork item={metadata} />
      </Link> : <DiscoveryArtwork item={metadata} />}
      <span className="saved-discovery-kind">{item.type === "album" ? "Album" : "Track"}</span>
      {canImport && !inLibrary && <label className="saved-discovery-select">
        <input type="checkbox" checked={selected} disabled={importing || selectionLocked}
          onChange={onSelect} aria-label={`Select ${item.title}`} />
      </label>}
      <button type="button" className="saved-discovery-listen" disabled={loadingPreview || !canMetadata}
        aria-label={`${playingPreview ? "Pause preview" : "Listen to preview"}: ${item.title}`}
        aria-busy={loadingPreview || undefined} aria-pressed={Boolean(playingPreview)} onClick={() => { void listen(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{playingPreview
          ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M8 5v14l11-7z" />}</svg>
        <span>{loadingPreview ? "Loading…" : playingPreview ? "Pause" : "Listen"}</span>
      </button>
    </div>
    <div className="saved-discovery-copy">
      <span className="saved-discovery-provider">{item.provider === "deezer" ? "Deezer" : "iTunes"}</span>
      <h2>{item.type === "album" ? <Link to={albumUrl}>{item.title}</Link> : item.title}</h2>
      <p>{item.artist}</p>
      <small>Saved {new Date(item.created_at).toLocaleDateString()}</small>
    </div>
    <div className="saved-discovery-actions">
      {canImport && <button type="button" className="saved-discovery-import" disabled={importing || inLibrary || selectionLocked}
        onClick={() => { void start(); }}>
        {inLibrary ? "In Library" : state === "QUEUED" ? "Queued" : importing ? "Importing…" : state === "FAILED" ? "Retry import" : "Import to Library"}
      </button>}
      <button type="button" className="saved-discovery-remove" disabled={removing || selectionLocked}
        aria-label={`Remove from Saved: ${item.title}`} title="Remove from Saved Discoveries"
        onClick={async () => { setRemoving(true); await onRemove(); setRemoving(false); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
      </button>
    </div>
    {previewError && <p className="saved-discovery-status" role="status">{previewError}</p>}
    {!canMetadata && <p className="saved-discovery-status">External previews are disabled in privacy settings.</p>}
    {(snapshot.message || item.error) && <p className="saved-discovery-status"
      role={state === "FAILED" ? "alert" : "status"}>{snapshot.message || item.error}</p>}
  </article>;
}

/** A preview-first collection. Imports retain the acquisition service's permissions,
 * duplicate protection and per-item progress; the server removes imported saves. */
export default function SavedDiscoveriesView() {
  const { canImport } = usePrivacy();
  const saved = useSavedDiscoveries();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [visibleCount, setVisibleCount] = useState(40);
  const generation = useRef(0);
  const { refresh, remove, enabled, items } = saved;
  const selectable = items.filter(canSelect);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id));

  useEffect(() => {
    if (!enabled) return;
    generation.current += 1;
    setImporting(false);
    setSelected(new Set());
    setNotice("");
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 5000);
    return () => { generation.current += 1; window.clearInterval(timer); };
  }, [enabled, refresh]);

  useEffect(() => {
    const eligibleIds = new Set(items.filter(canSelect).map((item) => item.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => eligibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [items]);

  async function importSelected() {
    if (!canImport || importing) return;
    const operation = generation.current;
    setImporting(true);
    setNotice("");
    let queued = 0;
    let failed = 0;
    for (const item of items.filter((entry) => selected.has(entry.id) && canSelect(entry))) {
      if (operation !== generation.current) return;
      const metadata = savedDiscoveryItem(item);
      const result = await (item.type === "album"
        ? externalActions.saveExternalAlbum(metadata) : externalActions.importExternalTrack(metadata));
      if (operation !== generation.current) return;
      if (result.state === "FAILED") failed += 1;
      else {
        queued += 1;
        setSelected((previous) => { const next = new Set(previous); next.delete(item.id); return next; });
      }
    }
    setNotice(`${queued} ${queued === 1 ? "item" : "items"} submitted for import.${failed ? ` ${failed} could not be queued; check the item messages and retry.` : ""}`);
    setImporting(false);
    void refresh();
  }

  return <div className="saved-discoveries">
    <div className="page-hero-gradient">
      <LightHero eyebrow="YOUR COLLECTION" title="Saved Discoveries"
        subtitle="Listen to a preview. Bring your favourites into your library.">
        <Link to="/explore" className="saved-discovery-explore">Back to Discover</Link>
      </LightHero>
    </div>
    <div className="saved-discoveries-toolbar">
      <div className="saved-discoveries-summary">
        <p><strong>{items.length}</strong> {items.length === 1 ? "saved discovery" : "saved discoveries"}
          {selected.size > 0 && <span className="saved-discoveries-selection-count"> · {selected.size} selected</span>}</p>
        <span className="saved-discovery-note">Imported items are removed from this list automatically.</span>
      </div>
      {canImport && <div className="saved-discoveries-bulk-actions">
        <button type="button" disabled={!selectable.length || importing} aria-controls="saved-discoveries-grid"
          onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id)))}>
          {allSelected ? "Clear selection" : "Select all"}
        </button>
        <button type="button" className="saved-discoveries-import-selected" disabled={!selected.size || importing}
          onClick={() => { void importSelected(); }}>
          {importing ? "Queueing…" : `Import Selected${selected.size ? ` (${selected.size})` : ""}`}
        </button>
      </div>}
    </div>
    {saved.error && <div className="saved-discoveries-message" role="alert">{saved.error}
      <button type="button" onClick={() => { void refresh(); }}>Retry</button>
    </div>}
    {saved.warning && <p className="saved-discoveries-message" role="status">{saved.warning}</p>}
    {notice && <p className="saved-discoveries-message" role="status">{notice}</p>}
    {saved.loading && <p role="status">Loading saved discoveries…</p>}
    {!saved.loading && !items.length && !saved.error && <section className="saved-discoveries-empty">
      <span aria-hidden="true">YOUR NEXT FAVOURITE</span>
      <h2>A place for your next favorites.</h2>
      <p>Save tracks and albums from Discover, listen to their previews, and import the ones you love.</p>
      <Link to="/explore">Discover music</Link>
    </section>}
    <div className="saved-discoveries-grid" id="saved-discoveries-grid">
      {items.slice(0, visibleCount).map((item) => <SavedCard key={item.id} item={item} selected={selected.has(item.id)}
        selectionLocked={importing} onStatusChange={refresh}
        onSelect={() => setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
          return next;
        })} onRemove={() => remove(item.id)} />)}
    </div>
    {items.length > visibleCount && <button type="button" className="saved-discoveries-more"
      onClick={() => setVisibleCount((count) => count + 40)}>Show more saved discoveries</button>}
  </div>;
}
