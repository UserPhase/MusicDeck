import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { ArtistFollowService, followArtistInput, ReleaseLookupError } from "../services/ArtistFollowService.js";
import type { TaskManager } from "../services/TaskManager.js";
import { enqueueReleaseScan } from "../tasks/runners/newReleaseScannerRunner.js";
import type { PrivacyManager } from "../services/PrivacyManager.js";
import type { CatalogService } from "../domain/catalog.js";

export function registerArtistFollowRoutes(app: FastifyInstance, db: Db, service: ArtistFollowService,
  tasks: TaskManager, privacy: PrivacyManager, catalog: CatalogService): void {
  const bodySchema = followArtistInput.extend({ ownerId: z.string().min(1).max(500) }).strict();
  const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(60).default(30) }).strict();
  app.get("/api/v1/artist-follows", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    reply.header("Cache-Control", "private, no-store"); return { artists: service.list(user.id) };
  });
  app.get("/api/v1/new-releases", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid release page.");
    reply.header("Cache-Control", "private, no-store");
    return { ...service.feed(user.id, parsed.data.offset, parsed.data.limit), artists: service.list(user.id) };
  });
  app.post("/api/v1/artist-follows", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Choose an artist with a valid name and provider ID.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed. Reopen this page.");
    if (user.role !== "admin" && !user.externalSearchEnabled) return sendError(reply, 403, "External discovery is not enabled for this account.");
    privacy.assertExternalAllowed("metadata");
    try {
      const { ownerId: _ownerId, ...input } = parsed.data;
      if (input.provider === "library") {
        const artist = await catalog.getArtist(input.artistId);
        if (!artist) return sendError(reply, 404, "Library artist not found.");
        input.artistName = artist.name;
      }
      const artist = service.follow(user.id, input);
      const taskId = enqueueReleaseScan(tasks);
      return reply.code(201).send({ artist, taskId });
    } catch (error) {
      if (error instanceof ReleaseLookupError) return sendError(reply, 400, error.message);
      throw error;
    }
  });
  app.delete("/api/v1/artist-follows/:key", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ ownerId: z.string().min(1).max(500) }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Account identity is required.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed. Reopen this page.");
    service.unfollow(user.id, (request.params as { key: string }).key);
    return reply.code(204).send();
  });
  app.post("/api/v1/new-releases/scan", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    privacy.assertExternalAllowed("metadata");
    return reply.code(202).send({ taskId: enqueueReleaseScan(tasks) });
  });
}
