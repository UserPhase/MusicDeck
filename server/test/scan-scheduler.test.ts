import { afterEach, describe, expect, test, vi } from "vitest";

import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { ScannerScheduler, validateScanSchedule } from "../src/services/scannerScheduler.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;
const schedulers: ScannerScheduler[] = [];

afterEach(async () => {
  schedulers.splice(0).forEach((scheduler) => scheduler.stop());
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function track(scheduler: ScannerScheduler) {
  schedulers.push(scheduler);
  return scheduler;
}

describe("validateScanSchedule", () => {
  test.each([
    ["0 3 * * *", "0 3 * * *"],
    ["30  4 * * 0", "30 4 * * 0"],
    ["15 2 * * 6", "15 2 * * 6"],
  ])("accepts 5-field cron %s", (input, expected) => {
    expect(validateScanSchedule(input)).toEqual({ ok: true, expression: expected });
  });

  test.each(["", "  ", "disabled", "Not scheduled", null, undefined])("treats %s as disabled", (input) => {
    expect(validateScanSchedule(input)).toEqual({ ok: true, expression: null });
  });

  test.each(["nightly", "0 0 3 * * *", "0 3 * *", "61 3 * * *", "0 25 * * *"])("rejects %s", (input) => {
    expect(validateScanSchedule(input).ok).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(validateScanSchedule(42).ok).toBe(false);
  });
});

describe("ScannerScheduler", () => {
  test("arms, reschedules and disables the cron job", async () => {
    current = await createTestServer();
    const scheduler = track(new ScannerScheduler(current.db, async () => ({ attempted: 1, failures: [] }), { logger: silentLogger, timezone: "UTC" }));

    const daily = scheduler.apply("0 3 * * *");
    expect(daily).toMatchObject({ enabled: true, valid: true, expression: "0 3 * * *", timezone: "UTC" });
    const next = new Date(daily.nextRunAt!);
    expect(next.getUTCHours()).toBe(3);
    expect(next.getUTCMinutes()).toBe(0);

    const weekly = scheduler.apply("30 4 * * 0");
    expect(weekly.expression).toBe("30 4 * * 0");
    expect(new Date(weekly.nextRunAt!).getUTCDay()).toBe(0);

    expect(scheduler.apply("")).toMatchObject({ enabled: false, valid: true, expression: null, nextRunAt: null });
  });

  test("keeps scans off and reports why when the stored value is invalid", async () => {
    current = await createTestServer();
    current.db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("library.scanSchedule", JSON.stringify("every night"), new Date().toISOString());
    const scheduler = track(new ScannerScheduler(current.db, async () => undefined, { logger: silentLogger }));

    const status = scheduler.start();
    expect(status).toMatchObject({ enabled: false, valid: false, stored: "every night", nextRunAt: null });
    expect(status.error).toMatch(/5-field/);
  });

  test("never runs two scans at once and records the outcome", async () => {
    current = await createTestServer();
    const gate = deferred();
    const scan = vi.fn(async () => {
      await gate.promise;
      return { attempted: 2, failures: [new Error("navidrome offline")] };
    });
    const scheduler = track(new ScannerScheduler(current.db, scan, { logger: silentLogger }));

    expect(scheduler.runNow("manual").started).toBe(true);
    expect(scheduler.runNow("scheduled").started).toBe(false);
    expect(scheduler.status()).toMatchObject({ running: true, currentRun: { trigger: "manual", status: "running" } });

    gate.resolve();
    await scheduler.waitForIdle();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toMatchObject({
      running: false,
      lastRun: { trigger: "manual", status: "partial", message: expect.stringContaining("navidrome offline") },
    });

    // The last run survives a restart.
    const reloaded = track(new ScannerScheduler(current.db, scan, { logger: silentLogger }));
    expect(reloaded.status().lastRun?.status).toBe("partial");
  });

  test("marks a scan failed when every server fails or the scan throws", async () => {
    current = await createTestServer();
    const allFailed = track(new ScannerScheduler(current.db, async () => ({ attempted: 1, failures: [new Error("boom")] }), { logger: silentLogger }));
    allFailed.runNow("manual");
    await allFailed.waitForIdle();
    expect(allFailed.status().lastRun).toMatchObject({ status: "failed", message: "boom" });

    const throwing = track(new ScannerScheduler(current.db, async () => { throw new Error("kaput"); }, { logger: silentLogger }));
    throwing.runNow("manual");
    await throwing.waitForIdle();
    expect(throwing.status().lastRun).toMatchObject({ status: "failed", message: "kaput" });
    expect(throwing.runNow("manual").started).toBe(true);
    await throwing.waitForIdle();
  });
});

describe("library scan routes", () => {
  test("PATCH validates and normalizes the schedule, then re-arms the job", async () => {
    current = await createTestServer();
    const { cookie } = await login(current.app);

    const invalid = await current.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/server",
      headers: { cookie },
      payload: { settings: { "library.scanSchedule": "0 0 3 * * *" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");

    const saved = await current.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/server",
      headers: { cookie },
      payload: { settings: { "library.scanSchedule": "0  3 * * 0", "jobs.maxConcurrency": 2 } },
    });
    expect(saved.statusCode).toBe(200);
    const row = saved.json().settings.find((entry: { key: string }) => entry.key === "library.scanSchedule");
    expect(JSON.parse(row.value)).toBe("0 3 * * 0");

    const status = await current.app.inject({ method: "GET", url: "/api/admin/library/scan/status", headers: { cookie } });
    expect(status.json()).toMatchObject({ enabled: true, expression: "0 3 * * 0" });
    expect(new Date(status.json().nextRunAt).getDay()).toBe(0);

    await current.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/server",
      headers: { cookie },
      payload: { settings: { "library.scanSchedule": "disabled" } },
    });
    const disabled = await current.app.inject({ method: "GET", url: "/api/admin/library/scan/status", headers: { cookie } });
    expect(disabled.json()).toMatchObject({ enabled: false, expression: null, stored: "", nextRunAt: null });
  });

  test("POST starts a background scan and reports overlap", async () => {
    const gate = deferred();
    const scanLibrary = vi.fn(async () => { await gate.promise; return { scanning: false }; });
    current = await createTestServer(createFakeBackend({ scanLibrary }));
    const { cookie } = await login(current.app);

    const first = await current.app.inject({ method: "POST", url: "/api/admin/library/scan", headers: { cookie } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ started: true, alreadyRunning: false, status: { running: true } });

    const second = await current.app.inject({ method: "POST", url: "/api/admin/library/scan", headers: { cookie } });
    expect(second.json()).toMatchObject({ started: false, alreadyRunning: true });

    gate.resolve();
    await vi.waitFor(async () => {
      const status = await current!.app.inject({ method: "GET", url: "/api/admin/library/scan/status", headers: { cookie } });
      expect(status.json()).toMatchObject({ running: false, lastRun: { trigger: "manual", status: "succeeded" } });
    });
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  test("scan endpoints require an administrator", async () => {
    current = await createTestServer();
    await createUser(current.db, { username: "listener", password: "listener-password", role: "user" });
    const { cookie } = await login(current.app, "listener", "listener-password");

    for (const request of [
      { method: "POST" as const, url: "/api/admin/library/scan" },
      { method: "GET" as const, url: "/api/admin/library/scan/status" },
    ]) {
      expect((await current.app.inject({ ...request })).statusCode).toBe(401);
      expect((await current.app.inject({ ...request, headers: { cookie } })).statusCode).toBe(403);
    }
  });
});
