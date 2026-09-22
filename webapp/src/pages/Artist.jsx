import {
  useEffect,
  useState,
} from "react";

import {
  useParams,
  Link,
} from "react-router-dom";

import {
  getArtist,
  getAlbum,
  getCoverUrl,
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

function Artist() {

  const { id } = useParams();


  const [artist, setArtist] =
    useState(null);

  const [albums, setAlbums] =
    useState([]);

  const [songs, setSongs] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);

  const {
    playContext,
    playQueue,
    playSongFromSource,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();

  function handleTrackPlayback(song, index) {
    playContext(songs, index, {
      type: "artist",
      id: artist.id,
      name: artist.name,
      coverArt: artist.coverArt,
    });
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
   * Close playlist menu when
   * clicking anywhere outside it.
   */

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
   * Load artist
   */

  useEffect(() => {
    let cancelled = false;

    async function loadArtist() {

      try {

        setLoading(true);
        setError(null);


        /*
         * Get artist
         */

        const artistData =
          await getArtist(id);


        if (!artistData) {

          throw new Error(
            "Artist not found."
          );

        }


        if (cancelled) {
          return;
        }

        setArtist(
          artistData
        );


        /*
         * Get artist albums
         */

        const artistAlbums =
          artistData.album || [];


        setAlbums(
          artistAlbums
        );


        /*
         * Library artists derive songs from their albums. External detail
         * payloads already provide provider-neutral popular tracks.
         */

        const artistSongs = Array.isArray(artistData.tracks)
          ? artistData.tracks
          : (await Promise.all(
            artistAlbums
              // Catalog-only albums merged in from the external catalog
              // (zero local tracks) don't have a local track listing to
              // fetch — skip them here; they still render on the page via
              // `albums`, they just don't contribute to the derived
              // "popular tracks" list below.
              .filter((album) => album.source?.kind !== "external")
              .map((album) =>
                getAlbum(album.id).catch((err) => {
                  console.error("Could not load album tracks:", err);
                  return null;
                })
              )
          )).flatMap(
            (album) =>
              album?.song || []
          );


        if (!cancelled) {
          setSongs(
            artistSongs
          );
        }

      } catch (err) {

        console.error(
          "Could not load artist:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load artist."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadArtist();

    return () => {
      cancelled = true;
    };

  }, [id]);


  /*
   * Load playlists
   */

  async function loadPlaylists() {

    try {

      setPlaylistsLoading(true);


      const data =
        await getPlaylists();


      setPlaylists(
        data
      );

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

  async function togglePlaylistMenu(song) {

    /*
     * Clicking the same menu closes it.
     */

    if (
      playlistMenuSong?.id === song.id
    ) {

      setPlaylistMenuSong(null);

      return;

    }


    /*
     * Open this song's menu.
     */

    setPlaylistMenuSong(song);


    /*
     * Load playlists the first
     * time the menu is opened.
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
       * Close menu.
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
   * Play entire artist
   */

  function playArtist() {

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
   * Loading
   */

  if (loading) {

    return (

      <div className="artist-page">

        <div className="loading">
          Loading artist...
        </div>

      </div>

    );

  }


  /*
   * Error
   */

  if (
    error ||
    !artist
  ) {

    return (

      <div className="artist-page">

        <Link
          to="/library/artists"
          className="artist-back"
        >
          ← Back
        </Link>


        <div className="error">

          {error ||
            "Artist not found."}

        </div>

      </div>

    );

  }


  return (

    <div
      className="artist-page detail-hero-gradient"
    >


      {/* BACK */}

      <Link
        to="/library/artists"
        className="artist-back"
      >
        ← Back
      </Link>


      {/* ARTIST HEADER */}

      <div className="artist-header">


        {/* IMAGE */}

        <div className="artist-page-cover">

          {artist.coverArt ? (

            <img
              width="210"
              height="210"
              src={
                getCoverUrl(
                  artist.coverArt
                )
              }
              alt={
                `${artist.name}`
              }
            />

          ) : (

            <div className="artist-page-placeholder">
              ♪
            </div>

          )}

        </div>


        {/* INFO */}

        <div className="artist-page-info">

          <div className="artist-type">
            ARTIST
          </div>


          <h1>
            {artist.name}
          </h1>


          <div className="artist-meta">

            {albums.length}{" "}

            {albums.length === 1
              ? "album"
              : "albums"}

            {" · "}

            {songs.length}{" "}

            {songs.length === 1
              ? "song"
              : "songs"}

          </div>


        </div>

      </div>

      <div className="detail-action-row artist-actions">

            <button
              className="artist-play"
              onClick={
                playArtist
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

      </div>


      {/* ALBUMS */}

      {albums.length > 0 && (

        <section className="artist-albums">

          <div className="artist-section-header">

            <h2>
              Albums
            </h2>

          </div>


          <div className="album-grid">

            {albums.map(
              (album) => (

              <Link
                key={album.id}
                to={`/album/${album.id}`}
                className="album"
              >

                <div className="album-cover">

                  {album.coverArt ? (

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

                  ) : (

                    <div className="album-cover-placeholder">
                      ♪
                    </div>

                  )}

                </div>


                <div className="album-title">
                  {album.name}
                </div>


                {album.year && (

                  <div className="album-artist">
                    {album.year}
                  </div>

                )}

                {album.source?.kind === "external" && (

                  <div className="album-artist album-not-downloaded">
                    Not downloaded
                  </div>

                )}

              </Link>

            ))}

          </div>

        </section>

      )}


      {/* TRACKS */}

      <section className="artist-tracks">

        <div className="artist-section-header">

          <h2>
            Tracks
          </h2>

        </div>


        <div className="track-list">

          <TrackListHeader />

          {songs.length === 0 && (

            <div className="library-empty">
              No tracks yet.
            </div>

          )}

          {songs.map(
            (song, index) => (
            <TrackRow
              key={`${song.id}-${index}`}
              song={song}
              index={index}
              showDownloadStatus={false}
              showSourceIndicator
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
                          key={
                            playlist.id
                          }

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

          ))}

        </div>

      </section>


    </div>

  );

}


export default Artist;
