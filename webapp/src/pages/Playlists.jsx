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


function Playlists() {

  const [playlists, setPlaylists] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState(null);


  /*
   * Load playlists
   */

  useEffect(() => {

    async function loadPlaylists() {

      try {

        setLoading(true);

        setError(null);


        const data =
          await getPlaylists();


        setPlaylists(data);

      } catch (err) {

        console.error(
          "Could not load playlists:",
          err
        );


        setError(
          err.message ||
          "Could not load playlists."
        );

      } finally {

        setLoading(false);

      }

    }


    loadPlaylists();

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
          {playlists.length} playlists
        </span>

      </div>


      {/* PLAYLIST GRID */}

      <div className="playlist-grid">

        {playlists.map(
          (playlist) => (

          <Link
            key={playlist.id}
            to={`/playlist/${playlist.id}`}
            className="playlist-card"
          >


            {/* COVER */}

            <div className="playlist-cover">

              <div className="playlist-cover-icon">
                ♫
              </div>

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

        {playlists.length === 0 && (

          <div className="playlist-empty">

            No playlists yet.

          </div>

        )}

      </div>

    </section>

  );

}


export default Playlists;
