import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import type { Track } from "../types.js";

/**
 * Favorites are stored as stable MusicDeck track IDs. Hydration resolves
 * each MusicDeck ID back to its provider source through the CatalogService,
 * so the public response carries stable IDs.
 */
export async function listFavoriteTracks(
  db: Db,
  catalog: CatalogService,
  userId: string
): Promise<Track[]> {
  const rows = db.prepare(
    "SELECT track_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId) as Array<{ track_id: string }>;

  const tracks: Track[] = [];

  for (const row of rows) {
    try {
      const track = await catalog.getTrack(row.track_id);
      if (track) {
        tracks.push(track);
      }
    } catch {
      // Provider unreachable for this item; skip without failing the read.
    }
  }

  return tracks;
}

export async function setTrackFavorite(
  db: Db,
  userId: string,
  trackId: string,
  liked: boolean
) {
  if (liked) {
    db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, track_id, created_at)
      VALUES (?, ?, ?)
    `).run(userId, trackId, new Date().toISOString());
  } else {
    db.prepare(
      "DELETE FROM favorites WHERE user_id = ? AND track_id = ?"
    ).run(userId, trackId);
  }
}
