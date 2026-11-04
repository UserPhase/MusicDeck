import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/authorization.js";
import type { Db } from "../db/database.js";
import type { SmartPlaylistEvaluator } from "../services/SmartPlaylistEvaluator.js";
import { InvalidSmartPlaylistRule, parseSmartPlaylistRule, mixOptionsSchema, type MixOptions } from "../types/smart-playlist.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { createId } from "../utils/ids.js";
import { sendError } from "../utils/http.js";

const bodySchema = z.object({ name: z.string().trim().min(1).max(200), rules: z.unknown(), options: mixOptionsSchema.optional() }).strict();
const previewSchema = z.object({
  rules: z.unknown(), limit: z.number().int().min(1).max(500).default(12),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  options: mixOptionsSchema.optional(),
}).strict();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
type Row = { id: string; name: string; rules_json: string; options_json: string | null; created_at: string; updated_at: string };
const optionsFor = (row: Row): MixOptions | undefined => row.options_json ? mixOptionsSchema.parse(JSON.parse(row.options_json)) : undefined;
const serialize = (row: Row) => ({
  id: row.id, name: row.name, rules: parseSmartPlaylistRule(JSON.parse(row.rules_json)),
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.options_json ? { options: optionsFor(row) } : {}),
});

export async function registerSmartPlaylistRoutes(app: FastifyInstance, db: Db, evaluator: SmartPlaylistEvaluator, playlists?: PlaylistService) {
  const owned = (id: string, userId: string) => db.prepare("SELECT * FROM smart_playlists WHERE id=? AND user_id=?")
    .get(id, userId) as Row | undefined;
  app.get("/api/v1/smart-playlists/seeds", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    const parsed = z.object({ q: z.string().max(300).default(""), id: z.string().min(1).max(500).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid song search", "VALIDATION_ERROR");
    reply.header("cache-control", "private, no-store");
    return { tracks: evaluator.findSeeds(parsed.data.q, parsed.data.id) };
  });
  app.get("/api/v1/smart-playlists", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    reply.header("cache-control", "private, no-store");
    const rows = db.prepare("SELECT * FROM smart_playlists WHERE user_id=? ORDER BY updated_at DESC,id").all(user.id) as Row[];
    return { playlists: rows.map(serialize) };
  });
  app.post("/api/v1/smart-playlists/preview", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid preview request", "VALIDATION_ERROR");
    try {
      reply.header("cache-control", "private, no-store");
      return evaluator.evaluate(user.id, parsed.data.rules, { ...parsed.data, mix: parsed.data.options });
    } catch (error) {
      if (error instanceof InvalidSmartPlaylistRule) return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      throw error;
    }
  });
  app.post("/api/v1/smart-playlists/snapshot", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = bodySchema.extend({ options: mixOptionsSchema, selectionToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "A mix name and valid settings are required", "VALIDATION_ERROR");
    if (!playlists) return sendError(reply, 503, "Playlist saving is unavailable");
    try {
      const result = evaluator.evaluate(user.id, parsed.data.rules, { limit: 200, mix: parsed.data.options });
      if (!result.refreshedAt) return sendError(reply, 503, "Your library is still loading. Try again shortly.");
      if (!result.tracks.length) return sendError(reply, 400, "No songs match this mix yet.", "VALIDATION_ERROR");
      if (parsed.data.selectionToken && parsed.data.selectionToken !== result.selectionToken) return sendError(reply, 409,
        "Your library changed. Refresh the mix before saving so its tracklist matches your preview.", "MIX_CHANGED");
      return reply.code(201).send({ playlist: playlists.createMix(parsed.data.name, user, result.tracks), kind: "playlist" });
    } catch (error) {
      if (error instanceof InvalidSmartPlaylistRule) return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      throw error;
    }
  });
  app.post("/api/v1/smart-playlists", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "A playlist name and rules are required", "VALIDATION_ERROR");
    try {
      const rules = parseSmartPlaylistRule(parsed.data.rules);
      const id = createId("smart");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO smart_playlists (id,user_id,name,rules_json,created_at,updated_at,options_json) VALUES (?,?,?,?,?,?,?)")
        .run(id, user.id, parsed.data.name, JSON.stringify(rules), now, now, parsed.data.options ? JSON.stringify(parsed.data.options) : null);
      return reply.code(201).send({ playlist: serialize(owned(id, user.id)!) });
    } catch (error) {
      if (error instanceof InvalidSmartPlaylistRule) return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      throw error;
    }
  });
  app.get("/api/v1/smart-playlists/:id", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const row = owned((request.params as { id: string }).id, user.id);
    return row ? { playlist: serialize(row) } : sendError(reply, 404, "Smart playlist not found");
  });
  app.put("/api/v1/smart-playlists/:id", { bodyLimit: 65_536 }, async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const existing = owned(id, user.id);
    if (!existing) return sendError(reply, 404, "Smart playlist not found");
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "A playlist name and rules are required", "VALIDATION_ERROR");
    try {
      const rules = parseSmartPlaylistRule(parsed.data.rules);
      db.prepare("UPDATE smart_playlists SET name=?,rules_json=?,updated_at=?,options_json=? WHERE id=? AND user_id=?")
        .run(parsed.data.name, JSON.stringify(rules), new Date().toISOString(), parsed.data.options ? JSON.stringify(parsed.data.options) : existing.options_json, id, user.id);
      return { playlist: serialize(owned(id, user.id)!) };
    } catch (error) {
      if (error instanceof InvalidSmartPlaylistRule) return sendError(reply, 400, error.message, "VALIDATION_ERROR");
      throw error;
    }
  });
  app.delete("/api/v1/smart-playlists/:id", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const result = db.prepare("DELETE FROM smart_playlists WHERE id=? AND user_id=?")
      .run((request.params as { id: string }).id, user.id);
    return result.changes ? reply.code(204).send() : sendError(reply, 404, "Smart playlist not found");
  });
  app.get("/api/v1/smart-playlists/:id/tracks", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const row = owned((request.params as { id: string }).id, user.id);
    if (!row) return sendError(reply, 404, "Smart playlist not found");
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid result window", "VALIDATION_ERROR");
    reply.header("cache-control", "private, no-store");
    return evaluator.evaluate(user.id, JSON.parse(row.rules_json), { ...parsed.data, mix: optionsFor(row) });
  });
}
