import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  usePlayer,
} from "../context/PlayerContext";

import PlaylistCover from "./PlaylistCover";

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


function Player() {

  const {
    currentSong,
    isPlaying,
    currentTime,
    duration,

    togglePlay,
    seek,

    nextSong,
    previousSong,

    volume,
    changeVolume,

    queue,
    queueIndex,

    recentlyPlayed,

    playSong,
    playQueueSong,

    toggleLike,
    isCurrentSongLiked,

    playbackContext,
    isPreview,
    previewDurationSeconds,
    playbackUnavailable,

  } = usePlayer();


  /*
   * QUEUE PANEL
   */

  const [
    showQueue,
    setShowQueue,
  ] = useState(false);


  const [
    queueView,
    setQueueView,
  ] = useState("queue");


  /*
   * Used to detect clicks outside
   * the queue.
   */

  const queueRef =
    useRef(null);


  /*
   * CLOSE QUEUE WHEN CLICKING
   * OUTSIDE IT
   */

  useEffect(() => {

    function handleOutsideClick(event) {

      if (!showQueue) {
        return;
      }


      if (
        queueRef.current &&
        !queueRef.current.contains(
          event.target
        )
      ) {

        setShowQueue(false);

      }

    }


    document.addEventListener(
      "mousedown",
      handleOutsideClick
    );


    return () => {

      document.removeEventListener(
        "mousedown",
        handleOutsideClick
      );

    };

  }, [showQueue]);


  /*
   * ONLY SHOW UPCOMING SONGS
   *
   * queueIndex is the currently
   * playing song.
   *
   * Everything before it has
   * already been played.
   */

  const upcomingQueue =
    queueIndex >= 0
      ? queue.slice(queueIndex + 1)
      : [];


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


  /*
   * TOGGLE QUEUE
   */

  function toggleQueue() {

    setShowQueue(
      (current) => !current
    );

  }


  /*
   * CLICK QUEUE SONG
   */

  function handleQueueSongClick(
    index
  ) {

    if (
      queueIndex < 0
    ) {
      return;
    }


    const actualIndex =
      queueIndex +
      1 +
      index;


    playQueueSong(
      actualIndex
    );

  }


  /*
   * CLICK RECENTLY PLAYED SONG
   */

  function handleRecentSongClick(
    song
  ) {

    playSong(song);

  }


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

      <div
        className="player-right"
        ref={queueRef}
      >


        {/* QUEUE */}

        <div className="player-queue">


          <button
            className="player-queue-button"

            onClick={
              toggleQueue
            }

            aria-label="Show queue"

            aria-expanded={
              showQueue
            }
          >
            Queue
          </button>


          {showQueue && (

            <div className="player-queue-panel">


              {/* =============================== */}
              {/* PLAYBACK CONTEXT */}
              {/* =============================== */}

              {playbackContext &&
                playbackContext.type === "playlist" && (

                <div className="player-queue-context">

                  <div className="player-queue-context-cover">

                    <PlaylistCover
                      playlist={playbackContext}
                      size={160}
                    />

                  </div>


                  <div className="player-queue-context-info">

                    <div className="player-queue-context-label">
                      Playing from playlist
                    </div>


                    <Link
                      to={`/playlist/${playbackContext.id}`}
                      className="player-queue-context-name"
                    >
                      {playbackContext.name}
                    </Link>

                  </div>

                </div>

              )}


              {/* =============================== */}
              {/* TABS */}
              {/* =============================== */}

              <div className="player-queue-tabs">


                <button
                  className={
                    queueView === "queue"
                      ? "active"
                      : ""
                  }

                  onClick={() =>
                    setQueueView(
                      "queue"
                    )
                  }
                >
                  Queue
                </button>


                <button
                  className={
                    queueView === "recent"
                      ? "active"
                      : ""
                  }

                  onClick={() =>
                    setQueueView(
                      "recent"
                    )
                  }
                >
                  Recently played
                </button>

              </div>


              {/* =============================== */}
              {/* QUEUE */}
              {/* =============================== */}

              {queueView === "queue" && (

                <div className="player-queue-list">


                  {upcomingQueue.length === 0 ? (

                    <div className="player-queue-empty">

                      {currentSong
                        ? "No songs queued"
                        : "Queue is empty"}

                    </div>

                  ) : (

                    upcomingQueue.map(
                      (
                        song,
                        index
                      ) => (

                        <button
                          key={
                            `${song.id}-${index}`
                          }

                          className="player-queue-song"

                          onClick={() =>
                            handleQueueSongClick(
                              index
                            )
                          }
                        >


                          <span className="player-queue-number">
                            {index + 1}
                          </span>


                          <span className="player-queue-info">


                            <span className="player-queue-title">
                              {song.title}
                            </span>


                            {song.artistId ? (

                              <span
                                className="player-queue-artist"
                              >
                                {song.artist ||
                                  "Unknown artist"}
                              </span>

                            ) : (

                              <span
                                className="player-queue-artist"
                              >
                                {song.artist ||
                                  "Unknown artist"}
                              </span>

                            )}

                          </span>

                        </button>

                      )

                    )

                  )}

                </div>

              )}


              {/* =============================== */}
              {/* RECENTLY PLAYED */}
              {/* =============================== */}

              {queueView === "recent" && (

                <div className="player-queue-list">


                  {recentlyPlayed.length === 0 ? (

                    <div className="player-queue-empty">
                      Nothing played yet
                    </div>

                  ) : (

                    recentlyPlayed
                      .slice(0, 10)
                      .map(
                        (
                          song,
                          index
                        ) => (

                          <button
                            key={
                              `${song.id}-${index}`
                            }

                            className="player-queue-song"

                            onClick={() =>
                              handleRecentSongClick(
                                song
                              )
                            }
                          >

                            <span className="player-queue-number">
                              {index + 1}
                            </span>


                            <span className="player-queue-info">


                              <span className="player-queue-title">
                                {song.title}
                              </span>


                              <span className="player-queue-artist">
                                {song.artist ||
                                  "Unknown artist"}
                              </span>

                            </span>

                          </button>

                        )

                      )

                  )}

                </div>

              )}

            </div>

          )}

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
