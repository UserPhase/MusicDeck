import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { toPublicUser } from "../users/users.js";
import { createId } from "../utils/ids.js";
import { notifySessionChanges } from "./session-events.js";

export const SESSION_COOKIE = "musicdeck_session";
const SESSION_DAYS = 30;
const EPHEMERAL_SESSION_HOURS = 24;

function toUser(row: any): SessionUser {
  return toPublicUser(row);
}

export function createSession(db: Db, userId: string, rememberMe = true) {
  const id = createId("session");
  const createdAt = new Date();
  const ttlMs = rememberMe
    ? SESSION_DAYS * 24 * 60 * 60 * 1000
    : EPHEMERAL_SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(createdAt.getTime() + ttlMs);

  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(id, userId, createdAt.toISOString(), expiresAt.toISOString());

  return {
    id,
    expiresAt,
    persistent: rememberMe,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date,
  secure: boolean,
  persistent = true
) {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    ...(persistent ? { expires: expiresAt } : {}),
  });
}

export function refreshSessionIfRemembered(
  db: Db,
  reply: FastifyReply,
  sessionId: string | undefined,
  secure: boolean
) {
  if (!sessionId) return;
  const row = db
    .prepare("SELECT created_at, expires_at FROM sessions WHERE id = ?")
    .get(sessionId) as { created_at: string; expires_at: string } | undefined;
  if (!row) return;

  const createdMs = Date.parse(row.created_at);
  const expiresMs = Date.parse(row.expires_at);
  const ephemeralMs = EPHEMERAL_SESSION_HOURS * 60 * 60 * 1000;
  // Ephemeral ("Remember me" unchecked) sessions have a 24h TTL and no cookie `Expires`.
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs - createdMs <= ephemeralMs + 60_000) {
    return;
  }

  const nextExpiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
    nextExpiresAt.toISOString(),
    sessionId
  );
  setSessionCookie(reply, sessionId, nextExpiresAt, secure, true);
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
