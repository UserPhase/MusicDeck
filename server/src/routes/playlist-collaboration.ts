import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { CatalogService } from "../domain/catalog.js";
import type { LibraryService } from "../domain/library.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { PlaylistOrganizationService } from "../domain/playlist-organization.js";
import { requireUser } from "../auth/authorization.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import { PlaylistCollaborationService } from "../services/PlaylistCollaborationService.js";
import { sendError } from "../utils/http.js";

const id = z.string().min(1).max(300), revision = z.number().int().nonnegative();
const actor = z.object({ ownerId: id }).strict();
const grant = z.object({ userId: id, role: z.enum(["VIEWER", "COLLABORATOR"]) }).strict();
const share = actor.extend({ revision, mode: z.enum(["PRIVATE", "SHARED_READ", "COLLABORATIVE", "PUBLIC_SERVER"]), grants: z.array(grant).max(100) }).strict();
const device = z.string().uuid();
const host = actor.extend({ deviceId: device }).strict();
const edit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), trackIds: z.array(id).min(1).max(20_000) }).strict(),
  z.object({ kind: z.literal("remove"), itemIds: z.array(id).min(1).max(20_000), expectedItemIds: z.array(id).max(20_000) }).strict(),
  z.object({ kind: z.literal("reorder"), itemIds: z.array(id).max(20_000), expectedItemIds: z.array(id).max(20_000) }).strict(),
]);
export function registerPlaylistCollaborationRoutes(app: FastifyInstance, db: Db, playlists: PlaylistService, catalog: CatalogService, library: LibraryService) {
  const service = new PlaylistCollaborationService(db), organization = new PlaylistOrganizationService(db, library);
  service.prune(); const timer = setInterval(() => { try { service.prune(); } catch (error) { app.log.warn({ err: error }, "Could not prune expired playlist invitations and parties"); } }, 3600_000);
  timer.unref(); app.addHook("onClose", async () => clearInterval(timer));
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/playlist") || request.url.startsWith("/api/playlists")) reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  app.get("/api/v1/playlists/:playlistId/sharing", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    return service.snapshot((request.params as { playlistId: string }).playlistId, user);
  });
  app.get("/api/v1/playlists/:playlistId/access-state", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const playlistId = (request.params as { playlistId: string }).playlistId;
    service.require(playlistId, user, "canRead");
    const row = db.prepare("SELECT edit_revision AS editRevision,sharing_revision AS sharingRevision,sharing_mode AS sharingMode FROM playlists WHERE id=?").get(playlistId);
    return { ...row as object, permissions: service.access(playlistId, user) };
  });
  app.get("/api/v1/playlists/:playlistId/sharing/users", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const query = z.object({ q: z.string().max(100).default("") }).strict().safeParse(request.query);
    if (!query.success) return sendError(reply, 400, "Invalid household member search.");
    return { users: service.users((request.params as { playlistId: string }).playlistId, user, query.data.q) };
  });
  app.put("/api/v1/playlists/:playlistId/sharing", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = share.safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid sharing settings.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen sharing settings.");
    return service.update((request.params as { playlistId: string }).playlistId, user, parsed.data.revision, parsed.data.mode, parsed.data.grants);
  });
  app.post("/api/v1/playlists/:playlistId/sharing/links", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ recipientUserId: id.nullable() }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Choose a valid link recipient.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    return reply.code(201).send(service.createLink((request.params as { playlistId: string }).playlistId, user, parsed.data.recipientUserId));
  });
  app.delete("/api/v1/playlists/:playlistId/sharing/links/:linkId", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Account identity is required.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    const params = request.params as { playlistId: string; linkId: string };
    service.revokeLink(params.playlistId, user, params.linkId); return reply.code(204).send();
  });
  app.post("/api/v1/playlist-shares/resolve", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid playlist invitation.");
    return { playlistId: service.resolveLink(user, parsed.data.token) };
  });
  app.put("/api/v1/playlists/:playlistId/tracks", { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const playlistId = (request.params as { playlistId: string }).playlistId;
    service.require(playlistId, user, "canEditTracks");
    const parsed = actor.extend({ revision, edit }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid collaborative track edit.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    const result = organization.execute(user, playlistId, parsed.data.revision, parsed.data.edit);
    void playlists.synchronize(playlistId).catch(error => app.log.warn({ err: error }, "Collaborative edit saved; provider synchronization failed"));
    return { ...result, playlist: await playlists.get(playlistId, user) };
  });
  app.get("/api/v1/playlists/:playlistId/party", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ deviceId: device }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Valid player identity is required.");
    const playlistId = (request.params as { playlistId: string }).playlistId;
    const state = service.partyState(playlistId, user, request.cookies[SESSION_COOKIE]!, parsed.data.deviceId);
    const requests = state.requests as { id: string; trackId: string; requestedBy: string | null }[];
    const tracks = new Map<string, Awaited<ReturnType<typeof catalog.getTrack>>>(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, requests.length) }, async () => {
      while (next < requests.length) { const row = requests[next++]; if (!tracks.has(row.trackId)) tracks.set(row.trackId, await catalog.getTrack(row.trackId).catch(() => null)); }
    }));
    service.require(playlistId, user, "canEditTracks");
    return { party: state.party, requests: requests.map(row => ({ ...row, track: tracks.get(row.trackId) ?? null })) };
  });
  app.post("/api/v1/playlists/:playlistId/party", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = host.safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid party player identity.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    return reply.code(201).send(service.startParty((request.params as { playlistId: string }).playlistId, user, request.cookies[SESSION_COOKIE]!, parsed.data.deviceId));
  });
  app.post("/api/v1/playlists/:playlistId/party/requests", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = actor.extend({ trackId: id, idempotencyKey: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid party track request.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    return reply.code(201).send(service.requestTrack((request.params as { playlistId: string }).playlistId, user, parsed.data.trackId, parsed.data.idempotencyKey));
  });
  app.post("/api/v1/playlists/:playlistId/party/control", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = host.extend({ action: z.enum(["heartbeat", "close", "QUEUED", "DISMISSED"]), requestId: id.optional() }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid party action.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "Your signed-in account changed.");
    service.hostAction((request.params as { playlistId: string }).playlistId, user, request.cookies[SESSION_COOKIE]!, parsed.data.deviceId, parsed.data.action, parsed.data.requestId);
    return { ok: true };
  });
}
