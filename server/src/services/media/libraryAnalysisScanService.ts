import type { Db } from "../../db/database.js";
import type { CatalogService } from "../../domain/catalog.js";
import type { Track } from "../../types.js";
import { createId } from "../../utils/ids.js";

export type LibraryScanStatus = {
  id: string; status: "discovering" | "running" | "completed" | "failed";
  totalTracks: number; completedTracks: number; skippedTracks: number; failedTracks: number;
  currentTrack: string | null; warning: string | null; parameters: Record<string, number>;
};
type Row = { id: string; user_id: string; scope: "library" | "playlists"; status: LibraryScanStatus["status"]; options_json: string;
  total_tracks: number; completed_tracks: number; skipped_tracks: number; failed_tracks: number;
  current_track: string | null; warning: string | null };
export class ScanParametersConflict extends Error {
  constructor() { super("Another scan is already running. Wait for it to finish before starting this scan."); }
}

/** Shared persisted queue, priority ordering and checkpoints for library analysis. */
export class LibraryAnalysisScanService {
  private worker?: Promise<void>;
  private stopping = false;
  private readonly jobs: string;
  private readonly tracks: string;
  constructor(private readonly db: Db, private readonly catalog: CatalogService,
    kind: "loudness" | "silence",
    private readonly analyze: (track: Track, parameters: Record<string, number>) => Promise<{ success: boolean; reused: boolean }>) {
    // Identifiers are selected internally, never accepted from an HTTP request.
    this.jobs = `${kind}_scan_jobs`; this.tracks = `${kind}_scan_tracks`;
  }

  status(userId?: string): LibraryScanStatus | null {
    const row = (userId && this.owner(userId)?.role !== "admin"
      ? this.db.prepare(`SELECT * FROM ${this.jobs} WHERE user_id = ? AND scope = 'playlists' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId)
      : this.db.prepare(`SELECT * FROM ${this.jobs} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get()) as Row | undefined;
    return row ? { id: row.id, status: row.status, totalTracks: row.total_tracks, completedTracks: row.completed_tracks,
      skippedTracks: row.skipped_tracks, failedTracks: row.failed_tracks, currentTrack: row.current_track,
      warning: row.warning, parameters: JSON.parse(row.options_json) } : null;
  }

  start(userId: string, parameters: Record<string, number> = {}): LibraryScanStatus {
    const scope = this.owner(userId)?.role === "admin" ? "library" : "playlists";
    const options = JSON.stringify(parameters);
    const active = this.active();
    if (active) {
      if (active.scope !== scope || (scope === "playlists" && active.user_id !== userId) || active.options_json !== options) throw new ScanParametersConflict();
      this.prioritize(active.id, userId); this.launch(active.id); return this.status(userId)!;
    }
    const id = createId("analysis"); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO ${this.jobs} (id, user_id, scope, status, options_json, created_at, updated_at) VALUES (?, ?, ?, 'discovering', ?, ?, ?)`).run(id, userId, scope, options, now, now);
    this.launch(id); return this.status(userId)!;
  }

  resume() { const active = this.active(); if (active) this.launch(active.id); }
  private active() { return this.db.prepare(`SELECT * FROM ${this.jobs} WHERE status IN ('discovering', 'running') LIMIT 1`).get() as Row | undefined; }
  private owner(id: string) {
    return this.db.prepare("SELECT disabled, role FROM users WHERE id = ?").get(id) as { disabled: number; role: string } | undefined;
  }

  private playlistTracks(userId: string) {
    return this.db.prepare(`SELECT DISTINCT COALESCE(i.library_track_id, s.library_item_id) AS track_id
      FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
      LEFT JOIN library_item_sources s ON s.connection_id = i.connection_id AND s.provider_item_id = i.provider_track_id AND s.item_type = 'track'
      WHERE p.owner_user_id = ? AND p.deleted_at IS NULL`).all(userId) as { track_id: string | null }[];
  }

  private prioritize(jobId: string, userId: string) {
    const heard = this.db.prepare(`SELECT track_id FROM recently_played WHERE user_id = ?
      UNION SELECT track_id FROM listening_events WHERE user_id = ? AND (counted = 1 OR listened_seconds > 0 OR event_type = 'complete')`).all(userId, userId) as { track_id: string }[];
    const playlists = this.playlistTracks(userId);
    const update = this.db.prepare(`UPDATE ${this.tracks} SET priority = MIN(priority, ?) WHERE job_id = ? AND track_id = ? AND status = 'pending'`);
    this.db.transaction(() => {
      for (const row of heard) update.run(0, jobId, row.track_id);
      for (const row of playlists) if (row.track_id) update.run(1, jobId, row.track_id);
    })();
  }

  private launch(id: string) {
    if (this.worker || this.stopping) return;
    this.worker = this.run(id).catch(error => {
      if (!this.stopping) {
        console.warn("Library analysis scan failed", error);
        this.db.prepare(`UPDATE ${this.jobs} SET status = 'failed', current_track = NULL, warning = ?, updated_at = ? WHERE id = ?`)
          .run("The library scan could not finish. You can retry it.", new Date().toISOString(), id);
      }
    }).finally(() => { this.worker = undefined; if (!this.stopping) { const active = this.active(); if (active && active.id !== id) this.launch(active.id); } });
  }

  private async run(id: string) {
    const job = this.db.prepare(`SELECT * FROM ${this.jobs} WHERE id = ?`).get(id) as Row;
    const requireOwner = () => {
      const owner = this.owner(job.user_id);
      if (!owner || owner.disabled || (job.scope === "library" && owner.role !== "admin")) throw new Error("Scan owner unavailable");
    };
    requireOwner();
    const parameters = JSON.parse(job.options_json) as Record<string, number>;
    if (job.status === "discovering") {
      const listing = job.scope === "library" ? await this.catalog.listTracks() : null;
      if (this.stopping) return;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO ${this.tracks} (job_id, track_id, title) VALUES (?, ?, ?)`);
      this.db.transaction(() => {
        if (listing) {
          for (const track of listing.items) insert.run(id, track.id, `${track.artistName} — ${track.title}`);
        } else {
          for (const { track_id } of this.playlistTracks(job.user_id)) if (track_id) insert.run(id, track_id, "");
        }
        const count = this.db.prepare(`SELECT COUNT(*) AS count FROM ${this.tracks} WHERE job_id = ?`).get(id) as { count: number };
        this.db.prepare(`UPDATE ${this.jobs} SET status = 'running', total_tracks = ?, warning = ? WHERE id = ?`)
          .run(count.count, listing?.degraded ? "Some library sources were unavailable. Run another scan after reconnecting them." : null, id);
        this.prioritize(id, job.user_id);
      })();
    }
    const inOwnedPlaylist = this.db.prepare(`SELECT 1 FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
      LEFT JOIN library_item_sources s ON s.connection_id = i.connection_id AND s.provider_item_id = i.provider_track_id AND s.item_type = 'track'
      WHERE p.owner_user_id = ? AND p.deleted_at IS NULL
        AND COALESCE(i.library_track_id, s.library_item_id) = ? LIMIT 1`);
    while (!this.stopping) {
      requireOwner();
      const next = this.db.prepare(`SELECT track_id, title FROM ${this.tracks} WHERE job_id = ? AND status = 'pending' ORDER BY priority, title COLLATE NOCASE, track_id LIMIT 1`)
        .get(id) as { track_id: string; title: string } | undefined;
      if (!next) break;
      let success = false; let reused = false;
      try {
        const allowed = () => job.scope === "library" || Boolean(inOwnedPlaylist.get(job.user_id, next.track_id));
        const track = allowed() ? await this.catalog.getTrack(next.track_id) : null;
        if (track && allowed()) {
          requireOwner();
          this.db.prepare(`UPDATE ${this.jobs} SET current_track = ?, updated_at = ? WHERE id = ?`)
            .run(`${track.artistName} — ${track.title}`, new Date().toISOString(), id);
          ({ success, reused } = await this.analyze(track, parameters));
        }
      } catch (error) { if (!this.stopping) console.warn("Could not analyze library track", { trackId: next.track_id, error }); }
      if (this.stopping) return;
      this.db.transaction(() => {
        this.db.prepare(`UPDATE ${this.tracks} SET status = ? WHERE job_id = ? AND track_id = ?`).run(success ? "completed" : "failed", id, next.track_id);
        this.db.prepare(`UPDATE ${this.jobs} SET completed_tracks = completed_tracks + ?, skipped_tracks = skipped_tracks + ?, failed_tracks = failed_tracks + ?, updated_at = ? WHERE id = ?`)
          .run(Number(success), Number(success && reused), Number(!success), new Date().toISOString(), id);
      })();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!this.stopping) this.db.prepare(`UPDATE ${this.jobs} SET status = 'completed', current_track = NULL, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  async close() { this.stopping = true; await this.worker; }
}
