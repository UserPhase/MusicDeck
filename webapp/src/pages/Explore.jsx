import TrackActionScope from "../components/TrackActionScope";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { getAlbum, getAlbums, getCoverUrl, getPersonalizedDiscovery } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import { usePrivacy } from "../context/PrivacyContext";
import { externalDiscoveryService } from "../services/externalDiscovery";
import { resolveTrackPreview } from "../services/resolveTrackPreview";
import { canStreamPreview, trustedPreviewUrl } from "../utils/previewPlayback";
import { extractArtworkColor } from "../utils/extractArtworkColor";
import { toUnifiedTrack } from "../types/track";
import { DiscoveryArtistCard, DiscoveryAlbumCard, DiscoveryArtwork as Artwork, itemLink } from "../components/DiscoveryCards";
import ExternalAlbumCard from "../components/ExternalAlbumCard";
import LightHero from "../components/Layout/LightHero";
import TrackRow from "../components/TrackRow";

import { toAlbumRouteIdFromApiId } from "../utils/idResolver";

const SHELF_SIZE = 7;
const TRACK_SIZE = 6;
const feedKeys = ["featured", "popularArtists", "popularAlbums", "popularTracks", "discoverTracks", "discoverArtists", "discoverAlbums", "genres"];
const initialFeeds = () => Object.fromEntries(feedKeys.map((key) => [key, { items: [], loading: true, error: null }]));
const nameOf = (item) => item?.name || item?.title || "Unknown";

function Header({ id, title, subtitle, featured = false }) {
  return <div className={`explore-section-heading${featured ? " explore-section-heading--featured" : ""}`}><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>;
}

function Skeleton({ shape, count }) {
  return <div className={`explore-skeletons explore-skeletons--${shape}`} aria-label="Loading section">
    {Array.from({ length: count }, (_, index) => <span className="explore-skeleton" key={index} />)}
  </div>;
}

function FeedBody({ feed, shape, count, empty, children }) {
  if (feed.loading) return <Skeleton shape={shape} count={count} />;
  if (feed.error) return <p className="explore-feed-message" role="status">{feed.error}</p>;
  if (!feed.items.length) return <p className="explore-feed-message">{feed.empty || empty}</p>;
  return <>{feed.notice && <p className="explore-feed-message" role="status">{feed.notice}</p>}{children}</>;
}

function ArtistShelf({ id, title, subtitle, feed }) {
  return <section className="explore-section" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="circles" count={SHELF_SIZE} empty="No artists to show yet.">
      <div className="explore-artist-row">{feed.items.slice(0, SHELF_SIZE).map((artist) =>
        <DiscoveryArtistCard key={artist.id} artist={artist} />
      )}</div>
    </FeedBody>
  </section>;
}

function isExternalAlbum(album) {
  // Sample placeholders have no real catalog entry to import.
  return Boolean(album?.id && !album.sample && (album.external || album.source?.kind === "external"));
}

function AlbumShelf({ id, title, subtitle, feed, onPlay }) {
  return <section className="explore-section" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="squares" count={SHELF_SIZE} empty="No albums to show yet.">
      <div className="explore-album-row">{feed.items.slice(0, SHELF_SIZE).map((album) => isExternalAlbum(album)
        ? <ExternalAlbumCard key={album.id} album={album} onPlay={onPlay} />
        : <DiscoveryAlbumCard key={album.id} album={album} onPlay={onPlay} />
      )}</div>
    </FeedBody>
  </section>;
}

function TrackPanel({ id, title, subtitle, feed, onPlay }) {
  return <section className="explore-track-panel" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="tracks" count={TRACK_SIZE} empty="No songs to show yet.">
      <TrackActionScope tracks={feed.items.slice(0, TRACK_SIZE).map((song) => toUnifiedTrack(song, "explore"))} dataKey={id}>
      <div className="explore-track-list track-list--compact" role="table">{feed.items.slice(0, TRACK_SIZE).map((rawSong, index) => {
        const song = toUnifiedTrack(rawSong, "explore");
        return <TrackRow
          className="explore-track-row"
          key={`${song.id}-${index}`}
          song={song}
          index={index}
          showAlbum={false}
          onPlay={onPlay}


        />;
      })}</div></TrackActionScope>
    </FeedBody>
  </section>;
}

const genreTones = ["#593092", "#187477", "#a34645", "#476395", "#915b2f", "#456b3c", "#743e77", "#2c6b82"];
const genreSymbols = ["◈", "✦", "♫", "◒", "✳", "◆", "◎", "✺"];

function genreCards(albums = [], moods = []) {
  const counts = new Map();
  albums.forEach((album) => {
    if (album.genre?.trim()) {
      const genre = album.genre.trim();
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  });
  const genres = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => ({ name }));
  return [...genres, ...moods].slice(0, 12).map((item, index) => ({ ...item, tone: item.tone || genreTones[index % genreTones.length], symbol: item.symbol || genreSymbols[index % genreSymbols.length] }));
}

function ExploreContent() {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [heroColor, setHeroColor] = useState(null);
  const [actionMessage, setActionMessage] = useState("");
  const [personalizedDiscovery, setPersonalizedDiscovery] = useState(true);
  const discoverySubtitle = personalizedDiscovery ? "Favourite artists and new connections" : "Popular picks to get started";

  const { playSong, playQueue, audioEngine } = usePlayer();
  const playbackRequest = useRef(0);
  useEffect(() => () => { playbackRequest.current += 1; }, []);

  useEffect(() => {
    let active = true;
    const load = (key, loader) => {
      Promise.resolve().then(loader).then((items) => {
        if (active) setFeeds((previous) => ({ ...previous, [key]: { items: Array.isArray(items) ? items : [], loading: false, error: null } }));
      }).catch((error) => {
        if (active) setFeeds((previous) => ({ ...previous, [key]: { items: [], loading: false, error: error.message || "Could not load this section." } }));
      });
    };
    load("featured", externalDiscoveryService.getFeatured);
    load("popularArtists", externalDiscoveryService.getPopularArtists);
    load("popularAlbums", externalDiscoveryService.getPopularAlbums);
    load("popularTracks", async () => {
      const tracks = await externalDiscoveryService.getPopularTracks();
      if (active) {
        setFeeds((previous) => ({
          ...previous,
          popularTracks: { items: tracks, loading: false, error: null },
        }));
      }
      externalDiscoveryService.hydrateMissingPreviews(tracks)
        .then((hydrated) => {
          if (active) {
            setFeeds((previous) => ({
              ...previous,
              popularTracks: { ...previous.popularTracks, items: hydrated },
            }));
          }
        })
        .catch((error) => {
          console.warn("Could not resolve previews for external chart tracks:", error);
        });
      return tracks;
    });
    getPersonalizedDiscovery().then((data) => {
      if (!active) return;
      const fields = { discoverTracks: "tracks", discoverArtists: "artists", discoverAlbums: "albums" };
      setPersonalizedDiscovery(Boolean(data.personalized));
      setFeeds((previous) => ({ ...previous, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, {
        items: Array.isArray(data[field]) ? data[field] : [], loading: false, error: null,
        empty: data.message || "No new suggestions right now. Check back as you listen to more music.",
        notice: key === "discoverTracks" ? data.message : null,
      }])) }));
    }).catch((error) => {
      if (!active) return;
      setFeeds((previous) => ({ ...previous, ...Object.fromEntries(["discoverTracks", "discoverArtists", "discoverAlbums"].map((key) => [key, {
        items: [], loading: false, error: error.message || "Personalised discovery is temporarily unavailable.",
      }])) }));
    });
    load("genres", async () => {
      const [albums, moods] = await Promise.allSettled([getAlbums(100), externalDiscoveryService.getMoods()]);
      if (albums.status === "rejected" && moods.status === "rejected") throw albums.reason;
      return genreCards(albums.status === "fulfilled" ? albums.value : [], moods.status === "fulfilled" ? moods.value : []);
    });
    return () => { active = false; };
  }, []);

  const leadArtwork = getCoverUrl(feeds.featured.items[0]?.coverArt, 640);
  useEffect(() => {
    let active = true;
    extractArtworkColor(leadArtwork).then((color) => { if (active) setHeroColor(color); });
    return () => { active = false; };
  }, [leadArtwork]);

  async function playAlbum(album) {
    const request = ++playbackRequest.current;
    const isCurrent = () => request === playbackRequest.current;
    const external = isExternalAlbum(album);
    setActionMessage("");
    try {
      void Promise.resolve(audioEngine?.unlock?.()).catch(() => {});
      if (external) setActionMessage("Loading album previews…");
      const id = toAlbumRouteIdFromApiId(album.localAlbumId || album.id);
      const details = await getAlbum(id);
      if (!isCurrent()) return;
      if (!details.song?.length) throw new Error(`No playable tracks found for ${nameOf(album)}.`);
      let queue = details.song;
      if (external) {
        const inLibrary = song => song.isDownloaded || song.source?.kind === "library" || song.availability?.libraryAvailable;
        const tracks = details.song.map(song => toUnifiedTrack(song, "explore")).map(song =>
          inLibrary(song) || song.source?.kind === "external" ? song
            : { ...song, external: true, source: { kind: "external", count: 0 } });
        const candidates = tracks.filter(song => inLibrary(song) || trustedPreviewUrl(song.previewUrl));
        queue = [];
        for (const [index, song] of candidates.entries()) {
          if (inLibrary(song) || await canStreamPreview(song.previewUrl)) {
            queue = candidates.slice(index);
            break;
          }
          if (!isCurrent()) return;
        }
        if (!queue.length) {
          for (const song of tracks.slice(0, 3)) {
            const previewUrl = await resolveTrackPreview(song, isCurrent);
            if (!isCurrent()) return;
            if (previewUrl) {
              queue = [{ ...song, previewUrl }];
              break;
            }
          }
        }
        if (!queue.length) throw new Error("Preview unavailable for this album. Open it to see the track list.");
      }
      if (!isCurrent()) return;
      setActionMessage("");
      await playQueue(queue, 0, {
        type: "album", id, name: details.name || details.title || nameOf(album),
        coverArt: details.coverArt || album.coverArt || null,
      });
    } catch (error) {
      if (isCurrent()) setActionMessage(error.message || "Could not play this album.");
    }
  }

  async function playTrack(song) {
    const request = ++playbackRequest.current;
    const isCurrent = () => request === playbackRequest.current;
    setActionMessage("");
    const track = toUnifiedTrack(song, "explore");
    try {
      if (!track.external || track.isDownloaded) { await playSong(track); return; }
      void Promise.resolve(audioEngine?.unlock?.()).catch(() => {});
      setActionMessage("Loading preview…");
      const previewUrl = await resolveTrackPreview(track, isCurrent);
      if (!isCurrent()) return;
      if (!previewUrl) throw new Error(`Preview unavailable for ${track.title}.`);
      setActionMessage("");
      await playSong({ ...track, previewUrl, source: track.source?.kind === "external" ? track.source : { kind: "external", count: 0 } });
    } catch (error) {
      if (isCurrent()) setActionMessage(error.message || "Could not play this preview.");
    }
  }

  return <div className="explore-page" data-view-loading={Object.values(feeds).some((feed) => feed.loading)}>
    <div className="page-hero-gradient">
      <LightHero
        className="explore-page-heading"
        eyebrow="MusicDeck / Discover"
        title="Find your next favorite"
        subtitle="New music from favourite artists and new connections, alongside Deezer's current charts."
      />
    </div>
    {actionMessage && <p className="explore-action-message" role="status">{actionMessage}</p>}

    <section className="explore-section" aria-labelledby="explore-featured-title">
      <Header id="explore-featured-title" title="Trending Now / Featured" subtitle="Current chart picks from Deezer" featured />
      <FeedBody feed={feeds.featured} shape="hero" count={3} empty="Featured albums are unavailable.">
        <div className="explore-featured-grid" style={{ "--feature-rgb": heroColor || "104 62 148" }}>
          {feeds.featured.items.slice(0, 3).map((album, index) => <article className={`explore-featured-card${index === 0 ? " explore-featured-card--lead" : ""}`} key={album.id}>
            <Artwork item={album} className="explore-featured-image" />
            <div className="explore-featured-copy">
              <span className="explore-featured-kicker">{index === 0 ? "FEATURED ALBUM" : "IN THE SPOTLIGHT"} · DEEZER</span>
              <h3><Link to={itemLink(album, "album")}>{nameOf(album)}</Link></h3><p>{album.artist}</p>
              <div className="explore-featured-actions">
                <button type="button" onClick={() => playAlbum(album)}>▶ <span>Play</span></button>
                <Link to={itemLink(album, "album")}>View album</Link>
              </div>
            </div>
          </article>)}
        </div>
      </FeedBody>
    </section>

    <ArtistShelf id="explore-popular-artists" title="Artists Popular Externally" subtitle="Deezer charts" feed={feeds.popularArtists} />
    <AlbumShelf id="explore-popular-albums" title="Albums Popular Externally" subtitle="Deezer charts" feed={feeds.popularAlbums} onPlay={playAlbum} />
    <div className="explore-pulse" aria-label="The Pulse: track discovery">
      <TrackPanel id="explore-discover-songs" title="Discover Songs" subtitle={discoverySubtitle} feed={feeds.discoverTracks} onPlay={playTrack}    />
      <TrackPanel id="explore-popular-songs" title="Songs Popular Externally" subtitle="Deezer charts" feed={feeds.popularTracks} onPlay={playTrack}    />
    </div>
    <ArtistShelf id="explore-discover-artists" title="Discover Artists" subtitle={personalizedDiscovery ? "New artists connected to your favourites" : "New artists to explore"} feed={feeds.discoverArtists} />
    <AlbumShelf id="explore-discover-albums" title="Discover Albums" subtitle={discoverySubtitle} feed={feeds.discoverAlbums} onPlay={playAlbum} />
    <section className="explore-section" aria-labelledby="explore-genres">
      <Header id="explore-genres" title="Browse by Genre & Mood" subtitle="Library genres and moods" />
      <FeedBody feed={feeds.genres} shape="genres" count={8} empty="No genres to show yet.">
        <div className="explore-genres">{feeds.genres.items.map((genre) =>
          <Link className="explore-genre" key={genre.name} to={`/search?q=${encodeURIComponent(genre.name)}`} style={{ "--genre-tone": genre.tone }}>
            <strong>{genre.name}</strong><span aria-hidden="true">{genre.symbol}</span>
          </Link>
        )}</div>
      </FeedBody>
    </section>
  </div>;
}

export default function Explore() {
  const { canMetadata, policy } = usePrivacy();
  if (!canMetadata) return <section className="privacy-banner" role="status">
    <h1>{policy?.localOnly || policy?.enforcedByEnvironment ? "Local-Only Mode Enabled" : "External Discovery Disabled"}</h1>
    <p>{policy?.localOnly || policy?.enforcedByEnvironment ? "Local-Only Mode Enabled. Outbound metadata services are offline." : "Outbound metadata services are disabled by your administrator."}</p>
    <Link to="/albums">Browse your local albums</Link>
  </section>;
  return <ExploreContent />;
}
