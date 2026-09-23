import type { Album, Artist, Track } from "../types.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";
import { upscaleItunesArtwork } from "./itunes-artist-catalog.js";

const DEEZER = "https://api.deezer.com";
const ITUNES = "https://itunes.apple.com";
const POSITIVE_CACHE_MS = 5 * 60_000;
const NEGATIVE_CACHE_MS = 60_000;

export type ArtistMetadata = Pick<Artist, "id" | "name">;
export type LocalArtistCatalog = {
  artist: ArtistMetadata;
  albums: Pick<Album, "artistId" | "name">[];
  tracks: Pick<Track, "artistId" | "title">[];
};
export type ExternalArtistImageCandidate = {
  providerId: string;
  artistName: string;
  /** Must originate in a dedicated artist-picture field, never album coverArt. */
  pictureUrl: string | null;
  albumTitles: string[];
  trackTitles: string[];
};
export type VerifiedArtistImage = {
  artistId: string;
  providerId: string;
  pictureUrl: string;
  overlapCount: number;
  kind: "artist" | "artist-tile-fallback";
};

type DeezerArtist = {
  id?: number;
  name?: string;
  picture_xl?: string;
  picture_big?: string;
};
type DeezerRelease = { title?: string; title_short?: string };
type DeezerResponse<T> = { data?: T[]; error?: { message?: string } };
type ItunesItem = { artistId?: number; artistName?: string; collectionName?: string; artworkUrl100?: string };
type ItunesResponse = { results?: ItunesItem[] };

function titleKey(value: string) {
  return `${normalizeMusicText(value)}|${versionSignature(value)}`;
}

/** A CDN URL is not enough: the path must identify an artist picture. */
export function isDedicatedArtistPicture(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "dzcdn.net" || url.hostname.endsWith(".dzcdn.net"))
      && url.pathname.startsWith("/images/artist/");
  } catch {
    return false;
  }
}

/** Accept native artist-info portraits, but never local cover-art routes or album CDN images. */
export function isNativeArtistPicture(value: string | null, albums: Pick<Album, "artworkUrl">[] = []): value is string {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (/\/rest\/getCoverArt(?:\.view)?(?:\/|$)/i.test(url.pathname)
      || /\/api\/artwork\//i.test(url.pathname)
      || /\/(?:images\/)?(?:cover|album)\//i.test(url.pathname)) return false;
    return !albums.some((album) => album.artworkUrl === value);
  } catch {
    return false;
  }
}

export function artistImageOverlapCount(local: LocalArtistCatalog, candidate: ExternalArtistImageCandidate) {
  if (normalizeMusicText(local.artist.name) !== normalizeMusicText(candidate.artistName)) return 0;
  const albums = new Set(local.albums
    .filter((album) => album.artistId === local.artist.id)
    .map((album) => titleKey(album.name)));
  const tracks = new Set(local.tracks
    .filter((track) => track.artistId === local.artist.id)
    .map((track) => titleKey(track.title)));
  return candidate.albumTitles.filter((title) => albums.has(titleKey(title))).length
    + candidate.trackTitles.filter((title) => tracks.has(titleKey(title))).length;
}

export function verifyArtistImageCandidate(local: LocalArtistCatalog, candidate: ExternalArtistImageCandidate): boolean {
  return isDedicatedArtistPicture(candidate.pictureUrl)
    && artistImageOverlapCount(local, candidate) >= 1;
}

/** Non-blocking portrait lookup: Deezer artist picture, then marked iTunes album tile. */
export class ArtistImageResolver {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<VerifiedArtistImage | null> }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  purgeArtistImageCache(artistId?: string) {
    if (artistId) {
      for (const key of this.cache.keys()) if (key.startsWith(`${artistId}:`)) this.cache.delete(key);
    }
    else this.cache.clear();
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<DeezerResponse<T>> {
    const url = new URL(path, `${DEEZER}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Deezer returned ${response.status}`);
    const body = await response.json() as DeezerResponse<T>;
    if (body.error || !Array.isArray(body.data)) throw new Error("Deezer returned invalid artist data");
    return body;
  }

  private async candidate(item: DeezerArtist): Promise<ExternalArtistImageCandidate | null> {
    if (item.id == null || !item.name) return null;
    const [albums, tracks] = await Promise.all([
      this.request<DeezerRelease>(`/artist/${item.id}/albums`, { limit: "5" }).catch(() => ({ data: [] })),
      this.request<DeezerRelease>(`/artist/${item.id}/top`, { limit: "5" }).catch(() => ({ data: [] })),
    ]);
    return {
      providerId: `deezer:${item.id}`,
      artistName: item.name,
      pictureUrl: item.picture_xl || item.picture_big || null,
      albumTitles: (albums.data || []).flatMap((album) => album.title ? [album.title] : []),
      trackTitles: (tracks.data || []).flatMap((track) => track.title ? [track.title] : []),
    };
  }

  private async findDeezer(local: LocalArtistCatalog): Promise<VerifiedArtistImage | null> {
    const search = await this.request<DeezerArtist>("/search/artist", { q: local.artist.name, limit: "8" });
    const seen = new Set<number>();
    const exact = (search.data || []).filter((item) => {
      if (item.id == null || seen.has(item.id)
        || normalizeMusicText(item.name) !== normalizeMusicText(local.artist.name)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, 3);
    const candidates = await Promise.all(exact.map((item) => this.candidate(item).catch(() => null)));
    const ranked = candidates.flatMap((candidate) => {
      if (!candidate || !isDedicatedArtistPicture(candidate.pictureUrl)) return [];
      return [{ candidate, score: artistImageOverlapCount(local, candidate) }];
    }).sort((left, right) => right.score - left.score);
    // A single exact-name artist is a useful fallback when local catalog data
    // is sparse. Multiple zero-overlap names remain ambiguous and are rejected.
    if (!ranked.length || (ranked[0].score === 0 && exact.length !== 1)
      || ranked[1]?.score === ranked[0].score) return null;
    return {
      artistId: local.artist.id,
      providerId: ranked[0].candidate.providerId,
      pictureUrl: ranked[0].candidate.pictureUrl!,
      overlapCount: ranked[0].score,
      kind: "artist",
    };
  }

  private async findItunesTile(local: LocalArtistCatalog): Promise<VerifiedArtistImage | null> {
    const url = new URL("/search", ITUNES);
    url.searchParams.set("term", local.artist.name);
    url.searchParams.set("entity", "musicArtist");
    url.searchParams.set("limit", "1");
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const artist = ((await response.json()) as ItunesResponse).results?.[0];
    if (!artist?.artistId || normalizeMusicText(artist.artistName) !== normalizeMusicText(local.artist.name)) return null;

    const lookup = new URL("/lookup", ITUNES);
    lookup.searchParams.set("id", String(artist.artistId));
    lookup.searchParams.set("entity", "album");
    lookup.searchParams.set("limit", "20");
    const releases = await this.fetchImpl(lookup, { signal: AbortSignal.timeout(3_000) });
    if (!releases.ok) return null;
    const albums = ((await releases.json()) as ItunesResponse).results || [];
    const localTitles = new Set(local.albums.filter((album) => album.artistId === local.artist.id)
      .map((album) => titleKey(album.name)));
    const match = albums.find((album) => album.artistId === artist.artistId
      && album.collectionName && localTitles.has(titleKey(album.collectionName))
      && upscaleItunesArtwork(album.artworkUrl100));
    const pictureUrl = upscaleItunesArtwork(match?.artworkUrl100);
    return pictureUrl ? { artistId: local.artist.id, providerId: `itunes:${artist.artistId}`,
      pictureUrl, overlapCount: 1, kind: "artist-tile-fallback" } : null;
  }

  private async find(local: LocalArtistCatalog, skipDeezer: boolean): Promise<VerifiedArtistImage | null> {
    if (!skipDeezer) {
      const deezer = await this.findDeezer(local).catch(() => null);
      if (deezer) return deezer;
    }
    return this.findItunesTile(local).catch(() => null);
  }

  resolve(local: LocalArtistCatalog, options: { skipDeezer?: boolean } = {}): Promise<VerifiedArtistImage | null> {
    const key = `${local.artist.id}:${options.skipDeezer ? "itunes" : "cascade"}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.find(local, Boolean(options.skipDeezer)).catch(() => null);
    const entry = { expiresAt: Date.now() + POSITIVE_CACHE_MS, value };
    this.cache.set(key, entry);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    void value.then((image) => {
      if (!image && this.cache.get(key) === entry) entry.expiresAt = Date.now() + NEGATIVE_CACHE_MS;
    });
    return value;
  }
}
