import type { Db } from "../../db/database.js";
import type { SessionUser } from "../../types.js";
import type { SpotifyImportJob } from "../../domain/spotify-playlist-import.js";

export type StoredImportJob = { job: SpotifyImportJob; playlistUrl: string; user: SessionUser; unreadableManifest?: string };
type JobRow = { id: string; user_id: string; manifest_json: string };

/** JSON checkpoints retain provider IDs, published paths and every entry error. */
export class SqliteImportJobRepository {
  constructor(private readonly db: Db) {}

  save(record: StoredImportJob): void {
    const job = record.job;
    if (record.user.id !== job.userId) throw new Error("Import checkpoint owner mismatch");
    const status = job.status === "queued" ? "PENDING" : job.status === "running" ? "PROCESSING"
      : job.status === "failed" || job.status === "partial" ? "FAILED" : "COMPLETED";
    const now = new Date().toISOString();
    const saved = this.db.prepare(`
      INSERT INTO import_jobs (id, user_id, status, total_tracks, completed_tracks, failed_tracks, manifest_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, total_tracks = excluded.total_tracks,
        completed_tracks = excluded.completed_tracks, failed_tracks = excluded.failed_tracks,
        manifest_json = excluded.manifest_json, updated_at = excluded.updated_at
      WHERE import_jobs.user_id = excluded.user_id
    `).run(job.id, job.userId, status, job.expectedCount || 0, job.completedCount ?? job.importedCount ?? 0,
      job.failedCount || 0, JSON.stringify(record), now, now);
    if (!saved.changes) throw new Error("Import checkpoint belongs to another user");
  }

  private decode(row: JobRow): StoredImportJob {
    try {
      const record = JSON.parse(row.manifest_json) as StoredImportJob;
      if (!record || record.job?.id !== row.id || record.job.userId !== row.user_id || record.user?.id !== row.user_id
        || !["queued", "running", "completed", "partial", "failed"].includes(record.job.status)
        || typeof record.playlistUrl !== "string"
        || (record.job.manifest !== undefined && (!Array.isArray(record.job.manifest)
          || record.job.manifest.some((entry) => !entry || !entry.source || !Number.isSafeInteger(entry.position) || typeof entry.status !== "string"))))
        throw new Error("Invalid import checkpoint");
      return record;
    } catch {
      // One unreadable checkpoint must not stop startup or discard its original evidence.
      const record: StoredImportJob = { playlistUrl: "", user: { id: row.user_id, disabled: true } as SessionUser,
        job: { id: row.id, userId: row.user_id, status: "failed", stage: "completed", error: "Stored import checkpoint is invalid; original manifest retained" },
        unreadableManifest: row.manifest_json };
      this.save(record); return record;
    }
  }

  get(id: string, userId: string): StoredImportJob | null {
    const row = this.db.prepare("SELECT id, user_id, manifest_json FROM import_jobs WHERE id = ? AND user_id = ?")
      .get(id, userId) as JobRow | undefined;
    return row ? this.decode(row) : null;
  }

  unfinished(): StoredImportJob[] {
    return (this.db.prepare("SELECT id, user_id, manifest_json FROM import_jobs WHERE status IN ('PENDING', 'PROCESSING') ORDER BY created_at, id")
      .all() as JobRow[]).map((row) => this.decode(row)).filter((record) => ["queued", "running"].includes(record.job.status));
  }
}
