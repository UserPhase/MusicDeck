import { createId } from "../utils/ids.js";
import type { CanonicalIdentity, UnifiedSearchResult } from "./search.js";
import { normalizeMusicText } from "./music-identity.js";

export type ExternalArtworkRecord = {
  url: string;
  expiresAt: number;
};

export type ExternalDetailRecord = {
  type: "album" | "artist";
  providerId: string;
  expiresAt: number;
};

export type ExternalAlbumDetail = {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  year: number | null;
  releaseDate: string | null;
  genre: string | null;
  label: string | null;
  artworkId: string | null;
  tracks: UnifiedSearchResult[];
  identity: CanonicalIdentity;
};

export type ExternalArtistAlbum = {
  id: string;
  title: string;
  year: number | null;
  artworkId: string | null;
  identity: CanonicalIdentity;
};

export type ExternalArtistDetail = {
  id: string;
  name: string;
  artworkId: string | null;
  albums: ExternalArtistAlbum[];
  tracks: UnifiedSearchResult[];
  identity: CanonicalIdentity;
};

export interface ExternalCatalogProvider {
  id: string;
  name: string;
  enabled: boolean;
  search(query: string, options?: { limit?: number }): Promise<UnifiedSearchResult[]>;
  getAlbum(id: string): Promise<ExternalAlbumDetail | null>;
  getArtist(id: string): Promise<ExternalArtistDetail | null>;
}

function year(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

function duration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value / 1000))
    : null;
}

function identity(type: "album" | "artist" | "track", parts: Array<string | null | undefined>): CanonicalIdentity {
  return {
    id: `external:${type}:${parts.map((part) => normalizeMusicText(part)).filter(Boolean).join(":")}`,
    strength: "normalized",
  };
}

/**
 * First real external catalog adapter. It uses iTunes' public metadata and
 * preview surfaces, stores artwork/detail provider references only in the
 * registry's short-lived private cache, and returns MusicDeck-facing neutral
 * records with no raw provider URLs.
 */
export class ItunesExternalCatalogProvider implements ExternalCatalogProvider {
  readonly id = "itunes";
  readonly name = "External Catalog";

  enabled = false;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: Map<string, ExternalArtworkRecord>
  ) {}

  fetchArtwork(url: string) {
    return this.fetchImpl(url);
  }

  private token(url: unknown): string | null {
    if (typeof url !== "string" || !this.artworkTokens) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("mzstatic.com")) {
      return null;
    }

    const id = createId("extart");
    this.artworkTokens.set(id, { url: parsed.toString(), expiresAt: Date.now() + 10 * 60_000 });
    return id;
  }

  private async request<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(`https://itunes.apple.com/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      throw new Error("External catalog is unavailable");
    }

    if (!response.ok) {
      throw new Error("External catalog is unavailable");
    }

    try {
      return await response.json() as T;
    } catch {
      throw new Error("External catalog returned invalid data");
    }
  }

  private artwork(url: unknown) {
    const id = this.token(url);
    return id ? { id, url: `/api/artwork/external/${encodeURIComponent(id)}` } : null;
  }

  private track(item: any): UnifiedSearchResult | null {
    const id = item.trackId ? `external_itunes_${item.trackId}` : null;
    if (!id) return null;

    return {
      type: "track",
      id,
      title: item.trackName || "Unknown title",
      subtitle: item.artistName || null,
      artist: item.artistName || null,
      album: item.collectionName || null,
      artwork: this.artwork(item.artworkUrl100),
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identity: identity("track", [item.trackName, item.artistName, item.collectionName]),
      metadata: {
        durationSeconds: duration(item.trackTimeMillis),
        artistId: item.artistId ? `external_itunes_artist_${item.artistId}` : null,
        albumId: item.collectionId ? `external_itunes_album_${item.collectionId}` : null,
      },
    };
  }

  async search(query: string, options: { limit?: number } = {}): Promise<UnifiedSearchResult[]> {
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const payload = await this.request<{ results?: any[] }>("search", {
      term: query,
      media: "music",
      entity: "song,album,musicArtist",
      limit,
    });

    return (payload.results || []).flatMap((item) => {
      if (item.wrapperType === "artist" || item.artistType === "Artist") {
        const id = item.artistId ? `external_itunes_artist_${item.artistId}` : null;
        return id ? [{
          type: "artist" as const,
          id,
          title: item.artistName || "Unknown artist",
          subtitle: "Artist",
          artist: item.artistName || null,
          album: null,
          artwork: null,
          provider: "external" as const,
          source: { kind: "external" as const, count: 0 },
          availability: null,
          identity: identity("artist", [item.artistName]),
          metadata: {},
        }] : [];
      }

      if (item.wrapperType === "collection") {
        const id = item.collectionId ? `external_itunes_album_${item.collectionId}` : null;
        return id ? [{
          type: "album" as const,
          id,
          title: item.collectionName || "Unknown album",
          subtitle: item.artistName || null,
          artist: item.artistName || null,
          album: null,
          artwork: this.artwork(item.artworkUrl100),
          provider: "external" as const,
          source: { kind: "external" as const, count: 0 },
          availability: null,
          identity: identity("album", [item.collectionName, item.artistName]),
          metadata: {
            year: year(item.releaseDate),
            artistId: item.artistId ? `external_itunes_artist_${item.artistId}` : null,
          },
        }] : [];
      }

      const track = this.track(item);
      return track ? [track] : [];
    });
  }

  async getAlbum(id: string): Promise<ExternalAlbumDetail | null> {
    if (!/^external_itunes_album_\d+$/.test(id)) return null;
    const collectionId = id.slice("external_itunes_album_".length);
    const payload = await this.request<{ results?: any[] }>("lookup", {
      id: collectionId,
      entity: "song",
    });
    const results = payload.results || [];
    const collection = results.find((item) => item.wrapperType === "collection");
    if (!collection) return null;

    const tracks = results
      .filter((item) => item.wrapperType === "track")
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item))
      .sort((left, right) => {
        return 0;
      });

    return {
      id,
      title: collection.collectionName || "Unknown album",
      artist: collection.artistName || "Unknown artist",
      artistId: collection.artistId ? `external_itunes_artist_${collection.artistId}` : null,
      year: year(collection.releaseDate),
      releaseDate: typeof collection.releaseDate === "string" ? collection.releaseDate : null,
      genre: collection.primaryGenreName || null,
      label: collection.copyright || null,
      artworkId: this.token(collection.artworkUrl100),
      tracks,
      identity: identity("album", [collection.collectionName, collection.artistName]),
    };
  }

  async getArtist(id: string): Promise<ExternalArtistDetail | null> {
    if (!/^external_itunes_artist_\d+$/.test(id)) return null;
    const artistId = id.slice("external_itunes_artist_".length);
    const [artistPayload, albumPayload, trackPayload] = await Promise.all([
      this.request<{ results?: any[] }>("lookup", { id: artistId }),
      this.request<{ results?: any[] }>("lookup", { id: artistId, entity: "album", limit: 25 }),
      this.request<{ results?: any[] }>("lookup", { id: artistId, entity: "song", limit: 10 }),
    ]);

    const artist = artistPayload.results?.[0];
    if (!artist?.artistName) return null;

    const albums = (albumPayload.results || []).flatMap((item) => {
      const albumId = item.collectionId ? `external_itunes_album_${item.collectionId}` : null;
      return albumId ? [{
        id: albumId,
        title: item.collectionName || "Unknown album",
        year: year(item.releaseDate),
        artworkId: this.token(item.artworkUrl100),
        identity: identity("album", [item.collectionName, artist.artistName]),
      }] : [];
    });

    const tracks = (trackPayload.results || [])
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));

    return {
      id,
      name: artist.artistName,
      artworkId: null,
      albums,
      tracks,
      identity: identity("artist", [artist.artistName]),
    };
  }
}

/**
 * Short-lived, in-memory external catalog registry. Detail and artwork tokens
 * deliberately expire and are bounded by request behavior; no persistent
 * external catalog index is created.
 */
export class ExternalCatalogRegistry {
  private readonly artwork = new Map<string, ExternalArtworkRecord>();
  private readonly details = new Map<string, ExternalDetailRecord>();
  readonly provider: ItunesExternalCatalogProvider;

  constructor(fetchImpl?: typeof fetch) {
    this.provider = new ItunesExternalCatalogProvider(fetchImpl, this.artwork);
  }

  configure(enabled: boolean) {
    this.provider.enabled = enabled;
  }

  isEnabled() {
    return this.provider.enabled;
  }

  async search(query: string, options?: { limit?: number }) {
    return this.provider.enabled ? this.provider.search(query, options) : [];
  }

  detailId(type: "album" | "artist", providerId: string) {
    const id = createId("extdetail");
    this.details.set(id, { type, providerId, expiresAt: Date.now() + 30 * 60_000 });
    return id;
  }

  private detail(id: string) {
    const record = this.details.get(id);
    if (!record || record.expiresAt < Date.now()) {
      this.details.delete(id);
      return null;
    }
    return record;
  }

  async getAlbum(id: string) {
    if (id.startsWith("external_itunes_album_")) {
      return this.provider.enabled ? this.provider.getAlbum(id) : null;
    }

    const record = this.detail(id);
    return record?.type === "album" && this.provider.enabled
      ? this.provider.getAlbum(record.providerId)
      : null;
  }

  async getArtist(id: string) {
    if (id.startsWith("external_itunes_artist_")) {
      return this.provider.enabled ? this.provider.getArtist(id) : null;
    }

    const record = this.detail(id);
    return record?.type === "artist" && this.provider.enabled
      ? this.provider.getArtist(record.providerId)
      : null;
  }

  getArtwork(id: string) {
    const record = this.artwork.get(id);
    if (!record || record.expiresAt < Date.now()) {
      this.artwork.delete(id);
      return null;
    }
    return record.url;
  }

  fetchArtwork(url: string) {
    return this.provider.fetchArtwork(url);
  }
}
