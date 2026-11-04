import fs from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createUser } from "../src/users/users.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;
const album = { name: "Undownloaded Record", artist: "Example Artist", coverUrl: "https://example.test/cover.jpg" };
const id = "external_deezer_album_42";
beforeEach(async () => {
  env = await createTestServer();
  cookie = (await login(env.app)).cookie!;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestServer(env.app, env.db);
  fs.rmSync(env.directory, { recursive: true, force: true });
});
const like = (favorite = true, session = cookie, metadata: unknown = album) => env.app.inject({
  method: "PUT", url: `/api/library/album/${id}/favorite`, headers: { cookie: session },
  payload: { favorite, ...(metadata ? { album: metadata } : {}) },
});
const list = (session = cookie) => env.app.inject({ method: "GET", url: "/api/favorites/albums", headers: { cookie: session } });

test("liking an external album persists its snapshot once and never downloads or creates a playlist", async () => {
  const acquire = vi.spyOn(env.acquisition, "createJob");
  const catalog = vi.spyOn(env.catalog, "getAlbum");
  expect((await like()).statusCode).toBe(200);
  expect((await like()).statusCode).toBe(200);
  expect((await list()).json().albums).toEqual([{ id, ...album }]);
  expect(acquire).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM playlists").get()).toEqual({ n: 0 });
  const reopened = new Database(env.db.name, { readonly: true });
  try {
    const rows = reopened.prepare("SELECT metadata_json FROM media_favorites WHERE item_type = 'album'").all() as Array<{ metadata_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json)).toEqual(album);
  } finally { reopened.close(); }
  await like(true, cookie, null); // Legacy clients cannot erase the stored cover/title.
  expect((await list()).json().albums).toEqual([{ id, ...album }]);
  expect((await like(false)).statusCode).toBe(200);
  expect((await list()).json().albums).toEqual([]);
});

test("album favorites require authentication and remain private to each user", async () => {
  expect((await env.app.inject({ method: "GET", url: "/api/favorites/albums" })).statusCode).toBe(401);
  expect((await env.app.inject({ method: "PUT", url: `/api/library/album/${id}/favorite`, payload: { favorite: true, album } })).statusCode).toBe(401);
  await like();
  await createUser(env.db, { username: "listener", password: "listener-password" });
  const other = (await login(env.app, "listener", "listener-password")).cookie!;
  expect((await list(other)).json().albums).toEqual([]);
  await like(false, other);
  expect((await list()).json().albums).toHaveLength(1);
});

test("unsafe artwork and invalid album metadata are rejected", async () => {
  for (const metadata of [{ ...album, name: "" }, { ...album, coverUrl: "javascript:alert(1)" }, { ...album, artist: 42 }]) {
    expect((await like(true, cookie, metadata)).statusCode).toBe(400);
  }
  expect((await list()).json().albums).toEqual([]);
});

test("older local album favorites resolve their catalog metadata", async () => {
  await env.app.inject({ method: "PUT", url: "/api/library/album/album-1/favorite", headers: { cookie }, payload: { favorite: true } });
  vi.spyOn(env.catalog, "getAlbum").mockResolvedValue({ id: "album-1", name: "Local Record", artistName: "Local Artist", artworkId: "cover" } as never);
  expect((await list()).json().albums).toEqual([{ id: "album-1", name: "Local Record", artist: "Local Artist", coverArt: "cover" }]);
});
