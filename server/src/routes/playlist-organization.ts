import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import type { Db } from "../db/database.js";
import type { LibraryService } from "../domain/library.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { PlaylistOrganizationError, PlaylistOrganizationService } from "../domain/playlist-organization.js";

const id = z.string().min(1).max(300), revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).max(20_000), name = z.string().trim().min(1).max(200).refine(value => !value.includes("\0"));
const position = z.number().int().min(0).max(100_000);
const edit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reorder"), itemIds: ids, expectedItemIds: ids }).strict(),
  z.object({ kind: z.literal("remove"), itemIds: ids.min(1), expectedItemIds: ids.optional() }).strict(),
  z.object({ kind: z.literal("add"), trackIds: ids.min(1) }).strict(),
  z.object({ kind: z.literal("details"), name: name.optional(), description: z.string().max(1000).nullable().optional() }).strict().refine(value => value.name !== undefined || value.description !== undefined),
  z.object({ kind: z.literal("trash") }).strict(), z.object({ kind: z.literal("restore") }).strict(),
]);
const organization = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("createFolder"), name, parentId: id.nullable() }).strict(),
  z.object({ kind: z.literal("folder"), id, name: name.optional(), parentId: id.nullable().optional(), pinned: z.boolean().optional(), position: position.optional() }).strict(),
  z.object({ kind: z.literal("deleteFolder"), id }).strict(),
  z.object({ kind: z.literal("playlist"), id, folderId: id.nullable().optional(), pinned: z.boolean().optional(), position: position.optional() }).strict(),
  z.object({ kind: z.literal("pinOrder"), id, position }).strict(),
]);

export async function registerPlaylistOrganizationRoutes(app: FastifyInstance, db: Db, library: LibraryService, playlists: PlaylistService) {
  const service = new PlaylistOrganizationService(db, library);
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const purge = () => {
    if (stopped) return;
    let delay = 60 * 60 * 1000;
    try { if (service.purgeExpired() === 100) delay = 25; }
    catch (error) { app.log.warn({ err: error }, "Could not purge expired playlist Trash"); delay = 60_000; }
    timer = setTimeout(purge, delay); timer.unref();
  };
  app.addHook("onReady", async () => { timer = setTimeout(purge, 0); timer.unref(); });
  app.addHook("preClose", async () => { stopped = true; if (timer) clearTimeout(timer); });
  const handle = <T>(work: () => T, reply: FastifyReply): T | null => {
    try { return work(); } catch (error) {
      if (error instanceof PlaylistOrganizationError) { sendError(reply, error.statusCode, error.message, error.statusCode === 409 ? "PLAYLIST_CONFLICT" : "PLAYLIST_ORGANIZATION_ERROR"); return null; }
      throw error;
    }
  };
  app.get("/api/v1/playlist-organization", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    return handle(() => service.tree(user), reply) ?? reply;
  });
  app.post("/api/v1/playlist-organization", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ ownerId: id, revision, operation: organization }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid folder or playlist placement.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reload before editing.");
    return handle(() => service.organize(user, parsed.data.revision, parsed.data.operation), reply) ?? reply;
  });
  app.get("/api/v1/playlists/trash", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    return { playlists: service.trash(user), retentionDays: 30 };
  });
  app.get("/api/v1/playlists/:playlistId/edit-state", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    return handle(() => service.state(user, (request.params as { playlistId: string }).playlistId), reply) ?? reply;
  });
  app.post("/api/v1/playlists/:playlistId/commands", { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ ownerId: id, revision, edit }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid playlist command.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reload before editing.");
    const playlistId = (request.params as { playlistId: string }).playlistId;
    const result = handle(() => service.execute(user, playlistId, parsed.data.revision, parsed.data.edit), reply);
    if (!result) return reply;
    void playlists.synchronize(playlistId).catch(error => app.log.warn({ err: error }, "Playlist sync failed; local command is saved"));
    return { ...result, playlist: await playlists.get(playlistId, user) };
  });
  app.post("/api/v1/playlist-commands/:commandId/:direction", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ ownerId: id, revision }).strict().safeParse(request.body);
    const params = z.object({ commandId: id, direction: z.enum(["undo", "redo"]) }).safeParse(request.params);
    if (!parsed.success || !params.success) return sendError(reply, 400, "Invalid undo or redo request.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reload before editing.");
    const result = handle(() => service.reverse(user, params.data.commandId, parsed.data.revision, params.data.direction), reply);
    if (!result) return reply;
    void playlists.synchronize(result.command.playlistId).catch(error => app.log.warn({ err: error }, "Playlist sync failed; local undo is saved"));
    return { ...result, playlist: await playlists.get(result.command.playlistId, user) };
  });
}
