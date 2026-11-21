import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getPlaylists } from "../api/playlists";
import PlaylistCover, { LikedSongsCover } from "../components/PlaylistCover";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import LikedAlbumsSection from "../components/LikedAlbumsSection";
import SmartPlaylistShelf from "../components/SmartPlaylistShelf";
import { usePlayer } from "../context/PlayerContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSmartPlaylists } from "../hooks/useSmartPlaylists";
import { MOBILE_LAYOUT_QUERY } from "../utils/layoutPreset";
import { normalizePlaylistSearch } from "../utils/playlistSearch";
import MobilePlaylists from "./MobilePlaylists";

const playlistFilters = { all: "All playlists", regular: "Regular playlists", smart: "Smart playlists" };
const playlistSorts = { az: "A\u2013Z", za: "Z\u2013A", newest: "Newest", oldest: "Oldest" };
const compareNames = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;

function comparePlaylists(left, right, sort) {
  const byName = compareNames(left.name, right.name);
  if (sort === "az") return byName;
  if (sort === "za") return -byName;
  const leftDate = Date.parse(left.createdAt);
  const rightDate = Date.parse(right.createdAt);
  if (Number.isFinite(leftDate) !== Number.isFinite(rightDate)) return Number.isFinite(leftDate) ? -1 : 1;
  return (sort === "newest" ? rightDate - leftDate : leftDate - rightDate) || byName;
}

function DesktopPlaylists({ playlists, loading, error, smart, likedCount }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("az");
  const search = normalizePlaylistSearch(query.trim());
  const matches = playlist => normalizePlaylistSearch(playlist.name).includes(search);
  const ordered = items => items.filter(matches).sort((left, right) => comparePlaylists(left, right, sort));
  const visible = filter === "smart" ? [] : ordered(playlists);
  const smartItems = filter === "regular" ? [] : ordered(smart.items);
  const total = visible.length + smartItems.length;
  const ready = !loading && !error;

  return <section className="library-section">
    <div className="library-section-header">
      <h2>Playlists</h2>
      {ready && <>
        <span>{total + 1} {total === 0 ? "playlist" : "playlists"}</span>
        <LibraryBrowseControls label="playlists" query={query} onQueryChange={setQuery} filter={filter}
          onFilterChange={setFilter} choices={playlistFilters} sort={sort} onSortChange={setSort} sortChoices={playlistSorts} />
      </>}
    </div>
    <div className="playlist-grid">
      <Link to="/liked" className="playlist-card" aria-label="Liked Songs">
        <LikedSongsCover className="playlist-cover playlist-cover--liked" />
        <div className="playlist-title">Liked Songs</div>
        <div className="playlist-meta">Pinned {"\u00b7"} {likedCount} {likedCount === 1 ? "song" : "songs"}</div>
      </Link>
      {ready && visible.map((playlist) => <Link key={playlist.id} to={`/playlist/${encodeURIComponent(playlist.id)}`} className="playlist-card">
        <div className="playlist-cover"><PlaylistCover playlist={playlist} size={300} /></div>
        <div className="playlist-title">{playlist.name}</div>
        <div className="playlist-meta">{playlist.songCount || 0} {playlist.songCount === 1 ? "song" : "songs"}</div>
      </Link>)}
      {ready && total === 0 && (filter === "regular" || (!smart.loading && !smart.error)) && (
        <div className="playlist-empty">{search || filter !== "all" ? "No other playlists match these filters." : "No other playlists yet."}</div>
      )}
    </div>
    {loading && <div className="loading">Loading playlists...</div>}
    {error && <div className="error">{error}</div>}
    {ready && filter !== "regular" && <SmartPlaylistShelf {...smart} items={smartItems} />}
  </section>;
}

export default function Playlists() {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const smart = useSmartPlaylists();
  const player = usePlayer();

  useEffect(() => {
    let mounted = true, sequence = 0;
    async function loadPlaylists() {
      const request = ++sequence;
      try {
        const data = await getPlaylists();
        if (mounted && request === sequence) {
          setPlaylists(data);
          setError(null);
        }
      } catch (err) {
        if (mounted && request === sequence) setError(err.message || "Could not load playlists.");
      } finally {
        if (mounted && request === sequence) setLoading(false);
      }
    }
    void loadPlaylists();
    window.addEventListener("playlistsChanged", loadPlaylists);
    return () => { mounted = false; window.removeEventListener("playlistsChanged", loadPlaylists); };
  }, []);

  return <>
    {mobile ? <MobilePlaylists playlists={playlists} loading={loading} error={error} smart={smart} player={player} />
      : <DesktopPlaylists playlists={playlists} loading={loading} error={error} smart={smart} likedCount={player?.likedSongIds?.size ?? 0} />}
    <LikedAlbumsSection />
  </>;
}
