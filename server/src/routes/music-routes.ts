import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { MusicBackend } from "../backends/music-backend.js";
import { requireUser } from "../auth/authorization.js";
import type { CatalogService } from "../domain/catalog.js";
import type { LibraryService } from "../domain/library.js";
import { SourceResolver, SourceUnavailableError } from "../domain/source-resolver.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { parsePlaylistArtworkId, resolveArtworkSize } from "../domain/playlist-artwork.js";
import { toAlbumSearchResult, toArtistSearchResult, toLegacySearchResponse, toTrackSearchResult } from "../domain/search.js";
import type { UnifiedSearchResult } from "../domain/search.js";
import type { SearchProviderRegistry } from "../domain/search-provider-registry.js";
import { deduplicateSearchGroups } from "../domain/search-deduplication.js";
import type { SourceProviderRegistry } from "../domain/source-provider-registry.js";
import type { ExternalCatalogRegistry } from "../domain/external-catalog.js";
import type { RecommendationRegistry, RecommendationKind } from "../domain/recommendations.js";
import type { LibraryInsightsService, LibraryFilter } from "../domain/library-insights.js";
import type { AcquisitionService } from "../domain/acquisition.js";
import type { SilenceAnalysisService } from "../domain/silence-analysis.js";
import {
  findMatchingExternalAlbum,
  findMatchingExternalArtist,
  mergeAlbumTracks,
  mergeArtistAlbums,
} from "../domain/catalog-merge.js";

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
import { addRecentlyPlayed, listRecentlyPlayed } from "../domain/recently-played.js";
import { listFavoriteTracks, setTrackFavorite } from "../domain/favorites.js";
import { listUserSettings } from "../domain/settings.js";
import { getPrimaryConnectionId } from "../domain/connections.js";
import { sendError } from "../utils/http.js";

const trackIdPattern = /^[^/]+$/;

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
  silenceAnalysis?: SilenceAnalysisService
) {
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
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid library filter", "VALIDATION_ERROR");
    }

    return libraryInsights.tracks({
      userId: user.id,
      filters: parsed.data.filters as LibraryFilter[],
      limit: parsed.data.limit,
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

  app.put("/api/library/:itemType/:itemId/rating", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { itemType, itemId } = request.params as { itemType: string; itemId: string };
    if (!["track", "album", "artist"].includes(itemType)) {
      return sendError(reply, 400, "Invalid rating item type", "VALIDATION_ERROR");
    }

    const parsed = z.object({ rating: z.number().int().min(1).max(5).nullable() }).safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid rating", "VALIDATION_ERROR");
    }

    try {
      libraryInsights.setRating(user.id, itemType as "track" | "album" | "artist", itemId, parsed.data.rating);
      return { ok: true };
    } catch {
      return sendError(reply, 400, "Invalid rating", "VALIDATION_ERROR");
    }
  });

  app.put("/api/library/:itemType/:itemId/favorite", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { itemType, itemId } = request.params as { itemType: string; itemId: string };
    if (!["track", "album", "artist", "playlist"].includes(itemType)) {
      return sendError(reply, 400, "Invalid favorite item type", "VALIDATION_ERROR");
    }

    const parsed = z.object({ favorite: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid favorite request", "VALIDATION_ERROR");
    }

    libraryInsights.setFavorite(user.id, itemType as "track" | "album" | "artist" | "playlist", itemId, parsed.data.favorite);
    return { ok: true };
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

    const tracks = await recommendations.local.radio(parsed.data, user.id, parsed.data.limit || 20);
    return { tracks, degraded: false };
  });

  app.post("/api/recommendations/feedback", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      action: z.enum(["hide", "not-interested", "more-like-this", "less-like-this", "block-artist", "block-album"]),
      itemType: z.enum(["track", "artist", "album"]),
      itemId: z.string().min(1),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid recommendation feedback", "VALIDATION_ERROR");
    }

    recommendations.local.setFeedback(user.id, parsed.data.action, parsed.data.itemType, parsed.data.itemId);
    return { ok: true };
  });

  app.post("/api/listening-events", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      trackId: z.string().min(1),
      eventType: z.enum(["play", "skip", "complete"]),
      completionRatio: z.number().min(0).max(1).optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid listening event", "VALIDATION_ERROR");
    }

    recommendations.local.recordListeningEvent(user.id, parsed.data.trackId, parsed.data.eventType, parsed.data.completionRatio);
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const query = request.query as { limit?: string };
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

    const externalAllowed = user.role === "admin" || user.externalSearchEnabled;
    if (!externalCatalog.isEnabled() || !externalAllowed) {
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

      const album = await externalCatalog.getAlbum(albumId);
      if (!album) {
        return sendError(reply, 404, "Album not found");
      }

      const { tracks, localCount } = await resolveExternalAlbumTracks(album);
      return {
        album: {
          ...album,
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
    return { album: { ...album, trackCount: tracks.length, localTrackCount: localCount } };
  });

  app.get("/api/albums/:albumId/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { albumId } = request.params as { albumId: string };
    if (albumId.startsWith("external_") || albumId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const album = await externalCatalog.getAlbum(albumId);
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

  app.get("/api/artists/:artistId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };

    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = await externalCatalog.getArtist(artistId);
      return artist ? { artist } : sendError(reply, 404, "Artist not found");
    }

    const artist = await catalog.getArtist(artistId);
    return artist ? { artist } : sendError(reply, 404, "Artist not found");
  });

  // Best-effort catalog completeness for a local artist: finds the matching
  // external (Spotify) artist by normalized name and merges its known albums
  // with the locally known albums, so albums with zero downloaded tracks
  // still remain visible. Falls back to local-only data on any failure.
  async function resolveArtistCatalogAlbums(
    user: { role: string; externalSearchEnabled: boolean },
    artistId: string,
    localArtist: { name: string }
  ) {
    const localAlbums = await catalog.getArtistAlbums(artistId);
    const stampedLocal = localAlbums.map((album) =>
      toAlbumSearchResult({
        ...album,
        availability: {
          state: "available",
          connectionId: "library",
          sourceCount: 1,
          availableSourceCount: 1,
          libraryAvailable: true,
        },
      })
    );

    const externalAllowed = user.role === "admin" || user.externalSearchEnabled;
    if (!externalCatalog.isEnabled() || !externalAllowed) {
      return stampedLocal;
    }

    try {
      const results = await externalCatalog.search(localArtist.name, { limit: 10 });
      const match = findMatchingExternalArtist(results, localArtist.name);
      if (!match) {
        return stampedLocal;
      }

      const detail = await externalCatalog.getArtist(match.id);
      if (!detail) {
        return stampedLocal;
      }

      const catalogAlbums: UnifiedSearchResult[] = detail.albums.map((album) => ({
        type: "album",
        id: album.id,
        title: album.title,
        subtitle: localArtist.name,
        artist: localArtist.name,
        album: null,
        artwork: album.artworkId
          ? { id: album.artworkId, url: `/api/artwork/external/${encodeURIComponent(album.artworkId)}` }
          : null,
        provider: "external",
        source: { kind: "external", count: 0 },
        availability: null,
        identity: album.identity,
        metadata: { year: album.year },
      }));

      return mergeArtistAlbums(stampedLocal, catalogAlbums);
    } catch {
      return stampedLocal;
    }
  }

  app.get("/api/artists/:artistId/albums", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = await externalCatalog.getArtist(artistId);
      return artist ? { albums: artist.albums } : sendError(reply, 404, "Artist not found");
    }

    const artist = await catalog.getArtist(artistId);
    if (!artist) {
      return sendError(reply, 404, "Artist not found");
    }

    return { albums: await resolveArtistCatalogAlbums(user, artistId, artist) };
  });

  app.get("/api/artists/:artistId/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { artistId } = request.params as { artistId: string };
    if (artistId.startsWith("external_") || artistId.startsWith("extdetail_")) {
      if (user.role !== "admin" && !user.externalSearchEnabled) {
        return sendError(reply, 403, "External catalog is not available for this user");
      }

      const artist = await externalCatalog.getArtist(artistId);
      return artist ? { tracks: artist.tracks } : sendError(reply, 404, "Artist not found");
    }

    return { tracks: await catalog.getArtistTracks(artistId) };
  });

  app.get("/api/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

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
    return { analysis: silenceAnalysis.getAnalysis(trackId) };
  });

  const silenceAnalysisRequestSchema = z.object({
    thresholdDb: z.number().optional(),
    minSilenceSeconds: z.number().positive().optional(),
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

    const query = request.query as { q?: string; types?: string; mode?: string };
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
    const canSearchExternal = user.role === "admin" || user.externalSearchEnabled;

    if (requestedMode === "external" && !canSearchExternal) {
      return sendError(reply, 403, "External search is not available for this user");
    }

    const mode = canSearchExternal ? requestedMode : "library";
    const result = await searchProviders.search(query.q || "", { types, mode });
    const shouldSearchExternal = canSearchExternal
      && externalCatalog.isEnabled()
      && (mode === "hybrid" || mode === "external")
      && (!types || types.some((type) => type !== "playlist"));

    if (shouldSearchExternal) {
      try {
        const external = await externalCatalog.search(query.q || "", { limit: 12 });
        const groups = deduplicateSearchGroups({
          ...result.groups,
          track: [...result.groups.track, ...external.filter((item) => item.type === "track")],
          album: [...result.groups.album, ...external.filter((item) => item.type === "album")],
          artist: [...result.groups.artist, ...external.filter((item) => item.type === "artist")],
        });
        const legacy = toLegacySearchResponse(result.groups);
        return { ...legacy, results: groups, degraded: result.degraded };
      } catch {
        // Keep library results available when external discovery degrades.
      }
    }

    const legacy = toLegacySearchResponse(result.groups);
    const normalized = deduplicateSearchGroups(result.groups);
    return {
      ...legacy,
      results: normalized,
      degraded: result.degraded,
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
    return { ok: true };
  });

  app.get("/api/recently-played", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    return { tracks: await listRecentlyPlayed(db, catalog, user.id) };
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
    const query = request.query as { source?: string; playableSource?: string };
    const preferredSource = typeof query.source === "string" && query.source ? query.source : undefined;
    const playableSource = typeof query.playableSource === "string" && query.playableSource ? query.playableSource : undefined;

    if (playableSource) {
      if (sourceProviders.isExternalSource(trackId, playableSource)
        && user.role !== "admin"
        && !user.externalPlaybackEnabled) {
        return sendError(reply, 403, "External playback is not available for this user");
      }

      try {
        return await sendProxyResponse(reply, await sourceProviders.fetchStream(trackId, playableSource, request.headers.range));
      } catch {
        return sendError(reply, 502, "Playback unavailable");
      }
    }

    if (!library.exists(trackId)) {
      return sendError(reply, 404, "Track not found");
    }

    try {
      return await sendProxyResponse(reply, await sourceResolver.fetchStream(trackId, request.headers.range, preferredSource));
    } catch (error) {
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
        resolveArtworkSize(size)
      );

      if (!rendered) {
        return sendError(reply, 404, "Artwork not found");
      }

      reply.header("content-type", rendered.contentType);
      reply.header("cache-control", "private, max-age=300");
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
      if (isMusicDeckArtwork) {
        return await sendProxyResponse(reply, await sourceResolver.fetchArtwork(artworkId, thumbnailSize));
      }
      return await sendProxyResponse(
        reply,
        thumbnailSize === undefined
          ? await backend.fetchArtwork(artworkId)
          : await backend.fetchArtwork(artworkId, thumbnailSize)
      );
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        return sendError(reply, 502, "Artwork unavailable");
      }
      throw error;
    }
  });

  app.post("/api/acquisitions", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (user.role !== "admin" && !user.externalPlaybackEnabled) {
      return sendError(reply, 403, "On-demand acquisitions are not enabled for this user");
    }

    if (!acquisition) {
      return sendError(reply, 503, "Acquisition service is not available");
    }

    const body = request.body as any;
    if (!body || (!body.candidate && !body.candidateId && !body.result && !body.trackId && !body.albumId)) {
      return sendError(reply, 400, "Invalid acquisition request payload", "VALIDATION_ERROR");
    }

    try {
      const job = await acquisition.createJob({
        userId: user.id,
        candidate: body.candidate,
        candidateId: body.candidateId,
        result: body.result,
        sourceProvider: body.sourceProvider || body.providerId,
        containerId: body.containerId,
        trackId: body.trackId,
        albumId: body.albumId,
        spotifyTrackUrl: body.spotifyTrackUrl || body.spotifyUrl,
        autoPlay: Boolean(body.autoPlay),
      });

      const statusCode = job.status === "completed" ? 200 : 202;
      return reply.code(statusCode).send({
        jobId: job.id,
        status: job.status,
        job,
      });
    } catch (error) {
      app.log.error(error);
      return sendError(reply, 500, error instanceof Error ? error.message : "Failed to create acquisition job");
    }
  });

  app.get("/api/acquisitions/events", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return sendError(reply, 503, "Acquisition service is not available");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders?.();

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);

    const unsubscribe = acquisition.subscribe((event, payload) => {
      if (user.role !== "admin" && payload.userId && payload.userId !== user.id) {
        return;
      }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    request.raw.on("close", () => {
      unsubscribe();
    });
  });

  app.get("/api/acquisitions", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return { jobs: [] };
    }

    const jobs = acquisition.listJobs(user.id, user.role === "admin");
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
      return sendError(reply, 400, error instanceof Error ? error.message : "Could not retry job");
    }
  });
}
