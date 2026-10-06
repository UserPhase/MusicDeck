import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { DiscoveryArtistCard, DiscoveryAlbumCard } from "../components/DiscoveryCards";
import LightHero from "../components/Layout/LightHero";
import TrackRow from "../components/TrackRow";
import { getAlbum, getAlbums, getArtists, getRecentlyAddedSongs, getRecommendations } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { toUnifiedTrack } from "../types/track";
import useTrackPlaylistMenu from "../hooks/useTrackPlaylistMenu";

const HERO_LIMIT = 6;
const ALBUM_LIMIT = 7;
const TRACK_LIMIT = 6;

function displayName(session) {
  return session?.displayName || session?.username || "there";
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

function SectionSkeleton({ variant, count }) {
  return (
    <div className={`home-skeleton-grid home-skeleton-grid--${variant}`} aria-label="Loading section">
      {Array.from({ length: count }, (_, index) => <span className="home-skeleton" key={index} />)}
    </div>
  );
}

function HomeTracks({ tracks, onPlay, trackMenu, listId, className = "", showArtwork = false }) {
  return <div className={`home-track-list track-list--compact ${className}`} role="table" aria-label="Songs">
    {tracks.map((rawSong, index) => {
      const song = toUnifiedTrack(rawSong, "home");
      return <TrackRow key={`${song.id}-${index}`} song={song} index={index} showAlbum={false} showArtwork={showArtwork}
        onPlay={onPlay} onToggleMenu={(selected, event) => trackMenu.toggleMenu(selected, event, listId)}
        menu={trackMenu.isOpen(song, listId) ? trackMenu.renderMenu(song) : null} />;
    })}
  </div>;
}

function CompactTrackList({ title, id, tracks, loading, error, onPlay, to, trackMenu }) {
  return (
    <section className="home-track-panel" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="tracks" count={TRACK_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : tracks.length ? (
        <HomeTracks tracks={tracks} onPlay={onPlay} trackMenu={trackMenu} listId={id} />
      ) : <p className="home-section-state">Nothing to show yet.</p>}
    </section>
  );
}

function ArtistShelf({ id, title, artists, loading, error, to }) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="artists" count={ALBUM_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : artists.length ? (
        <div className="explore-artist-row">
          {artists.map((artist) => <DiscoveryArtistCard key={artist.id} artist={artist} />)}
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
  const [actionMessage, setActionMessage] = useState("");
  const trackMenu = useTrackPlaylistMenu(setActionMessage);
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
      <LightHero
        className="home-greeting"
        eyebrow="MusicDeck"
        title={`Welcome back, ${displayName(session)}`}
      />

      {actionMessage && <p className="home-action-message" role="status">{actionMessage}</p>}

      <section className="home-section home-continue" aria-labelledby="continue-listening-title">
        <SectionHeader id="continue-listening-title" title="Continue Listening" />
        {!recentlyPlayed.length && recentTracks.loading ? <SectionSkeleton variant="tracks" count={HERO_LIMIT} /> : continueTracks.length ? (
          <HomeTracks tracks={continueTracks} onPlay={playSong} trackMenu={trackMenu} listId="continue" className="home-continue-grid" showArtwork />
        ) : <p className="home-section-state">Start listening and your recent music will appear here.</p>}
      </section>

      <section className="home-section" aria-labelledby="recent-albums-title">
        <SectionHeader id="recent-albums-title" title="Recently Added Albums" to="/library/albums" />
        {recentAlbums.loading ? <SectionSkeleton variant="albums" count={ALBUM_LIMIT} /> : recentAlbums.error ? (
          <p className="home-section-state">{recentAlbums.error}</p>
        ) : (
          <div className="explore-album-row">
            {recentAlbums.items.map((album) => (
              <DiscoveryAlbumCard key={album.id} album={album} onPlay={playAlbum} />
            ))}
          </div>
        )}
      </section>

      <ArtistShelf id="discover-artists-title" title="Discover Artists" artists={discoverArtists.items} loading={discoverArtists.loading} error={discoverArtists.error} to="/explore" />

      <section className="home-section home-discovery-split" aria-label="Track discovery">
        <CompactTrackList id="recent-tracks-title" title="Recently Added Songs" tracks={recentTracks.items} loading={recentTracks.loading} error={recentTracks.error} onPlay={playSong} to="/library/tracks" trackMenu={trackMenu} />
        <CompactTrackList id="discover-tracks-title" title="Discover Tracks" tracks={discoverTracks.items} loading={discoverTracks.loading} error={discoverTracks.error} onPlay={playSong} to="/explore" trackMenu={trackMenu} />
      </section>

      <section className="home-section" aria-labelledby="discover-albums-title">
        <SectionHeader id="discover-albums-title" title="Discover Albums" to="/explore" action="Explore" />
        {discoverAlbums.loading ? <SectionSkeleton variant="albums" count={ALBUM_LIMIT} /> : discoverAlbums.error ? (
          <p className="home-section-state">{discoverAlbums.error}</p>
        ) : (
          <div className="explore-album-row">
            {discoverAlbums.items.map((album) => (
              <DiscoveryAlbumCard key={album.id} album={album} onPlay={playAlbum} />
            ))}
          </div>
        )}
      </section>

      <ArtistShelf id="unexplored-artists-title" title="Unexplored Artists" artists={unexploredArtists.items} loading={unexploredArtists.loading} error={unexploredArtists.error} to="/library/artists" />

      <section className="home-section" aria-labelledby="deep-cuts-title">
        <SectionHeader id="deep-cuts-title" title="Try Something Different" to="/library/tracks" action="More tracks" />
        {deepCuts.loading ? <SectionSkeleton variant="deep-cuts" count={TRACK_LIMIT} /> : deepCuts.error ? (
          <p className="home-section-state">{deepCuts.error}</p>
        ) : deepCuts.items.length ? (
          <HomeTracks tracks={deepCuts.items} onPlay={playSong} trackMenu={trackMenu} listId="deep-cuts" className="home-deep-cuts" />
        ) : <p className="home-section-state">Keep listening to uncover deep cuts from your library.</p>}
      </section>
    </div>
  );
}

export default Home;
