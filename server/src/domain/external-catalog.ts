import { createId } from "../utils/ids.js";
import type { Db } from "../db/database.js";
import type { CanonicalIdentity, UnifiedSearchResult } from "./search.js";
import { normalizeMusicText } from "./music-identity.js";
import { SpotifyAuthClient, SpotifyAuthError, describeSpotifyErrorBody, hasSpotifyCredentials, resolveSpotifyCredentials, type SpotifyCredentials } from "./spotify-auth.js";

export type ExternalArtworkRecord = {
  url: string;
  expiresAt: number;
};

/**
 * Shared, in-memory artwork-token store used by every external catalog
 * search provider (Spotify, Deezer, ...). Raw provider CDN URLs are never
 * returned to clients directly -- callers exchange a validated CDN URL for
 * an opaque, short-lived token id, and the browser only ever sees
 * `/api/artwork/external/:artworkId`. Sharing one store lets every provider
 * reuse the same proxy route and caching behavior without provider-specific
 * client logic.
 */
export class ExternalArtworkTokenStore {
  private readonly tokens = new Map<string, ExternalArtworkRecord>();

  /**
   * Validates that `url` is an https URL whose hostname ends with one of
   * `allowedHostSuffixes`, then mints an opaque token id for it. Returns
   * null (no artwork) for anything that doesn't match, so a provider can
   * never be tricked into proxying an arbitrary attacker-supplied host.
   */
  token(url: unknown, allowedHostSuffixes: string[]): string | null {
    if (typeof url !== "string" || !url) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.protocol !== "https:" || !allowedHostSuffixes.some((suffix) => parsed.hostname.endsWith(suffix))) {
      return null;
    }

    const id = createId("extart");
    this.tokens.set(id, { url: parsed.toString(), expiresAt: Date.now() + 10 * 60_000 });
    return id;
  }

  /** Resolves a previously-minted token id back to its validated CDN URL, or null if expired/unknown. */
  get(id: string): string | null {
    const record = this.tokens.get(id);
    if (!record || record.expiresAt < Date.now()) {
      this.tokens.delete(id);
      return null;
    }
    return record.url;
  }
}

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

function identity(type: "album" | "artist" | "track", parts: Array<string | null | undefined>): CanonicalIdentity {
  return {
    id: `external:${type}:${parts.map((part) => normalizeMusicText(part)).filter(Boolean).join(":")}`,
    strength: "normalized",
  };
}

function spotifyDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value / 1000))
    : null;
}

function spotifyArtistName(item: any): string | null {
  return Array.isArray(item?.artists) && item.artists[0]?.name ? item.artists[0].name : null;
}

function spotifyIsrc(item: any): string | null {
  return typeof item?.external_ids?.isrc === "string" && item.external_ids.isrc ? item.external_ids.isrc : null;
}

function spotifyArtistId(item: any): string | null {
  return Array.isArray(item?.artists) && item.artists[0]?.id
    ? `external_spotify_artist_${item.artists[0].id}`
    : null;
}

function spotifyLargestImage(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (b?.width || 0) - (a?.width || 0));
  return typeof sorted[0]?.url === "string" ? sorted[0].url : null;
}

/**
 * External catalog adapter backed by Spotify's official Web API
 * (https://api.spotify.com/v1). Uses only the publicly documented,
 * credentialed client-credentials flow -- no scraping or private
 * endpoints. Credentials are supplied server-side via the search
 * provider's own configuration and never exposed to clients.
 */
export class SpotifyExternalCatalogProvider implements ExternalCatalogProvider {
  readonly id = "spotify";
  readonly name = "Spotify";

  enabled = false;

  private readonly auth: SpotifyAuthClient;

  constructor(
    private getConfig: () => SpotifyCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: ExternalArtworkTokenStore,
    private readonly db?: Db
  ) {
    this.auth = new SpotifyAuthClient(fetchImpl);
  }

  hasCredentials(): boolean {
    return hasSpotifyCredentials(resolveSpotifyCredentials(this.getConfig(), this.db));
  }

  fetchArtwork(url: string) {
    return this.fetchImpl(url);
  }

  private token(url: unknown): string | null {
    return this.artworkTokens ? this.artworkTokens.token(url, ["scdn.co"]) : null;
  }

  private artwork(images: unknown) {
    const id = this.token(spotifyLargestImage(images));
    return id ? { id, url: `/api/artwork/external/${encodeURIComponent(id)}` } : null;
  }

  private async request<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    let token: string | null;
    try {
      token = await this.auth.getAccessToken(resolveSpotifyCredentials(this.getConfig(), this.db));
    } catch (error) {
      if (error instanceof SpotifyAuthError) {
        throw new Error(`External catalog (Spotify) token request failed: ${error.message}`);
      }
      throw new Error(`External catalog (Spotify) is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!token) {
      throw new Error("External catalog (Spotify) is unavailable: no credentials configured");
    }

    const url = new URL(`https://api.spotify.com/v1/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new Error(`External catalog (Spotify) catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = describeSpotifyErrorBody(bodyText);
      throw new Error(
        `External catalog (Spotify) catalog request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new Error("External catalog returned invalid data");
    }
  }

  private track(item: any, albumName?: string | null): UnifiedSearchResult | null {
    if (!item?.id) return null;

    const isrc = spotifyIsrc(item);

    return {
      type: "track",
      id: `external_spotify_track_${item.id}`,
      title: item.name || "Unknown title",
      subtitle: spotifyArtistName(item),
      artist: spotifyArtistName(item),
      album: item.album?.name || albumName || null,
      artwork: this.artwork(item.album?.images),
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identity: isrc
        ? { id: `isrc:${isrc}`, strength: "isrc" }
        : identity("track", [item.name, spotifyArtistName(item), item.album?.name || albumName]),
      identityHints: isrc ? { isrc } : undefined,
      metadata: {
        durationSeconds: spotifyDuration(item.duration_ms),
        artistId: spotifyArtistId(item),
        albumId: item.album?.id ? `external_spotify_album_${item.album.id}` : null,
        spotifyTrackId: item.id,
        spotifyTrackUrl: item.external_urls?.spotify || null,
      },
    };
  }

  async search(query: string, options: { limit?: number } = {}): Promise<UnifiedSearchResult[]> {
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const payload = await this.request<{
      tracks?: { items?: any[] };
      albums?: { items?: any[] };
      artists?: { items?: any[] };
    }>("search", { q: query, type: "track,album,artist", limit });

    const tracks = (payload.tracks?.items || [])
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));

    const albums = (payload.albums?.items || []).flatMap((item) => {
      if (!item?.id) return [];
      return [{
        type: "album" as const,
        id: `external_spotify_album_${item.id}`,
        title: item.name || "Unknown album",
        subtitle: spotifyArtistName(item),
        artist: spotifyArtistName(item),
        album: null,
        artwork: this.artwork(item.images),
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        identity: identity("album", [item.name, spotifyArtistName(item)]),
        metadata: {
          year: year(item.release_date),
          artistId: spotifyArtistId(item),
        },
      }];
    });

    const artists = (payload.artists?.items || []).flatMap((item) => {
      if (!item?.id) return [];
      return [{
        type: "artist" as const,
        id: `external_spotify_artist_${item.id}`,
        title: item.name || "Unknown artist",
        subtitle: "Artist",
        artist: item.name || null,
        album: null,
        artwork: this.artwork(item.images),
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        identity: identity("artist", [item.name]),
        metadata: {},
      }];
    });

    return [...tracks, ...albums, ...artists];
  }

  async getAlbum(id: string): Promise<ExternalAlbumDetail | null> {
    if (!/^external_spotify_album_[a-zA-Z0-9]+$/.test(id)) return null;
    const albumId = id.slice("external_spotify_album_".length);

    let album: any;
    try {
      album = await this.request<any>(`albums/${albumId}`);
    } catch {
      return null;
    }
    if (!album?.id) return null;

    const artistName = spotifyArtistName(album);
    const tracks = (album.tracks?.items || [])
      .map((item: any) => this.track(item, album.name))
      .filter((item: UnifiedSearchResult | null): item is UnifiedSearchResult => Boolean(item));

    return {
      id,
      title: album.name || "Unknown album",
      artist: artistName || "Unknown artist",
      artistId: spotifyArtistId(album),
      year: year(album.release_date),
      releaseDate: typeof album.release_date === "string" ? album.release_date : null,
      genre: Array.isArray(album.genres) && album.genres[0] ? album.genres[0] : null,
      label: album.label || null,
      artworkId: this.token(spotifyLargestImage(album.images)),
      tracks,
      identity: identity("album", [album.name, artistName]),
    };
  }

  async getArtist(id: string): Promise<ExternalArtistDetail | null> {
    if (!/^external_spotify_artist_[a-zA-Z0-9]+$/.test(id)) return null;
    const artistId = id.slice("external_spotify_artist_".length);

    let artist: any;
    let albumPayload: { items?: any[] };
    let topTracksPayload: { tracks?: any[] };
    try {
      [artist, albumPayload, topTracksPayload] = await Promise.all([
        this.request<any>(`artists/${artistId}`),
        this.request<{ items?: any[] }>(`artists/${artistId}/albums`, {
          include_groups: "album,single",
          limit: 25,
        }),
        this.request<{ tracks?: any[] }>(`artists/${artistId}/top-tracks`, { market: "US" }),
      ]);
    } catch {
      return null;
    }

    if (!artist?.name) return null;

    const albums = (albumPayload.items || []).flatMap((item) => {
      if (!item?.id) return [];
      return [{
        id: `external_spotify_album_${item.id}`,
        title: item.name || "Unknown album",
        year: year(item.release_date),
        artworkId: this.token(spotifyLargestImage(item.images)),
        identity: identity("album", [item.name, artist.name]),
      }];
    });

    const tracks = (topTracksPayload.tracks || [])
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));

    return {
      id,
      name: artist.name,
      artworkId: this.token(spotifyLargestImage(artist.images)),
      albums,
      tracks,
      identity: identity("artist", [artist.name]),
    };
  }
}

function deezerArtistName(item: any): string | null {
  return typeof item?.artist?.name === "string" ? item.artist.name : null;
}

function deezerDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

/**
 * External catalog detail provider backed by Deezer's public API
 * (https://api.deezer.com), which requires no API key/OAuth. This mirrors
 * `SpotifyExternalCatalogProvider` but fetches album/artist *detail* pages
 * (as opposed to `DeezerSearchProvider` in search-provider-registry.ts,
 * which only produces search-list results). Both share the same
 * `external_deezer_<type>_<id>` ID convention, so IDs minted by either are
 * interchangeable, matching the existing Spotify search/detail split.
 */
export class DeezerExternalCatalogProvider implements ExternalCatalogProvider {
  readonly id = "deezer";
  readonly name = "Deezer";

  // Deezer's public catalog endpoints require no credentials, so this
  // provider is always available for detail lookups regardless of the
  // Spotify configuration/enablement state.
  enabled = true;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: ExternalArtworkTokenStore
  ) {}

  private artwork(url: unknown) {
    const id = this.artworkTokens ? this.artworkTokens.token(url, ["dzcdn.net"]) : null;
    return id ? { id, url: `/api/artwork/external/${encodeURIComponent(id)}` } : null;
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://api.deezer.com${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      throw new Error(`External catalog (Deezer) catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw new Error("External catalog (Deezer) returned invalid data");
    }

    if (!response.ok) {
      throw new Error(`External catalog (Deezer) catalog request failed (HTTP ${response.status})`);
    }

    let payload: any;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error("External catalog (Deezer) returned invalid data");
    }

    if (payload && typeof payload === "object" && payload.error) {
      const message = typeof payload.error.message === "string" ? payload.error.message : "unknown error";
      throw new Error(`External catalog (Deezer) catalog request failed: ${message}`);
    }

    return payload as T;
  }

  private track(item: any, albumName?: string | null, albumId?: string | null, albumArtwork?: unknown): UnifiedSearchResult | null {
    if (item?.id == null) return null;

    const artistName = deezerArtistName(item);

    return {
      type: "track",
      id: `external_deezer_track_${item.id}`,
      title: item.title || "Unknown title",
      subtitle: artistName,
      artist: artistName,
      album: item.album?.title || albumName || null,
      artwork: this.artwork(item.album?.cover_big || item.album?.cover_medium || albumArtwork),
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identity: identity("track", [item.title, artistName, item.album?.title || albumName]),
      metadata: {
        durationSeconds: deezerDuration(item.duration),
        artistId: item.artist?.id != null ? `external_deezer_artist_${item.artist.id}` : null,
        albumId: item.album?.id != null ? `external_deezer_album_${item.album.id}` : albumId || null,
        deezerTrackId: item.id,
        deezerTrackUrl: item.link || null,
      },
    };
  }

  private album(item: any): UnifiedSearchResult | null {
    if (item?.id == null) return null;
    const artistName = deezerArtistName(item) || item.artist?.name || null;
    return {
      type: "album",
      id: `external_deezer_album_${item.id}`,
      title: item.title || "Unknown album",
      subtitle: artistName,
      artist: artistName,
      album: null,
      artwork: this.artwork(item.cover_big || item.cover_medium),
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identity: identity("album", [item.title, artistName]),
      metadata: { year: year(item.release_date) },
    };
  }

  private artist(item: any): UnifiedSearchResult | null {
    if (item?.id == null) return null;
    return {
      type: "artist",
      id: `external_deezer_artist_${item.id}`,
      title: item.name || "Unknown artist",
      subtitle: "Artist",
      artist: item.name || null,
      album: null,
      artwork: this.artwork(item.picture_big || item.picture_medium),
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      identity: identity("artist", [item.name]),
      metadata: {},
    };
  }

  /**
   * Deezer's generic `/search` endpoint only ever returns track results, so
   * this alone can never satisfy `findMatchingExternalAlbum`/
   * `findMatchingExternalArtist` (which filter for `type === "album"` /
   * `"artist"`). Without albums/artists in the result set, the local
   * album/artist catalog-completeness merge in music-routes.ts silently
   * falls back to local-only data whenever only Deezer (keyless) is
   * available -- i.e. whenever Spotify credentials are not configured.
   * Querying the dedicated `/search/album` and `/search/artist` endpoints
   * alongside `/search` (tracks) mirrors `DeezerSearchProvider` in
   * search-provider-registry.ts and keeps every result type available for
   * matching.
   */
  async search(query: string, options: { limit?: number } = {}): Promise<UnifiedSearchResult[]> {
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const [trackPayload, albumPayload, artistPayload] = await Promise.all([
      this.request<{ data?: any[] }>("/search", { q: query, limit: String(limit) }),
      this.request<{ data?: any[] }>("/search/album", { q: query, limit: String(limit) }).catch(() => ({ data: [] })),
      this.request<{ data?: any[] }>("/search/artist", { q: query, limit: String(limit) }).catch(() => ({ data: [] })),
    ]);

    const tracks = (trackPayload.data || [])
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));
    const albums = (albumPayload.data || [])
      .map((item) => this.album(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));
    const artists = (artistPayload.data || [])
      .map((item) => this.artist(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));

    return [...tracks, ...albums, ...artists];
  }

  async getAlbum(id: string): Promise<ExternalAlbumDetail | null> {
    if (!/^external_deezer_album_[0-9]+$/.test(id)) return null;
    const albumId = id.slice("external_deezer_album_".length);

    let album: any;
    try {
      album = await this.request<any>(`/album/${albumId}`);
    } catch {
      return null;
    }
    if (album?.id == null) return null;

    const artistName = deezerArtistName(album) || album.artist?.name || "Unknown artist";
    const artworkUrl = album.cover_big || album.cover_medium;
    const tracks = (album.tracks?.data || [])
      .map((item: any) => this.track(item, album.title, id, artworkUrl))
      .filter((item: UnifiedSearchResult | null): item is UnifiedSearchResult => Boolean(item));

    return {
      id,
      title: album.title || "Unknown album",
      artist: artistName,
      artistId: album.artist?.id != null ? `external_deezer_artist_${album.artist.id}` : null,
      year: year(album.release_date),
      releaseDate: typeof album.release_date === "string" ? album.release_date : null,
      genre: Array.isArray(album.genres?.data) && album.genres.data[0]?.name ? album.genres.data[0].name : null,
      label: album.label || null,
      artworkId: this.artworkTokens ? this.artworkTokens.token(artworkUrl, ["dzcdn.net"]) : null,
      tracks,
      identity: identity("album", [album.title, artistName]),
    };
  }

  async getArtist(id: string): Promise<ExternalArtistDetail | null> {
    if (!/^external_deezer_artist_[0-9]+$/.test(id)) return null;
    const artistId = id.slice("external_deezer_artist_".length);

    let artist: any;
    let albumPayload: { data?: any[] };
    let topTracksPayload: { data?: any[] };
    try {
      [artist, albumPayload, topTracksPayload] = await Promise.all([
        this.request<any>(`/artist/${artistId}`),
        this.request<{ data?: any[] }>(`/artist/${artistId}/albums`, { limit: "25" }),
        this.request<{ data?: any[] }>(`/artist/${artistId}/top`, { limit: "10" }),
      ]);
    } catch {
      return null;
    }

    if (!artist?.name) return null;

    const albums = (albumPayload.data || []).flatMap((item) => {
      if (item?.id == null) return [];
      return [{
        id: `external_deezer_album_${item.id}`,
        title: item.title || "Unknown album",
        year: year(item.release_date),
        artworkId: this.artworkTokens ? this.artworkTokens.token(item.cover_big || item.cover_medium, ["dzcdn.net"]) : null,
        identity: identity("album", [item.title, artist.name]),
      }];
    });

    const tracks = (topTracksPayload.data || [])
      .map((item) => this.track(item))
      .filter((item): item is UnifiedSearchResult => Boolean(item));

    return {
      id,
      name: artist.name,
      artworkId: this.artworkTokens ? this.artworkTokens.token(artist.picture_big || artist.picture_medium, ["dzcdn.net"]) : null,
      albums,
      tracks,
      identity: identity("artist", [artist.name]),
    };
  }
}

/**
 * Short-lived, in-memory external catalog registry. Detail and artwork tokens
 * deliberately expire and are bounded by request behavior; no persistent
 * external catalog index is created. Dispatches to whichever provider owns
 * the `external_<providerId>_<type>_<nativeId>` ID prefix (Spotify, Deezer),
 * so both providers' detail pages resolve correctly regardless of which one
 * produced the originating search result.
 */
export class ExternalCatalogRegistry {
  private readonly artworkTokens = new ExternalArtworkTokenStore();
  private readonly details = new Map<string, ExternalDetailRecord>();
  private config: SpotifyCredentials = {};
  readonly provider: SpotifyExternalCatalogProvider;
  readonly deezerProvider: DeezerExternalCatalogProvider;
  private readonly providers: ExternalCatalogProvider[];

  constructor(private readonly fetchImpl: typeof fetch = fetch, db?: Db) {
    this.provider = new SpotifyExternalCatalogProvider(() => this.config, fetchImpl, this.artworkTokens, db);
    this.deezerProvider = new DeezerExternalCatalogProvider(fetchImpl, this.artworkTokens);
    this.providers = [this.provider, this.deezerProvider];
  }

  /** Shared artwork-token store used by every external search provider (Spotify, Deezer, ...). */
  get artwork(): ExternalArtworkTokenStore {
    return this.artworkTokens;
  }

  configure(enabled: boolean, config?: SpotifyCredentials) {
    this.provider.enabled = enabled;
    if (config) {
      this.config = config;
    }
  }

  /** True when at least one external catalog provider (Deezer is always-on) is enabled. */
  isEnabled() {
    return this.providers.some((provider) => provider.enabled);
  }

  private providerFor(id: string): ExternalCatalogProvider | null {
    return this.providers.find((provider) => id.startsWith(`external_${provider.id}_`)) || null;
  }

  async search(query: string, options?: { limit?: number }) {
    const results = await Promise.all(
      this.providers.map((provider) =>
        provider.enabled
          ? provider.search(query, options).catch(() => [] as UnifiedSearchResult[])
          : Promise.resolve([] as UnifiedSearchResult[])
      )
    );
    return results.flat();
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
    const provider = this.providerFor(id);
    if (provider) {
      return provider.enabled ? provider.getAlbum(id) : null;
    }

    const record = this.detail(id);
    if (record?.type !== "album") return null;
    const recordProvider = this.providerFor(record.providerId) || this.provider;
    return recordProvider.enabled ? recordProvider.getAlbum(record.providerId) : null;
  }

  async getArtist(id: string) {
    const provider = this.providerFor(id);
    if (provider) {
      return provider.enabled ? provider.getArtist(id) : null;
    }

    const record = this.detail(id);
    if (record?.type !== "artist") return null;
    const recordProvider = this.providerFor(record.providerId) || this.provider;
    return recordProvider.enabled ? recordProvider.getArtist(record.providerId) : null;
  }

  getArtwork(id: string) {
    return this.artworkTokens.get(id);
  }

  /**
   * Fetches a previously-validated external CDN URL for the artwork proxy
   * route. Not provider-specific: any provider that mints a token through
   * the shared `artwork` store (Spotify, Deezer, ...) can have its artwork
   * served through this same fetch path.
   */
  fetchArtwork(url: string) {
    return this.fetchImpl(url);
  }
}
