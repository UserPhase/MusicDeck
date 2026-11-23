import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayerActions } from "../context/PlayerItemState";
import { getTrackPage, trackLibraryFilters } from "../api/musicdeck";

import TrackListHeader from "../components/TrackListHeader";
import VirtualizedTrackList from "../components/VirtualizedTrackList";
import { usePagedLibrary } from "../hooks/usePagedLibrary";
import { useMediaQuery } from "../hooks/useMediaQuery";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import { useViewStateValue } from "../hooks/useViewStateStore";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { normalizePlaylistSearch } from "../utils/playlistSearch";
import { libraryTrackSorts } from "../types/libraryTracks";
import { MOBILE_LAYOUT_QUERY } from "../utils/layoutPreset";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";

const PAGE_SIZE = 100;

function Tracks() {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { playLibraryTracks } = usePlayerActions();
  const deletion = useServerDeletion();
  const deletedTracks = deletion?.deletedTracks;
  const excludeTrack = useCallback((song) => Boolean(deletedTracks?.has(String(song.id))), [deletedTracks]);
  const [filters, setFilters] = useViewStateValue("/library/tracks", "filters", { favoritesOnly: false, unplayedOnly: false });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 180);
    return () => clearTimeout(timer);
  }, [search]);
  const [sort, setSort] = useState("custom");
  const [field, direction] = sort.split("-");
  const sortBy = useCallback((field) => setSort((current) =>
    field === "custom" ? "custom" : `${field}-${current === field + "-asc" ? "desc" : "asc"}`), []);
  const viewQuery = useMemo(() => ({
    query, sort, favoritesOnly: Boolean(filters.favoritesOnly), unplayedOnly: Boolean(filters.unplayedOnly),
  }), [query, sort, filters.favoritesOnly, filters.unplayedOnly]);
  const loadPage = useCallback((options) => getTrackPage({
    ...options, ...viewQuery, filters: trackLibraryFilters(viewQuery),
  }), [viewQuery]);
  const library = usePagedLibrary(loadPage, excludeTrack, PAGE_SIZE);
  const total = library.total;
  const selectionIdentity = useMemo(() => ({ viewQuery, revision: library.collectionRevision, deletedTracks }),
    [viewQuery, library.collectionRevision, deletedTracks]);
  const searchTokens = useMemo(() => normalizePlaylistSearch(query).split(/\s+/).filter(Boolean), [query]);
  const loadRange = library.onRangeChange;
  const [, setPageIndex] = useViewStateValue("/library/tracks", "pageIndex", 0);
  const onRangeChange = useCallback((start, end) => {
    loadRange(start, end);
    setPageIndex(Math.floor(start / PAGE_SIZE));
  }, [loadRange, setPageIndex]);

  const [actionError, setActionError] = useState("");
  const [preparingQueue, setPreparingQueue] = useState(false);
  const playbackRequest = useRef(null);

  useEffect(() => {
    setPreparingQueue(false);
    setActionError("");
    return () => playbackRequest.current?.abort();
  }, [viewQuery]);

  const startPlayback = useCallback(async (song, shuffle) => {
    playbackRequest.current?.abort();
    const request = new AbortController();
    playbackRequest.current = request;
    setPreparingQueue(true);
    setActionError("");
    try {
      await playLibraryTracks({
        query: viewQuery,
        trackId: song ? String(song.id) : null,
        ...(shuffle !== undefined && { shuffle }),
      }, request.signal, deletedTracks);
    } catch (error) {
      if (!request.signal.aborted) setActionError(error.message || "Could not play the library.");
    } finally {
      if (playbackRequest.current === request && !request.signal.aborted) setPreparingQueue(false);
    }
  }, [viewQuery, playLibraryTracks, deletedTracks]);
  const handleTrackPlayback = useCallback((song) => {
    if (search.trim() === viewQuery.query) return startPlayback(song);
  }, [search, startPlayback, viewQuery.query]);
  const searching = search.trim() !== query;
  const playbackDisabled = searching || library.loading || !total || preparingQueue;

  return <section className="library-section" data-view-loading={library.loading}>
    <div className="library-track-toolbar">
      <div className="search-mode" aria-label="Library filters">
        {[["favoritesOnly", "Favorites"], ["unplayedOnly", "Unplayed"]].map(([key, label]) =>
          <button key={key} type="button" className={`search-mode-option ${filters[key] ? "active" : ""}`}
            aria-pressed={filters[key]} onClick={() => setFilters((current) => ({ ...current, [key]: !current[key] }))}>
            {label}
          </button>)}
      </div>
      {!library.loading && <span className="library-track-count">{total} {total === 1 ? "song" : "songs"}</span>}
      <div className="library-track-playback" aria-label="Library playback" role="group">
        <button className="folder-sort-trigger" type="button" disabled={playbackDisabled} onClick={() => startPlayback(null, false)}>Play all</button>
        <button className="folder-sort-trigger" type="button" disabled={playbackDisabled} onClick={() => startPlayback(null, true)}>Shuffle all</button>
      </div>
      <LibraryBrowseControls label="tracks" query={search} onQueryChange={value => setSearch(Array.from(value).slice(0, 200).join(""))} keepSearchOpen
        sort={sort} onSortChange={setSort} sortChoices={libraryTrackSorts} />
    </div>
    {library.loading && <LoadingState>Loading your songs...</LoadingState>}
    {preparingQueue && <div role="status">Preparing playback...</div>}
    {actionError && <ErrorState>{actionError}</ErrorState>}
    {library.error && <ErrorState>{library.error} <button type="button" onClick={library.retry}>Retry</button></ErrorState>}
    {!library.loading && <div className="track-list track-list--mobile" role="table" aria-label="Tracks"
      aria-rowcount={mobile ? total || undefined : total + 1}>
      {!mobile && <TrackListHeader sort={{ field, descending: direction === "desc", onChange: sortBy }} showDateAdded={false} />}
      {!total && !library.error && <EmptyState>{query || filters.favoritesOnly || filters.unplayedOnly ? "No songs match these filters." : "No songs yet."}</EmptyState>}
      <VirtualizedTrackList itemCount={total} mobile={mobile} getItem={library.getItem}
        searchTokens={searchTokens}
        loadSelection={library.loadSelection}
        onRangeChange={onRangeChange} dataKey={selectionIdentity} dynamicHeight
        onPlay={handleTrackPlayback} />
    </div>}
  </section>;
}

export default Tracks;
