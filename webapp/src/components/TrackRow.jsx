import { isValidElement, memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { usePlayer } from "../context/PlayerContext";
import { downloadToDevice, isDownloadedToDevice } from "../utils/downloadManager";
import { formatDuration } from "../utils/formatDuration";

import AvailabilityHint from "./AvailabilityHint";
import SourceIndicator from "./SourceIndicator";
import InLibraryBadge from "./InLibraryBadge";
import TrackContextMenu from "./TrackContextMenu";
import TrackDownloadButton from "./TrackDownloadButton";
import TrackPlaybackIndicator from "./TrackPlaybackIndicator";
import { DiscoveryArtwork } from "./DiscoveryCards";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { toArtistRouteIdFromApiId } from "../utils/idResolver";


function TrackRow({
  song,
  index,
  onPlay,
  showAlbum = true,
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
}) {
  const deletion = useServerDeletion();
  const {
    currentSong,
    downloadQuality = "320kbps",
    isPlaying,
    togglePlay,
  } = usePlayer();
  const menuTriggerRef = useRef(null);

  const [offlineStatus, setOfflineStatus] = useState("not-downloaded");

  const isCurrentTrack = Boolean(currentSong) &&
    String(currentSong.id) === String(song.id);
  const resolvedDownloaded = typeof isDownloaded === "boolean"
    ? isDownloaded
    : typeof song.isDownloaded === "boolean"
      ? song.isDownloaded
      : Boolean(song.availability?.libraryAvailable) || song.source?.kind === "library";
  const resolvedArtistId = artistId !== undefined ? artistId : song.artistId;
  const resolvedAlbumId = albumId !== undefined ? albumId : song.albumId;
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

  useEffect(() => {
    let cancelled = false;

    setOfflineStatus("not-downloaded");
    isDownloadedToDevice(song.id)
      .then((downloaded) => {
        if (!cancelled && downloaded) setOfflineStatus("downloaded");
      })
      .catch(() => {});

    function handleOfflineDownloadEvent(event) {
      if (!cancelled && String(event.detail?.trackId) === String(song.id)) {
        setOfflineStatus("downloaded");
      }
    }

    window.addEventListener("musicdeck:offline-download", handleOfflineDownloadEvent);
    return () => {
      cancelled = true;
      window.removeEventListener("musicdeck:offline-download", handleOfflineDownloadEvent);
    };
  }, [song.id]);

  async function handleOfflineDownload(event) {
    event.stopPropagation();
    if (!isServerSynced || offlineStatus !== "not-downloaded") return;

    setOfflineStatus("downloading");
    try {
      await downloadToDevice(song.id, downloadQuality);
      setOfflineStatus("downloaded");
    } catch (error) {
      console.error("Could not download track to this device:", error);
      setOfflineStatus("not-downloaded");
    }
  }

  function activateTrack() {
    if (isCurrentTrack) {
      togglePlay();
      return;
    }

    onPlay?.(song, index);
  }

  function handleRowClick(event) {
    if (!event.target.closest("a, button, input, select, textarea")) {
      activateTrack();
    }
  }

  function handleRowKeyDown(event) {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    activateTrack();
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
    className,
  ].filter(Boolean).join(" ");
  const supplementalMenuContent = isValidElement(menu) ? menu.props.children : menu;

  if (!preserveDeleted && deletion?.deletedTracks.has(String(song.id))) return null;

  return (
    <div
      className={rowClassName}
      role="row"
      tabIndex={0}
      aria-label={`${song.title || "Unknown title"} by ${resolvedArtist}`}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
    >
      <div className="track-number" role="cell">
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
        <div className={`track-title ${song.provider === "external" && song.inLibrary ? "track-title-with-library-badge" : ""}`}>
          <span className="track-title-text">{song.title || "Unknown title"}</span>
          <InLibraryBadge visible={song.provider === "external" && song.inLibrary} />
          <AvailabilityHint availability={song.availability} />
          {showSourceIndicator && <SourceIndicator source={song.source} />}
        </div>

        {resolvedArtistId ? (
          <Link to={`/artist/${encodeURIComponent(toArtistRouteIdFromApiId(resolvedArtistId))}`} className="track-artist">
            {song.artist || "Unknown artist"}
          </Link>
        ) : (
          <div className="track-artist">{resolvedArtist}</div>
        )}
      </div>

      {showAlbum && (
        resolvedAlbumId ? (
          <div className="track-album" role="cell">
            <Link to={`/album/${resolvedAlbumId}`} className="track-album-link">
              {resolvedAlbum}
            </Link>
          </div>
        ) : (
          <div className="track-album" role="cell">{resolvedAlbum}</div>
        )
      )}

      {!showAlbum && <div className="track-album" role="cell" aria-hidden="true" />}

      <div className="track-server-status" role="cell">
        {isServerSynced ? (
          <span className="track-server-placeholder" aria-hidden="true">{"\u2063"}</span>
        ) : isExternalTrack ? (
          <span className="track-server-placeholder" aria-hidden="true">{"\u2063"}</span>
        ) : (
          <TrackDownloadButton song={song} completedPlaceholder />
        )}
      </div>

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
        {isExternalTrack && (
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
          aria-expanded={Boolean(menu)}
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu?.(song, event);
          }}
        >
          ⋯
        </button>

        {menu && (
          <TrackContextMenu
            song={song}
            downloadQuality={downloadQuality}
            isServerSynced={isServerSynced}
            offlineStatus={offlineStatus}
            onOfflineDownload={handleOfflineDownload}
            onSpotdlDownload={onSpotdlDownload}
            triggerRef={menuTriggerRef}
            onRequestClose={() => onToggleMenu?.(song)}
          >
            {supplementalMenuContent}
          </TrackContextMenu>
        )}
      </div>
    </div>
  );
}


export default memo(TrackRow);
