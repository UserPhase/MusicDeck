import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createUser } from "../src/users/users.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;
const album = {
  provider: "deezer", external_id: "external_deezer_album_7", type: "album",
  title: "Saved Album", artist: "Artist One", cover_url: "https://example.test/cover.jpg",
  metadata: { year: 2024, previewUrl: "https://example.test/preview.mp3", songCount: 1 } as Record<string, unknown>,
};
beforeEach(async () => {
  env = await createTestServer();
  cookie = (await login(env.app)).cookie!;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestServer(env.app, env.db);
  fs.rmSync(env.directory, { recursive: true, force: true });
});
const save = (payload = album, session = cookie) => env.app.inject({
  method: "POST", url: "/api/v1/discoveries/save", headers: { cookie: session }, payload,
});
const list = (session = cookie) => env.app.inject({
  method: "GET", url: "/api/v1/discoveries/saved", headers: { cookie: session },
});

test("bookmarks persist metadata, canonicalize duplicate IDs, and never create acquisitions or tasks", async () => {
  const create = vi.spyOn(env.acquisition, "createJob");
  const first = await save();
  expect(first.statusCode).toBe(201);
  const second = await save({ ...album, external_id: "7" });
  expect(second.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
  expect(first.json().discovery).toMatchObject({ provider: "deezer", external_id: "7", metadata: album.metadata });
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 1 });
  expect(create).not.toHaveBeenCalled();
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM acquisition_jobs").get()).toEqual({ n: 0 });
  const reopened = new Database(env.db.name, { readonly: true });
  try {
    expect(reopened.prepare("SELECT external_id FROM saved_discoveries").all()).toEqual([{ external_id: "7" }]);
  } finally {
    reopened.close();
  }
});

test("all routes require authentication and a user cannot read or delete another user's saves", async () => {
  for (const method of ["GET", "POST", "DELETE"] as const) {
    const response = await env.app.inject({
      method, url: method === "POST" ? "/api/v1/discoveries/save" : `/api/v1/discoveries/saved${method === "DELETE" ? "/missing" : ""}`,
      ...(method === "POST" ? { payload: album } : {}),
    });
    expect(response.statusCode).toBe(401);
  }
  const id = (await save()).json().discovery.id;
  await createUser(env.db, { username: "listener", password: "listener-password" });
  const other = (await login(env.app, "listener", "listener-password")).cookie!;
  expect((await list(other)).json().discoveries).toEqual([]);
  expect((await env.app.inject({
    method: "DELETE", url: `/api/v1/discoveries/saved/${id}`, headers: { cookie: other },
  })).statusCode).toBe(404);
  expect((await save(album, other)).statusCode).toBe(201);
  expect((await list()).json().discoveries).toHaveLength(1);
  expect((await env.app.inject({
    method: "DELETE", url: `/api/v1/discoveries/saved/${id}`, headers: { cookie },
  })).statusCode).toBe(204);
  expect((await list()).json().discoveries).toEqual([]);
});

test("track, album and provider identities remain distinct; invalid payloads and unsafe artwork are rejected", async () => {
  for (const invalid of [{ ...album, provider: "spotify" }, { ...album, type: "artist" },
    { ...album, title: "" }, { ...album, cover_url: "javascript:alert(1)" }, { ...album, user_id: "another-user" }]) {
    expect((await save(invalid)).statusCode).toBe(400);
  }
  await save({ ...album, external_id: "7" });
  await save({ ...album, external_id: "7", provider: "itunes" });
  await save({ ...album, external_id: "7", type: "track" });
  expect((await list()).json().discoveries).toHaveLength(3);
});

test("positive library matches automatically remove only this user's saved metadata", async () => {
  await save({ ...album, title: "Album One" });
  await save({ ...album, external_id: "8", type: "track", title: "Track One" });
  const response = await list();
  expect(response.statusCode).toBe(200);
  expect(response.json().discoveries).toEqual([]);
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 0 });
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM acquisition_jobs").get()).toEqual({ n: 0 });
  expect(response.json().warning).toBeNull();
});

test("durable acquisition state is cross-referenced even before a library scan sees the import", async () => {
  await save({ ...album, title: "New Album" });
  const userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  env.db.prepare(`INSERT INTO acquisition_jobs (id, user_id, status, requested_album_id, created_at, updated_at)
    VALUES ('saved-job', ?, 'queued', 'external_deezer_album_7', ?, ?)`).run(userId, new Date().toISOString(), new Date().toISOString());
  expect((await list()).json().discoveries[0].status).toBe("QUEUED");
  env.db.prepare("UPDATE acquisition_jobs SET status = 'downloading' WHERE id = 'saved-job'").run();
  expect((await list()).json().discoveries[0].status).toBe("IMPORTING");
  env.db.prepare("UPDATE acquisition_jobs SET status = 'completed' WHERE id = 'saved-job'").run();
  expect((await list()).json().discoveries).toEqual([]);
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 0 });
});

test("unreachable libraries preserve bookmarks and explicitly report unknown status without auto-pruning", async () => {
  await save({ ...album, title: "New Album" });
  vi.spyOn(env.catalog, "listTracks").mockRejectedValue(new Error("Library offline"));
  const response = await list();
  expect(response.statusCode).toBe(200);
  expect(response.json().warning).toContain("could not be checked");
  expect(response.json().discoveries[0]).toMatchObject({ inLibrary: false, status: "UNKNOWN" });
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 1 });
});

test("failed imports and other users' bookmarks survive automatic cleanup", async () => {
  const own = (await save({ ...album, title: "Album One" })).json().discovery.id;
  const failed = (await save({ ...album, external_id: "9", title: "Retry Album" })).json().discovery.id;
  const userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const other = await createUser(env.db, { username: "saved-other", password: "saved-password" });
  const otherCookie = (await login(env.app, "saved-other", "saved-password")).cookie!;
  await save({ ...album, title: "Album One" }, otherCookie);
  env.db.prepare(`INSERT INTO acquisition_jobs (id, user_id, status, error_message, requested_album_id, created_at, updated_at)
    VALUES ('failed-saved', ?, 'failed', 'No audio match', 'external_deezer_album_9', ?, ?)`)
    .run(userId, new Date().toISOString(), new Date().toISOString());
  expect((await list()).json().discoveries).toEqual([expect.objectContaining({ id: failed, status: "FAILED" })]);
  expect(env.db.prepare("SELECT id FROM saved_discoveries WHERE id = ?").get(own)).toBeUndefined();
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries WHERE user_id = ?").get(other!.id)).toEqual({ n: 1 });
});

test("an album with only some of its known tracks downloaded stays saved", async () => {
  await save({ ...album, title: "Album One", metadata: { songCount: 12 } });
  expect((await list()).json().discoveries).toEqual([expect.objectContaining({ title: "Album One", inLibrary: false })]);
});

test.each([undefined, null, "", " ", 0, -1, 1.5, true, "NaN", "Infinity", "1.0", {}, []])(
  "a missing or invalid album total (%j) cannot prune a partial bookmark", async value => {
    const metadata = value === undefined ? {} : { songCount: value };
    await save({ ...album, title: "Album One", metadata });
    expect((await list()).json().discoveries).toEqual([expect.objectContaining({ title: "Album One", inLibrary: false })]);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 1 });
  });

test.each([{ trackCount: 1 }, { songCount: "1" }, { songCount: 0, trackCount: 1 }])(
  "a verified total matching actual local tracks removes the bookmark: %j", async metadata => {
    await save({ ...album, title: "Album One", metadata });
    expect((await list()).json().discoveries).toEqual([]);
  });

test("conflicting album totals preserve the bookmark", async () => {
  await save({ ...album, title: "Album One", metadata: { songCount: 1, trackCount: 12 } });
  expect((await list()).json().discoveries).toHaveLength(1);
});

test("an upstream album count alone does not prove that all tracks are local", async () => {
  const original = await env.catalog.listAlbums();
  vi.spyOn(env.catalog, "listAlbums").mockResolvedValue({ ...original, items: original.items.map(item => ({ ...item, songCount: 12 })) });
  await save({ ...album, title: "Album One", metadata: { songCount: 12 } });
  expect((await list()).json().discoveries).toHaveLength(1);
});

test("a different local track count is not treated as the saved album's exact edition", async () => {
  const original = await env.catalog.listTracks();
  vi.spyOn(env.catalog, "listTracks").mockResolvedValue({ ...original, items: [...original.items, { ...original.items[0], id: "another-local-track" }] });
  await save({ ...album, title: "Album One", metadata: { songCount: 1 } });
  expect((await list()).json().discoveries).toHaveLength(1);
});

test("an explicit completed album import removes an unknown-count bookmark without a library match", async () => {
  await save({ ...album, title: "New Album", metadata: {} });
  const userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const timestamp = new Date(Date.now() + 1).toISOString();
  env.db.prepare(`INSERT INTO acquisition_jobs (id,user_id,status,requested_album_id,created_at,updated_at)
    VALUES ('explicit-album',?,'completed','external_deezer_album_7',?,?)`).run(userId, timestamp, timestamp);
  expect((await list()).json().discoveries).toEqual([]);
});

test("an old completed job does not remove a newly saved item missing from the library", async () => {
  await save({ ...album, title: "New Album" });
  const userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  env.db.prepare(`INSERT INTO acquisition_jobs (id, user_id, status, requested_album_id, created_at, updated_at)
    VALUES ('old-saved-job', ?, 'completed', 'external_deezer_album_7', ?, ?)`)
    .run(userId, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
  expect((await list()).json().discoveries).toEqual([expect.objectContaining({ title: "New Album", inLibrary: false })]);
});

test("a completed import belonging to another listener cannot change this user's saved status", async () => {
  await save({ ...album, title: "New Album" });
  const other = await createUser(env.db, { username: "other", password: "other-password" });
  if (!other) throw new Error("Failed to create test user");
  env.db.prepare(`INSERT INTO acquisition_jobs (id, user_id, status, requested_album_id, created_at, updated_at)
    VALUES ('other-job', ?, 'completed', 'external_deezer_album_7', ?, ?)`).run(other.id, new Date().toISOString(), new Date().toISOString());
  expect((await list()).json().discoveries[0]).toMatchObject({ inLibrary: false, status: "IDLE" });
});

test("deleting a user cascades only their saved discoveries", async () => {
  await save();
  const other = await createUser(env.db, { username: "other", password: "other-password" });
  if (!other) throw new Error("Failed to create test user");
  const otherCookie = (await login(env.app, "other", "other-password")).cookie!;
  await save(album, otherCookie);
  env.db.prepare("DELETE FROM users WHERE id = ?").run(other.id);
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 1 });
});
