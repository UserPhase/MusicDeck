import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import {
  listServerSettings,
  listUserSettings,
  updateServerSettings,
  updateUserSettings,
} from "../domain/settings.js";
import {
  SCAN_SCHEDULE_SETTING_KEY,
  type ScannerScheduler,
  validateScanSchedule,
} from "../services/scannerScheduler.js";
import { sendError } from "../utils/http.js";
import { getUserById } from "../users/users.js";

const settingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
}).strict();

const themeSchema = z.enum(["dark", "light"]);
// Structural layout archetypes; legacy "tidal" values are mapped to "spotify" by the client.
const LAYOUT_PRESETS = ["spotify", "apple", "ytmusic", "soundcloud"] as const;
const layoutPresetSchema = z.enum(LAYOUT_PRESETS);

// Preferences an administrator may override on another user's behalf.
const adminUserSettingsSchema = z.object({
  settings: z.object({
    "ui.theme": themeSchema.optional(),
    "ui.layoutPreset": layoutPresetSchema.optional(),
    "playback.streamQuality": z.enum(["128", "320", "original"]).optional(),
    "playback.downloadQuality": z.enum(["lossless", "320kbps", "256kbps", "192kbps", "128kbps"]).optional(),
  }).strict(),
}).strict();

export async function registerSettingsRoutes(app: FastifyInstance, db: Db, scheduler?: ScannerScheduler) {
  app.get("/api/settings/user", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    return { settings: listUserSettings(db, user.id) };
  });

  app.patch("/api/settings/user", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = settingsSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid user settings request", "VALIDATION_ERROR");
    }

    const theme = parsed.data.settings["ui.theme"];
    if (theme !== undefined && !themeSchema.safeParse(theme).success) {
      return sendError(reply, 400, "Theme must be \"dark\" or \"light\"", "VALIDATION_ERROR");
    }

    const layoutPreset = parsed.data.settings["ui.layoutPreset"];
    if (layoutPreset !== undefined && !layoutPresetSchema.safeParse(layoutPreset).success) {
      return sendError(reply, 400, `Layout preset must be one of: ${LAYOUT_PRESETS.join(", ")}`, "VALIDATION_ERROR");
    }

    return { settings: updateUserSettings(db, user.id, parsed.data.settings) };
  });

  app.get("/api/admin/users/:userId/settings", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;

    const { userId } = request.params as { userId: string };
    if (!getUserById(db, userId)) return sendError(reply, 404, "User not found");

    return { settings: listUserSettings(db, userId) };
  });

  app.patch("/api/admin/users/:userId/settings", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;

    const { userId } = request.params as { userId: string };
    if (!getUserById(db, userId)) return sendError(reply, 404, "User not found");

    const parsed = adminUserSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Invalid user preferences request", "VALIDATION_ERROR");
    }

    return { settings: updateUserSettings(db, userId, parsed.data.settings) };
  });

  app.get("/api/admin/settings/server", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    return { settings: listServerSettings(db) };
  });

  app.patch("/api/admin/settings/server", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = settingsSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid server settings request", "VALIDATION_ERROR");
    }

    const settings = { ...parsed.data.settings };
    if (Object.prototype.hasOwnProperty.call(settings, "listening.thresholdSeconds")) {
      const threshold = z.number().finite().min(1).max(240).safeParse(settings["listening.thresholdSeconds"]);
      if (!threshold.success) return sendError(reply, 400, "Listening threshold must be between 1 and 240 seconds", "VALIDATION_ERROR");
    }
    const scheduleChanged = Object.prototype.hasOwnProperty.call(settings, SCAN_SCHEDULE_SETTING_KEY);
    if (scheduleChanged) {
      const validation = validateScanSchedule(settings[SCAN_SCHEDULE_SETTING_KEY]);
      if (!validation.ok) {
        return sendError(reply, 400, validation.error, "VALIDATION_ERROR");
      }
      // Persist the normalized form so legacy "disabled" aliases collapse to "".
      settings[SCAN_SCHEDULE_SETTING_KEY] = validation.expression ?? "";
    }

    const saved = updateServerSettings(db, settings);
    if (scheduleChanged) {
      scheduler?.apply(settings[SCAN_SCHEDULE_SETTING_KEY]);
    }
    return { settings: saved };
  });

  app.get("/api/admin/library/scan/status", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    if (!scheduler) return sendError(reply, 503, "Library scanning is unavailable", "SCAN_UNAVAILABLE");
    return scheduler.status();
  });

  app.post("/api/admin/library/scan", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    if (!scheduler) return sendError(reply, 503, "Library scanning is unavailable", "SCAN_UNAVAILABLE");

    // Scans can take minutes on large libraries, so respond immediately and let the client poll status.
    const { started } = scheduler.runNow("manual");
    return reply.code(202).send({ started, alreadyRunning: !started, status: scheduler.status() });
  });
}
