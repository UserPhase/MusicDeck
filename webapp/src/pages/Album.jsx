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

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import CollectionDownloadButton from "../components/CollectionDownloadButton";

import {
  getPlaylists,
  addSongToPlaylist as addSongToPlaylistRequest,
} from "../api/playlists";

import {
  usePlayer,
} from "../context/PlayerContext";

function Album() {

  const { id } = useParams();


  const [album, setAlbum] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  const {
    playContext,
    playQueue,
    playSongFromSource,
    downloadQuality,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();

  function handleTrackPlayback(song, index) {
    playContext(
      songs,
      index,
      {
        type: "album",
        id: album.id,
        name: album.name,
        coverArt: album.coverArt,
      }
    );
  }


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

    <div
      className="album-page detail-hero-gradient"
    >


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
              width="230"
              height="230"
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

            {typeof album.trackCount === "number" &&
              typeof album.localTrackCount === "number" &&
              album.trackCount > album.localTrackCount && (
                <>
                  {" · "}
                  <span className="album-completion">
                    {album.localTrackCount} / {album.trackCount} in library
                  </span>
                </>
              )}

          </div>


          {/* ACTIONS */}

        </div>

      </div>

      <div className="detail-action-row album-actions">


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
              label="album"
            />


            {/* LIKE */}

            <button
              type="button"
              className="detail-secondary-action album-action"
              aria-label="Like album"
            >
              ♡
            </button>


            {/* MORE */}

            <button
              type="button"
              className="detail-secondary-action album-action"
              aria-label="More options"
            >
              ⋯
            </button>

      </div>


      {/* TRACK LIST */}

      <div className="track-list">

        <TrackListHeader showAlbum={false} />


        {songs.map(
          (song, index) => {

          const isDownloaded =
            typeof song.isDownloaded === "boolean"
              ? song.isDownloaded
              : Boolean(song.availability?.libraryAvailable) ||
                song.source?.kind === "library";

          return (
          <TrackRow
            key={`${song.id}-${index}`}
            song={song}
            index={index}
            showAlbum={false}
            showSourceIndicator
            dimWhenUnavailable
            isDownloaded={isDownloaded}
            artistFallback={isDownloaded ? song.artist : `${song.artist} · Not downloaded`}
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
            ) : null}
          />

          );
        })}

      </div>

    </div>

  );

}


export default Album;
