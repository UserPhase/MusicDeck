import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization.js";
import { SessionStreamGuard } from "../../auth/session-stream.js";
import type { Db } from "../../db/database.js";
import {
  TASK_TYPES,
  TaskConflictError,
  TaskNotFoundError,
  TaskValidationError,
  type ManagedTask,
  type TaskManager,
  type TaskType,
} from "../../services/TaskManager.js";
import { sendError } from "../../utils/http.js";
import { SseConnectionLimiter, SseEventWriter } from "../../utils/sse.js";

const taskCreateSchema = z.object({
  type: z.enum(TASK_TYPES),
  payload: z.unknown().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
}).strict();

const prioritySchema = z.object({ priority: z.number().int().min(0).max(1000) }).strict();
const scheduleSchema = z.object({
  type: z.enum(TASK_TYPES),
  payload: z.unknown().optional(),
  expression: z.string().min(1).max(128),
}).strict();
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  includeTerminal: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
}).strict();

const MAX_TASK_STREAMS_PER_ADMIN = 3;
const MAX_TASK_STREAMS = 20;
const HEARTBEAT_MS = 25_000;

function publicTask(task: ManagedTask) {
  const { payload: _payload, ...safe } = task;
  return safe;
}

function sendTaskError(reply: Parameters<typeof sendError>[0], error: unknown) {
  if (error instanceof TaskNotFoundError) return sendError(reply, 404, error.message, "TASK_NOT_FOUND");
  if (error instanceof TaskValidationError) return sendError(reply, 400, error.message, "VALIDATION_ERROR");
  if (error instanceof TaskConflictError) return sendError(reply, 409, error.message, "TASK_CONFLICT");
  throw error;
}

export async function registerAdminTaskRoutes(
  app: FastifyInstance,
  db: Db,
  tasks: TaskManager,
): Promise<void> {
  const streams = new SseConnectionLimiter(MAX_TASK_STREAMS_PER_ADMIN, MAX_TASK_STREAMS);
  const cleanupStreams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const cleanup of cleanupStreams) cleanup();
  });

  app.get("/api/v1/admin/tasks", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "Invalid task list options", "VALIDATION_ERROR");
    try {
      return { tasks: tasks.list(parsed.data).map(publicTask) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.delete("/api/v1/admin/tasks/history", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    return { ids: tasks.clearHistory() };
  });

  app.get("/api/v1/admin/tasks/:taskId/logs", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    try {
      return { entries: tasks.diagnostics((request.params as { taskId: string }).taskId) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.post("/api/v1/admin/tasks", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;
    const parsed = taskCreateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid task request", "VALIDATION_ERROR");
    try {
      const task = tasks.enqueue(
        parsed.data.type,
        parsed.data.payload ?? {},
        admin.id,
        parsed.data.priority,
      );
      return reply.code(202).send({ task: publicTask(task) });
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.post("/api/v1/admin/tasks/:taskId/pause", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    try {
      const task = tasks.pause((request.params as { taskId: string }).taskId);
      return { task: publicTask(task) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.post("/api/v1/admin/tasks/:taskId/resume", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    try {
      const task = tasks.resume((request.params as { taskId: string }).taskId);
      return { task: publicTask(task) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.post("/api/v1/admin/tasks/:taskId/cancel", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    try {
      const task = await tasks.cancel((request.params as { taskId: string }).taskId);
      return { task: publicTask(task) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.patch("/api/v1/admin/tasks/:taskId/priority", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const parsed = prioritySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Priority must be an integer from 0 to 1000", "VALIDATION_ERROR");
    try {
      const task = tasks.reprioritize((request.params as { taskId: string }).taskId, parsed.data.priority);
      return { task: publicTask(task) };
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.get("/api/v1/admin/tasks/schedules", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    return { schedules: tasks.listSchedules() };
  });

  app.put("/api/v1/admin/tasks/schedules", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid task schedule", "VALIDATION_ERROR");
    try {
      const schedule = tasks.setSchedule(
        parsed.data.type as TaskType,
        parsed.data.payload ?? {},
        parsed.data.expression,
        admin.id,
      );
      return reply.code(201).send({ schedule });
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });

  app.delete("/api/v1/admin/tasks/schedules/:type", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const type = (request.params as { type: string }).type;
    if (!(TASK_TYPES as readonly string[]).includes(type)) {
      return sendError(reply, 400, "Unknown task type", "VALIDATION_ERROR");
    }
    tasks.removeSchedule(type as TaskType);
    return reply.code(204).send();
  });

  for (const path of ["/api/v1/admin/tasks/events", "/api/v1/admin/tasks/stream"]) app.get(path, async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;
    const release = streams.reserve(admin.id);
    if (!release) return sendError(reply, 429, "Too many open task event streams", "TOO_MANY_STREAMS");

    let writer: SseEventWriter | undefined;
    let guard: SessionStreamGuard | undefined;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeHistory: (() => void) | undefined;
    let metricsTimer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      release();
      guard?.close();
      unsubscribe?.();
      unsubscribeHistory?.();
      if (metricsTimer) clearInterval(metricsTimer);
      if (heartbeat) clearInterval(heartbeat);
      cleanupStreams.delete(cleanup);
      request.raw.removeListener("aborted", cleanup);
      reply.raw.removeListener("close", cleanup);
      reply.raw.removeListener("error", cleanup);
      reply.raw.removeListener("finish", cleanup);
      writer?.close();
    };
    cleanupStreams.add(cleanup);
    request.raw.once("aborted", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.once("finish", cleanup);

    try {
      guard = new SessionStreamGuard(db, request, true, cleanup, (error) => request.log.error(error));
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      writer = new SseEventWriter(reply.raw, undefined, undefined, () => Boolean(guard?.currentUser()));
      guard.start();
      writer.push("ready", {
        tasks: [...new Map([
          ...tasks.list({ limit: 500, includeTerminal: true }),
          ...tasks.list({ limit: 500 }),
        ].map((task) => [task.id, task])).values()].map(publicTask),
        metrics: tasks.metrics(),
      });
      unsubscribe = tasks.subscribe((event, task) => {
        writer?.push(event, { jobId: task.id, task: publicTask(task) });
      });
      unsubscribeHistory = tasks.subscribeHistoryCleared((ids) => writer?.push("history.cleared", { ids }));
      metricsTimer = setInterval(() => writer?.push("metrics", { metrics: tasks.metrics() }), 2500);
      heartbeat = setInterval(() => writer?.push("heartbeat", { at: new Date().toISOString() }), HEARTBEAT_MS);
      heartbeat.unref?.();
    } catch (error) {
      cleanup();
      request.log.error({ err: error }, "Could not open task event stream");
      if (!reply.sent) return sendError(reply, 500, "Could not open task event stream");
    }
  });
}
