import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization.js";
import type { Db } from "../../db/database.js";
import { ExtensionError, type ExtensionManager } from "../../services/ExtensionManager.js";
import { sendError } from "../../utils/http.js";
import { PrivacyBlockedError } from "../../services/PrivacyManager.js";

const updateSchema = z.object({ enabled: z.boolean() }).strict();
function failure(app: FastifyInstance, reply: FastifyReply, error: unknown) {
  if (error instanceof PrivacyBlockedError) return sendError(reply, 403, error.message, error.code);
  if (error instanceof ExtensionError) return sendError(reply,
    error.code === "EXTENSION_NOT_FOUND" ? 404 : error.code === "EXTENSION_CONFLICT" ? 409 : 500, error.message, error.code);
  app.log.error({ err: error }, "Extension operation failed");
  return sendError(reply, 500, "Extension operation failed. Review server logs.", "EXTENSION_FAILED");
}
export function registerExtensionRoutes(app: FastifyInstance, db: Db, manager: ExtensionManager): void {
  app.get("/api/v1/admin/extensions", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!requireAdmin(db, request, reply)) return reply;
    return manager.list();
  });
  app.post("/api/v1/admin/extensions/discover", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    try { return await manager.discover(); }
    catch (error) { return failure(app, reply, error); }
  });
  app.patch("/api/v1/admin/extensions/:extensionId", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Expected an enabled boolean", "VALIDATION_ERROR");
    try { return { extension: await manager.setEnabled((request.params as { extensionId: string }).extensionId, parsed.data.enabled) }; }
    catch (error) { return failure(app, reply, error); }
  });
  // Fastify's router cannot be mutated after startup; trusted routes use this fixed, admin-only gateway.
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"], url: "/api/v1/admin/extensions/:extensionId/routes/*",
    handler: async (request, reply) => {
      if (!requireAdmin(db, request, reply)) return reply;
      const params = request.params as { extensionId: string; "*": string };
      try { return await manager.dispatch(params.extensionId, request.method, `/${params["*"]}`, request, reply); }
      catch (error) { return failure(app, reply, error); }
    },
  });
}
