import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { LogBuffer, installLogCapture, serverLogs } from "../src/utils/logger.js";

type Route = { method: string; url: string };

/** Flattens Fastify's printRoutes tree into concrete method + path pairs. */
function listRoutes(app: FastifyInstance): Route[] {
  const stack: string[] = [];
  const routes: Route[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = line.match(/^(.*?)([/*][^\s]*) \(([^)]+)\)$/);
    if (!match) continue;
    const depth = Math.round(match[1].length / 4);
    stack.length = depth;
    stack[depth] = match[2];
    const fullPath = stack.join("");
    for (const method of match[3].split(",").map((value) => value.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push({ method, url: fullPath.replace(/:[A-Za-z]+/g, "audit-id") });
    }
  }
  return routes;
}

const ADMIN_ONLY_NON_PREFIXED: Route[] = [
  { method: "GET", url: "/api/users" },
  { method: "POST", url: "/api/users" },
  { method: "PATCH", url: "/api/users/audit-id" },
  { method: "DELETE", url: "/api/users/audit-id" },
];

let current: { app: FastifyInstance; db: Parameters<typeof closeTestServer>[1] } | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system audit: admin auth guards", () => {
  test("every admin endpoint rejects anonymous (401) and non-admin (403) callers", async () => {
    const { app, db } = await createTestServer();
    current = { app, db };
    await createUser(db, { username: "listener", password: "listener-password", role: "user" });
    const { cookie } = await login(app, "listener", "listener-password");

    const adminRoutes = [
      ...listRoutes(app).filter((route) => /^\/api\/(v1\/)?admin\//.test(route.url)),
      ...ADMIN_ONLY_NON_PREFIXED,
    ];
    expect(adminRoutes.length).toBeGreaterThan(25);

    const failures: string[] = [];
    for (const route of adminRoutes) {
      const anonymous = await app.inject({ method: route.method as any, url: route.url, payload: route.method === "GET" || route.method === "DELETE" ? undefined : {} });
      if (anonymous.statusCode !== 401) failures.push(`${route.method} ${route.url} anonymous -> ${anonymous.statusCode}`);

      const listener = await app.inject({ method: route.method as any, url: route.url, headers: { cookie }, payload: route.method === "GET" || route.method === "DELETE" ? undefined : {} });
      if (listener.statusCode !== 403) failures.push(`${route.method} ${route.url} non-admin -> ${listener.statusCode}`);
    }

    expect(failures).toEqual([]);
  });
});

describe("system audit: settings persistence across restarts", () => {
  test("branding and scan schedule survive a server rebuild on the same SQLite file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-audit-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "persist.sqlite");

    const first = await createTestServer(createFakeBackend(), { databasePath });
    current = first;
    const admin = await login(first.app);
    const brand = await first.app.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie: admin.cookie }, payload: { appName: "Audit Deck" } });
    expect(brand.statusCode).toBe(200);
    const schedule = await first.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/server",
      headers: { cookie: admin.cookie },
      payload: { settings: { "library.scanSchedule": "0 3 * * 0" } },
    });
    expect(schedule.statusCode).toBe(200);
    await closeTestServer(first.app, first.db);
    current = null;

    const second = await createTestServer(createFakeBackend(), { databasePath });
    current = second;
    const publicConfig = await second.app.inject({ method: "GET", url: "/api/public/config" });
    expect(publicConfig.json()).toMatchObject({ appName: "Audit Deck" });

    const again = await login(second.app);
    const status = await second.app.inject({ method: "GET", url: "/api/admin/library/scan/status", headers: { cookie: again.cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ stored: "0 3 * * 0", expression: "0 3 * * 0", enabled: true, valid: true });
    expect(status.json().nextRunAt).toEqual(expect.any(String));
  });
});

describe("system audit: error handling", () => {
  test("a crashing backend call yields a normalized 5xx and an [ERROR] log entry with the root cause", async () => {
    const buffer = new LogBuffer();
    const stdoutWrite = process.stdout.write;
    // Keep the pino passthrough from cluttering test output.
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const backend = createFakeBackend({
        listAlbums: async () => {
          throw new Error("audit: simulated backend crash");
        },
      });
      const { app, db } = await createTestServer(backend, {}, undefined, undefined, undefined, undefined, { logger: true, logBuffer: buffer });
      current = { app, db };
      const { cookie } = await login(app);

      const response = await app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.json()).toEqual({ error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }) });
      expect(JSON.stringify(response.json())).not.toContain("at ");

      const errors = buffer.list({ level: "error" });
      const logged = errors.find((entry) => entry.message.includes("All catalog providers are unavailable"));
      expect(logged?.stack).toContain("Caused by [test-connection]: Error: audit: simulated backend crash");
      expect(response.body).not.toContain("simulated backend crash");

      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      process.stdout.write = stdoutWrite;
    }
  });

  test("an unhandled promise rejection is logged at error level without killing the process", async () => {
    const stderrWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      installLogCapture(serverLogs);
      const before = serverLogs.stats().lastSeq;
      process.emit("unhandledRejection", new Error("audit: stray rejection"), Promise.resolve());
      const entry = serverLogs.list({ after: before, level: "error" }).find((item) => item.message.includes("audit: stray rejection"));
      expect(entry).toMatchObject({ level: "error", source: "process" });
      expect(entry?.stack).toContain("audit: stray rejection");
    } finally {
      process.stderr.write = stderrWrite;
      serverLogs.clear();
    }
  });
});
