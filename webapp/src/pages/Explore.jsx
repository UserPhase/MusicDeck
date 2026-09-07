import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getCoverUrl, getExplore, getRecommendations } from "../api/musicdeck";
import RecentItem from "../components/RecentItem";
import SourceIndicator from "../components/SourceIndicator";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/PageState";
import { usePlayer } from "../context/PlayerContext";

function Explore() {
  const [items, setItems] = useState({ albums: [], artists: [], songs: [] });
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { playSong } = usePlayer();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [data, recommended] = await Promise.all([
          getExplore(),
          getRecommendations(["continue-listening", "favorites-mix", "forgotten-favorites", "discover", "similar-artists"], 8),
        ]);
        if (!cancelled) {
          setItems(data);
          setRecommendations(recommended.sections || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load Explore.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="home-page">
      <section className="home-greeting" aria-labelledby="explore-title">
        <div>
          <p className="home-kicker">Explore</p>
          <h1 id="explore-title">Discover music</h1>
        </div>
      </section>

      {loading ? (
        <LoadingState>Loading discovery...</LoadingState>
      ) : error ? (
        <ErrorState>{error}</ErrorState>
      ) : (
        <>
          {recommendations.map((section) => (
            <section className="section" aria-labelledby={`explore-${section.id}`} key={section.id}>
              <div className="section-header">
                <h2 id={`explore-${section.id}`}>{section.title}</h2>
              </div>
              <div className="recent-list">
                {section.items.map((song) => (
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

          <section className="section" aria-labelledby="explore-albums-title">
            <div className="section-header">
              <h2 id="explore-albums-title">New discoveries</h2>
            </div>
            <div className="album-grid">
              {items.albums.length === 0 ? (
                <EmptyState>No album discoveries yet.</EmptyState>
              ) : (
                items.albums.map((album) => (
                  <Link key={album.id} to={`/album/${album.id}`} className="album">
                    <div className="album-cover">
                      {getCoverUrl(album.coverArt) ? (
                        <img src={getCoverUrl(album.coverArt)} alt={album.title} />
                      ) : (
                        <div className="album-cover-placeholder">♪</div>
                      )}
                    </div>
                    <div className="album-title">{album.title}</div>
                    <div className="album-artist">
                      {album.artist || "Unknown artist"}
                      <SourceIndicator source={album.source} />
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="explore-artists-title">
            <div className="section-header">
              <h2 id="explore-artists-title">Artists to explore</h2>
            </div>
            <div className="album-grid">
              {items.artists.length === 0 ? (
                <EmptyState>No artist discoveries yet.</EmptyState>
              ) : (
                items.artists.map((artist) => (
                  <Link key={artist.id} to={`/artist/${artist.id}`} className="album">
                    <div className="album-cover">
                      {getCoverUrl(artist.coverArt) ? (
                        <img src={getCoverUrl(artist.coverArt)} alt={`${artist.title}`} />
                      ) : (
                        <div className="album-cover-placeholder">♪</div>
                      )}
                    </div>
                    <div className="album-title">{artist.title}</div>
                    <SourceIndicator source={artist.source} />
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="explore-tracks-title">
            <div className="section-header">
              <h2 id="explore-tracks-title">Popular externally</h2>
            </div>
            <div className="recent-list">
              {items.songs.length === 0 ? (
                <EmptyState>No track discoveries yet.</EmptyState>
              ) : (
                items.songs.map((song) => (
                  <div key={song.id} className="explore-track">
                    <RecentItem
                      title={song.title}
                      artist={song.artist || "Unknown artist"}
                      artistId={song.metadata?.artistId}
                      cover={getCoverUrl(song.coverArt)}
                      onPlay={() => playSong(song)}
                    />
                    <SourceIndicator source={song.source} />
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default Explore;
