import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { createSession, clearSessionCookie, deleteSession, getSessionUser, setSessionCookie, SESSION_COOKIE } from "../auth/sessions.js";
import { requireUser } from "../auth/authorization.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { sendError } from "../utils/http.js";
import { getUserByUsername, toPublicUser } from "../users/users.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function registerAuthRoutes(app: FastifyInstance, db: Db, config: AppConfig) {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid login request");
    }

    const row = getUserByUsername(db, parsed.data.username) as any;

    if (!row || row.disabled) {
      return sendError(reply, 401, "Invalid username or password");
    }

    const valid = await verifyPassword(parsed.data.password, row.password_hash);

    if (!valid) {
      return sendError(reply, 401, "Invalid username or password");
    }

    const session = createSession(db, row.id);
      setSessionCookie(reply, session.id, session.expiresAt, config.secureCookies);

    return { user: toPublicUser(row) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    deleteSession(db, request.cookies[SESSION_COOKIE]);
      clearSessionCookie(reply, config.secureCookies);
    return { ok: true };
  });

  app.get("/api/auth/session", async (request) => {
    const user = getSessionUser(db, request);
    return {
      authenticated: Boolean(user),
      user,
    };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const user = requireUser(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = changePasswordSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid password change request");
    }

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as any;
    const valid = await verifyPassword(parsed.data.currentPassword, row.password_hash);

    if (!valid) {
      return sendError(reply, 400, "Current password is incorrect");
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      passwordHash,
      new Date().toISOString(),
      user.id
    );
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(
      user.id,
      request.cookies[SESSION_COOKIE]
    );

    return { ok: true };
  });
}
