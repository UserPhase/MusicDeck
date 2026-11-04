import { useCallback, useMemo, useState } from "react";
import { getAlbumPage } from "../api/musicdeck";
import AlbumGrid from "../components/AlbumGrid";
import { usePagedLibrary } from "../hooks/usePagedLibrary";
import { useCollectorLibrary } from "../hooks/useCollectorLibrary";
import CollectorFilterBar from "../components/CollectorFilterBar";
import { useViewStateValue } from "../hooks/useViewStateStore";
import { useServerDeletion } from "../context/ServerDeletionContext";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";

const sortChoices = {
  library: "Library order", az: "A–Z", za: "Z–A", newest: "Newest release", oldest: "Oldest release",
  artist: "Artist (A–Z)", artistReverse: "Artist (Z–A)",
};
const compareText = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;

function releaseTime(album) {
  const date = Date.parse(album.releaseDate);
  if (Number.isFinite(date)) return date;
  return album.year > 0 ? Date.UTC(album.year, 0, 1) : NaN;
}

function compareAlbums(left, right, sort) {
  const byTitle = compareText(left.name, right.name);
  if (sort === "az" || sort === "za") return sort === "az" ? byTitle : -byTitle;
  if (sort === "artist" || sort === "artistReverse") {
    const byArtist = compareText(left.artist || "", right.artist || "");
    return (sort === "artist" ? byArtist : -byArtist) || byTitle;
  }
  const leftDate = releaseTime(left), rightDate = releaseTime(right);
  if (Number.isFinite(leftDate) !== Number.isFinite(rightDate)) return Number.isFinite(leftDate) ? -1 : 1;
  return (sort === "newest" ? rightDate - leftDate : leftDate - rightDate) || byTitle;
}

function Albums() {
  const [sort, setSort] = useState("library");
  const deletion = useServerDeletion();
  const deletedAlbums = deletion?.deletedAlbums;
  const excludeAlbum = useCallback((album) => Boolean(deletedAlbums?.has(String(album.id))), [deletedAlbums]);
  const library = usePagedLibrary(getAlbumPage, excludeAlbum);
  const collector = useCollectorLibrary("album", { exclude: excludeAlbum, sortActive: sort !== "library" });
  const items = useMemo(() => sort === "library" ? collector.items
    : [...collector.items].sort((left, right) => compareAlbums(left, right, sort)), [collector.items, sort]);
  const total = collector.showSnapshot ? items.length : library.total;
  const loadRange = library.onRangeChange;
  const [, setPageIndex] = useViewStateValue("/library/albums", "pageIndex", 0);
  const onRangeChange = useCallback((start, end) => {
    loadRange(start, end);
    setPageIndex(Math.floor(start / 200));
  }, [loadRange, setPageIndex]);
  return <section className="library-section" data-view-loading={library.loading}>
    <div className="library-section-header">
      <h2>Albums</h2>
      {!library.loading && <span>{total} albums</span>}
      <CollectorFilterBar {...collector.bar} sort={{ label: "Sort albums", value: sort, choices: sortChoices, onChange: setSort }} />
    </div>
    {library.loading && <LoadingState>Loading albums...</LoadingState>}
    {library.error && <ErrorState>{library.error} <button type="button" onClick={library.retry}>Retry</button></ErrorState>}
    {!library.loading && !total && !library.error && !collector.bar.busy && <EmptyState>{collector.active ? "No albums match these filters." : "No albums yet."}</EmptyState>}
    {!library.loading && <AlbumGrid itemCount={total} onRangeChange={collector.showSnapshot ? undefined : onRangeChange}
      getItem={collector.showSnapshot ? index => items[index] : library.getItem} />}
  </section>;
}

export default Albums;
