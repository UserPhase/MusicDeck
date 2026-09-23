import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getAlbum, getAlbums, getCoverUrl, getExplore, getRecommendations, searchNavidrome, setMediaFavorite } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import { externalDiscoveryService } from "../services/externalDiscovery";
import { extractArtworkColor } from "../utils/extractArtworkColor";
import { formatDuration } from "../utils/formatDuration";
import ArtistAvatar from "../components/ArtistAvatar";

const SHELF_SIZE = 7;
const TRACK_SIZE = 6;
const feedKeys = ["featured", "popularArtists", "popularAlbums", "popularTracks", "discoverTracks", "discoverArtists", "discoverAlbums", "genres"];
const initialFeeds = () => Object.fromEntries(feedKeys.map((key) => [key, { items: [], loading: true, error: null }]));
const nameOf = (item) => item?.name || item?.title || "Unknown";
const itemLink = (item, type) => item.external || item.sample
  ? `/search?q=${encodeURIComponent(type === "album" ? `${nameOf(item)} ${item.artist || ""}`.trim() : nameOf(item))}`
  : `/${type}/${encodeURIComponent(item.id)}`;

function recommendedEntities(tracks, catalog, type) {
  const catalogByName = new Map(catalog.map((item) => [nameOf(item).toLowerCase(), item]));
  const picked = tracks.map((track) => {
    if (type === "artist") {
      const name = track.artist;
      if (!track.metadata?.artistId || !name) return null;
      const match = catalogByName.get(name.toLowerCase());
      return { id: track.metadata.artistId, name, type, coverArt: match?.coverArt || null };
    }
    if (!track.metadata?.albumId || !track.album) return null;
    return { id: track.metadata.albumId, title: track.album, artist: track.artist, type, coverArt: track.coverArt || null };
  }).filter(Boolean);
  const seen = new Set();
  return [...picked, ...catalog].filter((item) => {
    const key = type === "artist" ? nameOf(item).toLowerCase() : `${nameOf(item).toLowerCase()}:${(item.artist || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, SHELF_SIZE);
}

function Artwork({ item, className = "" }) {
  const [failed, setFailed] = useState(false);
  const image = getCoverUrl(item?.coverArt, 360);
  return <span className={`explore-artwork ${className}`}>
    {image && !failed ? <img src={image} alt="" onError={() => setFailed(true)} /> : <span className="explore-artwork-fallback" aria-hidden="true">{nameOf(item).slice(0, 1).toUpperCase()}</span>}
  </span>;
}

function Header({ id, title, subtitle }) {
  return <div className="explore-section-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>;
}

function Skeleton({ shape, count }) {
  return <div className={`explore-skeletons explore-skeletons--${shape}`} aria-label="Loading section">
    {Array.from({ length: count }, (_, index) => <span className="explore-skeleton" key={index} />)}
  </div>;
}

function FeedBody({ feed, shape, count, empty, children }) {
  if (feed.loading) return <Skeleton shape={shape} count={count} />;
  if (feed.error) return <p className="explore-feed-message" role="status">{feed.error}</p>;
  if (!feed.items.length) return <p className="explore-feed-message">{empty}</p>;
  return children;
}

function ArtistShelf({ id, title, subtitle, feed }) {
  return <section className="explore-section" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="circles" count={SHELF_SIZE} empty="No artists to show yet.">
      <div className="explore-artist-row">{feed.items.slice(0, SHELF_SIZE).map((artist) =>
        <Link className="explore-artist" key={artist.id} to={itemLink(artist, "artist")}>
          <ArtistAvatar artist={artist} className="explore-artist-image" allowAlbumTileFallback />
          <span className="explore-card-name">{nameOf(artist)}</span>
        </Link>
      )}</div>
    </FeedBody>
  </section>;
}

function AlbumShelf({ id, title, subtitle, feed, onPlay }) {
  return <section className="explore-section" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="squares" count={SHELF_SIZE} empty="No albums to show yet.">
      <div className="explore-album-row">{feed.items.slice(0, SHELF_SIZE).map((album) =>
        <article className="explore-album" key={album.id}>
          <div className="explore-album-image">
            <Link to={itemLink(album, "album")} aria-label={`Open ${nameOf(album)}`}><Artwork item={album} /></Link>
            <button type="button" onClick={() => onPlay(album)} aria-label={`Play ${nameOf(album)}`} className="explore-album-play">▶</button>
          </div>
          <Link className="explore-card-name" to={itemLink(album, "album")}>{nameOf(album)}</Link>
          <span className="explore-card-subtitle">{album.artist || "Unknown artist"}</span>
        </article>
      )}</div>
    </FeedBody>
  </section>;
}

function TrackPanel({ id, title, subtitle, feed, onPlay }) {
  return <section className="explore-track-panel" aria-labelledby={id}>
    <Header id={id} title={title} subtitle={subtitle} />
    <FeedBody feed={feed} shape="tracks" count={TRACK_SIZE} empty="No songs to show yet.">
      <div className="explore-track-list">{feed.items.slice(0, TRACK_SIZE).map((song) =>
        <button className="explore-track" type="button" key={song.id} onClick={() => onPlay(song)} aria-label={`Play ${nameOf(song)}`}>
          <Artwork item={song} className="explore-track-image" />
          <span className="explore-track-copy"><strong>{nameOf(song)}</strong><small>{song.artist || "Unknown artist"}</small></span>
          <time>{song.durationLabel || formatDuration(song.duration || song.metadata?.durationSeconds)}</time>
        </button>
      )}</div>
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

function Explore() {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [heroColor, setHeroColor] = useState(null);
  const [actionMessage, setActionMessage] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [savedIds, setSavedIds] = useState([]);
  const { playSong, playQueue } = usePlayer();

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
    load("popularTracks", externalDiscoveryService.getPopularTracks);
    const localDiscovery = getExplore();
    const recommendations = getRecommendations(["discover", "similar-artists"], 14);
    const recommendedTracks = recommendations.then((data) => (data.sections || []).flatMap((section) => section.items || []));
    load("discoverTracks", () => recommendedTracks.then((tracks) => tracks.slice(0, TRACK_SIZE)));
    const discoverEntities = async (type) => {
      const [tracks, catalog] = await Promise.allSettled([recommendedTracks, localDiscovery]);
      if (tracks.status === "rejected" && catalog.status === "rejected") throw tracks.reason;
      return recommendedEntities(
        tracks.status === "fulfilled" ? tracks.value : [],
        catalog.status === "fulfilled" ? (catalog.value[type === "artist" ? "artists" : "albums"] || []) : [],
        type
      );
    };
    load("discoverArtists", () => discoverEntities("artist"));
    load("discoverAlbums", () => discoverEntities("album"));
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

  async function resolveAlbum(album) {
    if (!album.external && !album.sample) return album.id;
    const results = await searchNavidrome(nameOf(album), { mode: "library" });
    const matching = (results.results?.album || []).find((item) => nameOf(item).toLowerCase() === nameOf(album).toLowerCase() && item.artist?.toLowerCase() === album.artist?.toLowerCase());
    return matching?.id || null;
  }

  async function playAlbum(album) {
    setActionMessage("");
    try {
      const id = await resolveAlbum(album);
      if (!id) throw new Error(`${nameOf(album)} is not available in your local library.`);
      const details = await getAlbum(id);
      if (!details.song?.length) throw new Error(`No playable tracks found for ${nameOf(album)}.`);
      playQueue(details.song, 0);
    } catch (error) {
      setActionMessage(error.message || "Could not play this album.");
    }
  }

  async function playTrack(song) {
    setActionMessage("");
    if (!song.external && !song.sample) { playSong(song); return; }
    try {
      const results = await searchNavidrome(nameOf(song), { mode: "library" });
      const matching = (results.results?.track || []).find((item) => nameOf(item).toLowerCase() === nameOf(song).toLowerCase() && item.artist?.toLowerCase() === song.artist?.toLowerCase());
      if (!matching) throw new Error(`External track — ${nameOf(song)} is not available in your local library.`);
      playSong(matching);
    } catch (error) {
      setActionMessage(error.message || "Could not play this song.");
    }
  }

  async function saveAlbum(album) {
    setActionMessage("");
    setSavingId(album.id);
    try {
      const id = await resolveAlbum(album);
      if (!id) throw new Error(`${nameOf(album)} is not available in your local library.`);
      await setMediaFavorite("album", id, true);
      setSavedIds((previous) => [...previous, album.id]);
      setActionMessage(`${nameOf(album)} saved to your favorites.`);
    } catch (error) {
      setActionMessage(error.message || "Could not save this album.");
    } finally {
      setSavingId(null);
    }
  }

  return <div className="explore-page">
    <header className="explore-page-heading">
      <p className="explore-eyebrow">MusicDeck / Explore</p>
      <h1>Find your next favorite</h1>
      <p>Fresh directions from your library, alongside Deezer's current charts.</p>
    </header>
    {actionMessage && <p className="explore-action-message" role="status">{actionMessage}</p>}

    <section className="explore-section" aria-labelledby="explore-featured-title">
      <Header id="explore-featured-title" title="Trending Now / Featured" subtitle="Current chart picks from Deezer" />
      <FeedBody feed={feeds.featured} shape="hero" count={3} empty="Featured albums are unavailable.">
        <div className="explore-featured-grid" style={{ "--feature-rgb": heroColor || "104 62 148" }}>
          {feeds.featured.items.slice(0, 3).map((album, index) => <article className={`explore-featured-card${index === 0 ? " explore-featured-card--lead" : ""}`} key={album.id}>
            <Artwork item={album} className="explore-featured-image" />
            <div className="explore-featured-copy">
              <span className="explore-featured-kicker">{index === 0 ? "FEATURED ALBUM" : "IN THE SPOTLIGHT"} · DEEZER</span>
              <h3>{nameOf(album)}</h3><p>{album.artist}</p>
              <div className="explore-featured-actions">
                <button type="button" onClick={() => playAlbum(album)}>▶ <span>Play</span></button>
                <button type="button" onClick={() => saveAlbum(album)} disabled={savingId === album.id || savedIds.includes(album.id)}>{savedIds.includes(album.id) ? "Saved" : "Save to Library"}</button>
              </div>
            </div>
          </article>)}
        </div>
      </FeedBody>
    </section>

    <ArtistShelf id="explore-popular-artists" title="Artists Popular Externally" subtitle="Deezer charts" feed={feeds.popularArtists} />
    <AlbumShelf id="explore-popular-albums" title="Albums Popular Externally" subtitle="Deezer charts" feed={feeds.popularAlbums} onPlay={playAlbum} />
    <div className="explore-pulse" aria-label="The Pulse: track discovery">
      <TrackPanel id="explore-discover-songs" title="Discover Songs" subtitle="Based on your listening" feed={feeds.discoverTracks} onPlay={playTrack} />
      <TrackPanel id="explore-popular-songs" title="Songs Popular Externally" subtitle="Deezer charts" feed={feeds.popularTracks} onPlay={playTrack} />
    </div>
    <ArtistShelf id="explore-discover-artists" title="Discover Artists" subtitle="New voices for your library" feed={feeds.discoverArtists} />
    <AlbumShelf id="explore-discover-albums" title="Discover Albums" subtitle="A fresh shelf to explore" feed={feeds.discoverAlbums} onPlay={playAlbum} />
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

export default Explore;
