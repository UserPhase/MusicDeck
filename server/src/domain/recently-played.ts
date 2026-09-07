import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import type { Track } from "../types.js";
import { createId } from "../utils/ids.js";

const RECENTLY_PLAYED_LIMIT = 50;
const RECENTLY_PLAYED_RETENTION = 100;

export async function listRecentlyPlayed(
  db: Db,
  catalog: CatalogService,
  userId: string
) {
  const rows = db.prepare(`
    SELECT track_id, MAX(played_at) AS played_at
    FROM recently_played
    WHERE user_id = ?
    GROUP BY track_id
    ORDER BY played_at DESC
    LIMIT ?
  `).all(userId, RECENTLY_PLAYED_LIMIT) as Array<{
    track_id: string;
    played_at: string;
  }>;

  const tracks: Array<Track & { playedAt: string }> = [];

  for (const row of rows) {
    try {
      const track = await catalog.getTrack(row.track_id);

      if (track) {
        tracks.push({
          ...track,
          playedAt: row.played_at,
        });
      }
    } catch {
      // Provider unreachable for this item; skip without failing the read.
    }
  }

  return tracks;
}

export function addRecentlyPlayed(
  db: Db,
  userId: string,
  trackId: string,
  playedAt = new Date().toISOString()
) {
  db.prepare(`
    INSERT INTO recently_played (id, user_id, track_id, played_at)
    VALUES (?, ?, ?, ?)
  `).run(createId("recent"), userId, trackId, playedAt);

  db.prepare(`
    DELETE FROM recently_played
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id
        FROM recently_played
        WHERE user_id = ?
        ORDER BY played_at DESC
        LIMIT ?
      )
  `).run(userId, userId, RECENTLY_PLAYED_RETENTION);
}
