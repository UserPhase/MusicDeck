import type { Db } from "../db/database.js";
import type { MusicBackend } from "../backends/music-backend.js";
import type { Playlist, SessionUser, Track } from "../types.js";
import { createId } from "../utils/ids.js";
import { getPrimaryConnectionId } from "./connections.js";
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
  id: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  source_connection_id: string | null;
  source_playlist_id: string | null;
  created_at: string;
  updated_at: string;
};

type PlaylistItemRow = {
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
    id: row.id,
    providerId: row.source_playlist_id || row.id,
    name: row.name,
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

export class PlaylistService {
  private readonly artwork: PlaylistArtworkService;

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
      "SELECT * FROM playlists WHERE id = ?"
    ).get(playlistId) as PlaylistRow | undefined;
  }

  private itemRows(playlistId: string): PlaylistItemRow[] {
    return this.db.prepare(
      "SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC"
    ).all(playlistId) as PlaylistItemRow[];
  }

  /** Hydrate playlist items into full tracks via their stable MusicDeck IDs.
   * Items stored before the identity migration fall back to their
   * provider-scoped reference. Missing/unresolvable tracks are skipped
   * without failing the read. */
  private async hydrate(playlistId: string): Promise<Track[]> {
    const items = this.itemRows(playlistId);
    const tracks: Track[] = [];

    for (const item of items) {
      try {
        const track = item.library_track_id
          ? await this.catalog.getTrack(item.library_track_id)
          : await this.backend.getTrack(item.provider_track_id);
        if (track) {
          tracks.push(track);
        }
      } catch {
        // Provider unreachable for this item; skip without failing the read.
      }
    }

    return tracks;
  }

  canModify(playlistId: string, user: SessionUser): boolean {
    if (user.role === "admin") {
      return true;
    }

    const row = this.getRow(playlistId);
    if (!row) {
      return false;
    }

    // Unowned (legacy/imported) playlists remain modifiable by any user,
    // matching the previous legacy-unowned compatibility behavior.
    if (!row.owner_user_id) {
      return true;
    }

    return row.owner_user_id === user.id;
  }

  private withOwner(row: PlaylistRow, tracks?: Track[]): Playlist & { ownerUserId: string | null } {
    return {
      ...toPlaylist(row, tracks, this.artworkFields(row.id)),
      ownerUserId: row.owner_user_id,
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
  async renderArtwork(playlistId: string, size?: number): Promise<RenderedArtwork | null> {
    if (!this.getRow(playlistId)) {
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

    return this.artwork.renderCollage(artworkIds, size);
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

  async list(): Promise<Array<Playlist & { ownerUserId: string | null }>> {
    // Ensure legacy provider playlists are imported once before listing.
    await this.importLegacyPlaylists();

    const rows = this.db.prepare(
      "SELECT * FROM playlists ORDER BY created_at ASC"
    ).all() as PlaylistRow[];

    return rows.map((row) => this.withOwner(row));
  }

  /**
   * Bounded MusicDeck-owned playlist search. Unlike provider catalog search,
   * this stays entirely in SQLite and does not hydrate playlist tracks.
   */
  async search(query: string, limit = 20): Promise<Array<Playlist & { ownerUserId: string | null }>> {
    const value = query.trim();

    if (!value) {
      return [];
    }

    await this.importLegacyPlaylists();

    const rows = this.db.prepare(`
      SELECT * FROM playlists
      WHERE name LIKE ? COLLATE NOCASE
         OR COALESCE(description, '') LIKE ? COLLATE NOCASE
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(`%${value}%`, `%${value}%`, limit) as PlaylistRow[];

    return rows.map((row) => this.withOwner(row));
  }

  async create(name: string, user: SessionUser): Promise<Playlist & { ownerUserId: string | null }> {
    const now = new Date().toISOString();
    const id = createId("mdpl");
    const connectionId = getPrimaryConnectionId(this.db);

    let providerPlaylistId: string | null = null;
    try {
      const providerPlaylist = await this.backend.createPlaylist(name);
      providerPlaylistId = providerPlaylist?.id || null;
    } catch {
      // Provider sync is best-effort; MusicDeck state remains authoritative.
    }

    this.db.prepare(`
      INSERT INTO playlists
        (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(id, user.id, name, connectionId, providerPlaylistId, now, now);

    return this.withOwner(this.getRow(id)!, []);
  }

  async get(playlistId: string): Promise<(Playlist & { ownerUserId: string | null }) | null> {
    const row = this.getRow(playlistId);

    if (!row) {
      return null;
    }

    const tracks = await this.hydrate(playlistId);
    return this.withOwner(row, tracks);
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

    this.db.prepare("DELETE FROM playlists WHERE id = ?").run(playlistId);

    if (row.source_playlist_id) {
      try {
        await this.backend.deletePlaylist(row.source_playlist_id);
      } catch {
        // Provider sync is best-effort.
      }
    }

    return true;
  }

  async addTrack(playlistId: string, trackId: string): Promise<{ added: boolean }> {
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
      INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createId("mdpli"), playlistId, position, connectionId, providerTrackId, libraryTrackId, new Date().toISOString());

    if (row.source_playlist_id) {
      try {
        await this.backend.addTrackToPlaylist(row.source_playlist_id, providerTrackId);
      } catch {
        // Provider sync is best-effort.
      }
    }

    return { added: true };
  }

  async removeItem(playlistId: string, trackId: string): Promise<boolean> {
    const row = this.getRow(playlistId);

    if (!row) {
      return false;
    }

    // Resolve the stable MusicDeck ID to the stored item, falling back to a
    // raw provider track ID for pre-migration items.
    const source = this.library.getPrimarySource(trackId);
    const item = source
      ? this.db.prepare(
          "SELECT id, position FROM playlist_items WHERE playlist_id = ? AND library_track_id = ? ORDER BY position ASC LIMIT 1"
        ).get(playlistId, trackId) as { id: string; position: number } | undefined
      : this.db.prepare(
          "SELECT id, position FROM playlist_items WHERE playlist_id = ? AND provider_track_id = ? ORDER BY position ASC LIMIT 1"
        ).get(playlistId, trackId) as { id: string; position: number } | undefined;

    if (!item) {
      return false;
    }

    this.db.prepare("DELETE FROM playlist_items WHERE id = ?").run(item.id);
    this.db.prepare(
      "UPDATE playlist_items SET position = position - 1 WHERE playlist_id = ? AND position > ?"
    ).run(playlistId, item.position);

    if (row.source_playlist_id) {
      try {
        await this.backend.removePlaylistItem(row.source_playlist_id, source?.providerItemId ?? trackId);
      } catch {
        // Provider sync is best-effort.
      }
    }

    return true;
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
