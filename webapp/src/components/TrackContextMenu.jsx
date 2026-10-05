import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { createAcquisition } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { useServerDeletion } from "../context/ServerDeletionContext";
import TrackLikeButton from "./TrackLikeButton";

function qualityLabel(quality) {
  return quality === "lossless"
    ? "Lossless"
    : String(quality || "320kbps").replace("kbps", " kbps");
}

function acquisitionPayload(song) {
  return {
    result: {
      id: song.id,
      type: "track",
      title: song.title || "",
      artist: song.artist || song.artistName || "",
      album: song.album || song.albumName || "",
      provider: song.provider || "external",
      source: song.source || { kind: "external", count: 1 },
      metadata: {
        ...(song.metadata || {}),
        spotifyTrackUrl: song.metadata?.spotifyTrackUrl || song.spotifyUrl,
        spotifyTrackId: song.metadata?.spotifyTrackId,
      },
    },
    trackId: song.id,
    sourceProvider: "spotdl",
  };
}

function useMenuPosition(triggerRef, menuRef) {
  const [position, setPosition] = useState({ top: 12, right: 12, visibility: "hidden" });

  useLayoutEffect(() => {
    function updatePosition() {
      const trigger = triggerRef?.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = menuRef.current?.offsetWidth || 240;
      const menuHeight = menuRef.current?.offsetHeight || 0;
      const left = Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12));
      const top = Math.min(rect.bottom + 8, window.innerHeight - menuHeight - 12);
      setPosition({
        top: Math.max(12, top),
        right: window.innerWidth - left - menuWidth,
        visibility: "visible",
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuRef, triggerRef]);

  return position;
}

function TrackContextMenu({
  song,
  downloadQuality,
  isServerSynced,
  offlineStatus,
  onOfflineDownload,
  onSpotdlDownload,
  onRequestClose,
  triggerRef,
  children,
}) {
  const isAdmin = useAuth()?.session?.role === "admin";
  const deletion = useServerDeletion();
  const { addToQueue } = usePlayer();
  const menuRef = useRef(null);
  const [isAcquiring, setIsAcquiring] = useState(false);
  const position = useMenuPosition(triggerRef, menuRef);
  const isDownloading = offlineStatus === "downloading";
  const isDownloaded = offlineStatus === "downloaded";
  const isExternal = !isServerSynced && Boolean(
    song.external || song.sample || song.source?.kind === "external" ||
    ["external", "deezer", "itunes"].includes(String(song.provider || "").toLowerCase())
  );
  const canLike = isServerSynced && !isExternal;
  const downloadSubtitle = isServerSynced
    ? `${qualityLabel(downloadQuality)}${isDownloaded ? " • Downloaded" : ""}`
    : `${qualityLabel(downloadQuality)} • Save to server first`;

  useEffect(() => {
    const menu = menuRef.current;
    const firstItem = menu?.querySelector('[role="menuitem"], [role="menuitemcheckbox"]');
    firstItem?.focus();

    function closeOnOutsidePress(event) {
      if (!menuRef.current?.contains(event.target) && !triggerRef?.current?.contains(event.target)) {
        onRequestClose?.();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [onRequestClose, triggerRef]);

  function handleKeyDown(event) {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]') || [])]
      .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
    const currentIndex = items.indexOf(document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      onRequestClose?.();
      triggerRef?.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  }

  async function downloadWithSpotdl() {
    if (isAcquiring) return;
    setIsAcquiring(true);
    try {
      if (onSpotdlDownload) await onSpotdlDownload(song);
      else await createAcquisition(acquisitionPayload(song));
      onRequestClose?.();
    } catch (error) {
      setIsAcquiring(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className="playlist-menu track-context-menu track-context-menu-portal"
      role="menu"
      aria-label={`Actions for ${song.title || "track"}`}
      style={position}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="playlist-menu-title">Track actions</div>

      <button type="button" role="menuitem" className="playlist-menu-item track-context-menu-item" onClick={() => { addToQueue(song); onRequestClose?.(); }}>
        <span className="track-context-menu-icon" aria-hidden="true">≡</span>
        <span className="track-context-menu-copy"><span>Add to Queue</span><small>Play after your current queue</small></span>
      </button>

      {children && <><div className="track-context-menu-divider" aria-hidden="true" />{children}</>}

      <div className="track-context-menu-divider" aria-hidden="true" />
      <TrackLikeButton song={song} variant="menu" disabled={!canLike} disabledHint="Available after the track is in your library" />

      {isExternal && (
        <button type="button" role="menuitem" className="playlist-menu-item track-context-menu-item" disabled={isAcquiring} onClick={downloadWithSpotdl}>
          <span className="track-context-menu-icon" aria-hidden="true">{isAcquiring ? <span className="track-offline-spinner" /> : "⇩"}</span>
          <span className="track-context-menu-copy"><span>{isAcquiring ? "Adding to download queue" : "Download via spotDL"}</span><small>Save to your server library</small></span>
        </button>
      )}

      <button type="button" role="menuitem" className={`playlist-menu-item track-context-menu-item${isDownloaded ? " is-downloaded" : ""}`} disabled={!isServerSynced || isDownloading || isDownloaded} onClick={onOfflineDownload}>
        <span className="track-context-menu-icon" aria-hidden="true">{isDownloading ? <span className="track-offline-spinner" /> : "⇩"}</span>
        <span className="track-context-menu-copy"><span>{isDownloading ? "Downloading to Device" : "Download to Device"}</span><small>{downloadSubtitle}</small></span>
      </button>

      {isAdmin && deletion && isServerSynced && song.id && !String(song.id).startsWith("external_") && <>
        <div className="track-context-menu-divider" aria-hidden="true" />
        <button type="button" role="menuitem" className="playlist-menu-item server-delete-menu-item" onClick={() => deletion.openTrack(song)}><span aria-hidden="true">🗑</span><span>Delete from Server</span></button>
      </>}
    </div>,
    document.body
  );
}

export default TrackContextMenu;
