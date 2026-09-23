import { useEffect, useId, useRef, useState } from "react";
import { getArtistPortrait, getCoverUrl, getMusicBrainzArtistPortrait } from "../api/musicdeck";

const pendingPortraits = new Map();
const AVATAR_CACHE_MS = 4 * 60_000;

function avatarKey(artistId) { return `artist_avatar:${artistId}`; }
function musicBrainzKey(artistId) { return `artist_avatar_mb:${artistId}`; }

function readCachedMusicBrainz(artistId, name) {
  try {
    const cached = JSON.parse(localStorage.getItem(musicBrainzKey(artistId)) || "null");
    const url = new URL(cached?.url);
    if (cached?.name === name && url.protocol === "https:"
      && url.hostname === "upload.wikimedia.org") {
      return { url: cached.url, source: "musicbrainz", kind: "artist", fromCache: true };
    }
  } catch { /* Optional cache. */ }
  return null;
}

function readCachedPortrait(artistId, name) {
  try {
    const cached = JSON.parse(localStorage.getItem(avatarKey(artistId)) || "null");
    if (cached?.name === name && cached.expiresAt > Date.now() && cached.portrait?.url) {
      return { ...cached.portrait, fromCache: true };
    }
  } catch { /* Storage can be unavailable. */ }
  return null;
}

function saveCachedPortrait(artistId, name, portrait) {
  if (portrait?.source === "musicbrainz") {
    try { localStorage.setItem(musicBrainzKey(artistId), JSON.stringify({ name, url: portrait.url })); }
    catch { /* Image display does not depend on storage. */ }
    return;
  }
  if (!["native", "deezer", "itunes"].includes(portrait?.source)) return;
  try {
    localStorage.setItem(avatarKey(artistId), JSON.stringify({ name,
      portrait: { url: portrait.url, source: portrait.source, kind: portrait.kind },
      expiresAt: Date.now() + AVATAR_CACHE_MS }));
  } catch { /* Image display does not depend on storage. */ }
}

function clearCachedPortrait(artistId) {
  try { localStorage.removeItem(avatarKey(artistId)); } catch { /* Optional cache. */ }
}

function clearCachedMusicBrainz(artistId) {
  try { localStorage.removeItem(musicBrainzKey(artistId)); } catch { /* Optional cache. */ }
}

function normalizePortrait(value) {
  if (typeof value === "string") return { url: value, source: "deezer", kind: "artist" };
  return value?.url ? value : null;
}

function portraitFor(artistId, options = {}) {
  const key = `${artistId}:${options.skipNative ? 1 : 0}:${options.skipDeezer ? 1 : 0}`;
  if (!pendingPortraits.has(key)) {
    const request = getArtistPortrait(artistId, options).finally(() => pendingPortraits.delete(key));
    pendingPortraits.set(key, request);
  }
  return pendingPortraits.get(key);
}

export function artistInitials(name) {
  const words = String(name || "").split(/\s+/).map((part) => part.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return words.slice(0, 2).map((word) => [...word][0]).join("").toUpperCase() || "?";
}

function hashArtist(value) {
  let hash = 2166136261;
  for (const character of String(value || "artist")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function ArtistAvatarFallback({ artistId, name }) {
  const gradientId = useId();
  const hue = 224 + (hashArtist(artistId || name) % 72);
  return (
    <svg className="artist-avatar-fallback" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 39% 30%)`} />
          <stop offset="100%" stopColor={`hsl(${hue + 18} 33% 11%)`} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill={`url(#${gradientId})`} />
      <text x="50" y="53" textAnchor="middle" dominantBaseline="middle" fill="#fff"
        fontWeight="750" fontSize={artistInitials(name).length > 1 ? "36" : "43"}
        letterSpacing="-2">{artistInitials(name)}</text>
    </svg>
  );
}

/** Local portraits are ID-scoped; external artist entities may supply artist artwork. */
export default function ArtistAvatar({ artist, className = "", allowAlbumTileFallback = false,
  enableMusicBrainzFallback = false }) {
  const artistId = artist?.id ? String(artist.id) : "";
  const name = artist?.name || artist?.title || "Unknown artist";
  const [portrait, setPortrait] = useState(() => enableMusicBrainzFallback
    ? readCachedMusicBrainz(artistId, name) : null);
  const [loaded, setLoaded] = useState(false);
  const [fallbackRequested, setFallbackRequested] = useState(false);
  const activeArtist = useRef(artistId);
  const isExternal = Boolean(artist?.external || artist?.sample || artist?.source?.kind === "external"
    || /^(external_|extdetail_|deezer_)/.test(artistId));

  useEffect(() => {
    let active = true;
    activeArtist.current = artistId;
    setPortrait(null);
    setLoaded(false);
    setFallbackRequested(false);
    if (!artistId) return () => { active = false; };
    if (isExternal) {
      const url = artist?.imageUrl || getCoverUrl(artist?.coverArt, 500);
      if (url) setPortrait({ url, source: "external", kind: "artist" });
      return () => { active = false; };
    }
    const musicBrainzCached = enableMusicBrainzFallback && readCachedMusicBrainz(artistId, name);
    if (musicBrainzCached) {
      setPortrait(musicBrainzCached);
      return () => { active = false; activeArtist.current = ""; };
    }
    const cached = readCachedPortrait(artistId, name);
    if (cached && (cached.kind !== "artist-tile-fallback" || allowAlbumTileFallback)) {
      setPortrait(cached);
      return () => { active = false; };
    }
    portraitFor(artistId).then((result) => {
      const resolved = normalizePortrait(result);
      if (active && resolved && (resolved.kind !== "artist-tile-fallback" || allowAlbumTileFallback)) {
        setPortrait(resolved);
      } else if (active && enableMusicBrainzFallback) setFallbackRequested(true);
    }).catch(() => { if (active && enableMusicBrainzFallback) setFallbackRequested(true); });
    return () => { active = false; activeArtist.current = ""; };
  }, [artistId, name, isExternal, artist?.imageUrl, artist?.coverArt,
    allowAlbumTileFallback, enableMusicBrainzFallback]);

  useEffect(() => {
    if (!fallbackRequested || !artistId || isExternal || !enableMusicBrainzFallback) return;
    let active = true;
    let preloader;
    getMusicBrainzArtistPortrait(artistId).then((result) => {
      if (!active || !result?.url) return;
      preloader = new Image();
      preloader.onload = () => {
        if (active) setPortrait(result);
      };
      preloader.onerror = () => {};
      preloader.src = result.url;
    }).catch(() => {});
    return () => { active = false; if (preloader) { preloader.onload = null; preloader.onerror = null; } };
  }, [fallbackRequested, artistId, isExternal, enableMusicBrainzFallback]);

  function handleImageError() {
    setLoaded(false);
    setPortrait(null);
    clearCachedPortrait(artistId);
    if (portrait?.source === "musicbrainz") {
      clearCachedMusicBrainz(artistId);
      setFallbackRequested(false);
      return;
    }
    if (isExternal) return;
    const options = portrait?.source === "native" ? { skipNative: true }
        : portrait?.source === "deezer" ? { skipNative: true, skipDeezer: true } : null;
    if (!options) { if (enableMusicBrainzFallback) setFallbackRequested(true); return; }
    portraitFor(artistId, options).then((result) => {
      const resolved = normalizePortrait(result);
      if (activeArtist.current === artistId && resolved
        && resolved.url !== portrait?.url
        && (resolved.kind !== "artist-tile-fallback" || allowAlbumTileFallback)) setPortrait(resolved);
      else if (activeArtist.current === artistId && enableMusicBrainzFallback) setFallbackRequested(true);
    }).catch(() => { if (activeArtist.current === artistId && enableMusicBrainzFallback) setFallbackRequested(true); });
  }

  return (
    <span className={`artist-avatar ${className}`} aria-hidden="true">
      <ArtistAvatarFallback artistId={artistId} name={name} />
      {portrait && <img key={portrait.url} className={`artist-avatar-photo${loaded ? " is-loaded" : ""}`}
        src={portrait.url} alt="" decoding="async" onLoad={() => {
          setLoaded(true);
          saveCachedPortrait(artistId, name, portrait);
        }}
        onError={handleImageError} />}
    </span>
  );
}
