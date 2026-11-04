import { EditionBadges } from "../components/common/EditionBadges";
import TrackActionScope from "../components/TrackActionScope";
import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Link,
  useSearchParams,
} from "react-router-dom";

import { searchNavidrome, getCoverUrl, getUserSettings, updateUserSettings } from "../api/musicdeck";

import AvailabilityHint from "../components/AvailabilityHint";
import PlaylistCover from "../components/PlaylistCover";
import SourceIndicator from "../components/SourceIndicator";
import LightHero from "../components/Layout/LightHero";
import { useViewStateValue } from "../hooks/useViewStateStore";
import InLibraryBadge from "../components/InLibraryBadge";
import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { usePrivacy } from "../context/PrivacyContext";
import { toAlbumRouteIdFromApiId, toArtistRouteIdFromApiId } from "../utils/idResolver";
import TrackArtistLinks from "../components/TrackArtistLinks";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../components/ui/PageState";


import {
  usePlayer,
} from "../context/PlayerContext";

function SearchHero({ title }) {
  return (
    <div className="page-hero-gradient">
      <LightHero className="search-page-hero" title={title} />
    </div>
  );
}

function Search() {
  const deletion = useServerDeletion();

  const [
    searchParams,
  ] = useSearchParams();


  const [savedQuery, setSavedQuery] = useViewStateValue("/search", "query", "");
  const query = searchParams.has("q") ? searchParams.get("q") || "" : savedQuery;
  useEffect(() => { setSavedQuery(query); }, [query, setSavedQuery]);


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
  ] = useState(Boolean(query.trim()));
  const [externalLoading, setExternalLoading] = useState(false);
  const [resolvedSearch, setResolvedSearch] = useState("");


  const [
    error,
    setError,
  ] = useState(null);

  const [savedFilters, setSavedFilters] = useViewStateValue("/search", "filters", {});
  const [preferredSourceMode, setSourceMode] = useState(() => ["library", "hybrid", "external"].includes(savedFilters.sourceMode) ? savedFilters.sourceMode : "hybrid");
  const { canMetadata } = usePrivacy();
  const sourceMode = canMetadata ? preferredSourceMode : "library";
  const hasChosenSourceMode = useRef(Boolean(savedFilters.sourceMode));


  const {
    playContext,
    playSongFromSource,
  } = usePlayer();

  function handleTrackPlayback(song, index) {
    playContext(results.track, index, {
      type: "search",
      id: query,
      name: `Search: ${query}`,
      coverArt: null,
    });
  }


  useEffect(() => {
    let cancelled = false;

    Promise.resolve(getUserSettings())
      .then((settings) => {
        const stored = settings.find((setting) => setting.key === "catalog.sourceMode");
        const value = stored ? JSON.parse(stored.value) : "hybrid";

        if (!cancelled && !hasChosenSourceMode.current && ["library", "hybrid", "external"].includes(value)) {
          setSourceMode(value);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);


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
      setExternalLoading(false);
      setError(null);

      return () => {
        cancelled = true;
      };

    }


    const empty = { artist: [], album: [], track: [], playlist: [], degraded: false };
    setResults(empty);
    setError(null);
    setLoading(true);
    setExternalLoading(sourceMode !== "library");

    function addPhase(data, phase) {
      if (cancelled) return;
      setResults((current) => {
        const next = { ...current, degraded: current.degraded || Boolean(data?.degraded) };
        for (const type of ["artist", "album", "track", "playlist"]) {
          const incoming = data?.results?.[type] || [];
          const existing = current[type].filter((item) => !incoming.some((other) => other.id === item.id));
          next[type] = phase === "local" ? [...incoming, ...existing] : [...existing, ...incoming];
        }
        return next;
      });
    }

    async function run() {
      const local = sourceMode === "external" ? null : searchNavidrome(query, { mode: sourceMode, phase: "local" })
        .then((data) => addPhase(data, "local"))
        .finally(() => { if (!cancelled) setLoading(false); });
      const external = sourceMode === "library" ? null : searchNavidrome(query, { mode: sourceMode, phase: "external" })
        .then((data) => addPhase(data, "external"))
        .finally(() => {
          if (!cancelled) {
            setExternalLoading(false);
            if (sourceMode === "external") setLoading(false);
          }
        });
      const outcomes = await Promise.allSettled([local, external].filter(Boolean));
      if (!cancelled) setResolvedSearch(`${query}\u001f${sourceMode}`);
      if (!cancelled && outcomes.every((outcome) => outcome.status === "rejected")) {
        setError(outcomes[0]?.reason?.message || "Could not search your music.");
      }
    }

    run();

    return () => {
      cancelled = true;
    };

  }, [query, sourceMode]);

  function chooseSourceMode(mode) {
    if (mode === sourceMode) return;

    hasChosenSourceMode.current = true;
    setSourceMode(mode);
    setSavedFilters({ sourceMode: mode });
    updateUserSettings({ "catalog.sourceMode": mode }).catch(() => {});
  }


  /*
   * EMPTY SEARCH
   */

  if (!query.trim()) {

    return (

      <div className="search-page">

        <SearchHero title="Search" />


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

      <div className="search-page" data-view-loading="true">

        <SearchHero title="Search" />


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

        <SearchHero title="Search" />

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

    <div className="search-page" data-view-loading={externalLoading || resolvedSearch !== `${query}\u001f${sourceMode}`}>


      {/* HEADER */}

      <SearchHero title="Search results" />


      <div className="search-mode" role="group" aria-label="Search source">
        {(canMetadata ? ["library", "hybrid", "external"] : ["library"]).map((mode) => (
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

      {externalLoading && sourceMode === "hybrid" && (
        <p className="search-external-pending" role="status">Looking for more music…</p>
      )}


      {!hasResults && !externalLoading ? (

        <EmptyState>
          No results found.
        </EmptyState>

      ) : hasResults ? (

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
                      to={`/artist/${encodeURIComponent(toArtistRouteIdFromApiId(artist.id))}`}
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
                  (album) => deletion?.deletedAlbums.has(String(album.id)) ? null : (

                    <div key={album.id} className="album-card-shell">
                      <Link className="see-all"
                        to={`/album/${encodeURIComponent(toAlbumRouteIdFromApiId(album.localAlbumId || album.id))}`}>
                        <div className="album-cover">
                          {album.coverArt && <img src={getCoverUrl(album.coverArt)} alt={`${album.title} cover`} />}
                        </div>
                        <div className="album-title search-album-title">
                          <span className="search-album-title-text">{album.title}</span>
                          <InLibraryBadge visible={album.provider === "external" && album.inLibrary} />
                        </div>
                      </Link>
                      <div className="album-artist">
                        <TrackArtistLinks song={album} />
                        <AvailabilityHint availability={album.availability} />
                        <SourceIndicator source={album.source} />
                        <EditionBadges item={album} />
                      </div>

                    </div>

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


              <div className="track-list" role="table" aria-label="Search tracks">

                <TrackListHeader />

                <TrackActionScope tracks={results.track} dataKey={`${query}:${sourceMode}`}>
                {results.track.map(
                  (song, index) => (
                    <TrackRow
                      key={song.id}
                      song={song}
                      index={index}
                      showDownloadStatus={false}
                      showSourceIndicator
                      duration={song.metadata?.durationSeconds}
                      sources={song.source?.options}
                      onPlay={handleTrackPlayback}
                      onSelectSource={playSongFromSource}


                    />

                  )
                )}
        </TrackActionScope>

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

                      <div className="search-result-cover">

                        <PlaylistCover playlist={playlist} size={160} />

                      </div>


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

      ) : null}

    </div>

  );

}


export default Search;
