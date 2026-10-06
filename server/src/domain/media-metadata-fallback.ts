import { normalizeMusicText } from "./music-identity.js";
import { upscaleItunesArtwork } from "./itunes-artist-catalog.js";

export type ArtistBiographyResult = { text: string; source: "wikipedia"; url: string };
type AlbumCandidate = { collectionName?: string; artistName?: string; artworkUrl100?: string };
type DeezerAlbum = { title?: string; artist?: { name?: string }; cover_xl?: string };
const MUSIC_CONTEXT = /\b(singer|musician|band|rapper|songwriter|vocalist|composer|record producer|recording artist|musical group|music group|rock group|hip[- ]hop|discography|album)s?\b/i;

export class MediaMetadataFallback {
  private readonly biographies = new Map<string, { expiresAt: number; value: Promise<ArtistBiographyResult | null> }>();
  private readonly covers = new Map<string, { expiresAt: number; value: Promise<string | null> }>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private cached<T>(
    cache: Map<string, { expiresAt: number; value: Promise<T | null> }>,
    key: string,
    lookup: () => Promise<T | null>
  ): Promise<T | null> {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    if (this.waiting.length >= 100) return Promise.reject(new Error("Metadata lookup capacity exceeded"));
    const slot = this.active < 5
      ? (this.active++, Promise.resolve())
      : new Promise<void>((resolve) => { this.waiting.push(resolve); });
    const entry: { expiresAt: number; value: Promise<T | null> } = {
      expiresAt: Number.POSITIVE_INFINITY, value: Promise.resolve(null),
    };
    entry.value = slot.then(lookup).then((result) => {
      entry.expiresAt = Date.now() + (result ? 24 * 60 * 60_000 : 5 * 60_000);
      return result;
    }).catch((error: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }).finally(() => {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    });
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return entry.value;
  }

  getBiography(artist: string): Promise<ArtistBiographyResult | null> {
    return this.cached(this.biographies, normalizeMusicText(artist), async () => {
      for (const title of [artist, `${artist} (musician)`, `${artist} (band)`, `${artist} (singer)`]) {
        const response = await this.fetchImpl(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, "_"))}`,
          { signal: AbortSignal.timeout(4_000), redirect: "error", headers: { Accept: "application/json" } }
        );
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
        const data = await response.json() as { type?: string; extract?: string; description?: string; title?: string };
        if (data.type === "disambiguation" || typeof data.extract !== "string") continue;
        const text = data.extract.replace(/<[^>]*>/g, " ").replace(/\[(?:\d+|citation needed)\]/gi, "")
          .replace(/\s+/g, " ").trim();
        if (!text || !MUSIC_CONTEXT.test(`${data.description || ""} ${text}`)) continue;
        const pageTitle = typeof data.title === "string" && data.title.trim() ? data.title : title;
        return { text: text.slice(0, 800), source: "wikipedia",
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/\s+/g, "_"))}` };
      }
      return null;
    });
  }

  getAlbumCover(artist: string, album: string): Promise<string | null> {
    return this.cached(this.covers, JSON.stringify([normalizeMusicText(artist), normalizeMusicText(album)]), async () => {
      const itunes = new URL("https://itunes.apple.com/search");
      itunes.searchParams.set("term", `${artist} ${album}`);
      itunes.searchParams.set("entity", "album");
      itunes.searchParams.set("limit", "10");
      let itunesError: unknown;
      try {
        const response = await this.fetchImpl(itunes, { signal: AbortSignal.timeout(4_000), redirect: "error" });
        if (!response.ok) throw new Error(`iTunes returned ${response.status}`);
        const data = await response.json() as { results?: AlbumCandidate[] };
        if (!Array.isArray(data.results)) throw new Error("iTunes returned invalid album data");
        const match = data.results.find((item) => normalizeMusicText(item.artistName) === normalizeMusicText(artist)
          && normalizeMusicText(item.collectionName) === normalizeMusicText(album) && this.coverUrl(item.artworkUrl100));
        const image = upscaleItunesArtwork(match?.artworkUrl100);
        if (image) return image;
      } catch (error) { itunesError = error; }
      const deezer = new URL("https://api.deezer.com/search/album");
      deezer.searchParams.set("q", `${artist} ${album}`);
      deezer.searchParams.set("limit", "10");
      const alternate = await this.fetchImpl(deezer, { signal: AbortSignal.timeout(4_000), redirect: "error" });
      if (!alternate.ok) throw new Error(`Deezer returned ${alternate.status}`);
      const albums = await alternate.json() as { data?: DeezerAlbum[] };
      if (!Array.isArray(albums.data)) throw new Error("Deezer returned invalid album data");
      const fallback = albums.data.find((item) => normalizeMusicText(item.artist?.name) === normalizeMusicText(artist)
        && normalizeMusicText(item.title) === normalizeMusicText(album) && this.coverUrl(item.cover_xl));
      if (fallback?.cover_xl) return fallback.cover_xl;
      if (itunesError) throw itunesError;
      return null;
    });
  }

  private coverUrl(value: string | undefined): boolean {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port
        && ["mzstatic.com", "dzcdn.net"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  }

  async fetchCover(url: string): Promise<Response> {
    if (!this.coverUrl(url)) throw new Error("Invalid metadata artwork URL");
    return this.fetchImpl(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  }
}
