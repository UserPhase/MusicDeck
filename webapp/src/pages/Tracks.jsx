import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayerActions } from "../context/PlayerItemState";
import { getAllSongs, getTrackPage } from "../api/musicdeck";

import TrackListHeader from "../components/TrackListHeader";
import VirtualizedTrackList from "../components/VirtualizedTrackList";
import { usePagedLibrary } from "../hooks/usePagedLibrary";
import { useCollectorLibrary } from "../hooks/useCollectorLibrary";
import CollectorFilterBar from "../components/CollectorFilterBar";
import { useViewStateValue } from "../hooks/useViewStateStore";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";

const compareText = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;
const sortChoices = {
  custom: "Library order",
  "title-asc": "Title (A–Z)", "title-desc": "Title (Z–A)",
  "album-asc": "Album (A–Z)", "album-desc": "Album (Z–A)",
  "duration-asc": "Shortest first", "duration-desc": "Longest first",
};

function compareTracks(left, right, field, descending) {
  if (field === "duration") {
    const leftKnown = Number.isFinite(left.duration) && left.duration > 0;
    const rightKnown = Number.isFinite(right.duration) && right.duration > 0;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (!leftKnown) return 0;
    return descending ? right.duration - left.duration : left.duration - right.duration;
  }
  const order = compareText(left[field] || "", right[field] || "");
  return descending ? -order : order;
}

function Tracks() {
  const { playContext } = usePlayerActions();
  const deletion = useServerDeletion();
  const deletedTracks = deletion?.deletedTracks;
  const excludeTrack = useCallback((song) => Boolean(deletedTracks?.has(String(song.id))), [deletedTracks]);
  const [filters, setFilters] = useViewStateValue("/library/tracks", "filters", { favoritesOnly: false, unplayedOnly: false });
  const activeFilters = useMemo(() => [
    filters.favoritesOnly ? { field: "favorite", op: "boolean", value: true } : null,
    filters.unplayedOnly ? { field: "played", op: "boolean", value: false } : null,
  ].filter(Boolean), [filters]);
  const loadPage = useCallback((options) => getTrackPage({ ...options, filters: activeFilters }), [activeFilters]);
  const library = usePagedLibrary(loadPage, excludeTrack);
  const [sort, setSort] = useState({ field: "custom", descending: false });
  const sortActive = sort.field !== "custom";
  const sortBy = useCallback(field => setSort(current => ({
    field, descending: field !== "custom" && current.field === field && !current.descending,
  })), []);
  const collector = useCollectorLibrary("track", { ...filters, exclude: excludeTrack, sortActive });
  const collectorActive = collector.showSnapshot;
  const collectorItems = useMemo(() => sortActive
    ? [...collector.items].sort((left, right) => compareTracks(left, right, sort.field, sort.descending))
    : collector.items, [collector.items, sort, sortActive]);
  const total = collectorActive ? collectorItems.length : library.total;
  const getCollectorItem = useCallback(index => collectorItems[index], [collectorItems]);
  const selectionIdentity = useMemo(() => ({ filters: activeFilters, revision: library.collectionRevision, deletedTracks }), [activeFilters, library.collectionRevision, deletedTracks]);
  const loadRange = library.onRangeChange;
  const [, setPageIndex] = useViewStateValue("/library/tracks", "pageIndex", 0);
  const onRangeChange = useCallback((start, end) => {
    loadRange(start, end);
    setPageIndex(Math.floor(start / 200));
  }, [loadRange, setPageIndex]);


  const [actionError, setActionError] = useState("");
  const [preparingQueue, setPreparingQueue] = useState(false);
  const playbackRequest = useRef(0);

  useEffect(() => {
    playbackRequest.current += 1;

    setPreparingQueue(false);
    return () => { playbackRequest.current += 1; };
  }, [activeFilters, collectorActive, collectorItems]);

  const handleTrackPlayback = useCallback(async (song) => {
    const request = ++playbackRequest.current;
    setPreparingQueue(true);
    setActionError("");
    try {
      // Playback still receives the complete filtered collection, not just the
      // viewport's cached pages. Enumeration happens only on explicit play.
      let songs;
      if (collectorActive) {
        songs = collectorItems;
      } else if (!activeFilters.length) {
        songs = await getAllSongs();
      } else {
        songs = [];
        let total;
        do {
          const page = await getTrackPage({ filters: activeFilters, offset: songs.length });
          if (request !== playbackRequest.current) return;
          songs.push(...page.items);
          total = page.total;
          if (!page.items.length && songs.length < total) throw new Error("The library changed. Please try again.");
        } while (songs.length < total);
      }
      if (request !== playbackRequest.current) return;
      songs = songs.filter((item) => !excludeTrack(item));
      const index = songs.findIndex((item) => String(item.id) === String(song.id));
      if (index < 0) throw new Error("This track is no longer in the collection.");
      await playContext(songs, index, {
        type: "collection", id: "library-tracks", name: "Library Tracks", coverArt: null,
      });
    } catch (error) {
      console.error("Could not play library tracks:", error);
      if (request === playbackRequest.current) setActionError(error.message || "Could not play the collection.");
    } finally {
      if (request === playbackRequest.current) setPreparingQueue(false);
    }
  }, [activeFilters, collectorActive, collectorItems, excludeTrack, playContext]);


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
      <CollectorFilterBar {...collector.bar} sort={{
        label: "Sort tracks",
        value: sortActive ? `${sort.field}-${sort.descending ? "desc" : "asc"}` : "custom",
        choices: sortChoices,
        onChange: value => {
          const [field, direction] = value.split("-");
          setSort({ field, descending: direction === "desc" });
        },
      }} />
    </div>
    {library.loading && <LoadingState>Loading your songs...</LoadingState>}
    {preparingQueue && <div role="status">Preparing playback...</div>}
    {actionError && <ErrorState>{actionError}</ErrorState>}
    {library.error && <ErrorState>{library.error} <button type="button" onClick={library.retry}>Retry</button></ErrorState>}
    {!library.loading && <div className="track-list" role="table" aria-label="Tracks" aria-rowcount={total + 1}>
      <TrackListHeader sort={{ ...sort, onChange: sortBy }} showDateAdded={false} />
      {!total && !library.error && !collector.bar.busy && <EmptyState>{collectorActive ? "No songs match these filters." : "No songs yet."}</EmptyState>}
      <VirtualizedTrackList itemCount={total} getItem={collectorActive ? getCollectorItem : library.getItem}
        searchTokens={collector.searchTokens}
        loadSelection={collectorActive ? undefined : library.loadSelection}
        onRangeChange={collectorActive ? undefined : onRangeChange} dataKey={collectorActive ? collectorItems : selectionIdentity} dynamicHeight
        onPlay={handleTrackPlayback}   />
    </div>}
  </section>;
}

export default Tracks;
