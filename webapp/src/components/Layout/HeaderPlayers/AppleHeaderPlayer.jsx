import { usePlayer } from "../../../context/PlayerContext";
import { useAlbumArtwork } from "../../../hooks/useAlbumArtwork";
import { usePreviewImport } from "../../../hooks/usePreviewImport";
import { formatTime } from "../../Player";


function TransportIcon({ name }) {
  if (name === "shuffle") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7h3.2c1.3 0 2.5.6 3.3 1.6L17 17" />
        <path d="m15 14 3 3-3 3" />
        <path d="M3 17h3.2c1.3 0 2.5-.6 3.3-1.6L11 13" />
        <path d="m15 4 3 3-3 3" />
      </svg>
    );
  }
  if (name === "repeat") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17 3l4 4-4 4" />
        <path d="M3 11V9a2 2 0 0 1 2-2h16" />
        <path d="M7 21l-4-4 4-4" />
        <path d="M21 13v2a2 2 0 0 1-2 2H3" />
      </svg>
    );
  }
  if (name === "previous") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" className="is-filled"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>;
  }
  if (name === "next") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" className="is-filled"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>;
  }
  if (name === "pause") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" className="is-filled"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>;
  }
  if (name === "play") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" className="is-filled"><path d="M7 4v16l13-8z" /></svg>;
  }
  if (name === "lyrics") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5h16v11H9l-5 4z" />
        <path d="M8 9h8M8 12h5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h12M4 11h12M4 16h8" />
      <path d="M18 14v6l3-3z" />
    </svg>
  );
}


/**
 * Apple Music-inspired header player: transport on the left, a centred
 * "LCD" readout with artwork, metadata and scrubber, then volume and the
 * lyrics/queue panel toggles. Reads the same PlayerContext as the bottom
 * bar, so switching layouts never interrupts playback.
 */
function AppleHeaderPlayer() {
  const {
    currentSong,
    isPlaying,
    currentTime,
    duration,
    togglePlay,
    seek,
    nextSong,
    previousSong,
    toggleShuffle,
    isShuffleEnabled,
    toggleLoop,
    isLooping,
    volume,
    changeVolume,
    toggleLike,
    isCurrentSongLiked,
    isPreview,
    playbackUnavailable,
    playbackMessage,
    activeSidebar,
    setActiveSidebar,
  } = usePlayer();
  const { url: coverUrl, onError: onCoverError } = useAlbumArtwork(currentSong, 48);
  const { importLabel, isImportDisabled, importPreviewTrack } = usePreviewImport(currentSong);

  const hasSong = Boolean(currentSong);
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volumePercent = Math.min(100, Math.max(0, (Number(volume) || 0) * 100));
  const isNowPlayingOpen = activeSidebar === "now-playing";
  const isQueueOpen = activeSidebar === "queue";

  const togglePanel = (panel) => setActiveSidebar((current) => current === panel ? "none" : panel);

  return (
    <div className="header-player" role="region" aria-label="Playback controls">
      <div className="header-player-transport">
        <button
          type="button"
          className={`header-player-button header-player-mode${isShuffleEnabled ? " active" : ""}`}
          onClick={toggleShuffle}
          disabled={!hasSong}
          aria-label={isShuffleEnabled ? "Turn off shuffle" : "Turn on shuffle"}
          aria-pressed={isShuffleEnabled}
        >
          <TransportIcon name="shuffle" />
        </button>
        <button type="button" className="header-player-button" onClick={previousSong} disabled={!hasSong} aria-label="Previous song">
          <TransportIcon name="previous" />
        </button>
        <button
          type="button"
          className="header-player-button header-player-play"
          onClick={togglePlay}
          disabled={!hasSong}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          <TransportIcon name={isPlaying ? "pause" : "play"} />
        </button>
        <button type="button" className="header-player-button" onClick={nextSong} disabled={!hasSong} aria-label="Next song">
          <TransportIcon name="next" />
        </button>
        <button
          type="button"
          className={`header-player-button header-player-mode${isLooping ? " active" : ""}`}
          onClick={toggleLoop}
          disabled={!hasSong}
          aria-label={isLooping ? "Turn off repeat" : "Turn on repeat"}
          aria-pressed={isLooping}
        >
          <TransportIcon name="repeat" />
        </button>
      </div>

      <div className={`header-player-lcd${hasSong ? "" : " is-idle"}`}>
        <span className="header-player-cover" aria-hidden="true">
          {coverUrl ? <img src={coverUrl} alt="" width="48" height="48" onError={onCoverError} /> : <span>♫</span>}
        </span>
        <div className="header-player-meta">
          <div className="header-player-title-row">
            <span className="header-player-title">{hasSong ? currentSong.title || "Unknown title" : "Nothing playing"}</span>
            {isPreview && hasSong && (
              <button type="button" className="now-preview-import" onClick={importPreviewTrack} disabled={isImportDisabled}>
                {importLabel}
              </button>
            )}
            {playbackUnavailable && <span className="now-badge now-badge-unavailable" role="status">Unavailable</span>}
          </div>
          <span className="header-player-artist">
            {hasSong ? [currentSong.artist || "Unknown artist", currentSong.album].filter(Boolean).join(" — ") : "Choose a song to start"}
          </span>
          <div className="header-player-scrubber">
            <span className="header-player-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min="0"
              max="100"
              value={progress}
              onChange={(event) => seek(Number(event.target.value))}
              disabled={!hasSong}
              className="header-player-progress tactile-slider"
              style={{ "--range-progress": `${progress}%` }}
              aria-label="Song progress"
            />
            <span className="header-player-time">{formatTime(duration)}</span>
          </div>
        </div>
        {hasSong && (
          <button
            type="button"
            className={`header-player-like${isCurrentSongLiked ? " liked" : ""}`}
            onClick={toggleLike}
            aria-label={isCurrentSongLiked ? "Unlike song" : "Like song"}
          >
            {isCurrentSongLiked ? "♥" : "♡"}
          </button>
        )}
      </div>

      <div className="header-player-actions">
        <label className="header-player-volume">
          <span aria-hidden="true">🔊</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            className="player-volume tactile-slider"
            style={{ "--range-progress": `${volumePercent}%` }}
            aria-label="Volume"
          />
        </label>
        <button
          type="button"
          className={`header-player-button header-player-panel${isNowPlayingOpen ? " active" : ""}`}
          onClick={() => togglePanel("now-playing")}
          aria-label={isNowPlayingOpen ? "Close lyrics panel" : "Open lyrics panel"}
          aria-pressed={isNowPlayingOpen}
        >
          <TransportIcon name="lyrics" />
        </button>
        <button
          type="button"
          className={`header-player-button header-player-panel${isQueueOpen ? " active" : ""}`}
          onClick={() => togglePanel("queue")}
          aria-label={isQueueOpen ? "Close queue sidebar" : "Open queue sidebar"}
          aria-pressed={isQueueOpen}
        >
          <TransportIcon name="queue" />
        </button>
      </div>

      {playbackMessage && (
        <div className="header-player-toast" role="status" aria-live="polite">{playbackMessage}</div>
      )}
    </div>
  );
}

export default AppleHeaderPlayer;
