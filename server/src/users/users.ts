import type { Db } from "../db/database.js";
import type { Role, User } from "../types.js";
import { hashPassword } from "../auth/passwords.js";
import { createId } from "../utils/ids.js";
import { avatarUrlFor } from "./avatars.js";

export function toPublicUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarRef: row.avatar_ref || null,
    avatarUrl: avatarUrlFor(row.id, row.avatar_updated_at),
    disabled: Boolean(row.disabled),
    isMasterAdmin: Boolean(row.is_master),
    externalSearchEnabled: row.external_search_enabled === undefined ? true : Boolean(row.external_search_enabled),
    externalPlaybackEnabled: Boolean(row.external_playback_enabled),
    lastLoginAt: row.last_login_at || null,
    lastPlaybackAt: row.last_playback_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const USER_WITH_ACTIVITY_SELECT = `
  SELECT users.*,
    (SELECT MAX(played_at) FROM recently_played WHERE recently_played.user_id = users.id) AS last_playback_at
  FROM users
`;

export function getUserByUsername(db: Db, username: string) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function getUserById(db: Db, userId: string) {
  const row = db.prepare(`${USER_WITH_ACTIVITY_SELECT} WHERE users.id = ?`).get(userId);
  return row ? toPublicUser(row) : null;
}

export function listUsers(db: Db) {
  return db.prepare(`${USER_WITH_ACTIVITY_SELECT} ORDER BY users.username ASC`).all().map(toPublicUser);
}

/**
 * Guarantees exactly one protected master administrator exists once any admin
 * does: the oldest admin is promoted only when no user carries the flag yet.
 */
export function ensureMasterAdmin(db: Db) {
  db.prepare(`
    UPDATE users SET is_master = 1
    WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_master = 1)
  `).run();
}

export function recordLogin(db: Db, userId: string) {
  const loggedInAt = new Date().toISOString();
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(loggedInAt, userId);
  return loggedInAt;
}

export async function createUser(
  db: Db,
  input: {
    username: string;
    password: string;
    displayName?: string;
    role?: Role;
  }
) {
  const now = new Date().toISOString();
  const id = createId("user");
  const passwordHash = await hashPassword(input.password);

  db.prepare(`
    INSERT INTO users
      (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    input.username,
    passwordHash,
    input.displayName || input.username,
    input.role || "user",
    now,
    now
  );

  ensureMasterAdmin(db);
  return getUserById(db, id);
}

export async function updateUser(
  db: Db,
  userId: string,
  input: {
    displayName?: string;
    avatarRef?: string | null;
    role?: Role;
    disabled?: boolean;
    externalSearchEnabled?: boolean;
    externalPlaybackEnabled?: boolean;
    password?: string;
  }
) {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;

  if (!existing) {
    return null;
  }

  const passwordHash = input.password
    ? await hashPassword(input.password)
    : existing.password_hash;

  db.prepare(`
    UPDATE users
    SET display_name = ?, avatar_ref = ?, role = ?, disabled = ?, external_search_enabled = ?, external_playback_enabled = ?, password_hash = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.displayName ?? existing.display_name,
    input.avatarRef === undefined ? existing.avatar_ref : input.avatarRef,
    input.role ?? existing.role,
    input.disabled === undefined ? existing.disabled : input.disabled ? 1 : 0,
    input.externalSearchEnabled === undefined ? existing.external_search_enabled : input.externalSearchEnabled ? 1 : 0,
    input.externalPlaybackEnabled === undefined ? existing.external_playback_enabled : input.externalPlaybackEnabled ? 1 : 0,
    passwordHash,
    new Date().toISOString(),
    userId
  );

  ensureMasterAdmin(db);
  return getUserById(db, userId);
}

export async function updateOwnProfile(
  db: Db,
  userId: string,
  input: {
    displayName?: string;
    avatarRef?: string | null;
  }
) {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;

  if (!existing) {
    return null;
  }

  db.prepare(`
    UPDATE users
    SET display_name = ?, avatar_ref = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.displayName ?? existing.display_name,
    input.avatarRef === undefined ? existing.avatar_ref : input.avatarRef,
    new Date().toISOString(),
    userId
  );

  return getUserById(db, userId);
}

export function deleteUser(db: Db, userId: string) {
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  return result.changes > 0;
}
