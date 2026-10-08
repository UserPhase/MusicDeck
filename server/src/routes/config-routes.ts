import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db/database.js";
import { requireAdmin } from "../auth/authorization.js";
import { getAppConfig, updateAppConfig } from "../domain/settings.js";
import { sendError } from "../utils/http.js";

export const APP_NAME_MAX_LENGTH = 40;

const appConfigSchema = z.object({
  appName: z.string()
    .trim()
    .min(1)
    .max(APP_NAME_MAX_LENGTH)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();

export async function registerConfigRoutes(app: FastifyInstance, db: Db) {
  // Unauthenticated: the login screen and browser title need the brand name
  // before a session exists, so only non-sensitive branding is exposed here.
  app.get("/api/public/config", async () => getAppConfig(db));

  app.patch("/api/admin/config", async (request, reply) => {
    const admin = requireAdmin(db, request, reply);
    if (!admin) return reply;

    const parsed = appConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        `Application name must be 1-${APP_NAME_MAX_LENGTH} characters without control characters`,
        "VALIDATION_ERROR",
      );
    }

    return updateAppConfig(db, parsed.data);
  });
}
