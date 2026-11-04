import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeMusicPath } from "../services/media/safeMusicPath.js";
import { readContentRevision, type TrackContentHint } from "../services/media/contentRevision.js";

export type LibraryItemType = "track" | "album" | "artist" | "artwork";

export type SourceRef = {
  connectionId: string;
  providerItemId: string;
};

/**
 * MusicDeck-owned identity mapping for catalog entities.
 *
 * Maps a provider-scoped reference (connection_id + provider_item_id) to a
 * stable MusicDeck `md_` ID, and back. Mappings are created once and reused,
 * so repeated catalog reads do not create duplicate rows. No cross-provider
 * matching/dedup is performed: the same song from two connections maps to
 * two distinct MusicDeck items until a later matching phase.
 */
export class LibraryService {
  constructor(private readonly db: Db, private readonly options: { musicRoot?: string } = {}) {}

  /** Resolve or create the stable MusicDeck ID for a provider item. */
  ensureId(type: LibraryItemType, ref: SourceRef, content?: TrackContentHint): string {
    // Scoped by item type: a provider whose artwork reference is the item's
    // own ID (Jellyfin) must not collide with the item identity itself.
    const existing = this.db.prepare(`
      SELECT library_item_id AS id
      FROM library_item_sources
      WHERE connection_id = ? AND provider_item_id = ? AND item_type = ?
    `).get(ref.connectionId, ref.providerItemId, type) as { id: string } | undefined;

    if (existing) {
      if (type === "track" && content) this.observeContent(existing.id, ref, content);
      return existing.id;
    }

    const now = new Date().toISOString();
    const id = type === "artwork" ? createId("mdart") : createId("md");

    this.db.prepare(
      "INSERT INTO library_items (id, type, created_at, updated_at, content_revision) VALUES (?, ?, ?, ?, ?)"
    ).run(id, type, now, now, type === "track" ? randomUUID() : "");
    this.db.prepare(`
      INSERT INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, type, ref.connectionId, ref.providerItemId, now);
    if (type === "track") {
      if (content) this.observeContent(id, ref, content);
    }
    return id;
  }

  getContentRevision(trackId: string): string | null { return readContentRevision(this.db, trackId); }

  private invalidateContent(trackId: string): void {
    this.db.prepare("UPDATE library_items SET content_revision = ?, updated_at = ? WHERE id = ? AND type = 'track'")
      .run(randomUUID(), new Date().toISOString(), trackId);
    // Also clear the legacy, unversioned response used by older clients.
    this.db.prepare("DELETE FROM track_silence_analysis WHERE track_id = ?").run(trackId);
    this.db.prepare("DELETE FROM track_silence_analysis_profiles WHERE track_id = ?").run(trackId);
  }

  private observeContent(trackId: string, ref: SourceRef, hint: TrackContentHint): void {
    this.db.transaction(() => {
      const previous = this.db.prepare(`SELECT content_fingerprint, content_metadata_json, file_path FROM library_item_sources
        WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?`)
        .get(trackId, ref.connectionId, ref.providerItemId) as { content_fingerprint: string | null; content_metadata_json: string | null; file_path: string | null };
      // Some provider endpoints return less metadata than others. Merge known
      // attributes so a sparse chart response cannot invalidate a full detail read.
      const attributes = hint.attributes ? { ...JSON.parse(previous.content_metadata_json ?? "{}"), ...hint.attributes } : null;
      const metadata = attributes ? JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)))) : null;
      const fingerprint = metadata ? createHash("sha256").update(metadata).digest("hex") : hint.fingerprint;
      if ((fingerprint && previous.content_fingerprint !== fingerprint)
        || (hint.filePath && previous.file_path && hint.filePath !== previous.file_path)) this.invalidateContent(trackId);
      this.db.prepare(`UPDATE library_item_sources SET content_fingerprint = COALESCE(?, content_fingerprint),
        content_metadata_json = COALESCE(?, content_metadata_json), file_path = COALESCE(?, file_path)
        WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?`)
        .run(fingerprint ?? null, metadata, hint.filePath ?? null, trackId, ref.connectionId, ref.providerItemId);
    })();
  }

  /** File metadata avoids reading/decoding an entire song on its playback path. */
  async refreshContentRevision(trackId: string, connectionId?: string): Promise<string | null> {
    if (!this.options.musicRoot) return this.getContentRevision(trackId);
    const sources = this.db.prepare(`SELECT connection_id, provider_item_id, file_path, file_fingerprint
      FROM library_item_sources WHERE library_item_id = ? AND item_type = 'track'
      ${connectionId ? "AND connection_id = ?" : ""}`)
      .all(...(connectionId ? [trackId, connectionId] : [trackId])) as Array<{
        connection_id: string; provider_item_id: string; file_path: string | null; file_fingerprint: string | null;
      }>;
    for (const source of sources) {
      if (!source.file_path) continue;
      let fingerprint: string;
      try {
        const file = safeMusicPath(this.options.musicRoot, path.resolve(this.options.musicRoot, source.file_path));
        const physical = await fs.realpath(file);
        const realRoot = await fs.realpath(this.options.musicRoot);
        const relative = path.relative(realRoot, physical);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File resolves outside the music root");
        const stat = await fs.stat(physical, { bigint: true });
        if (!stat.isFile()) throw new Error("Track path is not a regular file");
        fingerprint = createHash("sha256").update([physical, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex");
      } catch (error) {
        // Remote-only paths are common. A formerly observed local file becoming
        // inaccessible must invalidate its analysis, without blocking playback.
        if (!source.file_fingerprint) continue;
        fingerprint = `unavailable:${(error as NodeJS.ErrnoException).code ?? "path"}`;
      }
      this.db.transaction(() => {
        // Compare against the current value, not the snapshot before async I/O.
        const current = this.db.prepare(`SELECT file_fingerprint FROM library_item_sources
          WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?`)
          .get(trackId, source.connection_id, source.provider_item_id) as { file_fingerprint: string | null } | undefined;
        if (current && current.file_fingerprint !== fingerprint) {
          this.invalidateContent(trackId);
          this.db.prepare(`UPDATE library_item_sources SET file_fingerprint = ?
            WHERE library_item_id = ? AND connection_id = ? AND provider_item_id = ?`)
            .run(fingerprint, trackId, source.connection_id, source.provider_item_id);
        }
      })();
    }
    return this.getContentRevision(trackId);
  }

  /** A completed provider rescan is an explicit revision boundary, even if
   * that server cannot report file size, modification time or a local path. */
  invalidateConnectionContent(connectionId: string): void {
    const tracks = "SELECT library_item_id FROM library_item_sources WHERE connection_id = ? AND item_type = 'track'";
    this.db.transaction(() => {
      this.db.prepare(`UPDATE library_items SET content_revision = lower(hex(randomblob(16))), updated_at = ?
        WHERE type = 'track' AND id IN (${tracks})`).run(new Date().toISOString(), connectionId);
      this.db.prepare(`DELETE FROM track_silence_analysis WHERE track_id IN (${tracks})`).run(connectionId);
      this.db.prepare(`DELETE FROM track_silence_analysis_profiles WHERE track_id IN (${tracks})`).run(connectionId);
    })();
  }

  /** Resolve or create the stable MusicDeck artwork ID for a provider artwork reference. */
  ensureArtworkId(ref: SourceRef): string {
    return this.ensureId("artwork", ref);
  }

  /** All provider sources for a MusicDeck ID, in insertion order. */
  getSources(libraryItemId: string): SourceRef[] {
    const rows = this.db.prepare(`
      SELECT connection_id AS connectionId, provider_item_id AS providerItemId
      FROM library_item_sources
      WHERE library_item_id = ?
      ORDER BY created_at ASC
    `).all(libraryItemId) as Array<{ connectionId: string; providerItemId: string }>;

    return rows.map((row) => ({ connectionId: row.connectionId, providerItemId: row.providerItemId }));
  }

  /** The primary (first-mapped) source for a MusicDeck ID, or null. */
  getPrimarySource(libraryItemId: string): SourceRef | null {
    return this.getSources(libraryItemId)[0] || null;
  }

  /** The MusicDeck ID's item type, or null when unknown. */
  getItemType(libraryItemId: string): string | null {
    const row = this.db.prepare(
      "SELECT type FROM library_items WHERE id = ?"
    ).get(libraryItemId) as { type: string } | undefined;

    return row?.type ?? null;
  }

  /**
   * Attach an additional provider source to an existing MusicDeck item (e.g.
   * the same track on a second connection). The MusicDeck item must already
   * exist; its type scopes the new source mapping.
   */
  addSource(libraryItemId: string, ref: SourceRef): void {
    const type = this.getItemType(libraryItemId);

    if (!type) {
      throw new Error(`Unknown library item: ${libraryItemId}`);
    }

    this.db.prepare(`
      INSERT OR IGNORE INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(libraryItemId, type, ref.connectionId, ref.providerItemId, new Date().toISOString());
  }

  /** Whether a MusicDeck ID exists. */
  exists(libraryItemId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT id FROM library_items WHERE id = ?").get(libraryItemId)
    );
  }
}
