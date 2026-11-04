import {
  useEffect,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  getPlaylists,
} from "../api/playlists";

import PlaylistCover from "../components/PlaylistCover";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import { normalizePlaylistSearch } from "../utils/playlistSearch";
import LikedAlbumsSection from "../components/LikedAlbumsSection";
import SmartPlaylistShelf from "../components/SmartPlaylistShelf";
import { useSmartPlaylists } from "../hooks/useSmartPlaylists";


const playlistFilters = { all: "All playlists", regular: "Regular playlists", smart: "Smart playlists" };
const playlistSorts = { az: "A–Z", za: "Z–A", newest: "Newest", oldest: "Oldest" };
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

function PlaylistGrid() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("az");
  const smart = useSmartPlaylists();

  const [playlists, setPlaylists] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);
  const search = normalizePlaylistSearch(query.trim());
  const matches = playlist => normalizePlaylistSearch(playlist.name).includes(search);
  const ordered = items => items.filter(matches).sort((left, right) => comparePlaylists(left, right, sort));
  const visible = filter === "smart" ? [] : ordered(playlists);
  const smartItems = filter === "regular" ? [] : ordered(smart.items);
  const total = visible.length + smartItems.length;


  /*
   * Load playlists
   */

  useEffect(() => {
    let mounted = true, sequence = 0;

    async function loadPlaylists(quiet = false) {
      const request = ++sequence;

      try {

        if (!quiet) setLoading(true);

        setError(null);


        const data =
          await getPlaylists();


        if (mounted && request === sequence) setPlaylists(data);

      } catch (err) {

        console.error(
          "Could not load playlists:",
          err
        );


        if (mounted && request === sequence) setError(
          err.message ||
          "Could not load playlists."
        );

      } finally {

        if (mounted && request === sequence) setLoading(false);

      }

    }


    loadPlaylists();
    const changed = () => { void loadPlaylists(true); };
    window.addEventListener("playlistsChanged", changed);
    return () => { mounted = false; window.removeEventListener("playlistsChanged", changed); };
  }, []);


  /*
   * Loading
   */

  if (loading) {

    return (

      <section className="library-section">

        <div className="library-section-header">

          <h2>
            Playlists
          </h2>

        </div>


        <div className="loading">
          Loading playlists...
        </div>

      </section>

    );

  }


  /*
   * Error
   */

  if (error) {

    return (

      <section className="library-section">

        <div className="library-section-header">

          <h2>
            Playlists
          </h2>

        </div>


        <div className="error">
          {error}
        </div>

      </section>

    );

  }


  return (

    <section className="library-section">


      {/* HEADER */}

      <div className="library-section-header">

        <h2>
          Playlists
        </h2>


        <span>
          {total} playlists
        </span>
        <LibraryBrowseControls label="playlists" query={query} onQueryChange={setQuery} filter={filter}
          onFilterChange={setFilter} choices={playlistFilters} sort={sort} onSortChange={setSort} sortChoices={playlistSorts} />

      </div>


      {/* PLAYLIST GRID */}

      <div className="playlist-grid">

        {visible.map(
          (playlist) => (

          <Link
            key={playlist.id}
            to={`/playlist/${playlist.id}`}
            className="playlist-card"
          >


            {/* COVER */}

            <div className="playlist-cover">

              <PlaylistCover playlist={playlist} size={300} />

            </div>


            {/* INFO */}

            <div className="playlist-title">
              {playlist.name}
            </div>


            <div className="playlist-meta">

              {playlist.songCount || 0}{" "}

              {playlist.songCount === 1
                ? "song"
                : "songs"}

            </div>

          </Link>

        ))}


        {/* EMPTY */}

        {total === 0 && (filter === "regular" || (!smart.loading && !smart.error)) && (

          <div className="playlist-empty">

            {search || filter !== "all" ? "No playlists match these filters." : "No playlists yet."}

          </div>

        )}

      </div>
      {filter !== "regular" && <SmartPlaylistShelf {...smart} items={smartItems} />}

    </section>

  );

}


export default function Playlists() {
  return <><PlaylistGrid /><LikedAlbumsSection /></>;
}
