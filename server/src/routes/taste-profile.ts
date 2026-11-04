import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { tasteProfile, TasteProfileError } from "../services/TasteProfileManager.js";
import type { RecommendationService } from "../domain/recommendations.js";
import { playlistReadPredicate, playlistViewer } from "../services/PlaylistCollaborationService.js";
const id = z.string().min(1).max(500), revision = z.number().int().nonnegative();
export function registerTasteProfileRoutes(app: FastifyInstance, db: Db, recommendations: RecommendationService) {
  const service = tasteProfile(db);
  app.get("/api/v1/taste-profile/state", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    reply.header("Cache-Control", "private, no-store"); return { ...service.state(user.id),
      excludedPlaylistIds: (db.prepare(`SELECT id FROM playlists p WHERE exclude_from_taste=1 AND ${playlistReadPredicate()}`).all(playlistViewer(user)) as { id: string }[]).map(row => row.id),
      excludedTrackIds: (db.prepare("SELECT track_id AS id FROM taste_track_exclusions WHERE user_id=?").all(user.id) as { id: string }[]).map(row => row.id) };
  });
  app.get("/api/v1/taste-profile", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    reply.header("Cache-Control", "private, no-store"); return service.overview(user.id);
  });
  const mutations = {
    private: z.object({ ownerId: id, enabled: z.boolean(), revision }).strict(),
    playlist: z.object({ ownerId: id, playlistId: id, excluded: z.boolean() }).strict(),
    track: z.object({ ownerId: id, trackId: id, excluded: z.boolean(), title: z.string().max(500).optional(), artist: z.string().max(500).optional() }).strict(),
    restore: z.object({ ownerId: id, type: z.enum(["track", "artist", "album"]), id }).strict(),
    reset: z.object({ ownerId: id, revision, confirmation: z.literal("RESET") }).strict(),
  };
  for (const [action, schema] of Object.entries(mutations)) app.post(`/api/v1/taste-profile/${action}`, async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid taste preference request.");
    const body = parsed.data as Record<string, any>;
    if (body.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen taste settings.");
    try {
      if (action === "private") service.setPrivate(user.id, body.enabled, body.revision);
      else if (action === "playlist") service.setPlaylist(user, body.playlistId, body.excluded);
      else if (action === "track") service.setTrack(user.id, { id: body.trackId, title: body.title, artist: body.artist }, body.excluded);
      else if (action === "restore") service.restore(user.id, body.type, body.id);
      else service.reset(user.id, body.revision);
      recommendations.invalidateListeningTaste(user.id);
      reply.header("Cache-Control", "private, no-store"); return service.overview(user.id);
    } catch (error) {
      if (error instanceof TasteProfileError) return sendError(reply, error.statusCode, error.message, "TASTE_PROFILE_ERROR");
      throw error;
    }
  });
}
