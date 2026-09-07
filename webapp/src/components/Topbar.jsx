import {
  Link,
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


function Topbar() {

  const navigate = useNavigate();

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
                query
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

    <header className="topbar">


      {/* LOGO */}

      <Link
        to="/"
        className="logo"
      >
        Music<span>Deck</span>
      </Link>


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

            <div className="search-dropdown">


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

            </div>

          )}

        </div>

      </div>


      {/* PROFILE */}

      <div
        className="profile"
        ref={accountRef}
      >

        {user && <DownloadsMenu />}

        {user ? (

          <>

            <button
              type="button"
              className="profile-button"
              aria-haspopup="menu"
              aria-expanded={showAccountMenu}
              onClick={() =>
                setShowAccountMenu(
                  (current) => !current
                )
              }
            >
              <span className="avatar">
                {(user.displayName || user.username)
                  .slice(0, 2)
                  .toUpperCase()}
              </span>

              <span>
                {user.displayName || user.username}
              </span>
            </button>


            {showAccountMenu && (

              <div
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

              </div>

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
