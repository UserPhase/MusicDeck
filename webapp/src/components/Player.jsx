import {
  Link,
} from "react-router-dom";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  getCoverUrl,
} from "../api/musicdeck";


function formatTime(seconds) {

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


function Player({
  isQueueSidebarOpen = false,
  onToggleQueueSidebar,
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

  } = usePlayer();


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

    <footer className="player">


      {/* ================================================= */}
      {/* NOW PLAYING */}
      {/* ================================================= */}

      <div className="now-playing">

        {currentSong && (

          <div className="now-cover">

            <img
              src={
                currentSong.coverArt
                  ? getCoverUrl(
                      currentSong.coverArt
                    )
                  : undefined
              }

              alt={
                currentSong.title ||
                "Album cover"
              }

            />

          </div>

        )}


        <div className="now-info">

          <div className="now-title">

            {currentSong
              ? currentSong.title
              : "Nothing playing"}


            {isPreview && (

              <span
                className="now-badge now-badge-preview"
                title={
                  previewDurationSeconds
                    ? `Preview only (${Math.round(previewDurationSeconds)}s), not the full track`
                    : "Preview only, not the full track"
                }
              >
                Preview
              </span>

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

            className="progress"

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
            className="player-volume"

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
