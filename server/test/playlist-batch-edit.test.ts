import { afterEach, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>> | undefined;
afterEach(async () => {
  if (current) await closeTestServer(current.app, current.db);
  current = undefined;
});

async function fixture() {
  const backend = createFakeBackend();
  current = await createTestServer(backend);
  const { app, db } = current;
  const cookie = (await login(app)).cookie;
  const created = await app.inject({ method: "POST", url: "/api/playlists", headers: { cookie }, payload: { name: "Editing" } });
  const id: string = created.json().playlist.id;
  const insert = db.prepare(`INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  ["first", "second", "third", "missing"].forEach((key, index) => {
    insert.run(key, id, index, "", index === 2 ? "same" : index === 0 ? "same" : key, new Date().toISOString());
  });
  const baseTrack = await backend.getTrack("same");
  vi.mocked(backend.getTrack).mockImplementation(async (trackId) => trackId === "missing" ? null : { ...baseTrack!, id: trackId, providerId: trackId });
  const order = () => (db.prepare("SELECT id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position").all(id) as { id: string; position: number }[]);
  const post = (path: string, payload: object, auth = cookie) => app.inject({
    method: "POST", url: `/api/v1/playlists/${id}/${path}`, headers: { cookie: auth }, payload,
  });
  return { ...current, id, cookie, post, order };
}

test("duplicate songs expose independent occurrence IDs, including unavailable positions", async () => {
  const { app, id, cookie, post, order } = await fixture();
  const detail = await app.inject({ url: `/api/playlists/${id}`, headers: { cookie } });
  expect(detail.json().playlist.itemIds).toEqual(["first", "second", "third", "missing"]);
  expect(detail.json().playlist.tracks.map((track: { playlistItemId: string }) => track.playlistItemId)).toEqual(["first", "second", "third"]);
  const next = ["third", "missing", "first", "second"];
  const response = await post("reorder", { itemIds: next, expectedItemIds: ["first", "second", "third", "missing"] });
  expect(response.statusCode).toBe(200);
  expect(response.json().playlist.itemIds).toEqual(next);
  expect(order().map((row) => row.position)).toEqual([0, 1, 2, 3]);
  const removed = await post("tracks/batch", { action: "remove", itemIds: ["first"], expectedItemIds: next });
  expect(removed.statusCode).toBe(200);
  expect(order().map((row) => row.id)).toEqual(["third", "missing", "second"]);
  expect(removed.json().playlist.tracks[0].playlistItemId).toBe("third");
});

test("invalid permutations and unknown removals are atomic; stale clients receive 409", async () => {
  const { post, order } = await fixture();
  const expectedItemIds = order().map((row) => row.id);
  for (const itemIds of [["first"], ["first", "first", "third", "missing"], ["first", "second", "third", "foreign"]]) {
    expect((await post("reorder", { itemIds, expectedItemIds })).statusCode).toBe(400);
    expect(order().map((row) => row.id)).toEqual(expectedItemIds);
  }
  expect((await post("tracks/batch", { action: "remove", itemIds: ["first", "foreign"], expectedItemIds })).statusCode).toBe(400);
  expect(order().map((row) => row.id)).toEqual(expectedItemIds);
  expect((await post("reorder", { itemIds: [...expectedItemIds].reverse(), expectedItemIds })).statusCode).toBe(200);
  const stale = await post("reorder", { itemIds: expectedItemIds, expectedItemIds });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe("PLAYLIST_CONFLICT");
  expect((await post("tracks/batch", { action: "remove", itemIds: ["first"], expectedItemIds })).statusCode).toBe(409);
  expect(order().map((row) => row.id)).toEqual([...expectedItemIds].reverse());
});

test("legacy single removal accepts an occurrence ID and synchronizes the correct duplicate order", async () => {
  const { app, db, id, cookie, order, backend } = await fixture();
  db.prepare("UPDATE playlists SET source_playlist_id = ? WHERE id = ?").run("upstream", id);
  const response = await app.inject({ method: "DELETE", url: `/api/playlists/${id}/tracks/third`, headers: { cookie } });
  expect(response.statusCode).toBe(204);
  expect(order().map((row) => row.id)).toEqual(["first", "second", "missing"]);
  expect(backend.reorderPlaylistTracks).toHaveBeenCalledWith("upstream", ["same", "second", "missing"]);
  expect(backend.removePlaylistItem).not.toHaveBeenCalled();
});

test("batch addition is idempotent and validates authenticated ownership", async () => {
  const { app, db, id, post, order } = await fixture();
  const before = order().length;
  expect((await post("tracks/batch", { action: "add", trackIds: ["new", "new", "other"] })).statusCode).toBe(200);
  expect(order()).toHaveLength(before + 2);
  expect((await post("tracks/batch", { action: "add", trackIds: ["new", "other"] })).statusCode).toBe(200);
  expect(order()).toHaveLength(before + 2);
  await createUser(db, { username: "other-user", password: "other-password" });
  const otherCookie = (await login(app, "other-user", "other-password")).cookie;
  for (const path of ["reorder", "tracks/batch"]) {
    const unauthorized = await app.inject({ method: "POST", url: `/api/v1/playlists/${id}/${path}`, payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    expect((await post(path, {}, otherCookie)).statusCode).toBe(403);
  }
  expect((await post("tracks/batch", { action: "add", trackIds: [] })).statusCode).toBe(400);
  expect((await post("tracks/batch", { action: "remove", itemIds: [], expectedItemIds: [] })).statusCode).toBe(400);
});

test("batch inserts roll back completely when any write fails", async () => {
  const { db, post, order } = await fixture();
  const before = order();
  db.exec(`CREATE TRIGGER reject_batch_entry BEFORE INSERT ON playlist_items
    WHEN NEW.provider_track_id = 'reject' BEGIN SELECT RAISE(ABORT, 'Rejected test entry'); END`);
  expect((await post("tracks/batch", { action: "add", trackIds: ["new", "reject"] })).statusCode).toBe(500);
  expect(order()).toEqual(before);
});

test("provider order sync is serialized and provider failures never discard local edits", async () => {
  const { db, id, backend, playlists, order } = await fixture();
  db.prepare("UPDATE playlists SET source_playlist_id = ? WHERE id = ?").run("upstream", id);
  const initial = order().map((row) => row.id);
  const reverse = [...initial].reverse();
  let release: () => void = () => { throw new Error("Provider call has not started"); };
  vi.mocked(backend.reorderPlaylistTracks).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(null);
  }));
  const first = playlists.reorderItems(id, reverse, initial);
  await vi.waitFor(() => expect(backend.reorderPlaylistTracks).toHaveBeenCalledTimes(1));
  const final = ["second", "first", "third", "missing"];
  const second = playlists.reorderItems(id, final, reverse);
  expect(backend.reorderPlaylistTracks).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(backend.reorderPlaylistTracks).toHaveBeenLastCalledWith("upstream", ["second", "same", "same", "missing"]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(backend.reorderPlaylistTracks).mockRejectedValueOnce(new Error("Provider offline"));
  await playlists.reorderItems(id, reverse, final);
  expect(order().map((row) => row.id)).toEqual(reverse);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("local edit is saved"), expect.any(Error));
  warning.mockRestore();
});
