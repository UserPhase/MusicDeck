import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createTestServer, closeTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { ExtensionManager } from "../src/services/ExtensionManager.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { createPrivacyManager } from "../src/services/PrivacyManager.js";
import { loadConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(code = "", id = "sonic-recommendations") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "musicdeck-extensions-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, id);
  await fs.mkdir(directory);
  const tracePath = path.join(root, "trace.log");
  const prefix = `import fs from "node:fs";
    const trace = (event) => fs.appendFileSync(${JSON.stringify(tracePath)}, event + "\\n");
    trace("import");
  `;
  await fs.writeFile(path.join(directory, "extension.json"), JSON.stringify({
    apiVersion: 1, id, name: "Sonic Recommendations", version: "1.0.0", entry: "index.mjs", description: "Optional sonic analysis",
  }));
  await fs.writeFile(path.join(directory, "index.mjs"), prefix + code);
  const server = await createTestServer(undefined, { extensionsDir: root });
  cleanups.push(() => closeTestServer(server.app, server.db));
  const cookie = (await login(server.app)).cookie!;
  const call = (method: "GET" | "POST" | "PATCH", suffix = "", payload?: unknown, auth = cookie) =>
    server.app.inject({ method, url: `/api/v1/admin/extensions${suffix}`, headers: { cookie: auth },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { cookie: auth, "content-type": "application/json" } }) });
  const trace = async () => (await fs.readFile(tracePath, "utf8")).trim().split("\n");
  return { ...server, root, directory, tracePath, trace, cookie, call };
}

test("discovery executes no code, enforces admin access, and toggles lifecycle routes after Fastify is ready", async () => {
  const current = await fixture(`export default () => {
    let active = false;
    return {
      async onServerStart(context) { trace("start"); active = !context.signal.aborted; },
      registerRoutes(register) { register("GET", "/status", async () => ({ active })); },
      async onServerStop() { trace("stop"); active = false; },
    };
  };`);
  const { call, db, app, trace } = current;
  expect(await fs.stat(current.tracePath).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  await createUser(db, { username: "extension-listener", password: "listener-password" });
  const listener = (await login(app, "extension-listener", "listener-password")).cookie!;
  for (const [method, suffix, payload] of [
    ["GET", "", undefined], ["POST", "/discover", undefined],
    ["PATCH", "/sonic-recommendations", { enabled: true }], ["GET", "/sonic-recommendations/routes/status", undefined],
  ] as const) {
    expect((await call(method, suffix, payload, "")).statusCode).toBe(401);
    expect((await call(method, suffix, payload, listener)).statusCode).toBe(403);
  }
  const inventory = await call("GET");
  expect(inventory.headers["cache-control"]).toContain("no-store");
  expect(inventory.json()).toMatchObject({ extensions: [{ id: "sonic-recommendations", enabled: false, status: "disabled" }], issues: [] });
  expect((await call("GET", "/sonic-recommendations/routes/status")).statusCode).toBe(404);
  expect((await call("PATCH", "/sonic-recommendations", { enabled: true, entry: "/tmp/exploit.mjs" })).statusCode).toBe(400);
  expect((await call("PATCH", "/sonic-recommendations", { enabled: true })).json()).toMatchObject({ extension: { enabled: true } });
  expect((await call("GET", "/sonic-recommendations/routes/status")).json()).toEqual({ active: true });
  expect((await call("PATCH", "/sonic-recommendations", { enabled: true })).statusCode).toBe(200);
  expect(await trace()).toEqual(["import", "start"]);
  expect((await call("PATCH", "/sonic-recommendations", { enabled: false })).json()).toMatchObject({ extension: { enabled: false, status: "disabled" } });
  expect((await call("GET", "/sonic-recommendations/routes/status")).statusCode).toBe(404);
  await call("PATCH", "/sonic-recommendations", { enabled: true });
  expect(await trace()).toEqual(["import", "start", "stop", "start"]);
  expect(db.prepare("SELECT enabled FROM server_extensions WHERE extension_id=?").get("sonic-recommendations")).toEqual({ enabled: 1 });
});

test("failed activation rolls back routes, removes task interception, and exposes retryable cleanup state", async () => {
  const { call, trace } = await fixture(`export default () => ({
    async onServerStart() { trace("start"); },
    registerRoutes(register) { register("GET", "/ready", async () => ({ ok: true })); throw new Error("private installation path /secret"); },
    async onServerStop() { trace("rollback"); }
  });`);
  const response = await call("PATCH", "/sonic-recommendations", { enabled: true });
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("/secret");
  expect((await call("GET")).json()).toMatchObject({ extensions: [{ status: "error", enabled: false, error: expect.any(String) }] });
  expect((await call("GET", "/sonic-recommendations/routes/ready")).statusCode).toBe(404);
  expect(await trace()).toEqual(["import", "start", "rollback"]);
  expect((await call("PATCH", "/sonic-recommendations", { enabled: false })).json()).toMatchObject({ extension: { status: "disabled" } });
});

test("hot disable aborts and drains an in-flight route before cleanup, without admitting new work", async () => {
  const { call, trace } = await fixture(`export default () => ({
    registerRoutes(register) {
      register("GET", "/wait", async (_request, _reply, signal) => {
        trace("route");
        await new Promise((resolve) => signal.addEventListener("abort", () => { trace("abort"); setTimeout(resolve, 40); }, { once: true }));
        trace("drained"); return { stopped: true };
      });
    },
    async onServerStop() { trace("stop"); }
  });`);
  await call("PATCH", "/sonic-recommendations", { enabled: true });
  const work = call("GET", "/sonic-recommendations/routes/wait").then((response) => response);
  await vi.waitFor(async () => expect(await trace()).toContain("route"));
  let disabled = false;
  const stop = call("PATCH", "/sonic-recommendations", { enabled: false }).then((response) => { disabled = true; return response; });
  await vi.waitFor(async () => expect(await trace()).toContain("abort"));
  expect((await call("GET", "/sonic-recommendations/routes/wait")).statusCode).toBe(404);
  expect(disabled).toBe(false);
  expect((await work).json()).toEqual({ stopped: true });
  expect((await stop).statusCode).toBe(200);
  expect(await trace()).toEqual(["import", "route", "abort", "drained", "stop"]);
});

test("invalid manifests and directory links never execute, and entry replacement requires review/restart", async () => {
  const { call, root, directory, tracePath } = await fixture(`export default () => ({});`);
  const bad = path.join(root, "bad");
  await fs.mkdir(bad);
  await fs.writeFile(path.join(bad, "extension.json"), JSON.stringify({ apiVersion: 1, id: "bad", name: "Bad", version: "1", entry: "../outside.mjs" }));
  await fs.writeFile(path.join(bad, "index.mjs"), `throw new Error("must not import");`);
  await fs.symlink(directory, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const discovered = (await call("POST", "/discover")).json();
  expect(discovered.extensions).toHaveLength(1);
  expect(discovered.issues).toHaveLength(2);
  expect(await fs.stat(tracePath).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  await fs.appendFile(path.join(directory, "index.mjs"), "\n// replacement");
  expect((await call("PATCH", "/sonic-recommendations", { enabled: true })).statusCode).toBe(500);
  expect(await fs.stat(tracePath).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
});

test("optional audio runners reuse task progress/cancellation and cannot override core definitions", async () => {
  const current = await fixture(`export default () => ({
    async onServerStart(context) {
      context.tasks.registerAudioAnalysis({
        validate: (payload) => typeof payload === "object" && payload !== null && typeof payload.wait === "boolean",
        async run(payload, task) {
          trace("run"); task.report({ percent: 25, itemsProcessed: 1, totalItems: 4 });
          if (payload.wait) await new Promise((resolve) => task.signal.addEventListener("abort", resolve, { once: true }));
          task.throwIfCancelled(); trace("finished");
        }
      });
    },
    async interceptTaskRunner(task, context, next) { trace("before:" + task.type); await next(); trace("after:" + task.type); },
    async onServerStop() { trace("stop"); }
  });`);
  const { app, call, cookie, trace } = current;
  await call("PATCH", "/sonic-recommendations", { enabled: true });
  const enqueue = (wait: boolean) => app.inject({ method: "POST", url: "/api/v1/admin/tasks", headers: { cookie },
    payload: { type: "AUDIO_ANALYSIS", payload: { wait } } });
  expect((await app.inject({ method: "POST", url: "/api/v1/admin/tasks", headers: { cookie }, payload: { type: "AUDIO_ANALYSIS", payload: {} } })).statusCode).toBe(400);
  const completed = await enqueue(false);
  expect(completed.statusCode).toBe(202);
  const task = async (id: string) => {
    const response = await app.inject({ url: "/api/v1/admin/tasks?includeTerminal=true", headers: { cookie } });
    return response.json().tasks.find((item: { id: string }) => item.id === id);
  };
  await vi.waitFor(async () => expect((await task(completed.json().task.id)).state).toBe("FINISHED"));
  expect(await trace()).toEqual(["import", "before:AUDIO_ANALYSIS", "run", "finished", "after:AUDIO_ANALYSIS"]);
  const scan = await app.inject({ method: "POST", url: "/api/v1/admin/tasks", headers: { cookie },
    payload: { type: "LIBRARY_SCAN", payload: {} } });
  expect(scan.statusCode).toBe(202);
  await vi.waitFor(async () => expect((await task(scan.json().task.id)).state).toBe("FINISHED"));
  expect(await trace()).not.toContain("before:LIBRARY_SCAN");
  const running = await enqueue(true);
  await vi.waitFor(async () => expect((await task(running.json().task.id)).progress.percent).toBe(25));
  // An extension abort must unblock the scheduler's own paused checkpoint too.
  await app.inject({ method: "POST", url: `/api/v1/admin/tasks/${running.json().task.id}/pause`, headers: { cookie } });
  expect((await call("PATCH", "/sonic-recommendations", { enabled: false })).statusCode).toBe(200);
  await vi.waitFor(async () => expect((await task(running.json().task.id)).state).toBe("CANCELLED"));
  expect((await enqueue(false)).statusCode).toBe(409);
});

test("enabled intent survives manager restarts, shutdown runs cleanup without disabling persisted intent", async () => {
  const current = await fixture(`export default () => ({
    async onServerStart() { trace("start"); }, async onServerStop() { trace("stop"); }
  });`);
  const tasks = new TaskManager(current.db, { monitorIntervalMs: 10000 });
  cleanups.push(() => tasks.close());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const privacy = createPrivacyManager(current.db, loadConfig());
  const manager = new ExtensionManager(current.db, current.root, tasks, logger, privacy);
  await manager.start(); await manager.setEnabled("sonic-recommendations", true); await manager.close();
  expect(current.db.prepare("SELECT enabled FROM server_extensions").get()).toEqual({ enabled: 1 });
  const restarted = new ExtensionManager(current.db, current.root, tasks, logger, privacy);
  cleanups.push(() => restarted.close());
  await restarted.start();
  expect(restarted.list().extensions[0]).toMatchObject({ enabled: true, status: "enabled" });
  await restarted.setEnabled("sonic-recommendations", false);
  expect(await current.trace()).toEqual(["import", "start", "stop", "start", "stop"]);
});

test("scan installs new folders after startup without loading code, and asynchronous route registration completes before admission", async () => {
  const { root, call, directory } = await fixture(`export default () => ({});`);
  const extra = path.join(root, "visualizer-proxy");
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, "extension.json"), JSON.stringify({
    apiVersion: 1, id: "visualizer-proxy", name: "Visualizer", version: "1", entry: "index.mjs",
  }));
  await fs.writeFile(path.join(extra, "index.mjs"), `export default () => ({
    async registerRoutes(register) { await Promise.resolve(); register("GET", "/health", async () => ({ ready: true })); }
  });`);
  expect((await call("GET")).json().extensions).toHaveLength(1);
  expect((await call("POST", "/discover")).json().extensions).toHaveLength(2);
  expect((await call("PATCH", "/visualizer-proxy", { enabled: true })).statusCode).toBe(200);
  expect((await call("GET", "/visualizer-proxy/routes/health")).json()).toEqual({ ready: true });
  expect((await call("GET", "/sonic-recommendations/routes/health")).statusCode).toBe(404);
  await fs.rm(path.join(directory, "index.mjs"));
  expect((await call("POST", "/discover")).json().issues).toHaveLength(1);
});

test("cleanup failures stay unavailable, are reported, and can be retried without re-running a module", async () => {
  const { call, trace } = await fixture(`export default () => {
    let attempts = 0;
    return { async onServerStart() { trace("start"); },
      registerRoutes(register) { register("GET", "/ready", async () => ({ ok: true })); },
      async onServerStop() { trace("stop"); if (!attempts++) throw new Error("cleanup requires retry"); }
    };
  };`);
  await call("PATCH", "/sonic-recommendations", { enabled: true });
  expect((await call("PATCH", "/sonic-recommendations", { enabled: false })).statusCode).toBe(500);
  expect((await call("GET", "/sonic-recommendations/routes/ready")).statusCode).toBe(404);
  expect((await call("PATCH", "/sonic-recommendations", { enabled: true })).statusCode).toBe(409);
  expect((await call("GET")).json().extensions[0]).toMatchObject({ enabled: false, status: "error", error: expect.stringContaining("cleanup failed") });
  expect((await call("PATCH", "/sonic-recommendations", { enabled: false })).statusCode).toBe(200);
  expect(await trace()).toEqual(["import", "start", "stop", "stop"]);
});

test("task middleware is reversible, awaits forgotten next calls and rejects duplicate next without running core twice", async () => {
  const current = await fixture(`export default () => ({});`);
  const tasks = new TaskManager(current.db, { minFreeMemoryBytes: 0, maxCpuLoadPerCore: 100, monitorIntervalMs: 10000 });
  cleanups.push(() => tasks.close());
  let finish: (() => void) | undefined;
  const run = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); });
  tasks.register("AUDIO_ANALYSIS", { validate: (value): value is unknown => value !== null, run });
  const remove = tasks.intercept("test", async (_task, _context, next) => { void next(); });
  const task = tasks.enqueue("AUDIO_ANALYSIS", {}, "admin");
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(tasks.get(task.id)?.state).toBe("PROCESSING");
  finish?.();
  expect((await tasks.waitForSettlement(task.id)).state).toBe("FINISHED");
  remove();
  tasks.unregister("AUDIO_ANALYSIS");
  const core = vi.fn(async () => {});
  tasks.register("AUDIO_ANALYSIS", { validate: (value): value is unknown => value !== null, run: core });
  const removeBroken = tasks.intercept("broken", async (_task, _context, next) => { await next(); await next(); });
  const failed = tasks.enqueue("AUDIO_ANALYSIS", {}, "admin");
  expect((await tasks.waitForSettlement(failed.id)).state).toBe("FAILED");
  expect(core).toHaveBeenCalledTimes(1);
  removeBroken();
  const unwrapped = tasks.enqueue("AUDIO_ANALYSIS", {}, "admin");
  expect((await tasks.waitForSettlement(unwrapped.id)).state).toBe("FINISHED");
  expect(core).toHaveBeenCalledTimes(2);
  let lateNext: (() => Promise<void>) | undefined;
  const removeLate = tasks.intercept("late", async (_task, _context, next) => { lateNext = next; });
  const handled = tasks.enqueue("AUDIO_ANALYSIS", {}, "admin");
  expect((await tasks.waitForSettlement(handled.id)).state).toBe("FINISHED");
  expect(() => lateNext?.()).toThrow("after returning");
  expect(core).toHaveBeenCalledTimes(2);
  removeLate();
});

test("extension route network context returns standard Local-Only errors without invoking transport", async () => {
  const current = await fixture(`export default () => {
    let network;
    return {
      async onServerStart(context) { network = context.network; },
      registerRoutes(register) { register("GET", "/lookup", async () => {
        await network.fetch("https://external.example.test/metadata"); return { ok: true };
      }); }
    };
  };`);
  await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: current.cookie },
    payload: { localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true } });
  await current.call("PATCH", "/sonic-recommendations", { enabled: true });
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected transport invocation"));
  try {
    const denied = await current.call("GET", "/sonic-recommendations/routes/lookup");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: "LOCAL_ONLY_MODE_ACTIVE" } });
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

test("startup network context enforces Local-Only outside HTTP request scope", async () => {
  const current = await fixture(`export default () => ({
    async onServerStart(context) { await context.network.fetch("https://external.example.test/metadata"); }
  });`);
  const privacy = createPrivacyManager(current.db, loadConfig());
  privacy.update({ localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true });
  const tasks = new TaskManager(current.db, { monitorIntervalMs: 10000 });
  cleanups.push(() => tasks.close());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new ExtensionManager(current.db, current.root, tasks, logger, privacy);
  cleanups.push(() => manager.close());
  await manager.start();
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected transport invocation"));
  try {
    await expect(manager.setEnabled("sonic-recommendations", true)).rejects.toThrow("Extension activation failed");
    expect(transport).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.objectContaining({ code: "LOCAL_ONLY_MODE_ACTIVE" }),
    }), "Extension activation failed");
  } finally { transport.mockRestore(); }
});

test("server preClose aborts and drains live module requests before waiting for HTTP shutdown", async () => {
  const current = await fixture(`export default () => ({
    registerRoutes(register) { register("GET", "/wait", async (_request, _reply, signal) => {
      trace("route");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      trace("drained"); return { stopped: true };
    }); },
    async onServerStop() { trace("stop"); }
  });`);
  await current.call("PATCH", "/sonic-recommendations", { enabled: true });
  const request = current.call("GET", "/sonic-recommendations/routes/wait").then((reply) => reply);
  await vi.waitFor(async () => expect(await current.trace()).toContain("route"));
  await current.app.close();
  expect((await request).json()).toEqual({ stopped: true });
  expect(await current.trace()).toEqual(["import", "route", "drained", "stop"]);
  expect(current.db.prepare("SELECT enabled FROM server_extensions").get()).toEqual({ enabled: 1 });
});

test("an analysis runner collision rolls back only the new extension, leaving the existing runner operational", async () => {
  const current = await fixture(`export default () => ({
    async onServerStart(context) { context.tasks.registerAudioAnalysis({
      validate: (payload) => payload !== null,
      async run() { trace("original-runner"); }
    }); }
  });`);
  await current.call("PATCH", "/sonic-recommendations", { enabled: true });
  const directory = path.join(current.root, "conflicting");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "extension.json"), JSON.stringify({
    apiVersion: 1, id: "conflicting", name: "Conflicting", version: "1", entry: "index.mjs",
  }));
  await fs.writeFile(path.join(directory, "index.mjs"), `export default () => ({
    async onServerStart(context) { context.tasks.registerAudioAnalysis({
      validate: () => true, async run() { throw new Error("Must not replace original"); }
    }); },
    async interceptTaskRunner(_task, _context, next) { throw new Error("Must be removed on rollback"); }
  });`);
  await current.call("POST", "/discover");
  expect((await current.call("PATCH", "/conflicting", { enabled: true })).statusCode).toBe(500);
  const result = await current.app.inject({ method: "POST", url: "/api/v1/admin/tasks", headers: { cookie: current.cookie },
    payload: { type: "AUDIO_ANALYSIS", payload: {} } });
  expect(result.statusCode).toBe(202);
  const id = result.json().task.id;
  await vi.waitFor(async () => {
    const inventory = await current.app.inject({ url: "/api/v1/admin/tasks?includeTerminal=true", headers: { cookie: current.cookie } });
    expect(inventory.json().tasks.find((task: { id: string }) => task.id === id)?.state).toBe("FINISHED");
  });
  expect(await current.trace()).toContain("original-runner");
});

test("each scan retains warnings for enabled installations missing from disk", async () => {
  const current = await fixture(`export default () => ({});`);
  current.db.prepare("INSERT INTO server_extensions(extension_id, enabled, updated_at) VALUES (?, 1, ?)")
    .run("missing-extension", new Date().toISOString());
  for (let scan = 0; scan < 2; scan++) {
    expect((await current.call("POST", "/discover")).json().issues)
      .toEqual([expect.stringContaining("Enabled extension missing-extension is missing")]);
  }
});
