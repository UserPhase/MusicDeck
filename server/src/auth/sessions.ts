import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { toPublicUser } from "../users/users.js";
import { createId } from "../utils/ids.js";
import { notifySessionChanges } from "./session-events.js";

export const SESSION_COOKIE = "musicdeck_session";
const SESSION_DAYS = 30;

function toUser(row: any): SessionUser {
  return toPublicUser(row);
}

export function createSession(db: Db, userId: string) {
  const id = createId("session");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(id, userId, createdAt.toISOString(), expiresAt.toISOString());

  return {
    id,
    expiresAt,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date,
  secure: boolean
) {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}

export function deleteSession(db: Db, sessionId: string | undefined) {
  if (!sessionId) {
    return;
  }

  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  notifySessionChanges(db);
}

/** Transactional helper; notifySessionChanges must run after the caller commits. */
export function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND (? IS NULL OR id != ?)").run(
    userId, exceptSessionId ?? null, exceptSessionId ?? null
  );
}

export function getSessionUserById(db: Db, sessionId: string | undefined) {
  if (!sessionId) {
    return null;
  }

  const row = db.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
      AND users.disabled = 0
  `).get(sessionId, new Date().toISOString());

  return row ? toUser(row) : null;
}

export function getSessionUser(db: Db, request: FastifyRequest) {
  return getSessionUserById(db, request.cookies[SESSION_COOKIE]);
}
