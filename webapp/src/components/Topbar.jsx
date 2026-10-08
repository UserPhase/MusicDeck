import {
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  searchNavidrome,
  getCoverUrl,
} from "../api/musicdeck";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  useAuth,
} from "../context/AuthContext";

import DownloadsMenu from "./DownloadsMenu";
import FloatingPanel from "./ui/FloatingPanel";
import UserAvatar from "./UserAvatar";
import { useImport } from "../context/ImportContext";
import { BrandWordmark } from "../context/BrandingContext";

// Primary destinations for header-navigation layouts (YouTube Music, SoundCloud).
export const HEADER_NAV_ITEMS = [
  { to: "/", label: "Home", exact: true },
  { to: "/explore", label: "Explore" },
  { to: "/library/playlists", label: "Library", match: "/library" },
  { to: "/liked", label: "Liked Songs" },
  { to: "/listening-activity", label: "Listening Activity" },
];

export function isHeaderNavItemActive(item, pathname) {
  if (item.exact) return pathname === item.to;
  return pathname.startsWith(item.match || item.to);
}


/**
 * Shared header. Layout shells customise it through slots instead of forking
 * the search and account logic:
 *   leading        – control rendered before the logo (drawer toggle).
 *   showPrimaryNav – header navigation links (top-navigation shells).
 *   playerSlot     – transport controls rendered in the header (Apple Music).
 */
function Topbar({ leading = null, showPrimaryNav = false, playerSlot = null }) {
  const profileTriggerRef = useRef(null);
  const { job: importJob, isMinimized, openProgress } = useImport();

  const navigate = useNavigate();

  const location = useLocation();

  const isAdminShell = location.pathname.startsWith("/admin");

  const {
    playSong,
  } = usePlayer();

  const {
    session,
    signOut,
  } = useAuth();


  /*
   * SEARCH
   */

  const [
    searchQuery,
    setSearchQuery,
  ] = useState("");

  const [
    searchResults,
    setSearchResults,
  ] = useState([]);

  const [
    searching,
    setSearching,
  ] = useState(false);

  const [
    showDropdown,
    setShowDropdown,
  ] = useState(false);

  const [
    showAccountMenu,
    setShowAccountMenu,
  ] = useState(false);


  const searchRef =
    useRef(null);

  const accountRef =
    useRef(null);


  /*
   * USER
   */

  const user = session;


  /*
   * LOGOUT
   */

  function handleLogout() {

    setShowAccountMenu(false);
    signOut();
    navigate("/login");

  }



  /*
   * LIVE SEARCH
   */

  useEffect(() => {

    const query =
      searchQuery.trim();


    if (!query) {

      setSearchResults([]);
      setShowDropdown(false);

      return;

    }


    setShowDropdown(true);


    const timeout =
      setTimeout(
        async () => {

          try {

            setSearching(true);


            const results =
              await searchNavidrome(
                query,
                { mode: "library", phase: "local" }
              );


            setSearchResults(
              results.songs?.slice(0, 7) || []
            );

          } catch (error) {

            console.error(
              "Search failed:",
              error
            );

            setSearchResults([]);

          } finally {

            setSearching(false);

          }

        },
        250
      );


    return () => {
      clearTimeout(timeout);
    };

  }, [searchQuery]);


  /*
   * CLOSE SEARCH WHEN CLICKING
   * OUTSIDE
   */

  useEffect(() => {

    function handleOutsideClick(
      event
    ) {

      if (
        searchRef.current &&
        !searchRef.current.contains(
          event.target
        )
      ) {

        setShowDropdown(false);

      }

    }


    document.addEventListener(
      "mousedown",
      handleOutsideClick
    );


    return () => {

      document.removeEventListener(
        "mousedown",
        handleOutsideClick
      );

    };

  }, []);


  /*
   * CLOSE ACCOUNT MENU
   */

  useEffect(() => {

    function handleOutsideClick(event) {

      if (
        accountRef.current &&
        !accountRef.current.contains(
          event.target
        )
      ) {

        setShowAccountMenu(false);

      }

    }


    function handleEscape(event) {

      if (event.key === "Escape") {
        setShowAccountMenu(false);
      }

    }


    document.addEventListener(
      "mousedown",
      handleOutsideClick
    );

    document.addEventListener(
      "keydown",
      handleEscape
    );


    return () => {

      document.removeEventListener(
        "mousedown",
        handleOutsideClick
      );

      document.removeEventListener(
        "keydown",
        handleEscape
      );

    };

  }, []);


  /*
   * ENTER
   *
   * Open full search page.
   */

  function handleSearchSubmit(
    event
  ) {

    event.preventDefault();


    const query =
      searchQuery.trim();


    if (!query) {
      return;
    }


    setShowDropdown(false);


    navigate(
      `/search?q=${encodeURIComponent(
        query
      )}`
    );

  }


  /*
   * PLAY SEARCH RESULT
   */

  function handlePlaySong(song) {

    setShowDropdown(false);

    playSong(song);

  }


  /*
   * OPEN ARTIST
   */

  function handleArtistClick(
    event,
    artistId
  ) {

    event.stopPropagation();

    setShowDropdown(false);

    navigate(
      `/artist/${artistId}`
    );

  }


  /*
   * RENDER
   */

  return (

    <header className={`topbar${playerSlot ? " topbar--player" : ""}${showPrimaryNav ? " topbar--topnav" : ""}`}>


      {/* LOGO */}

      <div className="topbar-brand-group">
        {leading}

        <Link
          to="/"
          className="logo"
        >
          <BrandWordmark />
        </Link>

        {isAdminShell && (
          <span className="admin-shell-badge">Admin</span>
        )}

        {showPrimaryNav && (
          <nav className="topbar-primary-nav" aria-label="Header navigation">
            {HEADER_NAV_ITEMS.map((item) => {
              const isActive = isHeaderNavItemActive(item, location.pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`topbar-primary-link${isActive ? " active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      {playerSlot}


      {/* CENTER */}

      <div className="topbar-center">


        {/* HOME */}

        <Link
          to="/"
          className="homebutton"
          aria-label="Home"
        >
          🏠︎
        </Link>


        {/* SEARCH */}

        <div
          className="search-wrapper"
          ref={searchRef}
        >

          <form
            className="search"
            onSubmit={
              handleSearchSubmit
            }
          >

            <input
              type="text"
              value={searchQuery}
              onChange={(event) =>
                setSearchQuery(
                  event.target.value
                )
              }
              onFocus={() => {

                if (
                  searchQuery.trim()
                ) {

                  setShowDropdown(true);

                }

              }}
              placeholder="Search your music..."
              aria-label="Search your music"
              autoComplete="off"
            />

          </form>


          {/* DROPDOWN */}

          {showDropdown && (

            <FloatingPanel className="search-dropdown" anchorRef={searchRef} matchWidth role={null}
              onClose={() => setShowDropdown(false)}>


              {/* SEARCHING */}

              {searching && (

                <div className="search-dropdown-status">
                  Searching...
                </div>

              )}


              {/* RESULTS */}

              {!searching &&
                searchResults.length > 0 && (

                <>

                  <div className="search-dropdown-label">
                    Songs
                  </div>


                  {searchResults.map(
                    (song) => (

                    <div
                      key={song.id}
                      className="search-dropdown-song"
                    >


                      {/* COVER */}

                      <div className="search-dropdown-cover">

                        {song.coverArt ? (

                          <img
                            src={
                              getCoverUrl(
                                song.coverArt
                              )
                            }
                            alt=""
                          />

                        ) : (

                          <div className="search-dropdown-cover-empty">
                            ♪
                          </div>

                        )}

                      </div>


                      {/* SONG INFO */}

                      <div className="search-dropdown-info">

                        <button
                          type="button"
                          className="search-dropdown-title search-dropdown-play-action"
                          onClick={() =>
                            handlePlaySong(
                              song
                            )
                          }
                        >
                          {song.title}
                        </button>


                        {song.artistId ? (

                          <button
                            type="button"
                            className="search-dropdown-artist"
                            onClick={(event) =>
                              handleArtistClick(
                                event,
                                song.artistId
                              )
                            }
                          >
                            {song.artist ||
                              "Unknown artist"}
                          </button>

                        ) : (

                          <div className="search-dropdown-artist">
                            {song.artist ||
                              "Unknown artist"}
                          </div>

                        )}

                      </div>


                      {/* PLAY */}

                      <button
                        type="button"
                        className="search-dropdown-play"
                        aria-label={`Play ${song.title}`}
                        onClick={() =>
                          handlePlaySong(
                            song
                          )
                        }
                      >
                        ▶
                      </button>


                    </div>

                  ))}


                  {/* FULL SEARCH */}

                  <button
                    type="button"
                    className="search-dropdown-more"
                    onClick={() => {

                      const query =
                        searchQuery.trim();


                      setShowDropdown(false);


                      navigate(
                        `/search?q=${encodeURIComponent(
                          query
                        )}`
                      );

                    }}
                  >
                    See all results for "{searchQuery}"
                  </button>

                </>

              )}


              {/* NO RESULTS */}

              {!searching &&
                searchResults.length === 0 && (

                <div className="search-dropdown-status">
                  No songs found
                </div>

              )}

            </FloatingPanel>

          )}

        </div>

      </div>


      {/* PROFILE */}

      <div
        className="profile"
        ref={accountRef}
      >

        {user && isMinimized && (importJob?.status === "queued" || importJob?.status === "running") && (
          <button type="button" className="topbar-import-status" onClick={openProgress} aria-label="Show playlist import progress">
            <span className="playlist-modal-spinner" aria-hidden="true" />
            <span>Importing 1 Playlist...</span>
          </button>
        )}
        {user && <DownloadsMenu />}

        {user ? (

          <>

            <button
              type="button"
              className="profile-button"
              ref={profileTriggerRef}
              aria-haspopup="menu"
              aria-expanded={showAccountMenu}
              onClick={() =>
                setShowAccountMenu(
                  (current) => !current
                )
              }
            >
              <UserAvatar user={user} />

              <span>
                {user.displayName || user.username}
              </span>
            </button>


            {showAccountMenu && (

              <FloatingPanel
                anchorRef={profileTriggerRef}
                onClose={() => setShowAccountMenu(false)}
                className="account-menu"
                role="menu"
              >

                <Link
                  to="/profile"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() =>
                    setShowAccountMenu(false)
                  }
                >
                  Profile
                </Link>

                <Link
                  to="/settings"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() =>
                    setShowAccountMenu(false)
                  }
                >
                  Settings
                </Link>

                {user.role === "admin" && (

                  <Link
                    to="/admin"
                    className="account-menu-item"
                    role="menuitem"
                    onClick={() =>
                      setShowAccountMenu(false)
                    }
                  >
                    Admin Dashboard
                  </Link>

                )}

                <button
                  type="button"
                  className="account-menu-item"
                  role="menuitem"
                  onClick={handleLogout}
                >
                  Log out
                </button>

              </FloatingPanel>

            )}

          </>

        ) : (

          <Link
            to="/login"
            className="login-button"
          >
            Login
          </Link>

        )}

      </div>


    </header>

  );

}


export default Topbar;
