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
import { sendError } from "../utils/http.js";

const settingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
}).strict();

export async function registerSettingsRoutes(app: FastifyInstance, db: Db) {
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

    return { settings: updateUserSettings(db, user.id, parsed.data.settings) };
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

    return { settings: updateServerSettings(db, parsed.data.settings) };
  });
}
