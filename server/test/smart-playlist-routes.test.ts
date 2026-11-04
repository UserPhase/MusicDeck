import fs from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createUser } from "../src/users/users.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;

test("library-song search for Similar songs is authenticated and validates query input", async () => {
  expect((await env.app.inject({ url: "/api/v1/smart-playlists/seeds?q=Track" })).statusCode).toBe(401);
  const result = await env.app.inject({ url: "/api/v1/smart-playlists/seeds?q=Track", headers: { cookie } });
  expect(result.statusCode).toBe(200);
  expect(result.json().tracks[0]).toMatchObject({ title: "Track One" });
  expect((await env.app.inject({ url: `/api/v1/smart-playlists/seeds?q=${"x".repeat(301)}`, headers: { cookie } })).statusCode).toBe(400);
});
const rules = { operator: "AND", rules: [{ field: "title", operator: "contains", value: "Track" }] };
beforeEach(async () => {
  env = await createTestServer();
  cookie = (await login(env.app)).cookie!;
});
afterEach(async () => {
  await closeTestServer(env.app, env.db);
  fs.rmSync(env.directory, { recursive: true, force: true });
});
const create = (session = cookie) => env.app.inject({
  method: "POST", url: "/api/v1/smart-playlists", headers: { cookie: session }, payload: { name: "Dynamic", rules },
});

test("guided mixes persist their size and ordering across updates", async () => {
  const options = { size: 25, order: "variety", seed: 42 };
  const made = await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists", headers: { cookie }, payload: { name: "My mix", rules, options } });
  expect(made.statusCode).toBe(201);
  const id = made.json().playlist.id;
  expect(made.json().playlist.options).toEqual(options);
  await env.app.inject({ method: "PUT", url: `/api/v1/smart-playlists/${id}`, headers: { cookie }, payload: { name: "Renamed", rules } });
  expect((await env.app.inject({ url: `/api/v1/smart-playlists/${id}`, headers: { cookie } })).json().playlist.options).toEqual(options);
  expect((await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists", headers: { cookie }, payload: { name: "Bad", rules, options: { ...options, size: 0 } } })).statusCode).toBe(400);
});

test("fixed mixes become regular playlists with their selected songs, and stale previews cannot be saved", async () => {
  const options = { size: 25, order: "variety", seed: 42 };
  const preview = await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists/preview", headers: { cookie }, payload: { rules, options } });
  const payload = { name: "Party", rules, options, selectionToken: preview.json().selectionToken };
  expect((await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists/snapshot", payload })).statusCode).toBe(401);
  expect((await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists/snapshot", headers: { cookie }, payload: { ...payload, selectionToken: "a".repeat(64) } })).statusCode).toBe(409);
  const saved = await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists/snapshot", headers: { cookie }, payload });
  expect(saved.statusCode).toBe(201);
  expect(saved.json().kind).toBe("playlist");
  const id = saved.json().playlist.id;
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?").get(id)).toEqual({ n: preview.json().total });
  expect((await env.app.inject({ url: "/api/v1/smart-playlists", headers: { cookie } })).json().playlists).toEqual([]);
  expect((await env.app.inject({ url: "/api/playlists", headers: { cookie } })).json().playlists.some((item: { id: string }) => item.id === id)).toBe(true);
});

test("fixed mix creation rolls back the entire playlist if an entry cannot be stored", async () => {
  const before = (env.db.prepare("SELECT COUNT(*) AS n FROM playlists").get() as { n: number }).n;
  env.db.exec("CREATE TRIGGER fail_mix_entry BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT,'Test failure'); END;");
  const response = await env.app.inject({ method: "POST", url: "/api/v1/smart-playlists/snapshot", headers: { cookie }, payload: { name: "Fail", rules, options: { size: 25, order: "variety", seed: 42 } } });
  expect(response.statusCode).toBe(500);
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM playlists").get()).toEqual({ n: before });
});

test("creates, lists, edits, evaluates and deletes private rule definitions without freezing track IDs", async () => {
  const response = await create();
  expect(response.statusCode).toBe(201);
  const playlist = response.json().playlist;
  expect(playlist).toMatchObject({ name: "Dynamic", rules });
  const list = await env.app.inject({ url: "/api/v1/smart-playlists", headers: { cookie } });
  expect(list.json().playlists).toHaveLength(1);
  const result = await env.app.inject({ url: `/api/v1/smart-playlists/${playlist.id}/tracks`, headers: { cookie } });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ total: 1, warning: null });
  expect(result.json().tracks[0].title).toBe("Track One");
  const updatedRules = { field: "is_favorite", operator: "equals", value: true };
  const update = await env.app.inject({
    method: "PUT", url: `/api/v1/smart-playlists/${playlist.id}`, headers: { cookie },
    payload: { name: "Favorites", rules: updatedRules },
  });
  expect(update.statusCode).toBe(200);
  expect(update.json().playlist.rules).toEqual(updatedRules);
  const url = `/api/v1/smart-playlists/${playlist.id}/tracks`;
  expect((await env.app.inject({ url, headers: { cookie } })).json().total).toBe(0);
  const userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const trackId = result.json().tracks[0].id;
  env.db.prepare("INSERT INTO favorites VALUES (?,?,?)").run(userId, trackId, new Date().toISOString());
  expect((await env.app.inject({ url, headers: { cookie } })).json().total).toBe(1);
  expect((await env.app.inject({
    method: "DELETE", url: `/api/v1/smart-playlists/${playlist.id}`, headers: { cookie },
  })).statusCode).toBe(204);
  expect((await env.app.inject({ url, headers: { cookie } })).statusCode).toBe(404);
});

test("authentication and ownership apply to CRUD, previews and evaluation, including administrators", async () => {
  const id = (await create()).json().playlist.id;
  const user = await createUser(env.db, { username: "second", password: "second-password" });
  if (!user) throw new Error("Failed to create test user");
  const other = (await login(env.app, "second", "second-password")).cookie!;
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    expect((await env.app.inject({
      method, url: `/api/v1/smart-playlists/${id}`, headers: { cookie: other },
      ...(method === "PUT" ? { payload: { name: "Hacked", rules } } : {}),
    })).statusCode).toBe(404);
  }
  expect((await env.app.inject({ url: `/api/v1/smart-playlists/${id}/tracks`, headers: { cookie: other } })).statusCode).toBe(404);
  expect((await env.app.inject({ url: "/api/v1/smart-playlists", headers: { cookie: other } })).json().playlists).toEqual([]);
  const otherId = (await create(other)).json().playlist.id;
  expect((await env.app.inject({ url: `/api/v1/smart-playlists/${otherId}`, headers: { cookie } })).statusCode).toBe(404);
  env.db.prepare("DELETE FROM users WHERE id=?").run(user.id);
  expect(env.db.prepare("SELECT id FROM smart_playlists WHERE id=?").get(otherId)).toBeUndefined();
  for (const entry of [
    { method: "GET", url: "/api/v1/smart-playlists" },
    { method: "POST", url: "/api/v1/smart-playlists", payload: { name: "X", rules } },
    { method: "POST", url: "/api/v1/smart-playlists/preview", payload: { rules } },
    { method: "GET", url: `/api/v1/smart-playlists/${id}/tracks` },
    { method: "DELETE", url: `/api/v1/smart-playlists/${id}` },
  ] as const) expect((await env.app.inject(entry)).statusCode).toBe(401);
});

test("invalid rules, injection attempts and unbounded windows are rejected with explicit client errors", async () => {
  for (const invalid of [
    { operator: "AND", rules: [] }, { field: "title) OR 1=1--", operator: "equals", value: "x" },
    { field: "year", operator: "contains", value: "2020" }, { field: "is_favorite", operator: "equals", value: "true" },
  ]) {
    const preview = await env.app.inject({
      method: "POST", url: "/api/v1/smart-playlists/preview", headers: { cookie }, payload: { rules: invalid },
    });
    expect(preview.statusCode).toBe(400);
    const save = await env.app.inject({
      method: "POST", url: "/api/v1/smart-playlists", headers: { cookie }, payload: { name: "Invalid", rules: invalid },
    });
    expect(save.statusCode).toBe(400);
  }
  const id = (await create()).json().playlist.id;
  expect((await env.app.inject({
    url: `/api/v1/smart-playlists/${id}/tracks?limit=100000&offset=-1`, headers: { cookie },
  })).statusCode).toBe(400);
  const hostile = await env.app.inject({
    method: "POST", url: "/api/v1/smart-playlists/preview", headers: { cookie },
    payload: { rules: { field: "title", operator: "equals", value: "' OR 1=1 --" } },
  });
  expect(hostile.statusCode).toBe(200);
  expect(hostile.json().total).toBe(0);
});

test("a later catalog scan refreshes metadata and smart membership without rewriting the definition", async () => {
  const id = (await create()).json().playlist.id;
  const url = `/api/v1/smart-playlists/${id}/tracks`;
  expect((await env.app.inject({ url, headers: { cookie } })).json().total).toBe(1);
  const tracks = await env.backend.listTracks();
  env.backend.listTracks = async () => [{ ...tracks[0], title: "Changed title" }];
  await env.catalog.refreshIndex({
    taskId: "test-refresh", signal: new AbortController().signal,
    checkpoint: async () => {}, report: () => {}, throwIfCancelled: () => {},
    isPaused: () => false, onCancel: () => () => {},
  });
  expect((await env.app.inject({ url, headers: { cookie } })).json().total).toBe(0);
  expect((await env.app.inject({ url: `/api/v1/smart-playlists/${id}`, headers: { cookie } })).json().playlist.rules).toEqual(rules);
});
