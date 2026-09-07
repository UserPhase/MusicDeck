import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";

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
  constructor(private readonly db: Db) {}

  /** Resolve or create the stable MusicDeck ID for a provider item. */
  ensureId(type: LibraryItemType, ref: SourceRef): string {
    // Scoped by item type: a provider whose artwork reference is the item's
    // own ID (Jellyfin) must not collide with the item identity itself.
    const existing = this.db.prepare(`
      SELECT library_item_id AS id
      FROM library_item_sources
      WHERE connection_id = ? AND provider_item_id = ? AND item_type = ?
    `).get(ref.connectionId, ref.providerItemId, type) as { id: string } | undefined;

    if (existing) {
      return existing.id;
    }

    const now = new Date().toISOString();
    const id = type === "artwork" ? createId("mdart") : createId("md");

    this.db.prepare(
      "INSERT INTO library_items (id, type, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(id, type, now, now);
    this.db.prepare(`
      INSERT INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, type, ref.connectionId, ref.providerItemId, now);

    return id;
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
