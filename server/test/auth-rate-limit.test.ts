import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import * as passwords from "../src/auth/passwords.js";
import type { AppConfig } from "../src/config.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;
const limits = { windowMs: 1000, ipMax: 4, accountMax: 2, maxConcurrent: 1, maxEntries: 100 };

async function setup(overrides: Partial<AppConfig> = {}) {
  current = await createTestServer(undefined, { loginRateLimit: limits, ...overrides });
  return current;
}

function attempt(username: string, password = "wrong-password", ip = "192.0.2.1", headers = {}) {
  return current!.app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress: ip, headers,
    payload: { username, password },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("login rate limiting at the HTTP boundary", () => {
  test("preserves generic failures, counts normalized identities, and recovers after expiry", async () => {
    const { db } = await setup();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failed = await attempt("admin");
    expect(failed.statusCode).toBe(401);
    expect(failed.json().error.message).toBe("Invalid username or password");
    expect((await attempt(" ADMIN ", "wrong", "192.0.2.2")).json()).toEqual(failed.json());
    const blocked = await attempt("admin", "admin-password", "192.0.2.3");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("1");
    expect(blocked.headers["set-cookie"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    now = 1000;
    const success = await attempt("admin", "admin-password", "192.0.2.3");
    expect(success.statusCode).toBe(200);
    expect(success.headers["set-cookie"]).toBeDefined();
    expect(success.json().user).toMatchObject({ username: "admin", role: "admin" });
  });

  test("unknown accounts receive the same failure and throttling responses", async () => {
    await setup();
    const known = await attempt("admin");
    const unknown = await attempt("missing", "wrong", "192.0.2.2");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(known.json());
    await attempt("admin");
    await attempt("missing", "wrong", "192.0.2.2");
    const knownBlocked = await attempt("admin");
    const unknownBlocked = await attempt("missing", "wrong", "192.0.2.2");
    expect(knownBlocked.statusCode).toBe(429);
    expect(unknownBlocked.statusCode).toBe(429);
    expect(knownBlocked.json()).toEqual(unknownBlocked.json());
  });

  test("IP protection survives username rotation and spoofed forwarded headers", async () => {
    await setup();
    for (let i = 0; i < 4; i++) {
      expect((await attempt(`missing-${i}`, "wrong", "192.0.2.1", {
        "x-forwarded-for": `198.51.100.${i + 1}`,
      })).statusCode).toBe(401);
    }
    expect((await attempt("admin", "admin-password")).statusCode).toBe(429);
    expect((await attempt("admin", "admin-password", "192.0.2.2")).statusCode).toBe(200);
  });

  test("different accounts and sources retain independent capacity", async () => {
    const { db } = await setup();
    await createUser(db, { username: "listener", password: "listener-password" });
    await attempt("missing");
    await attempt("missing");
    expect((await attempt("missing", "wrong", "192.0.2.2")).statusCode).toBe(429);
    expect((await attempt("listener", "listener-password", "192.0.2.2")).statusCode).toBe(200);
  });

  test("only explicitly trusted proxies influence the client IP", async () => {
    await setup({ trustedProxies: ["10.0.0.2"] });
    for (let i = 0; i < 4; i++) {
      expect((await attempt(`missing-${i}`, "wrong", "10.0.0.2", {
        "x-forwarded-for": "203.0.113.250, 192.0.2.1",
      })).statusCode).toBe(401);
    }
    expect((await attempt("fresh", "wrong", "10.0.0.2", {
      "x-forwarded-for": "203.0.113.251, 192.0.2.1",
    })).statusCode).toBe(429);
    expect((await attempt("admin", "admin-password", "10.0.0.2", {
      "x-forwarded-for": "192.0.2.2",
    })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await attempt(`untrusted-${i}`, "wrong", "10.0.0.3");
    expect((await attempt("fresh-2", "wrong", "10.0.0.3", {
      "x-forwarded-for": "192.0.2.99",
    })).statusCode).toBe(429);
  });

  test("global concurrent work is bounded and reservations are released on errors", async () => {
    await setup();
    let resolveVerification!: (valid: boolean) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const verification = new Promise<boolean>((resolve) => { resolveVerification = resolve; });
    const verify = vi.spyOn(passwords, "verifyPassword").mockImplementationOnce(() => {
      markStarted();
      return verification;
    });
    const first = attempt("admin").then((response) => response);
    await started;
    try {
      const blocked = await attempt("other", "wrong", "192.0.2.2");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("1");
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      resolveVerification(false);
      await first;
    }
    verify.mockRejectedValueOnce(new Error("Test verification failure"));
    expect((await attempt("admin", "wrong", "192.0.2.2")).statusCode).toBe(500);
    expect((await attempt("other", "wrong", "192.0.2.3")).statusCode).toBe(401);
  });
});
