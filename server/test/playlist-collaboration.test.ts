import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../src/db/migrations.js";
import { PlaylistCollaborationService, playlistReadPredicate, playlistViewer, type PlaylistVisibility } from "../src/services/PlaylistCollaborationService.js";
import { PlaylistOrganizationService } from "../src/domain/playlist-organization.js";
import { LibraryService } from "../src/domain/library.js";
import { createSession } from "../src/auth/sessions.js";
import { getUserById } from "../src/users/users.js";
import type { SessionUser } from "../src/types.js";

let db: Database.Database, service: PlaylistCollaborationService, organization: PlaylistOrganizationService, now: number;
let owner: SessionUser, viewer: SessionUser, editor: SessionUser, stranger: SessionUser, admin: SessionUser;
const list = "playlist-one";
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); runMigrations(db); now = Date.now();
  db.exec("INSERT INTO roles VALUES('user','Listener'),('admin','Administrator')");
  for (const id of ["owner", "viewer", "editor", "stranger", "admin"]) db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES(?,?, 'never-export-this-hash',?,?,?,?)`).run(id, id, id.toUpperCase(), id === "admin" ? "admin" : "user", new Date(now).toISOString(), new Date(now).toISOString());
  [owner, viewer, editor, stranger, admin] = ["owner", "viewer", "editor", "stranger", "admin"].map(id => getUserById(db, id)!);
  db.prepare("INSERT INTO playlists(id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(list, owner.id, "Household", "2026", "2026");
  db.exec("INSERT INTO library_items(id,type,created_at,updated_at) VALUES('track-a','track','2026','2026'),('track-b','track','2026','2026')");
  service = new PlaylistCollaborationService(db, () => now); organization = new PlaylistOrganizationService(db, new LibraryService(db), () => now);
});
afterEach(() => db.close());
function share(mode: PlaylistVisibility = "COLLABORATIVE") {
  const revision = service.snapshot(list, owner).revision;
  return service.update(list, owner, revision, mode, mode === "COLLABORATIVE" ? [{ userId: editor.id, role: "COLLABORATOR" }, { userId: viewer.id, role: "VIEWER" }]
    : mode === "SHARED_READ" ? [{ userId: viewer.id, role: "VIEWER" }, { userId: editor.id, role: "VIEWER" }] : []);
}
describe("playlist permission matrix", () => {
  test.each(["PRIVATE", "SHARED_READ", "COLLABORATIVE", "PUBLIC_SERVER"] as const)("%s separates read, edit, and owner management", mode => {
    share(mode);
    expect(service.access(list, owner)).toEqual({ canRead: true, canEditTracks: true, canManage: true });
    expect(service.access(list, admin)).toEqual({ canRead: true, canEditTracks: true, canManage: true });
    expect(service.access(list, viewer)).toEqual({ canRead: mode !== "PRIVATE", canEditTracks: false, canManage: false });
    expect(service.access(list, editor)).toEqual({ canRead: mode !== "PRIVATE", canEditTracks: mode === "COLLABORATIVE", canManage: false });
    expect(service.access(list, stranger)).toEqual({ canRead: mode === "PUBLIC_SERVER", canEditTracks: false, canManage: false });
    const visible = db.prepare(`SELECT p.id FROM playlists p WHERE ${playlistReadPredicate()}`).all(playlistViewer(stranger));
    expect(visible).toHaveLength(mode === "PUBLIC_SERVER" ? 1 : 0);
  });
  test("disabled accounts fail closed even if a grant or caller role remains", () => {
    share(); db.prepare("UPDATE users SET disabled=1 WHERE id IN ('editor','admin')").run();
    expect(service.access(list, editor).canRead).toBe(false); expect(service.access(list, admin).canManage).toBe(false);
  });
  test("invalid and stale permission changes roll back all grant changes", () => {
    const initial = share();
    expect(() => service.update(list, owner, initial.revision - 1, "PRIVATE", [])).toThrow("changed elsewhere");
    expect(() => service.update(list, owner, initial.revision, "COLLABORATIVE", [{ userId: "missing", role: "COLLABORATOR" }])).toThrow("unavailable");
    expect(() => service.update(list, owner, initial.revision, "SHARED_READ", [{ userId: viewer.id, role: "COLLABORATOR" }])).toThrow("roles");
    expect(service.snapshot(list, owner)).toEqual(initial);
    expect(() => service.update(list, editor, initial.revision, "PRIVATE", [])).toThrow("permission");
    expect(() => service.users(list, stranger, "")).toThrow("permission");
  });
  test("member search is bounded and reveals no password hashes, roles or private settings", () => {
    const rows = service.users(list, owner, "VIEW"); expect(rows.map(row => row.id)).toEqual([viewer.id]);
    expect(Object.keys(rows[0]).sort()).toEqual(["avatarUrl", "displayName", "id", "username"]);
    expect(service.users(list, owner, "%")).toEqual([]);
    expect(JSON.stringify(service.snapshot(list, owner))).not.toContain("never-export");
  });
});
describe("account-bound invitations", () => {
  test("links are hashed, recipient-bound, expire, and cannot elevate a role", () => {
    share(); const invitation = service.createLink(list, owner, viewer.id);
    expect(JSON.stringify(db.prepare("SELECT * FROM playlist_share_links").all())).not.toContain(invitation.token);
    expect(service.resolveLink(viewer, invitation.token)).toBe(list);
    expect(service.access(list, viewer).canEditTracks).toBe(false);
    expect(() => service.resolveLink(editor, invitation.token)).toThrow("unavailable for your account");
    now += 7 * 86400_000 + 1; expect(() => service.resolveLink(viewer, invitation.token)).toThrow("unavailable");
  });
  test("revoking or changing roles invalidates existing links and current access", () => {
    share(); const first = service.createLink(list, owner, editor.id); service.revokeLink(list, owner, first.id);
    expect(() => service.resolveLink(editor, first.token)).toThrow();
    const second = service.createLink(list, owner, editor.id); share("PRIVATE");
    expect(() => service.resolveLink(editor, second.token)).toThrow(); expect(service.access(list, editor).canRead).toBe(false);
    expect(() => service.createLink(list, owner, null)).toThrow("Share this playlist");
  });
  test("public links require server accounts and private links require an existing named member", () => {
    share(); expect(() => service.createLink(list, owner, stranger.id)).toThrow("Add this member");
    expect(() => service.createLink(list, editor, viewer.id)).toThrow("permission");
    share("PUBLIC_SERVER"); const link = service.createLink(list, owner, null);
    expect(service.resolveLink(stranger, link.token)).toBe(list);
    expect(service.access(list, stranger).canEditTracks).toBe(false);
    db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(stranger.id); expect(() => service.resolveLink(stranger, link.token)).toThrow("permission");
  });
});
describe("collaborative commands and attribution", () => {
  test("collaborators reorder/remove with attribution-preserving undo, but cannot manage details or Trash", () => {
    share(); db.prepare(`INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at,added_by_user_id)
      VALUES('entry-a',?,0,'test','a','track-a','2026',?),('entry-b',?,1,'test','b','track-b','2026',?)`).run(list, owner.id, list, editor.id);
    const revision = () => organization.state(editor, list).revision;
    const order = organization.execute(editor, list, revision(), { kind: "reorder", itemIds: ["entry-b", "entry-a"], expectedItemIds: ["entry-a", "entry-b"] });
    expect(order.command).toBeTruthy();
    const remove = organization.execute(editor, list, revision(), { kind: "remove", itemIds: ["entry-b"], expectedItemIds: ["entry-b", "entry-a"] });
    organization.reverse(editor, remove.command!.id, remove.revision, "undo");
    expect(db.prepare("SELECT added_by_user_id FROM playlist_items WHERE id='entry-b'").get()).toEqual({ added_by_user_id: editor.id });
    expect(() => organization.execute(editor, list, revision(), { kind: "details", name: "Stolen" })).toThrow("Only the owner");
    expect(() => organization.execute(editor, list, revision(), { kind: "trash" })).toThrow("Only the owner");
    expect(() => organization.execute(viewer, list, revision(), { kind: "remove", itemIds: ["entry-a"] })).toThrow("Collaborator");
    const current = revision(); organization.execute(owner, list, current, { kind: "remove", itemIds: ["entry-a"] });
    expect(() => organization.execute(editor, list, current, { kind: "remove", itemIds: ["entry-b"] })).toThrow("changed elsewhere");
  });
  test("access removal blocks already-created undo handles", () => {
    share(); db.prepare(`INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,created_at,added_by_user_id) VALUES('entry-a',?,0,'test','a','2026',?)`).run(list, editor.id);
    const removed = organization.execute(editor, list, organization.state(editor, list).revision, { kind: "remove", itemIds: ["entry-a"] });
    share("PRIVATE"); expect(() => organization.reverse(editor, removed.command!.id, removed.revision, "undo")).toThrow("access denied");
    expect(db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?").get(list)).toEqual({ n: 0 });
  });
});
describe("party request isolation", () => {
  test("requests are durable, idempotent and limited to collaborators; only the exact host session/device can review", () => {
    share(); const session = createSession(db, owner.id).id, device = randomUUID(); service.startParty(list, owner, session, device);
    const key = randomUUID(), result = service.requestTrack(list, editor, "track-a", key);
    expect(service.requestTrack(list, editor, "track-a", key)).toEqual(result);
    expect(() => service.requestTrack(list, editor, "track-b", key)).toThrow("another track");
    expect(() => service.requestTrack(list, viewer, "track-b", randomUUID())).toThrow("permission");
    expect(() => service.requestTrack(list, stranger, "track-b", randomUUID())).toThrow("permission");
    expect(() => service.hostAction(list, editor, session, device, "QUEUED", result.id)).toThrow("permission");
    expect(() => service.hostAction(list, owner, createSession(db, owner.id).id, device, "QUEUED", result.id)).toThrow("hosting player");
    expect(() => service.hostAction(list, owner, session, randomUUID(), "QUEUED", result.id)).toThrow("hosting player");
    service.hostAction(list, owner, session, device, "QUEUED", result.id); service.hostAction(list, owner, session, device, "QUEUED", result.id);
    expect(service.partyState(list, owner, session, device).requests).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM playlist_party_requests").get()).toEqual({ n: 1 });
  });
  test("pending requests are removed when collaboration is revoked; viewer cannot inspect other submissions", () => {
    share(); const session = createSession(db, owner.id).id, device = randomUUID(); service.startParty(list, owner, session, device);
    service.requestTrack(list, editor, "track-a", randomUUID());
    service.update(list, owner, service.snapshot(list, owner).revision, "COLLABORATIVE", [{ userId: viewer.id, role: "COLLABORATOR" }]);
    expect(service.partyState(list, viewer, createSession(db, viewer.id).id, randomUUID()).requests).toEqual([]);
    expect(service.partyState(list, owner, session, device).requests).toEqual([]);
    expect(() => service.requestTrack(list, editor, "track-a", randomUUID())).toThrow("permission");
  });
  test("host logout, expired leases, mode changes, and non-library track IDs stop new requests", () => {
    share(); let session = createSession(db, owner.id).id; const device = randomUUID(); service.startParty(list, owner, session, device);
    expect(() => service.requestTrack(list, editor, "https://evil.test/audio", randomUUID())).toThrow("library track");
    now += 91_000; expect(() => service.requestTrack(list, editor, "track-a", randomUUID())).toThrow("offline");
    service.startParty(list, owner, session, device); db.prepare("DELETE FROM sessions WHERE id=?").run(session);
    expect(() => service.requestTrack(list, editor, "track-a", randomUUID())).toThrow("offline");
    session = createSession(db, owner.id).id; service.startParty(list, owner, session, device); share("PUBLIC_SERVER");
    expect(service.partyState(list, owner, session, device).party).toBeNull();
  });
  test("pending request quotas protect modest server hardware while retries remain accepted", () => {
    share(); const session = createSession(db, owner.id).id; service.startParty(list, owner, session, randomUUID());
    const keys = Array.from({ length: 20 }, () => randomUUID()); for (const key of keys) service.requestTrack(list, editor, "track-a", key);
    expect(() => service.requestTrack(list, editor, "track-b", randomUUID())).toThrow("full");
    expect(service.requestTrack(list, editor, "track-a", keys[0]).id).toBeTruthy();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
