import {
  useEffect,
  useState,
} from "react";

import {
  getStarred,
} from "../api/musicdeck";

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";

import {
  getPlaylists,
  addSongToPlaylist as addSongToPlaylistRequest,
} from "../api/playlists";

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
  } = usePlayer();

  function handleTrackPlayback(song, index) {
    playContext(songs, index, {
      type: "collection",
      id: "liked-songs",
      name: "Liked Songs",
      coverArt: null,
    });
  }


  const [
    playlistMenuSong,
    setPlaylistMenuSong,
  ] = useState(null);


  const [
    playlists,
    setPlaylists,
  ] = useState([]);

  const [
    playlistsLoading,
    setPlaylistsLoading,
  ] = useState(false);

  const [
    addingToPlaylist,
    setAddingToPlaylist,
  ] = useState(false);


  useEffect(() => {

    function handleDocumentClick() {
      setPlaylistMenuSong(null);
    }

    document.addEventListener(
      "mousedown",
      handleDocumentClick
    );

    return () => {

      document.removeEventListener(
        "mousedown",
        handleDocumentClick
      );

    };

  }, []);


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
      0
    );

  }


  /*
   * Load playlists
   */

  async function loadPlaylists() {

    try {

      setPlaylistsLoading(true);

      const data =
        await getPlaylists();

      setPlaylists(data);

    } catch (error) {

      console.error(
        "Could not load playlists:",
        error
      );

    } finally {

      setPlaylistsLoading(false);

    }

  }


  /*
   * Open / close playlist menu
   */

  async function togglePlaylistMenu(song) {

    if (
      playlistMenuSong?.id === song.id
    ) {

      setPlaylistMenuSong(null);

      return;

    }


    setPlaylistMenuSong(song);

    if (playlists.length === 0) {

      await loadPlaylists();

    }

  }


  /*
   * Add song to playlist
   */

  async function addSongToPlaylist(
    event,
    playlist,
    song
  ) {

    event.stopPropagation();

    if (addingToPlaylist) {
      return;
    }

    try {

      setAddingToPlaylist(true);

      await addSongToPlaylistRequest(
        playlist.id,
        song.id
      );

      setPlaylistMenuSong(null);

    } catch (error) {

      console.error(
        "Could not add song to playlist:",
        error
      );

    } finally {

      setAddingToPlaylist(false);

    }

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

    <div className="liked-page">


      {/* HEADER */}

      <div className="liked-header">

        <div className="liked-icon">
          ♥
        </div>


        <div>

          <div className="liked-label">
            PLAYLIST
          </div>


          <h1>
            Liked Songs
          </h1>


          <div className="liked-meta">

            {songs.length}{" "}

            {songs.length === 1
              ? "song"
              : "songs"}

          </div>

        </div>

      </div>


      {/* ACTIONS */}

      <div className="liked-actions">

        <button
          className="liked-play"
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
          className="liked-action"
          aria-label="More options"
        >
          ⋯
        </button>

      </div>


      {/* TRACK LIST */}

      <div className="track-list" role="table" aria-label="Liked tracks">

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
              onToggleMenu={togglePlaylistMenu}
              menu={playlistMenuSong?.id === song.id ? (
                <div className="playlist-menu">

                    <div className="playlist-menu-title">
                      Add to playlist
                    </div>

                    {playlistsLoading && (

                      <div className="playlist-menu-item">
                        Loading...
                      </div>

                    )}

                    {!playlistsLoading &&
                      playlists.map(
                        (playlist) => (

                        <button
                          key={playlist.id}
                          className="playlist-menu-item"
                          disabled={
                            addingToPlaylist
                          }
                          onClick={(event) =>
                            addSongToPlaylist(
                              event,
                              playlist,
                              song
                            )
                          }
                        >

                          <span>
                            ♫
                          </span>

                          <span>
                            {playlist.name}
                          </span>

                        </button>

                      ))}

                    {!playlistsLoading &&
                      playlists.length === 0 && (

                      <div className="playlist-menu-empty">
                        No playlists yet
                      </div>

                    )}
                </div>
              ) : null}
            />

          )

          )

        )}

      </div>

    </div>

  );

}


export default Liked;
