import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { createFakeBackend, createTestServer, closeTestServer, login } from "./helpers.js";
import { PlaylistOrganizationService, TRASH_RETENTION_MS } from "../src/domain/playlist-organization.js";
import { LibraryService } from "../src/domain/library.js";
import { createUser, getUserById } from "../src/users/users.js";
import type { SessionUser } from "../src/types.js";

let server: Awaited<ReturnType<typeof createTestServer>>;
let alice: SessionUser, bob: SessionUser, cookie: string | undefined;
let clock = Date.now();
let organization: PlaylistOrganizationService;
beforeAll(async () => {
  server = await createTestServer(createFakeBackend());
  server.db.pragma("journal_mode=WAL"); server.db.pragma("synchronous=NORMAL");
  alice = (await createUser(server.db, { username: "folder-alice", password: "alice-password" }))!;
  bob = (await createUser(server.db, { username: "folder-bob", password: "bob-password" }))!;
  cookie = (await login(server.app, "folder-alice", "alice-password")).cookie;
  organization = new PlaylistOrganizationService(server.db, server.library, () => clock);
}, 40_000);
afterAll(async () => { if (server) await closeTestServer(server.app, server.db); });
const entries = (id: string) => server.db.prepare("SELECT * FROM playlist_items WHERE playlist_id=? ORDER BY position").all(id);
async function playlist(name: string, count = 3) {
  const list = await server.playlists.create(name, alice);
  server.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const track = server.library.ensureId("track", { connectionId: "test-connection", providerItemId: `song-${i % 2}` });
      server.db.prepare("INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,library_track_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(`${list.id}-entry-${i}`, list.id, i, "test-connection", `song-${i % 2}`, track, new Date(clock).toISOString());
    }
  })();
  return list.id;
}
function organize(operation: Parameters<PlaylistOrganizationService["organize"]>[2], user = alice) {
  return organization.organize(user, organization.tree(user).revision, operation);
}
function edit(id: string, operation: Parameters<PlaylistOrganizationService["execute"]>[3]) {
  return organization.execute(alice, id, organization.state(alice, id).revision, operation);
}

describe("playlist organization and reversible commands", () => {
  test("nested folders enforce ownership, reject cycles and preserve children when removing a folder", async () => {
    const parent = organize({ kind: "createFolder", name: "Parent", parentId: null }).folders.find(row => row.name === "Parent")!;
    const child = organize({ kind: "createFolder", name: "Child", parentId: parent.id }).folders.find(row => row.name === "Child")!;
    expect(() => organize({ kind: "folder", id: parent.id, parentId: child.id })).toThrow("descendants");
    expect(() => organize({ kind: "createFolder", name: "Intruder", parentId: parent.id }, bob)).toThrow("Folder not found");
    const id = await playlist("Inside folder");
    organize({ kind: "playlist", id, folderId: child.id, pinned: true });
    const result = organize({ kind: "deleteFolder", id: child.id });
    expect(result.playlists.find(row => row.id === id)).toMatchObject({ folderId: parent.id, pinned: true });
    expect(server.db.pragma("foreign_key_check")).toEqual([]);
    const stale = result.revision;
    organize({ kind: "folder", id: parent.id, pinned: true });
    expect(() => organization.organize(alice, stale, { kind: "folder", id: parent.id, name: "Stale" })).toThrow("changed elsewhere");
  });

  test("multi-step undo/redo preserves exact duplicate occurrence IDs and order", async () => {
    const id = await playlist("Reversible duplicates", 5), original = entries(id) as Array<{ id: string }>;
    const reordered = [...original].reverse().map(row => row.id);
    const first = edit(id, { kind: "reorder", itemIds: reordered, expectedItemIds: original.map(row => row.id) });
    const second = edit(id, { kind: "remove", itemIds: [reordered[1], reordered[3]], expectedItemIds: reordered });
    expect(entries(id)).toHaveLength(3);
    let result = organization.reverse(alice, second.command!.id, second.revision, "undo");
    expect((entries(id) as Array<{ id: string }>).map(row => row.id)).toEqual(reordered);
    result = organization.reverse(alice, first.command!.id, result.revision, "undo");
    expect(entries(id)).toEqual(original);
    result = organization.reverse(alice, first.command!.id, result.revision, "redo");
    result = organization.reverse(alice, second.command!.id, result.revision, "redo");
    expect((entries(id) as Array<{ id: string }>).map(row => row.id)).toEqual(reordered.filter((_, i) => ![1, 3].includes(i)));
    const track = server.library.ensureId("track", { connectionId: "test-connection", providerItemId: "new-song" });
    const added = edit(id, { kind: "add", trackIds: [track, track] });
    expect(entries(id)).toHaveLength(4);
    organization.reverse(alice, added.command!.id, added.revision, "undo"); expect(entries(id)).toHaveLength(3);
  });

  test("custom folder reordering and pinning retain relative positions, including after a folder is removed", async () => {
    const first = organize({ kind: "createFolder", name: "First", parentId: null }).folders.find(row => row.name === "First")!;
    const second = organize({ kind: "createFolder", name: "Second", parentId: null }).folders.find(row => row.name === "Second")!;
    const order = () => organization.tree(alice).folders.filter(row => row.parent_folder_id === null).sort((a, b) => a.position - b.position).map(row => row.id);
    organize({ kind: "folder", id: second.id, position: 0 }); expect(order()[0]).toBe(second.id);
    const before = order();
    organize({ kind: "folder", id: first.id, pinned: true }); expect(order()).toEqual(before);
    const id = await playlist("Positioned playlist");
    organize({ kind: "playlist", id, folderId: second.id });
    organize({ kind: "deleteFolder", id: second.id });
    const placedBefore = organization.tree(alice).playlists.filter(row => row.folderId === null).map(row => row.id);
    organize({ kind: "playlist", id, pinned: true });
    expect(organization.tree(alice).playlists.filter(row => row.folderId === null).map(row => row.id)).toEqual(placedBefore);
  });

  test("pin order is independent of folders and normal playlist order", async () => {
    const folder = organize({ kind: "createFolder", name: "Pin test", parentId: null }).folders.find(row => row.name === "Pin test")!;
    const first = await playlist("Pinned Alpha", 0);
    const second = await playlist("Pinned Beta", 0);
    const regular = await playlist("Unpinned Gamma", 0);
    organize({ kind: "playlist", id: first, pinned: true, folderId: folder.id });
    organize({ kind: "playlist", id: second, pinned: true });
    const before = organization.tree(alice).playlists.map(({ id, position, folderId }) => ({ id, position, folderId }));
    const reordered = organize({ kind: "pinOrder", id: second, position: 0 });
    expect(reordered.playlists.find(row => row.id === second)?.pinPosition).toBe(0);
    expect(reordered.playlists.find(row => row.id === first)?.pinPosition).toBeGreaterThan(0);
    expect(reordered.playlists.map(({ id, position, folderId }) => ({ id, position, folderId }))).toEqual(before);
    expect(() => organize({ kind: "pinOrder", id: regular, position: 0 })).toThrow("Only pinned playlists");
  });

  test("legacy edits invalidate undo and another user cannot use a command handle", async () => {
    const id = await playlist("Concurrent edits");
    const change = edit(id, { kind: "details", name: "Renamed" });
    expect(() => organization.reverse(bob, change.command!.id, change.revision, "undo")).toThrow("expired");
    server.db.prepare("UPDATE playlists SET name='Newer edit' WHERE id=?").run(id);
    expect(() => organization.reverse(alice, change.command!.id, change.revision, "undo")).toThrow("changed elsewhere");
    expect(server.db.prepare("SELECT name FROM playlists WHERE id=?").get(id)).toEqual({ name: "Newer edit" });
  });

  test("Trash survives a second database connection, restores before 30 days and purges exactly at expiry", async () => {
    const id = await playlist("Thirty-day recovery"), original = entries(id);
    server.playlists.setCustomArtwork(id, Buffer.from("saved artwork"), "image/png");
    const artwork = server.db.prepare("SELECT content_type,data FROM playlist_artwork WHERE playlist_id=?").get(id);
    const removed = edit(id, { kind: "trash" });
    expect(await server.playlists.get(id, alice)).toBeNull();
    expect(entries(id)).toEqual(original);
    expect(server.db.prepare("SELECT content_type,data FROM playlist_artwork WHERE playlist_id=?").get(id)).toEqual(artwork);
    const reopened = new Database(server.db.name);
    try {
      reopened.pragma("foreign_keys=ON");
      const recovered = new PlaylistOrganizationService(reopened, new LibraryService(reopened), () => clock);
      expect(recovered.trash(alice).some((row: any) => row.id === id)).toBe(true);
      clock += TRASH_RETENTION_MS - 1;
      const restored = recovered.reverse(alice, removed.command!.id, removed.revision, "undo");
      expect(restored.deletedAt).toBeNull(); expect(entries(id)).toEqual(original);
    } finally { reopened.close(); }
    const trashedAgain = edit(id, { kind: "trash" });
    clock += TRASH_RETENTION_MS;
    expect(() => organization.reverse(alice, trashedAgain.command!.id, trashedAgain.revision, "undo")).toThrow("expired");
    organization.purgeExpired();
    expect(entries(id)).toEqual([]);
    expect(server.db.prepare("SELECT id FROM playlists WHERE id=?").get(id)).toBeUndefined();
    expect(server.db.prepare("SELECT id FROM playlist_edit_commands WHERE playlist_id=?").get(id)).toBeUndefined();
    expect(server.db.prepare("SELECT playlist_id FROM playlist_artwork WHERE playlist_id=?").get(id)).toBeUndefined();
    clock = Date.now();
  });

  test("HTTP commands validate actor, reject stale revisions, and legacy DELETE moves to Trash", async () => {
    const id = await playlist("Route protection");
    const revision = organization.state(alice, id).revision;
    expect((await server.app.inject({ method: "GET", url: "/api/playlists", headers: { cookie } })).json().playlists.find((row: any) => row.id === id).songCount).toBe(3);
    const request = (body: Record<string, unknown>) => server.app.inject({ method: "POST", url: `/api/v1/playlists/${id}/commands`, headers: { cookie }, payload: body });
    expect((await request({ ownerId: bob.id, revision, edit: { kind: "trash" } })).statusCode).toBe(409);
    const result = await request({ ownerId: alice.id, revision, edit: { kind: "details", name: "HTTP rename" } });
    expect(result.statusCode).toBe(200); expect(result.json().command.id).toBeTruthy();
    expect((await request({ ownerId: alice.id, revision, edit: { kind: "trash" } })).statusCode).toBe(409);
    const deleted = await server.app.inject({ method: "DELETE", url: `/api/playlists/${id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    expect((await server.app.inject({ method: "GET", url: `/api/playlists/${id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/api/playlists", headers: { cookie } })).json().playlists.some((row: any) => row.id === id)).toBe(false);
    expect(entries(id)).toHaveLength(3);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/playlists/trash", headers: { cookie } })).json().playlists.some((row: any) => row.id === id)).toBe(true);
    expect(server.db.pragma("foreign_key_check")).toEqual([]);
  });
});
