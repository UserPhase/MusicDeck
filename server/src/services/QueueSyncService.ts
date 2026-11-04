import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { LibraryService } from "../domain/library.js";
import { getPrimaryConnectionId } from "../domain/connections.js";
import { createId } from "../utils/ids.js";
const compress = promisify(gzip), expand = promisify(gunzip), DAY = 86400_000;
export const MAX_QUEUE_CONTENT_BYTES = 32 * 1024 * 1024;
const id = z.string().min(1).max(1000), text = z.string().max(1000), nonnegative = z.number().finite().nonnegative();
const resume = z.object({ type: z.enum(["album", "playlist"]), mediaId: id, title: id, trackIndex: z.number().int().nonnegative(),
  trackCount: z.number().int().positive(), occurrenceId: id.nullable() }).strict().refine(row => row.trackIndex < row.trackCount);
const preview = text.refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && /(^|\.)(itunes\.apple\.com|dzcdn\.net)$/.test(url.hostname); } catch { return false; } });
const gains = z.object({ trackGainDb: z.number().finite().optional(), albumGainDb: z.number().finite().optional(), trackPeak: nonnegative.optional(), albumPeak: nonnegative.optional() }).strict();
export const queueTrackSchema = z.object({ id, title: text.optional(), artist: text.optional(), album: text.optional(), artistId: text.optional(), albumId: text.optional(),
  artistCredits: z.array(z.object({ id: id.nullable(), name: id }).strict()).optional(),
  coverArt: text.optional(), provider: text.optional(), albumPlaybackId: text.optional(), playlistItemId: text.optional(), tastePlaylistId: text.optional(),
  external: z.boolean().optional(), isDownloaded: z.boolean().optional(), recommendationGenerated: z.boolean().optional(), autoplayGenerated: z.boolean().optional(),
  excludeFromTaste: z.boolean().optional(), tasteSessionExcluded: z.boolean().optional(), duration: nonnegative.optional(), albumTrackIndex: z.number().int().nonnegative().optional(),
  normalizationGainDb: z.number().finite().min(-60).max(12).optional(), previewUrl: preview.optional(),
  source: z.object({ kind: z.enum(["library", "external"]), count: nonnegative }).strict().optional(),
  metadata: z.object({ durationSeconds: nonnegative.optional(), artistId: z.union([text, z.number().finite()]).optional(), albumId: z.union([text, z.number().finite()]).optional(),
    isrc: text.optional(), year: z.union([text, z.number().finite()]).optional(), recommendationReason: text.optional(), normalizationGainDb: z.number().finite().optional() }).strict().optional(),
  replayGain: gains.optional(), loudness: z.object({ integratedLufs: z.number().finite(), truePeakDb: z.number().finite() }).strict().optional(), mediaResume: resume.optional(),
}).strict();
export const queueContentSchema = z.object({ version: z.literal(2), entries: z.array(z.object({ entryId: z.string().min(1).max(160), track: queueTrackSchema }).strict()) }).strict()
  .refine(content => new Set(content.entries.map(entry => entry.entryId)).size === content.entries.length, "Queue occurrences must be unique.");
export const queueCheckpointSchema = z.object({ index: z.number().int().min(-1), position: nonnegative.max(7 * DAY / 1000), repeatOne: z.boolean(), shuffle: z.boolean(),
  shuffleSeed: z.number().int().min(0).max(0xffffffff).nullable(), shuffleMode: z.enum(["standard", "smart"]), albumAware: z.boolean(), volume: z.number().min(0).max(1),
  wasPlaying: z.boolean(), context: z.object({ type: text, id, name: text, coverArt: text.nullable() }).strict().nullable(), capturedAt: z.number().int().nonnegative() }).strict();
export type QueueContent = z.infer<typeof queueContentSchema>;
export type QueueCheckpoint = z.infer<typeof queueCheckpointSchema>;
interface ContentRow { content_id: string; compressed: Buffer; raw_bytes: number; track_count: number }
export class QueueSyncError extends Error { constructor(message: string, readonly statusCode: 400 | 404 | 409 | 410 | 413 | 429) { super(message); } }
export class QueueSyncService {
  constructor(private readonly db: Db, private readonly library: LibraryService, private readonly now = Date.now) {}
  async storeContent(userId: string, input: unknown): Promise<{ contentId: string; trackCount: number }> {
    const parsed = queueContentSchema.safeParse(input); if (!parsed.success) throw new QueueSyncError("The queue contains invalid tracks or duplicate occurrence IDs.", 400);
    const serialized = JSON.stringify(parsed.data), bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_QUEUE_CONTENT_BYTES) throw new QueueSyncError("This queue exceeds the server's 32 MiB sync limit. The local queue remains intact.", 413);
    const contentId = createHash("sha256").update(serialized).digest("hex"), trackCount = parsed.data.entries.length;
    if (this.db.prepare("SELECT 1 FROM queue_contents WHERE user_id=? AND content_id=?").get(userId, contentId)) return { contentId, trackCount };
    const compressed = await compress(serialized, { level: 1 });
    this.db.transaction(() => {
      const size = this.db.prepare("SELECT COALESCE(SUM(length(compressed)),0) AS n FROM queue_contents WHERE user_id=?").get(userId) as { n: number };
      if (size.n + compressed.length > 128 * 1024 * 1024) throw new QueueSyncError("Your synced queues use the account's 128 MiB storage budget. Remove old named queues and retry later.", 413);
      this.db.prepare("INSERT OR IGNORE INTO queue_contents VALUES(?,?,?,?,?,?)").run(userId, contentId, compressed, bytes, trackCount, this.now());
    })();
    return { contentId, trackCount };
  }
  private contentRow(userId: string, contentId: string): ContentRow {
    const row = this.db.prepare("SELECT content_id,compressed,raw_bytes,track_count FROM queue_contents WHERE user_id=? AND content_id=?").get(userId, contentId) as ContentRow | undefined;
    if (!row) throw new QueueSyncError("The saved queue is unavailable for this account. Sync this device again.", 404); return row;
  }
  async content(userId: string, contentId: string): Promise<QueueContent> {
    const row = this.contentRow(userId, contentId);
    try {
      const decoded = await expand(row.compressed, { maxOutputLength: MAX_QUEUE_CONTENT_BYTES });
      if (decoded.length !== row.raw_bytes) throw new Error("Queue size mismatch");
      const serialized = decoded.toString("utf8");
      if (createHash("sha256").update(serialized).digest("hex") !== contentId) throw new Error("Queue checksum mismatch");
      const content = queueContentSchema.parse(JSON.parse(serialized));
      if (content.entries.length !== row.track_count) throw new Error("Queue count mismatch");
      return content;
    } catch { throw new QueueSyncError("The saved queue failed its integrity check. Sync the original device again.", 409); }
  }
  private checkpoint(userId: string, contentId: string, input: unknown) {
    const parsed = queueCheckpointSchema.safeParse(input); if (!parsed.success) throw new QueueSyncError("Invalid queue playback checkpoint.", 400);
    const checkpoint = parsed.data, count = this.contentRow(userId, contentId).track_count;
    if ((count === 0 && checkpoint.index !== -1) || (count > 0 && (checkpoint.index < 0 || checkpoint.index >= count))) throw new QueueSyncError("The playback index does not belong to this queue.", 400);
    if (checkpoint.capturedAt > this.now() + 5 * 60_000) throw new QueueSyncError("The device clock is ahead of the server. Correct the clock and retry queue sync.", 400);
    return checkpoint;
  }
  saveSession(userId: string, deviceId: string, deviceName: string, contentId: string, input: unknown, sequence: number) {
    return this.db.transaction(() => {
      const checkpoint = this.checkpoint(userId, contentId, input);
      const old = this.db.prepare("SELECT sequence,checkpoint_json FROM queue_sessions WHERE user_id=? AND device_id=?").get(userId, deviceId) as { sequence: number; checkpoint_json: string } | undefined;
      if (old && (old.sequence >= sequence || (JSON.parse(old.checkpoint_json) as QueueCheckpoint).capturedAt > checkpoint.capturedAt)) return { saved: false, sequence: old.sequence };
      if (!old && (this.db.prepare("SELECT COUNT(*) AS n FROM queue_sessions WHERE user_id=?").get(userId) as { n: number }).n >= 12)
        throw new QueueSyncError("This account already has 12 recent queue devices. Remove an old device queue before syncing another.", 429);
      this.db.prepare(`INSERT INTO queue_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET device_name=excluded.device_name,
        content_id=excluded.content_id,checkpoint_json=excluded.checkpoint_json,sequence=excluded.sequence,updated_at=excluded.updated_at`)
        .run(userId, deviceId, deviceName, contentId, JSON.stringify(checkpoint), sequence, this.now());
      return { saved: true, sequence };
    })();
  }
  sessions(userId: string) {
    return (this.db.prepare(`SELECT s.device_id AS deviceId,s.device_name AS deviceName,s.content_id AS contentId,s.checkpoint_json,s.sequence,
      s.updated_at AS updatedAt,c.track_count AS trackCount FROM queue_sessions s JOIN queue_contents c ON c.user_id=s.user_id AND c.content_id=s.content_id
      WHERE s.user_id=? ORDER BY s.updated_at DESC,s.device_id`).all(userId) as Record<string, unknown>[])
      .map(({ checkpoint_json, ...row }) => ({ ...row, checkpoint: JSON.parse(String(checkpoint_json)) as QueueCheckpoint }));
  }
  removeSession(userId: string, deviceId: string) { this.db.prepare("DELETE FROM queue_sessions WHERE user_id=? AND device_id=?").run(userId, deviceId); }
  named(userId: string) {
    return (this.db.prepare(`SELECT n.id,n.name,n.content_id AS contentId,n.checkpoint_json,n.revision,n.created_at AS createdAt,n.updated_at AS updatedAt,c.track_count AS trackCount
      FROM named_queues n JOIN queue_contents c ON c.user_id=n.user_id AND c.content_id=n.content_id WHERE n.user_id=? ORDER BY n.updated_at DESC,n.id`)
      .all(userId) as Record<string, unknown>[]).map(({ checkpoint_json, ...row }) => ({ ...row, checkpoint: JSON.parse(String(checkpoint_json)) as QueueCheckpoint }));
  }
  saveNamed(userId: string, name: string, contentId: string, input: unknown, operationId: string) {
    return this.db.transaction(() => {
      const checkpoint = this.checkpoint(userId, contentId, input);
      const previous = this.db.prepare("SELECT id,name,content_id FROM named_queues WHERE user_id=? AND operation_id=?").get(userId, operationId) as { id: string; name: string; content_id: string } | undefined;
      if (previous) { if (previous.content_id !== contentId || previous.name !== name) throw new QueueSyncError("Save request already belongs to another named queue.", 409); return { id: previous.id }; }
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM named_queues WHERE user_id=?").get(userId) as { n: number }).n >= 50) throw new QueueSyncError("You can keep up to 50 named queues. Remove an older one before saving another.", 429);
      const id = createId("queue"); this.db.prepare("INSERT INTO named_queues(id,user_id,name,content_id,checkpoint_json,operation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, userId, name, contentId, JSON.stringify(checkpoint), operationId, this.now(), this.now()); return { id };
    })();
  }
  removeNamed(userId: string, id: string, revision: number) {
    const removed = this.db.prepare("DELETE FROM named_queues WHERE user_id=? AND id=? AND revision=?").run(userId, id, revision);
    if (!removed.changes) throw new QueueSyncError("The named queue changed or was removed. Refresh the list.", 409);
  }
  async saveAsPlaylist(userId: string, name: string, contentId: string, operationId: string) {
    const content = await this.content(userId, contentId);
    if (!content.entries.length) throw new QueueSyncError("Add tracks to the queue before saving it as a playlist.", 400);
    if (content.entries.length > 20_000) throw new QueueSyncError("Static playlists support 20,000 tracks. Save this queue as a named queue to preserve every entry.", 413);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT playlist_id,content_id,name FROM queue_playlist_saves WHERE user_id=? AND operation_id=?").get(userId, operationId) as { playlist_id: string | null; content_id: string; name: string } | undefined;
      if (previous) {
        if (previous.content_id !== contentId || previous.name !== name) throw new QueueSyncError("Save request already belongs to another playlist.", 409);
        if (!previous.playlist_id || !this.db.prepare("SELECT 1 FROM playlists WHERE id=? AND deleted_at IS NULL").get(previous.playlist_id)) throw new QueueSyncError("The previously saved playlist was deleted. Restore it from Trash or start a new save.", 410);
        return { playlistId: previous.playlist_id };
      }
      const id = createId("mdpl"), now = new Date(this.now()).toISOString(), primary = getPrimaryConnectionId(this.db);
      this.db.prepare("INSERT INTO playlists(id,owner_user_id,name,description,created_at,updated_at) VALUES(?,?,?,'Saved listening queue',?,?)").run(id, userId, name, now, now);
      const insert = this.db.prepare(`INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at,external_track_json,added_by_user_id) VALUES(?,?,?,?,?,?,?,?,?)`);
      content.entries.forEach(({ track }, position) => {
        const source = this.library.getPrimarySource(track.id), external = track.external || track.source?.kind === "external" || /^external_/.test(track.id);
        if (!source && !external) throw new QueueSyncError(`Queue track ${position + 1} is no longer in the library. The original queue is unchanged.`, 409);
        const metadata = external && !source ? JSON.stringify({ id: track.id, providerId: track.id, title: track.title || "Unknown title", artistName: track.artist || "Unknown artist",
          artistId: track.artistId || null, artistCredits: track.artistCredits, albumName: track.album || "", albumId: track.albumId || null, durationSeconds: track.duration ?? null, trackNumber: null,
          artworkId: track.coverArt || null, artworkUrl: null, streamUrl: "", external: true, provider: "external", source: { kind: "external", count: 0 }, previewUrl: track.previewUrl ?? null }) : null;
        insert.run(createId("mdpli"), id, position, source?.connectionId ?? primary ?? "", source?.providerItemId ?? track.id, source ? track.id : null, now, metadata, userId);
      });
      this.db.prepare("INSERT INTO queue_playlist_saves VALUES(?,?,?,?,?)").run(userId, operationId, id, contentId, name); return { playlistId: id };
    })();
  }
  prune() {
    this.db.prepare("DELETE FROM queue_sessions WHERE updated_at<?").run(this.now() - 30 * DAY);
    this.db.prepare(`DELETE FROM queue_contents WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM queue_sessions s WHERE s.user_id=queue_contents.user_id AND s.content_id=queue_contents.content_id)
      AND NOT EXISTS(SELECT 1 FROM named_queues n WHERE n.user_id=queue_contents.user_id AND n.content_id=queue_contents.content_id)`)
      .run(this.now() - DAY);
  }
}
