import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  useParams,
  Link,
} from "react-router-dom";

import {
  getCoverUrl,
  matchLibraryItems,
} from "../api/musicdeck";
import { fetchArtistOverview } from "../api/artistOverviewQuery";
import ArtistAvatar from "../components/ArtistAvatar";
import ArtistBiography from "../components/ArtistBiography";
import InLibraryBadge from "../components/InLibraryBadge";
import { useArtistBiography } from "../hooks/useArtistBiography";

import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";

import {
  getPlaylists,
  addSongToPlaylist as addSongToPlaylistRequest,
} from "../api/playlists";

import {
  usePlayer,
} from "../context/PlayerContext";
import { useAuth } from "../context/AuthContext";

const ArtistAlbumCard = memo(function ArtistAlbumCard({ album }) {
  return (
    <Link to={`/album/${album.id}`} className="album">
      <div className="album-cover">
        {album.coverArt ? (
          <img src={getCoverUrl(album.coverArt, 300)} alt={`${album.name} cover`} loading="lazy" decoding="async" />
        ) : <div className="album-cover-placeholder">♪</div>}
      </div>
      <div className="album-title search-album-title">
        <span className="search-album-title-text">{album.name}</span>
        <InLibraryBadge visible={album.source?.kind === "external" && album.inLibrary} />
      </div>
      {album.year && <div className="album-artist">{album.year}</div>}
      {album.source?.kind === "external" && !album.inLibrary && (
        <div className="album-artist album-not-downloaded">Not downloaded</div>
      )}
    </Link>
  );
}, (previous, next) => ["id", "name", "coverArt", "year", "inLibrary"].every(
  (field) => previous.album[field] === next.album[field]
) && previous.album.source?.kind === next.album.source?.kind);

function ArtistBiographySection({ artist, songs }) {
  const localTrackId = songs.find((song) => song.id && song.source?.kind !== "external"
    && !String(song.id).startsWith("external_"))?.id;
  const { biography, loading } = useArtistBiography({
    artistId: artist.id, artistName: artist.name, trackId: localTrackId,
  });
  return (
    <section className="artist-about" aria-labelledby="artist-about-title">
      <div className="artist-section-header"><h2 id="artist-about-title">About {artist.name}</h2></div>
      <ArtistBiography biography={biography} loading={loading} />
    </section>
  );
}

function Artist() {

  const { id } = useParams();
  const userId = useAuth()?.session?.id;


  const [artist, setArtist] =
    useState(null);

  const [albums, setAlbums] =
    useState([]);
  const externalAlbumIds = albums.filter((album) => album.source?.kind === "external")
    .map((album) => album.id).join("|");

  useEffect(() => {
    const candidates = albums.filter((album) => album.source?.kind === "external");
    if (candidates.length === 0) return undefined;
    let cancelled = false;
    matchLibraryItems(candidates.map((album) => ({
      id: album.id, type: "album", title: album.name, artist: album.artist || artist?.name || "",
    }))).then((matches) => {
      if (cancelled) return;
      const byId = new Map(matches.map((match) => [match.id, match]));
      setAlbums((current) => current.map((album) => {
        const match = byId.get(album.id);
        return match ? { ...album, inLibrary: match.inLibrary, localAlbumId: match.localAlbumId } : album;
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  // The ID set changes only when a new discography arrives, not when badges update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalAlbumIds, artist?.name]);

  const [songs, setSongs] =
    useState([]);

  const [songCount, setSongCount] =
    useState(0);

  const [albumCount, setAlbumCount] =
    useState(0);

  const [loading, setLoading] =
    useState(true);

  const [enriching, setEnriching] =
    useState(false);

  const [error, setError] =
    useState(null);

  const {
    playContext,
    playQueue,
    playSongFromSource,
    isShuffleEnabled,
    toggleShuffle,
  } = usePlayer();

  const handleTrackPlayback = useCallback((song, index) => {
    if (!artist) return;
    playContext(songs, index, {
      type: "artist",
      id: artist.id,
      name: artist.name,
      coverArt: artist.coverArt,
    });
  }, [artist, playContext, songs]);


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
  const playlistMenuSongRef = useRef(null);
  const playlistsRef = useRef([]);
  playlistMenuSongRef.current = playlistMenuSong;
  playlistsRef.current = playlists;


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

    function showOverview(overview) {
      const artistData = overview.artist;
      if (!artistData || String(artistData.id) !== String(id)) {
        throw new Error("Artist not found.");
      }
      if (cancelled) return;

      const artistAlbums = (artistData.album || []).filter((album) =>
        !album.artistId || String(album.artistId) === String(id)
      );
      const artistSongs = (Array.isArray(overview.tracks) ? overview.tracks : [])
        .filter((song) => {
          const songArtistId = song.artistId || song.metadata?.artistId;
          return !songArtistId || String(songArtistId) === String(id);
        });
      const rankedSongs = Array.isArray(overview.topTracks)
        ? overview.topTracks
        : artistSongs.slice().sort((left, right) => (right.playCount || 0) - (left.playCount || 0));
      const popularSongs = rankedSongs.filter((song) => {
        const songArtistId = song.artistId || song.metadata?.artistId;
        return !songArtistId || String(songArtistId) === String(id);
      }).slice(0, 10);

      setArtist(artistData);
      setAlbums(artistAlbums);
      setSongs(popularSongs);
      setSongCount(typeof overview.localSongCount === "number" && artistData.source?.kind !== "external"
        ? overview.localSongCount : artistSongs.length);
      setAlbumCount(typeof overview.localAlbumCount === "number" && artistData.source?.kind !== "external"
        ? overview.localAlbumCount : artistAlbums.length);
    }

    async function loadArtist() {

      try {

        setLoading(true);
        setEnriching(false);
        setError(null);

        const isExternal = id.startsWith("external_") || id.startsWith("extdetail_");
        const initial = await fetchArtistOverview(id, isExternal ? undefined : "local", userId);
        if (cancelled) return;
        showOverview(initial);
        setLoading(false);

        if (initial.externalEnrichmentAvailable) {
          setEnriching(true);
          try {
            const complete = await fetchArtistOverview(id, undefined, userId);
            if (!cancelled) showOverview(complete);
          } catch (enrichmentError) {
            // The ID-scoped local page remains usable if the keyless catalog is slow or unavailable.
            console.error("Could not load more artist releases:", enrichmentError);
          } finally {
            if (!cancelled) setEnriching(false);
          }
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

  }, [id, userId]);


  /*
   * Load playlists
   */

  const loadPlaylists = useCallback(async () => {

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

  }, []);


  /*
   * Open / close playlist menu
   */

  const togglePlaylistMenu = useCallback(async (song) => {

    /*
     * Clicking the same menu closes it.
     */

    if (
      playlistMenuSongRef.current?.id === song.id
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
      playlistsRef.current.length === 0
    ) {

      await loadPlaylists();

    }

  }, [loadPlaylists]);


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

      <div className="artist-page detail-hero-gradient artist-page-loading" aria-label="Loading artist" aria-busy="true">
        <div className="artist-back artist-skeleton artist-skeleton-back" />
        <div className="artist-header">
          <div className="artist-page-cover artist-skeleton" />
          <div className="artist-page-info artist-skeleton-info">
            <div className="artist-skeleton artist-skeleton-kicker" />
            <div className="artist-skeleton artist-skeleton-name" />
            <div className="artist-skeleton artist-skeleton-meta" />
          </div>
        </div>
        <div className="artist-albums">
          <div className="artist-skeleton artist-skeleton-section-title" />
          <div className="artist-skeleton-albums">
            {Array.from({ length: 5 }, (_, index) => <div className="artist-skeleton artist-skeleton-album" key={index} />)}
          </div>
        </div>
        <div className="artist-tracks">
          <div className="artist-skeleton artist-skeleton-section-title" />
          <div className="artist-skeleton-rows">
            {Array.from({ length: 10 }, (_, index) => <div className="artist-skeleton artist-skeleton-row" key={index} />)}
          </div>
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

        <ArtistAvatar key={id} artist={artist} className="artist-page-cover" enableMusicBrainzFallback />


        {/* INFO */}

        <div className="artist-page-info">

          <div className="artist-type">
            ARTIST
          </div>


          <h1>
            {artist.name}
          </h1>


          <div className="artist-meta">

            {albumCount}{" "}

            {albumCount === 1
              ? "album"
              : "albums"}

            {" · "}

            {songCount}{" "}

            {songCount === 1
              ? "song"
              : "songs"}

            {artist.source?.kind !== "external" && " in library"}

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


      <ArtistBiographySection artist={artist} songs={songs} />


      {/* ALBUMS */}

      {(albums.length > 0 || enriching) && (

        <section className="artist-albums">

          <div className="artist-section-header">

            <h2>
              Albums
            </h2>

            {enriching && <span className="artist-enrichment-status" role="status">Finding more releases…</span>}

          </div>


          <div className="album-grid">

            {albums.map((album) => <ArtistAlbumCard key={album.id} album={album} />)}

          </div>

        </section>

      )}


      {/* TRACKS */}

      <section className="artist-tracks">

        <div className="artist-section-header">

          <h2>Top 10 Popular Tracks</h2>

        </div>


        <div className="track-list" role="table" aria-label="Artist tracks">

          <TrackListHeader />

          {songs.length === 0 && !enriching && (

            <div className="artist-tracks-empty" role="row">
              <span role="cell">No tracks yet.</span>
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
