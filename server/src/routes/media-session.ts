import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/authorization.js";
import type { Db } from "../db/database.js";
import { mediaCheckpointSchema, ResumableMediaService } from "../services/ResumableMediaService.js";
import { sendError } from "../utils/http.js";
import { PlaylistCollaborationService } from "../services/PlaylistCollaborationService.js";

const identity = z.object({ type: z.enum(["album", "playlist"]), mediaId: z.string().min(1).max(300) }).strict();
const listQuery = identity.partial().refine((value) => Boolean(value.type) === Boolean(value.mediaId),
  { message: "Specify both collection type and ID." });

export async function registerMediaSessionRoutes(app: FastifyInstance, db: Db) {
  const service = new ResumableMediaService(db);
  service.prune();
  const pruneTimer = setInterval(() => service.prune(), 60 * 60_000);
  pruneTimer.unref();
  app.addHook("onClose", async () => { clearInterval(pruneTimer); });
  app.get("/api/v1/user/media-sessions", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, query.error.message);
    reply.header("Cache-Control", "private, no-store");
    if (query.data.type && query.data.mediaId) {
      const item = service.get(user.id, query.data.type, query.data.mediaId);
      return { items: item ? [item] : [] };
    }
    return { items: service.list(user.id) };
  });
  app.post("/api/v1/user/media-sessions", { bodyLimit: 8192 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = mediaCheckpointSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, parsed.error.message);
    const value = parsed.data;
    if (value.type === "playlist" && !new PlaylistCollaborationService(db).access(value.mediaId, user).canRead) return sendError(reply, 404, "Playlist not found.");
    try {
      return { checkpoint: service.save(user.id, value) };
    } catch (error) {
      if (error instanceof RangeError) return sendError(reply, 400, error.message);
      throw error;
    }
  });
  app.delete("/api/v1/user/media-sessions", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = identity.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, parsed.error.message);
    service.remove(user.id, parsed.data.type, parsed.data.mediaId);
    return { ok: true };
  });
}
