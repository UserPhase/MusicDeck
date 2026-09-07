import {
  useEffect,
  useState,
} from "react";

import {
  Link,
} from "react-router-dom";

import {
  getAlbums,
  getCoverUrl,
} from "../api/musicdeck";


function Albums() {

  const [albums, setAlbums] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);


  /*
   * Load albums
   */

  useEffect(() => {
    let cancelled = false;

    async function loadAlbums() {

      try {

        setLoading(true);
        setError(null);


        const data =
          await getAlbums(500);


        if (!cancelled) {
          setAlbums(data);
        }

      } catch (err) {

        console.error(
          "Could not load albums:",
          err
        );


        if (!cancelled) {
          setError(
            err.message ||
            "Could not load albums."
          );
        }

      } finally {

        if (!cancelled) {
          setLoading(false);
        }

      }

    }


    loadAlbums();

    return () => {
      cancelled = true;
    };

  }, []);


  /*
   * Loading
   */

  if (loading) {

    return (

      <section className="library-section">

        <div className="library-section-header">

          <h2>
            Albums
          </h2>

        </div>


        <div className="loading">
          Loading albums...
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
            Albums
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
          Albums
        </h2>


        <span>
          {albums.length} albums
        </span>

      </div>


      {/* ALBUM GRID */}

      <div className="album-grid">

        {albums.length === 0 && (

          <div className="library-empty">
            No albums yet.
          </div>

        )}

        {albums.map(
          (album) => (

          <Link
            key={album.id}
            to={`/album/${album.id}`}
            className="album"
          >

            {/* COVER */}

            <div className="album-cover">

              {album.coverArt ? (

                <img
                  src={
                    getCoverUrl(
                      album.coverArt
                    )
                  }
                  alt={
                    `${album.name} cover`
                  }
                />

              ) : (

                <div className="album-cover-placeholder">
                  ♪
                </div>

              )}

            </div>


            {/* TITLE */}

            <div className="album-title">
              {album.name}
            </div>


            {/* ARTIST */}

            <div className="album-artist">
              {album.artist}
            </div>

          </Link>

        ))}

      </div>

    </section>

  );

}


export default Albums;
