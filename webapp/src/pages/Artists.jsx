import {
  useEffect,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  getArtists,
} from "../api/musicdeck";
import ArtistAvatar from "../components/ArtistAvatar";
import LibraryBrowseControls from "../components/LibraryBrowseControls";
import { normalizePlaylistSearch } from "../utils/playlistSearch";

const artistSorts = { az: "A–Z", za: "Z–A", most: "Most albums", fewest: "Fewest albums" };
const compareNames = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;

function Artists() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("az");

  const [artists, setArtists] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);
  const search = normalizePlaylistSearch(query.trim());
  const visibleArtists = artists.filter(artist => normalizePlaylistSearch(artist.name).includes(search))
    .sort((left, right) => {
      const byName = compareNames(left.name, right.name);
      if (sort === "az" || sort === "za") return sort === "az" ? byName : -byName;
      const byCount = (left.albumCount ?? 0) - (right.albumCount ?? 0);
      return (sort === "most" ? -byCount : byCount) || byName;
    });


  /*
   * Load artists
   */

  useEffect(() => {

    async function loadArtists() {

      try {

        setLoading(true);

        setError(null);


        const data =
          await getArtists();


        setArtists(data);

      } catch (err) {

        console.error(
          "Could not load artists:",
          err
        );


        setError(
          err.message ||
          "Could not load artists."
        );

      } finally {

        setLoading(false);

      }

    }


    loadArtists();

  }, []);


  /*
   * Loading
   */

  if (loading) {

    return (

      <section className="library-section">

        <div className="library-section-header">

          <h2>
            Artists
          </h2>

        </div>


        <div className="loading">
          Loading artists...
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
            Artists
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
          Artists
        </h2>


        <span>
          {visibleArtists.length} artists
        </span>
        <LibraryBrowseControls label="artists" query={query} onQueryChange={setQuery}
          sort={sort} onSortChange={setSort} sortChoices={artistSorts} />

      </div>


      {/* ARTIST GRID */}

      <div className="artist-grid">

        {visibleArtists.length === 0 && (

          <div className="library-empty">
            {search ? "No artists match your search." : "No artists yet."}
          </div>

        )}

        {visibleArtists.map(
          (artist) => (

          <Link
            key={artist.id}
            to={`/artist/${artist.id}`}
            className="artist group"
          >


            {/* ARTIST IMAGE */}

            <ArtistAvatar artist={artist} className="artist-cover" allowAlbumTileFallback
              enableMusicBrainzFallback deferUntilVisible />


            {/* ARTIST NAME */}

            <div className="artist-name">
              {artist.name}
            </div>

          </Link>

        ))}

      </div>

    </section>

  );

}


export default Artists;
