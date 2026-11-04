import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import { requireAdmin } from "../auth/authorization.js";
import { SessionStreamGuard } from "../auth/session-stream.js";
import { sendError } from "../utils/http.js";
import { SseEventWriter } from "../utils/sse.js";
import { LOG_LEVELS, type LogBuffer, type LogEntry, serverLogs } from "../utils/logger.js";

export const MAX_LOG_STREAMS = 10;
const STREAM_BATCH_MS = 100;
const STREAM_BATCH_MAX = 200;
const HEARTBEAT_MS = 25_000;

const listQuerySchema = z.object({
  level: z.enum(LOG_LEVELS as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  after: z.coerce.number().int().min(0).optional(),
});

const streamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

export async function registerAdminLogsRoutes(app: FastifyInstance, db: Db, logs: LogBuffer = serverLogs) {
  let openStreams = 0;
  const streamCleanups = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const cleanup of streamCleanups) cleanup();
  });

  app.get("/api/admin/logs", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "level must be error, warn, info or debug and limit 1-1000", "VALIDATION_ERROR");
    }
    const { level, limit = 200, after } = parsed.data;
    return {
      entries: logs.list({ level: level as LogEntry["level"] | undefined, limit, after }),
      stats: logs.stats(),
    };
  });

  app.delete("/api/admin/logs", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;

    logs.clear();
    request.log.info({ adminId: admin.id }, "server log buffer cleared");
    return reply.code(204).send();
  });

  app.get("/api/admin/logs/stream", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;

    const parsed = streamQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "after must be a log sequence number", "VALIDATION_ERROR");
    if (openStreams >= MAX_LOG_STREAMS) {
      return sendError(reply, 429, "Too many open log streams", "TOO_MANY_STREAMS");
    }

    // EventSource reconnects send Last-Event-ID; replay what the client missed.
    const lastEventId = Number(request.headers["last-event-id"]);
    const after = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : parsed.data.after;

    openStreams += 1;
    let writer: SseEventWriter | undefined;
    let guard: SessionStreamGuard | undefined;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let pending: LogEntry[] = [];
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      openStreams -= 1;
      guard?.close();
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      pending = [];
      streamCleanups.delete(cleanup);
      request.raw.removeListener("aborted", cleanup);
      reply.raw.removeListener("close", cleanup);
      reply.raw.removeListener("error", cleanup);
      reply.raw.removeListener("finish", cleanup);
      writer?.close();
    };
    streamCleanups.add(cleanup);
    request.raw.once("aborted", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.once("finish", cleanup);
    try {
      guard = new SessionStreamGuard(db, request, true, cleanup, (error) => app.log.error(error));
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform keeps compression middleware (CRA dev proxy) from
        // buffering the stream; X-Accel-Buffering does the same for nginx.
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      writer = new SseEventWriter(reply.raw, undefined, undefined, () => Boolean(guard?.currentUser()));
      guard.start();
      writer.push("ready", { stats: logs.stats() });

      pending = after === undefined ? [] : logs.list({ after });
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        if (!guard?.currentUser()) return;
        // Batches stay well under the writer's pending-frame cap, so a log burst
        // never trips its slow-client disconnect.
        while (pending.length) {
          const batch = pending.slice(0, STREAM_BATCH_MAX);
          pending = pending.slice(STREAM_BATCH_MAX);
          writer?.push("logs", { entries: batch }, batch[batch.length - 1].id);
        }
      };
      if (pending.length) flush();

      if (cleanedUp) return;
      unsubscribe = logs.subscribe(
        (entry) => {
          pending.push(entry);
          if (pending.length >= STREAM_BATCH_MAX) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, STREAM_BATCH_MS);
        },
        () => {
          pending = [];
          writer?.push("cleared", {});
        },
      );
      heartbeat = setInterval(() => writer?.push("ping", { at: Date.now() }), HEARTBEAT_MS);
      heartbeat.unref?.();
    } catch (error) {
      cleanup();
      app.log.error(error);
      reply.raw.destroy();
    }
  });
}
