import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup() {
  current = await createTestServer();
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

/**
 * Regression coverage for LAN/self-hosted multi-account deployments: two
 * independent user accounts sharing one MusicDeck server must never see or
 * mutate each other's private data (settings, favorites, recently played).
 */
describe("multi-user data isolation", () => {
  test("per-user settings do not leak between accounts", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "alice", password: "alice-password", role: "user" });
    await createUser(db, { username: "bob", password: "bob-password", role: "user" });

    const { cookie: aliceCookie } = await login(app, "alice", "alice-password");
    const { cookie: bobCookie } = await login(app, "bob", "bob-password");

    const aliceUpdate = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie: aliceCookie },
      payload: { settings: { "playback.defaultVolume": 0.2 } },
    });
    expect(aliceUpdate.statusCode).toBe(200);

    const bobUpdate = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie: bobCookie },
      payload: { settings: { "playback.defaultVolume": 0.9 } },
    });
    expect(bobUpdate.statusCode).toBe(200);

    const aliceSettings = await app.inject({
      method: "GET",
      url: "/api/settings/user",
      headers: { cookie: aliceCookie },
    });
    const bobSettings = await app.inject({
      method: "GET",
      url: "/api/settings/user",
      headers: { cookie: bobCookie },
    });

    const aliceVolume = (aliceSettings.json().settings as Array<{ key: string; value: unknown }>)
      .find((entry) => entry.key === "playback.defaultVolume");
    const bobVolume = (bobSettings.json().settings as Array<{ key: string; value: unknown }>)
      .find((entry) => entry.key === "playback.defaultVolume");

    expect(String(aliceVolume?.value)).toBe("0.2");
    expect(String(bobVolume?.value)).toBe("0.9");
  });

  test("favorite tracks are scoped per user", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "alice", password: "alice-password", role: "user" });
    await createUser(db, { username: "bob", password: "bob-password", role: "user" });

    const { cookie: aliceCookie } = await login(app, "alice", "alice-password");
    const { cookie: bobCookie } = await login(app, "bob", "bob-password");

    const tracksResponse = await app.inject({
      method: "GET",
      url: "/api/tracks",
      headers: { cookie: aliceCookie },
    });
    const trackId = tracksResponse.json().tracks[0].id as string;

    const favorite = await app.inject({
      method: "PUT",
      url: `/api/favorites/tracks/${trackId}`,
      headers: { cookie: aliceCookie },
    });
    expect(favorite.statusCode).toBe(200);

    const aliceFavorites = await app.inject({
      method: "GET",
      url: "/api/favorites/tracks",
      headers: { cookie: aliceCookie },
    });
    const bobFavorites = await app.inject({
      method: "GET",
      url: "/api/favorites/tracks",
      headers: { cookie: bobCookie },
    });

    expect(aliceFavorites.json().tracks).toHaveLength(1);
    expect(bobFavorites.json().tracks).toHaveLength(0);
  });

  test("recently played history is scoped per user", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "alice", password: "alice-password", role: "user" });
    await createUser(db, { username: "bob", password: "bob-password", role: "user" });

    const { cookie: aliceCookie } = await login(app, "alice", "alice-password");
    const { cookie: bobCookie } = await login(app, "bob", "bob-password");

    const tracksResponse = await app.inject({
      method: "GET",
      url: "/api/tracks",
      headers: { cookie: aliceCookie },
    });
    const trackId = tracksResponse.json().tracks[0].id as string;

    const played = await app.inject({
      method: "POST",
      url: "/api/recently-played",
      headers: { cookie: aliceCookie },
      payload: { trackId },
    });
    expect(played.statusCode).toBe(201);

    const alicePlayed = await app.inject({
      method: "GET",
      url: "/api/recently-played",
      headers: { cookie: aliceCookie },
    });
    const bobPlayed = await app.inject({
      method: "GET",
      url: "/api/recently-played",
      headers: { cookie: bobCookie },
    });

    expect(alicePlayed.json().tracks).toHaveLength(1);
    expect(bobPlayed.json().tracks).toHaveLength(0);
  });

  test("a non-admin user cannot manage other accounts or read admin-only server settings", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "alice", password: "alice-password", role: "user" });

    const { cookie: aliceCookie } = await login(app, "alice", "alice-password");

    const listUsers = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: aliceCookie },
    });
    expect(listUsers.statusCode).toBe(403);

    const serverSettings = await app.inject({
      method: "GET",
      url: "/api/admin/settings/server",
      headers: { cookie: aliceCookie },
    });
    expect(serverSettings.statusCode).toBe(403);
  });

  test("sessions are isolated: logging out one user does not affect the other's session", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "alice", password: "alice-password", role: "user" });
    await createUser(db, { username: "bob", password: "bob-password", role: "user" });

    const { cookie: aliceCookie } = await login(app, "alice", "alice-password");
    const { cookie: bobCookie } = await login(app, "bob", "bob-password");

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: aliceCookie },
    });
    expect(logout.statusCode).toBe(200);

    const aliceSession = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: aliceCookie },
    });
    expect(aliceSession.json()).toEqual({ authenticated: false, user: null });

    const bobSession = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: bobCookie },
    });
    expect(bobSession.json().authenticated).toBe(true);
    expect(bobSession.json().user).toMatchObject({ username: "bob" });
  });
});
