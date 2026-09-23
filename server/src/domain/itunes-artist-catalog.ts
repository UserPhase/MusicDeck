import type { Album, Artist, Track } from "../types.js";
import type { ExternalArtworkTokenStore, ExternalAlbumDetail } from "./external-catalog.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";
import type { UnifiedSearchResult } from "./search.js";

const BASE_URL = "https://itunes.apple.com";
const CACHE_MS = 7 * 24 * 60 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

type ItunesItem = {
  wrapperType?: string;
  kind?: string;
  artistId?: number;
  artistName?: string;
  collectionId?: number;
  collectionName?: string;
  collectionViewUrl?: string;
  trackId?: number;
  trackName?: string;
  trackTimeMillis?: number;
  releaseDate?: string;
  primaryGenreName?: string;
  artworkUrl100?: string;
};

type ItunesResponse = { resultCount?: number; results?: ItunesItem[] };

export type ItunesArtistCatalogResult = {
  albums: Array<{
    id: string;
    title: string;
    year: number | null;
    releaseDate: string | null;
    genre: string | null;
    artworkId: string | null;
    storeUrl: string | null;
    identity: { id: string; strength: "provider" };
  }>;
  tracks: UnifiedSearchResult[];
};

type CachedCatalog = {
  artistId: number;
  albums: ItunesItem[];
  tracks: ItunesItem[];
};

/** Keep meaningful editions distinct while folding punctuation/case variants. */
export function itunesReleaseKey(title: string) {
  return `${normalizeMusicText(title)}|${versionSignature(title)}`;
}

export function sameItunesRecording(local: Track, external: UnifiedSearchResult, artist: Artist) {
  const duration = external.metadata.durationSeconds;
  return external.type === "track"
    && local.artistId === artist.id
    && normalizeMusicText(external.artist) === normalizeMusicText(artist.name)
    && normalizeMusicText(local.title).length >= 8
    && itunesReleaseKey(local.title) === itunesReleaseKey(external.title)
    && typeof duration === "number"
    && typeof local.durationSeconds === "number"
    && Math.abs(local.durationSeconds - duration) <= 20;
}

function artistCreditMatches(candidate: string | undefined, local: string) {
  const exact = normalizeMusicText(candidate);
  const target = normalizeMusicText(local);
  if (!exact || !target) return false;
  if (exact === target) return true;
  // Accept a first-billed collaboration, never a partial artist-name match.
  const firstCredit = (candidate || "").split(/\s*(?:,|&|\/|\bfeat\.?\b|\bfeaturing\b)\s*/i)[0];
  return normalizeMusicText(firstCredit) === target;
}

function releaseYear(value: string | undefined): number | null {
  if (!value) return null;
  const year = new Date(value).getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

export function upscaleItunesArtwork(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^(?:[a-z0-9-]+\.)?mzstatic\.com$/i.test(url.hostname)) return null;
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/100x100bb\.(jpg|jpeg|png|webp)$/i, "1000x1000bb.$1");
    return url.toString();
  } catch {
    return null;
  }
}

/** Keyless iTunes metadata, anchored to an exact local artist ID and release. */
export class ItunesArtistCatalog {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<CachedCatalog | null> }>();
  private readonly albumCache = new Map<string, { expiresAt: number; value: Promise<ExternalAlbumDetail | null> }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly artwork?: ExternalArtworkTokenStore) {}

  private async request(path: "search" | "lookup", params: Record<string, string>): Promise<ItunesItem[]> {
    const url = new URL(path, `${BASE_URL}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`iTunes returned ${response.status}`);
    const payload = await response.json() as ItunesResponse;
    if (!Array.isArray(payload.results)) throw new Error("iTunes returned invalid results");
    return payload.results;
  }

  private trimCache<T>(cache: Map<string, T>) {
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }

  private async fetchCatalog(artist: Artist, localAlbums: Album[]): Promise<CachedCatalog | null> {
    const search = await this.request("search", {
      term: artist.name, media: "music", entity: "album", limit: "50",
    });
    const localKeys = new Set(localAlbums
      .filter((album) => album.artistId === artist.id)
      .map((album) => itunesReleaseKey(album.name)));
    const groups = new Map<number, { score: number; albums: ItunesItem[] }>();
    for (const item of search) {
      if (item.collectionId == null || item.artistId == null || !item.collectionName
        || !artistCreditMatches(item.artistName, artist.name)) continue;
      const group = groups.get(item.artistId) || { score: 0, albums: [] };
      group.albums.push(item);
      if (localKeys.has(itunesReleaseKey(item.collectionName))) group.score += 1;
      groups.set(item.artistId, group);
    }
    const ranked = [...groups].sort((left, right) => right[1].score - left[1].score);
    // A name alone is not proof of identity. If the store lacks a local
    // release anchor (or multiple IDs tie), keep the trusted local catalog.
    if (!ranked.length || ranked[0][1].score === 0
      || ranked[1]?.[1].score === ranked[0][1].score) return null;
    const [itunesArtistId, matched] = ranked[0];

    // ID lookup is less prone to search false positives and returns releases
    // beyond the search page. Keep the search result if lookup is unavailable.
    const [albums, tracks] = await Promise.all([
      this.request("lookup", { id: String(itunesArtistId), entity: "album", limit: "200" })
        .catch(() => matched.albums),
      this.request("lookup", { id: String(itunesArtistId), entity: "song", limit: "25" })
        .catch(() => [] as ItunesItem[]),
    ]);
    return { artistId: itunesArtistId, albums: albums.some((item) => item.wrapperType === "collection") ? albums : matched.albums, tracks };
  }

  async resolve(artist: Artist, localAlbums: Album[], localTracks: Track[]): Promise<ItunesArtistCatalogResult | null> {
    if (!localAlbums.length && !localTracks.length) return null;
    const key = `itunes_catalog:${artist.id}`;
    const cached = this.cache.get(key);
    let value: Promise<CachedCatalog | null>;
    if (cached && cached.expiresAt > Date.now()) {
      value = cached.value;
    } else {
      value = this.fetchCatalog(artist, localAlbums).catch(() => null);
      const entry = { expiresAt: Date.now() + CACHE_MS, value };
      this.cache.set(key, entry);
      this.trimCache(this.cache);
      void value.then((result) => {
        if (!result && this.cache.get(key) === entry) entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
      });
    }
    const catalog = await value;
    if (!catalog) return null;
    const seen = new Set<string>();
    const albums = catalog.albums.flatMap((item) => {
      if (item.collectionId == null || item.artistId !== catalog.artistId || !item.collectionName
        || !artistCreditMatches(item.artistName, artist.name)) return [];
      const releaseKey = itunesReleaseKey(item.collectionName);
      if (seen.has(releaseKey)) return [];
      seen.add(releaseKey);
      return [{
        id: `external_itunes_album_${item.collectionId}`,
        title: item.collectionName,
        year: releaseYear(item.releaseDate),
        releaseDate: item.releaseDate || null,
        genre: item.primaryGenreName || null,
        artworkId: this.artwork?.token(upscaleItunesArtwork(item.artworkUrl100), [".mzstatic.com"]) || null,
        storeUrl: item.collectionViewUrl || null,
        identity: { id: `itunes:album:${item.collectionId}`, strength: "provider" as const },
      }];
    });
    const tracks = catalog.tracks.flatMap((item): UnifiedSearchResult[] => {
      if (item.trackId == null || !item.trackName || item.artistId !== catalog.artistId
        || !artistCreditMatches(item.artistName, artist.name)) return [];
      const artworkId = this.artwork?.token(upscaleItunesArtwork(item.artworkUrl100), [".mzstatic.com"]) || null;
      return [{
        type: "track", id: `external_itunes_track_${item.trackId}`,
        title: item.trackName, subtitle: item.artistName || artist.name,
        artist: item.artistName || artist.name, album: item.collectionName || null,
        artwork: artworkId ? { id: artworkId, url: `/api/artwork/external/${encodeURIComponent(artworkId)}` } : null,
        provider: "external", source: { kind: "external", count: 0 }, availability: null,
        identity: { id: `itunes:track:${item.trackId}`, strength: "provider" },
        metadata: {
          artistId: artist.id,
          albumId: item.collectionId != null ? `external_itunes_album_${item.collectionId}` : null,
          durationSeconds: typeof item.trackTimeMillis === "number" ? Math.round(item.trackTimeMillis / 1000) : null,
        },
      }];
    }).slice(0, 10);
    return { albums, tracks };
  }

  async getAlbum(id: string): Promise<ExternalAlbumDetail | null> {
    if (!/^external_itunes_album_[0-9]+$/.test(id)) return null;
    const cached = this.albumCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.loadAlbum(id).catch(() => null);
    // Artwork proxy tokens expire after ten minutes; refresh album details
    // before they expire rather than caching dead URLs for seven days.
    this.albumCache.set(id, { expiresAt: Date.now() + 5 * 60_000, value });
    this.trimCache(this.albumCache);
    return value;
  }

  private async loadAlbum(id: string): Promise<ExternalAlbumDetail | null> {
    const collectionId = id.slice("external_itunes_album_".length);
    const items = await this.request("lookup", { id: collectionId, entity: "song", limit: "200" });
    const album = items.find((item) => String(item.collectionId) === collectionId && item.wrapperType === "collection");
    if (!album?.collectionName) return null;
    const artworkId = this.artwork?.token(upscaleItunesArtwork(album.artworkUrl100), [".mzstatic.com"]) || null;
    const tracks = items.flatMap((item): UnifiedSearchResult[] => {
      if (item.kind !== "song" || item.trackId == null || String(item.collectionId) !== collectionId) return [];
      return [{
        type: "track", id: `external_itunes_track_${item.trackId}`,
        title: item.trackName || "Unknown title", subtitle: item.artistName || null,
        artist: item.artistName || null, album: album.collectionName || null,
        artwork: artworkId ? { id: artworkId, url: `/api/artwork/external/${encodeURIComponent(artworkId)}` } : null,
        provider: "external", source: { kind: "external", count: 0 }, availability: null,
        identity: { id: `itunes:track:${item.trackId}`, strength: "provider" },
        metadata: {
          artistId: item.artistId != null ? `external_itunes_artist_${item.artistId}` : null,
          albumId: id,
          durationSeconds: typeof item.trackTimeMillis === "number" ? Math.round(item.trackTimeMillis / 1000) : null,
        },
      }];
    });
    return {
      id, title: album.collectionName, artist: album.artistName || "Unknown artist",
      artistId: album.artistId != null ? `external_itunes_artist_${album.artistId}` : null,
      year: releaseYear(album.releaseDate), releaseDate: album.releaseDate || null,
      genre: album.primaryGenreName || null, label: null, artworkId, tracks,
      identity: { id: `itunes:album:${collectionId}`, strength: "provider" },
    };
  }
}
