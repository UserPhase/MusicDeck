import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import type { SilenceAnalysisService } from "../domain/silence-analysis.js";
import type { SilenceScanService } from "../services/media/silenceScanService.js";
import { ScanParametersConflict } from "../services/media/libraryAnalysisScanService.js";

export const silenceAnalysisRequestSchema = z.object({
  thresholdDb: z.number().min(-100).max(0).optional(),
  minSilenceSeconds: z.number().positive().max(30).optional(),
}).strict();

export async function registerSilenceScanRoutes(app: FastifyInstance, db: Db, scan?: SilenceScanService, analysis?: SilenceAnalysisService) {
  app.get("/api/playback/silence-scan", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    return { scan: scan?.status(user.id) ?? null };
  });
  app.post("/api/playback/silence-scan", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    const parsed = silenceAnalysisRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "Invalid silence analysis settings", "VALIDATION_ERROR");
    if (!scan) return sendError(reply, 503, "Library silence analysis is unavailable");
    try { return reply.code(202).send({ scan: scan.start(user.id, parsed.data) }); }
    catch (error) {
      if (error instanceof ScanParametersConflict) return sendError(reply, 409, error.message);
      throw error;
    }
  });
  app.addHook("onClose", async () => { await Promise.all([scan?.close(), analysis?.close()]); });
}
