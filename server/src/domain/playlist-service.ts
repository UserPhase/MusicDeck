import type { Db } from "../db/database.js";
import type { MusicBackend } from "../backends/music-backend.js";
import type { Playlist, SessionUser, Track } from "../types.js";
import { createId } from "../utils/ids.js";
import { getPrimaryConnectionId } from "./connections.js";
import { PlaylistCollaborationService, playlistReadPredicate, playlistViewer, type PlaylistVisibility } from "../services/PlaylistCollaborationService.js";
import { avatarUrlFor } from "../users/avatars.js";
import type { CatalogService } from "./catalog.js";
import type { LibraryService } from "./library.js";
import {
  COLLAGE_TILE_COUNT,
  PlaylistArtworkService,
  type PlaylistArtworkMode,
  type RenderedArtwork,
} from "./playlist-artwork.js";

/**
 * MusicDeck-owned playlist service.
 *
 * Playlists and their items are persisted in MusicDeck's own SQLite tables
 * (`playlists` / `playlist_items`); MusicDeck is the authoritative store for
 * composition, ordering, and ownership. Items carry a provider-scoped
 * reference (connection_id + provider_track_id) so a playlist can span
 * multiple provider connections without cross-provider ID guessing.
 *
 * Provider synchronization (Navidrome) is an optional, best-effort side
 * effect: failures never corrupt or roll back the MusicDeck-owned state.
 */

type PlaylistRow = {
  sharing_mode: PlaylistVisibility;
  sharing_revision: number;
  exclude_from_taste: number;
  id: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  source_connection_id: string | null;
  source_playlist_id: string | null;
  created_at: string;
  updated_at: string;
  edit_revision: number;
  deleted_at: string | null;
};

type PlaylistItemRow = {
  added_by_user_id: string | null;
  added_by_name: string | null;
  added_by_avatar: string | null;
  external_track_json: string | null;
  id: string;
  playlist_id: string;
  position: number;
  connection_id: string;
  provider_track_id: string;
  library_track_id: string | null;
  created_at: string;
};

function toPlaylist(
  row: PlaylistRow,
  tracks: Track[] | undefined,
  artwork: PlaylistArtworkFields
): Playlist {
  return {
    excludeFromTaste: Boolean(row.exclude_from_taste),
    sharingMode: row.sharing_mode,
    sharingRevision: row.sharing_revision,
    id: row.id,
    providerId: row.source_playlist_id || row.id,
    name: row.name,
    createdAt: row.created_at,
    editRevision: row.edit_revision,
    description: row.description,
    artworkId: artwork.artworkId,
    artworkUrl: artwork.artworkUrl,
    artworkMode: artwork.artworkMode,
    songCount: tracks ? tracks.length : 0,
    ...(tracks ? { tracks } : {}),
  };
}

type PlaylistArtworkFields = {
  artworkId: string | null;
  artworkUrl: string | null;
  artworkMode: PlaylistArtworkMode | null;
};

const NO_ARTWORK: PlaylistArtworkFields = {
  artworkId: null,
  artworkUrl: null,
  artworkMode: null,
};

export class PlaylistEditError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409) {
    super(message);
  }
}

export class PlaylistService {
  private readonly artwork: PlaylistArtworkService;
  private readonly orderSyncs = new Map<string, Promise<void>>();
  private readonly syncDirty = new Set<string>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly backend: MusicBackend,
    private readonly catalog: CatalogService,
    private readonly library: LibraryService,
    /** Used to read library cover art when rendering the automatic collage. */
    sourceResolver?: { fetchArtwork(libraryItemId: string, size?: number): Promise<{
      body: ReadableStream<Uint8Array> | null;
      status: number;
      headers: Headers;
    }> }
  ) {
    this.artwork = new PlaylistArtworkService(
      db,
      sourceResolver
        ? (artworkId, size) =>
            size === undefined
              ? sourceResolver.fetchArtwork(artworkId)
              : sourceResolver.fetchArtwork(artworkId, size)
        : undefined
    );
  }

  private getRow(playlistId: string): PlaylistRow | undefined {
    return this.db.prepare(
      "SELECT * FROM playlists WHERE id = ? AND deleted_at IS NULL"
    ).get(playlistId) as PlaylistRow | undefined;
  }

  private itemRows(playlistId: string): PlaylistItemRow[] {
    return this.db.prepare(
      `SELECT i.*,u.display_name AS added_by_name,u.avatar_updated_at AS added_by_avatar FROM playlist_items i
       LEFT JOIN users u ON u.id=i.added_by_user_id WHERE i.playlist_id = ? ORDER BY i.position ASC`
    ).all(playlistId) as PlaylistItemRow[];
  }

  /** Hydrate playlist items into full tracks via their stable MusicDeck IDs.
   * Items stored before the identity migration fall back to their
   * provider-scoped reference. Missing/unresolvable tracks are skipped
   * without failing the read. */
  private async hydrate(playlistId: string, items = this.itemRows(playlistId)): Promise<Track[]> {
    const tracks: Array<Track | null> = Array(items.length).fill(null);
    const lookups = new Map<string, Promise<Track | null>>();
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        const attribution = { playlistAddedAt: item.created_at, addedByUserId: item.added_by_user_id, addedBy: item.added_by_user_id ? {
          id: item.added_by_user_id, displayName: item.added_by_name || "Former member", avatarUrl: avatarUrlFor(item.added_by_user_id, item.added_by_avatar),
        } : null };
        if (item.external_track_json) {
          try { tracks[index] = { ...JSON.parse(item.external_track_json), ...attribution, playlistItemId: item.id }; }
          catch { /* Retain the occurrence, even if its stored metadata cannot be read. */ }
          continue;
        }
        const key = item.library_track_id ? `library:${item.library_track_id}`
          : JSON.stringify([item.connection_id, item.provider_track_id]);
        let lookup = lookups.get(key);
        if (!lookup) {
          lookup = (item.library_track_id ? this.catalog.getTrack(item.library_track_id)
            : this.backend.getTrack(item.provider_track_id)).catch(() => null);
          lookups.set(key, lookup);
        }
        const track = await lookup;
        // Keep duplicate playlist occurrences and their order, while requesting
        // repeated provider identities only once per response. An unavailable
        // item still cannot prevent the remaining playlist from loading.
        if (track) tracks[index] = { ...track, ...attribution, playlistItemId: item.id };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
    return tracks.filter((track): track is Track => track !== null);
  }

  canModify(playlistId: string, user: SessionUser): boolean {
    return new PlaylistCollaborationService(this.db).access(playlistId, user).canEditTracks;
  }
  canManage(playlistId: string, user: SessionUser): boolean { return new PlaylistCollaborationService(this.db).access(playlistId, user).canManage; }

  canRead(playlistId: string, user: SessionUser): boolean {
    return new PlaylistCollaborationService(this.db).access(playlistId, user).canRead;
  }

  private withOwner(row: PlaylistRow, tracks?: Track[], itemIds?: string[], user?: SessionUser): Playlist & { ownerUserId: string | null } {
    return {
      ...toPlaylist(row, tracks, this.artworkFields(row.id)),
      songCount: itemIds?.length ?? tracks?.length ?? (this.db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?").get(row.id) as { n: number }).n,
      ownerUserId: row.owner_user_id,
      ...(user ? { permissions: new PlaylistCollaborationService(this.db).access(row.id, user) } : {}),
      ...(tracks ? { itemIds: itemIds ?? this.itemRows(row.id).map((item) => item.id) } : {}),
    };
  }

  /**
   * Stable references for the playlist's leading tracks. Deliberately read
   * straight from SQLite (no provider hydration) so listing playlists stays
   * cheap: the collage itself is only rendered when the artwork token is
   * actually requested.
   */
  private collageTrackRefs(playlistId: string): string[] {
    const rows = this.db.prepare(`
      SELECT COALESCE(library_track_id, connection_id || ':' || provider_track_id) AS ref
      FROM playlist_items
      WHERE playlist_id = ?
      ORDER BY position ASC
      LIMIT ?
    `).all(playlistId, COLLAGE_TILE_COUNT) as Array<{ ref: string }>;

    return rows.map((row) => row.ref);
  }

  private artworkFields(playlistId: string): PlaylistArtworkFields {
    const descriptor = this.artwork.describe(playlistId, this.collageTrackRefs(playlistId));
    return descriptor || NO_ARTWORK;
  }

  /**
   * Resolve the playlist's cover art bytes. Custom artwork always wins;
   * otherwise the 2x2 collage is generated from the current first four
   * tracks. Returns null only when the playlist is unknown or empty and has
   * no custom artwork, so callers can fall back to their placeholder.
   */
  async renderArtwork(playlistId: string, user: SessionUser, size?: number): Promise<RenderedArtwork | null> {
    if (!this.canRead(playlistId, user)) {
      return null;
    }

    const custom = this.artwork.getCustom(playlistId);

    if (custom) {
      return { body: custom.data, contentType: custom.contentType };
    }

    const items = this.itemRows(playlistId).slice(0, COLLAGE_TILE_COUNT);

    if (items.length === 0) {
      return null;
    }

    const artworkIds: string[] = [];

    for (const item of items) {
      if (item.external_track_json) continue;
      try {
        const track = item.library_track_id
          ? await this.catalog.getTrack(item.library_track_id)
          : await this.backend.getTrack(item.provider_track_id);

        if (track?.artworkId) {
          artworkIds.push(track.artworkId);
        }
      } catch {
        // A track that cannot be resolved simply contributes no tile.
      }
    }

    const rendered = await this.artwork.renderCollage(artworkIds, size);
    return this.canRead(playlistId, user) ? rendered : null;
  }

  /** Replace the playlist's automatic collage with custom artwork. */
  setCustomArtwork(playlistId: string, data: Buffer, contentType: string): boolean {
    if (!this.getRow(playlistId)) {
      return false;
    }

    this.artwork.setCustom(playlistId, data, contentType);
    return true;
  }

  /** Drop custom artwork so the playlist reverts to the automatic collage. */
  clearCustomArtwork(playlistId: string): boolean {
    if (!this.getRow(playlistId)) {
      return false;
    }

    this.artwork.clearCustom(playlistId);
    return true;
  }

  async list(user: SessionUser): Promise<Array<Playlist & { ownerUserId: string | null }>> {
    // Ensure legacy provider playlists are imported once before listing.
    await this.importLegacyPlaylists();

    const rows = this.db.prepare(
      `SELECT * FROM playlists p WHERE deleted_at IS NULL AND ${playlistReadPredicate()} ORDER BY created_at ASC`
    ).all(playlistViewer(user)) as PlaylistRow[];

    return rows.map((row) => this.withOwner(row, undefined, undefined, user));
  }

  /**
   * Bounded MusicDeck-owned playlist search. Unlike provider catalog search,
   * this stays entirely in SQLite and does not hydrate playlist tracks.
   */
  async search(query: string, limit = 20, user?: SessionUser): Promise<Array<Playlist & { ownerUserId: string | null }>> {
    const value = query.trim();

    if (!value) {
      return [];
    }

    await this.importLegacyPlaylists();

    const rows = this.db.prepare(`
      SELECT * FROM playlists p
      WHERE deleted_at IS NULL AND ${playlistReadPredicate()}
        AND (name LIKE @query COLLATE NOCASE
         OR COALESCE(description, '') LIKE @query COLLATE NOCASE)
      ORDER BY updated_at DESC
      LIMIT @limit
    `).all({ ...playlistViewer(user ?? { id: "", role: "user" }), query: `%${value}%`, limit }) as PlaylistRow[];

    return rows.map((row) => this.withOwner(row, undefined, undefined, user));
  }

  async create(name: string, user: SessionUser, description?: string, importId?: string): Promise<Playlist & { ownerUserId: string | null }> {
    if (importId) {
      const existing = this.getRow(importId);
      if (existing) {
        if (existing.owner_user_id !== user.id) throw new Error("Imported playlist belongs to another user");
        return this.withOwner(existing, undefined, undefined, user);
      }
    }
    const now = new Date().toISOString();
    const id = importId || createId("mdpl");
    const connectionId = getPrimaryConnectionId(this.db);

    let providerPlaylistId: string | null = null;
    // Durable imports create their authoritative local record first. Provider
    // playlist creation cannot be made atomic with SQLite and has no idempotency key.
    if (importId) {
      this.db.prepare(`
        INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(id, user.id, name, description?.trim() || null, connectionId, now, now);
      return this.withOwner(this.getRow(id)!, [], undefined, user);
    }
    try {
      const providerPlaylist = await this.backend.createPlaylist(name);
      providerPlaylistId = providerPlaylist?.id || null;
    } catch {
      // Provider sync is best-effort; MusicDeck state remains authoritative.
    }

    this.db.prepare(`
      INSERT INTO playlists
        (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, name, description?.trim() || null, connectionId, providerPlaylistId, now, now);

    return this.withOwner(this.getRow(id)!, [], undefined, user);
  }

  /** Save a generated mix as one atomic, editable MusicDeck-owned playlist. */
  createMix(name: string, user: SessionUser, tracks: Track[]) {
    const id = createId("mdpl");
    const now = new Date().toISOString();
    const unique = [...new Map(tracks.map((track) => [track.id, track])).values()];
    const primary = getPrimaryConnectionId(this.db);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO playlists
        (id,owner_user_id,name,description,source_connection_id,source_playlist_id,created_at,updated_at)
        VALUES (?,?,?,'Generated mix',?,NULL,?,?)`).run(id, user.id, name, primary, now, now);
      const insert = this.db.prepare(`INSERT INTO playlist_items
        (id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at,external_track_json,added_by_user_id) VALUES (?,?,?,?,?,?,?,?,?)`);
      unique.forEach((track, position) => {
        const source = track.external ? null : this.library.getPrimarySource(track.id);
        insert.run(createId("mdpli"), id, position, source?.connectionId ?? primary ?? "",
          source?.providerItemId ?? track.providerId, source ? track.id : null, now, track.external ? JSON.stringify(track) : null, user.id);
      });
    })();
    return this.withOwner(this.getRow(id)!, unique);
  }

  /** Adopt a freshly scanned provider playlist without creating a duplicate upstream. */
  async adoptProviderPlaylist(providerPlaylistId: string, user: SessionUser, name?: string): Promise<Playlist & { ownerUserId: string | null }> {
    const connectionId = getPrimaryConnectionId(this.db);
    if (!connectionId) throw new Error("No library connection is available");

    const providerPlaylist = await this.backend.getPlaylist(providerPlaylistId);
    if (!providerPlaylist || !providerPlaylist.tracks?.length) {
      throw new Error("Navidrome scanned the files but did not import the playlist tracks. Check playlist auto-import and the M3U paths.");
    }

    const existing = this.db.prepare(
      "SELECT id FROM playlists WHERE source_connection_id = ? AND source_playlist_id = ?"
    ).get(connectionId, providerPlaylistId) as { id: string } | undefined;
    if (existing) new PlaylistCollaborationService(this.db).require(existing.id, user, "canManage", true);
    if (existing && !this.getRow(existing.id)) throw new PlaylistEditError("This playlist is in Trash. Restore it before importing again.", 409);
    if (!existing && this.db.prepare("SELECT 1 FROM playlist_provider_tombstones WHERE connection_id=? AND provider_playlist_id=?").get(connectionId, providerPlaylistId)) throw new PlaylistEditError("This provider playlist was deleted from MusicDeck.", 409);
    const id = existing?.id || createId("mdpl");
    const now = new Date().toISOString();
    const displayName = name?.trim() || providerPlaylist.name;

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          "UPDATE playlists SET owner_user_id = ?, name = ?, updated_at = ? WHERE id = ?"
        ).run(user.id, displayName, now, id);
        this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(id);
      } else {
        this.db.prepare(`
          INSERT INTO playlists
            (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, user.id, displayName, providerPlaylist.description, connectionId, providerPlaylistId, now, now);
      }

      providerPlaylist.tracks!.forEach((track, index) => {
        const providerTrackId = String(track.id);
        const libraryTrackId = this.library.ensureId("track", { connectionId, providerItemId: providerTrackId });
        this.db.prepare(`
          INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, added_by_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(createId("mdpli"), id, index, connectionId, providerTrackId, libraryTrackId, now, user.id);
      });
    })();

    return this.withOwner(this.getRow(id)!, providerPlaylist.tracks);
  }

  async get(playlistId: string, user: SessionUser): Promise<(Playlist & { ownerUserId: string | null }) | null> {
    const row = this.getRow(playlistId);

    if (!row || !this.canRead(playlistId, user)) {
      return null;
    }

    const items = this.itemRows(playlistId);
    const tracks = await this.hydrate(playlistId, items);
    if (!this.canRead(playlistId, user)) return null;
    return this.withOwner(this.getRow(playlistId)!, tracks, items.map((item) => item.id), user);
  }

  async update(
    playlistId: string,
    input: { name?: string; description?: string | null }
  ): Promise<(Playlist & { ownerUserId: string | null }) | null> {
    const row = this.getRow(playlistId);

    if (!row) {
      return null;
    }

    const now = new Date().toISOString();
    const name = input.name !== undefined ? input.name : row.name;
    const description = input.description !== undefined ? input.description : row.description;

    this.db.prepare(
      "UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?"
    ).run(name, description, now, playlistId);

    if (row.source_playlist_id) {
      try {
        await this.backend.updatePlaylist(row.source_playlist_id, { name, description });
      } catch {
        // Provider sync is best-effort.
      }
    }

    return this.withOwner(this.getRow(playlistId)!);
  }

  async remove(playlistId: string): Promise<boolean> {
    const row = this.getRow(playlistId);

    if (!row) {
      return false;
    }

    this.db.prepare("UPDATE playlists SET deleted_at=?,updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), playlistId);

    return true;
  }

  async addTrack(playlistId: string, trackId: string, actor?: SessionUser): Promise<{ added: boolean }> {
    if (actor) new PlaylistCollaborationService(this.db).require(playlistId, actor, "canEditTracks");
    const row = this.getRow(playlistId);

    if (!row) {
      return { added: false };
    }

    // trackId is a stable MusicDeck ID. Resolve it to the primary source's
    // provider reference for storage and provider sync.
    const source = this.library.getPrimarySource(trackId);
    const libraryTrackId = source ? trackId : null;
    const connectionId = source?.connectionId ?? (getPrimaryConnectionId(this.db) ?? "");
    const providerTrackId = source?.providerItemId ?? trackId;

    const existing = this.db.prepare(
      "SELECT id FROM playlist_items WHERE playlist_id = ? AND connection_id = ? AND provider_track_id = ?"
    ).get(playlistId, connectionId, providerTrackId);

    if (existing) {
      return { added: false };
    }

    const position = (this.db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = ?"
    ).get(playlistId) as { next: number }).next;

    this.db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, added_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createId("mdpli"), playlistId, position, connectionId, providerTrackId, libraryTrackId, new Date().toISOString(), actor?.id ?? row.owner_user_id);

    if (row.source_playlist_id) {
      try {
        await this.backend.addTrackToPlaylist(row.source_playlist_id, providerTrackId);
      } catch {
        // Provider sync is best-effort.
      }
    }

    return { added: true };
  }

  /** Link a track returned by the primary catalog provider to a MusicDeck playlist. */
  hasProviderTrack(playlistId: string, providerTrackId: string): boolean {
    const connectionId = getPrimaryConnectionId(this.db);
    return Boolean(connectionId && this.db.prepare(
      "SELECT id FROM playlist_items WHERE playlist_id = ? AND connection_id = ? AND provider_track_id = ?"
    ).get(playlistId, connectionId, providerTrackId));
  }

  async addProviderTrack(playlistId: string, providerTrackId: string): Promise<{ added: boolean }> {
    const connectionId = getPrimaryConnectionId(this.db);
    if (!connectionId || !this.getRow(playlistId)) return { added: false };
    const libraryTrackId = this.library.ensureId("track", { connectionId, providerItemId: providerTrackId });
    return this.addTrack(playlistId, libraryTrackId);
  }

  async removeItem(playlistId: string, trackId: string): Promise<boolean> {
    const row = this.getRow(playlistId);

    if (!row) {
      return false;
    }

    // Resolve the stable MusicDeck ID to the stored item, falling back to a
    // raw provider track ID for pre-migration items.
    const source = this.library.getPrimarySource(trackId);
    const exactItem = this.db.prepare(
      "SELECT id, position, provider_track_id FROM playlist_items WHERE playlist_id = ? AND id = ?"
    ).get(playlistId, trackId) as { id: string; position: number; provider_track_id: string } | undefined;
    const item = exactItem ?? (source
      ? this.db.prepare(
          "SELECT id, position FROM playlist_items WHERE playlist_id = ? AND library_track_id = ? ORDER BY position ASC LIMIT 1"
        ).get(playlistId, trackId) as { id: string; position: number } | undefined
      : this.db.prepare(
          "SELECT id, position FROM playlist_items WHERE playlist_id = ? AND provider_track_id = ? ORDER BY position ASC LIMIT 1"
        ).get(playlistId, trackId) as { id: string; position: number } | undefined);

    if (!item) {
      return false;
    }

    this.db.prepare("DELETE FROM playlist_items WHERE id = ?").run(item.id);
    this.db.prepare(
      "UPDATE playlist_items SET position = position - 1 WHERE playlist_id = ? AND position > ?"
    ).run(playlistId, item.position);

    if (exactItem && row.source_playlist_id) {
      await this.syncOrder(row);
    } else if (row.source_playlist_id) {
      try {
        await this.backend.removePlaylistItem(row.source_playlist_id, source?.providerItemId ?? trackId);
      } catch {
        // Provider sync is best-effort.
      }
    }

    return true;
  }

  private assertOrder(items: PlaylistItemRow[], expected: string[]): void {
    if (items.length !== expected.length || items.some((item, index) => item.id !== expected[index])) {
      throw new PlaylistEditError("This playlist changed elsewhere. Reload it before editing again.", 409);
    }
  }

  private async syncOrder(row: PlaylistRow): Promise<void> {
    if (!row.source_playlist_id) return;
    const pending = (this.orderSyncs.get(row.id) ?? Promise.resolve()).then(async () => {
      if (this.closing) return;
      const current = this.getRow(row.id);
      if (!current?.source_playlist_id) return;
      const trackIds = this.itemRows(row.id).map((item) => item.provider_track_id);
      try {
        await this.backend.updatePlaylist(current.source_playlist_id, { name: current.name, description: current.description });
        if (!this.closing) await this.backend.reorderPlaylistTracks(current.source_playlist_id, trackIds);
      } catch (error) {
        console.warn("Playlist provider synchronization failed; the local edit is saved:", error);
      }
    });
    this.orderSyncs.set(row.id, pending);
    try {
      await pending;
    } finally {
      if (this.orderSyncs.get(row.id) === pending) {
        this.orderSyncs.delete(row.id);
        if (this.syncDirty.delete(row.id) && !this.closing) void this.synchronize(row.id).catch(error => console.warn("Playlist synchronization failed:", error));
      }
    }
  }

  async synchronize(playlistId: string): Promise<void> {
    if (this.closing) return;
    if (this.orderSyncs.has(playlistId)) { this.syncDirty.add(playlistId); return; }
    const row = this.getRow(playlistId);
    if (row) await this.syncOrder(row);
  }

  async close(): Promise<void> {
    this.closing = true; this.syncDirty.clear();
    await Promise.allSettled([...this.orderSyncs.values()]);
  }

  /** Exact occurrence permutation with compare-and-swap, checked inside the write transaction. */
  async reorderItems(playlistId: string, itemIds: string[], expectedItemIds: string[]) {
    const row = this.getRow(playlistId);
    if (!row) return null;
    this.db.transaction(() => {
      const items = this.itemRows(playlistId);
      this.assertOrder(items, expectedItemIds);
      const known = new Set(items.map((item) => item.id));
      if (itemIds.length !== items.length || new Set(itemIds).size !== items.length || itemIds.some((id) => !known.has(id))) {
        throw new PlaylistEditError("Reorder must contain every playlist entry exactly once.", 400);
      }
      const update = this.db.prepare("UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?");
      itemIds.forEach((id, index) => update.run(index, playlistId, id));
      this.db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), playlistId);
    })();
    await this.syncOrder(row);
    const updatedRow = this.getRow(playlistId);
    if (!updatedRow) return null;
    const items = this.itemRows(playlistId);
    return this.withOwner(updatedRow, await this.hydrate(playlistId, items), items.map((item) => item.id));
  }

  async editTracks(playlistId: string, edit:
    | { action: "add"; trackIds: string[] }
    | { action: "remove"; itemIds: string[]; expectedItemIds: string[] }, actor?: SessionUser) {
    const row = this.getRow(playlistId);
    if (!row) return null;
    this.db.transaction(() => {
      if (actor) new PlaylistCollaborationService(this.db).require(playlistId, actor, "canEditTracks");
      const items = this.itemRows(playlistId);
      if (edit.action === "remove") {
        this.assertOrder(items, edit.expectedItemIds);
        const selected = new Set(edit.itemIds);
        const known = new Set(items.map((item) => item.id));
        if (selected.size !== edit.itemIds.length || edit.itemIds.some((id) => !known.has(id))) {
          throw new PlaylistEditError("Selected entries do not belong to this playlist.", 400);
        }
        const remove = this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?");
        selected.forEach((id) => remove.run(playlistId, id));
        const update = this.db.prepare("UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?");
        items.filter((item) => !selected.has(item.id)).forEach((item, index) => update.run(index, playlistId, item.id));
      } else {
        const existing = new Set(items.map((item) => JSON.stringify([item.connection_id, item.provider_track_id])));
        const insert = this.db.prepare(`INSERT INTO playlist_items
          (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at, added_by_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        let position = items.length;
        for (const trackId of edit.trackIds) {
          const source = this.library.getPrimarySource(trackId);
          const connectionId = source?.connectionId ?? getPrimaryConnectionId(this.db) ?? "";
          const providerId = source?.providerItemId ?? trackId;
          const key = JSON.stringify([connectionId, providerId]);
          if (existing.has(key)) continue;
          existing.add(key);
          insert.run(createId("mdpli"), playlistId, position++, connectionId, providerId, source ? trackId : null, new Date().toISOString(), actor?.id ?? row.owner_user_id);
        }
      }
      this.db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), playlistId);
    })();
    await this.syncOrder(row);
    const updatedRow = this.getRow(playlistId);
    if (!updatedRow) return null;
    const items = this.itemRows(playlistId);
    const tracks = await this.hydrate(playlistId, items);
    if (actor && !this.canRead(playlistId, actor)) return null;
    return this.withOwner(updatedRow, tracks, items.map((item) => item.id), actor);
  }

  async reorder(playlistId: string, trackIds: string[]): Promise<(Playlist & { ownerUserId: string | null }) | null> {
    const row = this.getRow(playlistId);

    if (!row) {
      return null;
    }

    const items = this.itemRows(playlistId);
    // Index by stable MusicDeck ID (post-migration) and by provider track ID
    // (pre-migration fallback) so reorder accepts whichever the client holds.
    const byLibraryId = new Map(
      items.filter((item) => item.library_track_id).map((item) => [item.library_track_id as string, item])
    );
    const byProviderId = new Map(items.map((item) => [item.provider_track_id, item]));

    // Reorder known items in the order given; unknown IDs are ignored.
    const ordered = trackIds
      .map((trackId) => byLibraryId.get(trackId) || byProviderId.get(trackId))
      .filter((item): item is PlaylistItemRow => Boolean(item));

    const now = new Date().toISOString();
    ordered.forEach((item, index) => {
      this.db.prepare(
        "UPDATE playlist_items SET position = ? WHERE id = ?"
      ).run(index, item.id);
    });
    this.db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);

    if (row.source_playlist_id) {
      try {
        await this.backend.reorderPlaylistTracks(
          row.source_playlist_id,
          ordered.map((item) => item.provider_track_id)
        );
      } catch {
        // Provider sync is best-effort.
      }
    }

    const tracks = await this.hydrate(playlistId);
    return this.withOwner(this.getRow(playlistId)!, tracks);
  }

  /**
   * One-time import of legacy provider-backed playlists into MusicDeck-owned
   * storage. Idempotent via the source_connection_id/source_playlist_id
   * marker; a playlist already imported is never re-imported.
   */
  async importLegacyPlaylists(): Promise<void> {
    const connectionId = getPrimaryConnectionId(this.db);

    if (!connectionId) {
      return;
    }

    let providerPlaylists: Playlist[];
    try {
      providerPlaylists = await this.backend.listPlaylists();
    } catch {
      // Provider unreachable; nothing to import right now.
      return;
    }

    for (const providerPlaylist of providerPlaylists) {
      if (this.db.prepare("SELECT 1 FROM playlist_provider_tombstones WHERE connection_id=? AND provider_playlist_id=?").get(connectionId, providerPlaylist.id)) continue;
      const existing = this.db.prepare(
        "SELECT id FROM playlists WHERE source_connection_id = ? AND source_playlist_id = ?"
      ).get(connectionId, providerPlaylist.id);

      if (existing) {
        continue;
      }

      const now = new Date().toISOString();
      const id = createId("mdpl");

      this.db.prepare(`
        INSERT INTO playlists
          (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(id, providerPlaylist.name, providerPlaylist.description, connectionId, providerPlaylist.id, now, now);
      this.db.prepare("UPDATE playlists SET sharing_mode='PUBLIC_SERVER' WHERE id=?").run(id);

      const tracks = providerPlaylist.tracks || [];
      tracks.forEach((track, index) => {
        const libraryTrackId = this.library.ensureId("track", {
          connectionId,
          providerItemId: String(track.id),
        });

        this.db.prepare(`
          INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(createId("mdpli"), id, index, connectionId, String(track.id), libraryTrackId, now);
      });
    }
  }
}
