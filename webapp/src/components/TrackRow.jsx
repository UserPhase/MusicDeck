import { isValidElement, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { usePlayer } from "../context/PlayerContext";
import { downloadToDevice, isDownloadedToDevice } from "../utils/downloadManager";
import { formatDuration } from "../utils/formatDuration";

import AvailabilityHint from "./AvailabilityHint";
import SourceIndicator from "./SourceIndicator";
import TrackContextMenu from "./TrackContextMenu";
import TrackDownloadButton from "./TrackDownloadButton";
import TrackPlaybackIndicator from "./TrackPlaybackIndicator";


function TrackRow({
  song,
  index,
  onPlay,
  showAlbum = true,
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
  className = "",
}) {
  const {
    currentSong,
    downloadQuality = "320kbps",
    isPlaying,
    togglePlay,
  } = usePlayer();

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
      console.warn("Could not download track to this device:", error);
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
    !showAlbum && "track-album-page",
    dimWhenUnavailable && !resolvedDownloaded && "track-not-downloaded",
    isCurrentTrack && "is-current-track",
    isCurrentTrack && isPlaying && "is-playing",
    className,
  ].filter(Boolean).join(" ");
  const supplementalMenuContent = isValidElement(menu) ? menu.props.children : menu;

  return (
    <div
      className={rowClassName}
      tabIndex={0}
      aria-label={`${song.title || "Unknown title"} by ${resolvedArtist}`}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
    >
      <div className="track-number">
        <TrackPlaybackIndicator
          index={index}
          isCurrentTrack={isCurrentTrack}
          isPlaying={isPlaying}
        />

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

      <div className="track-info">
        <div className="track-title">
          {song.title || "Unknown title"}
          <AvailabilityHint availability={song.availability} />
          {showSourceIndicator && <SourceIndicator source={song.source} />}
        </div>

        {resolvedArtistId ? (
          <Link to={`/artist/${resolvedArtistId}`} className="track-artist">
            {song.artist || "Unknown artist"}
          </Link>
        ) : (
          <div className="track-artist">{resolvedArtist}</div>
        )}
      </div>

      {showAlbum && (
        resolvedAlbumId ? (
          <Link to={`/album/${resolvedAlbumId}`} className="track-album">
            {resolvedAlbum}
          </Link>
        ) : (
          <div className="track-album">{resolvedAlbum}</div>
        )
      )}

      {!showAlbum && <div className="track-album" aria-hidden="true" />}

      <div className="track-server-status">
        {isServerSynced ? (
          <span className="track-server-placeholder" aria-hidden="true">{"\u2063"}</span>
        ) : (
          <TrackDownloadButton song={song} completedPlaceholder />
        )}
      </div>

      <div className="track-duration">
        {formatDuration(resolvedDuration)}
      </div>

      <div
        className="track-row-actions"
        ref={actionsRef}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="track-menu"
          aria-label={`More options for ${song.title || "track"}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={(event) => onToggleMenu?.(song, event)}
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
          >
            {supplementalMenuContent}
          </TrackContextMenu>
        )}
      </div>
    </div>
  );
}


export default TrackRow;
