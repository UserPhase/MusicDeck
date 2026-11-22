import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { DiscoveryArtistCard, DiscoveryAlbumCard } from "../components/DiscoveryCards";
import DiscoveryTrackList, { MOBILE_DISCOVERY_TRACK_LIMIT } from "../components/DiscoveryTrackList";
import LightHero from "../components/Layout/LightHero";
import PlaylistCover from "../components/PlaylistCover";
import { NewReleasesShelf } from "../views/NewReleasesView";
import { useDiscoveryPlayback } from "../hooks/useDiscoveryPlayback";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getAlbum, getAlbums, getArtists, getRecentlyAddedSongs, getRecommendations, LISTENING_ACTIVITY_CHANGED_EVENT } from "../api/musicdeck";
import { getRecentlyPlayedPlaylists } from "../api/playlists";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { startVisualPolling } from "../services/visualActivity";
import { toUnifiedTrack } from "../types/track";
import { MOBILE_LAYOUT_QUERY } from "../utils/layoutPreset";
import { uniqueTracks } from "../utils/uniqueTracks";


const HERO_LIMIT = 6;
const ALBUM_LIMIT = 7;
const TRACK_LIMIT = 6;

function displayName(session) {
  return session?.displayName || session?.username || "there";
}

function recommendationItems(result) {
  return uniqueTracks((result?.sections || []).flatMap((section) => section.items || []), TRACK_LIMIT);
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
  const shelf = variant === "albums" ? " explore-album-row" : variant === "artists" ? " explore-artist-row" : "";
  return (
    <div className={`home-skeleton-grid home-skeleton-grid--${variant}${shelf}`} aria-label="Loading section">
      {Array.from({ length: count }, (_, index) => <span className="home-skeleton" key={index} />)}
    </div>
  );
}

function HomeTracks({ tracks, className = "", ...props }) {
  const songs = useMemo(() => tracks.map((song) => toUnifiedTrack(song, "home")), [tracks]);
  return <DiscoveryTrackList tracks={songs} className={`home-track-list ${className}`} {...props} />;
}

function CompactTrackList({ title, id, tracks, loading, error, onPlay, to, mobile }) {
  return (
    <section className="home-track-panel" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="tracks" count={mobile ? MOBILE_DISCOVERY_TRACK_LIMIT : TRACK_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : tracks.length ? (
        <HomeTracks tracks={tracks} onPlay={onPlay} listId={id} mobile={mobile} />
      ) : <p className="home-section-state">Nothing to show yet.</p>}
    </section>
  );
}

function ArtistShelf({ id, title, artists, loading, error, to, artistState }) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <SectionHeader id={id} title={title} to={to} />
      {loading ? <SectionSkeleton variant="artists" count={ALBUM_LIMIT} /> : error ? (
        <p className="home-section-state">{error}</p>
      ) : artists.length ? (
        <div className="explore-artist-row">
          {artists.map((artist) => <DiscoveryArtistCard key={artist.id} artist={artist}
            playbackState={artistState(artist)} />)}
        </div>
      ) : <p className="home-section-state">No artists to show yet.</p>}
    </section>
  );
}

function RecentlyPlayedPlaylists() {
  const [playlists, setPlaylists] = useState([]);

  useEffect(() => {
    let pending;
    function load() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      getRecentlyPlayedPlaylists(controller.signal).then((items) => {
        if (!controller.signal.aborted) setPlaylists(items);
      }).catch(() => {
        if (!controller.signal.aborted) setPlaylists([]);
      });
    }

    const events = [LISTENING_ACTIVITY_CHANGED_EVENT, "playlistsChanged", "smartPlaylistsChanged", "online"];
    const stopPolling = startVisualPolling(load, 60_000, { refreshOnWindowFocus: true });
    events.forEach((event) => window.addEventListener(event, load));
    return () => {
      stopPolling();
      pending?.abort();
      events.forEach((event) => window.removeEventListener(event, load));
    };
  }, []);

  if (!playlists.length) return null;

  return (
    <section className="home-section" aria-labelledby="recent-playlists-title">
      <SectionHeader id="recent-playlists-title" title="Recently Played Playlists" />
      <ul className="explore-album-row home-playlist-row">
        {playlists.map((playlist) => (
          <li key={playlist.id}>
            <Link className="home-playlist-card" to={`/${playlist.isSmart ? "smart-playlist" : "playlist"}/${encodeURIComponent(playlist.id)}`}>
              <span className="home-playlist-cover" aria-hidden="true">
                <PlaylistCover playlist={playlist} size={320} />
              </span>
              <span className="explore-card-name">{playlist.name}</span>
            </Link>
          </li>
        ))}
      </ul>
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

  const { playSong, playQueue, recentlyPlayed, currentSong, isPlaying, togglePlay } = usePlayer();
  const { session } = useAuth();
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { albumState, artistState } = useDiscoveryPlayback(currentSong, isPlaying, isMobile);

  async function playAlbum(album) {
    try {
      const result = await getAlbum(album.id);
      const albumSongs = result?.song || [];
      if (albumSongs.length) playQueue(albumSongs, 0, {
        type: "album", id: result.id || album.id, name: result.name || album.name,
        coverArt: result.coverArt || album.coverArt || null,
      });
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
    load(setRecentTracks, async () => uniqueTracks(await getRecentlyAddedSongs(TRACK_LIMIT), TRACK_LIMIT), "Could not load recently added songs.");
    const discovery = getRecommendations(["discover"], 30)
      .then((data) => (data.sections || []).flatMap((section) => section.items || []));
    load(setDiscoverTracks, async () => uniqueTracks(await discovery, TRACK_LIMIT), "Could not load discovery tracks.");
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

  const continueTracks = useMemo(() => uniqueTracks(recentlyPlayed, HERO_LIMIT), [recentlyPlayed]);
  const recentSongs = <CompactTrackList id="recent-tracks-title" title="Recently Added Songs"
    tracks={recentTracks.items} loading={recentTracks.loading} error={recentTracks.error}
    onPlay={playSong} to="/library/tracks" mobile={isMobile} />;

  return (
    <div className="home-page home-hero-gradient">
      <LightHero
        className="home-greeting"
        eyebrow="MusicDeck"
        title={`Welcome back, ${displayName(session)}`}
      />


      <section className="home-section home-continue" aria-labelledby="continue-listening-title">
        <SectionHeader id="continue-listening-title" title="Continue Listening" />
        {continueTracks.length ? (
          <HomeTracks tracks={continueTracks} onPlay={playSong} listId="continue" className="home-continue-grid"
            showArtwork compactTile={isMobile} />
        ) : <p className="home-section-state">Start listening and your recent music will appear here.</p>}
      </section>

      <NewReleasesShelf />
      {isMobile && session?.id && <RecentlyPlayedPlaylists key={session.id} />}
      <section className="home-section" aria-labelledby="recent-albums-title">
        <SectionHeader id="recent-albums-title" title="Recently Added Albums" to="/library/albums" />
        {recentAlbums.loading ? <SectionSkeleton variant="albums" count={ALBUM_LIMIT} /> : recentAlbums.error ? (
          <p className="home-section-state">{recentAlbums.error}</p>
        ) : (
          <div className="explore-album-row">
            {recentAlbums.items.map((album) => {
              const playbackState = albumState(album);
              return <DiscoveryAlbumCard key={album.id} album={album} inlinePlay={isMobile}
                playbackState={playbackState} onPlay={playbackState ? togglePlay : playAlbum} />;
            })}
          </div>
        )}
      </section>

      {isMobile && recentSongs}
      <ArtistShelf id="discover-artists-title" title="Discover Artists" artists={discoverArtists.items} loading={discoverArtists.loading} error={discoverArtists.error} to="/explore"
        artistState={artistState} />

      <section className="home-section home-discovery-split" aria-label="Track discovery">
        {!isMobile && recentSongs}
        <CompactTrackList id="discover-tracks-title" title="Discover Tracks" tracks={discoverTracks.items} loading={discoverTracks.loading} error={discoverTracks.error} onPlay={playSong} to="/explore" mobile={isMobile} />
      </section>

      <section className="home-section" aria-labelledby="discover-albums-title">
        <SectionHeader id="discover-albums-title" title="Discover Albums" to="/explore" action="Discover" />
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

      <ArtistShelf id="unexplored-artists-title" title="Unexplored Artists" artists={unexploredArtists.items} loading={unexploredArtists.loading} error={unexploredArtists.error} to="/library/artists"
        artistState={artistState} />

      <section className="home-section" aria-labelledby="deep-cuts-title">
        <SectionHeader id="deep-cuts-title" title="Try Something Different" to="/library/tracks" action="More tracks" />
        {deepCuts.loading ? <SectionSkeleton variant={isMobile ? "tracks" : "deep-cuts"} count={isMobile ? MOBILE_DISCOVERY_TRACK_LIMIT : TRACK_LIMIT} /> : deepCuts.error ? (
          <p className="home-section-state">{deepCuts.error}</p>
        ) : deepCuts.items.length ? (
          <HomeTracks tracks={deepCuts.items} onPlay={playSong} listId="deep-cuts" className="home-deep-cuts" mobile={isMobile} />
        ) : <p className="home-section-state">Keep listening to uncover deep cuts from your library.</p>}
      </section>
    </div>
  );
}

export default Home;
