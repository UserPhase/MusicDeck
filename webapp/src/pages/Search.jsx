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

import ArtistAvatar from "../components/ArtistAvatar";
import AvailabilityHint from "../components/AvailabilityHint";
import PlaylistCover from "../components/PlaylistCover";
import SourceIndicator from "../components/SourceIndicator";
import LightHero from "../components/Layout/LightHero";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useViewStateValue } from "../hooks/useViewStateStore";
import InLibraryBadge from "../components/InLibraryBadge";
import TrackListHeader from "../components/TrackListHeader";
import TrackRow from "../components/TrackRow";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { usePrivacy } from "../context/PrivacyContext";
import { toAlbumRouteIdFromApiId, toArtistRouteIdFromApiId } from "../utils/idResolver";
import { MOBILE_LAYOUT_QUERY } from "../utils/layoutPreset";
import TrackArtistLinks from "../components/TrackArtistLinks";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../components/ui/PageState";


import {
  usePlayer,
} from "../context/PlayerContext";

const CATEGORIES = [
  { id: "songs", type: "track", label: "Songs", preview: 3 },
  { id: "albums", type: "album", label: "Albums", preview: 2 },
  { id: "artists", type: "artist", label: "Artists", preview: 2 },
  { id: "playlists", type: "playlist", label: "Playlists", preview: 2 },
];

function SearchHero({ title, query, onSearch, isMobile, category, chooseCategory, categoryControls }) {
  const [draft, setDraft] = useState(query);
  const input = useRef(null);
  useEffect(() => { setDraft(query); }, [query]);
  function handleSubmit(event) {
    event.preventDefault();
    onSearch(new FormData(event.currentTarget).get("q").trim());
  }

  return (
    <div className="page-hero-gradient">
      <LightHero className="search-page-hero" title={title}>
        {isMobile && (
          <>
            <form className="search-page-form" role="search" aria-label="Music search" onSubmit={handleSubmit}>
              <div className="search-input-field">
                <input ref={input} type="search" name="q" value={draft} onChange={(event) => setDraft(event.target.value)}
                  enterKeyHint="search" placeholder="Search your music" aria-label="Search your music" autoComplete="off" />
                {draft && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => {
                  setDraft(""); onSearch(""); input.current?.focus();
                }}>×</button>}
              </div>
              <button type="submit">Search</button>
            </form>
            <div className="search-categories" role="group" aria-label="Result type" ref={categoryControls}>
              {[{ id: "all", label: "All" }, ...CATEGORIES].map(({ id, label }) => (
                <button key={id} type="button" data-category={id} aria-pressed={category === id}
                  onClick={() => chooseCategory(id)}>{label}</button>
              ))}
            </div>
          </>
        )}
      </LightHero>
    </div>
  );
}

function Search() {
  const deletion = useServerDeletion();
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);

  const [
    searchParams,
    setSearchParams,
  ] = useSearchParams();


  const [savedQuery, setSavedQuery] = useViewStateValue("/search", "query", "");
  const query = searchParams.has("q") ? searchParams.get("q") || "" : savedQuery;
  useEffect(() => { setSavedQuery(query); }, [query, setSavedQuery]);
  const categoryControls = useRef(null);
  const chosenCategory = isMobile && CATEGORIES.find(({ id }) => id === searchParams.get("category"));
  const category = chosenCategory?.id ?? "all";
  const shownCategories = chosenCategory ? [chosenCategory] : CATEGORIES;

  function chooseCategory(next) {
    if (next === category) return;
    const params = new URLSearchParams(searchParams);
    if (query && !params.has("q")) params.set("q", query);
    if (next === "all") params.delete("category");
    else params.set("category", next);
    setSearchParams(params);
  }

  function searchFor(term) {
    if (term !== query) setSearchParams(chosenCategory ? { q: term, category } : { q: term });
  }


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

  const playableResults = isMobile && deletion?.deletedTracks?.size
    ? results.track.filter((song) => !deletion.deletedTracks.has(String(song.id))) : results.track;

  function handleTrackPlayback(song, index) {
    playContext(playableResults, index, {
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

  const searchHeroProps = { query, onSearch: searchFor, isMobile, category, chooseCategory, categoryControls };


  /*
   * EMPTY SEARCH
   */

  if (!query.trim()) {

    return (

      <div className="search-page">

        <SearchHero title="Search" {...searchHeroProps} />


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

        <SearchHero title="Search" {...searchHeroProps} />


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

        <SearchHero title="Search" {...searchHeroProps} />

        <ErrorState>
          {error}
        </ErrorState>

      </div>

    );

  }


  const availableResults = {
    ...results,
    track: playableResults,
    album: deletion?.deletedAlbums?.size
      ? results.album.filter((album) => !deletion.deletedAlbums.has(String(album.id))) : results.album,
  };
  const hasResults = shownCategories.some(({ type }) => availableResults[type].length > 0);


  return (

    <div className="search-page" data-view-loading={externalLoading || resolvedSearch !== `${query}\u001f${sourceMode}`}>


      {/* HEADER */}

      <SearchHero title="Search results" {...searchHeroProps} />


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
          {chosenCategory ? `No ${chosenCategory.label.toLowerCase()} found.` : "No results found."}
        </EmptyState>

      ) : hasResults ? (

        <div className="search-groups">
          {shownCategories.filter(({ type }) => availableResults[type].length > 0).map(({ id, type, label, preview }) => {
            const matches = availableResults[type];
            const items = isMobile && category === "all" ? matches.slice(0, preview) : matches;
            const headingId = `search-results-${id}`;

            return <section key={id} className={`${type === "track" ? "library-section" : "section"} search-group search-group-${id}`}
              aria-labelledby={headingId}>
              <div className={type === "track" ? "library-section-header" : "section-header"}>
                <h2 id={headingId}>{label}</h2>
                {items.length < matches.length && <button className="search-category-more" type="button"
                  aria-label={`See all ${label.toLowerCase()}`} onClick={() => {
                    categoryControls.current?.querySelector(`[data-category="${id}"]`)?.focus({ preventScroll: true });
                    chooseCategory(id);
                  }}>See all</button>}
              </div>

              {type === "track" && <div className="track-list track-list--mobile" role="table" aria-label="Search tracks">
                {!isMobile && <TrackListHeader />}
                <TrackActionScope tracks={items} dataKey={`${query}:${sourceMode}:${category}`}>
                  {items.map((song, index) => <TrackRow key={song.id} song={song} index={index}
                    mobile={isMobile} showDownloadStatus={false} showSourceIndicator
                    duration={song.metadata?.durationSeconds} sources={song.source?.options}
                    onPlay={handleTrackPlayback} onSelectSource={playSongFromSource} />)}
                </TrackActionScope>
              </div>}

              {type === "album" && <div className="album-grid">
                {items.map((album) => <div key={album.id} className="album-card-shell search-album-card">
                  <Link className="see-all"
                    to={`/album/${encodeURIComponent(toAlbumRouteIdFromApiId(album.localAlbumId || album.id))}`}>
                    <div className="album-cover">
                      {album.coverArt && <img src={getCoverUrl(album.coverArt, isMobile ? 300 : undefined)}
                        alt={`${album.title} cover`} loading="lazy" decoding="async" />}
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
                </div>)}
              </div>}

              {type === "artist" && <div className={isMobile ? "artist-grid" : "search-results"}>
                {items.map((artist) => <Link key={artist.id}
                  to={`/artist/${encodeURIComponent(toArtistRouteIdFromApiId(artist.id))}`}
                  className={isMobile ? "artist" : "search-result"}>
                  {isMobile ? <>
                    <ArtistAvatar artist={artist} className="artist-cover" enableMusicBrainzFallback deferUntilVisible />
                    <div className="artist-name">{artist.title}</div>
                  </> : <div className="search-result-info">
                    <div className="search-result-title">{artist.title}</div>
                    <div className="search-result-type">
                      Artist
                      <AvailabilityHint availability={artist.availability} />
                      <SourceIndicator source={artist.source} />
                    </div>
                  </div>}
                </Link>)}
              </div>}

              {type === "playlist" && <div className="search-results">
                {items.map((playlist) => <Link key={playlist.id} to={`/playlist/${playlist.id}`} className="search-result">
                  <div className="search-result-cover">
                    <PlaylistCover playlist={playlist} size={160} />
                  </div>
                  <div className="search-result-info">
                    <div className="search-result-title">{playlist.title}</div>
                    <div className="search-result-type">Playlist</div>
                  </div>
                </Link>)}
              </div>}
            </section>;
          })}
        </div>

      ) : null}

    </div>

  );

}


export default Search;
