import { isValidElement, memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent, KeyboardEvent, ReactNode, Ref, TouchEvent as ReactTouchEvent } from "react";
import type { SelectionModifiers } from "../hooks/useTrackSelection";
import { Link } from "react-router-dom";

import { useTrackPlayer } from "../context/PlayerItemState";
import {
  downloadToDevice, isDeviceDownloadPending, OfflineDownloadError, subscribeDeviceDownload,
} from "../utils/downloadManager";
import { offlineAuditor, offlineDisplayStatus, useOfflineAudit } from "../services/storage/OfflineAuditor";
import { formatDuration } from "../utils/formatDuration";

import AvailabilityHint from "./AvailabilityHint";
import SourceIndicator from "./SourceIndicator";
import InLibraryBadge from "./InLibraryBadge";
import UniversalTrackContextMenu from "./UniversalTrackContextMenu";
import { useTrackActionScope } from "./TrackActionScope";
import TrackDownloadButton from "./TrackDownloadButton";
import TrackPlaybackIndicator from "./TrackPlaybackIndicator";
import { DiscoveryArtwork } from "./DiscoveryCards";
import { useServerDeletion } from "../context/ServerDeletionContext";
import TrackArtistLinks, { type TrackArtistCredit } from "./TrackArtistLinks";
import { toAlbumRouteIdFromApiId } from "../utils/idResolver";
import SaveDiscoveryButton from "./SaveDiscoveryButton";
import { ContributorAvatar } from "./playlists/PlaylistShareModal";
import { EditionBadges } from "./common/EditionBadges";
import PlaylistSearchHighlight from "./playlists/PlaylistSearchHighlight";


export interface Track {
  addedBy?: { id: string; displayName: string; avatarUrl: string | null } | null;
  showContributor?: boolean;
  id: string | number;
  title?: string;
  artist?: string;
  album?: string;
  artistId?: string | null;
  artistCredits?: TrackArtistCredit[];
  albumId?: string | null;
  duration?: number | null;
  playlistAddedAt?: string;
  isDownloaded?: boolean;
  provider?: string;
  inLibrary?: boolean;
  external?: boolean;
  sample?: boolean;
  source?: { kind?: string; count?: number };
  availability?: { libraryAvailable?: boolean; [key: string]: unknown };
  metadata?: { durationSeconds?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** Metadata and callbacks remain ordinary props. Playback and pending device
 * downloads are selected by song ID inside the row, not passed by the list. */
export interface TrackRowProps {
  song: Track;
  index: number;
  onPlay?: (song: Track, index: number) => void;
  showAlbum?: boolean;
  showDateAdded?: boolean;
  searchTokens?: readonly string[];
  showArtwork?: boolean;
  showSourceIndicator?: boolean;
  dimWhenUnavailable?: boolean;
  isDownloaded?: boolean;
  artistId?: string | null;
  albumId?: string | null;
  artistFallback?: string;
  albumFallback?: string;
  duration?: number | null;
  onToggleMenu?: (song: Track, event?: MouseEvent) => void;
  menu?: ReactNode;
  actionsRef?: Ref<HTMLDivElement>;
  onSpotdlDownload?: (song: Track) => void;
  className?: string;
  preserveDeleted?: boolean;
  selected?: boolean;
  selectionMode?: boolean;
  onLongPress?: (index: number) => void;
  onSelect?: (index: number, modifiers: SelectionModifiers) => void;
  reorderable?: boolean;
  editingDisabled?: boolean;
  onQueue?: (song: Track) => void;
  onDownload?: (song: Track) => void;
  action?: ReactNode;
  showImportAction?: boolean;
}

/** Links and controls keep their own click, text-editing and drag behavior. */
export function isTrackControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [contenteditable]:not([contenteditable="false"]), [data-no-track-drag], [data-track-selection-menu]',
  ));
}

const addedDateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
function TrackRow({
  song,
  index,
  onPlay,
  showAlbum = true,
  showDateAdded = false,
  searchTokens,
  showArtwork = false,
  showSourceIndicator = false,
  dimWhenUnavailable = false,
  isDownloaded,
  artistId,
  albumId,
  artistFallback,
  albumFallback,
  duration,
  onToggleMenu,
  menu,
  actionsRef,
  onSpotdlDownload,
  className = "",
  preserveDeleted = false,
  selected: selectedProp,
  onSelect: onSelectProp,
  selectionMode: modeProp,
  onLongPress,
  reorderable = false,
  editingDisabled: editingDisabledProp = false,
  onQueue,
  onDownload,
  action,
  showImportAction = true,
}: TrackRowProps) {
  const scope = useTrackActionScope();
  const editingDisabled = editingDisabledProp || Boolean(scope?.disabled);
  const selected = selectedProp ?? (scope ? scope.selection.selectedIds.has(scope.keyAt(index)) : undefined);
  const onSelect = onSelectProp ?? scope?.select;
  const selectionMode = modeProp ?? scope?.selectionMode ?? false;
  const legacySelection = scope ? scope.legacySelection : modeProp === undefined && Boolean(onSelect);
  const legacyMenu = !scope || scope.legacySelection;
  const deletion = useServerDeletion();
  const {
    isCurrentTrack,
    downloadQuality = "320kbps",
    isPlaying,
    togglePlay,
  } = useTrackPlayer(song.id);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number } | null>(null);
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const menuOpen = (legacyMenu && Boolean(menu)) || localMenuOpen;
  // Native dragstart may target the draggable ancestor rather than the link
  // beneath the pointer. Remember its origin without rendering on pointer moves.
  const dragMayStart = useRef(true);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touch = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(0);
  const consumeTouchClick = useRef(false);
  const lastTouch = useRef(0);
  const cancelHold = useCallback(() => { if (hold.current !== null) clearTimeout(hold.current); hold.current = null; }, []);
  useEffect(() => {
    const cancel = () => { if (touch.current) { consumeTouchClick.current = true; suppressClick.current = Math.max(suppressClick.current, Date.now() + 500); } cancelHold(); touch.current = null; };
    const multiTouch = (event: TouchEvent) => { if (event.touches.length !== 1) cancel(); };
    window.addEventListener("scroll", cancel, true); window.addEventListener("blur", cancel);
    window.addEventListener("touchstart", multiTouch, { capture: true, passive: true });
    document.addEventListener("visibilitychange", cancel); window.addEventListener("musicdeck:navigation", cancel);
    return () => { cancel(); window.removeEventListener("scroll", cancel, true); window.removeEventListener("blur", cancel);
      window.removeEventListener("touchstart", multiTouch, true);
      document.removeEventListener("visibilitychange", cancel); window.removeEventListener("musicdeck:navigation", cancel); };
  }, [cancelHold, song.id, index, editingDisabled, selectionMode, scope?.identity]);
  function touchStart(event: ReactTouchEvent) {
    cancelHold(); lastTouch.current = Date.now(); touch.current = null; suppressClick.current = 0; consumeTouchClick.current = false;
    if (event.touches.length !== 1 || isTrackControl(event.target) || editingDisabled || (!scope && !onLongPress)) return;
    const point = event.touches[0];
    touch.current = { id: point.identifier, x: point.clientX, y: point.clientY };
    dragMayStart.current = false;
    hold.current = setTimeout(() => {
      hold.current = null;
      if (!touch.current) return;
      suppressClick.current = Date.now() + 1500;
      consumeTouchClick.current = true;
      if (scope) scope.enter(index); else onLongPress?.(index);
    }, 500);
  }
  function touchMove(event: ReactTouchEvent) {
    const start = touch.current;
    const point = Array.from(event.touches).find((item) => item.identifier === start?.id);
    if (event.touches.length !== 1 || !start || !point || Math.hypot(point.clientX - start.x, point.clientY - start.y) > 10) {
      cancelHold(); touch.current = null;
      suppressClick.current = Math.max(suppressClick.current, Date.now() + 500);
      consumeTouchClick.current = true;
    }
  }

  const [offlineError, setOfflineError] = useState<string | null>(null);
  // The auditor verifies the stored file; a record alone never earns the "Downloaded" badge.
  const offlineAudit = useOfflineAudit(song.id);
  const isDownloadingToDevice = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeDeviceDownload(song.id, listener), [song.id]),
    useCallback(() => isDeviceDownloadPending(song.id), [song.id]),
    () => false,
  );
  const offlineStatus = offlineDisplayStatus(offlineAudit, isDownloadingToDevice);

  const resolvedDownloaded = typeof isDownloaded === "boolean"
    ? isDownloaded
    : typeof song.isDownloaded === "boolean"
      ? song.isDownloaded
      : Boolean(song.availability?.libraryAvailable) || song.source?.kind === "library";
  const resolvedAlbumId = albumId !== undefined ? albumId : song.albumId ?? (typeof song.metadata?.albumId === "string" ? song.metadata.albumId : null);
  const resolvedArtist = artistFallback ?? song.artist ?? "Unknown artist";
  const resolvedAlbum = albumFallback ?? song.album ?? "Unknown album";
  const resolvedDuration = duration ?? song.duration ?? song.metadata?.durationSeconds;
  const isServerSynced = resolvedDownloaded ||
    Boolean(song.availability?.libraryAvailable) ||
    song.source?.kind === "library";
  const isExternalTrack = !isServerSynced && Boolean(
    song.external || song.sample || song.source?.kind === "external" ||
    ["external", "deezer", "itunes"].includes(String(song.provider || "").toLowerCase())
  );

  async function handleOfflineDownload(event: MouseEvent) {
    event.stopPropagation();
    if (!isServerSynced || offlineStatus === "downloading" || offlineStatus === "downloaded") return;

    setOfflineError(null);
    try {
      await downloadToDevice(song.id, downloadQuality, song);
      // Re-verify the stored copy now, including when the manager reused an existing record.
      const result = await offlineAuditor.recordDownloaded(song.id);
      if (result.status !== "verified") {
        setOfflineError("The offline copy couldn't be verified. Try downloading it again.");
      }
    } catch (error) {
      console.error("Could not download track to this device:", error);
      setOfflineError(error instanceof OfflineDownloadError
        ? error.message
        : "The download failed. Try again.");
    }
  }

  function activateTrack() {
    if (isCurrentTrack) {
      togglePlay?.();
      return;
    }

    onPlay?.(song, index);
  }

  function handleRowClick(event: MouseEvent) {
    if (!isTrackControl(event.target)) {
      if (onSelect && (selectionMode || event.ctrlKey || event.metaKey || event.shiftKey || (legacySelection && Date.now() - lastTouch.current > 800))) {
        if (!editingDisabled) onSelect(index, selectionMode && !event.shiftKey ? { ctrlKey: true } : event);
      } else activateTrack();
    }
  }

  function handleRowKeyDown(event: KeyboardEvent) {
    if (event.target === event.currentTarget && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      event.stopPropagation();
      openContextMenu();
      return;
    }
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    if (onSelect && (event.key === " " || selectionMode)) {
      if (!editingDisabled) onSelect(index, selectionMode ? { ctrlKey: true } : event);
    } else activateTrack();
  }

  function openContextMenu(event?: MouseEvent) {
    if (onSelect && !selected && !editingDisabled) onSelect(index, {});
    setContextPoint(event ? { x: event.clientX, y: event.clientY } : null);
    if (legacyMenu && onToggleMenu) {
      if (!menu) onToggleMenu(song, event);
    } else setLocalMenuOpen(true);
  }

  function closeMenu() {
    setLocalMenuOpen(false);
    setContextPoint(null);
    if (legacyMenu && menu) onToggleMenu?.(song);
  }

  const playLabel = isCurrentTrack
    ? isPlaying
      ? `Pause ${song.title}`
      : `Resume ${song.title}`
    : !resolvedDownloaded && song.source?.kind === "external"
      ? `Play preview of ${song.title}`
      : `Play ${song.title}`;

  const rowClassName = [
    "track",
    showArtwork && "track-with-artwork",
    !showAlbum && "track-album-page",
    dimWhenUnavailable && !resolvedDownloaded && "track-not-downloaded",
    isCurrentTrack && "is-current-track",
    isCurrentTrack && isPlaying && "is-playing",
    selected && "is-selected",
    onSelect && "track-selectable",
    selectionMode && "track-selection-mode",
    reorderable && !editingDisabled && "track-reorderable",
    className,
  ].filter(Boolean).join(" ");
  const supplementalMenuContent = isValidElement<{ children?: ReactNode }>(menu) ? menu.props.children : menu;

  if (!preserveDeleted && deletion?.deletedTracks.has(String(song.id))) return null;

  return (
    <div
      className={rowClassName}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      tabIndex={0}
      draggable={reorderable && !editingDisabled}
      onPointerDownCapture={(event) => {
        dragMayStart.current = event.pointerType !== "touch" && !isTrackControl(event.target);
        if (event.pointerType === "mouse") { lastTouch.current = 0; suppressClick.current = 0; consumeTouchClick.current = false; }
      }}
      onTouchStart={touchStart} onTouchMove={touchMove}
      onTouchEnd={() => {
        cancelHold(); touch.current = null; lastTouch.current = Date.now();
        if (consumeTouchClick.current) suppressClick.current = Math.max(suppressClick.current, Date.now() + 800);
        consumeTouchClick.current = false;
      }} onTouchCancel={() => { cancelHold(); touch.current = null; suppressClick.current = Date.now() + 500; consumeTouchClick.current = false; }}
      onDragStart={reorderable ? (event) => {
        if (editingDisabled || !dragMayStart.current || isTrackControl(event.target)) event.preventDefault();
      } : undefined}
      aria-label={`${song.title || "Unknown title"} by ${resolvedArtist}`}
      title={typeof song.recommendationReason === "string" ? song.recommendationReason : undefined}
      onClick={handleRowClick}
      onClickCapture={(event) => {
        if (event.detail > 0 && Date.now() < suppressClick.current) { suppressClick.current = 0; event.preventDefault(); event.stopPropagation(); }
      }}
      onContextMenu={(event) => {
        // Artist/album links retain the browser's link context menu.
        if (event.target instanceof Element && event.target.closest("a, input, select, textarea, [contenteditable]")) return;
        event.preventDefault();
        event.stopPropagation();
        if (touch.current || Date.now() < suppressClick.current) return;
        openContextMenu(event);
      }}
      onDoubleClick={onSelect && legacySelection ? (event) => {
        if (!selectionMode && Date.now() - lastTouch.current > 800 && !isTrackControl(event.target)) activateTrack();
      } : undefined}
      onKeyDown={handleRowKeyDown}
    >
      <div className="track-number" role="cell">
        {selectionMode && <input type="checkbox" className="track-selection-checkbox" checked={Boolean(selected)} disabled={editingDisabled}
          aria-label={`Select ${song.title || "track"}`} onClick={(event) => event.stopPropagation()}
          onChange={() => onSelect?.(index, { ctrlKey: true })} />}
        {showArtwork ? <DiscoveryArtwork item={song} className="track-cover-art" /> : <TrackPlaybackIndicator
          index={index}
          isCurrentTrack={isCurrentTrack}
          isPlaying={isPlaying}
        />}

        <button
          type="button"
          className="track-play"
          onClick={(event) => {
            event.stopPropagation();
            activateTrack();
          }}
          aria-label={playLabel}
        >
          {isCurrentTrack && isPlaying ? "⏸" : "▶"}
        </button>
      </div>

      <div className="track-info" role="cell">
        <div className={`track-title ${song.provider === "external" && song.inLibrary ? "track-title-with-library-badge" : ""}${isExternalTrack ? " track-title--bookmark" : ""}`}>
          <span className="track-title-text"><PlaylistSearchHighlight text={song.title || "Unknown title"} tokens={searchTokens} /></span>
          {song.showContributor && song.addedBy && <ContributorAvatar user={song.addedBy} label={`Added by ${song.addedBy.displayName}`} />}
          {offlineAudit.status === "verified" && <span className="offline-available-badge" title="Verified audio saved on this device">↓ Offline</span>}
          <InLibraryBadge visible={song.provider === "external" && song.inLibrary} />
          <AvailabilityHint availability={song.availability} />
          {showSourceIndicator && <SourceIndicator source={song.source} />}
          <EditionBadges item={song} formatOnly />
          {isExternalTrack && <SaveDiscoveryButton compact kind="track" item={{ ...song, id: String(song.id) }} />}
        </div>

        <TrackArtistLinks song={song} className="track-artist" artistId={artistId}
          fallback={artistFallback} searchTokens={searchTokens} />
      </div>

      {showAlbum && (
        resolvedAlbumId ? (
          <div className="track-album" role="cell">
            <Link to={`/album/${encodeURIComponent(toAlbumRouteIdFromApiId(resolvedAlbumId))}`} className="track-album-link" onClick={(event) => event.stopPropagation()}>
              <PlaylistSearchHighlight text={resolvedAlbum} tokens={searchTokens} />
            </Link>
          </div>
        ) : (
          <div className="track-album" role="cell"><PlaylistSearchHighlight text={resolvedAlbum} tokens={searchTokens} /></div>
        )
      )}

      {!showAlbum && <div className="track-album" role="cell" aria-hidden="true" />}

      {showDateAdded ? <div className="track-date-added" role="cell">
        {song.playlistAddedAt && Number.isFinite(Date.parse(song.playlistAddedAt))
          ? <time dateTime={song.playlistAddedAt}>{addedDateFormat.format(new Date(song.playlistAddedAt))}</time>
          : <span aria-label="Date unavailable">—</span>}
      </div> : <div className="track-server-status" role="cell">
        {isServerSynced ? (
          <span className="track-server-placeholder" aria-hidden="true">{"\u2063"}</span>
        ) : isExternalTrack ? (
          <span className="track-server-placeholder" aria-hidden="true">{"\u2063"}</span>
        ) : (
          <TrackDownloadButton song={song} completedPlaceholder />
        )}
      </div>}

      <div className="track-duration" role="cell">
        {formatDuration(resolvedDuration)}
      </div>

      <div
        className="track-row-actions"
        role="cell"
        ref={actionsRef}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {action}
        {showDateAdded && !isExternalTrack && !isServerSynced && <TrackDownloadButton song={song} completedPlaceholder />}
        {isExternalTrack && showImportAction && (
          <TrackDownloadButton
            song={song}
            className="track-row-import"
            completedPlaceholder
          />
        )}

        <button
          type="button"
          className="track-menu"
          ref={menuTriggerRef}
          aria-label={`More options for ${song.title || "track"}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            if (menuOpen) closeMenu();
            else openContextMenu();
          }}
        >
          ⋯
        </button>

        {menuOpen && (
          <UniversalTrackContextMenu
            song={song}
            targets={scope && selected ? scope.selectedPreview : undefined}
            targetCount={scope && selected ? scope.selection.selectedCount : 1}
            resolveTargets={scope && selected ? scope.resolveSelected : undefined}
            downloadQuality={downloadQuality}
            isServerSynced={isServerSynced}
            offlineStatus={offlineStatus}
            offlineError={offlineError}
            onOfflineDownload={onDownload ? () => onDownload(song) : handleOfflineDownload}
            onSpotdlDownload={onSpotdlDownload}
            triggerRef={menuTriggerRef}
            anchorPoint={contextPoint}
            onAddToQueue={onQueue}
            actionsDisabled={editingDisabled}
            onRequestClose={closeMenu}
            onActionError={scope?.reportActionError}
          >
            {legacyMenu ? supplementalMenuContent : null}
          </UniversalTrackContextMenu>
        )}
      </div>
    </div>
  );
}


/** Check every prop, including callbacks, so memoization never retains stale
 * menu or playback closures. Reactive player fields are selected internally. */
export default memo(TrackRow, (previous, next) => {
  const keys = Object.keys(previous) as (keyof TrackRowProps)[];
  return keys.length === Object.keys(next).length && keys.every((key) => Object.is(previous[key], next[key]));
});
