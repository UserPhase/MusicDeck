import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization.js";
import type { Db } from "../../db/database.js";
import type { SonicRecommendationService } from "../../services/SonicRecommendationService.js";
import { TaskConflictError, type TaskManager } from "../../services/TaskManager.js";
import { SONIC_TASK } from "../../tasks/runners/sonicAnalysisRunner.js";
import { sendError } from "../../utils/http.js";

const schedules = { hourly: "30 * * * *", nightly: "30 2 * * *" } as const;
const configuration = z.object({
  enabled: z.boolean(), threads: z.number().int().min(1).max(4), weight: z.number().min(0).max(6),
  schedule: z.enum(["manual", "hourly", "nightly"]),
}).strict();
const actions = z.object({ action: z.enum(["start", "pause", "resume", "cancel"]) }).strict();

export function registerSonicRoutes(app: FastifyInstance, db: Db, service: SonicRecommendationService, tasks: TaskManager) {
  const path = "/api/v1/admin/sonic";
  const snapshot = () => {
    const pending = tasks.findPending(SONIC_TASK, {});
    const task = pending ?? tasks.list({ includeTerminal: true, limit: 100 }).find(item => item.type === SONIC_TASK);
    const expression = tasks.listSchedules().find(item => item.type === SONIC_TASK && item.enabled)?.expression;
    const schedule = expression === schedules.hourly ? "hourly" : expression === schedules.nightly ? "nightly" : "manual";
    return {
      settings: { ...service.settings, schedule },
      counts: service.counts(),
      task: task ? { id: task.id, state: task.state, progress: task.progress, error: task.error } : null,
      activeStreams: tasks.metrics().activeStreams,
    };
  };
  app.get(path, async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    reply.header("Cache-Control", "private, no-store");
    return snapshot();
  });
  app.put(path, async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;
    const parsed = configuration.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid sonic settings");
    const { schedule, ...settings } = parsed.data;
    service.configure(settings);
    if (settings.enabled && schedule !== "manual") tasks.setSchedule(SONIC_TASK, {}, schedules[schedule], admin.id);
    else tasks.removeSchedule(SONIC_TASK);
    if (!settings.enabled) {
      const pending = tasks.findPending(SONIC_TASK, {});
      if (pending) await tasks.cancel(pending.id);
    }
    return snapshot();
  });
  app.post(path, async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;
    const parsed = actions.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid sonic task action");
    const pending = tasks.findPending(SONIC_TASK, {});
    try {
      switch (parsed.data.action) {
        case "start":
          if (!service.settings.enabled) return sendError(reply, 409, "Enable sonic analysis first");
          tasks.enqueue(SONIC_TASK, {}, admin.id);
          break;
        case "pause": if (pending) tasks.pause(pending.id); break;
        case "resume":
          if (!service.settings.enabled) return sendError(reply, 409, "Enable sonic analysis first");
          if (pending) tasks.resume(pending.id);
          break;
        case "cancel": if (pending) await tasks.cancel(pending.id); break;
      }
    } catch (error) {
      if (error instanceof TaskConflictError) return sendError(reply, 409, error.message);
      throw error;
    }
    return snapshot();
  });
}
