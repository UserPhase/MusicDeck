import {
  useEffect,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  filterLibraryTracks,
  getAllSongs,
  setMediaRating,
} from "../api/musicdeck";

import AvailabilityHint from "../components/AvailabilityHint";
import SourceMenu from "../components/SourceMenu";
import TrackDownloadButton from "../components/TrackDownloadButton";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../components/ui/PageState";

import {
  getPlaylists,
  addSongToPlaylist as addSongToPlaylistRequest,
} from "../api/playlists";

import {
  formatDuration,
} from "../utils/formatDuration";


function Tracks() {

  const {
    playSong,
    playSongFromSource,
  } = usePlayer();


  const [songs, setSongs] =
    useState([]);

  const [loadingSongs, setLoadingSongs] =
    useState(true);

  const [songError, setSongError] =
    useState(null);

  const [filters, setFilters] =
    useState({ favoritesOnly: false, unplayedOnly: false, minimumRating: "" });


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
   * Prevent duplicate playlist additions
   */

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
   * Load all songs
   */

  useEffect(() => {
    let cancelled = false;

    async function loadSongs() {

      try {

        setLoadingSongs(true);

        setSongError(null);

        const activeFilters = [
          filters.favoritesOnly ? { field: "favorite", op: "boolean", value: true } : null,
          filters.unplayedOnly ? { field: "played", op: "boolean", value: false } : null,
          filters.minimumRating ? { field: "rating", op: "gte", value: Number(filters.minimumRating) } : null,
        ].filter(Boolean);

        const data = activeFilters.length > 0
          ? await filterLibraryTracks(activeFilters)
          : await getAllSongs();


        if (!cancelled) {
          setSongs(data);
        }

      } catch (error) {

        console.error(
          "Could not load songs:",
          error
        );

        if (!cancelled) {
          setSongError(
            "Could not load your songs."
          );
        }

      } finally {

        if (!cancelled) {
          setLoadingSongs(false);
        }

      }

    }


    loadSongs();

    return () => {
      cancelled = true;
    };

  }, [filters]);


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


    /*
     * Only load playlists when
     * we actually need them.
     */

    if (playlists.length === 0) {

      await loadPlaylists();

    }

  }


  /*
   * Add ONE song to ONE playlist
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

      /*
       * Close the menu.
       */

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


  return (

    <section className="library-section">


      {/* HEADER */}

      <div className="library-section-header">

        <h2>
          Tracks
        </h2>


        {!loadingSongs && (

          <span>
            {songs.length} songs
          </span>

        )}

      </div>

      <div className="search-mode" aria-label="Library filters">
        <button
          type="button"
          className={`search-mode-option ${filters.favoritesOnly ? "active" : ""}`}
          aria-pressed={filters.favoritesOnly}
          onClick={() => setFilters((current) => ({ ...current, favoritesOnly: !current.favoritesOnly }))}
        >
          Favorites
        </button>
        <button
          type="button"
          className={`search-mode-option ${filters.unplayedOnly ? "active" : ""}`}
          aria-pressed={filters.unplayedOnly}
          onClick={() => setFilters((current) => ({ ...current, unplayedOnly: !current.unplayedOnly }))}
        >
          Unplayed
        </button>
      </div>


      {/* LOADING */}

      {loadingSongs && (

        <LoadingState>
          Loading your songs...
        </LoadingState>

      )}


      {/* ERROR */}

      {songError && (

        <ErrorState>
          {songError}
        </ErrorState>

      )}


      {/* TRACK LIST */}

      {!loadingSongs &&
        !songError && (

        <div className="track-list">

          {songs.length === 0 && (

            <EmptyState>
              No songs yet.
            </EmptyState>

          )}

          {songs.map(
            (song, index) => (

            <div
              className="track"
              key={song.id}
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


              {/* ALBUM */}

              {song.albumId ? (

                <Link
                  to={
                    `/album/${song.albumId}`
                  }
                  className="track-album"
                >
                  {song.album}
                </Link>

              ) : (

                <div className="track-album">
                  {song.album}
                </div>

              )}


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
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}

                onClick={() =>
                  togglePlaylistMenu(song)
                }
                >
                  ⋯
                </button>


                {playlistMenuSong?.id ===
                  song.id && (

                  <div className="playlist-menu"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
              >

                    <div className="playlist-menu-title">
                      Track actions
                    </div>

                    <div className="playlist-menu-item" role="group" aria-label={`Rate ${song.title}`}>
                      {[1, 2, 3, 4, 5].map((rating) => (
                        <button
                          key={rating}
                          type="button"
                          className="source-menu-retry"
                          aria-label={`Rate ${song.title} ${rating} stars`}
                          onClick={() => setMediaRating("track", song.id, rating).catch(() => {})}
                        >
                          {rating}★
                        </button>
                      ))}
                      <button
                        type="button"
                        className="source-menu-retry"
                        onClick={() => setMediaRating("track", song.id, null).catch(() => {})}
                      >
                        Clear
                      </button>
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

                )}

              </div>

            </div>

          ))}

        </div>

      )}

    </section>

  );

}


export default Tracks;
