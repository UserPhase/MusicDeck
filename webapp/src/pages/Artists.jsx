import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getArtists } from "../api/musicdeck";
import ArtistAvatar from "../components/ArtistAvatar";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";
import { normalizePlaylistSearch } from "../utils/playlistSearch";

const PAGE_SIZE = 100;
const artistSorts = { az: "A-Z", za: "Z-A", most: "Most albums", fewest: "Fewest albums" };
const compareNames = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;

function Artists() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("az");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [artists, setArtists] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const search = normalizePlaylistSearch(query.trim());
  const matches = useMemo(() => (artists || []).filter(artist => normalizePlaylistSearch(artist.name).includes(search))
    .sort((left, right) => {
      const byName = compareNames(left.name, right.name);
      if (sort === "az" || sort === "za") return sort === "az" ? byName : -byName;
      const byCount = (left.albumCount ?? 0) - (right.albumCount ?? 0);
      return (sort === "most" ? -byCount : byCount) || byName;
    }), [artists, search, sort]);

  useEffect(() => {
    const controller = new AbortController();
    getArtists(controller.signal).then(result => {
      if (!controller.signal.aborted) setArtists(result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message || "Could not load artists.");
    });
    return () => controller.abort();
  }, [attempt]);

  return <section className="library-section">
    <div className="library-section-header">
      <h2>Artists</h2>
      {artists && <span>{matches.length} {matches.length === 1 ? "artist" : "artists"}</span>}
      {artists && <LibraryBrowseControls label="artists" query={query} sort={sort} sortChoices={artistSorts} keepSearchOpen
        onQueryChange={value => { setQuery(value); setVisibleCount(PAGE_SIZE); }}
        onSortChange={value => { setSort(value); setVisibleCount(PAGE_SIZE); }} />}
    </div>
    {!artists && !error && <LoadingState>Loading artists...</LoadingState>}
    {error && <ErrorState>{error} <button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry</button></ErrorState>}
    {artists && <>
      {matches.length === 0 && <EmptyState>{search ? "No artists match your search." : "No artists yet."}</EmptyState>}
      <div className="artist-grid">
        {matches.slice(0, visibleCount).map(artist => <Link key={artist.id} to={`/artist/${artist.id}`} className="artist group">
          <ArtistAvatar artist={artist} className="artist-cover" allowAlbumTileFallback enableMusicBrainzFallback deferUntilVisible />
          <div className="artist-name">{artist.name}</div>
        </Link>)}
      </div>
      {visibleCount < matches.length && <button type="button" className="folder-sort-trigger artist-grid-more"
        onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>Show more artists</button>}
    </>}
  </section>;
}

export default Artists;
