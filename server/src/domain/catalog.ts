import type { Album, Artist, Track } from "../types.js";
import { randomUUID } from "node:crypto";
import type { CatalogProvider } from "../backends/catalog-provider.js";
import type { ProviderRegistry, RegisteredProvider } from "../backends/registry.js";
import { LibraryService, type LibraryItemType } from "./library.js";
import { redactText, serverLogs, type LogBuffer } from "../utils/logger.js";
import type { TaskManager, TaskRunContext } from "../services/TaskManager.js";
import { trackContentHint } from "../services/media/contentRevision.js";
import { isTrackCreditedTo } from "../utils/artistMetadata.js";

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
type WindowSnapshot<T> = CatalogListResult<T> & { revision: string };
const WINDOW_TTL_MS = 30_000;

export type CatalogSearchResult = {
  artists: Array<Available<Artist>>;
  albums: Array<Available<Album>>;
  tracks: Array<Available<Track>>;
  degraded: boolean;
};

type SettledRead<T> =
  | { entry: RegisteredProvider; ok: true; value: T }
  | { entry: RegisteredProvider; ok: false; error: unknown };

/**
 * The public message stays generic (no provider internals reach clients), but
 * each provider's own failure is kept as `cause` and appended to the stack so
 * server logs show why every source failed instead of swallowing it.
 */
function allProvidersUnavailable(failures: Array<{ entry: RegisteredProvider; error: unknown }>): Error {
  const causes = failures.map(({ error }) => (error instanceof Error ? error : new Error(String(error))));
  const failure = new Error("All catalog providers are unavailable", {
    cause: new AggregateError(causes, "Catalog provider failures"),
  });
  const details = failures
    .map(({ entry }, index) => `Caused by [${entry.connectionId}]: ${causes[index].stack ?? causes[index].message}`)
    .join("\n");
  if (details) failure.stack = `${failure.stack}\n${details}`;
  return failure;
}

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
  private readonly trackSnapshotListeners = new Set<(snapshot: CatalogListResult<Track>) => void>();

  subscribeTrackSnapshots(listener: (snapshot: CatalogListResult<Track>) => void): () => void {
    this.trackSnapshotListeners.add(listener);
    return () => { this.trackSnapshotListeners.delete(listener); };
  }

  private taskManager?: TaskManager;
  private readonly scanOutcomes = new Map<string, { attempted: number; failures: unknown[] }>();

  bindTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
  }

  async refreshIndex(task: TaskRunContext, batchSize = 50): Promise<void> {
    let processed = 0;
    const snapshot: Array<Available<Track>> = [];
    for (const entry of this.connections()) {
      await task.checkpoint();
      const tracks = await entry.provider.listTracks();
      for (let offset = 0; offset < tracks.length; offset += batchSize) {
        await task.checkpoint();
        for (const track of tracks.slice(offset, offset + batchSize)) {
          snapshot.push({ ...this.stamp(track, "track", entry.connectionId),
            availability: availabilityFor(entry.connectionId, 1, 1) });
          processed++;
        }
        task.report({
          itemsProcessed: processed,
          totalItems: null,
          message: "Refreshing library track identities",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.trackWindow = null;
    this.albumWindow = null;
    this.trackSnapshotListeners.forEach((listener) => listener({ items: snapshot, degraded: false }));
  }
  private trackWindow: { expires: number; value: Promise<WindowSnapshot<Track>>; degraded?: boolean } | null = null;
  private albumWindow: { expires: number; value: Promise<WindowSnapshot<Album>> } | null = null;
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly library: LibraryService,
    private readonly logger: Pick<LogBuffer, "push"> = serverLogs,
    private readonly importedGain?: (track: Track) => number | { gainDb: number; integratedLufs: number; truePeakDb: number } | undefined,
  ) {}

  private connections(): RegisteredProvider[] {
    return this.registry.list();
  }

  private mappedSource(libraryItemId: string) {
    for (const source of this.library.getSources(libraryItemId)) {
      const entry = this.registry.getByConnectionId(source.connectionId);
      if (entry?.enabled) return { ...source, provider: entry.provider };
    }
    return null;
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

  /** Detail reads hydrate a single library item rather than fan out through
   * `aggregate`, so attach the same availability contract explicitly. */
  private withDetailAvailability<T extends { id: string }>(
    item: T,
    connectionId: string
  ): Available<T> {
    const sources = this.library.getSources(item.id);
    const availableSourceCount = sources.filter((source) => {
      const entry = this.registry.getByConnectionId(source.connectionId);
      return Boolean(entry?.enabled);
    }).length;

    return {
      ...item,
      availability: availabilityFor(
        connectionId,
        Math.max(sources.length, 1),
        availableSourceCount
      ),
    };
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
    const mdId = this.library.ensureId(type, { connectionId, providerItemId: item.id }, type === "track" ? trackContentHint(item) : undefined);
    const measured = type === "track" ? this.importedGain?.({ ...item, id: mdId } as T & Track) : undefined;
    const gain = typeof measured === "object" ? measured.gainDb : measured;
    return { ...item, id: mdId, ...(Number.isFinite(gain) ? { normalizationGainDb: gain } : {}),
      ...(typeof measured === "object" ? { loudness: { integratedLufs: measured.integratedLufs, truePeakDb: measured.truePeakDb } } : {}) };
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
  private withStableTrackId<T extends Pick<Track, "id" | "albumId" | "artistId" | "artistCredits">>(
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
      ...(track.artistCredits?.length ? { artistCredits: track.artistCredits.map((credit) => ({
        ...credit,
        id: credit.id ? this.library.ensureId("artist", { connectionId, providerItemId: credit.id }) : null,
      })) } : {}),
    };
  }

  /**
   * Map an album's provider-native artistId relationship to a stable
   * MusicDeck ID, mirroring track relationship stamping. Without this, an
   * album's artistId stays a raw provider ID that never resolves through
   * `getPrimarySource`, breaking artist-track cross-referencing (e.g.
   * `resolveAlbumCatalogTracks`) and album -> artist navigation links.
   */
  private withStableAlbumArtistId<T extends { artistId: string | null }>(
    album: T,
    connectionId: string
  ): T {
    return {
      ...album,
      artistId: album.artistId
        ? this.library.ensureId("artist", { connectionId, providerItemId: album.artistId })
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
    const connection = this.registry.getByConnectionId(connectionId);
    const withArtwork: T = { ...this.withStableArtwork(item, connectionId), sourceServer: connection?.type };

    if (type === "track") {
      return this.withStableTrackId(withArtwork as T & { albumId: string | null; artistId: string | null }, connectionId) as T;
    }

    if (type === "album") {
      const withId = this.withStableId(withArtwork, type, connectionId);
      return this.withStableAlbumArtistId(withId as T & { artistId: string | null }, connectionId) as T;
    }

    return this.withStableId(withArtwork, type, connectionId);
  }

  /**
   * Run `read` against every enabled catalog provider concurrently, keeping
   * registry order. Each entry resolves to a SettledRead tagged with its
   * connection so failures never reject the whole batch.
   */
  private async runReads<T>(
    operation: string,
    read: (provider: CatalogProvider) => Promise<T>
  ): Promise<Array<SettledRead<T>>> {
    const connections = this.connections();

    const results = await Promise.all(
      connections.map(async (entry): Promise<SettledRead<T>> => {
        try {
          return { entry, ok: true, value: await read(entry.provider) };
        } catch (error) {
          return { entry, ok: false, error };
        }
      })
    );
    if (results.some((result) => result.ok)) {
      for (const result of results) {
        if (result.ok) continue;
        const description = result.error instanceof Error
          ? `${result.error.name}: ${result.error.message}`
          : String(result.error);
        this.logger.push({
          level: "warn",
          source: "server",
          message: "Catalog provider read failed; returning partial results",
          meta: {
            connectionId: result.entry.connectionId,
            providerType: result.entry.type,
            operation,
            // Provider URLs are not needed to diagnose which connection failed.
            errorDescription: redactText(description).replace(/https?:\/\/[^\s"'<>]+/gi, "[provider URL]"),
          },
        });
      }
    }
    return results;
  }

  /**
   * Aggregate successful reads in registry order, stamp availability, and
   * throw a MusicDeck error only when every provider failed.
   */
  private aggregate<T extends { id: string; artworkId: string | null; artworkUrl: string | null }>(
    results: Array<SettledRead<T[]>>,
    type: LibraryItemType
  ): CatalogListResult<T> {
    const totalSources = results.length;
    const availableSources = results.filter((result) => result.ok).length;

    if (availableSources === 0 && totalSources > 0) {
      throw allProvidersUnavailable(results.flatMap((result) => (result.ok ? [] : [result])));
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
    return this.aggregate(await this.runReads("listAlbums", (provider) => provider.listAlbums(limit)), "album");
  }

  async listArtists(): Promise<CatalogListResult<Artist>> {
    return this.aggregate(await this.runReads("listArtists", (provider) => provider.listArtists()), "artist");
  }

  private async readTracks(): Promise<CatalogListResult<Track>> {
    return this.aggregate(await this.runReads("listTracks", (provider) => provider.listTracks()), "track");
  }

  async listTracks(): Promise<CatalogListResult<Track>> {
    const window = this.trackWindow;
    const result = await this.readTracks();
    // A live read can observe an outage or recovery before the snapshot expires.
    if (window && this.trackWindow === window && window.degraded !== undefined && window.degraded !== result.degraded) {
      this.trackWindow = {
        expires: Date.now() + WINDOW_TTL_MS,
        value: Promise.resolve({ ...result, revision: randomUUID() }),
        degraded: result.degraded,
      };
    }
    return result;
  }

  /**
   * Full, uncached listings for diagnostics. `listedConnectionIds` names the
   * connections whose track listing succeeded, so callers only judge items
   * missing from a source that actually answered.
   */
  async auditSnapshot(): Promise<{
    tracks: CatalogListResult<Track>;
    albums: CatalogListResult<Album>;
    artists: CatalogListResult<Artist>;
    listedConnectionIds: string[];
    albumsComplete: boolean;
  }> {
    const [trackReads, albumReads, artistReads] = await Promise.all([
      this.runReads("listTracks", (provider) => provider.listTracks()),
      this.runReads("listAllAlbums", (provider) =>
        provider.listAllAlbums ? provider.listAllAlbums() : provider.listAlbums()),
      this.runReads("listArtists", (provider) => provider.listArtists()),
    ]);
    return {
      tracks: this.aggregate(trackReads, "track"),
      albums: this.aggregate(albumReads, "album"),
      artists: this.aggregate(artistReads, "artist"),
      listedConnectionIds: trackReads.filter((read) => read.ok).map((read) => read.entry.connectionId),
      albumsComplete: albumReads.every((read) => read.ok && typeof read.entry.provider.listAllAlbums === "function"),
    };
  }

  /** Share full track enumeration across viewport reads and background indexes. */
  async tracksForWindow(): Promise<WindowSnapshot<Track>> {
    if (!this.trackWindow || this.trackWindow.expires <= Date.now()) {
      const revision = randomUUID();
      const value = this.readTracks().then((result) => {
        if (this.trackWindow === entry) {
          this.trackWindow = { ...entry, expires: Date.now() + WINDOW_TTL_MS, degraded: result.degraded };
        }
        return { ...result, revision };
      });
      // Even a slow provider read stays shared until it settles.
      const entry = { expires: Infinity, value };
      this.trackWindow = entry;
      value.catch(() => { if (this.trackWindow === entry) this.trackWindow = null; });
    }
    return this.trackWindow.value;
  }

  async albumsForWindow(): Promise<WindowSnapshot<Album>> {
    if (!this.albumWindow || this.albumWindow.expires < Date.now()) {
      const revision = randomUUID();
      const value = this.runReads("listAllAlbums", (provider) =>
        provider.listAllAlbums ? provider.listAllAlbums() : provider.listAlbums())
        .then((results) => ({ ...this.aggregate(results, "album"), revision }));
      const entry = { expires: Date.now() + WINDOW_TTL_MS, value };
      this.albumWindow = entry;
      value.catch(() => { if (this.albumWindow === entry) this.albumWindow = null; });
    }
    return this.albumWindow.value;
  }

  async getRandomAlbums(limit?: number): Promise<CatalogListResult<Album>> {
    return this.aggregate(await this.runReads("getRandomAlbums", (provider) => provider.getRandomAlbums(limit)), "album");
  }

  async getRandomTracks(limit?: number): Promise<CatalogListResult<Track>> {
    return this.aggregate(await this.runReads("getRandomTracks", (provider) => provider.getRandomTracks(limit)), "track");
  }

  async search(query: string, types?: string[]): Promise<CatalogSearchResult> {
    const connections = this.connections();
    const totalSources = connections.length;

    const settled = await this.runReads("search", (provider) => provider.search(query, types));

    const availableSources = settled.filter((result) => result.ok).length;

    if (availableSources === 0 && totalSources > 0) {
      throw allProvidersUnavailable(settled.flatMap((result) => (result.ok ? [] : [result])));
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

  // Provider IDs are scoped to their mapped connection; never send one
  // connection's native ID to another server.

  async getAlbum(albumId: string): Promise<Album | null> {
    const source = this.mappedSource(albumId);
    if (!source) {
      return null;
    }
    const album = await source.provider.getAlbum(source.providerItemId);
    if (!album) return null;
    return this.withDetailAvailability(this.stamp(album, "album", source.connectionId), source.connectionId);
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const source = this.mappedSource(albumId);
    if (!source) {
      return [];
    }
    const tracks = await source.provider.getAlbumTracks(source.providerItemId);
    return tracks.map((track) =>
      this.withDetailAvailability(
        this.stamp(track, "track", source.connectionId),
        source.connectionId
      )
    );
  }

  async getArtist(artistId: string, options?: { includeArtistInfo?: boolean }): Promise<Artist | null> {
    const source = this.mappedSource(artistId);
    if (!source) {
      return null;
    }
    const artist = await source.provider.getArtist(source.providerItemId, options);
    if (artist?.imageUrl && artist.imageUrl === artist.artworkUrl
      && this.registry.getByConnectionId(source.connectionId)?.type === "jellyfin") {
      const stamped = this.stamp(artist, "artist", source.connectionId);
      return { ...stamped, imageUrl: stamped.artworkUrl };
    }
    return artist ? this.withStableId(artist, "artist", source.connectionId) : null;
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    const source = this.mappedSource(artistId);
    if (!source) {
      return [];
    }
    const albums = await source.provider.getArtistAlbums(source.providerItemId);
    const sourceServer = this.registry.getByConnectionId(source.connectionId)?.type;
    return albums.filter((album) => !album.artistId || album.artistId === source.providerItemId).map((album) =>
      ({ ...this.withStableId(album, "album", source.connectionId), artistId, sourceServer })
    );
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const source = this.mappedSource(artistId);
    if (!source) {
      return [];
    }
    const tracks = await source.provider.getArtistTracks(source.providerItemId);
    return tracks.filter((track) => isTrackCreditedTo(track, source.providerItemId)).map((track) =>
      this.withDetailAvailability(
        this.stamp(track, "track", source.connectionId),
        source.connectionId
      )
    );
  }

  async getTrack(trackId: string): Promise<Track | null> {
    const source = this.mappedSource(trackId);
    if (!source) {
      return null;
    }
    const track = await source.provider.getTrack(source.providerItemId);
    if (track) {
      this.library.ensureId("track", { connectionId: source.connectionId, providerItemId: source.providerItemId }, trackContentHint(track));
      await this.library.refreshContentRevision(trackId, source.connectionId);
    }
    return track
      ? this.withDetailAvailability(
          this.stamp(track, "track", source.connectionId),
          source.connectionId
        )
      : null;
  }

  async getTrackFilePath(trackId: string): Promise<string | null> {
    return (await this.resolveTrackFile(trackId))?.filePath ?? null;
  }

  getSourceConnectionId(itemId: string): string | null {
    return this.mappedSource(itemId)?.connectionId ?? null;
  }

  /** Keep the path and owning connection together. An explicit album source
   * must never fall back to deleting another provider's copy of a track. */
  async resolveTrackFile(trackId: string, connectionId?: string): Promise<{ connectionId: string; filePath: string | null } | null> {
    const source = connectionId
      ? this.library.getSources(trackId).find(candidate => candidate.connectionId === connectionId)
      : this.mappedSource(trackId);
    if (!source) return null;
    const entry = this.registry.getByConnectionId(source.connectionId);
    if (!entry?.enabled) return null;
    const filePath = await entry.provider.getTrackFilePath?.(source.providerItemId) ?? null;
    return { connectionId: source.connectionId, filePath };
  }

  /** Administrative file operations request a scan on the owning source.
   * Prefer the nonblocking scan trigger when that provider supports it. */
  async requestLibraryRescan(connectionId: string): Promise<void> {
    const entry = this.registry.getByConnectionId(connectionId);
    if (!entry?.enabled) throw new Error("The owning library source is unavailable");
    this.library.invalidateConnectionContent(connectionId);
    this.trackWindow = null;
    this.albumWindow = null;
    if (entry.provider.requestLibraryRescan) await entry.provider.requestLibraryRescan();
    else if (entry.provider.scanLibrary) await entry.provider.scanLibrary();
    else throw new Error("The owning library source does not support rescanning");
  }

  async getArtistTopTracks(artistId: string, limit = 10): Promise<Track[]> {
    const source = this.mappedSource(artistId);
    if (!source) return [];
    const provider = source.provider;
    const tracks = provider.getArtistTopTracks
      ? await provider.getArtistTopTracks(source.providerItemId, limit)
      : (await provider.getArtistTracks(source.providerItemId))
          .sort((left, right) => (right.playCount || 0) - (left.playCount || 0))
          .slice(0, limit);
    return tracks.filter((track) => isTrackCreditedTo(track, source.providerItemId))
      .slice(0, limit)
      .map((track) => this.withDetailAvailability(
        this.stamp(track, "track", source.connectionId), source.connectionId
      ));
  }

  private metadataProviderForTrack(trackId: string): {
    provider: CatalogProvider;
    providerTrackId: string;
  } | null {
    const source = this.mappedSource(trackId);
    if (!source) return null;
    return { provider: source.provider, providerTrackId: source.providerItemId };
  }

  async getTrackLyrics(trackId: string): Promise<string | null> {
    const resolved = this.metadataProviderForTrack(trackId);
    if (!resolved || typeof resolved.provider.getLyrics !== "function") return null;

    return resolved.provider.getLyrics(resolved.providerTrackId);
  }

  async getTrackArtistBiography(trackId: string): Promise<string | null> {
    const resolved = this.metadataProviderForTrack(trackId);
    if (!resolved || typeof resolved.provider.getArtistBiographyForTrack !== "function") return null;

    return resolved.provider.getArtistBiographyForTrack(resolved.providerTrackId);
  }

  /**
   * Triggers a scan on every connected provider. Provider failures are
   * collected rather than thrown so one broken connection cannot block the
   * rest; callers that care (the scan scheduler) inspect the summary.
   */
  async scanLibrary(task?: TaskRunContext): Promise<{ attempted: number; failures: unknown[] }> {
    if (this.taskManager && !task) {
      const queued = this.taskManager.enqueue("LIBRARY_SCAN", {}, "system");
      this.scanOutcomes.set(queued.id, { attempted: 0, failures: [] });
      try {
        const settled = await this.taskManager.waitForSettlement(queued.id);
        const result = this.scanOutcomes.get(queued.id)!;
        if (settled.state !== "FINISHED" && !result.failures.length) {
          throw new Error(settled.error ?? "Library scan cancelled");
        }
        return result;
      } finally {
        this.scanOutcomes.delete(queued.id);
      }
    }
    const scanners = this.connections().filter((entry) => typeof entry.provider.scanLibrary === "function");
    const failures: unknown[] = [];
    for (const [index, entry] of scanners.entries()) {
      await task?.checkpoint();
      try {
        await entry.provider.scanLibrary!();
        this.library.invalidateConnectionContent(entry.connectionId);
        this.trackWindow = null;
      } catch (error) {
        task?.throwIfCancelled();
        failures.push(error);
      }
      task?.report({ percent: (index + 1) / scanners.length * 100, message: "Requesting provider library scans" });
    }
    task?.throwIfCancelled();
    const result = { attempted: scanners.length, failures };
    if (task && this.scanOutcomes.has(task.taskId)) this.scanOutcomes.set(task.taskId, result);
    return result;
  }
}
