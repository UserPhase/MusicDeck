import { useEffect, useState, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";

import {
  getCoverUrl,
} from "../api/musicdeck";

import AvailabilityHint from "../components/AvailabilityHint";
import SourceMenu from "../components/SourceMenu";
import TrackDownloadButton from "../components/TrackDownloadButton";

import {
  getPlaylist,
  removeSongFromPlaylist as removeSongFromPlaylistRequest,
  deletePlaylist,
} from "../api/playlists";

import { usePlayer } from "../context/PlayerContext";

import { formatDuration } from "../utils/formatDuration";


function Playlist() {

  const { id } = useParams();


  const [playlist, setPlaylist] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  const [
    menuSongId,
    setMenuSongId,
  ] = useState(null);


  const menuRef = useRef(null);
  const navigate = useNavigate();

  const [
  showMenu,
  setShowMenu,
  ] = useState(false);

  const [
  deleting,
  setDeleting,
  ] = useState(false);

  const {
    playSong,
    playQueue,
    playSongFromSource,
  } = usePlayer();

useEffect(() => {

  function handleClickOutside(event) {

    if (
      menuRef.current &&
      !menuRef.current.contains(
        event.target
      )
    ) {

      setMenuSongId(null);

    }

  }


  document.addEventListener(
    "mousedown",
    handleClickOutside
  );


  return () => {

    document.removeEventListener(
      "mousedown",
      handleClickOutside
    );

  };

}, []);
  /*
   * Load playlist from Navidrome
   */

  useEffect(() => {
    let cancelled = false;

    async function loadPlaylist() {

      try {

        setLoading(true);
        setError(null);


        const data =
          await getPlaylist(id);


        if (!cancelled) {
          setPlaylist(data);
        }

      } catch (err) {

        console.error(
          "Could not load playlist:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load playlist."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadPlaylist();

    return () => {
      cancelled = true;
    };

  }, [id]);


async function handleRemoveSong(
  song,
  songIndex
) {

  try {

    await removeSongFromPlaylistRequest(
      id,
      songIndex
    );

      setPlaylist((currentPlaylist) => {

        if (!currentPlaylist) {
          return currentPlaylist;
        }


        const updatedSongs =
          (currentPlaylist.entry || [])
            .filter(
              (playlistSong) =>
                String(playlistSong.id) !==
                String(song.id)
            );


        return {
          ...currentPlaylist,

          entry: updatedSongs,

          songCount:
            updatedSongs.length,
        };

      });


      /*
       * Close the menu.
       */

      setMenuSongId(null);

    } catch (error) {

      console.error(
        "Could not remove song from playlist:",
        error
      );

    }

  }

  if (loading) {

    return (

      <div className="playlist-page">

        <div className="loading">
          Loading playlist...
        </div>

      </div>

    );

  }

  if (error || !playlist) {

    return (

      <div className="playlist-page">

        <Link
          to="/library/playlists"
          className="playlist-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Playlist not found."}

        </div>

      </div>

    );

  }

  const songs =
    playlist.entry || [];

  function playPlaylist() {

    if (songs.length === 0) {
      return;
    }
    playQueue(
      songs,
      0
    );

  }

  return (

    <div className="playlist-page">


      {/* BACK */}

      <Link
        to="/library/playlists"
        className="playlist-back"
      >
        ← Back
      </Link>

      <div className="playlist-header">


        <div className="playlist-page-cover">

          {playlist.coverArt ? (

            <img
              src={getCoverUrl(
                playlist.coverArt
              )}
              alt={`${playlist.name} cover`}
            />

          ) : (

            <div className="playlist-placeholder">
              ♫
            </div>

          )}

        </div>

        <div className="playlist-page-info">


          <div className="playlist-type">
            PLAYLIST
          </div>


          <h1>
            {playlist.name}
          </h1>


          {playlist.comment && (

            <p className="playlist-description">
              {playlist.comment}
            </p>

          )}


          <div className="playlist-meta">

            {songs.length}{" "}

            {songs.length === 1
              ? "song"
              : "songs"}

          </div>

          <div className="playlist-actions">


            <button
              className="playlist-play"
              onClick={playPlaylist}
              disabled={
                songs.length === 0
              }
            >
              ▶
              <span>
                Play
              </span>

            </button>


<div className="playlist-options">

  <button
    className="playlist-action"
    aria-label="More options"
    onClick={(event) => {
      event.stopPropagation();

      setShowMenu(
        (current) => !current
      );
    }}
  >
    ⋯
  </button>


  {showMenu && (

    <div className="playlist-options-menu">

      <button
        className="playlist-delete"
        disabled={deleting}
        onClick={async (event) => {

          event.stopPropagation();

          const confirmed =
            window.confirm(
              `Delete "${playlist.name}"?`
            );

          if (!confirmed) {
            return;
          }

          try {

            setDeleting(true);

            await deletePlaylist(
              playlist.id
            );

            setShowMenu(false);

            /*
             * Return to the playlist list
             * after successful deletion.
             */

            navigate("/library/playlists");

            window.dispatchEvent(
            new Event("playlistsChanged")
            );

          } catch (error) {

            console.error(
              "Could not delete playlist:",
              error
            );

            alert(
              error.message ||
              "Could not delete playlist."
            );

            setDeleting(false);

          }

        }}
      >
        {deleting
          ? "Deleting..."
          : "Delete playlist"}
      </button>

    </div>

  )}

</div>


          </div>

        </div>

      </div>


      {/* SONG LIST */}

      <div className="track-list">

        {songs.length === 0 ? (

          <div className="library-empty">
            This playlist doesn't have any songs yet.
          </div>

        ) : (

          songs.map((song, index) => (

            <div
              className="track"
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

              <div className="track-info">

                <div className="track-title">
                  {song.title}
                  <AvailabilityHint availability={song.availability} />
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

              {song.albumId ? (

                <Link
                  to={`/album/${song.albumId}`}
                  className="track-album"
                >
                  {song.album}
                </Link>

              ) : (

                <div className="track-album">
                  {song.album}
                </div>

              )}

              <TrackDownloadButton song={song} />

              <div className="track-duration">

                {formatDuration(
                  song.duration
                )}

              </div>


              {/* MENU */}

              <div
                className="track-menu-container"
                ref={menuRef}
              >

                <SourceMenu
                  song={song}
                  sources={song.sources}
                  onSelect={playSongFromSource}
                />

                <button
                  className="track-menu"
                  aria-label="More options"

                  onClick={(event) => {

                    event.stopPropagation();

                    setMenuSongId(
                      menuSongId === song.id
                        ? null
                        : song.id
                    );

                  }}
                >
                  ⋯
                </button>


                {/* MENU FOR THIS SONG ONLY */}

                {menuSongId === song.id && (

                  <div
                    className="playlist-menu"

                    onClick={(event) =>
                      event.stopPropagation()
                    }
                  >

                    <button
                      className="playlist-menu-item"

                      onClick={() =>
                        handleRemoveSong(
                          song,
                          index
                        )
                      }
                    >

                      <span>
                        −
                      </span>

                      <span>
                        Remove from playlist
                      </span>

                    </button>

                  </div>

                )}

              </div>

            </div>

          ))

        )}

      </div>

    </div>

  );

}


export default Playlist;