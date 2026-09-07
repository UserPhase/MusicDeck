import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import {
  getPlaylists,
  createPlaylist,
} from "../api/playlists";


function Sidebar() {

  const location = useLocation();

  const [playlists, setPlaylists] = useState([]);

  const [loading, setLoading] = useState(true);


  /*
   * Load playlists from Navidrome.
   *
   * Single source of truth: used for the initial load and
   * for reloads triggered by the "playlistsChanged" event.
   */

  const loadPlaylists = useCallback(
    async () => {

      try {

        const data = await getPlaylists();

        setPlaylists(data || []);

      } catch (error) {

        console.error(
          "Could not load playlists:",
          error
        );

      } finally {

        setLoading(false);

      }

    },
    []
  );

  useEffect(() => {

    loadPlaylists();


    // Reload when a playlist is
    // created/deleted elsewhere
    function handlePlaylistsChanged() {
      loadPlaylists();
    }


    window.addEventListener(
      "playlistsChanged",
      handlePlaylistsChanged
    );


    return () => {

      window.removeEventListener(
        "playlistsChanged",
        handlePlaylistsChanged
      );

    };

  }, [loadPlaylists]);

  /*
   * Create playlist
   */

  async function handleAddPlaylist() {

    const name = window.prompt(
      "Enter a name for your playlist:"
    );

    if (name === null) {
      return;
    }

    const trimmedName = name.trim();

    if (!trimmedName) {
      return;
    }


    try {

      const playlist =
        await createPlaylist(trimmedName);

      if (playlist) {

        setPlaylists((current) => [
          ...current,
          playlist,
        ]);

      } else {

        await loadPlaylists();

      }

    } catch (error) {

      console.error(
        "Could not create playlist:",
        error
      );

      alert(
        error.message ||
        "Could not create playlist."
      );

    }

  }


  return (

    <aside className="sidebar">


      {/* YOUR LIBRARY */}

      <div className="nav-section">

        <div className="nav-title">
          Your Library
        </div>

        <Link
          to="/explore"
          className={`nav-item ${
            location.pathname === "/explore"
              ? "active"
              : ""
          }`}
        >

          <span className="nav-icon">
            ◇
          </span>

          <span>
            Explore
          </span>

        </Link>


        <Link
          to="/library/playlists"
          className={`nav-item ${
            location.pathname === "/library/playlists"
              ? "active"
              : ""
          }`}
        >

          <span className="nav-icon">
            ♫
          </span>

          <span>
            Library
          </span>

        </Link>


        <Link
          to="/liked"
          className={`nav-item ${
            location.pathname === "/liked"
              ? "active"
              : ""
          }`}
        >

          <span className="nav-icon">
            ♡
          </span>

          <span>
            Liked Songs
          </span>

        </Link>

      </div>


      {/* PLAYLISTS */}

      <div className="nav-section">

        <div className="nav-title">
          Playlists
        </div>


        {loading && (

          <div className="nav-item">
            Loading...
          </div>

        )}


        {!loading && playlists.map((playlist) => (

          <Link
            key={playlist.id}
            to={`/playlist/${playlist.id}`}
            className={`nav-item ${
              location.pathname ===
              `/playlist/${playlist.id}`
                ? "active"
                : ""
            }`}
          >

            <span className="nav-icon">
              ♫
            </span>

            <span>
              {playlist.name}
            </span>

          </Link>

        ))}


        {/* ADD PLAYLIST */}

        <button
          className="nav-item"
          onClick={handleAddPlaylist}
        >

          <span className="nav-icon">
            +
          </span>

          <span>
            Add playlist
          </span>

        </button>

      </div>


    </aside>

  );

}


export default Sidebar;
