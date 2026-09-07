import type { Album, Artist, Track } from "../types.js";
import type { CatalogProvider } from "../backends/catalog-provider.js";
import type { ProviderRegistry, RegisteredProvider } from "../backends/registry.js";
import { LibraryService, type LibraryItemType } from "./library.js";

/**
 * MusicDeck-owned availability summary attached to catalog read-model items.
 *
 * This describes what MusicDeck knows about how an item can be reached, not
 * how any provider implements it. It is derived only from data already in
 * hand during a fan-out (which connections returned items and whether any
 * provider failed) — never from per-item network probes.
 *
 * `state` is intentionally small; future states (external, cached,
 * downloaded) extend the same field without changing the shape.
 * `connectionId` identifies which configured connection supplied this copy;
 * duplicate items from other connections remain separate entries until the
 * stable-ID phase.
 */
export type Availability = {
  state: "available" | "degraded" | "unavailable";
  connectionId: string;
  sourceCount: number;
  availableSourceCount: number;
  libraryAvailable: boolean;
};

/** A friendly, provider-neutral playable-source option for the client. */
export type SourceOption = {
  id: string;
  name: string;
};

/** A catalog item plus its MusicDeck availability summary. `sources` lists
 * friendly playable-source options when the item has more than one mapped,
 * enabled source; omitted otherwise. */
export type Available<T> = T & {
  availability: Availability;
  sources?: SourceOption[];
};

/** Result of a fan-out read. `degraded` is true when at least one provider
 * failed while at least one succeeded. */
export type CatalogListResult<T> = {
  items: Array<Available<T>>;
  degraded: boolean;
};

export type CatalogSearchResult = {
  artists: Array<Available<Artist>>;
  albums: Array<Available<Album>>;
  tracks: Array<Available<Track>>;
  degraded: boolean;
};

type SettledRead<T> =
  | { entry: RegisteredProvider; ok: true; value: T[] }
  | { entry: RegisteredProvider; ok: false };

/** Build the availability summary for one item returned by one connection. */
function availabilityFor(connectionId: string, totalSources: number, availableSources: number): Availability {
  return {
    state: availableSources === 0
      ? "unavailable"
      : availableSources < totalSources
        ? "degraded"
        : "available",
    connectionId,
    sourceCount: totalSources,
    availableSourceCount: availableSources,
    libraryAvailable: availableSources > 0,
  };
}

/**
 * MusicDeck-owned boundary for catalog reads.
 *
 * Routes depend on this service instead of a provider directly. The service
 * fans reads out across every enabled CatalogProvider in deterministic
 * registry order, aggregates successful results, isolates per-provider
 * failures, stamps each item with an additive availability summary, and
 * reports a degraded flag for partial results.
 *
 * Intentionally not implemented here: dedup/matching, source priority,
 * stable cross-provider IDs, source resolution, and detail-endpoint
 * cross-provider routing. Duplicate items from different providers are
 * preserved as-is until the stable-ID phase.
 */
export class CatalogService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly library: LibraryService
  ) {}

  private connections(): RegisteredProvider[] {
    return this.registry.list();
  }

  private primary(): CatalogProvider {
    return this.registry.getPrimary().provider;
  }

  /**
   * Friendly, provider-neutral playable-source options for a library item.
   * Returns the item's mapped, currently enabled sources as `{id, name}`
   * using the connection's configured display name; the `id` is the
   * connection ID used by the stream endpoint's `?source=` selector. Returns
   * undefined when there is at most one playable source (nothing to choose).
   */
  private sourceOptionsFor(libraryItemId: string): SourceOption[] | undefined {
    const sources = this.library.getSources(libraryItemId);
    const options: SourceOption[] = [];

    for (const source of sources) {
      const entry = this.registry.getByConnectionId(source.connectionId);

      if (entry && entry.enabled) {
        options.push({ id: entry.connectionId, name: entry.name });
      }
    }

    return options.length > 1 ? options : undefined;
  }

  /**
   * Stamp an item with its stable MusicDeck ID, mapping the provider-native
   * ID to the library identity for the connection that returned it. The
   * provider-native ID stays internal via the availability summary.
   */
  private withStableId<T extends { id: string }>(
    item: T,
    type: LibraryItemType,
    connectionId: string
  ): T {
    const mdId = this.library.ensureId(type, { connectionId, providerItemId: item.id });
    return { ...item, id: mdId };
  }

  /**
   * Map a provider-native artwork reference to a stable MusicDeck artwork
   * identity and rebuild the public artwork URL. Null artwork stays null —
   * no identity is fabricated for absent artwork. Uses only data already
   * present on the catalog item; no extra provider calls.
   */
  private withStableArtwork<T extends { artworkId: string | null; artworkUrl: string | null }>(
    item: T,
    connectionId: string
  ): T {
    if (!item.artworkId) {
      return item;
    }

    const artworkId = this.library.ensureArtworkId({
      connectionId,
      providerItemId: item.artworkId,
    });

    return {
      ...item,
      artworkId,
      artworkUrl: `/api/artwork/${encodeURIComponent(artworkId)}`,
    };
  }

  /**
   * Stamp a track with its stable MusicDeck ID and normalize its nested
   * album/artist relationships to stable MusicDeck IDs resolved through the
   * same connection's library mappings. A relationship the provider does not
   * expose (null/empty) is preserved as null — no ID is fabricated.
   */
  private withStableTrackId<T extends { id: string; albumId: string | null; artistId: string | null }>(
    track: T,
    connectionId: string
  ): T {
    const withId = this.withStableId(track, "track", connectionId);

    return {
      ...withId,
      albumId: track.albumId
        ? this.library.ensureId("album", { connectionId, providerItemId: track.albumId })
        : null,
      artistId: track.artistId
        ? this.library.ensureId("artist", { connectionId, providerItemId: track.artistId })
        : null,
    };
  }

  /** Stamp either a track or a plain entity, normalizing track relationships
   * and artwork identity. */
  private stamp<T extends { id: string; artworkId: string | null; artworkUrl: string | null }>(
    item: T,
    type: LibraryItemType,
    connectionId: string
  ): T {
    const withArtwork = this.withStableArtwork(item, connectionId);

    if (type === "track") {
      return this.withStableTrackId(withArtwork as T & { albumId: string | null; artistId: string | null }, connectionId) as T;
    }

    return this.withStableId(withArtwork, type, connectionId);
  }

  /**
   * Resolve a public MusicDeck ID back to the provider-native ID for its
   * primary source. Returns null when the ID is not a known library item.
   */
  private toProviderId(libraryItemId: string): string | null {
    return this.library.getPrimarySource(libraryItemId)?.providerItemId ?? null;
  }

  /**
   * Run `read` against every enabled catalog provider concurrently, keeping
   * registry order. Each entry resolves to a SettledRead tagged with its
   * connection so failures never reject the whole batch.
   */
  private async runReads<T>(
    read: (provider: CatalogProvider) => Promise<T[]>
  ): Promise<Array<SettledRead<T>>> {
    const connections = this.connections();

    return Promise.all(
      connections.map(async (entry): Promise<SettledRead<T>> => {
        try {
          return { entry, ok: true, value: await read(entry.provider) };
        } catch {
          return { entry, ok: false };
        }
      })
    );
  }

  /**
   * Aggregate successful reads in registry order, stamp availability, and
   * throw a MusicDeck error only when every provider failed.
   */
  private aggregate<T extends { id: string; artworkId: string | null; artworkUrl: string | null }>(
    results: Array<SettledRead<T>>,
    type: LibraryItemType
  ): CatalogListResult<T> {
    const totalSources = results.length;
    const availableSources = results.filter((result) => result.ok).length;

    if (availableSources === 0 && totalSources > 0) {
      throw new Error("All catalog providers are unavailable");
    }

    const items: Array<Available<T>> = [];

    for (const result of results) {
      if (!result.ok) {
        continue;
      }

      const availability = availabilityFor(result.entry.connectionId, totalSources, availableSources);
      for (const item of result.value) {
        const stamped = this.stamp(item, type, result.entry.connectionId);
        const sources = this.sourceOptionsFor(stamped.id);
        items.push({ ...stamped, availability, ...(sources ? { sources } : {}) });
      }
    }

    return { items, degraded: availableSources < totalSources };
  }

  async listAlbums(limit?: number): Promise<CatalogListResult<Album>> {
    return this.aggregate(await this.runReads((provider) => provider.listAlbums(limit)), "album");
  }

  async listArtists(): Promise<CatalogListResult<Artist>> {
    return this.aggregate(await this.runReads((provider) => provider.listArtists()), "artist");
  }

  async listTracks(): Promise<CatalogListResult<Track>> {
    return this.aggregate(await this.runReads((provider) => provider.listTracks()), "track");
  }

  async getRandomAlbums(limit?: number): Promise<CatalogListResult<Album>> {
    return this.aggregate(await this.runReads((provider) => provider.getRandomAlbums(limit)), "album");
  }

  async getRandomTracks(limit?: number): Promise<CatalogListResult<Track>> {
    return this.aggregate(await this.runReads((provider) => provider.getRandomTracks(limit)), "track");
  }

  async search(query: string, types?: string[]): Promise<CatalogSearchResult> {
    const connections = this.connections();
    const totalSources = connections.length;

    const settled = await Promise.all(
      connections.map(async (entry) => {
        try {
          return { entry, ok: true as const, value: await entry.provider.search(query, types) };
        } catch {
          return { entry, ok: false as const };
        }
      })
    );

    const availableSources = settled.filter((result) => result.ok).length;

    if (availableSources === 0 && totalSources > 0) {
      throw new Error("All catalog providers are unavailable");
    }

    const artists: Array<Available<Artist>> = [];
    const albums: Array<Available<Album>> = [];
    const tracks: Array<Available<Track>> = [];

    for (const result of settled) {
      if (!result.ok) {
        continue;
      }

      const availability = availabilityFor(result.entry.connectionId, totalSources, availableSources);
      artists.push(...result.value.artists.map((item) => {
        const stamped = this.stamp(item, "artist", result.entry.connectionId);
        const sources = this.sourceOptionsFor(stamped.id);
        return { ...stamped, availability, ...(sources ? { sources } : {}) };
      }));
      albums.push(...result.value.albums.map((item) => {
        const stamped = this.stamp(item, "album", result.entry.connectionId);
        const sources = this.sourceOptionsFor(stamped.id);
        return { ...stamped, availability, ...(sources ? { sources } : {}) };
      }));
      tracks.push(...result.value.tracks.map((item) => {
        const stamped = this.stamp(item, "track", result.entry.connectionId);
        const sources = this.sourceOptionsFor(stamped.id);
        return { ...stamped, availability, ...(sources ? { sources } : {}) };
      }));
    }

    return { artists, albums, tracks, degraded: availableSources < totalSources };
  }

  // Detail endpoints accept a stable MusicDeck ID, resolve it to the primary
  // source's provider-native ID, and fetch from the primary provider. An
  // unknown MusicDeck ID resolves to null -> clean not-found. Source failover
  // across multiple sources is intentionally not implemented yet.
  // Availability is not stamped on detail results in this phase.

  async getAlbum(albumId: string): Promise<Album | null> {
    const providerId = this.toProviderId(albumId);
    if (!providerId) {
      return null;
    }
    const album = await this.primary().getAlbum(providerId);
    return album ? this.withStableId(album, "album", this.library.getPrimarySource(albumId)!.connectionId) : null;
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const source = this.library.getPrimarySource(albumId);
    if (!source) {
      return [];
    }
    const tracks = await this.primary().getAlbumTracks(source.providerItemId);
    return tracks.map((track) => this.stamp(track, "track", source.connectionId));
  }

  async getArtist(artistId: string): Promise<Artist | null> {
    const source = this.library.getPrimarySource(artistId);
    if (!source) {
      return null;
    }
    const artist = await this.primary().getArtist(source.providerItemId);
    return artist ? this.withStableId(artist, "artist", source.connectionId) : null;
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    const source = this.library.getPrimarySource(artistId);
    if (!source) {
      return [];
    }
    const albums = await this.primary().getArtistAlbums(source.providerItemId);
    return albums.map((album) => this.withStableId(album, "album", source.connectionId));
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const source = this.library.getPrimarySource(artistId);
    if (!source) {
      return [];
    }
    const tracks = await this.primary().getArtistTracks(source.providerItemId);
    return tracks.map((track) => this.stamp(track, "track", source.connectionId));
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const source = this.library.getPrimarySource(trackId);
    if (!source) {
      return null;
    }
    const track = await this.primary().getTrack(source.providerItemId);
    return track ? this.stamp(track, "track", source.connectionId) : null;
  }

  async scanLibrary(): Promise<void> {
    const connections = this.connections();
    await Promise.allSettled(
      connections.map((entry) => {
        if (typeof entry.provider.scanLibrary === "function") {
          return entry.provider.scanLibrary();
        }
        return Promise.resolve();
      })
    );
  }
}
