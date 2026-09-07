import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { createId } from "../src/utils/ids.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup(backend = createFakeBackend()) {
  current = await createTestServer(backend);
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("MusicDeck-owned domain data", () => {
  test("recently played is stored per authenticated MusicDeck user with retention", async () => {
    const { app, db } = await setup();
    const { cookie } = await login(app);

    // Establish a stable track ID via a catalog read, then reference it.
    const tracksResponse = await app.inject({
      method: "GET",
      url: "/api/tracks",
      headers: { cookie },
    });
    const mdTrackId = tracksResponse.json().tracks[0].id as string;

    for (let index = 0; index < 105; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/recently-played",
        headers: { cookie },
        payload: { trackId: mdTrackId },
      });

      expect(response.statusCode).toBe(201);
    }

    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM recently_played"
    ).get() as { count: number };

    expect(count.count).toBe(100);

    const list = await app.inject({
      method: "GET",
      url: "/api/recently-played",
      headers: { cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().tracks.length).toBeGreaterThan(0);
    expect(list.json().tracks[0].id).toBe(mdTrackId);
  }, 10_000);

  test("favorites are stored per user by stable MusicDeck track ID", async () => {
    const backend = createFakeBackend();
    const { app, db } = await setup(backend);
    const { cookie } = await login(app);

    // Establish the stable ID via a catalog read so hydration can resolve it.
    const tracksResponse = await app.inject({
      method: "GET",
      url: "/api/tracks",
      headers: { cookie },
    });
    const mdTrackId = tracksResponse.json().tracks[0].id as string;

    const add = await app.inject({
      method: "PUT",
      url: `/api/favorites/tracks/${mdTrackId}`,
      headers: { cookie },
    });

    expect(add.statusCode).toBe(200);

    const row = db.prepare(
      "SELECT track_id FROM favorites WHERE track_id = ?"
    ).get(mdTrackId) as { track_id: string };

    expect(row).toBeTruthy();
    expect(row.track_id).toMatch(/^md_/);

    const list = await app.inject({
      method: "GET",
      url: "/api/favorites/tracks",
      headers: { cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().tracks[0]).toMatchObject({ id: mdTrackId });

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/favorites/tracks/${mdTrackId}`,
      headers: { cookie },
    });

    expect(remove.statusCode).toBe(200);

    const afterRemove = db.prepare(
      "SELECT track_id FROM favorites WHERE track_id = ?"
    ).get(mdTrackId);
    expect(afterRemove).toBeUndefined();
  });

  test("playlist ownership blocks normal users from changing another user's playlist", async () => {
    const { app, db } = await setup();
    const adminLogin = await login(app);
    const owner = await createUser(db, {
      username: "owner",
      password: "owner-password",
      role: "user",
    });
    const listener = await createUser(db, {
      username: "listener",
      password: "listener-password",
      role: "user",
    });

  const now = new Date().toISOString();
  const playlistId = createId("mdpl");
  db.prepare(`
    INSERT INTO playlists (id, owner_user_id, name, description, source_connection_id, source_playlist_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(playlistId, owner!.id, "Owned", now, now);

    const listenerLogin = await login(app, "listener", "listener-password");
    const denied = await app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie: listenerLogin.cookie },
      payload: { trackId: "track-2" },
    });

    expect(listener).toBeTruthy();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({ code: "FORBIDDEN" });

    const allowed = await app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie: adminLogin.cookie },
      payload: { trackId: "track-2" },
    });

    expect(allowed.statusCode).toBe(200);
  });

  test("new playlists are assigned to their creator", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/playlists",
      headers: { cookie },
      payload: { name: "Mine" },
    });

    expect(create.statusCode).toBe(201);
    expect(create.json().playlist.ownerUserId).toBeTruthy();

    const playlistId = create.json().playlist.id;
    const ownership = current!.db.prepare(
      "SELECT owner_user_id FROM playlists WHERE id = ?"
    ).get(playlistId) as { owner_user_id: string };

    expect(ownership.owner_user_id).toBeTruthy();
  });
});
