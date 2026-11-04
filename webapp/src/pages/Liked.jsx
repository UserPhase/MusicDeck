import TrackActionScope from "../components/TrackActionScope";
import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  getStarred,
} from "../api/musicdeck";

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import CollectionDownloadButton from "../components/CollectionDownloadButton";
import FloatingPanel from "../components/ui/FloatingPanel";


import {
  usePlayer,
} from "../context/PlayerContext";

function Liked() {

  const [
    songs,
    setSongs,
  ] = useState([]);


  const [
    loading,
    setLoading,
  ] = useState(true);


  const [
    error,
    setError,
  ] = useState(null);


  const {
    playContext,
    playQueue,
    playSongFromSource,
    addToQueue,
    downloadQuality,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();
  const optionsTriggerRef = useRef(null);
  const [showMenu, setShowMenu] = useState(false);

  const playbackContext = {
    type: "collection",
    id: "liked-songs",
    name: "Liked Songs",
    coverArt: null,
  };

  function handleTrackPlayback(song, index) {
    playContext(songs, index, playbackContext);
  }


  /*
   * Load liked songs
   */

  useEffect(() => {
    let cancelled = false;

    async function loadLikedSongs() {

      try {

        setLoading(true);

        setError(null);


        const data =
          await getStarred();


        if (!cancelled) {
          setSongs(
            data || []
          );
        }

      } catch (err) {

        console.error(
          "Could not load liked songs:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load liked songs."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadLikedSongs();

    return () => {
      cancelled = true;
    };

  }, []);


  /*
   * Play all liked songs
   */

  function playLikedSongs() {

    if (
      songs.length === 0
    ) {
      return;
    }


    playQueue(
      songs,
      0,
      playbackContext
    );

  }


  /*
   * Loading
   */

  if (loading) {

    return (

      <div className="liked-page">

        <div className="loading">
          Loading liked songs...
        </div>

      </div>

    );

  }


  /*
   * Error
   */

  if (error) {

    return (

      <div className="liked-page">

        <div className="error">
          {error}
        </div>

      </div>

    );

  }


  return (

    <div className="liked-page detail-hero-gradient">


      {/* HEADER */}

      <div className="playlist-header">

        <div className="playlist-page-cover liked-cover">
          ♥
        </div>


        <div className="playlist-page-info">

          <div className="playlist-type">
            PLAYLIST
          </div>


          <h1>
            Liked Songs
          </h1>


          <div className="playlist-meta">

            {songs.length}{" "}

            {songs.length === 1
              ? "song"
              : "songs"}

          </div>

        </div>

      </div>


      {/* ACTIONS */}

      <div className="detail-action-row playlist-actions">

        <button
          className="playlist-play"
          onClick={
            playLikedSongs
          }
          disabled={
            songs.length === 0
          }
        >

          ▶

          <span>
            Play
          </span>

        </button>

        <button
          type="button"
          className={`detail-secondary-action${isShuffleEnabled ? " is-active" : ""}`}
          aria-label="Toggle shuffle"
          aria-pressed={Boolean(isShuffleEnabled)}
          onClick={toggleShuffle}
        >
          ⇄
        </button>

        <CollectionDownloadButton
          tracks={songs}
          quality={downloadQuality}
          label="liked songs"
        />

        <div className="playlist-options">
          <button
            type="button"
            className="detail-secondary-action playlist-action"
            ref={optionsTriggerRef}
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={showMenu}
            onClick={() => setShowMenu((current) => !current)}
          >
            ⋯
          </button>

          {showMenu && (
            <FloatingPanel
              anchorRef={optionsTriggerRef}
              onClose={() => setShowMenu(false)}
              className="playlist-options-menu"
              role="menu"
            >
              <button
                type="button"
                className="playlist-menu-item"
                role="menuitem"
                disabled={songs.length === 0}
                aria-label={`Add ${songs.length} ${songs.length === 1 ? "track" : "tracks"} to queue`}
                onClick={() => {
                  songs.forEach(addToQueue);
                  setShowMenu(false);
                }}
              >
                <span aria-hidden="true">＋</span>
                Add to queue
              </button>
            </FloatingPanel>
          )}
        </div>

      </div>


      {/* TRACK LIST */}

      <TrackActionScope tracks={songs} dataKey="liked-tracks"><div className="track-list" role="table" aria-label="Liked tracks">

        <TrackListHeader />

        {songs.length === 0 ? (

          <div className="library-empty">
            You haven't liked any songs yet.
          </div>

        ) : (

          songs.map(
            (song, index) => (
            <TrackRow
              key={`${song.id}-${index}`}
              song={song}
              index={index}
              onPlay={handleTrackPlayback}
              onSelectSource={playSongFromSource}


            />

          )

          )

        )}

      </div></TrackActionScope>

    </div>

  );

}


export default Liked;
