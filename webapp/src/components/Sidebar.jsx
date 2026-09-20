import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import PlaylistCover from "./PlaylistCover";

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

    <aside className="sidebar" aria-label="Main navigation">
      <section className="nav-section" aria-labelledby="library-navigation">
        <h2 className="nav-title" id="library-navigation">Your Library</h2>

        <Link
          to="/explore"
          className={`nav-item ${location.pathname === "/explore" ? "active" : ""}`}
          aria-current={location.pathname === "/explore" ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">◇</span>
          <span className="nav-label">Explore</span>
        </Link>

        <Link
          to="/library/playlists"
          className={`nav-item ${location.pathname.startsWith("/library") ? "active" : ""}`}
          aria-current={location.pathname.startsWith("/library") ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">♫</span>
          <span className="nav-label">Library</span>
        </Link>

        <Link
          to="/liked"
          className={`nav-item ${location.pathname === "/liked" ? "active" : ""}`}
          aria-current={location.pathname === "/liked" ? "page" : undefined}
        >
          <span className="nav-icon" aria-hidden="true">♡</span>
          <span className="nav-label">Liked Songs</span>
        </Link>
      </section>

      <section className="nav-section playlists-section" aria-labelledby="playlist-navigation">
        <div className="nav-section-heading">
          <h2 className="nav-title" id="playlist-navigation">Playlists</h2>
          <button
            className="add-playlist-icon"
            type="button"
            onClick={handleAddPlaylist}
            aria-label="Add playlist"
            title="Add playlist"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>

        <div className="playlist-list">
          {loading && <div className="nav-loading">Loading playlists…</div>}

          {!loading && playlists.map((playlist) => {
            const isActive = location.pathname === `/playlist/${playlist.id}`;

            return (
              <Link
                key={playlist.id}
                to={`/playlist/${playlist.id}`}
                className={`nav-item playlist-nav-item ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                title={playlist.name}
              >
                <span className="nav-icon nav-icon-playlist" aria-hidden="true">
                  <PlaylistCover
                    playlist={playlist}
                    size={64}
                    placeholderClassName="nav-icon-playlist-placeholder"
                  />
                </span>
                <span className="nav-label">{playlist.name}</span>
              </Link>
            );
          })}
        </div>

        <button
          className="nav-item add-playlist"
          type="button"
          onClick={handleAddPlaylist}
        >
          <span className="nav-icon add-icon" aria-hidden="true">+</span>
          <span className="nav-label">Add playlist</span>
        </button>
      </section>
    </aside>

  );

}


export default Sidebar;
