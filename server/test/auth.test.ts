import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import type { AppConfig } from "../src/config.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup(configOverrides: Partial<AppConfig> = {}) {
  current = await createTestServer(undefined, configOverrides);
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("auth and health", () => {
  test("public health does not require authentication", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: "musicdeck-server" });
  });

  test("admin health requires an admin session", async () => {
    const { app } = await setup();
    const denied = await app.inject({ method: "GET", url: "/api/admin/health" });

    expect(denied.statusCode).toBe(401);

    const { cookie } = await login(app);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/health",
      headers: { cookie },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ ok: true, backend: "navidrome" });
  });

  test("login success, session lookup, and logout", async () => {
    const { app } = await setup();
    const { response, cookie } = await login(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "admin", role: "admin" });
    expect(cookie).toContain("musicdeck_session=");
    expect(cookie).toContain("HttpOnly");

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie },
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });

    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie },
    });

    expect(afterLogout.json()).toEqual({ authenticated: false, user: null });
  });

  test("login failure does not create a session", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  test("production sessions use secure cookies", async () => {
     const { app } = await setup({ isProduction: true, secureCookies: true });
    const { cookie } = await login(app);

    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("password changes are hashed and require the old password", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const badChange = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "wrong-password", newPassword: "new-password" },
    });

    expect(badChange.statusCode).toBe(400);

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "admin-password", newPassword: "new-password" },
    });

    expect(change.statusCode).toBe(200);

    const oldLogin = await login(app, "admin", "admin-password");
    expect(oldLogin.response.statusCode).toBe(401);

    const newLogin = await login(app, "admin", "new-password");
    expect(newLogin.response.statusCode).toBe(200);
  });
});
