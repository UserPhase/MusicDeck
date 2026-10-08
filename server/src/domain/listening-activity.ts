import { z } from "zod";
import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import { createId } from "../utils/ids.js";

const text = z.string().max(500);
export const playbackEventSchema = z.object({
  playbackSessionId: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  ownerUserId: z.string().min(1).max(200).optional(),
  trackId: z.string().min(1).max(300),
  startedAt: z.string().datetime(),
  listenedSeconds: z.number().finite().min(0).max(86_400),
  durationSeconds: z.number().finite().positive().max(86_400).nullable(),
  finished: z.boolean(),
  track: z.object({
    title: text,
    artist: text,
    album: text,
    artistId: text.nullable().optional(),
    albumId: text.nullable().optional(),
    coverArt: text.nullable().optional(),
    coverUrl: z.string().max(2000).nullable().optional(),
  }),
});
export type PlaybackEvent = z.infer<typeof playbackEventSchema>;
type EventRow = {
  id: string; track_id: string; created_at: string; listened_seconds: number | null;
  duration_seconds: number | null; counted: number; finished: number; track_json: string | null;
};
export type ActivityPeriod = "7" | "30" | "90" | "year" | "all";

export function listeningThreshold(db: Db): number {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'listening.thresholdSeconds'").get() as { value: string } | undefined;
  const value = row ? Number(JSON.parse(row.value)) : 30;
  if (!Number.isFinite(value) || value < 1 || value > 240) throw new Error("Invalid configured listening threshold");
  return value;
}

export function recordPlayback(db: Db, userId: string, event: PlaybackEvent, now = Date.now()) {
  const started = Date.parse(event.startedAt);
  if (started > now + 5000 || started < now - 30 * 86_400_000) {
    throw new Error("Playback start timestamp is outside the supported session window");
  }
  return db.transaction(() => {
    const previous = db.prepare(`
      SELECT * FROM listening_events WHERE user_id = ? AND playback_session_id = ?
    `).get(userId, event.playbackSessionId) as (EventRow & { playback_session_id: string }) | undefined;
    if (previous && (previous.track_id !== event.trackId || previous.created_at !== event.startedAt)) {
      throw new Error("Playback session cannot be reused for another listen");
    }
    // Cumulative reports can arrive twice or out of order. Never add a retry's
    // seconds, and never credit more real time than the session could contain.
    const seconds = Math.max(previous?.listened_seconds || 0,
      Math.min(event.listenedSeconds, Math.max(0, (now - started) / 1000)));
    const duration = event.durationSeconds ?? previous?.duration_seconds ?? null;
    const threshold = Math.min(listeningThreshold(db), duration ?? Infinity);
    const counted = Boolean(previous?.counted) || seconds >= threshold;
    const newlyCounted = counted && !previous?.counted;
    const id = previous?.id || createId("listen");
    const finished = Boolean(previous?.finished) || event.finished;
    const ratio = duration ? Math.min(1, seconds / duration) : null;
    if (previous) {
      db.prepare(`UPDATE listening_events SET listened_seconds = ?, duration_seconds = ?, counted = ?,
        finished = ?, event_type = ?, completion_ratio = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(seconds, duration, Number(counted), Number(finished), counted ? "complete" : "progress", ratio,
          new Date(now).toISOString(), id, userId);
    } else {
      const artistName = event.track.artist.trim().toLowerCase();
      const albumName = event.track.album.trim().toLowerCase();
      const artistKey = event.track.artistId || (artistName !== "unknown artist" && artistName ? artistName : null);
      const albumKey = event.track.albumId ||
        (albumName && albumName !== "unknown album" ? `${artistKey || ""}\u001f${albumName}` : null);
      db.prepare(`INSERT INTO listening_events
        (id,user_id,track_id,event_type,completion_ratio,created_at,playback_session_id,
         listened_seconds,duration_seconds,counted,finished,updated_at,track_json,artist_key,album_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, event.trackId, counted ? "complete" : "progress", ratio, event.startedAt,
          event.playbackSessionId, seconds, duration, Number(counted), Number(finished),
          new Date(now).toISOString(), JSON.stringify(event.track), artistKey, albumKey);
    }
    return { id, counted, newlyCounted, listenedSeconds: seconds };
  })();
}

function periodStart(period: ActivityPeriod, now: number) {
  if (period === "all") return "0000";
  if (period === "year") return new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, 1)).toISOString();
  return new Date(now - Number(period) * 86_400_000).toISOString();
}

export async function hydrateActivity(rows: EventRow[], catalog: CatalogService) {
  // New sessions have snapshots. Only legacy rows need provider resolution;
  // resolve at most one page, in small batches, never the entire music catalog.
  const items: Array<{ id: string; playedAt: string; listenedSeconds: number | null; track: Record<string, unknown> }> = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = await Promise.all(rows.slice(offset, offset + 8).map(async (row) => {
      let snapshot: Record<string, unknown> = row.track_json ? JSON.parse(row.track_json) : {};
      if (!row.track_json) {
        try {
          const track = await catalog.getTrack(row.track_id);
          if (track) snapshot = { ...track, artist: track.artistName, album: track.albumName,
            coverArt: track.artworkId, coverUrl: track.artworkUrl, duration: track.durationSeconds };
        } catch (error) {
          console.warn("Could not resolve historical listening track:", row.track_id, error);
          // Historical events survive deletion/provider outages; keep the row
          // and expose its unavailable state instead of dropping history.
          snapshot = { unavailable: true };
        }
      }
      return { id: row.id, playedAt: row.created_at, listenedSeconds: row.listened_seconds,
        track: { ...snapshot, id: row.track_id, title: snapshot.title || "Unavailable track",
          artist: snapshot.artist || "Unknown artist", album: snapshot.album || "",
          duration: row.duration_seconds ?? snapshot.duration ?? null,
          source: { kind: "library", count: 1 } } };
    }));
    items.push(...batch);
  }
  return items;
}

export async function listeningHistory(db: Db, catalog: CatalogService, userId: string,
  options: { period: ActivityPeriod; search: string; limit: number; cursor?: { at: string; id: string } }, now = Date.now()) {
  const search = options.search.replace(/[\\%_]/g, "\\$&");
  const rows = db.prepare(`SELECT * FROM listening_events
    WHERE user_id = ? AND counted = 1 AND created_at >= ?
      AND (? = '' OR COALESCE(json_extract(track_json, '$.title'), track_id) LIKE ? ESCAPE '\\'
        OR json_extract(track_json, '$.artist') LIKE ? ESCAPE '\\'
        OR json_extract(track_json, '$.album') LIKE ? ESCAPE '\\')
      AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(userId, periodStart(options.period, now), search, `%${search}%`, `%${search}%`, `%${search}%`,
      options.cursor?.at || "", options.cursor?.at || "", options.cursor?.at || "", options.cursor?.id || "",
      options.limit + 1) as EventRow[];
  const more = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return { items: await hydrateActivity(page, catalog),
    nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString("base64url") : null };
}

export async function activityRecent(db: Db, catalog: CatalogService, userId: string) {
  const rows = db.prepare(`SELECT * FROM listening_events WHERE user_id = ? AND counted = 1
    ORDER BY created_at DESC, id DESC LIMIT 50`).all(userId) as EventRow[];
  return (await hydrateActivity(rows, catalog)).map((item) => ({ ...item.track, playedAt: item.playedAt }));
}

export function listeningStatistics(db: Db, userId: string, period: ActivityPeriod, now = Date.now()) {
  const start = periodStart(period, now);
  const overview = db.prepare(`SELECT COALESCE(SUM(listened_seconds),0) AS listeningSeconds,
    COALESCE(SUM(CASE WHEN counted = 1 THEN 1 ELSE 0 END),0) AS plays,
    COUNT(DISTINCT CASE WHEN counted = 1 THEN track_id END) AS uniqueSongs,
    COUNT(DISTINCT CASE WHEN counted = 1 THEN artist_key END) AS uniqueArtists,
    COUNT(DISTINCT CASE WHEN counted = 1 THEN album_key END) AS uniqueAlbums,
    COALESCE(SUM(CASE WHEN counted = 1 AND listened_seconds IS NULL THEN 1 ELSE 0 END),0) AS legacyPlays
    FROM listening_events WHERE user_id = ? AND created_at >= ?`).get(userId, start);
  const top = (column: "track_id" | "artist_key" | "album_key") => db.prepare(`
    SELECT ${column} AS key, COUNT(*) AS plays, COALESCE(SUM(listened_seconds),0) AS listeningSeconds,
      MAX(created_at) AS lastPlayedAt, track_json AS snapshot
    FROM listening_events WHERE user_id = ? AND created_at >= ? AND counted = 1 AND ${column} IS NOT NULL
    GROUP BY ${column} ORDER BY ${column === "track_id" ? "plays DESC, listeningSeconds DESC" : "listeningSeconds DESC, plays DESC"}, key LIMIT 10`)
    .all(userId, start).map((raw) => {
      const row = raw as { key: string; plays: number; listeningSeconds: number; snapshot: string | null };
      return { key: row.key, plays: row.plays, listeningSeconds: row.listeningSeconds,
        track: row.snapshot ? JSON.parse(row.snapshot) : null };
    });
  const trend = (format: string) => db.prepare(`SELECT strftime(?, created_at) AS bucket,
    SUM(counted) AS plays, COALESCE(SUM(listened_seconds),0) AS listeningSeconds
    FROM listening_events WHERE user_id = ? AND created_at >= ? AND (counted = 1 OR listened_seconds > 0)
    GROUP BY bucket ORDER BY bucket`).all(format, userId, start);
  return { period, timezone: "UTC", overview, topSongs: top("track_id"), topArtists: top("artist_key"),
    topAlbums: top("album_key"), daily: trend("%Y-%m-%d"), monthly: trend("%Y-%m"),
    weekdays: trend("%w"), hourly: trend("%H") };
}
