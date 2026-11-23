import { useCallback, useEffect, useState } from "react";
import { getAlbumPage } from "../api/musicdeck";
import AlbumGrid from "../components/AlbumGrid";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import { usePagedLibrary } from "../hooks/usePagedLibrary";
import { useViewStateValue } from "../hooks/useViewStateStore";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";

const PAGE_SIZE = 100;
const sortChoices = {
  library: "Library order", az: "A-Z", za: "Z-A", newest: "Newest release", oldest: "Oldest release",
  artist: "Artist (A-Z)", artistReverse: "Artist (Z-A)",
};

function Albums() {
  const [sort, setSort] = useState("library");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 180);
    return () => clearTimeout(timer);
  }, [search]);

  const deletion = useServerDeletion();
  const deletedAlbums = deletion?.deletedAlbums;
  const excludeAlbum = useCallback((album) => Boolean(deletedAlbums?.has(String(album.id))), [deletedAlbums]);
  const loadPage = useCallback(options => getAlbumPage({ ...options, query, sort }), [query, sort]);
  const library = usePagedLibrary(loadPage, excludeAlbum, PAGE_SIZE);
  const loadRange = library.onRangeChange;
  const [, setPageIndex] = useViewStateValue("/library/albums", "pageIndex", 0);
  const onRangeChange = useCallback((start, end) => {
    loadRange(start, end);
    setPageIndex(Math.floor(start / PAGE_SIZE));
  }, [loadRange, setPageIndex]);
  return <section className="library-section" data-view-loading={library.loading}>
    <div className="library-section-header">
      <h2>Albums</h2>
      {!library.loading && <span>{library.total} {library.total === 1 ? "album" : "albums"}</span>}
      <LibraryBrowseControls label="albums" query={search} onQueryChange={value => setSearch(Array.from(value).slice(0, 200).join(""))}
        sort={sort} onSortChange={setSort} sortChoices={sortChoices} keepSearchOpen />
    </div>
    {library.loading && <LoadingState>Loading albums...</LoadingState>}
    {library.error && <ErrorState>{library.error} <button type="button" onClick={library.retry}>Retry</button></ErrorState>}
    {!library.loading && !library.total && !library.error && <EmptyState>{query ? "No albums match your search." : "No albums yet."}</EmptyState>}
    {!library.loading && <AlbumGrid itemCount={library.total} onRangeChange={onRangeChange} getItem={library.getItem} />}
  </section>;
}

export default Albums;
