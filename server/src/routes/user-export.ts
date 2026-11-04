import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import { DataExportService, ExportNotFoundError, type ExportKind } from "../services/DataExportService.js";
import { getUserById } from "../users/users.js";
import { sendError } from "../utils/http.js";

const formats = {
  playlists: z.enum(["m3u8", "xspf"]).default("m3u8"),
  history: z.literal("csv").default("csv"),
  favorites: z.literal("json").default("json"),
  settings: z.literal("json").default("json"),
  bundle: z.enum(["zip", "json"]).default("zip"),
};
const contentTypes: Record<string, string> = {
  m3u8: "audio/x-mpegurl; charset=utf-8", xspf: "application/xspf+xml; charset=utf-8",
  csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8", zip: "application/zip",
};

export async function registerUserExportRoutes(app: FastifyInstance, db: Db, service: DataExportService) {
  const active = new Map<string, Set<AbortController>>();
  app.addHook("preClose", async () => {
    for (const controllers of active.values()) for (const controller of controllers) controller.abort();
  });
  function owner(request: FastifyRequest, reply: FastifyReply, admin: boolean): string | null {
    const user = admin ? requireAdmin(db, request, reply) : requireUser(db, request, reply);
    if (!user) return null;
    if (!admin) return user.id;
    const { userId } = request.params as { userId: string };
    if (!getUserById(db, userId)) { sendError(reply, 404, "User not found."); return null; }
    return userId;
  }

  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/users/:userId/export" : "/api/v1/user/export";
    app.get(`${prefix}/summary`, async (request, reply) => {
      const userId = owner(request, reply, admin);
      if (!userId) return reply;
      reply.header("Cache-Control", "private, no-store");
      return service.summary(userId);
    });
    const register = (kind: ExportKind, suffix: string, individual = false) => {
      app.get(`${prefix}/${suffix}`, async (request, reply) => {
        const userId = owner(request, reply, admin);
        if (!userId) return reply;
        const parsed = z.object({ format: formats[kind] }).strict().safeParse(request.query);
        if (!parsed.success) return sendError(reply, 400, "Invalid export format.", "VALIDATION_ERROR");
        const controllers = active.get(userId) ?? new Set<AbortController>();
        const totalActive = [...active.values()].reduce((sum, set) => sum + set.size, 0);
        if (controllers.size >= 2 || totalActive >= 4) {
          reply.header("Retry-After", "10");
          return sendError(reply, 429, "Too many active exports. Wait for a download to finish.", "EXPORT_LIMIT");
        }
        const playlistId = individual ? (request.params as { playlistId: string }).playlistId : undefined;
        const controller = new AbortController();
        let stream;
        try {
          stream = service.stream(userId, kind, parsed.data.format, playlistId, controller.signal);
        } catch (error) {
          if (error instanceof ExportNotFoundError) return sendError(reply, 404, error.message);
          throw error;
        }
        controllers.add(controller);
        active.set(userId, controllers);
        const abortStream = () => stream.destroy();
        controller.signal.addEventListener("abort", abortStream, { once: true });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          controllers.delete(controller);
          if (!controllers.size) active.delete(userId);
          request.raw.off("aborted", closed);
          reply.raw.off("close", closed);
          reply.raw.off("finish", cleanup);
          controller.signal.removeEventListener("abort", abortStream);
        };
        const closed = () => {
          controller.abort();
          stream.destroy();
          cleanup();
        };
        request.raw.once("aborted", closed);
        reply.raw.once("close", closed);
        reply.raw.once("finish", cleanup);
        stream.once("error", (error) => {
          if (!controller.signal.aborted) app.log.error({ err: error }, "User data export failed");
          controller.abort();
          cleanup();
        });
        const extension = kind === "playlists" && !individual ? "zip" : parsed.data.format;
        const idPart = playlistId ? `-${playlistId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}` : "";
        reply.header("Cache-Control", "private, no-store");
        reply.header("Content-Type", contentTypes[extension]);
        reply.header("Content-Disposition", `attachment; filename="musicdeck-${kind}${idPart}-${new Date().toISOString().slice(0, 10)}.${extension}"`);
        return reply.send(stream);
      });
    };
    register("playlists", "playlists");
    register("playlists", "playlists/:playlistId", true);
    register("history", "history");
    register("favorites", "favorites");
    register("settings", "settings");
    register("bundle", "bundle");
  }
}
