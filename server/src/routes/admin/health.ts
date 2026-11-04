import type { FastifyInstance } from "fastify";

import { requireAdmin } from "../../auth/authorization.js";
import type { Db } from "../../db/database.js";
import {
  LibraryHealthScanBusy,
  type LibraryHealthScanService,
} from "../../services/library/libraryHealthScanService.js";
import { sendError } from "../../utils/http.js";

/**
 * Admin Library Health endpoints. Every check and repair runs in the
 * background: POSTs answer immediately with 202 and the client polls
 * `GET /api/admin/library/health/scan` for progress and the final report.
 */
export async function registerAdminHealthRoutes(
  app: FastifyInstance,
  db: Db,
  health: LibraryHealthScanService,
) {
  app.get("/api/admin/library/health/scan", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    return { status: health.status() };
  });

  app.post("/api/admin/library/health/scan", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const { started, status } = health.start();
    return reply.code(202).send({ started, alreadyRunning: !started, status });
  });

  app.post("/api/admin/library/health/repair/artwork", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    // The media server owns artwork, so the repair is a provider rescan. The
    // scheduler never throws and reports when a scan is already in flight.
    const { started, status } = health.requestArtworkRescan();
    return reply.code(202).send({ started, alreadyRunning: !started, status });
  });

  app.post("/api/admin/library/health/repair/prune-orphans", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const current = health.status();
    if (current.state === "running") {
      return sendError(reply, 409, new LibraryHealthScanBusy().message, "HEALTH_SCAN_RUNNING");
    }
    if (!current.report) {
      return sendError(reply, 409, "Run a health check before pruning orphaned tracks.", "HEALTH_REPORT_REQUIRED");
    }
    if (current.report.summary.orphanedTracks === 0) {
      return sendError(reply, 409, "The latest health check found no orphaned tracks to prune.", "NOTHING_TO_PRUNE");
    }
    try {
      // Pruning re-lists the library first and removes only records the fresh
      // listing confirms are gone, so an old report can never cause data loss.
      return reply.code(202).send({ started: true, status: health.startPrune() });
    } catch (error) {
      if (error instanceof LibraryHealthScanBusy) return sendError(reply, 409, error.message, "HEALTH_SCAN_RUNNING");
      throw error;
    }
  });
}
