import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { createId } from "../utils/ids.js";

export const SESSION_COOKIE = "musicdeck_session";
const SESSION_DAYS = 30;

function toUser(row: any): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarRef: row.avatar_ref || null,
    disabled: Boolean(row.disabled),
    externalSearchEnabled: row.external_search_enabled === undefined ? true : Boolean(row.external_search_enabled),
    externalPlaybackEnabled: Boolean(row.external_playback_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
}

export function getSessionUser(db: Db, request: FastifyRequest) {
  const sessionId = request.cookies[SESSION_COOKIE];

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
