import { NavLink, Outlet } from "react-router-dom";

function Library() {
  return (
    <div className="library">

      <div className="library-header">
        <h1>Library</h1>
      </div>

      <div className="library-actions">

        <NavLink
          to="/library/playlists"
          className={({ isActive }) =>
            `library-action ${isActive ? "active" : ""}`
          }
        >
          Playlists
        </NavLink>

        <NavLink
          to="/library/albums"
          className={({ isActive }) =>
            `library-action ${isActive ? "active" : ""}`
          }
        >
          Albums
        </NavLink>

        <NavLink
          to="/library/artists"
          className={({ isActive }) =>
            `library-action ${isActive ? "active" : ""}`
          }
        >
          Artists
        </NavLink>

        <NavLink
          to="/library/tracks"
          className={({ isActive }) =>
            `library-action ${isActive ? "active" : ""}`
          }
        >
          Tracks
        </NavLink>

      </div>

      <div className="library-content">
        <Outlet />
      </div>

    </div>
  );
}

export default Library;
