import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { CatalogService } from "../domain/catalog.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import { listeningHistory, listeningStatistics, listeningThreshold } from "../domain/listening-activity.js";

const period = z.enum(["7", "30", "90", "year", "all"]).default("all");
const cursorSchema = z.object({ at: z.string().datetime(), id: z.string().min(1).max(200) });

export async function registerListeningActivityRoutes(app: FastifyInstance, db: Db, catalog: CatalogService) {
  app.get("/api/listening-activity/config", async (request, reply) => {
    if (!requireUser(db, request, reply)) return reply;
    return { thresholdSeconds: listeningThreshold(db) };
  });
  app.get("/api/listening-activity/history", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = z.object({ period, search: z.string().max(200).default(""),
      limit: z.coerce.number().int().min(1).max(50).default(30),
      cursor: z.string().max(600).optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid history query", "VALIDATION_ERROR");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (parsed.data.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(parsed.data.cursor, "base64url").toString()));
      } catch {
        return sendError(reply, 400, "Invalid history cursor", "VALIDATION_ERROR");
      }
    }
    return listeningHistory(db, catalog, user.id, { ...parsed.data, cursor });
  });
  app.get("/api/listening-activity/statistics", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return reply;
    const parsed = z.object({ period }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid statistics period", "VALIDATION_ERROR");
    return listeningStatistics(db, user.id, parsed.data.period);
  });
}
