import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { SystemHealthWizard } from "../src/services/SystemHealthWizard.js";
import { configurationSnapshot } from "../src/services/systemConfiguration.js";
const roots: string[] = [], databases: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "musicdeck-health-test-"))) throw new Error("Invalid test path"); fs.rmSync(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-health-test-")); roots.push(root);
  const config = loadConfig({ databasePath: path.join(root, "db.sqlite"), musicRoot: path.join(root, "music"), acquisitionTmpDir: path.join(root, "staging"), sessionSecret: "test-secret", firstAdmin: { username: "admin", password: "password" }, navidrome: { url: "http://navidrome.test/base", username: "music", password: "super-secret" } });
  fs.mkdirSync(config.musicRoot); fs.mkdirSync(config.acquisitionTmpDir); const db = await openDatabase(config); databases.push(db);
  const runner = { run: vi.fn(() => ({ kill: () => {}, promise: Promise.resolve({ exitCode: 0, stdout: "version", stderr: "" }) })) };
  return { root, db, config, runner };
}
test("checks authenticated Navidrome reachability without exposing passwords or auth tokens", async () => {
  const context = await fixture(), fetch = vi.fn(async () => new Response(JSON.stringify({ "subsonic-response": { status: "ok" } })));
  const report = await new SystemHealthWizard(context.db, context.config, { fetch, runner: context.runner }).runConfigured();
  expect(report.ready).toBe(true); expect(report.checks.find((check) => check.id === "backend-connection")?.status).toBe("pass");
  const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe("/base/rest/ping.view"); expect(url.searchParams.has("t")).toBe(true); expect(url.searchParams.has("p")).toBe(false); expect(init.redirect).toBe("error");
  expect(JSON.stringify(report)).not.toContain("super-secret"); expect(JSON.stringify(report)).not.toContain(url.searchParams.get("t"));
  expect(fs.readdirSync(context.config.musicRoot)).toEqual([]);
});
test("reports rejected Jellyfin API keys with an actionable fix", async () => {
  const context = await fixture(), fetch = vi.fn(async () => new Response("", { status: 401 }));
  const candidate = { ...configurationSnapshot(context.config), backend: "jellyfin" as const, jellyfin: { url: "http://jellyfin.test", apiKey: "secret-api-key" } };
  const report = await new SystemHealthWizard(context.db, context.config, { fetch, runner: context.runner }).run(candidate);
  expect(report.ready).toBe(false); expect(report.checks[0]).toMatchObject({ status: "fail", fix: expect.stringContaining("API key") });
  const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]; expect(url.search).toBe(""); expect(init.headers).toMatchObject({ "X-Emby-Token": "secret-api-key" });
  expect(JSON.stringify(report)).not.toContain("secret-api-key");
});
test("missing required directories fail while optional download-tool failures remain warnings", async () => {
  const context = await fixture();
  const runner = { run: () => ({ kill: () => {}, promise: Promise.reject(new Error("ENOENT")) }) };
  const report = await new SystemHealthWizard(context.db, context.config, { fetch: async () => { throw new Error("offline"); }, runner }).run({ ...configurationSnapshot(context.config), musicRoot: path.join(context.root, "missing") });
  expect(report.checks.find((check) => check.id === "music-directory")).toMatchObject({ status: "fail", fix: expect.stringContaining("Create") });
  expect(report.checks.find((check) => check.id === "spotdl")).toMatchObject({ status: "warning" });
  expect(report.checks.find((check) => check.id === "database-integrity")).toMatchObject({ status: "pass" });
});
