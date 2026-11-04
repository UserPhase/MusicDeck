import { z } from "zod";
import type { Db } from "../db/database.js";
import { playlistReadPredicate } from "./PlaylistCollaborationService.js";

export const MEDIA_SESSION_TTL = 30 * 86_400_000;
export const mediaCheckpointSchema = z.object({
  type: z.enum(["album", "playlist"]),
  mediaId: z.string().min(1).max(300),
  title: z.string().trim().min(1).max(500),
  trackId: z.string().min(1).max(300),
  occurrenceId: z.string().min(1).max(300).nullable().default(null),
  trackIndex: z.number().int().min(0).max(1_000_000),
  trackCount: z.number().int().min(1).max(1_000_001),
  positionSeconds: z.number().finite().min(0).max(86_400),
  durationSeconds: z.number().finite().positive().max(86_400).nullable(),
  capturedAt: z.number().int().positive(),
  completed: z.boolean().default(false),
}).strict().refine((value) => value.trackIndex < value.trackCount, { message: "Track index is outside the collection." })
  .refine((value) => value.durationSeconds === null || value.positionSeconds <= value.durationSeconds,
    { message: "Position exceeds track duration." });

export type MediaCheckpointInput = z.input<typeof mediaCheckpointSchema>;
export interface MediaCheckpoint {
  type: "album" | "playlist"; mediaId: string; title: string; trackId: string;
  occurrenceId: string | null; trackIndex: number; trackCount: number;
  positionSeconds: number; durationSeconds: number | null;
  progress: number; capturedAt: number; updatedAt: number;
}
interface SessionRow {
  media_type: MediaCheckpoint["type"]; media_id: string; title: string; track_id: string;
  occurrence_id: string | null; track_index: number; track_count: number;
  position_seconds: number; duration_seconds: number | null; progress: number;
  captured_at: number; updated_at: number;
}
function checkpoint(row: SessionRow): MediaCheckpoint {
  return {
    type: row.media_type, mediaId: row.media_id, title: row.title, trackId: row.track_id,
    occurrenceId: row.occurrence_id, trackIndex: row.track_index, trackCount: row.track_count,
    positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds,
    progress: row.progress, capturedAt: row.captured_at, updatedAt: row.updated_at,
  };
}

/** User-owned playback bookmarks, independent of statistical listening events. */
export class ResumableMediaService {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  prune(): number {
    this.db.prepare("DELETE FROM media_session_completions WHERE updated_at<?").run(this.now() - MEDIA_SESSION_TTL);
    return this.db.prepare("DELETE FROM media_sessions WHERE updated_at<? OR progress>=1")
      .run(this.now() - MEDIA_SESSION_TTL).changes;
  }

  private clean(userId: string): void {
    this.prune();
    // A deleted/private playlist must never remain visible via an old checkpoint.
    this.db.prepare(`DELETE FROM media_sessions WHERE user_id=@viewer AND media_type='playlist'
      AND NOT EXISTS (SELECT 1 FROM playlists p WHERE p.id=media_id AND p.deleted_at IS NULL AND ${playlistReadPredicate()})`)
      .run({ viewer: userId, isAdmin: Number(Boolean(this.db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(userId))) });
  }

  get(userId: string, type: MediaCheckpoint["type"], mediaId: string): MediaCheckpoint | null {
    this.clean(userId);
    const row = this.db.prepare("SELECT * FROM media_sessions WHERE user_id=? AND media_type=? AND media_id=?")
      .get(userId, type, mediaId) as SessionRow | undefined;
    return row ? checkpoint(row) : null;
  }

  list(userId: string): MediaCheckpoint[] {
    this.clean(userId);
    return (this.db.prepare("SELECT * FROM media_sessions WHERE user_id=? ORDER BY updated_at DESC,media_type,media_id LIMIT 100")
      .all(userId) as SessionRow[]).map(checkpoint);
  }

  save(userId: string, input: MediaCheckpointInput): MediaCheckpoint | null {
    const value = mediaCheckpointSchema.parse(input);
    const now = this.now();
    if (value.capturedAt > now + 5000 || value.capturedAt < now - MEDIA_SESSION_TTL) {
      throw new RangeError("Checkpoint timestamp is outside the allowed range.");
    }
    this.prune();
    return this.db.transaction(() => {
      // Retain only an ordering tombstone after completion, not a resumable item.
      // A delayed five-second write must not resurrect a finished collection.
      const completed = this.db.prepare("SELECT captured_at FROM media_session_completions WHERE user_id=? AND media_type=? AND media_id=?")
        .get(userId, value.type, value.mediaId) as { captured_at: number } | undefined;
      if (completed && completed.captured_at >= value.capturedAt) return null;
      const previous = this.db.prepare("SELECT * FROM media_sessions WHERE user_id=? AND media_type=? AND media_id=?")
        .get(userId, value.type, value.mediaId) as SessionRow | undefined;
      if (previous && (previous.captured_at > value.capturedAt ||
        (previous.captured_at === value.capturedAt && !value.completed))) return checkpoint(previous);
      const fraction = value.durationSeconds ? value.positionSeconds / value.durationSeconds : 0;
      const progress = value.completed ? 1 : (value.trackIndex + fraction) / value.trackCount;
      if (progress >= 1) {
        this.db.prepare(`INSERT INTO media_session_completions (user_id,media_type,media_id,captured_at,updated_at)
          VALUES (?,?,?,?,?) ON CONFLICT(user_id,media_type,media_id) DO UPDATE SET captured_at=excluded.captured_at,updated_at=excluded.updated_at`)
          .run(userId, value.type, value.mediaId, value.capturedAt, now);
        this.remove(userId, value.type, value.mediaId);
        return null;
      }
      this.db.prepare("DELETE FROM media_session_completions WHERE user_id=? AND media_type=? AND media_id=?")
        .run(userId, value.type, value.mediaId);
      this.db.prepare(`INSERT INTO media_sessions
        (user_id,media_type,media_id,title,track_id,occurrence_id,track_index,track_count,position_seconds,duration_seconds,progress,captured_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,media_type,media_id) DO UPDATE SET
        title=excluded.title,track_id=excluded.track_id,occurrence_id=excluded.occurrence_id,track_index=excluded.track_index,
        track_count=excluded.track_count,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,
        progress=excluded.progress,captured_at=excluded.captured_at,updated_at=excluded.updated_at`)
        .run(userId, value.type, value.mediaId, value.title, value.trackId, value.occurrenceId, value.trackIndex,
          value.trackCount, value.positionSeconds, value.durationSeconds, progress, value.capturedAt, now);
      return { ...value, progress, updatedAt: now };
    })();
  }

  remove(userId: string, type: MediaCheckpoint["type"], mediaId: string): void {
    this.db.prepare("DELETE FROM media_sessions WHERE user_id=? AND media_type=? AND media_id=?")
      .run(userId, type, mediaId);
  }
}
