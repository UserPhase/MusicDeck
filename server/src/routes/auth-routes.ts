import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { createSession, clearSessionCookie, deleteSession, getSessionUser, revokeUserSessions, setSessionCookie, SESSION_COOKIE } from "../auth/sessions.js";
import { notifySessionChanges } from "../auth/session-events.js";
import { requireUser } from "../auth/authorization.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { sendError } from "../utils/http.js";
import { getUserByUsername, recordLogin, toPublicUser } from "../users/users.js";
import { LoginRateLimiter } from "../auth/login-rate-limiter.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function registerAuthRoutes(app: FastifyInstance, db: Db, config: AppConfig) {
  const limiter = new LoginRateLimiter(config.loginRateLimit);
  const cleanupTimer = setInterval(() => limiter.cleanup(), Math.min(config.loginRateLimit.windowMs, 60_000));
  cleanupTimer.unref();
  app.addHook("onClose", async () => clearInterval(cleanupTimer));

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendError(reply, 400, "Invalid login request");
    }

    const admission = limiter.admit(request.ip, parsed.data.username);
    if (!admission.allowed) {
      reply.header("Retry-After", admission.retryAfter);
      return sendError(reply, 429, "Too many login attempts. Please try again later.", "RATE_LIMITED");
    }

    try {
      const row = getUserByUsername(db, parsed.data.username) as {
        id: string; disabled: number; password_hash: string;
      } | undefined;

      if (!row || row.disabled) {
        return sendError(reply, 401, "Invalid username or password");
      }

      const valid = await verifyPassword(parsed.data.password, row.password_hash);

      if (!valid) {
        return sendError(reply, 401, "Invalid username or password");
      }

      const authenticated = db.transaction(() => {
        const current = getUserByUsername(db, parsed.data.username) as typeof row;
        if (!current || current.disabled || current.password_hash !== row.password_hash) return null;
        return { current, session: createSession(db, current.id), lastLoginAt: recordLogin(db, current.id) };
      })();
      if (!authenticated) return sendError(reply, 401, "Invalid username or password");
      const { current, session, lastLoginAt } = authenticated;
      setSessionCookie(reply, session.id, session.expiresAt, config.secureCookies);

      return { user: toPublicUser({ ...current, last_login_at: lastLoginAt }) };
    } finally {
      admission.release();
    }
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
    const changed = db.transaction(() => {
      const current = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string } | undefined;
      if (!getSessionUser(db, request) || current?.password_hash !== row.password_hash) return false;
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
        passwordHash,
        new Date().toISOString(),
        user.id
      );
      revokeUserSessions(db, user.id, request.cookies[SESSION_COOKIE]);
      return true;
    })();
    if (!changed) return sendError(reply, 401, "Authentication required");
    notifySessionChanges(db);

    return { ok: true };
  });
}
