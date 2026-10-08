import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

async function setupWithSecondAdmin() {
  current = await createTestServer();
  const { app } = current;
  const master = await login(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: master.cookie },
    payload: { username: "deputy", password: "deputy-password", role: "admin" },
  });
  expect(created.statusCode).toBe(201);

  const deputy = await login(app, "deputy", "deputy-password");
  return { app, db: current.db, master, deputy, deputyId: created.json().user.id as string };
}

describe("master administrator guardrails", () => {
  test("the seeded admin is flagged as the master and later admins are not", async () => {
    const { app, master, deputyId } = await setupWithSecondAdmin();

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: master.cookie } });
    const users = list.json().users as Array<{ id: string; isMasterAdmin: boolean }>;

    expect(users.find((user) => user.id === master.response.json().user.id)?.isMasterAdmin).toBe(true);
    expect(users.find((user) => user.id === deputyId)?.isMasterAdmin).toBe(false);
  });

  test("other admins cannot disable, demote, re-permission, reset, or delete the master", async () => {
    const { app, master, deputy } = await setupWithSecondAdmin();
    const url = `/api/users/${master.response.json().user.id}`;

    for (const payload of [
      { disabled: true },
      { role: "user" },
      { externalSearchEnabled: false },
      { externalPlaybackEnabled: true },
      { password: "hijacked-password" },
    ]) {
      const response = await app.inject({ method: "PATCH", url, headers: { cookie: deputy.cookie }, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(403);
      expect(response.json().error.code).toBe("MASTER_ADMIN_PROTECTED");
    }

    const deletion = await app.inject({ method: "DELETE", url, headers: { cookie: deputy.cookie } });
    expect(deletion.statusCode).toBe(403);

    const rename = await app.inject({
      method: "PATCH",
      url,
      headers: { cookie: deputy.cookie },
      payload: { displayName: "Owner" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().user).toMatchObject({ displayName: "Owner", disabled: false, role: "admin" });
  });

  test("admins cannot lock themselves out but can still manage other admins", async () => {
    const { app, deputy, master, deputyId } = await setupWithSecondAdmin();
    const selfUrl = `/api/users/${deputyId}`;

    for (const payload of [{ disabled: true }, { role: "user" }]) {
      const response = await app.inject({ method: "PATCH", url: selfUrl, headers: { cookie: deputy.cookie }, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("SELF_LOCKOUT");
    }

    const selfDelete = await app.inject({ method: "DELETE", url: selfUrl, headers: { cookie: deputy.cookie } });
    expect(selfDelete.statusCode).toBe(403);

    const demote = await app.inject({
      method: "PATCH",
      url: selfUrl,
      headers: { cookie: master.cookie },
      payload: { externalPlaybackEnabled: false, role: "user" },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().user).toMatchObject({ role: "user", externalPlaybackEnabled: false });
  });
});

describe("admin user activity and preferences", () => {
  test("user payloads expose last login and last playback timestamps", async () => {
    const { app, db, master, deputyId } = await setupWithSecondAdmin();
    db.prepare("INSERT INTO recently_played (id, user_id, track_id, played_at) VALUES (?, ?, ?, ?)")
      .run("rp_1", deputyId, "track-1", "2024-05-01T10:00:00.000Z");

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: master.cookie } });
    const deputy = (list.json().users as any[]).find((user) => user.id === deputyId);

    expect(typeof deputy.lastLoginAt).toBe("string");
    expect(deputy.lastPlaybackAt).toBe("2024-05-01T10:00:00.000Z");
  });

  test("admins can read and override another user's preferences with validated values", async () => {
    const { app, master, deputy, deputyId } = await setupWithSecondAdmin();
    const url = `/api/admin/users/${deputyId}/settings`;

    const saved = await app.inject({
      method: "PATCH",
      url,
      headers: { cookie: master.cookie },
      payload: { settings: { "ui.theme": "light", "playback.streamQuality": "320", "playback.downloadQuality": "lossless" } },
    });
    expect(saved.statusCode).toBe(200);

    const own = await app.inject({ method: "GET", url: "/api/settings/user", headers: { cookie: deputy.cookie } });
    const values = Object.fromEntries((own.json().settings as any[]).map((row) => [row.key, JSON.parse(row.value)]));
    expect(values).toMatchObject({
      "ui.theme": "light",
      "playback.streamQuality": "320",
      "playback.downloadQuality": "lossless",
    });

    const invalid = await app.inject({
      method: "PATCH",
      url,
      headers: { cookie: master.cookie },
      payload: { settings: { "ui.theme": "neon" } },
    });
    expect(invalid.statusCode).toBe(400);

    const unknownUser = await app.inject({ method: "GET", url: "/api/admin/users/missing/settings", headers: { cookie: master.cookie } });
    expect(unknownUser.statusCode).toBe(404);
  });

  test("user and admin theme edits share one persisted value", async () => {
    const { app, master, deputy, deputyId } = await setupWithSecondAdmin();
    const readTheme = async (cookie: string, url: string) => {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      const row = (response.json().settings as any[]).find((setting) => setting.key === "ui.theme");
      return row ? JSON.parse(row.value) : null;
    };

    const own = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie: deputy.cookie },
      payload: { settings: { "ui.theme": "light" } },
    });
    expect(own.statusCode).toBe(200);
    expect(await readTheme(master.cookie, `/api/admin/users/${deputyId}/settings`)).toBe("light");

    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${deputyId}/settings`,
      headers: { cookie: master.cookie },
      payload: { settings: { "ui.theme": "dark" } },
    });
    expect(await readTheme(deputy.cookie, "/api/settings/user")).toBe("dark");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/settings/user",
      headers: { cookie: deputy.cookie },
      payload: { settings: { "ui.theme": "solarized" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(await readTheme(deputy.cookie, "/api/settings/user")).toBe("dark");
  });

  test("non-admins cannot read another user's preferences", async () => {
    const { app, master, deputyId } = await setupWithSecondAdmin();
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: master.cookie },
      payload: { username: "listener", password: "listener-password" },
    });
    const listener = await login(app, "listener", "listener-password");

    const denied = await app.inject({
      method: "GET",
      url: `/api/admin/users/${deputyId}/settings`,
      headers: { cookie: listener.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});
