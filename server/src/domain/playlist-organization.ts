import { createHash } from "node:crypto";
import type { Db } from "../db/database.js";
import type { SessionUser, Track } from "../types.js";
import type { LibraryService } from "./library.js";
import { createId } from "../utils/ids.js";
import { PlaylistCollaborationService, playlistReadPredicate, playlistViewer } from "../services/PlaylistCollaborationService.js";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEPTH = 16, MAX_ITEMS = 20_000;
export class PlaylistOrganizationError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 410) { super(message); }
}
export interface PlaylistFolder { id: string; name: string; parent_folder_id: string | null; user_id: string; pinned: boolean; position: number }
interface FolderRow extends Omit<PlaylistFolder, "pinned"> { pinned: number }
interface PlaylistTreeRow { id: string; name: string; ownerUserId: string | null; createdAt: string; creator: string | null; folderId: string | null; pinned: number; position: number; pinPosition: number | null }
interface PlaylistRow { id: string; owner_user_id: string | null; name: string; description: string | null; deleted_at: string | null; edit_revision: number }
interface Entry { id: string; playlist_id: string; position: number; connection_id: string; provider_track_id: string; library_track_id: string | null; created_at: string; external_track_json?: string | null; added_by_user_id?: string | null }
type Delta = { kind: "order"; ids: string[] } | { kind: "remove"; ids: string[] } | { kind: "insert"; items: Entry[] }
  | { kind: "details"; name: string; description: string | null } | { kind: "trash"; at: string | null };
export type PlaylistEdit = { kind: "reorder"; itemIds: string[]; expectedItemIds: string[] }
  | { kind: "remove"; itemIds: string[]; expectedItemIds?: string[] }
  | { kind: "add"; trackIds: string[] }
  | { kind: "details"; name?: string; description?: string | null }
  | { kind: "trash" } | { kind: "restore" };
interface StoredCommand { id: string; user_id: string; playlist_id: string; label: string; before_hash: string; after_hash: string; forward_json: string; inverse_json: string; state: "done" | "undone" }

export function playlistSearchText(track: Partial<Track>): string {
  return [track.title, track.artistName, track.albumName, ...(track.genres || [])].join(" ").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** All writes are short synchronous SQLite transactions. No provider requests run under a write lock. */
export class PlaylistOrganizationService {
  constructor(private readonly db: Db, private readonly library: LibraryService, private readonly now = Date.now) {}
  private row(id: string, user: SessionUser, allowTrash = false, write = false): PlaylistRow {
    const row = this.db.prepare("SELECT id,owner_user_id,name,description,deleted_at,edit_revision FROM playlists WHERE id=?").get(id) as PlaylistRow | undefined;
    const access = new PlaylistCollaborationService(this.db).access(id, user, allowTrash);
    if (!row || !access.canRead) throw new PlaylistOrganizationError(write ? "Playlist edit access denied." : "Playlist not found.", write ? 403 : 404);
    if (write && !access.canEditTracks) throw new PlaylistOrganizationError("Collaborator access is required to edit tracks.", 403);
    if (row.deleted_at && (!allowTrash || this.now() - Date.parse(row.deleted_at) >= TRASH_RETENTION_MS)) throw new PlaylistOrganizationError(allowTrash ? "This playlist's recovery period has expired." : "Playlist is in Trash.", allowTrash ? 410 : 404);
    return row;
  }
  private entries(id: string) { return this.db.prepare("SELECT * FROM playlist_items WHERE playlist_id=? ORDER BY position,id").all(id) as Entry[]; }
  private fingerprint(row: PlaylistRow): string {
    return createHash("sha256").update(JSON.stringify([row.name, row.description, row.deleted_at, this.entries(row.id)])).digest("hex");
  }
  private checkRevision(actual: number, expected: number) {
    if (actual !== expected) throw new PlaylistOrganizationError("This playlist changed elsewhere. Reload it before editing or undoing.", 409);
  }
  state(user: SessionUser, id: string) {
    const row = this.row(id, user, true, true);
    return { revision: row.edit_revision, itemIds: this.entries(id).map(item => item.id), deletedAt: row.deleted_at };
  }
  private assertOrder(items: Entry[], expected?: string[]) {
    if (expected && (items.length !== expected.length || items.some((item, i) => item.id !== expected[i]))) throw new PlaylistOrganizationError("The playlist's track order changed. Reload before editing.", 409);
  }
  private apply(id: string, delta: Delta) {
    const items = this.entries(id);
    if (delta.kind === "details") this.db.prepare("UPDATE playlists SET name=?,description=? WHERE id=?").run(delta.name, delta.description, id);
    else if (delta.kind === "trash") this.db.prepare("UPDATE playlists SET deleted_at=? WHERE id=?").run(delta.at, id);
    else {
      let order: Entry[];
      if (delta.kind === "order") {
        const byId = new Map(items.map(item => [item.id, item]));
        if (new Set(delta.ids).size !== items.length || delta.ids.length !== items.length || delta.ids.some(key => !byId.has(key))) throw new PlaylistOrganizationError("Reorder must contain every entry exactly once.", 400);
        order = delta.ids.map(key => byId.get(key)!);
      } else if (delta.kind === "remove") {
        const ids = new Set(delta.ids), known = new Set(items.map(item => item.id));
        if (ids.size !== delta.ids.length || delta.ids.some(key => !known.has(key))) throw new PlaylistOrganizationError("An entry is no longer in this playlist.", 409);
        const remove = this.db.prepare("DELETE FROM playlist_items WHERE playlist_id=? AND id=?");
        ids.forEach(key => remove.run(id, key)); order = items.filter(item => !ids.has(item.id));
      } else {
        if (items.length + delta.items.length > MAX_ITEMS) throw new PlaylistOrganizationError("A playlist can contain at most 20,000 entries.", 400);
        order = [...items];
        const insert = this.db.prepare("INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at,external_track_json,added_by_user_id) VALUES(?,?,?,?,?,?,?,?,?)");
        for (const item of [...delta.items].sort((a, b) => a.position - b.position)) {
          const contributor = item.added_by_user_id && this.db.prepare("SELECT 1 FROM users WHERE id=?").get(item.added_by_user_id) ? item.added_by_user_id : null;
          insert.run(item.id, id, item.position, item.connection_id, item.provider_track_id, item.library_track_id, item.created_at, item.external_track_json ?? null, contributor);
          order.splice(Math.min(item.position, order.length), 0, item);
        }
      }
      const update = this.db.prepare("UPDATE playlist_items SET position=? WHERE id=? AND playlist_id=? AND position<>?");
      order.forEach((item, position) => update.run(position, item.id, id, position));
    }
    this.db.prepare("UPDATE playlists SET updated_at=?,edit_revision=edit_revision+1 WHERE id=?").run(new Date(this.now()).toISOString(), id);
  }
  execute(user: SessionUser, id: string, expectedRevision: number, edit: PlaylistEdit) {
    return this.db.transaction(() => {
      const row = this.row(id, user, edit.kind === "restore", true);
      if (["details", "trash", "restore"].includes(edit.kind) && !new PlaylistCollaborationService(this.db).access(id, user, edit.kind === "restore").canManage)
        throw new PlaylistOrganizationError("Only the owner can manage playlist details and Trash.", 403);
      this.checkRevision(row.edit_revision, expectedRevision);
      const items = this.entries(id), before = this.fingerprint(row);
      let forward: Delta, inverse: Delta, label: string;
      switch (edit.kind) {
        case "reorder":
          this.assertOrder(items, edit.expectedItemIds);
          forward = { kind: "order", ids: edit.itemIds }; inverse = { kind: "order", ids: items.map(item => item.id) }; label = "Tracks reordered"; break;
        case "remove": {
          this.assertOrder(items, edit.expectedItemIds);
          const ids = new Set(edit.itemIds);
          forward = { kind: "remove", ids: edit.itemIds }; inverse = { kind: "insert", items: items.filter(item => ids.has(item.id)) }; label = `${ids.size === 1 ? "Track" : "Tracks"} removed`; break;
        }
        case "add": {
          const known = new Set(items.map(item => JSON.stringify([item.connection_id, item.provider_track_id])));
          const added: Entry[] = [];
          for (const trackId of edit.trackIds) {
            const source = this.library.getPrimarySource(trackId);
            if (!source) throw new PlaylistOrganizationError("A selected track is not in the library. Import it before adding it.", 400);
            const key = JSON.stringify([source.connectionId, source.providerItemId]);
            if (known.has(key)) continue; known.add(key);
            added.push({ id: createId("mdpli"), playlist_id: id, position: items.length + added.length, connection_id: source.connectionId,
              provider_track_id: source.providerItemId, library_track_id: trackId, created_at: new Date(this.now()).toISOString(), added_by_user_id: user.id });
          }
          forward = { kind: "insert", items: added }; inverse = { kind: "remove", ids: added.map(item => item.id) }; label = `${added.length === 1 ? "Track" : "Tracks"} added`; break;
        }
        case "details":
          forward = { kind: "details", name: edit.name ?? row.name, description: edit.description === undefined ? row.description : edit.description };
          inverse = { kind: "details", name: row.name, description: row.description }; label = "Playlist details updated"; break;
        case "trash": case "restore":
          forward = { kind: "trash", at: edit.kind === "trash" ? new Date(this.now()).toISOString() : null };
          inverse = { kind: "trash", at: row.deleted_at }; label = edit.kind === "trash" ? "Playlist moved to Trash" : "Playlist restored"; break;
      }
      this.apply(id, forward);
      const after = this.row(id, user, true, true), afterHash = this.fingerprint(after);
      if (before === afterHash) return { command: null, revision: after.edit_revision, deletedAt: after.deleted_at };
      const commandId = createId("plcmd");
      this.db.prepare(`INSERT INTO playlist_edit_commands(id,user_id,playlist_id,label,before_hash,after_hash,forward_json,inverse_json,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,'done',?)`).run(commandId, user.id, id, label, before, afterHash, JSON.stringify(forward), JSON.stringify(inverse), new Date(this.now()).toISOString());
      // Bound retained inverse payloads; old client handles fail explicitly rather than guessing.
      this.db.prepare(`DELETE FROM playlist_edit_commands WHERE user_id=? AND id NOT IN
        (SELECT id FROM playlist_edit_commands WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50)`).run(user.id, user.id);
      return { command: { id: commandId, playlistId: id, label }, revision: after.edit_revision, deletedAt: after.deleted_at };
    })();
  }
  reverse(user: SessionUser, commandId: string, expectedRevision: number, direction: "undo" | "redo") {
    return this.db.transaction(() => {
      const command = this.db.prepare("SELECT * FROM playlist_edit_commands WHERE id=? AND user_id=?").get(commandId, user.id) as StoredCommand | undefined;
      if (!command) throw new PlaylistOrganizationError("This undo step has expired. Reload the playlist.", 410);
      const row = this.row(command.playlist_id, user, true, true);
      this.checkRevision(row.edit_revision, expectedRevision);
      const expected = direction === "undo" ? command.after_hash : command.before_hash;
      if (command.state !== (direction === "undo" ? "done" : "undone") || this.fingerprint(row) !== expected) throw new PlaylistOrganizationError("Undo history no longer matches this playlist. Reload it before continuing.", 409);
      const delta = JSON.parse(direction === "undo" ? command.inverse_json : command.forward_json) as Delta;
      if ((delta.kind === "details" || delta.kind === "trash") && !new PlaylistCollaborationService(this.db).access(row.id, user, true).canManage)
        throw new PlaylistOrganizationError("Only the owner can undo playlist management changes.", 403);
      this.apply(row.id, delta);
      this.db.prepare("UPDATE playlist_edit_commands SET state=? WHERE id=?").run(direction === "undo" ? "undone" : "done", commandId);
      const updated = this.row(row.id, user, true, true);
      return { command: { id: command.id, playlistId: row.id, label: command.label }, revision: updated.edit_revision, deletedAt: updated.deleted_at };
    })();
  }
  trash(user: SessionUser) {
    return this.db.prepare(`SELECT id,name,deleted_at AS deletedAt,edit_revision AS revision,
      (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) AS trackCount
      FROM playlists p WHERE deleted_at IS NOT NULL AND deleted_at>? AND (owner_user_id=? OR ?)
      ORDER BY deleted_at DESC,id`).all(new Date(this.now() - TRASH_RETENTION_MS).toISOString(), user.id, user.role === "admin" ? 1 : 0);
  }
  purgeExpired(limit = 100): number {
    return this.db.transaction(() => this.db.prepare(`DELETE FROM playlists WHERE id IN
      (SELECT id FROM playlists WHERE deleted_at IS NOT NULL AND deleted_at<=? ORDER BY deleted_at LIMIT ?)`)
      .run(new Date(this.now() - TRASH_RETENTION_MS).toISOString(), limit).changes)();
  }
  private folder(userId: string, id: string): FolderRow {
    const row = this.db.prepare("SELECT * FROM playlist_folders WHERE id=? AND user_id=?").get(id, userId) as FolderRow | undefined;
    if (!row) throw new PlaylistOrganizationError("Folder not found.", 404); return row;
  }
  private checkParent(userId: string, parent: string | null, moving?: string) {
    let depth = 0, cursor = parent;
    while (cursor) {
      if (cursor === moving) throw new PlaylistOrganizationError("A folder cannot be moved into itself or its descendants.", 400);
      cursor = this.folder(userId, cursor).parent_folder_id;
      if (++depth >= MAX_DEPTH) throw new PlaylistOrganizationError("Folders support up to 16 nesting levels.", 400);
    }
    if (moving) {
      const height = this.db.prepare(`WITH RECURSIVE children(id,depth) AS (SELECT ?,1 UNION ALL
        SELECT f.id,c.depth+1 FROM playlist_folders f JOIN children c ON f.parent_folder_id=c.id WHERE f.user_id=?) SELECT MAX(depth) AS depth FROM children`)
        .get(moving, userId) as { depth: number };
      if (depth + height.depth > MAX_DEPTH) throw new PlaylistOrganizationError("This move would exceed 16 nesting levels.", 400);
    }
  }
  private organizationRevision(userId: string) {
    this.db.prepare("INSERT OR IGNORE INTO playlist_organization_state(user_id) VALUES(?)").run(userId);
    return (this.db.prepare("SELECT revision FROM playlist_organization_state WHERE user_id=?").get(userId) as { revision: number }).revision;
  }
  tree(user: SessionUser) {
    const folders = (this.db.prepare("SELECT * FROM playlist_folders WHERE user_id=? ORDER BY position,id").all(user.id) as FolderRow[]).map(row => ({ ...row, pinned: Boolean(row.pinned) }));
    const playlists = this.db.prepare(`SELECT p.id,p.name,p.owner_user_id AS ownerUserId,p.updated_at AS updatedAt,p.created_at AS createdAt,u.display_name AS creator,
      o.folder_id AS folderId,COALESCE(o.pinned,0) AS pinned,COALESCE(o.position,2147483647) AS position,o.pin_position AS pinPosition
      FROM playlists p LEFT JOIN playlist_placements o ON o.playlist_id=p.id AND o.user_id=@placementUser
      LEFT JOIN users u ON u.id=p.owner_user_id
      WHERE p.deleted_at IS NULL AND ${playlistReadPredicate()}
      ORDER BY position,p.name COLLATE NOCASE,p.id`).all({ ...playlistViewer(user), placementUser: user.id }) as PlaylistTreeRow[];
    return { revision: this.organizationRevision(user.id), folders, playlists: playlists.map(row => ({ ...row, pinned: Boolean(row.pinned) })) };
  }
  organize(user: SessionUser, expectedRevision: number, operation:
    | { kind: "createFolder"; name: string; parentId: string | null }
    | { kind: "folder"; id: string; name?: string; parentId?: string | null; pinned?: boolean; position?: number }
    | { kind: "deleteFolder"; id: string }
    | { kind: "playlist"; id: string; folderId?: string | null; pinned?: boolean; position?: number }
    | { kind: "pinOrder"; id: string; position: number }) {
    this.db.transaction(() => {
      this.checkRevision(this.organizationRevision(user.id), expectedRevision);
      if (operation.kind === "createFolder") {
        this.checkParent(user.id, operation.parentId);
        const next = this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM playlist_folders WHERE user_id=? AND parent_folder_id IS ?").get(user.id, operation.parentId) as { n: number };
        this.db.prepare("INSERT INTO playlist_folders(id,name,parent_folder_id,user_id,position) VALUES(?,?,?,?,?)").run(createId("plfolder"), operation.name, operation.parentId, user.id, next.n);
      } else if (operation.kind === "folder") {
        const folder = this.folder(user.id, operation.id), parent = operation.parentId === undefined ? folder.parent_folder_id : operation.parentId;
        this.checkParent(user.id, parent, folder.id);
        const siblings = this.db.prepare("SELECT id,position FROM playlist_folders WHERE user_id=? AND parent_folder_id IS ? AND id<>? ORDER BY position,id").all(user.id, parent, folder.id) as { id: string; position?: number }[];
        const rank = siblings.filter(item => (item.position ?? 0) < folder.position || (item.position === folder.position && item.id < folder.id)).length;
        const position = operation.position ?? (parent === folder.parent_folder_id ? rank : siblings.length);
        siblings.splice(Math.min(position, siblings.length), 0, { id: folder.id });
        this.db.prepare("UPDATE playlist_folders SET name=?,parent_folder_id=?,pinned=? WHERE id=? AND user_id=?").run(operation.name ?? folder.name, parent, operation.pinned === undefined ? folder.pinned : Number(operation.pinned), folder.id, user.id);
        const update = this.db.prepare("UPDATE playlist_folders SET position=? WHERE id=? AND user_id=?"); siblings.forEach((row, i) => update.run(i, row.id, user.id));
      } else if (operation.kind === "deleteFolder") {
        const folder = this.folder(user.id, operation.id);
        this.db.prepare("UPDATE playlist_placements SET folder_id=?,position=position+100000 WHERE user_id=? AND folder_id=?").run(folder.parent_folder_id, user.id, folder.id);
        this.db.prepare("UPDATE playlist_folders SET parent_folder_id=?,position=position+100000 WHERE user_id=? AND parent_folder_id=?").run(folder.parent_folder_id, user.id, folder.id);
        this.db.prepare("DELETE FROM playlist_folders WHERE id=? AND user_id=?").run(folder.id, user.id);
      } else if (operation.kind === "pinOrder") {
        const pins = this.tree(user).playlists.filter(row => row.pinned).sort((a, b) =>
          (a.pinPosition ?? Infinity) - (b.pinPosition ?? Infinity) || a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id, "en"));
        const index = pins.findIndex(row => row.id === operation.id);
        if (index < 0) throw new PlaylistOrganizationError("Only pinned playlists can be reordered here.", 400);
        const [pin] = pins.splice(index, 1);
        pins.splice(operation.position, 0, pin);
        const update = this.db.prepare("UPDATE playlist_placements SET pin_position=? WHERE user_id=? AND playlist_id=?");
        pins.forEach((row, position) => update.run(position, user.id, row.id));
      } else {
        this.row(operation.id, user);
        const previous = this.db.prepare("SELECT * FROM playlist_placements WHERE user_id=? AND playlist_id=?").get(user.id, operation.id) as { folder_id: string | null; position: number; pinned: number } | undefined;
        const parent = operation.folderId === undefined ? previous?.folder_id ?? null : operation.folderId;
        if (parent) this.folder(user.id, parent);
        const currentSiblings = (this.tree(user).playlists as Array<{ id?: unknown; folderId?: unknown }>).filter(row => row.folderId === parent);
        const rank = currentSiblings.findIndex(row => row.id === operation.id);
        const siblings = currentSiblings.filter(row => row.id !== operation.id).map(row => ({ id: String(row.id) }));
        siblings.splice(Math.min(operation.position ?? (previous?.folder_id === parent && rank >= 0 ? rank : siblings.length), siblings.length), 0, { id: operation.id });
        const upsert = this.db.prepare(`INSERT INTO playlist_placements(user_id,playlist_id,folder_id,pinned,position) VALUES(?,?,?,?,?)
          ON CONFLICT(user_id,playlist_id) DO UPDATE SET folder_id=excluded.folder_id,pinned=excluded.pinned,position=excluded.position`);
        siblings.forEach((row, i) => {
          const pinned = row.id === operation.id ? operation.pinned === undefined ? previous?.pinned ?? 0 : Number(operation.pinned)
            : Number((this.db.prepare("SELECT pinned FROM playlist_placements WHERE user_id=? AND playlist_id=?").get(user.id, row.id) as { pinned: number } | undefined)?.pinned ?? 0);
          upsert.run(user.id, row.id, parent, pinned, i);
        });
        if (operation.pinned === false) this.db.prepare("UPDATE playlist_placements SET pin_position=NULL WHERE user_id=? AND playlist_id=?").run(user.id, operation.id);
      }
      this.db.prepare("UPDATE playlist_organization_state SET revision=revision+1 WHERE user_id=?").run(user.id);
    })();
    return this.tree(user);
  }
}
