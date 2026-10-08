import type { Db } from "../db/database.js";
import { parseImageDataUrl } from "../domain/playlist-artwork.js";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function hasImageSignature(data: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "image/jpeg":
      return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/png":
      return data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return data.length > 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
    default:
      return false;
  }
}

/**
 * Decode an avatar data URL. On top of the shared artwork parser's size and
 * syntax checks, avatars are restricted to JPEG/PNG/WebP and the bytes must
 * match the declared type so a mislabeled payload is never stored.
 */
export function parseAvatarDataUrl(value: unknown): { data: Buffer; contentType: string } | null {
  const image = parseImageDataUrl(value);

  if (!image || !AVATAR_TYPES.has(image.contentType) || image.data.length > MAX_AVATAR_BYTES) {
    return null;
  }

  return hasImageSignature(image.data, image.contentType) ? image : null;
}

/** Versioned URL so browsers and every UI surface refetch after a change. */
export function avatarUrlFor(userId: string, updatedAt: string | null | undefined): string | null {
  if (!updatedAt) {
    return null;
  }

  return `/api/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(String(Date.parse(updatedAt) || updatedAt))}`;
}

export function setUserAvatar(db: Db, userId: string, data: Buffer, contentType: string): boolean {
  const now = new Date().toISOString();

  return db.transaction(() => {
    const result = db.prepare(
      "UPDATE users SET avatar_updated_at = ?, updated_at = ? WHERE id = ?"
    ).run(now, now, userId);

    if (result.changes === 0) {
      return false;
    }

    db.prepare(`
      INSERT INTO user_avatars (user_id, content_type, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        content_type = excluded.content_type,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run(userId, contentType, data, now);

    return true;
  })();
}

export function clearUserAvatar(db: Db, userId: string): boolean {
  const now = new Date().toISOString();

  return db.transaction(() => {
    const result = db.prepare(
      "UPDATE users SET avatar_updated_at = NULL, updated_at = ? WHERE id = ?"
    ).run(now, userId);

    db.prepare("DELETE FROM user_avatars WHERE user_id = ?").run(userId);
    return result.changes > 0;
  })();
}

export function getUserAvatar(db: Db, userId: string): { data: Buffer; contentType: string } | null {
  const row = db.prepare(
    "SELECT content_type, data FROM user_avatars WHERE user_id = ?"
  ).get(userId) as { content_type: string; data: Buffer | Uint8Array } | undefined;

  return row ? { data: Buffer.from(row.data), contentType: row.content_type } : null;
}
