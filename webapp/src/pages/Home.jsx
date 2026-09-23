import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import AlbumCard from "../components/AlbumCard";
import ArtistAvatar from "../components/ArtistAvatar";
import { getAlbum, getAlbums, getArtistTracks, getArtists, getCoverUrl, getRecentlyAddedSongs, getRecommendations } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { formatDuration } from "../utils/formatDuration";

const HERO_LIMIT = 6;
const ALBUM_LIMIT = 7;
const TRACK_LIMIT = 6;

function displayName(session) {
  return session?.displayName || session?.username || "there";
}

function trackTitle(track) {
  return track?.title || track?.name || "Unknown track";
}

function trackArtist(track) {
  return track?.artist || track?.metadata?.artist || "Unknown artist";
}

function trackDuration(track) {
  return track?.duration || track?.metadata?.durationSeconds;
}

function artistName(artist) {
  return artist?.name || artist?.title || "Unknown artist";
}

function recommendationItems(result) {
  return (result?.sections || []).flatMap((section) => section.items || []).slice(0, TRACK_LIMIT);
}

function preferredEntities(tracks, entities, kind) {
  const key = kind === "album" ? "albumId" : "artistId";
  const byId = new Map(entities.map((entity) => [String(entity.id), entity]));
  const ranked = tracks.map((track) => byId.get(String(track.metadata?.[key]))).filter(Boolean);
  const seen = new Set();
  return [...ranked, ...entities].filter((entity) => {
    if (seen.has(entity.id)) return false;
    seen.add(entity.id);
    return true;
  }).slice(0, ALBUM_LIMIT);
}

function SectionHeader({ id, title, to, action = "See all" }) {
  return (
    <div className="home-section-header">
      <h2 id={id}>{title}</h2>
      {to && <Link className="see-all" to={to}>{action}</Link>}
    </div>
  );
}

function Artwork({ cover, className = "" }) {
  return cover ? (
    <img className={className} src={cover} alt="" />
  ) : (
    <div className={`home-artwork-placeholder ${className}`} aria-hidden="true">♫</div>
  );
}

function SectionSkeleton({ variant, count }) {
  return (
    <div className={`home-skeleton-grid home-skeleton-grid--${variant}`} aria-label="Loading section">
      {Array.from({ length: count }, (_, index) => <span className="home-skeleton" key={index} />)}
    </div>
  );
}

function ContinueCard({ song, onPlay }) {
  const title = trackTitle(song);
  return (
    <button className="home-continue-card" type="button" onClick={() => onPlay(song)}>
      <Artwork cover={getCoverUrl(song.coverArt, 128)} className="home-continue-artwork" />
      <span>{title}</span>
      <i aria-hidden="true">▶</i>
    </button>
  );
}

function CompactTrackRow({ song, onPlay }) {
  const title = trackTitle(song);
  return (
    <button className="home-track-row" type="button" onClick={() => onPlay(song)} aria-label={`Play ${title}`}>
      <Artwork cover={getCoverUrl(song.coverArt, 80)} className="home-track-artwork" />
      <span className="home-track-copy">
        <strong>{title}</strong>
        <small>{trackArtist(song)}</small>
      </span>
      <time>{formatDuration(trackDuration(song))}</time>
    </button>
  );
}

function CompactTrackList({ title, id, tracks, loading, error, onPlay, to }) {
  return (
    <section className="home-track-panel" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="tracks" count={TRACK_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : tracks.length ? (
        <div className="home-track-list">
          {tracks.map((song) => <CompactTrackRow key={song.id} song={song} onPlay={onPlay} />)}
        </div>
      ) : <p className="home-section-state">Nothing to show yet.</p>}
    </section>
  );
}

function ArtistCard({ artist, onPlay }) {
  const name = artistName(artist);

  return (
    <article className="home-artist-card">
      <div className="home-artist-avatar">
        <ArtistAvatar artist={artist} allowAlbumTileFallback />
        <button type="button" className="home-artist-play" onClick={() => onPlay(artist)} aria-label={`Play ${name}`}>
          ▶
        </button>
      </div>
      {artist.id ? <Link to={`/artist/${artist.id}`}>{name}</Link> : <span>{name}</span>}
    </article>
  );
}

function ArtistShelf({ id, title, artists, loading, error, onPlay, to }) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="artists" count={ALBUM_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : artists.length ? (
        <div className="home-artist-row">
          {artists.map((artist) => <ArtistCard key={artist.id} artist={artist} onPlay={onPlay} />)}
        </div>
      ) : <p className="home-section-state">No artists to show yet.</p>}
    </section>
  );
}

function Home() {
  const [recentAlbums, setRecentAlbums] = useState({ items: [], loading: true, error: null });
  const [recentTracks, setRecentTracks] = useState({ items: [], loading: true, error: null });
  const [discoverTracks, setDiscoverTracks] = useState({ items: [], loading: true, error: null });
  const [discoverAlbums, setDiscoverAlbums] = useState({ items: [], loading: true, error: null });
  const [discoverArtists, setDiscoverArtists] = useState({ items: [], loading: true, error: null });
  const [unexploredArtists, setUnexploredArtists] = useState({ items: [], loading: true, error: null });
  const [deepCuts, setDeepCuts] = useState({ items: [], loading: true, error: null });
  const { playSong, playQueue, recentlyPlayed } = usePlayer();
  const { session } = useAuth();

  async function playAlbum(album) {
    try {
      const result = await getAlbum(album.id);
      const albumSongs = result?.song || [];
      if (albumSongs.length) playQueue(albumSongs, 0);
    } catch (error) {
      console.error("Could not play album:", error);
    }
  }

  async function playArtist(artist) {
    try {
      const tracks = await getArtistTracks(artist.id);
      if (tracks.length) playQueue(tracks, 0);
    } catch (error) {
      console.error("Could not play artist:", error);
    }
  }

  useEffect(() => {
    let cancelled = false;

    function load(setter, loader, message) {
      loader()
        .then((items) => {
          if (!cancelled) setter({ items, loading: false, error: null });
        })
        .catch((error) => {
          if (!cancelled) setter({ items: [], loading: false, error: error.message || message });
        });
    }

    load(setRecentAlbums, () => getAlbums(ALBUM_LIMIT), "Could not load recently added albums.");
    load(setRecentTracks, () => getRecentlyAddedSongs(TRACK_LIMIT), "Could not load recently added songs.");
    const discovery = getRecommendations(["discover"], 30)
      .then((data) => (data.sections || []).flatMap((section) => section.items || []));
    load(setDiscoverTracks, async () => (await discovery).slice(0, TRACK_LIMIT), "Could not load discovery tracks.");
    const personalized = async (loader, kind) => {
      const [profile, catalog] = await Promise.allSettled([discovery, loader()]);
      if (catalog.status === "rejected") throw catalog.reason;
      return preferredEntities(profile.status === "fulfilled" ? profile.value : [], catalog.value, kind);
    };
    load(setDiscoverAlbums, () => personalized(() => getAlbums(500), "album"), "Could not load discovery albums.");
    load(setDiscoverArtists, () => personalized(getArtists, "artist"), "Could not load discovery artists.");
    load(setUnexploredArtists, async () => (await getArtists()).slice().sort((left, right) => (left.playCount || 0) - (right.playCount || 0)).slice(0, ALBUM_LIMIT), "Could not load unexplored artists.");
    load(setDeepCuts, async () => recommendationItems(await getRecommendations(["forgotten-favorites"], TRACK_LIMIT)), "Could not load deep cuts.");

    return () => {
      cancelled = true;
    };
  }, []);

  const continueTracks = recentlyPlayed.length
    ? recentlyPlayed.slice(0, HERO_LIMIT)
    : recentTracks.items.slice(0, HERO_LIMIT);

  return (
    <div className="home-page home-hero-gradient">
      <section className="home-greeting" aria-labelledby="home-greeting-title">
        <div>
          <p className="home-kicker">MusicDeck</p>
          <h1 id="home-greeting-title">Welcome back, {displayName(session)}</h1>
        </div>
      </section>

      <section className="home-section home-continue" aria-labelledby="continue-listening-title">
        <SectionHeader id="continue-listening-title" title="Continue Listening" />
        {!recentlyPlayed.length && recentTracks.loading ? <SectionSkeleton variant="tracks" count={HERO_LIMIT} /> : continueTracks.length ? (
          <div className="home-continue-grid">
            {continueTracks.map((song) => <ContinueCard key={song.id} song={song} onPlay={playSong} />)}
          </div>
        ) : <p className="home-section-state">Start listening and your recent music will appear here.</p>}
      </section>

      <section className="home-section" aria-labelledby="recent-albums-title">
        <SectionHeader id="recent-albums-title" title="Recently Added Albums" to="/library/albums" />
        {recentAlbums.loading ? <SectionSkeleton variant="albums" count={ALBUM_LIMIT} /> : recentAlbums.error ? (
          <p className="home-section-state">{recentAlbums.error}</p>
        ) : (
          <div className="home-album-row">
            {recentAlbums.items.map((album) => (
              <AlbumCard key={album.id} title={album.name || album.title} artist={album.artist || "Unknown artist"} cover={getCoverUrl(album.coverArt, 320)} availability={album.availability} onClick={() => playAlbum(album)} />
            ))}
          </div>
        )}
      </section>

      <ArtistShelf id="discover-artists-title" title="Discover Artists" artists={discoverArtists.items} loading={discoverArtists.loading} error={discoverArtists.error} onPlay={playArtist} to="/explore" />

      <section className="home-section home-discovery-split" aria-label="Track discovery">
        <CompactTrackList id="recent-tracks-title" title="Recently Added Songs" tracks={recentTracks.items} loading={recentTracks.loading} error={recentTracks.error} onPlay={playSong} to="/library/tracks" />
        <CompactTrackList id="discover-tracks-title" title="Discover Tracks" tracks={discoverTracks.items} loading={discoverTracks.loading} error={discoverTracks.error} onPlay={playSong} to="/explore" />
      </section>

      <section className="home-section" aria-labelledby="discover-albums-title">
        <SectionHeader id="discover-albums-title" title="Discover Albums" to="/explore" action="Explore" />
        {discoverAlbums.loading ? <SectionSkeleton variant="albums" count={ALBUM_LIMIT} /> : discoverAlbums.error ? (
          <p className="home-section-state">{discoverAlbums.error}</p>
        ) : (
          <div className="home-album-row">
            {discoverAlbums.items.map((album) => (
              <AlbumCard key={album.id} title={album.title || album.name} artist={album.artist || "Unknown artist"} cover={getCoverUrl(album.coverArt, 320)} availability={album.availability} onClick={() => playAlbum(album)} />
            ))}
          </div>
        )}
      </section>

      <ArtistShelf id="unexplored-artists-title" title="Unexplored Artists" artists={unexploredArtists.items} loading={unexploredArtists.loading} error={unexploredArtists.error} onPlay={playArtist} to="/library/artists" />

      <section className="home-section" aria-labelledby="deep-cuts-title">
        <SectionHeader id="deep-cuts-title" title="Try Something Different" to="/library/tracks" action="More tracks" />
        {deepCuts.loading ? <SectionSkeleton variant="deep-cuts" count={TRACK_LIMIT} /> : deepCuts.error ? (
          <p className="home-section-state">{deepCuts.error}</p>
        ) : deepCuts.items.length ? (
          <div className="home-deep-cuts">
            {deepCuts.items.map((song) => (
              <button className="home-deep-cut" type="button" key={song.id} onClick={() => playSong(song)}>
                <Artwork cover={getCoverUrl(song.coverArt, 320)} className="home-deep-cut-artwork" />
                <span><strong>{trackTitle(song)}</strong><small>{trackArtist(song)}</small></span>
                <i aria-hidden="true">▶</i>
              </button>
            ))}
          </div>
        ) : <p className="home-section-state">Keep listening to uncover deep cuts from your library.</p>}
      </section>
    </div>
  );
}

export default Home;
