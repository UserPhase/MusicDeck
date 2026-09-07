import type { CatalogProvider, SearchResult } from "../catalog-provider.js";
import type { StreamProvider, StreamResult } from "../stream-provider.js";
import type { Album, Artist, Track } from "../../types.js";
import { mapJellyfinAlbum, mapJellyfinArtist, mapJellyfinTrack } from "./jellyfin-mapper.js";

export type JellyfinConfig = {
  url: string;
  apiKey: string;
};

/**
 * Jellyfin provider: catalog reads + direct audio streaming/artwork.
 *
 * Authentication uses the X-Emby-Token header; the API key is never placed in
 * URLs, logs, or error messages. Catalog is read via /Items and /Artists with
 * server-side filtering. Streaming is direct-play only (no transcoding) in
 * this first implementation.
 *
 * Does not implement UserDataSync — favorites/playlist sync is deferred.
 */
export class JellyfinBackend implements CatalogProvider, StreamProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JellyfinConfig, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.fetchImpl = fetchImpl;
  }

  private buildUrl(path: string, params: Record<string, unknown> = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    const search = url.searchParams;

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      search.append(key, String(value));
    }

    return url;
  }

  private authHeaders(): Record<string, string> {
    return { "X-Emby-Token": this.apiKey };
  }

  private async request<T = any>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(this.buildUrl(path, params), {
        headers: this.authHeaders(),
      });
    } catch {
      throw new Error("Jellyfin connection failed");
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Jellyfin authentication failed");
      }
      if (response.status === 404) {
        throw new JellyfinNotFoundError();
      }
      throw new Error(`Jellyfin returned ${response.status}`);
    }

    try {
      return await response.json() as T;
    } catch {
      throw new Error("Jellyfin returned invalid JSON");
    }
  }

  private async listItems<T>(params: Record<string, unknown>, map: (item: any) => T): Promise<T[]> {
    const result = await this.request<{ Items?: any[] }>("Items", params);
    return (result.Items || []).map(map);
  }

  async listAlbums(limit = 500): Promise<Album[]> {
    return this.listItems({
      IncludeItemTypes: "MusicAlbum",
      Recursive: true,
      SortBy: "SortName",
      Limit: limit,
    }, mapJellyfinAlbum);
  }

  async getAlbum(albumId: string): Promise<Album | null> {
    const result = await this.request<{ Items?: any[] }>("Items", {
      Ids: albumId,
      IncludeItemTypes: "MusicAlbum",
    });
    const item = result.Items?.[0];
    return item ? mapJellyfinAlbum(item) : null;
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    return this.listItems({
      ParentId: albumId,
      IncludeItemTypes: "Audio",
      SortBy: "ParentIndexNumber,IndexNumber",
    }, mapJellyfinTrack);
  }

  async listArtists(): Promise<Artist[]> {
    const result = await this.request<any[]>("Artists", { SortBy: "SortName" });
    return (Array.isArray(result) ? result : []).map(mapJellyfinArtist);
  }

  async getArtist(artistId: string): Promise<Artist | null> {
    const result = await this.request<{ Items?: any[] }>("Items", {
      Ids: artistId,
      IncludeItemTypes: "MusicArtist",
    });
    const item = result.Items?.[0];
    return item ? mapJellyfinArtist(item) : null;
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    return this.listItems({
      ArtistIds: artistId,
      IncludeItemTypes: "MusicAlbum",
      Recursive: true,
    }, mapJellyfinAlbum);
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    return this.listItems({
      ArtistIds: artistId,
      IncludeItemTypes: "Audio",
      Recursive: true,
    }, mapJellyfinTrack);
  }

  async listTracks(): Promise<Track[]> {
    return this.listItems({
      IncludeItemTypes: "Audio",
      Recursive: true,
      SortBy: "SortName",
    }, mapJellyfinTrack);
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const result = await this.request<{ Items?: any[] }>("Items", {
      Ids: trackId,
      IncludeItemTypes: "Audio",
    });
    const item = result.Items?.[0];
    return item ? mapJellyfinTrack(item) : null;
  }

  async search(query: string, types: string[] = ["artists", "albums", "tracks"]): Promise<SearchResult> {
    const empty: SearchResult = { artists: [], albums: [], tracks: [] };

    if (!query.trim()) {
      return empty;
    }

    const wants = new Set(types);
    const includeTypes: string[] = [];

    if (wants.has("artists")) includeTypes.push("MusicArtist");
    if (wants.has("albums")) includeTypes.push("MusicAlbum");
    if (wants.has("tracks") || wants.has("songs")) includeTypes.push("Audio");

    if (includeTypes.length === 0) {
      return empty;
    }

    const items = await this.listItems({
      searchTerm: query.trim(),
      IncludeItemTypes: includeTypes.join(","),
      Recursive: true,
      Limit: 100,
    }, (item) => item);

    for (const item of items) {
      if (item.Type === "MusicArtist") {
        empty.artists.push(mapJellyfinArtist(item));
      } else if (item.Type === "MusicAlbum") {
        empty.albums.push(mapJellyfinAlbum(item));
      } else if (item.Type === "Audio") {
        empty.tracks.push(mapJellyfinTrack(item));
      }
    }

    return empty;
  }

  async getRandomTracks(limit = 10): Promise<Track[]> {
    return this.listItems({
      IncludeItemTypes: "Audio",
      Recursive: true,
      SortBy: "Random",
      Limit: limit,
    }, mapJellyfinTrack);
  }

  async getRandomAlbums(limit = 16): Promise<Album[]> {
    return this.listItems({
      IncludeItemTypes: "MusicAlbum",
      Recursive: true,
      SortBy: "Random",
      Limit: limit,
    }, mapJellyfinAlbum);
  }

  async fetchStream(trackId: string, range?: string): Promise<StreamResult> {
    const response = await this.fetchImpl(
      this.buildUrl(`Audio/${encodeURIComponent(trackId)}/stream`, { static: "true" }),
      {
        headers: {
          ...this.authHeaders(),
          ...(range ? { Range: range } : {}),
        },
      }
    );

    return {
      body: response.body,
      status: response.status,
      headers: response.headers,
    };
  }

  async fetchArtwork(artworkId: string): Promise<StreamResult> {
    const response = await this.fetchImpl(
      this.buildUrl(`Items/${encodeURIComponent(artworkId)}/Images/Primary`),
      { headers: this.authHeaders() }
    );

    return {
      body: response.body,
      status: response.status,
      headers: response.headers,
    };
  }
}

/** Thrown when Jellyfin reports an item does not exist. */
export class JellyfinNotFoundError extends Error {
  constructor() {
    super("Jellyfin item not found");
    this.name = "JellyfinNotFoundError";
  }
}
