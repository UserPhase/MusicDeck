import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { createSession } from "../src/auth/sessions.js";
import { registerSetupRecoveryRoutes } from "../src/routes/admin/setup-recovery.js";
import { SystemHealthWizard } from "../src/services/SystemHealthWizard.js";
let current: { app: FastifyInstance; db: Db; root: string } | null = null;
afterEach(async () => { vi.restoreAllMocks(); if (current) { await current.app.close(); current.db.close(); const root = path.resolve(current.root); if (!root.startsWith(path.join(os.tmpdir(), "musicdeck-recovery-route-"))) throw new Error("Invalid test path"); fs.rmSync(root, { recursive: true, force: true }); current = null; } });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-recovery-route-"));
  const config = loadConfig({ databasePath: path.join(root, "db.sqlite"), sessionSecret: "test-secret", firstAdmin: { username: "admin", password: "password" }, navidrome: { url: "http://navidrome.test", username: "music", password: "backend-secret" } });
  const db = await openDatabase(config), app = Fastify({ logger: false }); await app.register(cookie);
  const admin = db.prepare("SELECT id FROM users WHERE role='admin'").get() as { id: string };
  const session = createSession(db, admin.id);
  const wizard = new SystemHealthWizard(db, config);
  const run = vi.spyOn(wizard, "runConfigured").mockResolvedValue({ checkedAt: new Date().toISOString(), status: "pass", ready: true, checks: [] });
  await registerSetupRecoveryRoutes(app, db, config, { wizard });
  current = { app, db, root };
  return { app, db, root, run, headers: { cookie: `musicdeck_session=${session.id}` } };
}
test("requires an administrator for status, diagnostics, archives, policy updates and restore", async () => {
  const context = await fixture();
  for (const [method, url] of [["GET", "status"], ["POST", "diagnostics"], ["POST", "backups"], ["PATCH", "backup-policy"], ["POST", "restore"]] as const) {
    const response = await context.app.inject({ method, url: `/api/v1/admin/system/${url}` }); expect(response.statusCode).toBe(401);
  }
  context.db.prepare("UPDATE users SET role='user'").run();
  expect((await context.app.inject({ method: "GET", url: "/api/v1/admin/system/status", headers: context.headers })).statusCode).toBe(403);
});
test("status redacts credentials and persists daily backup policy", async () => {
  const context = await fixture();
  const response = await context.app.inject({ method: "GET", url: "/api/v1/admin/system/status", headers: context.headers });
  expect(response.statusCode).toBe(200); expect(response.json().configuration.navidrome.passwordSet).toBe(true); expect(response.body).not.toContain("backend-secret");
  expect(response.headers["cache-control"]).toBe("no-store"); expect(response.json().restartSupported).toBe(false);
  const saved = await context.app.inject({ method: "PATCH", url: "/api/v1/admin/system/backup-policy", headers: context.headers, payload: { daily: true } });
  expect(saved.statusCode).toBe(200);
  expect((context.db.prepare("SELECT value FROM server_settings WHERE key='recovery.backupDaily'").get() as { value: string }).value).toBe("true");
});
test("runs a structured report and prevents cross-origin recovery requests", async () => {
  const context = await fixture();
  expect((await context.app.inject({ method: "POST", url: "/api/v1/admin/system/diagnostics", headers: context.headers })).json().report.ready).toBe(true);
  expect(context.run).toHaveBeenCalledTimes(1);
  expect((await context.app.inject({ method: "POST", url: "/api/v1/admin/system/backups", headers: { ...context.headers, origin: "https://untrusted.example" } })).statusCode).toBe(403);
});
test("refuses restore when the runtime cannot safely restart", async () => {
  const context = await fixture();
  const response = await context.app.inject({ method: "POST", url: "/api/v1/admin/system/restore", headers: { ...context.headers, "content-type": "application/gzip", "x-musicdeck-confirm-restore": "replace-system-data" }, payload: Buffer.from("invalid gzip") });
  expect(response.statusCode).toBe(409); expect(fs.existsSync(path.join(context.root, ".recovery"))).toBe(false);
});
