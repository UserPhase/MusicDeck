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

describe("profile, settings, authorization, and errors", () => {
  test("persists direct and 256 kbps preferences through user and admin settings", async () => {
    const { app, db } = await setup();
    const admin = await login(app);
    const id = (db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
    for (const quality of ["256", "direct", "original"]) {
      for (const url of ["/api/settings/user", `/api/admin/users/${id}/settings`]) {
        const saved = await app.inject({
          method: "PATCH", url, headers: { cookie: admin.cookie },
          payload: { settings: { "playback.streamQuality": quality } },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().settings).toContainEqual(expect.objectContaining({ key: "playback.streamQuality", value: JSON.stringify(quality) }));
      }
    }
  });
  test("album-aware playback is a validated per-user boolean preference", async () => {
    const { app, db } = await setup();
    const admin = await login(app);
    await createUser(db, { username: "album-listener", password: "listener-password", role: "user" });
    const listener = await login(app, "album-listener", "listener-password");
    for (const enabled of [true, false]) {
      const saved = await app.inject({
        method: "PATCH", url: "/api/settings/user", headers: { cookie: listener.cookie },
        payload: { settings: { "playback.albumAware": enabled } },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toContainEqual(expect.objectContaining({ key: "playback.albumAware", value: JSON.stringify(enabled) }));
    }
    const invalid = await app.inject({
      method: "PATCH", url: "/api/settings/user", headers: { cookie: listener.cookie },
      payload: { settings: { "playback.albumAware": "true" } },
    });
    expect(invalid.statusCode).toBe(400);
    const other = await app.inject({ method: "GET", url: "/api/settings/user", headers: { cookie: admin.cookie } });
    expect(other.json().settings.some((row: { key: string }) => row.key === "playback.albumAware")).toBe(false);
  });

  test("shuffle mode is validated, persisted and scoped to the signed-in user", async () => {
    const { app, db } = await setup();
    const admin = await login(app);
    await createUser(db, { username: "shuffle-listener", password: "listener-password", role: "user" });
    const listener = await login(app, "shuffle-listener", "listener-password");
    for (const mode of ["standard", "smart"]) {
      const saved = await app.inject({
        method: "PATCH", url: "/api/settings/user", headers: { cookie: listener.cookie },
        payload: { settings: { "playback.shuffleMode": mode } },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toContainEqual(expect.objectContaining({ key: "playback.shuffleMode", value: JSON.stringify(mode) }));
    }
    const invalid = await app.inject({
      method: "PATCH", url: "/api/settings/user", headers: { cookie: listener.cookie },
      payload: { settings: { "playback.shuffleMode": "random-sort" } },
    });
    expect(invalid.statusCode).toBe(400);
    const other = await app.inject({ method: "GET", url: "/api/settings/user", headers: { cookie: admin.cookie } });
    expect(other.json().settings.some((row: { key: string }) => row.key === "playback.shuffleMode")).toBe(false);
    expect((await app.inject({
      method: "PATCH", url: "/api/settings/user", payload: { settings: { "playback.shuffleMode": "smart" } },
    })).statusCode).toBe(401);
  });

  test("users can update safe profile fields but cannot escalate role", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie },
      payload: { role: "admin" },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: "VALIDATION_ERROR" });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie },
      payload: { displayName: "Admin User", avatarRef: "avatar-1" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().user).toMatchObject({
      displayName: "Admin User",
      avatarRef: "avatar-1",
      role: "admin",
    });
  });

  test("server settings require admin while user settings require authentication", async () => {
    const { app, db } = await setup();
    await createUser(db, {
      username: "listener",
      password: "listener-password",
      role: "user",
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/settings/user",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const normal = await login(app, "listener", "listener-password");
    const userSettings = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie: normal.cookie },
      payload: { settings: { "ui.compactLists": true, forbidden: true } },
    });

    expect(userSettings.statusCode).toBe(200);
    expect(userSettings.json().settings).toHaveLength(1);

    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/settings/server",
      headers: { cookie: normal.cookie },
    });
    expect(denied.statusCode).toBe(403);

    const admin = await login(app);
    const serverSettings = await app.inject({
      method: "PATCH",
      url: "/api/admin/settings/server",
      headers: { cookie: admin.cookie },
      payload: { settings: { "jobs.maxConcurrency": 2, ignored: "no" } },
    });

    expect(serverSettings.statusCode).toBe(200);
    expect(serverSettings.json().settings).toHaveLength(1);
  });

  test("admin routes return consistent errors for unauthenticated, user, and admin callers", async () => {
    const { app, db } = await setup();
    await createUser(db, {
      username: "listener",
      password: "listener-password",
      role: "user",
    });

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/admin/backend-connections",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });

    const normal = await login(app, "listener", "listener-password");
    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/backend-connections",
      headers: { cookie: normal.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({ code: "FORBIDDEN" });

    const admin = await login(app);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/backend-connections",
      headers: { cookie: admin.cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  test("validation errors use the standard API error envelope", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/recently-played",
      headers: { cookie },
      payload: { wrong: "shape" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid recently played request",
      },
    });
  });
});
