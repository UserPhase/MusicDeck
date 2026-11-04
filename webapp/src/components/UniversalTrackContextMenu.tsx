import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import TrackTasteOption from "./settings/TrackTasteOption";
import { getPlaylists } from "../api/playlists";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { isLibraryActionTrack, useTrackActions, type TrackActionName } from "../hooks/useTrackActions";
import type { Track } from "./TrackRow";
import RecommendationMenuItems from "./RecommendationMenuItems";

export interface UniversalTrackContextMenuProps {
  song: Track; targets?: readonly Track[]; targetCount?: number; resolveTargets?(): Promise<Track[]>;
  triggerRef?: RefObject<HTMLButtonElement | null>; anchorPoint?: { x: number; y: number } | null;
  onRequestClose?(): void; actionsDisabled?: boolean; children?: ReactNode;
  onActionError?(message: string): void;
  downloadQuality?: string; isServerSynced?: boolean; offlineStatus?: string; offlineError?: string | null;
  onOfflineDownload?(event: MouseEvent<HTMLButtonElement>): void | Promise<void>;
  onSpotdlDownload?(song: Track): void | Promise<void>;
  onAddToQueue?(song: Track): void | Promise<void>;
}
export default function UniversalTrackContextMenu({ song, targets, targetCount, resolveTargets, triggerRef, anchorPoint,
  onRequestClose, actionsDisabled = false, children, downloadQuality = "320kbps", offlineStatus, offlineError,
  onOfflineDownload, onAddToQueue, onSpotdlDownload, onActionError }: UniversalTrackContextMenuProps) {
  const actions = useTrackActions(targets || song);
  const menuId = useId();
  const count = targetCount ?? targets?.length ?? 1;
  const batch = count > 1;
  const deletion = useServerDeletion();
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onRequestClose); close.current = onRequestClose;
  const report = useRef(onActionError); report.current = onActionError;
  const lastFailure = useRef("");
  const active = useRef(true);
  const operation = useRef(false);
  const [position, setPosition] = useState<CSSProperties>({ top: 12, left: 12, visibility: "hidden" });
  const [choosing, setChoosing] = useState(false);
  const [destinations, setDestinations] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    const update = () => {
      const rect = triggerRef?.current?.getBoundingClientRect();
      if (!rect && !anchorPoint) return;
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      const ox = viewport?.offsetLeft || 0, oy = viewport?.offsetTop || 0;
      const menuWidth = Math.min(menu.current?.offsetWidth || 264, width - 24);
      const menuHeight = Math.min(menu.current?.offsetHeight || 0, height - 24);
      setPosition({ visibility: "visible", left: Math.max(ox + 12, Math.min(anchorPoint?.x ?? (rect!.right - menuWidth), ox + width - menuWidth - 12)),
        top: Math.max(oy + 12, Math.min(anchorPoint?.y ?? (rect!.bottom + 8), oy + height - menuHeight - 12)),
        maxHeight: height - 24, maxWidth: width - 24 });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (menu.current) observer?.observe(menu.current);
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update); window.visualViewport?.addEventListener("scroll", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); };
  }, [triggerRef, anchorPoint]);
  useEffect(() => {
    active.current = true;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !triggerRef?.current?.contains(event.target)) close.current?.();
    };
    const navigate = () => close.current?.();
    const anotherMenu = (event: Event) => { if ((event as CustomEvent).detail !== menuId) close.current?.(); };
    window.dispatchEvent(new CustomEvent("musicdeck:track-menu-open", { detail: menuId }));
    window.addEventListener("musicdeck:track-menu-open", anotherMenu);
    document.addEventListener("pointerdown", outside, true); window.addEventListener("musicdeck:navigation", navigate);
    return () => {
      active.current = false;
      if (lastFailure.current) report.current?.(lastFailure.current);
      document.removeEventListener("pointerdown", outside, true); window.removeEventListener("musicdeck:navigation", navigate); window.removeEventListener("musicdeck:track-menu-open", anotherMenu);
    };
  }, [triggerRef, menuId]);
  useEffect(() => {
    if (!choosing) return;
    let cancelled = false; setLoading(true); setError("");
    getPlaylists().then((items) => { if (!cancelled) setDestinations(items); })
      .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load playlists."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [choosing, attempt]);
  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close.current?.(); triggerRef?.current?.focus({ preventScroll: true }); return;
    }
    if (event.key === "Tab") { close.current?.(); return; }
    if (event.target instanceof Element && event.target.closest("input,select,textarea")) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') || [])]
      .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }
  async function run(name: TrackActionName, playlistId?: string, event?: MouseEvent<HTMLButtonElement>) {
    if (operation.current || actionsDisabled) return;
    operation.current = true; lastFailure.current = ""; setBusy(true); setError(""); setNotice(""); report.current?.("");
    try {
      const selected = resolveTargets ? await resolveTargets() : targets || [song];
      if (!active.current) return;
      // Legacy standalone rows can still supply device-download callbacks. Collection rows always use the controller.
      if (!batch && !resolveTargets && name === "downloadSelected" && onOfflineDownload && actions.allLibrary && event) await onOfflineDownload(event);
      else if (!batch && !resolveTargets && name === "addToQueue" && onAddToQueue) await onAddToQueue(song);
      else if (!batch && !resolveTargets && name === "downloadSelected" && onSpotdlDownload && !actions.allLibrary) await onSpotdlDownload(song);
      else {
        const result = await actions.execute(name, selected, playlistId);
        if (active.current) setNotice(result.queued || result.imported ? [result.queued ? `${result.queued} device downloads queued.` : "",
          result.imported ? `${result.imported} server imports queued. Save to your device after import finishes.` : ""].filter(Boolean).join(" ")
          : name === "saveForLater" ? "Saved for later. Library tracks are in the Saved for Later playlist; discoveries are in Saved." : `${result.completed} ${result.completed === 1 ? "track" : "tracks"} updated.`);
      }
      if (active.current && !["downloadSelected", "toggleFavorite", "saveForLater"].includes(name)) {
        close.current?.(); triggerRef?.current?.focus({ preventScroll: true });
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "The action failed. Please retry.";
      lastFailure.current = message;
      if (active.current) setError(message); else report.current?.(message);
    } finally { operation.current = false; if (active.current) setBusy(false); }
  }
  const disabled = actionsDisabled || busy || Boolean(actions.busy);
  const unresolved = Boolean(resolveTargets) && (!targets?.length || count > targets.length);
  const mayBeLibrary = unresolved && actions.tracks.every(isLibraryActionTrack);
  const libraryOnly = actions.allLibrary || mayBeLibrary;
  const downloadLabel = batch || unresolved ? "Download Selected" : offlineStatus === "downloading" ? "Downloading to Device"
    : actions.allLibrary ? offlineStatus === "needs-redownload" ? "Re-download to Device" : "Download to Device" : "Download via spotDL";
  const quality = downloadQuality === "lossless" ? "Lossless" : downloadQuality.replace("kbps", " kbps");
  function item(name: TrackActionName, label: string, icon: string, hint: string, unavailable = false) {
    return <button type="button" role="menuitem" className="playlist-menu-item track-context-menu-item" disabled={disabled || unavailable}
      aria-label={label} aria-describedby={`${menuId}-${name}-hint`}
      onClick={(event) => { void run(name, undefined, event); }}>
      <span className="track-context-menu-icon" aria-hidden="true">{icon}</span><span className="track-context-menu-copy"><span>{label}</span><small id={`${menuId}-${name}-hint`}>{hint}</small></span>
    </button>;
  }
  return createPortal(<div ref={menu} role="menu" className="glass-dropdown playlist-menu track-context-menu track-context-menu-portal universal-track-context-menu"
    data-track-selection-menu="" aria-label={batch ? `Actions for ${count} selected tracks` : `Actions for ${song.title || "track"}`}
    aria-busy={disabled || undefined} style={position} onKeyDown={keyDown}
    onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="playlist-menu-title">{batch ? `${count} selected tracks` : "Track actions"}</div>
    {item("addToQueue", "Add to Queue", "≡", "Play after your current queue")}
    {item("playNext", "Play Next", "↳", "Keep the selected track order")}
    <button type="button" role="menuitem" className="playlist-menu-item track-context-menu-item" disabled={disabled || !libraryOnly}
      aria-label="Add to Playlist..." aria-describedby={`${menuId}-playlist-hint`}
      aria-expanded={choosing} onClick={() => setChoosing(!choosing)}><span className="track-context-menu-icon" aria-hidden="true">＋</span>
      <span className="track-context-menu-copy"><span>Add to Playlist…</span><small id={`${menuId}-playlist-hint`}>{libraryOnly ? "Choose a destination playlist" : "Import to your library first"}</small></span></button>
    {choosing && <div role="group" aria-label="Destination playlist">
      {loading ? <p role="status" className="playlist-menu-empty">Loading playlists…</p> : destinations.length ? destinations.map((playlist) =>
        <button key={playlist.id} type="button" role="menuitem" disabled={disabled} className="playlist-menu-item"
          onClick={() => { void run("addToPlaylist", String(playlist.id)); }}>{playlist.name || "Untitled playlist"}</button>)
        : <p className="playlist-menu-empty">No playlists yet. Create a playlist first.</p>}
      {error && <button type="button" role="menuitem" className="playlist-menu-item" disabled={disabled} onClick={() => setAttempt(attempt + 1)}>Retry playlists</button>}
    </div>}
    {item("saveForLater", "Save for Later", "◇", "Library tracks go to Saved for Later; discoveries stay in Saved")}
    <div className="track-context-menu-divider" aria-hidden="true" />
    <button type="button" role={batch || unresolved ? "menuitem" : "menuitemcheckbox"} className="playlist-menu-item track-context-menu-item" aria-checked={batch || unresolved ? undefined : actions.allFavorite}
      disabled={disabled || !libraryOnly} onClick={() => { void run("toggleFavorite"); }}>
      <span className="track-context-menu-icon" aria-hidden="true">{actions.allFavorite ? "♥" : "♡"}</span>
      <span className="track-context-menu-copy"><span>{batch || unresolved ? "Toggle Favorites" : actions.allFavorite ? "Remove from Liked Songs" : "Save to Liked Songs"}</span><small>{libraryOnly ? "Like tracks" : "Available after the track is in your library"}</small></span></button>
    {item("hideFromRecommendations", "Hide from recommendations", "⊘", "Stop suggesting these tracks")}
    {item("downloadSelected", downloadLabel, "↓", offlineError || (offlineStatus === "needs-redownload" ? "Offline copy is missing or damaged"
      : actions.allLibrary ? `${quality}${offlineStatus === "downloaded" ? " • Downloaded" : ""}` : "External tracks import to your server; library tracks save on this device"),
      (!actions.canDownload && !mayBeLibrary) || (!batch && ["downloaded", "downloading"].includes(offlineStatus || "")))}
    {!batch && actions.allLibrary && item("startRadio", "Start radio", "◉", "Play a station based on this track")}
    {!batch && <RecommendationMenuItems song={song} onRequestClose={onRequestClose} excludeHide disabled={disabled} allowRadio={actions.allLibrary} />}
    {!batch && !unresolved && <TrackTasteOption tracks={[song]} disabled={disabled} />}
    {children && <><div className="track-context-menu-divider" aria-hidden="true" />{children}</>}
    {!batch && deletion?.canDelete && actions.allLibrary && <button type="button" role="menuitem" disabled={disabled} className="playlist-menu-item server-delete-menu-item"
      onClick={() => { deletion.openTrack(song); close.current?.(); }}>Delete from Server</button>}
    {(error || actions.error) && <p role="alert" className="track-context-menu-error">{error || actions.error}</p>}
    {notice && <p role="status" className="track-action-notice">{notice}</p>}
  </div>, document.body);
}
