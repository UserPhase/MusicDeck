import { useLayoutEffect, useRef } from "react";
import { useVisualActivity } from "../hooks/useVisualActivity";
import { usePlaybackDisplayPosition } from "../hooks/usePlaybackDisplayPosition";
import { isDesktopRuntime } from "../services/desktop/desktopRuntime";
import PlayerAudioTools from "./player/PlayerAudioTools";
import TrackArtistLinks from "./TrackArtistLinks";

import {
  usePlayer,
} from "../context/PlayerContext";

import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { usePreviewImport } from "../hooks/usePreviewImport";
import { usePrivacy } from "../context/PrivacyContext";

import AudioQualityBadge from "./player/AudioQualityBadge";
import DeviceSelectorButton from "./player/DeviceSelectorButton";


export function formatTime(seconds) {

  if (
    seconds === undefined ||
    seconds === null ||
    Number.isNaN(seconds)
  ) {
    return "0:00";
  }


  const minutes =
    Math.floor(seconds / 60);


  const remaining =
    Math.floor(seconds % 60);


  return (
    `${minutes}:` +
    `${remaining
      .toString()
      .padStart(2, "0")}`
  );

}


function paintProgress(input, percent) {
  input.value = String(percent);
  input.style.setProperty("--range-progress", `${percent}%`);
}

function progressPercent(position, duration) {
  return duration > 0 && Number.isFinite(position) ? Math.min(100, Math.max(0, position / duration * 100)) : 0;
}

function PlayerProgress({ player }) {
  const { currentSong, isPlaying, isBuffering, isRemotePlayback, duration, seek, readPlaybackPosition } = player;
  const currentTime = usePlaybackDisplayPosition(player);
  const progressInput = useRef(null);
  const visualActive = useVisualActivity();
  const desktop = isDesktopRuntime();
  const animateProgress = Boolean((!desktop || isRemotePlayback) && visualActive && currentSong && duration > 0 && isPlaying && !isBuffering && readPlaybackPosition);

  useLayoutEffect(() => {
    if (!visualActive) return;
    const position = (!desktop || isRemotePlayback) && currentSong && readPlaybackPosition ? readPlaybackPosition() : currentTime;
    paintProgress(progressInput.current, progressPercent(position, duration));
  }, [currentSong, currentTime, duration, animateProgress, readPlaybackPosition, visualActive, desktop, isRemotePlayback]);

  // Repaint only the scrubber between media events so the rest of the UI stays idle.
  useLayoutEffect(() => {
    if (!animateProgress) return;
    const input = progressInput.current;
    let frame;
    const draw = () => {
      const percent = progressPercent(readPlaybackPosition(), duration);
      if (input.valueAsNumber !== percent) paintProgress(input, percent);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [animateProgress, duration, readPlaybackPosition]);


  return (
    <div className="progress-container">
      <span className="time">{formatTime(currentTime)}</span>
      <input
        ref={progressInput}
        type="range"
        min="0"
        max="100"
        step="any"
        defaultValue={0}
        onChange={(event) => {
          const percent = event.currentTarget.valueAsNumber;
          paintProgress(event.currentTarget, percent);
          seek(percent);
        }}
        disabled={!currentSong || !(duration > 0)}
        className="progress tactile-slider"
        aria-label="Song progress"
      />
      <span className="time">{formatTime(duration)}</span>
    </div>
  );
}

/**
 * Docked player bar. `variant="drawer"` restyles it as the floating,
 * expandable bar used by the YouTube Music layout; `actions` renders extra
 * buttons (such as the drawer expand toggle) beside the queue button.
 */
function Player({
  isQueueSidebarOpen = false,
  onToggleQueueSidebar,
  variant = "bar",
  actions = null,
  mobile = false,
}) {

  const player = usePlayer();
  const {
    currentSong,
    isPlaying,
    isRemotePlayback,
    isCasting,

    togglePlay,

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
    isPreparingPlayback,

  } = player;
  const { url: coverUrl, onError: onCoverError } = useAlbumArtwork(currentSong, 56);
  const { importLabel, isImportDisabled, importPreviewTrack } = usePreviewImport(currentSong);
  const { canImport } = usePrivacy();


  const lastAudibleVolume = useRef(0.5);
  const isMuted = volume === 0;
  const muteLabel = isMuted ? "Unmute" : "Mute";

  useLayoutEffect(() => {
    if (volume > 0) lastAudibleVolume.current = volume;
  }, [volume]);

  return (

    <footer className={`player player--${variant}`}>

      {playbackMessage && (
        <div className="player-toast" role="status" aria-live="polite">
          {playbackMessage}
        </div>
      )}


      {/* ================================================= */}
      {/* NOW PLAYING */}
      {/* ================================================= */}

      <div className="now-playing">

        {currentSong && (

          <div className="now-cover">

            {coverUrl ? <img
              width="56"
              height="56"
              src={coverUrl}
              onError={onCoverError}

              alt={
                currentSong.title ||
                "Album cover"
              }

            /> : <span aria-hidden="true">♫</span>}

          </div>

        )}


        <div className="now-info">

          <div className="now-title">

            <span className="now-title-text">
              {currentSong
                ? currentSong.title
                : "Nothing playing"}
            </span>


            {isPreview && currentSong && <span className="audio-badge audio-badge-preview now-audio-badge">PREVIEW</span>}
            {currentSong && !isPreview && !isRemotePlayback && !isCasting && <AudioQualityBadge />}

            {isPreview && currentSong && canImport && (
              <button
                type="button"
                className="now-preview-import"
                onClick={importPreviewTrack}
                disabled={isImportDisabled}
              >
                {importLabel}
              </button>
            )}


            {playbackUnavailable && (

              <span
                className="now-badge now-badge-unavailable"
                role="status"
              >
                Unavailable
              </span>

            )}

          </div>


          {currentSong ? (

            <TrackArtistLinks song={currentSong} className="now-artist" />

          ) : (

            <div className="now-artist">
              Choose a song to start
            </div>

          )}

        </div>


        {/* LIKE */}

        {currentSong && (

          <button
            className={
              `heart ${
                isCurrentSongLiked
                  ? "liked"
                  : ""
              }`
            }

            onClick={
              toggleLike
            }

            aria-label={
              isCurrentSongLiked
                ? "Unlike song"
                : "Like song"
            }

          >
            {isCurrentSongLiked
              ? "♥"
              : "♡"}

          </button>

        )}
        {mobile && <div className="player-audio-tools-mobile" role="group" aria-label="Playback devices">
          <PlayerAudioTools />
          <DeviceSelectorButton compact />
        </div>}


      </div>


      {/* ================================================= */}
      {/* CONTROLS */}
      {/* ================================================= */}

      <div className="controls">


        <div className="control-buttons">


          {/* SHUFFLE */}

          <button
            className={
              `control shuffle-control ${
                isShuffleEnabled
                  ? "active"
                  : ""
              }`
            }

            onClick={
              toggleShuffle
            }

            disabled={
              !currentSong || isRemotePlayback
            }

            aria-label={
              isShuffleEnabled
                ? "Turn off shuffle"
                : "Turn on shuffle"
            }

            aria-pressed={
              isShuffleEnabled
            }
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M3 7h3.2c1.3 0 2.5.6 3.3 1.6L17 17" />
              <path d="m15 14 3 3-3 3" />
              <path d="M3 17h3.2c1.3 0 2.5-.6 3.3-1.6L11 13" />
              <path d="m15 4 3 3-3 3" />
            </svg>
          </button>


          {/* PREVIOUS */}

          <button
            className="control"

            onClick={
              previousSong
            }

            disabled={
              !currentSong
            }

            aria-label="Previous song"
          >
            ◀
          </button>


          {/* PLAY / PAUSE */}

          <button
            className="play-button"

            onClick={
              togglePlay
            }

            disabled={
              !currentSong
            }

            aria-label={
              isPreparingPlayback ? "Cancel preparation" : isPlaying
                ? "Pause"
                : "Play"
            }
            aria-busy={isPreparingPlayback || undefined}
          >

            {isPreparingPlayback ? "…" : isPlaying
              ? "❚❚"
              : "▶"}

          </button>


          {/* NEXT */}

          <button
            className="control"

            onClick={
              nextSong
            }

            disabled={
              !currentSong
            }

            aria-label="Next song"
          >
            ▶
          </button>


          {/* LOOP */}

          <button
            className={
              `control loop-control ${
                isLooping
                  ? "active"
                  : ""
              }`
            }

            onClick={
              toggleLoop
            }

            disabled={
              !currentSong || isRemotePlayback
            }

            aria-label={
              isLooping
                ? "Turn off repeat"
                : "Turn on repeat"
            }

            aria-pressed={
              isLooping
            }
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M17 3l4 4-4 4" />
              <path d="M3 7h18" />
              <path d="M7 21l-4-4 4-4" />
              <path d="M21 17H3" />
            </svg>
          </button>

        </div>


        {/* PROGRESS */}

        <PlayerProgress player={player} />

      </div>


      {/* ================================================= */}
      {/* RIGHT SIDE */}
      {/* ================================================= */}

      <div className="player-right">


        {/* QUEUE */}

        <div className="player-queue">


          <button
            className="player-queue-button"

            onClick={onToggleQueueSidebar}

            aria-label={isQueueSidebarOpen ? "Close queue sidebar" : "Open queue sidebar"}

            aria-expanded={isQueueSidebarOpen}
          >
            Queue
          </button>

          {actions}

        </div>


        {!mobile && <div className="player-streaming-controls" role="group" aria-label="Playback devices">
          <PlayerAudioTools />
          <DeviceSelectorButton compact />
        </div>}

        {/* =============================== */}
        {/* VOLUME */}
        {/* =============================== */}

        <div className="volume">

          <button type="button" className="player-mute-button" aria-label={muteLabel} title={muteLabel}
            onClick={() => changeVolume(isMuted ? lastAudibleVolume.current : 0)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H3v6h3l5 4V5Z" />
              {isMuted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15 9a4 4 0 0 1 0 6m2.5-8.5a8 8 0 0 1 0 11" />}
            </svg>
          </button>


          <input
            className="player-volume tactile-slider"

            style={{ "--range-progress": `${Math.min(100, Math.max(0, (Number(volume) || 0) * 100))}%` }}

            type="range"

            min="0"
            max="1"

            step="0.01"

            value={volume}

            onChange={(event) =>
              changeVolume(
                Number(
                  event.target.value
                )
              )
            }

            aria-label="Volume"
          />

        </div>


      </div>

    </footer>

  );

}


export default Player;
