import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestServer, closeTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { PlaylistCollaborationService } from "../src/services/PlaylistCollaborationService.js";
import type { SessionUser } from "../src/types.js";
import { DataExportService } from "../src/services/DataExportService.js";
import { ResumableMediaService } from "../src/services/ResumableMediaService.js";
let server: Awaited<ReturnType<typeof createTestServer>>, owner: SessionUser, viewer: SessionUser, editor: SessionUser;
let ownerCookie: string | undefined, viewerCookie: string | undefined, editorCookie: string | undefined;
beforeAll(async () => {
  server = await createTestServer();
  owner = (await createUser(server.db, { username: "share-owner", password: "owner-password" }))!;
  viewer = (await createUser(server.db, { username: "share-viewer", password: "viewer-password" }))!;
  editor = (await createUser(server.db, { username: "share-editor", password: "editor-password" }))!;
  ownerCookie = (await login(server.app, owner.username, "owner-password")).cookie;
  viewerCookie = (await login(server.app, viewer.username, "viewer-password")).cookie;
  editorCookie = (await login(server.app, editor.username, "editor-password")).cookie;
}, 30_000);
afterAll(async () => { if (server) await closeTestServer(server.app, server.db); });
async function playlist() {
  const value = await server.playlists.create("Household collaboration", owner);
  new PlaylistCollaborationService(server.db).update(value.id, owner, 0, "COLLABORATIVE", [{ userId: viewer.id, role: "VIEWER" }, { userId: editor.id, role: "COLLABORATOR" }]);
  const track = (await server.catalog.listTracks()).items[0];
  return { id: value.id, trackId: track.id };
}
test("all playlist mutation paths reject viewers with 403, including undo commands and artwork", async () => {
  const { id, trackId } = await playlist(), headers = { cookie: viewerCookie };
  for (const [method, url, payload] of [
    ["POST", `/api/playlists/${id}/tracks`, { trackId }], ["DELETE", `/api/playlists/${id}/tracks/missing`, undefined],
    ["PUT", `/api/playlists/${id}/tracks/reorder`, { trackIds: [trackId] }],
    ["POST", `/api/v1/playlists/${id}/reorder`, { itemIds: [], expectedItemIds: [] }],
    ["POST", `/api/v1/playlists/${id}/tracks/batch`, { action: "add", trackIds: [trackId] }],
    ["PUT", `/api/v1/playlists/${id}/tracks`, { ownerId: viewer.id, revision: 1, edit: { kind: "add", trackIds: [trackId] } }],
    ["POST", `/api/v1/playlists/${id}/commands`, { ownerId: viewer.id, revision: 1, edit: { kind: "add", trackIds: [trackId] } }],
    ["PATCH", `/api/playlists/${id}`, { name: "Unauthorized" }], ["DELETE", `/api/playlists/${id}`, undefined],
    ["PUT", `/api/playlists/${id}/artwork`, { image: "invalid" }], ["DELETE", `/api/playlists/${id}/artwork`, undefined],
  ] as const) {
    const response = await server.app.inject({ method, url, headers, payload }); expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403);
  }
  expect((await server.app.inject({ url: `/api/playlists/${id}`, headers })).statusCode).toBe(200);
  expect((await server.app.inject({ url: `/api/v1/playlists/${id}/sharing/users`, headers })).statusCode).toBe(403);
});
test("collaborator edits persist authenticated attribution and show in shared list, tree and search", async () => {
  const { id, trackId } = await playlist(), headers = { cookie: editorCookie };
  const state = await server.app.inject({ url: `/api/v1/playlists/${id}/edit-state`, headers }); expect(state.statusCode).toBe(200);
  const response = await server.app.inject({ method: "PUT", url: `/api/v1/playlists/${id}/tracks`, headers,
    payload: { ownerId: editor.id, revision: state.json().revision, edit: { kind: "add", trackIds: [trackId] } } });
  expect(response.statusCode).toBe(200); expect(response.json().playlist.tracks[0].addedBy).toMatchObject({ id: editor.id, displayName: editor.displayName });
  expect(response.json().playlist.permissions).toEqual({ canRead: true, canEditTracks: true, canManage: false });
  const tree = await server.app.inject({ url: "/api/v1/playlist-organization", headers }); expect(tree.json().playlists.some((p: { id: string }) => p.id === id)).toBe(true);
  expect((await server.playlists.search("Household", 100, editor)).some(p => p.id === id)).toBe(true);
  const stale = await server.app.inject({ method: "PUT", url: `/api/v1/playlists/${id}/tracks`, headers,
    payload: { ownerId: editor.id, revision: state.json().revision, edit: { kind: "add", trackIds: [trackId] } } }); expect(stale.statusCode).toBe(409);
  for (const method of ["PATCH", "DELETE"] as const) expect((await server.app.inject({ method, url: `/api/playlists/${id}`, headers,
    ...(method === "PATCH" ? { payload: { name: "Not owner" } } : {}) })).statusCode).toBe(403);
});
test("invitation endpoint requires authentication and the intended recipient; account guards reject stale tabs", async () => {
  const { id } = await playlist();
  const bad = await server.app.inject({ method: "PUT", url: `/api/v1/playlists/${id}/sharing`, headers: { cookie: ownerCookie },
    payload: { ownerId: editor.id, revision: 1, mode: "PRIVATE", grants: [] } }); expect(bad.statusCode).toBe(409);
  const created = await server.app.inject({ method: "POST", url: `/api/v1/playlists/${id}/sharing/links`, headers: { cookie: ownerCookie },
    payload: { ownerId: owner.id, recipientUserId: viewer.id } }); expect(created.statusCode).toBe(201);
  const token = created.json().token;
  expect((await server.app.inject({ method: "POST", url: "/api/v1/playlist-shares/resolve", payload: { token } })).statusCode).toBe(401);
  expect((await server.app.inject({ method: "POST", url: "/api/v1/playlist-shares/resolve", headers: { cookie: editorCookie }, payload: { token } })).statusCode).toBe(403);
  const resolved = await server.app.inject({ method: "POST", url: "/api/v1/playlist-shares/resolve", headers: { cookie: viewerCookie }, payload: { token } });
  expect(resolved.json()).toEqual({ playlistId: id }); expect(resolved.headers["cache-control"]).toContain("no-store");
});
test("party HTTP requests revalidate collaborator access and isolate host controls by device", async () => {
  const { id, trackId } = await playlist(), deviceId = randomUUID();
  const opened = await server.app.inject({ method: "POST", url: `/api/v1/playlists/${id}/party`, headers: { cookie: ownerCookie }, payload: { ownerId: owner.id, deviceId } });
  expect(opened.statusCode).toBe(201);
  const payload = { ownerId: editor.id, trackId, idempotencyKey: randomUUID() };
  const send = () => server.app.inject({ method: "POST", url: `/api/v1/playlists/${id}/party/requests`, headers: { cookie: editorCookie }, payload });
  const first = await send(); expect(first.statusCode).toBe(201); expect((await send()).json()).toEqual(first.json());
  const state = await server.app.inject({ url: `/api/v1/playlists/${id}/party?deviceId=${deviceId}`, headers: { cookie: ownerCookie } });
  expect(state.json().party.isHost).toBe(true); expect(state.json().requests[0].track.id).toBe(trackId);
  expect((await server.app.inject({ method: "POST", url: `/api/v1/playlists/${id}/party/control`, headers: { cookie: ownerCookie },
    payload: { ownerId: owner.id, deviceId: randomUUID(), action: "QUEUED", requestId: first.json().id } })).statusCode).toBe(403);
  new PlaylistCollaborationService(server.db).update(id, owner, 1, "PRIVATE", []);
  expect((await send()).statusCode).toBe(403);
  expect((await server.app.inject({ url: `/api/playlists/${id}`, headers: { cookie: editorCookie } })).statusCode).toBe(404);
  expect(server.db.pragma("foreign_key_check")).toEqual([]);
});
test("exports and resume bookmarks respect named shares and do not leak ownerless playlists made private", async () => {
  const { id, trackId } = await playlist();
  const exports = new DataExportService(server.db, server.catalog, { publicUrl: "http://localhost", musicRoot: server.directory, log: () => {} });
  expect(exports.summary(viewer.id).playlists.some(row => row.id === id)).toBe(true);
  const resumes = new ResumableMediaService(server.db);
  resumes.save(viewer.id, { type: "playlist", mediaId: id, title: "Household", trackId, occurrenceId: null, trackIndex: 0, trackCount: 1, positionSeconds: 5, durationSeconds: 90, capturedAt: Date.now() });
  expect(resumes.get(viewer.id, "playlist", id)).toBeTruthy();
  new PlaylistCollaborationService(server.db).update(id, owner, 1, "PRIVATE", []);
  expect(exports.summary(viewer.id).playlists.some(row => row.id === id)).toBe(false);
  expect(resumes.get(viewer.id, "playlist", id)).toBeNull();
  server.db.prepare("UPDATE playlists SET owner_user_id=NULL WHERE id=?").run(id);
  expect(exports.summary(viewer.id).playlists.some(row => row.id === id)).toBe(false);
  expect(() => exports.stream(viewer.id, "playlists", "m3u8", id)).toThrow("not found");
});
