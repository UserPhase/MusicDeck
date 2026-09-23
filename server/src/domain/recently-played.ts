import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import type { Track } from "../types.js";
import { createId } from "../utils/ids.js";

const RECENTLY_PLAYED_LIMIT = 50;
const RECENTLY_PLAYED_RETENTION = 100;
export const LISTENING_WINDOW_DAYS = 45;
export const listeningWindowStart = (now = Date.now()) =>
  new Date(now - LISTENING_WINDOW_DAYS * 86_400_000).toISOString();

/** Provider play stats belong to the configured backend account, not to an
 * individual MusicDeck login when several people share that connection. */
export function canUseProviderHistory(db: Db): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE disabled = 0").get() as { count: number };
  return row.count <= 1;
}

export async function listRecentlyPlayed(
  db: Db,
  catalog: CatalogService,
  userId: string
) {
  const rows = db.prepare(`
    SELECT track_id, MAX(played_at) AS played_at
    FROM recently_played
    WHERE user_id = ? AND played_at >= ?
    GROUP BY track_id
    ORDER BY played_at DESC
    LIMIT ?
  `).all(userId, listeningWindowStart(), RECENTLY_PLAYED_LIMIT) as Array<{
    track_id: string;
    played_at: string;
  }>;

  const tracks: Array<Track & { playedAt: string }> = [];
  let catalogTracks: Track[] = [];
  try {
    catalogTracks = (await catalog.listTracks()).items;
  } catch {
    // Individual recent items may still be available below.
  }

  const byId = new Map(catalogTracks.map((track) => [track.id, track]));
  for (const row of rows) {
    try {
      const track = byId.get(row.track_id) || await catalog.getTrack(row.track_id);
      if (track) tracks.push({ ...track, playedAt: row.played_at });
    } catch {
      // Provider unreachable for this item; skip without failing the read.
    }
  }

  // Navidrome/Jellyfin activity from other clients is available as a last-
  // played timestamp in the catalog, even when MusicDeck has no local event.
  const cutoff = Date.parse(listeningWindowStart());
  const positions = new Map(tracks.map((track, index) => [track.id, index]));
  for (const track of canUseProviderHistory(db) ? catalogTracks : []) {
    const playedTime = Date.parse(track.lastPlayedAt || "");
    if (!Number.isFinite(playedTime) || playedTime < cutoff) continue;
    const playedAt = track.lastPlayedAt!;
    const existingIndex = positions.get(track.id);
    if (existingIndex !== undefined) {
      if (playedTime > Date.parse(tracks[existingIndex].playedAt)) {
        tracks[existingIndex] = { ...track, playedAt };
      }
      continue;
    }
    positions.set(track.id, tracks.length);
    tracks.push({ ...track, playedAt });
  }
  tracks.sort((left, right) => Date.parse(right.playedAt) - Date.parse(left.playedAt));
  tracks.length = Math.min(tracks.length, RECENTLY_PLAYED_LIMIT);

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
