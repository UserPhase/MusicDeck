import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { LibraryService } from "../domain/library.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { QueueSyncService, QueueSyncError, queueCheckpointSchema, MAX_QUEUE_CONTENT_BYTES } from "../services/QueueSyncService.js";
const id = z.string().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/), sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const actor = z.object({ ownerId: id }).strict(), name = z.string().trim().min(1).max(200);
export function registerQueueSessionRoutes(app: FastifyInstance, db: Db, library: LibraryService) {
  const service = new QueueSyncService(db, library); let uploads = 0;
  const prune = () => { try { service.prune(); } catch (error) { app.log.warn({ err: error }, "Could not prune queue snapshots"); } };
  prune(); const timer = setInterval(prune, 3600_000); timer.unref(); app.addHook("onClose", async () => clearInterval(timer));
  app.get("/api/v1/user/queue-session", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    reply.header("Cache-Control", "private, no-store"); return { sessions: service.sessions(user.id), namedQueues: service.named(user.id) };
  });
  app.post("/api/v1/user/queue-session/content", { bodyLimit: MAX_QUEUE_CONTENT_BYTES,
    onRequest: async (request, reply) => { if (!requireUser(db, request, reply)) return reply; } }, async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const query = actor.safeParse(request.query); if (!query.success) return sendError(reply, 400, "Account identity is required for queue sync.");
    if (query.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the queue.");
    if (uploads >= 2) return sendError(reply, 429, "Queue sync is busy. The local queue is safe; retry shortly.");
    uploads++; try { return await service.storeContent(user.id, request.body); } finally { uploads--; }
  });
  app.get("/api/v1/user/queue-session/content/:contentId", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const params = z.object({ contentId: hash }).safeParse(request.params); if (!params.success) return sendError(reply, 400, "Invalid queue content ID.");
    reply.header("Cache-Control", "private, no-store"); return service.content(user.id, params.data.contentId);
  });
  app.put("/api/v1/user/queue-session", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ deviceId: id, deviceName: name, contentId: hash, checkpoint: queueCheckpointSchema, sequence }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid queue session checkpoint.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the queue.");
    return service.saveSession(user.id, parsed.data.deviceId, parsed.data.deviceName, parsed.data.contentId, parsed.data.checkpoint, parsed.data.sequence);
  });
  app.delete("/api/v1/user/queue-session", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ deviceId: id }).strict().safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid queue device.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    service.removeSession(user.id, parsed.data.deviceId); return reply.code(204).send();
  });
  app.post("/api/v1/user/queue-session/named", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ name, contentId: hash, checkpoint: queueCheckpointSchema, operationId: id }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid named queue.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    return reply.code(201).send(service.saveNamed(user.id, parsed.data.name, parsed.data.contentId, parsed.data.checkpoint, parsed.data.operationId));
  });
  app.delete("/api/v1/user/queue-session/named/:queueId", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ revision: sequence }).strict().safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid named queue revision.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    service.removeNamed(user.id, (request.params as { queueId: string }).queueId, parsed.data.revision); return reply.code(204).send();
  });
  app.post("/api/v1/user/queue-session/playlist", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ name, contentId: hash, operationId: id }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid queue playlist save.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    return reply.code(201).send(await service.saveAsPlaylist(user.id, parsed.data.name, parsed.data.contentId, parsed.data.operationId));
  });
}
export { QueueSyncError };
