import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import AlbumCard from "../components/AlbumCard";
import RecentItem from "../components/RecentItem";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../components/ui/PageState";

import {
  getRandomAlbums,
  getRandomSongs,
  getAlbum,
  getCoverUrl,
  getExplore,
  getRecommendations,
  getStarred,
} from "../api/musicdeck";
import {
  getPlaylists,
} from "../api/playlists";

import { usePlayer } from "../context/PlayerContext";
import { useAuth } from "../context/AuthContext";

const HOME_TRACK_LIMIT = 6;
const HOME_ALBUM_LIMIT = 12;
const HOME_PLAYLIST_LIMIT = 6;

function displayName(session) {
  return session?.displayName || session?.username || "there";
}

function Home() {
  const [albums, setAlbums] =
    useState([]);

  const [songs, setSongs] =
    useState([]);

  const [favorites, setFavorites] =
    useState([]);

  const [playlists, setPlaylists] =
    useState([]);

  const [externalDiscoveries, setExternalDiscoveries] =
    useState([]);

  const [recommendations, setRecommendations] =
    useState([]);

  const [loadingDiscover, setLoadingDiscover] =
    useState(true);

  const [loadingFavorites, setLoadingFavorites] =
    useState(true);

  const [loadingPlaylists, setLoadingPlaylists] =
    useState(true);

  const [discoverError, setDiscoverError] =
    useState(null);

  const [favoritesError, setFavoritesError] =
    useState(null);

  const [playlistsError, setPlaylistsError] =
    useState(null);

  const {
    playSong,
    playQueue,
    recentlyPlayed,
  } = usePlayer();

  const {
    session,
  } = useAuth();

  async function playAlbum(album) {
    try {
      const result =
        await getAlbum(album.id);

      const albumSongs =
        result?.song || [];

      if (albumSongs.length === 0) {
        return;
      }

      playQueue(
        albumSongs,
        0
      );
    } catch (error) {
      console.error(
        "Could not play album:",
        error
      );
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadDiscovery() {
      try {
        setLoadingDiscover(true);
        setDiscoverError(null);

        const [
          albumData,
          songData,
        ] = await Promise.all([
          getRandomAlbums(HOME_ALBUM_LIMIT),
          getRandomSongs(HOME_TRACK_LIMIT),
        ]);

        if (!cancelled) {
          setAlbums(albumData);
          setSongs(songData);
        }
      } catch (error) {
        console.error("Could not load Home discovery:", error);

        if (!cancelled) {
          setDiscoverError(
            error.message || "Could not load your music."
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingDiscover(false);
        }
      }
    }

    async function loadFavorites() {
      try {
        setLoadingFavorites(true);
        setFavoritesError(null);

        const data =
          await getStarred();

        if (!cancelled) {
          setFavorites(data.slice(0, HOME_TRACK_LIMIT));
        }
      } catch (error) {
        console.error("Could not load Home favorites:", error);

        if (!cancelled) {
          setFavoritesError("Could not load favorites.");
        }
      } finally {
        if (!cancelled) {
          setLoadingFavorites(false);
        }
      }
    }

    async function loadPlaylists() {
      try {
        setLoadingPlaylists(true);
        setPlaylistsError(null);

        const data =
          await getPlaylists();

        if (!cancelled) {
          setPlaylists(data.slice(0, HOME_PLAYLIST_LIMIT));
        }
      } catch (error) {
        console.error("Could not load Home playlists:", error);

        if (!cancelled) {
          setPlaylistsError("Could not load playlists.");
        }
      } finally {
        if (!cancelled) {
          setLoadingPlaylists(false);
        }
      }
    }

    async function loadExternalDiscovery() {
      try {
        const data = await getExplore();
        if (!cancelled) {
          setExternalDiscoveries(
            (data.albums || [])
              .filter((album) => album.source?.kind === "external")
              .slice(0, 6)
          );
        }
      } catch {
        if (!cancelled) {
          setExternalDiscoveries([]);
        }
      }
    }

    async function loadRecommendations() {
      try {
        const data = await getRecommendations(["favorites-mix", "discover"], HOME_TRACK_LIMIT);
        if (!cancelled) {
          setRecommendations(data.sections || []);
        }
      } catch {
        if (!cancelled) {
          setRecommendations([]);
        }
      }
    }

    loadDiscovery();
    loadFavorites();
    loadPlaylists();
    loadExternalDiscovery();
    loadRecommendations();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="home-page">
      <section className="home-greeting" aria-labelledby="home-greeting-title">
        <div>
          <p className="home-kicker">MusicDeck</p>

          <h1 id="home-greeting-title">
            Welcome back, {displayName(session)}
          </h1>
        </div>
      </section>

      <section className="section" aria-labelledby="continue-listening-title">
        <div className="section-header">
          <h2 id="continue-listening-title">Continue Listening</h2>
        </div>

        <div className="recent-list">
          {recentlyPlayed.length === 0 ? (
            <EmptyState>Start listening and your recent music will appear here.</EmptyState>
          ) : (
            recentlyPlayed.slice(0, HOME_TRACK_LIMIT).map((song) => (
              <RecentItem
                key={song.id}
                title={song.title}
                artist={song.artist || "Unknown artist"}
                artistId={song.artistId}
                cover={getCoverUrl(song.coverArt)}
                onPlay={() => playSong(song)}
              />
            ))
          )}
        </div>
      </section>

      {recommendations.map((section) => (
        <section className="section" aria-labelledby={`home-${section.id}`} key={section.id}>
          <div className="section-header">
            <h2 id={`home-${section.id}`}>{section.title}</h2>
            <Link to="/explore" className="see-all">Explore</Link>
          </div>

          <div className="recent-list">
            {section.items.slice(0, HOME_TRACK_LIMIT).map((song) => (
              <div key={song.id}>
                <RecentItem
                  title={song.title}
                  artist={song.artist || "Unknown artist"}
                  artistId={song.metadata?.artistId}
                  cover={getCoverUrl(song.coverArt)}
                  onPlay={() => playSong(song)}
                />
                {song.metadata?.recommendationReason && (
                  <div className="recommendation-reason">{song.metadata.recommendationReason}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {!loadingFavorites && favorites.length > 0 && (
        <section className="section" aria-labelledby="favorites-title">
          <div className="section-header">
            <h2 id="favorites-title">Your Favorites</h2>

            <Link to="/liked" className="see-all">View liked songs</Link>
          </div>

          <div className="recent-list">
            {favorites.map((song) => (
              <RecentItem
                key={song.id}
                title={song.title}
                artist={song.artist || "Unknown artist"}
                artistId={song.artistId}
                cover={getCoverUrl(song.coverArt)}
                onPlay={() => playSong(song)}
              />
            ))}
          </div>
        </section>
      )}

      {!loadingFavorites && favorites.length === 0 && favoritesError && (
        <section className="section" aria-labelledby="favorites-title">
          <div className="section-header">
            <h2 id="favorites-title">Your Favorites</h2>
          </div>

          <ErrorState>{favoritesError}</ErrorState>
        </section>
      )}

      {!loadingPlaylists && playlists.length > 0 && (
        <section className="section" aria-labelledby="playlists-title">
          <div className="section-header">
            <h2 id="playlists-title">Your Playlists</h2>

            <Link to="/library/playlists" className="see-all">View playlists</Link>
          </div>

          <div className="playlist-grid home-playlist-grid">
            {playlists.map((playlist) => (
              <Link
                key={playlist.id}
                to={`/playlist/${playlist.id}`}
                className="playlist-card"
              >
                <div className="playlist-cover">
                  <div className="playlist-cover-icon">♫</div>
                </div>

                <div className="playlist-title">{playlist.name}</div>

                <div className="playlist-meta">
                  {playlist.songCount || 0} {playlist.songCount === 1 ? "song" : "songs"}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {!loadingPlaylists && playlists.length === 0 && playlistsError && (
        <section className="section" aria-labelledby="playlists-title">
          <div className="section-header">
            <h2 id="playlists-title">Your Playlists</h2>
          </div>

          <ErrorState>{playlistsError}</ErrorState>
        </section>
      )}

      <section className="section" aria-labelledby="discover-albums-title">
        <div className="section-header">
          <h2 id="discover-albums-title">Discover Albums</h2>

          <Link to="/library/albums" className="see-all">View albums</Link>
        </div>

        {loadingDiscover ? (
          <LoadingState>Loading your music...</LoadingState>
        ) : discoverError ? (
          <ErrorState>{discoverError}</ErrorState>
        ) : (
          <div className="album-grid">
            {albums.length === 0 ? (
              <EmptyState>No albums yet.</EmptyState>
            ) : (
              albums.map((album) => (
                <AlbumCard
                  key={album.id}
                  title={album.name}
                  artist={album.artist || "Unknown artist"}
                  cover={getCoverUrl(album.coverArt)}
                  availability={album.availability}
                  onClick={() => playAlbum(album)}
                />
              ))
            )}
          </div>
        )}
      </section>

      {externalDiscoveries.length > 0 && (
        <section className="section" aria-labelledby="external-discoveries-title">
          <div className="section-header">
            <h2 id="external-discoveries-title">New discoveries</h2>
            <Link to="/explore" className="see-all">Explore</Link>
          </div>

          <div className="album-grid">
            {externalDiscoveries.map((album) => (
              <Link key={album.id} to={`/album/${album.id}`} className="album">
                <div className="album-cover">
                  {getCoverUrl(album.coverArt) ? (
                    <img src={getCoverUrl(album.coverArt)} alt={album.title} />
                  ) : (
                    <div className="album-cover-placeholder">♪</div>
                  )}
                </div>
                <div className="album-title">{album.title}</div>
                <div className="album-artist">{album.artist || "Unknown artist"}</div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="try-different-title">
        <div className="section-header">
          <h2 id="try-different-title">Try Something Different</h2>

          <Link to="/library/tracks" className="see-all">More tracks</Link>
        </div>

        {loadingDiscover ? (
          <LoadingState>Finding tracks...</LoadingState>
        ) : discoverError ? (
          <ErrorState>{discoverError}</ErrorState>
        ) : (
          <div className="recent-list">
            {songs.length === 0 ? (
              <EmptyState>No songs yet.</EmptyState>
            ) : (
              songs.map((song) => (
                <RecentItem
                  key={song.id}
                  title={song.title}
                  artist={song.artist || "Unknown artist"}
                  artistId={song.artistId}
                  cover={getCoverUrl(song.coverArt)}
                  onPlay={() => playSong(song)}
                />
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default Home;