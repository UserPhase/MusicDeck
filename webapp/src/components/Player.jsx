import { Link } from "react-router-dom";

import {
  usePlayer,
} from "../context/PlayerContext";

import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { usePreviewImport } from "../hooks/usePreviewImport";

import AudioBadge from "./AudioBadge";


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
}) {

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
    previewDurationSeconds,
    playbackUnavailable,
    playbackMessage,

    streamQuality,

  } = usePlayer();
  const { url: coverUrl, onError: onCoverError } = useAlbumArtwork(currentSong, 56);
  const { importLabel, isImportDisabled, importPreviewTrack } = usePreviewImport(currentSong);


  /*
   * PROGRESS
   */

  const progress =
    duration > 0
      ? Math.min(
          100,
          (currentTime / duration) * 100
        )
      : 0;


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


            {currentSong && (
              <AudioBadge
                type={
                  isPreview
                    ? "preview"
                    : currentSong.audioType ||
                      currentSong.metadata?.codec ||
                      currentSong.source?.quality?.codec
                }
                bitrate={
                  currentSong.bitrate ||
                  currentSong.metadata?.bitrate ||
                  currentSong.source?.quality?.bitrate ||
                  (streamQuality === "original" ? undefined : streamQuality)
                }
                className="now-audio-badge"
                title={
                  isPreview && previewDurationSeconds
                    ? `Preview only (${Math.round(previewDurationSeconds)}s), not the full track`
                    : undefined
                }
              />
            )}

            {isPreview && currentSong && (
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

            currentSong.artistId ? (

              <Link
                to={
                  `/artist/${currentSong.artistId}`
                }
                className="now-artist"
              >
                {currentSong.artist ||
                  "Unknown artist"}
              </Link>

            ) : (

              <div className="now-artist">
                {currentSong.artist ||
                  "Unknown artist"}
              </div>

            )

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
              !currentSong
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
              isPlaying
                ? "Pause"
                : "Play"
            }
          >

            {isPlaying
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
              !currentSong
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

        <div className="progress-container">

          <span className="time">
            {formatTime(
              currentTime
            )}
          </span>


          <input
            type="range"

            min="0"
            max="100"

            value={progress}

            onChange={(event) =>
              seek(
                Number(
                  event.target.value
                )
              )
            }

            disabled={
              !currentSong
            }

            className="progress tactile-slider"

            style={{ "--range-progress": `${Math.min(100, Math.max(0, Number(progress) || 0))}%` }}

            aria-label="Song progress"
          />


          <span className="time">
            {formatTime(
              duration
            )}
          </span>

        </div>

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


        {/* =============================== */}
        {/* VOLUME */}
        {/* =============================== */}

        <div className="volume">

          <span
            aria-hidden="true"
          >
            🔊
          </span>


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
