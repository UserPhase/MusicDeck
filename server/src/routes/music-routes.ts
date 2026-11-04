import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { MusicBackend } from "../backends/music-backend.js";
import { requireUser } from "../auth/authorization.js";
import { LoginRateLimiter, DEFAULT_LOGIN_RATE_LIMIT } from "../auth/login-rate-limiter.js";
import { SessionStreamGuard } from "../auth/session-stream.js";
import type { CatalogService } from "../domain/catalog.js";
import type { LibraryService } from "../domain/library.js";
import { SourceResolver, SourceUnavailableError } from "../domain/source-resolver.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { parsePlaylistArtworkId, resolveArtworkSize } from "../domain/playlist-artwork.js";
import { toArtistSearchResult, toLegacySearchResponse, toTrackSearchResult } from "../domain/search.js";
import type { UnifiedSearchResult } from "../domain/search.js";
import type { SearchProviderRegistry } from "../domain/search-provider-registry.js";
import { deduplicateSearchGroups } from "../domain/search-deduplication.js";
import { CompositeMetadataService } from "../services/CompositeMetadataService.js";
import { SubsonicAdapter } from "../services/adapters/SubsonicAdapter.js";
import { DeezerAdapter } from "../services/adapters/DeezerAdapter.js";
import { iTunesAdapter } from "../services/adapters/iTunesAdapter.js";
import type { SourceProviderRegistry } from "../domain/source-provider-registry.js";
import type { ExternalCatalogRegistry } from "../domain/external-catalog.js";
import type { RecommendationRegistry, RecommendationKind } from "../domain/recommendations.js";
import type { LibraryInsightsService, LibraryFilter } from "../domain/library-insights.js";
import { AcquisitionJobError, type AcquisitionService } from "../domain/acquisition.js";
import { acquisitionRequestSchema } from "../domain/acquisition-input.js";
import { AcquisitionValidationError } from "../domain/acquisition-url-policy.js";
import { AcquisitionCapacityError, DEFAULT_ACQUISITION_LIMITS, type AcquisitionLimits } from "../domain/acquisition-limits.js";
import type { SilenceAnalysisService } from "../domain/silence-analysis.js";
import { silenceAnalysisRequestSchema } from "./silence-scan-routes.js";
import type { Album, Artist, Track } from "../types.js";
import { DeezerDiscoveryService } from "../domain/deezer-discovery.js";
import { ExploreDiscoveryService } from "../domain/explore-discovery.js";
import { PlaylistRecommendationService } from "../domain/playlist-recommendations.js";
import { DeezerDiscoveryCatalog } from "../services/discovery/deezerDiscoveryCatalog.js";
import { ItunesArtistCatalog, itunesReleaseKey, sameItunesRecording } from "../domain/itunes-artist-catalog.js";
import { ArtistImageResolver, isNativeArtistPicture } from "../domain/artist-image.js";
import { MusicBrainzAvatarWorker } from "../domain/musicbrainz-avatar-worker.js";
import { LyricsService, parseLrcLines, type LyricsTrack } from "../domain/lyrics-service.js";
import { MediaMetadataFallback } from "../domain/media-metadata-fallback.js";
import { AlbumArtworkService } from "../services/media/albumService.js";
import { ARTWORK_VERDICT_HEADER } from "../services/media/navidromeArtwork.js";
import { isSpotifyArtworkUrl } from "../utils/spotifyArtworkUrl.js";
import { SqliteImportedArtworkRepository } from "../infrastructure/persistence/sqliteImportedArtworkRepository.js";
import { mergeDiscography, type DiscographyAlbum, type DiscographyTrack } from "../services/discovery/discographyMerger.js";
import { normalizeMusicText } from "../domain/music-identity.js";
import {
  findMatchingExternalAlbum,
  findMatchingExternalArtist,
  mergeAlbumTracks,
  recordingsMatch,
} from "../domain/catalog-merge.js";
import { addRecentlyPlayed } from "../domain/recently-played.js";
import { activityRecent, playbackEventSchema, recordPlayback } from "../domain/listening-activity.js";
import { listFavoriteTracks, setTrackFavorite } from "../domain/favorites.js";
import { listUserSettings } from "../domain/settings.js";
import { sendError } from "../utils/http.js";
import { AudioMetadataInspector } from "../services/AudioMetadataInspector.js";
import { currentPrivacyManager } from "../services/PrivacyManager.js";
import { SseConnectionLimiter, SseEventWriter } from "../utils/sse.js";
import type { TaskManager } from "../services/TaskManager.js";
import { RecommendationSeedNotFoundError } from "../services/RecommendationEngine.js";
import { tasteProfile, tasteTarget, tasteArtistId } from "../services/TasteProfileManager.js";
import { hydrateMissingPreviews, normalizeExternalTrack } from "../services/discovery/externalTrackNormalizer.js";

const libraryPageQuerySchema = z.object({
  offset: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const sourceRequestSchema = z.object({
  preference: z.enum(["library", "external", "manual", "best", "lossless", "highest-bitrate", "preferred"]).optional(),
  preferredProvider: z.string().optional(),
  result: z.object({
    id: z.string().min(1),
    type: z.enum(["track", "album", "artist", "playlist"]),
    title: z.string().min(1),
    subtitle: z.string().nullable().optional(),
    artist: z.string().nullable().optional(),
    album: z.string().nullable().optional(),
    provider: z.enum(["library", "musicdeck", "plugin", "external"]),
    source: z.object({
      kind: z.enum(["library", "musicdeck", "external"]),
      count: z.number().nonnegative(),
      externalAvailable: z.boolean().optional(),
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

const trackIdPattern = /^[^/]+$/;
const lyricsQuerySchema = z.object({
  track_name: z.string().trim().min(1).max(300),
  artist_name: z.string().trim().min(1).max(300),
  album_name: z.string().trim().max(300).optional(),
  duration: z.coerce.number().finite().positive().max(86_400),
});
const libraryMatchesSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200),
    type: z.enum(["track", "album"]),
    title: z.string().max(300),
    artist: z.string().max(300),
    isrc: z.string().max(32).nullable().optional(),
  })).max(100),
});
const externalPreviewHydrationSchema = z.object({
  tracks: z.array(z.object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(300),
    artist: z.string().min(1).max(300),
    album: z.string().max(300).nullable().optional(),
    coverUrl: z.string().max(2048).nullable().optional(),
    previewUrl: z.string().max(2048).nullable().optional(),
    isrc: z.string().max(32).nullable().optional(),
  })).max(20),
});

function parseTypes(value: unknown) {
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function sendProxyResponse(reply: any, result: Awaited<ReturnType<MusicBackend["fetchStream"]>>) {
  if (!result.body) {
    return sendError(reply, 502, "Media response did not include a body");
  }

  const allowedHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ];

  for (const header of allowedHeaders) {
    const value = result.headers.get(header);

    if (value) {
      reply.header(header, value);
    }
  }

  return reply.code(result.status).send(Readable.fromWeb(result.body as any));
}

export async function registerMusicRoutes(
  app: FastifyInstance,
  db: Db,
  backend: MusicBackend,
  catalog: CatalogService,
  library: LibraryService,
  sourceResolver: SourceResolver,
  playlists: PlaylistService,
  searchProviders: SearchProviderRegistry,
  sourceProviders: SourceProviderRegistry,
  externalCatalog: ExternalCatalogRegistry,
  recommendations: RecommendationRegistry,
  libraryInsights: LibraryInsightsService,
  acquisition?: AcquisitionService,
  silenceAnalysis?: SilenceAnalysisService,
  acquisitionLimits: AcquisitionLimits = DEFAULT_ACQUISITION_LIMITS,
  taskManager?: TaskManager,
  scrobbleQueue?: import("../services/scrobble/ScrobbleQueueService.js").ScrobbleQueueService
) {
  const audioInspector = new AudioMetadataInspector(
    (trackId, connectionId) => sourceResolver.audioMetadata(trackId, connectionId),
    (error, message) => app.log.warn({ err: error }, message),
  );
  const inspectionQuery = z.object({ inspectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict();
  app.get("/api/v1/stream/inspect/:trackId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const query = inspectionQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, query.error.message);
    const { trackId } = request.params as { trackId: string };
    if (!library.exists(trackId)) return sendError(reply, 404, "Track not found");
    reply.header("Cache-Control", "private, no-store");
    return audioInspector.inspect(user.id, trackId, query.data.inspectionId);
  });
  const acquisitionStreams = new SseConnectionLimiter(acquisitionLimits.ssePerUser, acquisitionLimits.sseGlobal);
  const streamCleanups = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const cleanup of streamCleanups) cleanup();
  });
  const deezerDiscovery = new DeezerDiscoveryService();
  const discoveryCatalog = new DeezerDiscoveryCatalog(externalCatalog.fetchImpl, deezerDiscovery);
  const exploreDiscovery = new ExploreDiscoveryService(db, catalog, recommendations.local,
    discoveryCatalog);
  const playlistRecommendations = new PlaylistRecommendationService(db, catalog, discoveryCatalog);
  const itunesArtistCatalog = new ItunesArtistCatalog(externalCatalog.fetchImpl, externalCatalog.artwork);
  const artistImages = new ArtistImageResolver(externalCatalog.fetchImpl);
  const musicBrainzAvatars = new MusicBrainzAvatarWorker(db, externalCatalog.fetchImpl);
  const lyricsService = new LyricsService(externalCatalog.fetchImpl);
  const lyricReports = new LoginRateLimiter({ ...DEFAULT_LOGIN_RATE_LIMIT, accountMax: 5, windowMs: 60_000 });
  const mediaMetadata = new MediaMetadataFallback(externalCatalog.fetchImpl);
  const albumArtwork = new AlbumArtworkService(async (id) => {
    const result = id.startsWith("mdart_")
      ? await sourceResolver.fetchArtwork(id)
      : await backend.fetchArtwork(id);
    await result.body?.cancel();
    if (result.status === 404) return "placeholder";
    if (result.status !== 200) throw new Error(`Album artwork validation returned ${result.status}`);
    if (!/^image\//i.test(result.headers.get("content-type") || "")) return "placeholder";
    return result.headers.get(ARTWORK_VERDICT_HEADER) === "uncertain" ? "uncertain" : "genuine";
  }, (artist, album) => mediaMetadata.getAlbumCover(artist, album),
  (error) => app.log.warn({ err: error }, "Album artwork resolution failed"),
  new SqliteImportedArtworkRepository(db));
  const metadata = new CompositeMetadataService(
    new SubsonicAdapter(catalog),
    [
      new DeezerAdapter(externalCatalog.fetchImpl, externalCatalog.artwork),
      new iTunesAdapter(externalCatalog.fetchImpl, externalCatalog.artwork),
    ],
    catalog
  );
  const artistSnapshotCache = new Map<string, {
    expiresAt: number;
    value: Promise<{ artist: Artist | null; localAlbums: Album[]; localTracks: Track[] }>;
  }>();

  function localArtistSnapshot(artistId: string) {
    const cached = artistSnapshotCache.get(artistId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = Promise.all([
      catalog.getArtist(artistId, { includeArtistInfo: false }),
      catalog.getArtistAlbums(artistId),
      catalog.getArtistTopTracks(artistId, 10),
    ]).then(([artist, localAlbums, localTracks]) => ({ artist, localAlbums, localTracks }))
      .catch((error) => {
        artistSnapshotCache.delete(artistId);
        throw error;
      });
    artistSnapshotCache.set(artistId, { expiresAt: Date.now() + 15_000, value });
    if (artistSnapshotCache.size > 100) artistSnapshotCache.delete(artistSnapshotCache.keys().next().value!);
    return value;
  }

  app.get("/api/discovery/external", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    try {
      const charts = await deezerDiscovery.getCharts();
      reply.header("Cache-Control", "private, max-age=300");
      return charts;
    } catch {
      return sendError(reply, 502, "External charts are temporarily unavailable", "EXTERNAL_DISCOVERY_UNAVAILABLE");
    }
  });

  app.get("/api/discovery/personalized", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    const result = await exploreDiscovery.get(user.id);
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    reply.header("Cache-Control", "private, no-store");
    return result;
  });

  app.get("/api/v1/playlists/:playlistId/recommendations", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { playlistId } = request.params as { playlistId: string };
    const parsed = z.object({ source: z.enum(["library", "external"]).default("library") }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid recommendation source", "VALIDATION_ERROR");
    if (!playlists.canRead(playlistId, user)) return sendError(reply, 404, "Playlist not found");
    reply.header("Cache-Control", "private, no-store");
    const canModify = playlists.canModify(playlistId, user);
    const external = parsed.data.source === "external";
    if (external && ((user.role !== "admin" && !user.externalSearchEnabled) ||
        currentPrivacyManager()?.isExternalAllowed("metadata") === false)) {
      return { items: [], message: "External suggestions are disabled. Library suggestions are still available.", canModify };
    }
    const playlist = await playlists.get(playlistId, user);
    if (!playlist) return sendError(reply, 404, "Playlist not found");
    try {
      const result = await playlistRecommendations.get(user.id, playlist, external);
      return { ...result, canModify };
    } catch (error) {
      request.log.warn({ err: error }, "Could not load playlist recommendations");
      return sendError(reply, 503, "Playlist recommendations are temporarily unavailable. Try again shortly.", "RECOMMENDATIONS_UNAVAILABLE");
    }
  });

  app.get("/api/discovery/itunes-preview", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    const parsed = z.object({ term: z.string().trim().min(1).max(300), entity: z.literal("song"), limit: z.literal("1") }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid preview lookup", "VALIDATION_ERROR");
    const url = new URL("https://itunes.apple.com/search");
    url.search = new URLSearchParams(parsed.data).toString();
    const response = await externalCatalog.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return sendError(reply, 502, "iTunes preview lookup unavailable");
    reply.header("Cache-Control", "private, no-store");
    return response.json();
  });

  app.post("/api/discovery/external/previews", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = externalPreviewHydrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid external preview lookup request", "VALIDATION_ERROR");
    }

    const tracks = parsed.data.tracks.flatMap((track) => {
      const normalized = normalizeExternalTrack(track);
      return normalized ? [normalized] : [];
    });
    const hydrated = await hydrateMissingPreviews(
      tracks,
      (query) => externalCatalog.deezerProvider.searchTracks(query, 10),
      5
    );
    reply.header("Cache-Control", "private, max-age=300");
    return {
      tracks: hydrated.map(({ id, previewUrl }) => ({ id, previewUrl })),
    };
  });

  app.get("/api/library/random-albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { limit?: string };
    const result = await catalog.getRandomAlbums(Number(query.limit || 16));
    return { albums: result.items, degraded: result.degraded };
  });

  app.get("/api/library/random-tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { limit?: string };
    const result = await catalog.getRandomTracks(Number(query.limit || 10));
    return { tracks: result.items, degraded: result.degraded };
  });

  app.post("/api/library/tracks/filter", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      filters: z.array(z.object({
        field: z.string().min(1),
        op: z.enum(["eq", "gte", "lte", "contains", "boolean"]).optional(),
        value: z.unknown(),
      })).default([]),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid library filter", "VALIDATION_ERROR");
    }

    return libraryInsights.tracks({
      userId: user.id,
      filters: parsed.data.filters as LibraryFilter[],
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  app.get("/api/library/health", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    return libraryInsights.health(user.id);
  });

  app.get("/api/library/statistics", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    return libraryInsights.statistics(user.id);
  });

  app.get("/api/library/collections/:kind", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { kind } = request.params as { kind: string };
    if (kind === "highest-rated") return sendError(reply, 404, "Library collection not found");
    const query = request.query as { limit?: string };
    return libraryInsights.collection(user.id, kind, Number(query.limit || 50));
  });

  app.get("/api/library/saved-filters", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    return { filters: libraryInsights.listFilters(user.id) };
  });

  app.post("/api/library/saved-filters", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      name: z.string().min(1).max(100),
      filters: z.array(z.object({
        field: z.string().min(1),
        op: z.enum(["eq", "gte", "lte", "contains", "boolean"]).optional(),
        value: z.unknown(),
      })),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid saved filter", "VALIDATION_ERROR");
    }

    return reply.code(201).send({
      filter: libraryInsights.saveFilter(user.id, parsed.data.name, parsed.data.filters as LibraryFilter[]),
    });
  });

  app.get("/api/library/collector", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    reply.header("Cache-Control", "private, no-store");
    const includeAlbums = (request.query as { albums?: string }).albums === "1";
    const [tracks, albums] = await Promise.all([
      libraryInsights.collectorTracks(user.id),
      includeAlbums ? catalog.albumsForWindow() : null,
    ]);
    return { ...tracks, ownerId: user.id, albums: albums?.items ?? [], degraded: tracks.degraded || albums?.degraded || false };
  });

  app.put("/api/library/:itemType/:itemId/favorite", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { itemType, itemId } = request.params as { itemType: string; itemId: string };
    if (!["track", "album", "artist", "playlist"].includes(itemType)) {
      return sendError(reply, 400, "Invalid favorite item type", "VALIDATION_ERROR");
    }

    const parsed = z.object({
      favorite: z.boolean(),
      album: z.object({
        name: z.string().trim().min(1).max(500),
        artist: z.string().trim().max(500),
        coverUrl: z.string().max(2048).refine((value) => {
          if (value.startsWith("/api/") && !value.includes("\\")) return true;
          try { return ["https:", "http:"].includes(new URL(value).protocol); }
          catch { return false; }
        }).nullable(),
      }).optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid favorite request", "VALIDATION_ERROR");
    }

    libraryInsights.setFavorite(user.id, itemType as "track" | "album" | "artist" | "playlist", itemId, parsed.data.favorite,
      itemType === "album" ? parsed.data.album : undefined);
    return { ok: true };
  });

  app.get("/api/favorites/albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    reply.header("cache-control", "private, no-store");
    const rows = db.prepare(`SELECT item_id, metadata_json FROM media_favorites
      WHERE user_id = ? AND item_type = 'album' ORDER BY created_at DESC, item_id`)
      .all(user.id) as Array<{ item_id: string; metadata_json: string | null }>;
    const albums = await Promise.all(rows.map(async (row) => {
      if (row.metadata_json) return { ...JSON.parse(row.metadata_json), id: row.item_id };
      // Favorites saved before metadata snapshots were introduced still work.
      try {
        const album = await catalog.getAlbum(row.item_id);
        if (album) return { id: album.id, name: album.name, artist: album.artistName,
          coverUrl: album.artworkUrl, coverArt: album.artworkId };
      } catch { /* Keep an unavailable favorite visible so it can be removed. */ }
      return { id: row.item_id, name: "Saved album", artist: "", coverUrl: null };
    }));
    return { albums };
  });

  app.get("/api/recommendations", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { kinds?: string; limit?: string };
    const allowed = new Set([
      "continue-listening",
      "favorites-mix",
      "forgotten-favorites",
      "discover",
      "similar-tracks",
      "similar-artists",
      "radio-track",
      "radio-artist",
      "radio-album",
    ]);
    const kinds = (query.kinds || "continue-listening,favorites-mix,forgotten-favorites,discover")
      .split(",")
      .map((kind) => kind.trim())
      .filter((kind): kind is RecommendationKind => allowed.has(kind as RecommendationKind));

    return recommendations.sections(user.id, kinds, Number(query.limit || 12));
  });

  app.post("/api/recommendations/radio", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      type: z.enum(["track", "artist", "album"]),
      id: z.string().min(1),
      title: z.string().optional(),
      artist: z.string().optional(),
      album: z.string().optional(),
      artistId: z.string().nullable().optional(),
      albumId: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid radio request", "VALIDATION_ERROR");
    }

    try {
      const tracks = await recommendations.local.radio(parsed.data, user.id, parsed.data.limit || 20);
      return { tracks, degraded: false };
    } catch (error) {
      if (error instanceof RecommendationSeedNotFoundError) return sendError(reply, 404, error.message, "TRACK_NOT_FOUND");
      throw error;
    }
  });

  app.post("/api/recommendations/feedback", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      action: z.enum(["hide", "not-interested", "more-like-this", "less-like-this", "block-artist", "block-album"]),
      itemType: z.enum(["track", "artist", "album"]),
        itemId: z.string().min(1).max(256).optional(),
        title: z.string().trim().min(1).max(500).optional(),
        artist: z.string().trim().min(1).max(500).optional(),
        album: z.string().trim().max(500).optional(),
    }).refine((value) =>
      (value.action !== "block-artist" || value.itemType === "artist") &&
      (value.action !== "block-album" || value.itemType === "album")
    ).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid recommendation feedback", "VALIDATION_ERROR");
    }

    const feedbackId = parsed.data.itemId ?? (parsed.data.itemType === "artist" && parsed.data.artist ? tasteArtistId(parsed.data.artist) : null);
    if (!feedbackId) return sendError(reply, 400, "An item ID or artist name is required.", "VALIDATION_ERROR");
    recommendations.local.setFeedback(user.id, parsed.data.action, parsed.data.itemType, feedbackId, parsed.data);
    return { ok: true };
  });

  app.post("/api/recommendations/autoplay", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    if (tasteProfile(db).state(user.id).privateListening) return { tracks: [], degraded: false };
    const parsed = z.object({
      seedId: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(50).default(10),
      excludeIds: z.array(z.string().min(1).max(256)).max(500).default([]),
      playlistId: z.string().min(1).max(300).optional(), excludeFromTaste: z.boolean().optional(),
    }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid autoplay request", "VALIDATION_ERROR");
    const metadata = tasteProfile(db).resolve({ id: parsed.data.seedId });
    if (tasteProfile(db).decision(user.id, { trackId: parsed.data.seedId, startedAt: new Date().toISOString(), playlistId: parsed.data.playlistId,
      excludeFromTaste: parsed.data.excludeFromTaste, track: { title: metadata.title, artist: metadata.artist } }).excluded) return { tracks: [], degraded: false };
    try {
      const tracks = await recommendations.local.autoplay(user.id, parsed.data.seedId, parsed.data.limit, parsed.data.excludeIds);
      return { tracks, degraded: false };
    } catch (error) {
      if (error instanceof RecommendationSeedNotFoundError) return sendError(reply, 404, error.message, "TRACK_NOT_FOUND");
      throw error;
    }
  });

  app.post("/api/listening-events", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (request.body && typeof request.body === "object" && "playbackSessionId" in request.body) {
      const parsed = playbackEventSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "Invalid playback report", "VALIDATION_ERROR");
      if (parsed.data.ownerUserId && parsed.data.ownerUserId !== user.id) {
        return sendError(reply, 403, "Playback report belongs to a different signed-in user", "USER_MISMATCH");
      }
      let result: ReturnType<typeof recordPlayback>;
      try {
        result = recordPlayback(db, user.id, parsed.data, Date.now(), (id, seconds, duration) =>
          scrobbleQueue?.enqueuePlayback(user.id, id, parsed.data, seconds, duration));
      } catch (error) {
        if (error instanceof Error && (error.message.startsWith("Playback session") || error.message.startsWith("Playback start"))) {
          return sendError(reply, 400, error.message, "VALIDATION_ERROR");
        }
        throw error;
      }
      scrobbleQueue?.kick();
        if (result.tasteChanged || (!result.tasteExcluded && (result.newlyCounted || parsed.data.finished))) recommendations.local.invalidateListeningTaste(user.id);
        if (result.newlyCounted) addRecentlyPlayed(db, user.id, parsed.data.trackId, parsed.data.startedAt, { excluded: result.tasteExcluded, sessionId: parsed.data.playbackSessionId, recordingKey: result.recordingKey });
      if (result.scrobbleDue) {
        // Provider scrobbling is secondary; commit the local event first and
        // never make the player wait for the upstream provider.
        sourceResolver.scrobbleTrack(parsed.data.trackId).catch((error) =>
          request.log.warn({ error }, "Could not scrobble qualified play"));
      }
      return reply.code(200).send({ ok: true, ...result });
    }

    const parsed = z.object({
      trackId: z.string().min(1),
      eventType: z.enum(["play", "skip", "complete"]),
      completionRatio: z.number().min(0).max(1).optional(),
      privateListening: z.boolean().optional(), excludeFromTaste: z.boolean().optional(), playlistId: z.string().min(1).max(300).nullable().optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid listening event", "VALIDATION_ERROR");
    }

    const tasteResult = recommendations.local.recordListeningEvent(user.id, parsed.data.trackId, parsed.data.eventType, parsed.data.completionRatio, parsed.data);
    if (parsed.data.eventType !== "complete") return reply.code(201).send({ ok: true });

    addRecentlyPlayed(db, user.id, parsed.data.trackId, undefined, { excluded: tasteResult.excluded, recordingKey: tasteResult.recordingKey });
    // A local provider outage must not discard the listening event or break playback.
    try {
      const scrobbled = await sourceResolver.scrobbleTrack(parsed.data.trackId);
      return reply.code(201).send({ ok: true, scrobbled });
    } catch (error) {
      request.log.warn({ error }, "Could not scrobble qualified play");
      return reply.code(201).send({ ok: true, scrobbled: false });
    }
  });

  app.get("/api/albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { limit?: string; offset?: string };
    if (query.offset !== undefined) {
      const page = libraryPageQuerySchema.safeParse(query);
      if (!page.success) return sendError(reply, 400, "Invalid library page", "VALIDATION_ERROR");
      const result = await catalog.albumsForWindow();
      return { albums: result.items.slice(page.data.offset, page.data.offset + page.data.limit),
        total: result.items.length, revision: result.revision, degraded: result.degraded };
    }
    const result = await catalog.listAlbums(Number(query.limit || 500));
    return { albums: result.items, degraded: result.degraded };
  });

  // Best-effort catalog completeness for a local album: finds the matching
  // external (Spotify) album by normalized title/artist and merges its known
  // tracklist with the locally downloaded tracks. Never throws — falls back
  // to local-only data when the external catalog is unavailable, disabled,
  // not permitted for this user, or no confident match is found.
  async function resolveAlbumCatalogTracks(
    user: { role: string; externalSearchEnabled: boolean },
    albumId: string,
    localAlbum: { name: string; artistName: string; artistId: string | null }
  ) {
    const localTracks = await catalog.getAlbumTracks(albumId);
    const stampedLocal = localTracks.map((track) =>
      toTrackSearchResult({
        ...track,
        availability: {
          state: "available",
          connectionId: "library",
          sourceCount: 1,
          availableSourceCount: 1,
          libraryAvailable: true,
        },
      })
    );

    const externalAllowed = (user.role === "admin" || user.externalSearchEnabled) &&
      currentPrivacyManager()?.isExternalAllowed("metadata") !== false;
    if (!externalCatalog.isEnabled() || !externalAllowed || currentPrivacyManager()?.isExternalAllowed("metadata") === false) {
      return { tracks: stampedLocal, localCount: stampedLocal.length };
    }

    try {
      const query = `${localAlbum.name} ${localAlbum.artistName || ""}`.trim();
      const results = await externalCatalog.search(query, { limit: 10 });
      const match = findMatchingExternalAlbum(results, localAlbum.name, localAlbum.artistName);
      if (!match) {
        return { tracks: stampedLocal, localCount: stampedLocal.length };
      }

      const detail = await externalCatalog.getAlbum(match.id);
      if (!detail) {
        return { tracks: stampedLocal, localCount: stampedLocal.length };
      }

      const artistTracks = localAlbum.artistId
        ? await catalog.getArtistTracks(localAlbum.artistId)
        : localTracks;
      const localCandidates = artistTracks.map((track) =>
        toTrackSearchResult({
          ...track,
          availability: {
            state: "available",
            connectionId: "library",
            sourceCount: 1,
            availableSourceCount: 1,
            libraryAvailable: true,
          },
        })
      );
      const merged = mergeAlbumTracks(localCandidates, detail.tracks, {
        appendUnmatchedLocal: false,
      });
      return {
        tracks: merged,
        localCount: merged.filter((track) => track.availability?.libraryAvailable).length,
      };
    } catch {
      // Best-effort enrichment only; local library data remains authoritative.
      return { tracks: stampedLocal, localCount: stampedLocal.length };
    }
  }

  async function resolveExternalAlbumTracks(
    externalAlbum: {
      title: string;
      artist: string;
      tracks: UnifiedSearchResult[];
    }
  ) {
    try {
      const localArtists = await catalog.listArtists();
      const localArtistResults = localArtists.items.map((artist) =>
        toArtistSearchResult(artist)
      );
      const localArtist = findMatchingExternalArtist(
        localArtistResults,
        externalAlbum.artist
      );

      if (!localArtist) {
        return { tracks: externalAlbum.tracks, localCount: 0 };
      }

      const localTracks = await catalog.getArtistTracks(localArtist.id);
      const stampedLocal = localTracks.map((track) =>
        toTrackSearchResult({
          ...track,
          availability: {
            state: "available",
            connectionId: "library",
            sourceCount: 1,
            availableSourceCount: 1,
            libraryAvailable: true,
          },
        })
      );

      const tracks = mergeAlbumTracks(stampedLocal, externalAlbum.tracks, {
        appendUnmatchedLocal: false,
      });
      return {
        tracks,
        localCount: tracks.filter((track) => track.availability?.libraryAvailable).length,
      };
    } catch {
      return { tracks: externalAlbum.tracks, localCount: 0 };
    }
  }

  app.get("/api/albums/:albumId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { albumId } = request.params as { albumId: string };

    if (albumId.startsWith("external_") || albumId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const album = albumId.startsWith("external_itunes_album_")
        ? await itunesArtistCatalog.getAlbum(albumId)
        : await externalCatalog.getAlbum(albumId);
      if (!album) {
        return sendError(reply, 404, "Album not found");
      }

      const { tracks, localCount } = await resolveExternalAlbumTracks(album);
      return {
        album: {
          ...await albumArtwork.resolve(album, tracks),
          tracks,
          trackCount: tracks.length,
          localTrackCount: localCount,
        },
      };
    }

    const album = await catalog.getAlbum(albumId);
    if (!album) {
      return sendError(reply, 404, "Album not found");
    }

    const { tracks, localCount } = await resolveAlbumCatalogTracks(user, albumId, album);
    return { album: { ...await albumArtwork.resolve(album, tracks), trackCount: tracks.length, localTrackCount: localCount } };
  });

  app.get<{ Params: { albumId: string }; Querystring: { size?: string } }>("/api/albums/:albumId/artwork", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    const { albumId } = request.params;
    const album = await catalog.getAlbum(albumId);
    if (!album) return sendError(reply, 404, "Album not found");
    const resolved = await albumArtwork.resolve(album, () => catalog.getAlbumTracks(albumId));
    const target = resolved.coverUrl;
    if (target && isSpotifyArtworkUrl(target) && currentPrivacyManager()?.isExternalAllowed("artwork")) {
      return reply.header("Cache-Control", "private, no-store").redirect(target);
    }
    if (!target || !/^\/api\/(?:artwork\/[^/]|metadata\/album-artwork\?)/.test(target)) {
      return sendError(reply, 404, "Artwork not found");
    }
    const [pathname, query] = target.split("?", 2);
    const params = new URLSearchParams(query);
    if (pathname.startsWith("/api/artwork/") && request.query.size !== undefined) {
      params.set("size", String(resolveArtworkSize(request.query.size)));
    }
    reply.header("Cache-Control", resolved.artworkResolutionFailed ? "private, no-store" : "private, max-age=300");
    return reply.redirect(params.size ? `${pathname}?${params}` : pathname);
  });

  app.get("/api/albums/:albumId/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { albumId } = request.params as { albumId: string };
    if (albumId.startsWith("external_") || albumId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const album = albumId.startsWith("external_itunes_album_")
        ? await itunesArtistCatalog.getAlbum(albumId)
        : await externalCatalog.getAlbum(albumId);
      if (!album) {
        return sendError(reply, 404, "Album not found");
      }

      const { tracks } = await resolveExternalAlbumTracks(album);
      return { tracks };
    }

    const album = await catalog.getAlbum(albumId);
    if (!album) {
      return sendError(reply, 404, "Album not found");
    }

    const { tracks } = await resolveAlbumCatalogTracks(user, albumId, album);
    return { tracks };
  });

  app.get("/api/artists", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const result = await catalog.listArtists();
    return { artists: result.items, degraded: result.degraded };
  });

  async function resolvePopularTracks(candidates: UnifiedSearchResult[], localTracks: Track[] = []) {
    const local = localTracks.map(toTrackSearchResult);
    const ranked: UnifiedSearchResult[] = [];
    for (const track of candidates) {
      if (ranked.some((item) => item.id === track.id || recordingsMatch(item, track))) continue;
      ranked.push(track);
      if (ranked.length === 10) break;
    }

    // Artist albums can omit local singles and tracks filed under compilations.
    // Search only the unresolved titles in the ranked list, without a library scan.
    const searches = new Map<string, Promise<UnifiedSearchResult[]>>();
    const resolved = await Promise.all(ranked.map(async (track) => {
      const owned = local.find((item) => recordingsMatch(item, track));
      if (owned) return owned;
      const key = normalizeMusicText(track.title);
      if (!key) return track;
      let lookup = searches.get(key);
      if (!lookup) {
        lookup = catalog.search(track.title, ["tracks"])
          .then((result) => result.tracks.map(toTrackSearchResult)).catch(() => []);
        searches.set(key, lookup);
      }
      return (await lookup).find((item) => recordingsMatch(item, track)) ?? track;
    }));

    const top: UnifiedSearchResult[] = [];
    for (const track of [...resolved, ...local]) {
      if (top.some((item) => item.id === track.id || recordingsMatch(item, track))) continue;
      top.push(track);
      if (top.length === 10) break;
    }
    return top;
  }

  app.get("/api/artists/:artistId/overview", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };
    const { scope } = request.query as { scope?: string };
    const externalAllowed = (user.role === "admin" || user.externalSearchEnabled) &&
      currentPrivacyManager()?.isExternalAllowed("metadata") !== false;
    const keylessExternalArtist = /^external_(deezer|itunes)_artist_/.test(artistId);
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      // Deezer and iTunes detail metadata is keyless. Users who can see a
      // public chart should be able to open its artist page without needing
      // the optional external-search feature flag.
      if (!externalAllowed && !keylessExternalArtist) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }
      const artist = artistId.startsWith("external_itunes_artist_")
        ? await itunesArtistCatalog.getArtist(artistId)
        : await externalCatalog.getArtist(artistId);
      return artist ? {
        artist,
        albums: artist.albums,
        tracks: artist.tracks.slice(0, 10),
        topTracks: await resolvePopularTracks(artist.tracks),
        localAlbumCount: 0,
        localSongCount: 0,
      } : sendError(reply, 404, "Artist not found");
    }

    // The local provider's stable artist ID is the authority for counts and
    // membership. iTunes metadata can only supplement it after corroboration.
    const snapshotStartedAt = performance.now();
    const { artist, localAlbums, localTracks } = await localArtistSnapshot(artistId);
    const snapshotMs = performance.now() - snapshotStartedAt;
    if (!artist) return sendError(reply, 404, "Artist not found");

    const enrichmentStartedAt = performance.now();
    const itunes = externalAllowed && scope !== "local"
      ? await itunesArtistCatalog.resolve(artist, localAlbums, localTracks)
      : null;
    reply.header("server-timing", `artist-snapshot;dur=${snapshotMs.toFixed(1)}, artist-enrichment;dur=${(performance.now() - enrichmentStartedAt).toFixed(1)}`);
    const albumKeys = new Set(localAlbums.map((album) => itunesReleaseKey(album.name)));
    const externalAlbums = itunes?.albums.filter((album) => {
      const key = itunesReleaseKey(album.title);
      if (albumKeys.has(key)) return false;
      albumKeys.add(key);
      return true;
    })
      .map((album) => ({ ...album, artist: artist.name, artistId })) || [];
    const localPopular = localTracks.slice().sort((left, right) =>
      (right.playCount || 0) - (left.playCount || 0)
    );
    const seen = new Set<string>();
    const popular = (itunes?.tracks || []).flatMap((track) => {
      const local = localPopular.find((candidate) => sameItunesRecording(candidate, track, artist));
      const result = local || {
        ...track,
        metadata: { ...track.metadata, artistId },
      };
      if (seen.has(result.id)) return [];
      seen.add(result.id);
      return [result];
    });
    for (const track of localPopular) {
      if (popular.length >= 10) break;
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      popular.push(track);
    }

    return {
      // Provider coverArt/artistImageUrl may contain a stale album cover.
      // Portraits are resolved by the separate, verified endpoint only.
      artist: { ...artist, imageUrl: null },
      albums: [...localAlbums, ...externalAlbums],
      tracks: localTracks.slice(0, 10),
      topTracks: popular.slice(0, 10),
      localAlbumCount: localAlbums.length,
      localSongCount: artist.songCount ?? localAlbums.reduce((total, album) => total + album.songCount, 0),
      externalEnrichmentAvailable: scope === "local" && externalAllowed,
    };
  });

  async function deezerArtistForName(name: string, localAlbums: Album[]) {
    const nameKey = normalizeMusicText(name);
    if (!nameKey) return null;
    const candidates = await externalCatalog.deezerProvider.searchArtists(name, 8).catch(() => []);
    const matches = [...new Set(candidates.filter((candidate) => normalizeMusicText(candidate.title) === nameKey)
      .map((candidate) => candidate.id))];
    if (!matches.length || matches.length > 3) return null;
    const details = await Promise.all(matches.map((id) => externalCatalog.deezerProvider.getArtist(id).catch(() => null)));
    if (matches.length === 1) return details[0];

    const localReleases = new Set(localAlbums.map((album) => itunesReleaseKey(album.name)));
    const ranked = details.flatMap((detail) => detail ? [{ detail, score: new Set(detail.albums
      .map((album) => itunesReleaseKey(album.title)).filter((key) => localReleases.has(key))).size }] : [])
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.score && ranked[0].score !== ranked[1]?.score ? ranked[0].detail : null;
  }

  /**
   * Slow, optional artist enrichment. The Artist page requests this only
   * after its local overview has rendered, so a provider timeout never delays
   * the library view.
   */
  app.get("/api/artists/:artistId/discography", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    if ((user.role !== "admin" && !user.externalSearchEnabled)
      || currentPrivacyManager()?.isExternalAllowed("metadata") === false) {
      return sendError(reply, 403, "External catalog is not available for this user");
    }

    const { artistId } = request.params as { artistId: string };
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      return sendError(reply, 400, "Complete discography requires a local artist");
    }

    const { artist, localAlbums, localTracks: snapshotTracks } = await localArtistSnapshot(artistId);
    if (!artist) return sendError(reply, 404, "Artist not found");
    const localTracks = await catalog.getArtistTracks(artistId).catch(() => snapshotTracks);

    const [itunes, deezerDetail] = await Promise.all([
      itunesArtistCatalog.resolve(artist, localAlbums, localTracks),
      deezerArtistForName(artist.name, localAlbums),
    ]);

    const local = {
      albums: localAlbums.map((album): DiscographyAlbum => ({
        id: album.id, title: album.name, artist: artist.name, year: album.year,
        artworkId: album.artworkId, source: "local",
      })),
      tracks: localTracks.map((track): DiscographyTrack => ({
        id: track.id, title: track.title, artist: track.artistName, album: track.albumName,
        durationSeconds: track.durationSeconds, artworkId: track.artworkId, source: "local",
      })),
    };
    const external = {
      albums: [
        ...(itunes?.albums || []).map((album): DiscographyAlbum => ({
          id: album.id, title: album.title, artist: artist.name, year: album.year,
          artworkId: album.artworkId, source: "external", provider: "itunes",
        })),
        ...(deezerDetail?.albums || []).map((album): DiscographyAlbum => ({
          id: album.id, title: album.title, artist: artist.name, year: album.year,
          artworkId: album.artworkId, source: "external", provider: "deezer",
        })),
      ],
      tracks: [
        ...(itunes?.tracks || []).map((track): DiscographyTrack => ({
          id: track.id, title: track.title, artist: track.artist, album: track.album,
          durationSeconds: typeof track.metadata.durationSeconds === "number" ? track.metadata.durationSeconds : null,
          artworkId: track.artwork?.id || null, previewUrl: track.previewUrl || null,
          source: "external", provider: "itunes", metadata: track.metadata,
        })),
        ...(deezerDetail?.tracks || []).map((track): DiscographyTrack => ({
          id: track.id, title: track.title, artist: track.artist, album: track.album,
          durationSeconds: typeof track.metadata.durationSeconds === "number" ? track.metadata.durationSeconds : null,
          artworkId: track.artwork?.id || null, previewUrl: track.previewUrl || null,
          source: "external", provider: "deezer", metadata: track.metadata,
        })),
      ],
    };
    const merged = mergeDiscography(local, external);
    reply.header("Cache-Control", "private, max-age=300");
    return {
      missingAlbums: merged.missingAlbums.map((album) => ({
        ...album, name: album.title, coverArt: album.artworkId,
        source: { kind: "external", count: 0, externalAvailable: true },
        discographySource: "external",
      })),
      missingTracks: merged.missingTracks.map((track) => ({
        ...track, coverArt: track.artworkId,
        source: { kind: "external", count: 0, externalAvailable: true },
        discographySource: "external",
      })),
      providers: { itunes: Boolean(itunes), deezer: Boolean(deezerDetail) },
    };
  });

  app.get("/api/artists/:artistId/top-tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const externalAllowed = currentPrivacyManager()?.isExternalAllowed("metadata") !== false;
    if (externalAllowed && user.role !== "admin" && !user.externalSearchEnabled) {
      return sendError(reply, 403, "External catalog is not available for this user");
    }
    const { artistId } = request.params as { artistId: string };
    const { artist, localAlbums, localTracks: snapshotTracks } = await localArtistSnapshot(artistId);
    if (!artist) return sendError(reply, 404, "Artist not found");
    const artistTracks = await catalog.getArtistTracks(artistId).catch(() => []);
    const localTracks = [...new Map([...snapshotTracks, ...artistTracks].map((track) => [track.id, track])).values()];
    const [itunes, deezer] = await Promise.all([
      externalAllowed ? itunesArtistCatalog.resolve(artist, localAlbums, localTracks) : Promise.resolve(null),
      externalAllowed ? deezerArtistForName(artist.name, localAlbums) : Promise.resolve(null),
    ]);
    const top = await resolvePopularTracks([...(deezer?.tracks || []), ...(itunes?.tracks || [])], localTracks);
    reply.header("Cache-Control", "private, max-age=300");
    return {
      tracks: top.map((track) => ({
        ...track,
        coverArt: track.artwork?.id ?? null,
        duration: track.metadata.durationSeconds ?? null,
        isDownloaded: track.source.kind === "library",
        discographySource: track.source.kind === "library" ? "local" : "external",
        ...(track.localTrackId ? { localId: track.localTrackId } : {}),
      })),
    };
  });

  // Portrait enrichment is intentionally separate from the artist overview:
  // Deezer can be slow, but must never delay the discography or top tracks.
  app.get("/api/artists/:artistId/portrait", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { artistId } = request.params as { artistId: string };
    const { skipNative, skipDeezer } = request.query as { skipNative?: string; skipDeezer?: string };
    reply.header("Cache-Control", "no-store");
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      return { imageUrl: null };
    }
    const { artist, localAlbums, localTracks } = await localArtistSnapshot(artistId);
    if (!artist) return sendError(reply, 404, "Artist not found");
    if (skipNative !== "1") {
      if (artist.imageUrl === artist.artworkUrl && artist.imageUrl?.startsWith("/api/artwork/mdart_")) {
        return { imageUrl: artist.imageUrl, imageSource: "native", imageKind: "artist" };
      }
      const native = isNativeArtistPicture(artist.imageUrl || null, localAlbums)
        ? artist.imageUrl : (await catalog.getArtist(artistId, { includeArtistInfo: true }).catch(() => null))?.imageUrl;
      if (isNativeArtistPicture(native || null, localAlbums)) {
        return { imageUrl: native, imageSource: "native", imageKind: "artist" };
      }
    }
    if ((user.role !== "admin" && !user.externalSearchEnabled) || currentPrivacyManager()?.isExternalAllowed("artwork") === false) return { imageUrl: null };
    const verified = await artistImages.resolve({ artist, albums: localAlbums, tracks: localTracks },
      { skipDeezer: skipDeezer === "1" });
    const artworkId = verified
      ? externalCatalog.artwork.token(verified.pictureUrl,
        verified.providerId.startsWith("itunes:") ? [".mzstatic.com"] : [".dzcdn.net"])
      : null;
    return { imageUrl: artworkId ? `/api/artwork/external/${encodeURIComponent(artworkId)}` : null,
      imageSource: verified?.providerId.startsWith("itunes:") ? "itunes" : verified ? "deezer" : null,
      imageKind: verified?.kind || null };
  });

  // This endpoint is called by the avatar after mount, never by the overview.
  // Its own response may take seconds while the already-rendered page remains usable.
  app.get("/api/artists/:artistId/portrait/musicbrainz", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { artistId } = request.params as { artistId: string };
    reply.header("Cache-Control", "no-store");
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) return { imageUrl: null };
    if ((user.role !== "admin" && !user.externalSearchEnabled) || currentPrivacyManager()?.isExternalAllowed("artwork") === false) return { imageUrl: null };
    const { artist } = await localArtistSnapshot(artistId);
    if (!artist) return sendError(reply, 404, "Artist not found");
    const imageUrl = await musicBrainzAvatars.resolve(artist);
    return { imageUrl, imageSource: imageUrl ? "musicbrainz" : null, imageKind: imageUrl ? "artist" : null };
  });

  app.post("/api/artists/:artistId/portrait/purge", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    if (user.role !== "admin") return sendError(reply, 403, "Admin access required");
    const { artistId } = request.params as { artistId: string };
    artistImages.purgeArtistImageCache(artistId);
    musicBrainzAvatars.purge(artistId);
    return { purged: true, artistId };
  });

  app.get("/api/artists/:artistId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };

    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = artistId.startsWith("external_itunes_artist_")
        ? await itunesArtistCatalog.getArtist(artistId)
        : await externalCatalog.getArtist(artistId);
      return artist ? { artist } : sendError(reply, 404, "Artist not found");
    }

    const artist = await catalog.getArtist(artistId, { includeArtistInfo: false });
    return artist ? { artist: { ...artist, imageUrl: null } } : sendError(reply, 404, "Artist not found");
  });

  app.get("/api/artists/:artistId/albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = artistId.startsWith("external_itunes_artist_")
        ? await itunesArtistCatalog.getArtist(artistId)
        : await externalCatalog.getArtist(artistId);
      return artist ? { albums: artist.albums } : sendError(reply, 404, "Artist not found");
    }

    const artist = await catalog.getArtist(artistId);
    if (!artist) {
      return sendError(reply, 404, "Artist not found");
    }

    return { albums: await catalog.getArtistAlbums(artistId) };
  });

  app.get("/api/artists/:artistId/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = artistId.startsWith("external_itunes_artist_")
        ? await itunesArtistCatalog.getArtist(artistId)
        : await externalCatalog.getArtist(artistId);
      return artist ? { tracks: artist.tracks } : sendError(reply, 404, "Artist not found");
    }

    return { tracks: await catalog.getArtistTracks(artistId) };
  });

  app.get("/api/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { offset?: string; limit?: string };
    if (query.offset !== undefined) {
      const page = libraryPageQuerySchema.safeParse(query);
      if (!page.success) return sendError(reply, 400, "Invalid library page", "VALIDATION_ERROR");
      const result = await catalog.tracksForWindow();
      return { tracks: result.items.slice(page.data.offset, page.data.offset + page.data.limit),
        total: result.items.length, revision: result.revision, degraded: result.degraded };
    }
    const result = await catalog.listTracks();
    return { tracks: result.items, degraded: result.degraded };
  });

  app.get("/api/tracks/:trackId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };
    const track = await catalog.getTrack(trackId);
    return track ? { track } : sendError(reply, 404, "Track not found");
  });

  app.get("/api/tracks/recently-added", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(query.limit) || 6, 30));
    const result = await catalog.listTracks();
    const tracks = result.items.slice().sort((left, right) =>
      (Date.parse(right.addedAt || "") || 0) - (Date.parse(left.addedAt || "") || 0)
    ).slice(0, limit);
    return { tracks, degraded: result.degraded };
  });

  app.get("/api/tracks/:trackId/lyrics", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };
    const parsed = lyricsQuerySchema.safeParse(request.query);
    let metadata: LyricsTrack | null = parsed.success ? {
      title: parsed.data.track_name,
      artist: parsed.data.artist_name,
      album: parsed.data.album_name,
      durationSeconds: parsed.data.duration,
    } : null;
    if (!metadata) {
      const track = await catalog.getTrack(trackId).catch(() => null);
      if (track?.title && track.artistName && track.durationSeconds) {
        metadata = { title: track.title, artist: track.artistName,
          album: track.albumName || undefined, durationSeconds: track.durationSeconds };
      }
    }
    const local = await catalog.getTrackLyrics(trackId).catch(() => null);
    const localLines = typeof local === "string" ? parseLrcLines(local) : [];
    if (localLines.length) {
      return { syncedLyrics: localLines, plainLyrics: null, isSynced: true,
        provider: "none", instrumental: false, lyrics: local };
    }
    const external = metadata ? await lyricsService.get(trackId, metadata) : null;
    if (external?.syncedLyrics || external?.plainLyrics) {
      return { ...external, lyrics: external.syncedLyrics || external.plainLyrics };
    }
    return {
      syncedLyrics: null,
      plainLyrics: local,
      isSynced: false,
      provider: "none",
      instrumental: external?.instrumental || false,
      lyrics: local,
    };
  });

  app.post("/api/tracks/:trackId/lyrics/report", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const params = z.object({ trackId: z.string().min(1).max(300).regex(/^[\w.:-]+$/) }).safeParse(request.params);
    const body = z.object({ reason: z.enum(["wrong-lyrics", "wrong-timing"]), ownerId: z.string().min(1) })
      .strict().safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid lyrics report");
    if (body.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed");
    const admission = lyricReports.admit(request.ip, user.id);
    if (!admission.allowed) {
      reply.header("Retry-After", admission.retryAfter);
      return sendError(reply, 429, "Too many lyrics reports. Try again shortly.");
    }
    try {
      request.log.warn({ trackId: params.data.trackId, userId: user.id, reason: body.data.reason }, "Lyrics issue reported");
      return reply.code(204).send();
    } finally {
      admission.release();
    }
  });

  const artistMetadataQuery = z.object({ artist: z.string().trim().min(1).max(300) });
  const albumMetadataQuery = artistMetadataQuery.extend({ album: z.string().trim().min(1).max(300) });
  let activeArtworkFallbacks = 0;

  app.get("/api/metadata/artist-biography", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = artistMetadataQuery.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid artist metadata request");
    try {
      const biography = await mediaMetadata.getBiography(parsed.data.artist);
      reply.header("Cache-Control", "private, max-age=300");
      return { biography };
    } catch (error) {
      request.log.warn({ err: error }, "Artist biography lookup failed");
      return sendError(reply, 502, "Could not load the artist biography");
    }
  });

  app.get("/api/metadata/album-artwork", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = albumMetadataQuery.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid album metadata request");
    if (activeArtworkFallbacks >= 20) return sendError(reply, 503, "Artwork lookup capacity exceeded");
    activeArtworkFallbacks++;
    try {
      const url = await mediaMetadata.getAlbumCover(parsed.data.artist, parsed.data.album);
      if (!url) return sendError(reply, 404, "No matching album artwork found");
      const response = await mediaMetadata.fetchCover(url);
      const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "";
      if (!response.ok || !response.body || !/^image\/(?:jpeg|png|webp|gif)$/i.test(contentType)) {
        await response.body?.cancel();
        return sendError(reply, 502, "Album artwork unavailable");
      }
      // Bound the upstream payload even when the CDN omits Content-Length.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel();
            return sendError(reply, 502, "Album artwork exceeds the size limit");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      reply.header("Content-Type", contentType);
      reply.header("Cache-Control", "private, max-age=86400");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(Buffer.concat(chunks, bytes));
    } catch (error) {
      request.log.warn({ err: error }, "Album artwork lookup failed");
      return sendError(reply, 502, "Could not load album artwork");
    } finally { activeArtworkFallbacks--; }
  });

  app.get("/api/tracks/:trackId/artist-biography", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };
    return { biography: await catalog.getTrackArtistBiography(trackId) };
  });

  // Silence-trim metadata: exposes whatever MusicDeck has already analyzed
  // for this track (or `analysis: null` when it has never been analyzed).
  // Never triggers analysis itself — that is an explicit, separate action.
  app.get("/api/tracks/:trackId/silence-analysis", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!silenceAnalysis) {
      return { analysis: null };
    }

    const { trackId } = request.params as { trackId: string };
    const parsed = z.object({ thresholdDb: z.coerce.number().min(-100).max(0).optional(),
      minSilenceSeconds: z.coerce.number().positive().max(30).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid silence analysis settings", "VALIDATION_ERROR");
    await sourceResolver.refreshContentRevision(trackId);
    return { analysis: silenceAnalysis.getAnalysis(trackId, Object.keys(parsed.data).length ? parsed.data : undefined) };
  });

  // Manual (re-)analysis. Always resolves with a result (completed or
  // failed) rather than a 5xx — a failed analysis is a valid, persisted
  // outcome that the client falls back on.
  app.post("/api/tracks/:trackId/silence-analysis", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!silenceAnalysis) {
      return sendError(reply, 503, "Silence analysis is not available");
    }

    const { trackId } = request.params as { trackId: string };

    if (!library.exists(trackId)) {
      return sendError(reply, 404, "Track not found");
    }

    const parsed = silenceAnalysisRequestSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid silence analysis request", "VALIDATION_ERROR");
    }

    const analysis = await silenceAnalysis.analyzeTrack(trackId, parsed.data);
    return { analysis };
  });

  app.get("/api/search", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const personalize = (groups: Parameters<typeof deduplicateSearchGroups>[0], all = false) => {
      const allows = tasteProfile(db).feedbackFilter(user.id);
      return Object.fromEntries(Object.entries(groups).map(([type, items]) => [type, items.filter(item =>
        item.type === "playlist" || (!all && item.source?.kind === "library") || allows(tasteTarget(item)))])) as typeof groups;
    };

    const query = request.query as { q?: string; types?: string; mode?: string; phase?: string };
    const types = parseTypes(query.types)?.flatMap((type) => {
      if (type === "tracks" || type === "songs") return ["track"] as const;
      if (type === "albums") return ["album"] as const;
      if (type === "artists") return ["artist"] as const;
      if (type === "playlists") return ["playlist"] as const;
      return [];
    });
    const requestedMode = query.mode === "library" || query.mode === "external" || query.mode === "hybrid"
      ? query.mode
      : "hybrid";
    const canSearchExternal = (user.role === "admin" || user.externalSearchEnabled) &&
      currentPrivacyManager()?.isExternalAllowed("metadata") !== false;

    if (requestedMode === "external" && !canSearchExternal) {
      return sendError(reply, 403, "External search is not available for this user");
    }

    const mode = canSearchExternal ? requestedMode : "library";
    if (query.phase === "local") {
      const local = await searchProviders.search(query.q || "", { types, mode: "library", user });
      const groups = deduplicateSearchGroups(local.groups);
      return { ...toLegacySearchResponse(local.groups), results: groups, degraded: local.degraded };
    }

    if (query.phase === "external") {
      if (!canSearchExternal || mode === "library") {
        return { results: { track: [], album: [], artist: [], playlist: [] }, degraded: false };
      }
      const keylessEnabled = searchProviders.rawConfig("deezer")?.enabled !== false;
      const external = keylessEnabled
        ? await metadata.searchExternal(query.q || "", types)
        : { groups: { track: [], album: [], artist: [], playlist: [] }, degraded: false };
      let extra: UnifiedSearchResult[] = [];
      if (searchProviders.rawConfig("spotify")?.enabled && externalCatalog.isEnabled()) {
        try {
          const catalogResults = await externalCatalog.search(query.q || "", { limit: 12 });
          extra = await metadata.annotateLibraryMatches(catalogResults.filter((item) => item.id.startsWith("external_spotify_")));
        } catch {
          // The keyless adapters remain usable when the configured catalog fails.
        }
      }
      return {
          results: personalize(deduplicateSearchGroups({
          ...external.groups,
          track: [...external.groups.track, ...extra.filter((item) => item.type === "track")],
          album: [...external.groups.album, ...extra.filter((item) => item.type === "album")],
          artist: [...external.groups.artist, ...extra.filter((item) => item.type === "artist")],
          }), true),
        degraded: external.degraded,
      };
    }
    const result = await searchProviders.search(query.q || "", { types, mode, user });
    const shouldSearchExternal = canSearchExternal
      && externalCatalog.isEnabled()
      && (mode === "hybrid" || mode === "external")
      && (!types || types.some((type) => type !== "playlist"));

    if (shouldSearchExternal) {
      try {
        const external = await externalCatalog.search(query.q || "", { limit: 12 });
        const groups = personalize(deduplicateSearchGroups({
          ...result.groups,
          track: [...result.groups.track, ...external.filter((item) => item.type === "track")],
          album: [...result.groups.album, ...external.filter((item) => item.type === "album")],
          artist: [...result.groups.artist, ...external.filter((item) => item.type === "artist")],
        }), mode === "external");
        const legacy = toLegacySearchResponse(groups);
        return { ...legacy, results: groups, degraded: result.degraded };
      } catch {
        // Keep library results available when external discovery degrades.
      }
    }

    const normalized = personalize(deduplicateSearchGroups(result.groups), mode === "external");
    const legacy = toLegacySearchResponse(normalized);
    return {
      ...legacy,
      results: normalized,
      degraded: result.degraded,
    };
  });

  app.post("/api/library/matches", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = libraryMatchesSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid library match request");
    const candidates = parsed.data.items.map((item): UnifiedSearchResult => ({
      id: item.id,
      type: item.type,
      title: item.title,
      subtitle: item.artist,
      artist: item.artist,
      album: null,
      artwork: null,
      provider: "external",
      source: { kind: "external", count: 0 },
      availability: null,
      metadata: {},
      ...(item.isrc ? { identityHints: { isrc: item.isrc } } : {}),
    }));
    const matched = await metadata.annotateLibraryMatches(candidates);
    return {
      matches: matched.map((item) => ({
        id: item.id,
        inLibrary: Boolean(item.inLibrary),
        localTrackId: item.localTrackId || null,
        localAlbumId: item.localAlbumId || null,
      })),
    };
  });

  app.get("/api/favorites/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    return { tracks: await listFavoriteTracks(db, catalog, user.id) };
  });

  app.put("/api/favorites/tracks/:trackId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };

    if (!trackIdPattern.test(trackId)) {
      return sendError(reply, 400, "Invalid track ID", "VALIDATION_ERROR");
    }

    await setTrackFavorite(db, user.id, trackId, true);
    recommendations.local.invalidateListeningTaste(user.id);
    return { ok: true };
  });

  app.delete("/api/favorites/tracks/:trackId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };

    if (!trackIdPattern.test(trackId)) {
      return sendError(reply, 400, "Invalid track ID", "VALIDATION_ERROR");
    }

    await setTrackFavorite(db, user.id, trackId, false);
    recommendations.local.invalidateListeningTaste(user.id);
    return { ok: true };
  });

  app.get("/api/recently-played", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    return { tracks: await activityRecent(db, catalog, user.id, (request.query as { tasteOnly?: string }).tasteOnly === "1") };
  });

  app.post("/api/recently-played", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const body = request.body as { trackId?: unknown } | undefined;
    const trackId = typeof body?.trackId === "string" ? body.trackId : "";

    if (!trackIdPattern.test(trackId)) {
      return sendError(reply, 400, "Invalid recently played request", "VALIDATION_ERROR");
    }

    addRecentlyPlayed(db, user.id, trackId);
    recommendations.local.recordListeningEvent(user.id, trackId, "complete");
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/sources", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = sourceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid source resolution request", "VALIDATION_ERROR");
    }

    const preferenceSetting = (listUserSettings(db, user.id) as Array<{ key: string; value: string }>)
      .find((setting) => setting.key === "playback.sourcePreference");
    let preference: import("../domain/playable-sources.js").SourcePreference = "manual";
    try {
      const value = preferenceSetting ? JSON.parse(preferenceSetting.value) : null;
      preference = value === "library-first" || value === "library"
        ? "library"
        : value === "external-first" || value === "external"
          ? "external"
          : value === "best" || value === "lossless" || value === "highest-bitrate"
            ? value
            : "manual";
    } catch {
      preference = "manual";
    }

    if (parsed.data.preference) {
      preference = parsed.data.preference;
    }

    const resolved = await sourceProviders.resolve({
      ...parsed.data.result,
      subtitle: parsed.data.result.subtitle || null,
      artist: parsed.data.result.artist || null,
      album: parsed.data.result.album || null,
      artwork: null,
      availability: null,
      metadata: parsed.data.result.metadata || {},
    }, {
      allowExternal: user.role === "admin" || user.externalPlaybackEnabled,
      preference,
      preferredProvider: parsed.data.preferredProvider,
    });

    return {
      result: { id: parsed.data.result.id, type: parsed.data.result.type },
      ...resolved,
    };
  });

  app.get("/api/tracks/:trackId/stream", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { trackId } = request.params as { trackId: string };
    const query = request.query as { source?: string; playableSource?: string; maxBitRate?: string; inspectionId?: string };
    const inspectionId = query.inspectionId;
    if (inspectionId !== undefined && !inspectionQuery.safeParse({ inspectionId }).success) {
      return sendError(reply, 400, "Invalid audio inspection identifier");
    }
    const preferredSource = typeof query.source === "string" && query.source ? query.source : undefined;
    const playableSource = typeof query.playableSource === "string" && query.playableSource ? query.playableSource : undefined;
    const requestedBitRate = Number(query.maxBitRate);
    const maxBitRate = [128, 192, 256, 320].includes(requestedBitRate)
      ? requestedBitRate
      : undefined;

    if (playableSource) {
      if (sourceProviders.isExternalSource(trackId, playableSource)
        && user.role !== "admin"
        && !user.externalPlaybackEnabled) {
        return sendError(reply, 403, "External playback is not available for this user");
      }

      const release = taskManager?.acquireMediaStream();
      if (release) {
        reply.raw.once("finish", release);
        reply.raw.once("close", release);
        reply.raw.once("error", release);
      }
      try {
        const result = await sourceProviders.fetchStream(trackId, playableSource, request.headers.range);
        return await sendProxyResponse(reply, result);
      } catch {
        release?.();
        return sendError(reply, 502, "Playback unavailable");
      }
    }

    if (!library.exists(trackId)) {
      return sendError(reply, 404, "Track not found");
    }

    const release = taskManager?.acquireMediaStream();
    if (release) {
      reply.raw.once("finish", release);
      reply.raw.once("close", release);
      reply.raw.once("error", release);
    }
    try {
      let result = await sourceResolver.fetchStream(trackId, request.headers.range, preferredSource, maxBitRate);
      if (inspectionId) result = audioInspector.observe(user.id, trackId, inspectionId, result, request.headers.range);
      return await sendProxyResponse(reply, result);
    } catch (error) {
      release?.();
      if (error instanceof SourceUnavailableError) {
        return sendError(reply, 502, "Playback unavailable");
      }
      throw error;
    }
  });

  app.get("/api/artwork/external/:artworkId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (user.role !== "admin" && !user.externalSearchEnabled) {
      return sendError(reply, 403, "External catalog is not available for this user");
    }

    const { artworkId } = request.params as { artworkId: string };
    const url = externalCatalog.getArtwork(artworkId);
    if (!url) {
      return sendError(reply, 404, "Artwork not found");
    }

    const response = await externalCatalog.fetchArtwork(url);
    if (!response.ok || !response.body) {
      return sendError(reply, 502, "Artwork unavailable");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(contentType)) {
      return sendError(reply, 502, "Artwork unavailable");
    }

    reply.header("content-type", contentType.split(";")[0]);
    reply.header("cache-control", "private, max-age=300");
    return reply.send(Readable.fromWeb(response.body as any));
  });

  app.get("/api/artwork/:artworkId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artworkId } = request.params as { artworkId: string };
    const { size } = request.query as { size?: string };

    // Playlist cover art (custom upload or the automatic 2x2 collage)
    // resolves through the same authenticated artwork proxy as every other
    // MusicDeck artwork reference.
    const playlistArtwork = parsePlaylistArtworkId(artworkId);

    if (playlistArtwork) {
      const rendered = await playlists.renderArtwork(
        playlistArtwork.playlistId,
        user,
        resolveArtworkSize(size)
      );

      if (!rendered) {
        return sendError(reply, 404, "Artwork not found");
      }

      reply.header("content-type", rendered.contentType);
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      return reply.send(rendered.body);
    }

    // MusicDeck artwork IDs (mdart_) resolve through the SourceResolver.
    // A provider-native cover-art ID is still accepted as a bounded
    // compatibility path for clients that have not yet been re-stamped, and
    // is not the long-term public model.
    const isMusicDeckArtwork = artworkId.startsWith("mdart_");

    if (isMusicDeckArtwork && !library.exists(artworkId)) {
      return sendError(reply, 404, "Artwork not found");
    }

    // A thumbnail hint is forwarded to the backing provider, which resizes
    // server-side; providers that cannot resize return the full image.
    const thumbnailSize = size === undefined ? undefined : resolveArtworkSize(size);

    try {
      // Respect provider cache headers when present; otherwise give the
      // browser a private cache so revisiting the page does not reload covers.
      reply.header("cache-control", "private, max-age=3600");
      const result = isMusicDeckArtwork
        ? await sourceResolver.fetchArtwork(artworkId, thumbnailSize)
        : thumbnailSize === undefined
          ? await backend.fetchArtwork(artworkId)
          : await backend.fetchArtwork(artworkId, thumbnailSize);
      if (result.status === 404) {
        await result.body?.cancel();
        reply.header("cache-control", "private, no-store");
        return sendError(reply, 404, "Artwork not found");
      }
      return await sendProxyResponse(reply, result);
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        return sendError(reply, 502, "Artwork unavailable");
      }
      throw error;
    }
  });

  app.post("/api/acquisitions", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (user.role !== "admin" && !user.externalPlaybackEnabled) {
      return sendError(reply, 403, "On-demand acquisitions are not enabled for this user");
    }

    if (!acquisition) {
      return sendError(reply, 503, "Acquisition service is not available");
    }

    const parsed = acquisitionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid acquisition request payload", "VALIDATION_ERROR");
    }
    const body = parsed.data;

    try {
      const job = await acquisition.createJob({
        userId: user.id,
        candidate: body.candidate,
        candidateId: body.candidateId,
        result: body.result,
        sourceProvider: body.sourceProvider,
        containerId: body.containerId,
        trackId: body.trackId,
        albumId: body.albumId,
        spotifyTrackUrl: body.spotifyTrackUrl,
        spotifyUrl: body.spotifyUrl,
        autoPlay: Boolean(body.autoPlay),
      });

      const statusCode = job.status === "completed" ? 200 : 202;
      return reply.code(statusCode).send({
        jobId: job.id,
        status: job.status,
        job,
      });
    } catch (error) {
      if (error instanceof AcquisitionCapacityError) {
        reply.header("Retry-After", error.retryAfter);
        return sendError(reply, 429, error.message, "ACQUISITION_CAPACITY");
      }
      if (error instanceof AcquisitionValidationError) {
        return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      }
      request.log.error({ err: error, operation: "acquisition.create" }, "Failed to create acquisition job");
      return sendError(reply, 500, "Failed to create acquisition job", "ACQUISITION_CREATE_FAILED");
    }
  });

  app.get("/api/acquisitions/events", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return sendError(reply, 503, "Acquisition service is not available");
    }

    const release = acquisitionStreams.reserve(user.id);
    if (!release) {
      reply.header("Retry-After", 30);
      return sendError(reply, 429, "Acquisition event connection limit reached", "ACQUISITION_CAPACITY");
    }
    let eventWriter: SseEventWriter | undefined;
    let unsubscribe: (() => void) | undefined;
    let guard: SessionStreamGuard | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      release();
      guard?.close();
      unsubscribe?.();
      streamCleanups.delete(cleanup);
      request.raw.removeListener("aborted", cleanup);
      reply.raw.removeListener("close", cleanup);
      reply.raw.removeListener("error", cleanup);
      reply.raw.removeListener("finish", cleanup);
      eventWriter?.close();
    };
    streamCleanups.add(cleanup);
    request.raw.once("aborted", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.once("finish", cleanup);
    try {
      guard = new SessionStreamGuard(db, request, user.role === "admin", cleanup, (error) => app.log.error(error));
      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders?.();
      eventWriter = new SseEventWriter(reply.raw, undefined, undefined, (event, payload) => {
        const current = guard?.currentUser();
        return Boolean(current && (event === "connected" || current.role === "admin" || payload.userId === current.id));
      });
      guard.start();
      eventWriter.push("connected", { connected: true });

      if (!closed) {
        unsubscribe = acquisition.subscribe((event, payload) => {
          eventWriter?.push(event, payload);
        });
      }
    } catch (error) {
      cleanup();
      app.log.error(error);
      reply.raw.destroy();
    }
  });

  app.get<{ Querystring: { scope?: string } }>("/api/acquisitions", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return { jobs: [] };
    }

    const jobs = acquisition.listJobs(user.id, user.role === "admin" && request.query.scope !== "mine");
    reply.header("Cache-Control", "private, no-store");
    return { jobs };
  });

  app.get("/api/acquisitions/:id", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return sendError(reply, 404, "Acquisition not found");
    }

    const { id } = request.params as { id: string };
    const job = acquisition.getJob(id, user.id, user.role === "admin");
    if (!job) {
      return sendError(reply, 404, "Acquisition job not found");
    }

    return { job };
  });

  app.post("/api/acquisitions/:id/cancel", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return sendError(reply, 404, "Acquisition not found");
    }

    const { id } = request.params as { id: string };
    const cancelled = await acquisition.cancelJob(id, user.id, user.role === "admin");
    if (!cancelled) {
      return sendError(reply, 400, "Could not cancel acquisition job");
    }

    const job = acquisition.getJob(id, user.id, user.role === "admin");
    return { ok: true, job };
  });

  app.post("/api/acquisitions/:id/retry", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return sendError(reply, 404, "Acquisition not found");
    }

    const { id } = request.params as { id: string };
    try {
      const job = await acquisition.retryJob(id, user.id, user.role === "admin");
      return { ok: true, job };
    } catch (error) {
      if (error instanceof AcquisitionCapacityError) {
        reply.header("Retry-After", error.retryAfter);
        return sendError(reply, 429, error.message, "ACQUISITION_CAPACITY");
      }
      if (error instanceof AcquisitionJobError) {
        return sendError(reply, error.code === "ACQUISITION_NOT_FOUND" ? 404 : 409, error.message, error.code);
      }
      if (error instanceof AcquisitionValidationError) {
        return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      }
      request.log.error({ err: error, operation: "acquisition.retry" }, "Failed to retry acquisition job");
      return sendError(reply, 500, "Failed to retry acquisition job", "ACQUISITION_RETRY_FAILED");
    }
  });
}
