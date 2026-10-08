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

describe("app branding config", () => {
  test("public config is unauthenticated and defaults to MusicDeck", async () => {
    const { app } = await setup();

    const response = await app.inject({ method: "GET", url: "/api/public/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ appName: "MusicDeck" });
  });

  test("admins can rename the app and the public config reflects it", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { appName: "  Basement FM  " },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ appName: "Basement FM" });

    const publicConfig = await app.inject({ method: "GET", url: "/api/public/config" });
    expect(publicConfig.json()).toEqual({ appName: "Basement FM" });
  });

  test("non-admins and anonymous callers cannot rename the app", async () => {
    const { app, db } = await setup();
    await createUser(db, { username: "listener", password: "listener-password", role: "user" });

    const anonymous = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      payload: { appName: "Hijacked" },
    });
    expect(anonymous.statusCode).toBe(401);

    const normal = await login(app, "listener", "listener-password");
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: normal.cookie },
      payload: { appName: "Hijacked" },
    });
    expect(denied.statusCode).toBe(403);

    const publicConfig = await app.inject({ method: "GET", url: "/api/public/config" });
    expect(publicConfig.json()).toEqual({ appName: "MusicDeck" });
  });

  test.each([
    ["empty", { appName: "   " }],
    ["too long", { appName: "x".repeat(41) }],
    ["control characters", { appName: "Music\nDeck" }],
    ["wrong type", { appName: 42 }],
    ["unknown keys", { appName: "Fine", extra: true }],
  ])("rejects %s app names", async (_label, payload) => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("layout preset preference", () => {
  test("users can save each layout archetype and unsupported values are rejected", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    for (const preset of ["spotify", "apple", "ytmusic", "soundcloud"]) {
      const saved = await app.inject({
        method: "PATCH",
        url: "/api/settings/user",
        headers: { cookie },
        payload: { settings: { "ui.layoutPreset": preset } },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toEqual([
        expect.objectContaining({ key: "ui.layoutPreset", value: JSON.stringify(preset) }),
      ]);
    }

    for (const preset of ["winamp", "tidal"]) {
      const invalid = await app.inject({
        method: "PATCH",
        url: "/api/settings/user",
        headers: { cookie },
        payload: { settings: { "ui.layoutPreset": preset } },
      });
      expect(invalid.statusCode).toBe(400);
    }
  });
});
