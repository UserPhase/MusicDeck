import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import type { PlaylistService } from "../domain/playlist-service.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { SimilarMixEngine, SimilarMixError } from "../services/SimilarMixEngine.js";
import { hydrateMissingPreviews, normalizeExternalTrack } from "../services/discovery/externalTrackNormalizer.js";
import { currentPrivacyManager } from "../services/PrivacyManager.js";

const id = z.string().min(1).max(500);
const previewSchema = z.object({ ownerId: id, seedTrackIds: z.array(id).min(1).max(5),
  scope: z.enum(["LIBRARY_ONLY", "DISCOVERY_ONLY", "HYBRID_MIX"]), adventurousness: z.number().min(0).max(1),
  lockedTrackIds: z.array(id).max(25).optional(), excludeTrackIds: z.array(id).max(1000).optional(), shuffleSeed: z.string().min(1).max(100).optional(),
}).strict();
const selectionSchema = z.object({ ownerId: id, previewId: z.string().uuid(), trackIds: z.array(id).min(1).max(25).refine(ids => new Set(ids).size === ids.length) }).strict();

export function registerSimilarMixRoutes(app: FastifyInstance, db: Db, playlists: PlaylistService, fetchImpl?: typeof fetch, previewLookup?: (query: string) => Promise<unknown[]>) {
  const engine = new SimilarMixEngine(db, { fetchImpl, apiKey() {
    const row = db.prepare("SELECT enabled,config_json,permissions_json FROM plugin_configs WHERE plugin_id='lastfm'").get() as
      { enabled: number; config_json: string; permissions_json: string } | undefined;
    if (!row?.enabled) return null;
    try {
      const config: unknown = JSON.parse(row.config_json), permissions: unknown = JSON.parse(row.permissions_json);
      return config && typeof config === "object" && "apiKey" in config && typeof config.apiKey === "string" &&
        Array.isArray(permissions) && permissions.includes("network.request") ? config.apiKey.trim() || null : null;
    } catch { return null; }
  } });
  app.addHook("preClose", () => engine.close());
  const guarded = async <T>(operation: () => T | Promise<T>, reply: import("fastify").FastifyReply) => {
    try { return await operation(); }
    catch (error) { if (error instanceof SimilarMixError) return sendError(reply, error.statusCode, error.message, "SIMILAR_MIX_ERROR"); throw error; }
  };
  app.get("/api/v1/similar-mixes/seeds", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    const parsed = z.object({ q: z.string().trim().min(2).max(300) }).strict().safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Search using at least two characters.");
    reply.header("Cache-Control", "private, no-store");
    return guarded(() => ({ tracks: engine.searchSeeds(parsed.data.q) }), reply);
  });
  app.post("/api/v1/similar-mixes/seeds", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = z.object({ ownerId: id, title: z.string().trim().min(1).max(300), artist: z.string().trim().min(1).max(300) }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Enter a song title and artist.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the mix builder.");
    return guarded(() => ({ track: engine.registerExternalSeed(parsed.data.title, parsed.data.artist) }), reply);
  });
  app.post("/api/v1/similar-mixes/preview", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = previewSchema.safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid similar-mix settings.");
    const { ownerId, ...input } = parsed.data;
    if (ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the mix builder.");
    reply.header("Cache-Control", "private, no-store");
    return guarded(async () => {
      const result = await engine.generate(user.id, input), previewId = randomUUID(), now = Date.now();
      db.transaction(() => {
        db.prepare("DELETE FROM similar_mix_previews WHERE expires_at<=?").run(now);
        db.prepare("INSERT INTO similar_mix_previews(id,user_id,candidate_ids_json,created_at,expires_at) VALUES(?,?,?,?,?)")
          .run(previewId, user.id, JSON.stringify(result.tracks.map(track => track.id)), now, now + 30 * 60_000);
        db.prepare(`DELETE FROM similar_mix_previews WHERE user_id=? AND id NOT IN
          (SELECT id FROM similar_mix_previews WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30)`).run(user.id, user.id);
      })();
      return { ...result, previewId };
    }, reply);
  });
  const selection = (userId: string, previewId: string, ids: string[]) => {
    const row = db.prepare("SELECT candidate_ids_json,expires_at,playlist_id FROM similar_mix_previews WHERE id=? AND user_id=?").get(previewId, userId) as
      { candidate_ids_json: string; expires_at: number; playlist_id: string | null } | undefined;
    if (!row || row.expires_at <= Date.now()) throw new SimilarMixError("This mix preview expired. Refresh it before saving or queueing.", 409);
    const allowed = new Set<string>(JSON.parse(row.candidate_ids_json));
    if (ids.some(id => !allowed.has(id))) throw new SimilarMixError("The selection no longer matches this preview. Refresh the mix.", 409);
    return row;
  };
  const hydrateSelection = async (userId: string, ids: string[]) => {
    const tracks = engine.materialize(userId, ids);
    if (previewLookup) {
      const missing = tracks.filter(track => track.external && !track.previewUrl).filter(track => {
        const row = db.prepare("SELECT preview_checked_at FROM similar_mix_external_tracks WHERE id=?").get(track.id) as { preview_checked_at: number | null } | undefined;
        return !row?.preview_checked_at || Date.now() - row.preview_checked_at > 10 * 60_000;
      }).flatMap(track => { const normalized = normalizeExternalTrack(track); return normalized ? [normalized] : []; });
      if (missing.length) {
        const hydrated = await hydrateMissingPreviews(missing, previewLookup, 3);
        currentPrivacyManager()?.assertExternalAllowed("metadata");
        const update = db.prepare("UPDATE similar_mix_external_tracks SET preview_url=?,preview_checked_at=? WHERE id=?");
        db.transaction(() => { hydrated.forEach(track => update.run(track.previewUrl, Date.now(), track.id)); })();
      }
    }
    // Feedback may change while previews are resolving; recheck before returning or committing.
    return engine.materialize(userId, ids);
  };
  app.post("/api/v1/similar-mixes/selection", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = selectionSchema.safeParse(request.body); if (!parsed.success) return sendError(reply, 400, "Invalid mix selection.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the mix builder.");
    return guarded(async () => { selection(user.id, parsed.data.previewId, parsed.data.trackIds); return { tracks: await hydrateSelection(user.id, parsed.data.trackIds) }; }, reply);
  });
  app.post("/api/v1/similar-mixes/save", async (request, reply) => {
    const user = requireUser(db, request, reply); if (!user) return reply;
    const parsed = selectionSchema.extend({ name: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "A mix name and valid preview are required.");
    if (parsed.data.ownerId !== user.id) return sendError(reply, 409, "The signed-in account changed. Reopen the mix builder.");
    return guarded(async () => {
      const existing = selection(user.id, parsed.data.previewId, parsed.data.trackIds);
      if (!existing.playlist_id) await hydrateSelection(user.id, parsed.data.trackIds);
      return db.transaction(() => {
      const row = selection(user.id, parsed.data.previewId, parsed.data.trackIds);
      if (row.playlist_id) {
        const playlist = db.prepare("SELECT id,name FROM playlists WHERE id=? AND deleted_at IS NULL").get(row.playlist_id);
        if (!playlist) throw new SimilarMixError("The saved playlist is in Trash. Restore it from your collection.", 409);
        return { playlist, alreadySaved: true };
      }
      const tracks = engine.materialize(user.id, parsed.data.trackIds), playlist = playlists.createMix(parsed.data.name, user, tracks);
      db.prepare("UPDATE similar_mix_previews SET playlist_id=? WHERE id=?").run(playlist.id, parsed.data.previewId);
      reply.code(201); return { playlist, alreadySaved: false };
      })();
    }, reply);
  });
  return engine;
}
