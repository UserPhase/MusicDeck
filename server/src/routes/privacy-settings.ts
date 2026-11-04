import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { PrivacyBlockedError, PrivacyManager, type PrivacyCategory } from "../services/PrivacyManager.js";

const schema = z.object({ localOnly: z.boolean(), allowMetadata: z.boolean(), allowImports: z.boolean(), allowArtwork: z.boolean() }).strict();
function integrationCategory(path: string, method: string, query: Record<string, unknown>, body: unknown): PrivacyCategory | null {
  if (path === "/api/admin/downloader/diagnostics") return "imports";
  if ((path.startsWith("/api/v1/playlists/import-spotify") && method === "POST") ||
      (path === "/api/acquisitions" && method === "POST") || /^\/api\/acquisitions\/[^/]+\/retry$/.test(path)) return "imports";
  if (path.startsWith("/api/artwork/external/") || path === "/api/metadata/album-artwork") return "artwork";
  if (path.startsWith("/api/discovery/") || path.startsWith("/api/external/") ||
      path.startsWith("/api/metadata/") || path === "/api/playback/preview") return "metadata";
  if (path === "/api/playback/normalize" && body && typeof body === "object" && "previewUrl" in body) return "metadata";
  if (path === "/api/search" && (query.mode === "external" || query.phase === "external")) return "metadata";
  if (/^\/api\/(albums|artists|tracks)\/(external_|extdetail_|deezer_artist_)/.test(path)) return "metadata";
  if (/^\/api\/artists\/[^/]+\/discography$/.test(path)) return "metadata";
  if (/^\/api\/artists\/[^/]+\/portrait\/musicbrainz$/.test(path)) return "artwork";
  if (/^\/api\/admin\/search-providers\/[^/]+\/test$/.test(path)) return "metadata";
  if (/^\/api\/admin\/(source-providers|plugins)\/[^/]+\/test$/.test(path)) return "external";
  return null;
}
export function installPrivacyRequestScope(app: FastifyInstance, manager: PrivacyManager) {
  app.addHook("onRequest", (_request, _reply, done) => manager.run(done));
}
export async function registerPrivacySettingsRoutes(app: FastifyInstance, db: Db, manager: PrivacyManager) {
  app.get("/api/v1/privacy", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    reply.header("Cache-Control", "private, no-store");
    return manager.snapshot();
  });
  app.patch("/api/v1/privacy", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid privacy policy", "VALIDATION_ERROR");
    reply.header("Cache-Control", "private, no-store");
    return manager.update(parsed.data);
  });
  app.addHook("preHandler", async (request, reply) => {
    let path: string;
    try { path = decodeURIComponent(request.url.split("?")[0]); }
    catch (error) {
      if (!(error instanceof URIError)) throw error;
      return sendError(reply, 400, "Malformed request path", "VALIDATION_ERROR");
    }
    const category = integrationCategory(path, request.method, (request.query ?? {}) as Record<string, unknown>, request.body);
    if (!category) return;
    if (!requireUser(db, request, reply)) return reply;
    try { manager.assertExternalAllowed(category); }
    catch (error) {
      if (!(error instanceof PrivacyBlockedError)) throw error;
      return sendError(reply, 403, error.message, error.code);
    }
  });
}
