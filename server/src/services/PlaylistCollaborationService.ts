import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/database.js";
import type { SessionUser } from "../types.js";
import { avatarUrlFor } from "../users/avatars.js";
import { getSessionUserById } from "../auth/sessions.js";
import { createId } from "../utils/ids.js";

export type PlaylistVisibility = "PRIVATE" | "SHARED_READ" | "COLLABORATIVE" | "PUBLIC_SERVER";
export type PlaylistCollaboratorRole = "VIEWER" | "COLLABORATOR";
export interface PlaylistGrant { userId: string; role: PlaylistCollaboratorRole }
export interface PlaylistAccess { canRead: boolean; canEditTracks: boolean; canManage: boolean }
export class PlaylistPermissionError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 410 | 429) { super(message); }
}
interface PlaylistRow { id: string; owner_user_id: string | null; sharing_mode: PlaylistVisibility; sharing_revision: number; deleted_at: string | null }
interface PartyRow { id: string; playlist_id: string; host_user_id: string; host_session_id: string; host_device_id: string;
  created_at: number; expires_at: number; closed_at: number | null }
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const PARTY_LEASE_MS = 90_000, DAY = 86400_000;

/** Bind viewer/isAdmin parameters; never interpolate caller-supplied SQL identifiers. */
export function playlistReadPredicate(alias: "p" | "playlists" | "t" = "p"): string {
  return `(${alias}.owner_user_id=@viewer OR @isAdmin=1 OR ${alias}.sharing_mode='PUBLIC_SERVER' OR
    (${alias}.sharing_mode IN ('SHARED_READ','COLLABORATIVE') AND EXISTS(SELECT 1 FROM playlist_permissions perm
      WHERE perm.playlist_id=${alias}.id AND perm.user_id=@viewer)))`;
}
export function playlistViewer(user: Pick<SessionUser, "id" | "role">) { return { viewer: user.id, isAdmin: user.role === "admin" ? 1 : 0 }; }

/** One authority for reads, track edits, owner management, authenticated links, and party requests. */
export class PlaylistCollaborationService {
  constructor(private readonly db: Db, private readonly now = Date.now) {}
  private row(playlistId: string): PlaylistRow | undefined {
    return this.db.prepare("SELECT id,owner_user_id,sharing_mode,sharing_revision,deleted_at FROM playlists WHERE id=?").get(playlistId) as PlaylistRow | undefined;
  }
  access(playlistId: string, user: Pick<SessionUser, "id" | "role">, includeTrash = false): PlaylistAccess {
    const row = this.row(playlistId), denied = { canRead: false, canEditTracks: false, canManage: false };
    if (!row || !this.db.prepare("SELECT 1 FROM users WHERE id=? AND disabled=0").get(user.id)) return denied;
    const manager = user.role === "admin" || row.owner_user_id === user.id;
    if (row.deleted_at) return includeTrash && manager ? { canRead: true, canEditTracks: true, canManage: true } : denied;
    if (manager) return { canRead: true, canEditTracks: true, canManage: true };
    const grant = this.db.prepare("SELECT role FROM playlist_permissions WHERE playlist_id=? AND user_id=?").get(playlistId, user.id) as { role: PlaylistCollaboratorRole } | undefined;
    const named = row.sharing_mode === "SHARED_READ" || row.sharing_mode === "COLLABORATIVE";
    return { canRead: row.sharing_mode === "PUBLIC_SERVER" || named && Boolean(grant),
      canEditTracks: row.sharing_mode === "COLLABORATIVE" && grant?.role === "COLLABORATOR", canManage: false };
  }
  require(playlistId: string, user: Pick<SessionUser, "id" | "role">, capability: keyof PlaylistAccess, includeTrash = false): void {
    if (!this.access(playlistId, user, includeTrash)[capability]) throw new PlaylistPermissionError("You do not have permission for this playlist action.", 403);
  }
  snapshot(playlistId: string, user: SessionUser) {
    this.require(playlistId, user, "canManage");
    const row = this.row(playlistId)!;
    const grants = this.db.prepare(`SELECT perm.user_id AS userId,perm.role,u.username,u.display_name AS displayName,u.avatar_updated_at,u.disabled
      FROM playlist_permissions perm JOIN users u ON u.id=perm.user_id WHERE perm.playlist_id=? ORDER BY u.username COLLATE NOCASE`)
      .all(playlistId) as { userId: string; role: PlaylistCollaboratorRole; username: string; displayName: string; avatar_updated_at: string | null; disabled: number }[];
    const links = this.db.prepare(`SELECT l.id,l.recipient_user_id AS recipientUserId,u.display_name AS recipientName,l.expires_at AS expiresAt
      FROM playlist_share_links l LEFT JOIN users u ON u.id=l.recipient_user_id WHERE l.playlist_id=? AND l.revoked_at IS NULL AND l.expires_at>?
      ORDER BY l.created_at DESC LIMIT 50`).all(playlistId, this.now());
    return { playlistId, mode: row.sharing_mode, revision: row.sharing_revision, ownerUserId: row.owner_user_id,
      grants: grants.map(({ avatar_updated_at, disabled, ...grant }) => ({ ...grant, disabled: Boolean(disabled), avatarUrl: avatarUrlFor(grant.userId, avatar_updated_at) })), links };
  }
  users(playlistId: string, user: SessionUser, query: string) {
    this.require(playlistId, user, "canManage");
    const owner = this.row(playlistId)!.owner_user_id;
    const pattern = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const rows = this.db.prepare(`SELECT id,username,display_name AS displayName,avatar_updated_at FROM users WHERE disabled=0
      AND id<>COALESCE(?, '') AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY username COLLATE NOCASE LIMIT 50`)
      .all(owner, pattern, pattern) as { id: string; username: string; displayName: string; avatar_updated_at: string | null }[];
    return rows.map(({ avatar_updated_at, ...row }) => ({ ...row, avatarUrl: avatarUrlFor(row.id, avatar_updated_at) }));
  }
  update(playlistId: string, user: SessionUser, expectedRevision: number, mode: PlaylistVisibility, grants: PlaylistGrant[]) {
    if (!["PRIVATE", "SHARED_READ", "COLLABORATIVE", "PUBLIC_SERVER"].includes(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new PlaylistPermissionError("Invalid sharing settings.", 400);
    if (grants.length > 100 || new Set(grants.map(grant => grant.userId)).size !== grants.length)
      throw new PlaylistPermissionError("Choose at most 100 distinct household members.", 400);
    if ((mode === "PRIVATE" || mode === "PUBLIC_SERVER") && grants.length || mode === "SHARED_READ" && grants.some(grant => grant.role !== "VIEWER"))
      throw new PlaylistPermissionError("This sharing mode does not allow the selected roles.", 400);
    this.db.transaction(() => {
      this.require(playlistId, user, "canManage"); const row = this.row(playlistId)!;
      if (row.sharing_revision !== expectedRevision) throw new PlaylistPermissionError("Sharing changed elsewhere. Reload before saving.", 409);
      for (const grant of grants) {
        if (!["VIEWER", "COLLABORATOR"].includes(grant.role) || grant.userId === row.owner_user_id ||
          !this.db.prepare("SELECT 1 FROM users WHERE id=? AND disabled=0").get(grant.userId))
          throw new PlaylistPermissionError("A selected account is unavailable or has an invalid role.", 400);
      }
      this.db.prepare("DELETE FROM playlist_permissions WHERE playlist_id=?").run(playlistId);
      const insert = this.db.prepare("INSERT INTO playlist_permissions VALUES(?,?,?,?,?)");
      for (const grant of grants) insert.run(playlistId, grant.userId, grant.role, user.id, new Date(this.now()).toISOString());
      this.db.prepare("UPDATE playlists SET sharing_mode=?,sharing_revision=sharing_revision+1,edit_revision=edit_revision+1,updated_at=? WHERE id=?")
        .run(mode, new Date(this.now()).toISOString(), playlistId);
      this.db.prepare("UPDATE playlist_share_links SET revoked_at=? WHERE playlist_id=? AND revoked_at IS NULL").run(this.now(), playlistId);
      if (mode !== "COLLABORATIVE") this.db.prepare("UPDATE playlist_party_sessions SET closed_at=? WHERE playlist_id=? AND closed_at IS NULL").run(this.now(), playlistId);
    })();
    return this.snapshot(playlistId, user);
  }
  createLink(playlistId: string, user: SessionUser, recipientUserId: string | null) {
    return this.db.transaction(() => {
      this.require(playlistId, user, "canManage"); const row = this.row(playlistId)!;
      if (row.sharing_mode === "PRIVATE") throw new PlaylistPermissionError("Share this playlist before creating an invitation link.", 400);
      if (recipientUserId === null && row.sharing_mode !== "PUBLIC_SERVER") throw new PlaylistPermissionError("Choose an existing playlist member for this link.", 400);
      if (recipientUserId && !this.db.prepare("SELECT 1 FROM users WHERE id=? AND disabled=0").get(recipientUserId)) throw new PlaylistPermissionError("Recipient account is unavailable.", 400);
      if (recipientUserId && row.sharing_mode !== "PUBLIC_SERVER" && !this.db.prepare("SELECT 1 FROM playlist_permissions WHERE playlist_id=? AND user_id=?").get(playlistId, recipientUserId))
        throw new PlaylistPermissionError("Add this member to the playlist before creating a link.", 400);
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM playlist_share_links WHERE playlist_id=? AND revoked_at IS NULL AND expires_at>?").get(playlistId, this.now()) as { n: number };
      if (count.n >= 50) throw new PlaylistPermissionError("Revoke an existing invitation before creating another.", 429);
      const token = randomBytes(32).toString("hex"), id = createId("plshare"), expiresAt = this.now() + 7 * DAY;
      this.db.prepare("INSERT INTO playlist_share_links(id,playlist_id,recipient_user_id,token_hash,created_by_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, playlistId, recipientUserId, digest(token), user.id, this.now(), expiresAt);
      return { id, token, expiresAt };
    })();
  }
  revokeLink(playlistId: string, user: SessionUser, id: string) {
    this.require(playlistId, user, "canManage");
    this.db.prepare("UPDATE playlist_share_links SET revoked_at=? WHERE id=? AND playlist_id=? AND revoked_at IS NULL").run(this.now(), id, playlistId);
  }
  resolveLink(user: SessionUser, token: string): string {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new PlaylistPermissionError("Invitation expired or unavailable.", 404);
    const row = this.db.prepare("SELECT playlist_id,recipient_user_id FROM playlist_share_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?")
      .get(digest(token), this.now()) as { playlist_id: string; recipient_user_id: string | null } | undefined;
    if (!row || row.recipient_user_id && row.recipient_user_id !== user.id) throw new PlaylistPermissionError("This invitation is unavailable for your account.", 403);
    this.require(row.playlist_id, user, "canRead"); return row.playlist_id;
  }
  private party(playlistId: string): PartyRow | null {
    const row = this.db.prepare("SELECT * FROM playlist_party_sessions WHERE playlist_id=? AND closed_at IS NULL").get(playlistId) as PartyRow | undefined;
    if (!row) return null;
    const host = getSessionUserById(this.db, row.host_session_id);
    if (row.expires_at <= this.now() || !host || !this.access(playlistId, host).canManage || this.row(playlistId)?.sharing_mode !== "COLLABORATIVE") {
      this.db.prepare("UPDATE playlist_party_sessions SET closed_at=? WHERE id=?").run(this.now(), row.id); return null;
    }
    return row;
  }
  startParty(playlistId: string, user: SessionUser, sessionId: string, deviceId: string) {
    return this.db.transaction(() => {
      this.require(playlistId, user, "canManage");
      if (this.row(playlistId)?.sharing_mode !== "COLLABORATIVE") throw new PlaylistPermissionError("Choose collaborative sharing before opening a party queue.", 400);
      if (getSessionUserById(this.db, sessionId)?.id !== user.id) throw new PlaylistPermissionError("Playback session expired.", 403);
      const current = this.party(playlistId);
      if (current) {
        this.requireHost(current, user, sessionId, deviceId);
        this.db.prepare("UPDATE playlist_party_sessions SET expires_at=? WHERE id=?").run(this.now() + PARTY_LEASE_MS, current.id);
        return { id: current.id, expiresAt: this.now() + PARTY_LEASE_MS };
      }
      const id = createId("party"), expiresAt = this.now() + PARTY_LEASE_MS;
      this.db.prepare("INSERT INTO playlist_party_sessions(id,playlist_id,host_user_id,host_session_id,host_device_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, playlistId, user.id, sessionId, deviceId, this.now(), expiresAt);
      return { id, expiresAt };
    })();
  }
  private requireHost(party: PartyRow, user: SessionUser, sessionId: string, deviceId: string) {
    if (party.host_user_id !== user.id || party.host_session_id !== sessionId || party.host_device_id !== deviceId)
      throw new PlaylistPermissionError("Only the hosting player can manage this party queue.", 403);
  }
  partyState(playlistId: string, user: SessionUser, sessionId: string, deviceId: string) {
    this.require(playlistId, user, "canEditTracks"); const party = this.party(playlistId);
    if (!party) return { party: null, requests: [] };
    this.db.prepare(`UPDATE playlist_party_requests SET state='DISMISSED' WHERE party_id=? AND state='PENDING' AND NOT EXISTS(
      SELECT 1 FROM users u WHERE u.id=playlist_party_requests.requested_by_user_id AND u.disabled=0 AND
        (u.role='admin' OR u.id=? OR EXISTS(SELECT 1 FROM playlist_permissions perm WHERE perm.playlist_id=? AND perm.user_id=u.id AND perm.role='COLLABORATOR')))`)
      .run(party.id, this.row(playlistId)!.owner_user_id, playlistId);
    const isHost = party.host_user_id === user.id && party.host_session_id === sessionId && party.host_device_id === deviceId;
    const requests = this.db.prepare(`SELECT r.id,r.track_id AS trackId,r.requested_by_user_id AS requestedByUserId,r.created_at AS createdAt,
      u.display_name AS requestedBy FROM playlist_party_requests r LEFT JOIN users u ON u.id=r.requested_by_user_id
      WHERE r.party_id=? AND r.state='PENDING' AND (r.requested_by_user_id=? OR ?) ORDER BY r.created_at,r.rowid LIMIT 200`)
      .all(party.id, user.id, isHost ? 1 : 0);
    return { party: { id: party.id, isHost, expiresAt: party.expires_at }, requests };
  }
  requestTrack(playlistId: string, user: SessionUser, trackId: string, idempotencyKey: string) {
    return this.db.transaction(() => {
      this.require(playlistId, user, "canEditTracks"); const party = this.party(playlistId);
      if (!party) throw new PlaylistPermissionError("The host's party queue is offline. Ask them to reopen it.", 409);
      const previous = this.db.prepare("SELECT id,track_id AS trackId,state FROM playlist_party_requests WHERE party_id=? AND requested_by_user_id=? AND idempotency_key=?")
        .get(party.id, user.id, idempotencyKey) as { id: string; trackId: string; state: string } | undefined;
      if (previous) { if (previous.trackId !== trackId) throw new PlaylistPermissionError("Request key already belongs to another track.", 409); return previous; }
      if (!this.db.prepare("SELECT 1 FROM library_items WHERE id=? AND type='track'").get(trackId)) throw new PlaylistPermissionError("Choose a library track for this party queue.", 400);
      const pending = this.db.prepare("SELECT COUNT(*) AS total,SUM(requested_by_user_id=?) AS own FROM playlist_party_requests WHERE party_id=? AND state='PENDING'")
        .get(user.id, party.id) as { total: number; own: number | null };
      if (pending.total >= 200 || (pending.own ?? 0) >= 20) throw new PlaylistPermissionError("The party request queue is full. Wait for the host to review requests.", 429);
      const id = createId("partyreq");
      this.db.prepare("INSERT INTO playlist_party_requests(id,party_id,track_id,requested_by_user_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, party.id, trackId, user.id, idempotencyKey, this.now());
      return { id, trackId, state: "PENDING" };
    })();
  }
  hostAction(playlistId: string, user: SessionUser, sessionId: string, deviceId: string,
    action: "heartbeat" | "close" | "QUEUED" | "DISMISSED", requestId?: string) {
    return this.db.transaction(() => {
      this.require(playlistId, user, "canManage"); const party = this.party(playlistId);
      if (!party) throw new PlaylistPermissionError("Party queue expired. Open it again on the hosting player.", 409);
      this.requireHost(party, user, sessionId, deviceId);
      if (action === "heartbeat") this.db.prepare("UPDATE playlist_party_sessions SET expires_at=? WHERE id=?").run(this.now() + PARTY_LEASE_MS, party.id);
      else if (action === "close") this.db.prepare("UPDATE playlist_party_sessions SET closed_at=? WHERE id=?").run(this.now(), party.id);
      else {
        this.partyState(playlistId, user, sessionId, deviceId);
        const row = this.db.prepare("SELECT state FROM playlist_party_requests WHERE id=? AND party_id=?").get(requestId ?? "", party.id) as { state: string } | undefined;
        if (!row) throw new PlaylistPermissionError("Party request not found.", 404);
        if (row.state !== "PENDING" && row.state !== action) throw new PlaylistPermissionError("This request was already reviewed.", 409);
        this.db.prepare("UPDATE playlist_party_requests SET state=? WHERE id=? AND party_id=?").run(action, requestId, party.id);
      }
    })();
  }
  prune(): void {
    const before = this.now() - 7 * DAY;
    this.db.prepare("DELETE FROM playlist_party_requests WHERE state<>'PENDING' AND created_at<?").run(before);
    this.db.prepare("DELETE FROM playlist_party_sessions WHERE COALESCE(closed_at,expires_at)<?").run(before);
    this.db.prepare("DELETE FROM playlist_share_links WHERE COALESCE(revoked_at,expires_at)<?").run(before);
  }
}
