import {
  useEffect,
  useState,
} from "react";

import {
  useParams,
  Link,
} from "react-router-dom";

import {
  getAlbum,
  getCoverUrl,
} from "../api/musicdeck";

import AvailabilityHint from "../components/AvailabilityHint";
import SourceMenu from "../components/SourceMenu";
import SourceIndicator from "../components/SourceIndicator";
import TrackDownloadButton from "../components/TrackDownloadButton";

import {
  getPlaylists,
  addSongToPlaylist as addSongToPlaylistRequest,
} from "../api/playlists";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";


function Album() {

  const { id } = useParams();


  const [album, setAlbum] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);


  const {
    playSong,
    playQueue,
    playSongFromSource,
  } = usePlayer();


  /*
   * Playlist menu
   */

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


  /*
   * Load album
   */

  useEffect(() => {
    let cancelled = false;

    async function loadAlbum() {

      try {

        setLoading(true);
        setError(null);


        const data =
          await getAlbum(id);


        if (!cancelled) {
          setAlbum(data);
        }

      } catch (err) {

        console.error(
          "Could not load album:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load album."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadAlbum();

    return () => {
      cancelled = true;
    };

  }, [id]);


  /*
   * Close playlist menu when
   * clicking anywhere else.
   */

  useEffect(() => {

    function handleDocumentClick() {

      setPlaylistMenuSong(null);

    }


    document.addEventListener(
      "click",
      handleDocumentClick
    );


    return () => {

      document.removeEventListener(
        "click",
        handleDocumentClick
      );

    };

  }, []);


  /*
   * Load playlists
   */

  async function loadPlaylists() {

    try {

      setPlaylistsLoading(true);


      const data =
        await getPlaylists();


      setPlaylists(data);

    } catch (err) {

      console.error(
        "Could not load playlists:",
        err
      );

    } finally {

      setPlaylistsLoading(false);

    }

  }


  /*
   * Open / close playlist menu
   */

  async function togglePlaylistMenu(
    song
  ) {

    if (
      playlistMenuSong?.id === song.id
    ) {

      setPlaylistMenuSong(null);

      return;

    }


    setPlaylistMenuSong(song);


    /*
     * Load playlists the first time
     * the menu is opened.
     */

    if (
      playlists.length === 0
    ) {

      await loadPlaylists();

    }

  }


  /*
   * Add song to playlist
   */

  async function addSongToPlaylist(
    playlist,
    song
  ) {

    try {

      await addSongToPlaylistRequest(
        playlist.id,
        song.id
      );


      /*
       * Close the menu after adding.
       */

      setPlaylistMenuSong(null);

    } catch (err) {

      console.error(
        "Could not add song to playlist:",
        err
      );

    }

  }


  /*
   * Loading
   */

  if (loading) {

    return (

      <div className="album-page">

        <div className="loading">
          Loading album...
        </div>

      </div>

    );

  }


  /*
   * Error
   */

  if (
    error ||
    !album
  ) {

    return (

      <div className="album-page">

        <Link
          to="/library"
          className="album-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Album not found."}

        </div>

      </div>

    );

  }


  const songs =
    album.song || [];


  /*
   * Play entire album
   */

  function playAlbum() {

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


  return (

    <div className="album-page">


      {/* BACK */}

      <Link
        to="/library"
        className="album-back"
      >
        ← Back
      </Link>


      {/* ALBUM HEADER */}

      <div className="album-header">


        {/* COVER */}

        <div className="album-page-cover">

          {album.coverArt && (

            <img
              src={
                getCoverUrl(
                  album.coverArt
                )
              }
              alt={
                `${album.name} cover`
              }
            />

          )}

        </div>


        {/* INFO */}

        <div className="album-page-info">


          <div className="album-type">
            ALBUM
          </div>


          <h1>
            {album.name}
          </h1>


          {/* ARTIST */}

          {album.artistId ? (

            <Link
              to={
                `/artist/${album.artistId}`
              }
              className="album-artist"
            >
              {album.artist}
            </Link>

          ) : (

            <div className="album-artist">
              {album.artist}
            </div>

          )}


          {/* META */}

          <div className="album-meta">

            {album.year && (

              <>
                {album.year}
                {" · "}
              </>

            )}

            {album.genre && (
              <>
                {album.genre}
                {" · "}
              </>
            )}

            {album.label && (
              <>
                {album.label}
                {" · "}
              </>
            )}

            {songs.length}
            {" "}


            {songs.length === 1
              ? "song"
              : "songs"}

          </div>


          {/* ACTIONS */}

          <div className="album-actions">


            {/* PLAY */}

            <button
              className="album-play"
              onClick={playAlbum}
              disabled={
                songs.length === 0
              }
            >

              ▶

              <span>
                Play
              </span>

            </button>


            {/* LIKE */}

            <button
              className="album-action"
              aria-label="Like album"
            >
              ♡
            </button>


            {/* MORE */}

            <button
              className="album-action"
              aria-label="More options"
            >
              ⋯
            </button>

          </div>

        </div>

      </div>


      {/* TRACK LIST */}

      <div className="track-list">


        {songs.map(
          (song, index) => (

          <div
            className="track track-album-page"
            key={`${song.id}-${index}`}
          >


            {/* NUMBER / PLAY */}

            <div className="track-number">

              <span className="track-number-text">
                {index + 1}
              </span>


              <button
                className="track-play"
                onClick={() =>
                  playSong(song)
                }
                aria-label={
                  `Play ${song.title}`
                }
              >
                ▶
              </button>

            </div>


            {/* SONG + ARTIST */}

            <div className="track-info">

              <div className="track-title">
                {song.title}
                <AvailabilityHint availability={song.availability} />
                <SourceIndicator source={song.source} />
              </div>


              {song.artistId ? (

                <Link
                  to={
                    `/artist/${song.artistId}`
                  }
                  className="track-artist"
                >
                  {song.artist}
                </Link>

              ) : (

                <div className="track-artist">
                  {song.artist}
                </div>

              )}

            </div>


            {/* DOWNLOAD */}

            <TrackDownloadButton song={song} />


            {/* DURATION */}

            <div className="track-duration">

              {formatDuration(
                song.duration
              )}

            </div>


            {/* MENU */}

            <div
              className="track-menu-container"
              onClick={(event) =>
                event.stopPropagation()
              }
            >

              <SourceMenu
                song={song}
                sources={song.sources}
                onSelect={playSongFromSource}
              />

              <button
                className="track-menu"
                aria-label="More options"
                onClick={() =>
                  togglePlaylistMenu(song)
                }
              >
                ⋯
              </button>


              {/* PLAYLIST MENU */}

              {playlistMenuSong?.id ===
                song.id && (

                <div
                  className="playlist-menu"
                  onClick={(event) =>
                    event.stopPropagation()
                  }
                >

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
                        onClick={() =>
                          addSongToPlaylist(
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

              )}

            </div>

          </div>

        ))}

      </div>

    </div>

  );

}


export default Album;