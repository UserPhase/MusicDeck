import { afterEach, describe, expect, test, vi } from "vitest";
import { createUser, updateUser } from "../src/users/users.js";
import * as passwords from "../src/auth/passwords.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (env) await closeTestServer(env.app, env.db);
  env = undefined;
});

async function setup() {
  env = await createTestServer();
  const target = await createUser(env.db, { username: "target", password: "old-password" });
  if (!target) throw new Error("Missing fixture user");
  const admin = await login(env.app);
  const sessions = await Promise.all([login(env.app, "target", "old-password"), login(env.app, "target", "old-password")]);
  return { ...env, target, admin, sessions };
}

describe("session revocation", () => {
  test("administrator password reset revokes all cookies and requires the new password", async () => {
    const { app, db, target, admin, sessions } = await setup();
    const reset = await app.inject({ method: "PATCH", url: `/api/users/${target.id}`, headers: { cookie: admin.cookie },
      payload: { password: "replacement-password" } });
    expect(reset.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(target.id)).toEqual({ n: 0 });
    for (const session of sessions) {
      expect((await app.inject({ url: "/api/users/me", headers: { cookie: session.cookie } })).statusCode).toBe(401);
    }
    expect((await login(app, "target", "old-password")).response.statusCode).toBe(401);
    const fresh = await login(app, "target", "replacement-password");
    expect(fresh.response.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/users/me", headers: { cookie: fresh.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/users", headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });

  test("disable/re-enable never resurrects old sessions", async () => {
    const { app, target, admin, sessions } = await setup();
    for (const disabled of [true, false]) {
      const result = await app.inject({ method: "PATCH", url: `/api/users/${target.id}`,
        headers: { cookie: admin.cookie }, payload: { disabled } });
      expect(result.statusCode).toBe(200);
      for (const session of sessions) {
        expect((await app.inject({ url: "/api/users/me", headers: { cookie: session.cookie } })).statusCode).toBe(401);
      }
    }
    expect((await login(app, "target", "old-password")).response.statusCode).toBe(200);
  });

  test("self-service change retains only the current session and logout still revokes it", async () => {
    const { app, sessions } = await setup();
    const changed = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie: sessions[0].cookie },
      payload: { currentPassword: "old-password", newPassword: "self-new-password" } });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/users/me", headers: { cookie: sessions[0].cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/users/me", headers: { cookie: sessions[1].cookie } })).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: sessions[0].cookie } });
    expect((await app.inject({ url: "/api/users/me", headers: { cookie: sessions[0].cookie } })).statusCode).toBe(401);
    expect((await login(app, "target", "self-new-password")).response.statusCode).toBe(200);
  });

  test("account changes roll back if session invalidation fails", async () => {
    const { db, target } = await setup();
    const original = db.prepare("SELECT password_hash, disabled FROM users WHERE id = ?").get(target.id);
    db.exec("CREATE TRIGGER reject_revocation BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture revocation failure'); END");
    await expect(updateUser(db, target.id, { password: "new-password", disabled: true })).rejects.toThrow("fixture revocation failure");
    expect(db.prepare("SELECT password_hash, disabled FROM users WHERE id = ?").get(target.id)).toEqual(original);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(target.id)).toEqual({ n: 2 });
  });

  test("a login already verifying the old password cannot create a session after reset", async () => {
    const { app, db, target } = await setup();
    const originalVerify = passwords.verifyPassword;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(passwords, "verifyPassword").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return originalVerify(...args);
    });
    const pending = app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "target", password: "old-password" } }).then((response) => response);
    await ready;
    await updateUser(db, target.id, { password: "reset-password" });
    release();
    expect((await pending).statusCode).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(target.id)).toEqual({ n: 0 });
  });
});
