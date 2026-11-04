import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import { requireUser } from "../auth/authorization.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { PlaylistEditError } from "../domain/playlist-service.js";
import { parseSpotifyPlaylistUrl, PlaylistImportForbiddenError, type SpotifyPlaylistImportService } from "../domain/spotify-playlist-import.js";
import { parseImageDataUrl, MAX_ARTWORK_REQUEST_BYTES } from "../domain/playlist-artwork.js";
import { sendError } from "../utils/http.js";

const createPlaylistSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const updatePlaylistSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
}).refine((updates) => updates.name !== undefined || updates.description !== undefined);

const addTrackSchema = z.object({
  trackId: z.string().min(1),
});

const reorderSchema = z.object({
  trackIds: z.array(z.string().min(1)),
});

const entryIds = z.array(z.string().min(1).max(300)).max(20_000);
const entryReorderSchema = z.object({ itemIds: entryIds, expectedItemIds: entryIds }).strict();
const batchTracksSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), trackIds: entryIds.min(1) }).strict(),
  z.object({ action: z.literal("remove"), itemIds: entryIds.min(1), expectedItemIds: entryIds }).strict(),
]);

const artworkSchema = z.object({
  image: z.string().min(1),
});

const spotifyImportSchema = z.object({ playlistUrl: z.string().max(2048) });

export async function registerPlaylistRoutes(app: FastifyInstance, db: Db, playlists: PlaylistService, spotifyImporter?: SpotifyPlaylistImportService) {
  app.get("/api/playlists", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    return { playlists: await playlists.list(user) };
  });

  app.post("/api/playlists", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const parsed = createPlaylistSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid playlist request");
    }

    const playlist = await playlists.create(parsed.data.name, user, parsed.data.description);
    return reply.code(201).send({ playlist });
  });

  app.post("/api/v1/playlists/import-spotify", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    if (user.role !== "admin" && !user.externalPlaybackEnabled) return sendError(reply, 403, "Downloads are not enabled for this user");
    if (!spotifyImporter) return sendError(reply, 503, "Spotify playlist import is not configured");

    const parsed = spotifyImportSchema.safeParse(request.body);
    if (!parsed.success || !parseSpotifyPlaylistUrl(parsed.data.playlistUrl)) {
      return sendError(reply, 400, "Please enter a valid open.spotify.com/playlist URL");
    }
    try {
      return reply.code(202).send({ job: spotifyImporter.start(parsed.data.playlistUrl, user) });
    } catch (error) {
      if (error instanceof PlaylistImportForbiddenError) return sendError(reply, 403, error.message);
      return sendError(reply, 429, error instanceof Error ? error.message : "Could not queue playlist import");
    }
  });

  app.get("/api/v1/playlists/import-spotify/:jobId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    if (!spotifyImporter) return sendError(reply, 503, "Spotify playlist import is not configured");
    const { jobId } = request.params as { jobId: string };
    const job = spotifyImporter.get(jobId, user.id);
    return job ? { job } : sendError(reply, 404, "Import job not found");
  });

  app.get("/api/playlists/:playlistId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };
    const playlist = await playlists.get(playlistId, user);
    return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
  });

  app.patch("/api/playlists/:playlistId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };
    const parsed = updatePlaylistSchema.safeParse(request.body);

    if (!playlists.canManage(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid playlist update request");
    }

    const playlist = await playlists.update(playlistId, parsed.data);
    return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
  });

  app.delete("/api/playlists/:playlistId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };

    if (!playlists.canManage(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    const removed = await playlists.remove(playlistId);
    return removed ? reply.code(204).send() : sendError(reply, 404, "Playlist not found");
  });

  app.post("/api/playlists/:playlistId/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };
    const parsed = addTrackSchema.safeParse(request.body);

    if (!playlists.canModify(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid playlist track request");
    }

    return await playlists.addTrack(playlistId, parsed.data.trackId, user);
  });

  app.delete("/api/playlists/:playlistId/tracks/:playlistItemId", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId, playlistItemId } = request.params as {
      playlistId: string;
      playlistItemId: string;
    };

    if (!playlists.canModify(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    const removed = await playlists.removeItem(playlistId, playlistItemId);
    return removed ? reply.code(204).send() : sendError(reply, 404, "Playlist not found");
  });

  app.put("/api/playlists/:playlistId/tracks/reorder", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };
    const parsed = reorderSchema.safeParse(request.body);

    if (!playlists.canModify(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid playlist reorder request");
    }

    const playlist = await playlists.reorder(playlistId, parsed.data.trackIds);
    return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
  });

  app.post("/api/v1/playlists/:playlistId/reorder", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { playlistId } = request.params as { playlistId: string };
    if (!playlists.canModify(playlistId, user)) return sendError(reply, 403, "Playlist access denied");
    const parsed = entryReorderSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid playlist entry reorder", "VALIDATION_ERROR");
    try {
      const playlist = await playlists.reorderItems(playlistId, parsed.data.itemIds, parsed.data.expectedItemIds);
      return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
    } catch (error) {
      if (error instanceof PlaylistEditError) return sendError(reply, error.statusCode, error.message, error.statusCode === 409 ? "PLAYLIST_CONFLICT" : "VALIDATION_ERROR");
      throw error;
    }
  });

  app.post("/api/v1/playlists/:playlistId/tracks/batch", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const { playlistId } = request.params as { playlistId: string };
    if (!playlists.canModify(playlistId, user)) return sendError(reply, 403, "Playlist access denied");
    const parsed = batchTracksSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid playlist batch edit", "VALIDATION_ERROR");
    try {
      const playlist = await playlists.editTracks(playlistId, parsed.data, user);
      return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
    } catch (error) {
      if (error instanceof PlaylistEditError) return sendError(reply, error.statusCode, error.message, error.statusCode === 409 ? "PLAYLIST_CONFLICT" : "VALIDATION_ERROR");
      throw error;
    }
  });

  /**
   * Replace the automatic 2x2 collage with custom playlist artwork. The image
   * is uploaded as a validated base64 data URL so no multipart dependency is
   * needed; only the custom artwork is stored, never a generated collage.
   *
   * The route raises its body limit above the image cap because base64
   * inflates the payload; without it the server's default 1 MiB limit would
   * reject valid uploads before validation ever runs.
   */
  app.put(
    "/api/playlists/:playlistId/artwork",
    { bodyLimit: MAX_ARTWORK_REQUEST_BYTES },
    async (request, reply) => {
      const user = requireUser(db, request, reply);
      if (!user) return reply;

      const { playlistId } = request.params as { playlistId: string };

      if (!playlists.canManage(playlistId, user)) {
        return sendError(reply, 403, "Playlist access denied");
      }

      const parsed = artworkSchema.safeParse(request.body);
      const image = parsed.success ? parseImageDataUrl(parsed.data.image) : null;

      if (!image) {
        return sendError(reply, 400, "Invalid playlist artwork upload", "VALIDATION_ERROR");
      }

      if (!playlists.setCustomArtwork(playlistId, image.data, image.contentType)) {
        return sendError(reply, 404, "Playlist not found");
      }

      const playlist = await playlists.get(playlistId, user);
      return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
    }
  );

  /** Remove custom artwork so the playlist falls back to the automatic collage. */
  app.delete("/api/playlists/:playlistId/artwork", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;

    const { playlistId } = request.params as { playlistId: string };

    if (!playlists.canManage(playlistId, user)) {
      return sendError(reply, 403, "Playlist access denied");
    }

    if (!playlists.clearCustomArtwork(playlistId)) {
      return sendError(reply, 404, "Playlist not found");
    }

    const playlist = await playlists.get(playlistId, user);
    return playlist ? { playlist } : sendError(reply, 404, "Playlist not found");
  });
}
