import {
  useEffect,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  getArtists,
  getCoverUrl,
} from "../api/musicdeck";


function Artists() {

  const [artists, setArtists] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);


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
          {artists.length} artists
        </span>

      </div>


      {/* ARTIST GRID */}

      <div className="artist-grid">

        {artists.length === 0 && (

          <div className="library-empty">
            No artists yet.
          </div>

        )}

        {artists.map(
          (artist) => (

          <Link
            key={artist.id}
            to={`/artist/${artist.id}`}
            className="artist"
          >


            {/* ARTIST IMAGE */}

            <div className="artist-cover">

              {artist.coverArt ? (

                <img
                  src={
                    getCoverUrl(
                      artist.coverArt
                    )
                  }
                  alt={
                    `${artist.name} cover`
                  }
                />

              ) : (

                <div className="artist-cover-placeholder">
                  ♪
                </div>

              )}

            </div>


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
