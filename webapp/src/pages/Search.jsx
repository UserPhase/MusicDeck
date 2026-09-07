import {
  useEffect,
  useState,
} from "react";

import {
  Link,
  useSearchParams,
} from "react-router-dom";

import {
  searchNavidrome,
  getCoverUrl,
  getUserSettings,
  startRadio,
  updateUserSettings,
} from "../api/musicdeck";

import AvailabilityHint from "../components/AvailabilityHint";
import SourceMenu from "../components/SourceMenu";
import SourceIndicator from "../components/SourceIndicator";
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
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";


function Search() {

  const [
    searchParams,
  ] = useSearchParams();


  const query =
    searchParams.get("q") || "";


  const [
    results,
    setResults,
  ] = useState({
    artist: [],
    album: [],
    track: [],
    playlist: [],
    degraded: false,
  });


  const [
    loading,
    setLoading,
  ] = useState(false);


  const [
    error,
    setError,
  ] = useState(null);

  const [sourceMode, setSourceMode] = useState("hybrid");


  const {
    playSong,
    playSongFromSource,
    playQueue,
  } = usePlayer();


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

  useEffect(() => {
    let cancelled = false;

    Promise.resolve(getUserSettings())
      .then((settings) => {
        const stored = settings.find((setting) => setting.key === "catalog.sourceMode");
        const value = stored ? JSON.parse(stored.value) : "hybrid";

        if (!cancelled && ["library", "hybrid", "external"].includes(value)) {
          setSourceMode(value);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
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

  async function startTrackRadio(song) {
    try {
      const tracks = await startRadio({
        type: "track",
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        artistId: song.metadata?.artistId || null,
        albumId: song.metadata?.albumId || null,
      });

      if (tracks.length > 0) {
        setPlaylistMenuSong(null);
        playQueue(tracks, 0);
      }
    } catch (error) {
      console.error("Could not start radio:", error);
    }
  }


  /*
   * SEARCH
   */

  useEffect(() => {
    let cancelled = false;

    if (!query.trim()) {

      setResults({
        artist: [],
        album: [],
        track: [],
        playlist: [],
        degraded: false,
      });

      setLoading(false);
      setError(null);

      return () => {
        cancelled = true;
      };

    }


    async function search() {

      try {

        setLoading(true);
        setError(null);


        const data =
          await searchNavidrome(
            query,
            { mode: sourceMode }
          );


        if (!cancelled) {
          setResults({
            artist: data?.results?.artist || [],
            album: data?.results?.album || [],
            track: data?.results?.track || [],
            playlist: data?.results?.playlist || [],
            degraded: Boolean(data?.degraded),
          });
        }

      } catch (err) {

        console.error(
          "Search failed:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not search your music."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    search();

    return () => {
      cancelled = true;
    };

  }, [query, sourceMode]);

  function chooseSourceMode(mode) {
    setSourceMode(mode);
    updateUserSettings({ "catalog.sourceMode": mode }).catch(() => {});
  }


  /*
   * EMPTY SEARCH
   */

  if (!query.trim()) {

    return (

      <div className="search-page">

        <div className="section-header">

          <h1>
            Search
          </h1>

        </div>


        <EmptyState>
          Search for an artist, album or song.
        </EmptyState>

      </div>

    );

  }


  /*
   * LOADING
   */

  if (loading) {

    return (

      <div className="search-page">

        <div className="section-header">

          <h1>
            Search
          </h1>

        </div>


        <LoadingState>
          Searching for "{query}"...
        </LoadingState>

      </div>

    );

  }


  /*
   * ERROR
   */

  if (error) {

    return (

      <div className="search-page">

        <ErrorState>
          {error}
        </ErrorState>

      </div>

    );

  }


  const hasResults =
    results.artist.length > 0 ||
    results.album.length > 0 ||
    results.track.length > 0 ||
    results.playlist.length > 0;


  return (

    <div className="search-page">


      {/* HEADER */}

      <div className="section-header">

        <h1>
          Search results
        </h1>

      </div>


      <p className="search-query">
        Results for "{query}"
      </p>

      <div className="search-mode" role="group" aria-label="Catalog mode">
        {["library", "hybrid", "external"].map((mode) => (
          <button
            key={mode}
            type="button"
            className={`search-mode-option ${sourceMode === mode ? "active" : ""}`}
            aria-pressed={sourceMode === mode}
            onClick={() => chooseSourceMode(mode)}
          >
            {mode[0].toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      {results.degraded && (
        <p className="search-degraded" role="status">
          Some music is temporarily unavailable.
        </p>
      )}


      {!hasResults ? (

        <EmptyState>
          No results found.
        </EmptyState>

      ) : (

        <div className="search-groups">


          {/* ================================
              ARTISTS
          ================================= */}

          {results.artist.length > 0 && (

            <section className="section search-group search-group-artists">

              <div className="section-header">

                <h2>
                  Artists
                </h2>

              </div>


              <div className="search-results">

                {results.artist.map(
                  (artist) => (

                    <Link
                      key={artist.id}
                      to={`/artist/${artist.id}`}
                      className="search-result"
                    >

                      <div className="search-result-info">

                        <div className="search-result-title">
                          {artist.title}
                        </div>

                        <div className="search-result-type">
                          Artist
                          <AvailabilityHint availability={artist.availability} />
                          <SourceIndicator source={artist.source} />
                        </div>

                      </div>

                    </Link>

                  )
                )}

              </div>

            </section>

          )}


          {/* ================================
              ALBUMS
          ================================= */}

          {results.album.length > 0 && (

            <section className="section search-group search-group-albums">

              <div className="section-header">

                <h2>
                  Albums
                </h2>

              </div>


              <div className="album-grid">

                {results.album.map(
                  (album) => (

                    <Link
                      key={album.id}
                      to={`/album/${album.id}`}
                      className="see-all"
                    >

                      <div className="album-cover">

                        {album.coverArt && (

            <img
              src={
                getCoverUrl(
                  album.coverArt
                )
              }
              alt={
                `${album.title} cover`
              }
            />

                        )}

                      </div>


                      <div className="album-title">
                        {album.title}
                      </div>


                      <div className="album-artist">
                        {album.artist ||
                          "Unknown artist"}
                        <AvailabilityHint availability={album.availability} />
                        <SourceIndicator source={album.source} />
                      </div>

                    </Link>

                  )
                )}

              </div>

            </section>

          )}


          {/* ================================
              SONGS
          ================================= */}

          {results.track.length > 0 && (

            <section className="library-section search-group search-group-songs">

              <div className="library-section-header">

                <h2>
                  Songs
                </h2>

              </div>


              <div className="track-list">

                {results.track.map(
                  (song, index) => (

                    <div
                      key={song.id}
                      className="track"
                    >


                      {/* NUMBER / PLAY */}

                      <div className="track-number">

                        <span className="track-number-text">
                          {index + 1}
                        </span>


                        <button
                          type="button"
                          className="track-play"
                          disabled={song.source?.kind === "external"}
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


                      {/* SONG INFO */}

                      <div className="track-info">

                        <div className="track-title">
                          {song.title}
                          <AvailabilityHint availability={song.availability} />
                          <SourceIndicator source={song.source} />
                        </div>


                        {song.metadata.artistId ? (

                          <Link
                            to={
                              `/artist/${song.metadata.artistId}`
                            }
                            className="track-artist"
                          >
                            {song.artist ||
                              "Unknown artist"}
                          </Link>

                        ) : (

                          <div className="track-artist">
                            {song.artist ||
                              "Unknown artist"}
                          </div>

                        )}

                      </div>


                      {/* ALBUM */}

                      {song.metadata.albumId ? (

                        <Link
                          to={
                            `/album/${song.metadata.albumId}`
                          }
                          className="track-album"
                        >
                          {song.album ||
                            "Unknown album"}
                        </Link>

                      ) : (

                        <div className="track-album">
                          {song.album ||
                            "Unknown album"}
                        </div>

                      )}


                      {/* DOWNLOAD */}

                      <TrackDownloadButton song={song} />


                      {/* DURATION */}

                      <div className="track-duration">

                        {formatDuration(
                          song.metadata.durationSeconds
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
                          sources={song.source?.options}
                          onSelect={playSongFromSource}
                        />

                        <button
                          type="button"
                          className="track-menu"
                          aria-label={
                            `More options for ${song.title}`
                          }
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

                          <div
                            className="playlist-menu"
                            onMouseDown={(event) => {
                              event.stopPropagation();
                            }}
                          >

                            <div className="playlist-menu-title">
                              Add to playlist
                            </div>

                            <button
                              type="button"
                              className="playlist-menu-item"
                              onClick={(event) => {
                                event.stopPropagation();
                                startTrackRadio(song);
                              }}
                            >
                              <span>◉</span>
                              <span>Start radio</span>
                            </button>

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

                  )
                )}

              </div>

            </section>

          )}


          {results.playlist.length > 0 && (

            <section className="section search-group search-group-playlists">

              <div className="section-header">

                <h2>
                  Playlists
                </h2>

              </div>


              <div className="search-results">

                {results.playlist.map(
                  (playlist) => (

                    <Link
                      key={playlist.id}
                      to={`/playlist/${playlist.id}`}
                      className="search-result"
                    >

                      <div className="search-result-info">

                        <div className="search-result-title">
                          {playlist.title}
                        </div>

                        <div className="search-result-type">
                          Playlist
                        </div>

                      </div>

                    </Link>

                  )
                )}

              </div>

            </section>

          )}

        </div>

      )}

    </div>

  );

}


export default Search;
