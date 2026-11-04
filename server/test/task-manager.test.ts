import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createUser } from "../src/users/users.js";
import { TaskManager, type TaskDefinition, type TaskType } from "../src/services/TaskManager.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(taskDefinitions?: Partial<Record<TaskType, TaskDefinition<unknown>>>) {
  const server = await createTestServer(
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    taskDefinitions ? { taskDefinitions } : {},
  );
  cleanups.push(() => closeTestServer(server.app, server.db));
  const manager = new TaskManager(server.db, {
    maxConcurrent: 1,
    maxAnalysisWorkers: 1,
    minFreeMemoryBytes: 0,
    maxCpuLoadPerCore: 100,
    monitorIntervalMs: 10_000,
  });
  cleanups.unshift(async () => manager.close());
  return { ...server, manager };
}

async function waitForTask(manager: TaskManager, id: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const task = manager.get(id);
    if (task?.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${id} did not reach ${state}: ${JSON.stringify(manager.get(id))}`);
}

describe("TaskManager", () => {
  test("retains bounded diagnostic tails, broadcasts priority changes, and clears only settled history", async () => {
    const { manager, db } = await setup();
    manager.register("LIBRARY_SCAN", {
      validate: (value): value is object => Boolean(value && typeof value === "object"),
      async run(_payload, context) {
        for (let i = 0; i < 220; i++) context.log?.(i % 2 ? "stderr" : "stdout", `line ${i} password=must-not-leak`);
        context.log?.("stderr", "x".repeat(3000));
      },
    });
    const finished = manager.enqueue("LIBRARY_SCAN", {}, "admin");
    await manager.waitForSettlement(finished.id);
    const logs = manager.diagnostics(finished.id);
    expect(logs).toHaveLength(200);
    expect(logs.some((entry) => entry.source === "stderr")).toBe(true);
    expect(logs.some((entry) => entry.source === "stdout")).toBe(true);
    expect(logs.some((entry) => entry.message.length === 2000)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("must-not-leak");
    const release = manager.acquireMediaStream();
    const queued = manager.enqueue("LIBRARY_SCAN", {}, "admin");
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event, task) => { events.push(`${event}:${task.priority}`); });
    manager.reprioritize(queued.id, 901);
    expect(events).toContain("task.state:901");
    const metrics = manager.metrics();
    expect(metrics).toMatchObject({ maxConcurrent: 1, activeStreams: 1 });
    expect(metrics.memoryBytes).toBeGreaterThan(0);
    expect(metrics.totalMemoryBytes).toBeGreaterThan(0);
    expect(manager.clearHistory()).toEqual([finished.id]);
    expect(manager.get(queued.id)?.state).toBe("QUEUED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM background_task_logs").get()).toEqual({ count: 0 });
    unsubscribe();
    await manager.cancel(queued.id);
    release();
  });

  test("streams ready/history, resource metrics and history clearing on the new SSE alias", async () => {
    const { app, db } = await setup({
      LIBRARY_SCAN: {
        validate: (value): value is object => Boolean(value && typeof value === "object"),
        async run(_payload, context) { context.log?.("stdout", "Index complete"); context.report({ percent: 100 }); },
      },
    });
    const { cookie } = await login(app);
    await createUser(db, { username: "activity-listener", password: "listener-password", role: "user" });
    const listener = await login(app, "activity-listener", "listener-password");
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/tasks", headers: { cookie }, payload: { type: "LIBRARY_SCAN" } });
    const id: string = created.json().task.id;
    for (let i = 0; i < 100; i++) {
      const result = await app.inject({ method: "GET", url: "/api/v1/admin/tasks?includeTerminal=true", headers: { cookie } });
      if (result.json().tasks.some((task: { id: string; state: string }) => task.id === id && task.state === "FINISHED")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const logs = await app.inject({ method: "GET", url: `/api/v1/admin/tasks/${id}/logs`, headers: { cookie } });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().entries.some((entry: { message: string }) => entry.message === "Index complete")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/tasks/unknown/logs", headers: { cookie } })).statusCode).toBe(404);
    for (const [method, url] of [["GET", "/api/v1/admin/tasks/stream"], ["GET", `/api/v1/admin/tasks/${id}/logs`], ["DELETE", "/api/v1/admin/tasks/history"]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: { cookie: listener.cookie } })).statusCode).toBe(403);
    }
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const request = http.get({ host: "127.0.0.1", port, path: "/api/v1/admin/tasks/stream", headers: { cookie } });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        request.once("response", resolve); request.once("error", reject);
      });
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      const waitFor = async (text: string) => {
        for (let i = 0; i < 200; i++) {
          if (body.includes(text)) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Missing ${text} in task stream`);
      };
      await waitFor("event: ready");
      expect(body).toContain(id);
      expect(body).toContain('"state":"FINISHED"');
      expect(body).not.toContain('"payload"');
      await waitFor("event: metrics");
      const cleared = await app.inject({ method: "DELETE", url: "/api/v1/admin/tasks/history", headers: { cookie } });
      expect(cleared.json().ids).toEqual([id]);
      await waitFor("event: history.cleared");
      expect((await app.inject({ method: "GET", url: `/api/v1/admin/tasks/${id}/logs`, headers: { cookie } })).statusCode).toBe(404);
    } finally { request.destroy(); }
  });

  test("executes by priority and records progress and completion", async () => {
    const { manager } = await setup();
    const order: string[] = [];
    let unblock!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const validate = (value: unknown): value is { name: string } =>
      Boolean(value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string");

    manager.register("LIBRARY_SCAN", {
      validate,
      async run(payload, context) {
        started();
        await gate;
        context.report({ percent: 45, itemsProcessed: 9, totalItems: 20 });
        await context.checkpoint();
        order.push(payload.name);
      },
    });
    manager.register("SPOTDL_DOWNLOAD", {
      validate,
      async run(payload, context) {
        context.report({ percent: 25, itemsProcessed: 1, totalItems: 4 });
        await context.checkpoint();
        order.push(payload.name);
      },
    });
    manager.register("AUDIO_ANALYSIS", {
      validate,
      async run(payload, context) {
        await context.checkpoint();
        order.push(payload.name);
      },
    });

    const first = manager.enqueue("LIBRARY_SCAN", { name: "running" }, "admin");
    await firstStarted;
    const analysis = manager.enqueue("AUDIO_ANALYSIS", { name: "analysis" }, "admin");
    const download = manager.enqueue("SPOTDL_DOWNLOAD", { name: "download" }, "admin");
    unblock();

    await waitForTask(manager, first.id, "FINISHED");
    await waitForTask(manager, download.id, "FINISHED");
    await waitForTask(manager, analysis.id, "FINISHED");
    expect(order).toEqual(["running", "download", "analysis"]);
    expect(manager.get(download.id)?.progress).toMatchObject({
      percent: 100,
      itemsProcessed: 1,
      totalItems: 4,
    });
  });

  test("pauses and resumes at a cooperative checkpoint, and cancellation aborts the worker", async () => {
    const { manager } = await setup();
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    manager.register("AUDIO_ANALYSIS", {
      validate: (value): value is Record<string, never> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      async run(_payload, context) {
        started();
        let processed = 0;
        while (processed < 30) {
          await context.checkpoint();
          context.throwIfCancelled();
          context.report({ itemsProcessed: ++processed });
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    });
    const task = manager.enqueue("AUDIO_ANALYSIS", {}, "admin");
    await began;
    manager.pause(task.id);
    await waitForTask(manager, task.id, "PAUSED");
    const pausedItems = manager.get(task.id)?.progress.itemsProcessed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.get(task.id)?.progress.itemsProcessed).toBe(pausedItems);
    manager.resume(task.id);
    await waitForTask(manager, task.id, "FINISHED");
    expect(manager.get(task.id)?.progress.itemsProcessed).toBeGreaterThan(pausedItems ?? 0);

    let cancelStarted!: () => void;
    const cancelBegan = new Promise<void>((resolve) => { cancelStarted = resolve; });
    manager.unregister("AUDIO_ANALYSIS");
    manager.register("AUDIO_ANALYSIS", {
      validate: (value): value is Record<string, never> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      async run(_payload, context) {
        cancelStarted();
        await new Promise<void>((resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const cancellable = manager.enqueue("AUDIO_ANALYSIS", {}, "admin");
    await cancelBegan;
    await manager.cancel(cancellable.id);
    await waitForTask(manager, cancellable.id, "CANCELLED");
  });

  test("active media streams yield audio analysis workers at their next checkpoint", async () => {
    const { manager } = await setup();
    let firstItem!: () => void;
    const firstDone = new Promise<void>((resolve) => { firstItem = resolve; });
    manager.register("AUDIO_ANALYSIS", {
      validate: (value): value is Record<string, never> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      async run(_payload, context) {
        await context.checkpoint();
        context.report({ itemsProcessed: 1 });
        firstItem();
        await new Promise((resolve) => setTimeout(resolve, 15));
        await context.checkpoint();
        context.report({ itemsProcessed: 2 });
      },
    });
    const task = manager.enqueue("AUDIO_ANALYSIS", {}, "admin");
    await firstDone;
    const releaseStream = manager.acquireMediaStream();
    await waitForTask(manager, task.id, "PAUSED");
    expect(manager.get(task.id)?.progress.itemsProcessed).toBe(1);
    releaseStream();
    await waitForTask(manager, task.id, "FINISHED");
    expect(manager.get(task.id)?.progress.itemsProcessed).toBe(2);
  });

  test("admin task routes omit internal payloads, reject non-admin access, and configure schedules", async () => {
    const routeRunner: TaskDefinition<unknown> = {
      validate: (value): value is unknown => Boolean(value && typeof value === "object"),
      async run(payload, context) {
        if ((payload as { hold?: boolean }).hold) {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
          return;
        }
        context.report({ percent: 100, itemsProcessed: 1, totalItems: 1 });
      },
    };
    const { app } = await setup({ LIBRARY_SCAN: routeRunner });
    const admin = await login(app);
    const requestTask = async (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) => app.inject({
      method,
      url,
      headers: { cookie: admin.cookie },
      ...(payload === undefined ? {} : { payload }),
    });
    const firstHold = await requestTask("POST", "/api/v1/admin/tasks", {
      type: "LIBRARY_SCAN", payload: { hold: true },
    });
    expect(firstHold.statusCode).toBe(202);
    const firstId = firstHold.json().task.id as string;
    const secondHold = await requestTask("POST", "/api/v1/admin/tasks", {
      type: "LIBRARY_SCAN", payload: { hold: true },
    });
    expect(secondHold.statusCode).toBe(202);
    const secondId = secondHold.json().task.id as string;
    for (let i = 0; i < 100; i++) {
      const current = await requestTask("GET", "/api/v1/admin/tasks?includeTerminal=true");
      const states = new Map(current.json().tasks.map((task: { id: string; state: string }) => [task.id, task.state]));
      if (states.get(firstId) === "PROCESSING" && states.get(secondId) === "PROCESSING") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const queuedControl = await requestTask("POST", "/api/v1/admin/tasks", {
      type: "LIBRARY_SCAN", payload: { hold: false },
    });
    const queuedId = queuedControl.json().task.id as string;
    const reprioritized = await requestTask("PATCH", `/api/v1/admin/tasks/${queuedId}/priority`, { priority: 900 });
    expect(reprioritized.statusCode).toBe(200);
    expect(reprioritized.json().task.priority).toBe(900);
    const paused = await requestTask("POST", `/api/v1/admin/tasks/${queuedId}/pause`);
    expect(paused.json().task.state).toBe("PAUSED");
    const resumed = await requestTask("POST", `/api/v1/admin/tasks/${queuedId}/resume`);
    expect(resumed.json().task.state).toBe("QUEUED");
    const cancelled = await requestTask("POST", `/api/v1/admin/tasks/${queuedId}/cancel`);
    expect(cancelled.json().task.state).toBe("CANCELLED");
    await requestTask("POST", `/api/v1/admin/tasks/${firstId}/cancel`);
    await requestTask("POST", `/api/v1/admin/tasks/${secondId}/cancel`);

    const queued = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tasks",
      headers: { cookie: admin.cookie },
      payload: { type: "LIBRARY_SCAN", payload: { label: "private-detail" } },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().task).not.toHaveProperty("payload");
    let listedResponse = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tasks?includeTerminal=true",
      headers: { cookie: admin.cookie },
    });
    for (let attempt = 0; attempt < 100 && listedResponse.json().tasks[0]?.state !== "FINISHED"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      listedResponse = await app.inject({
        method: "GET",
        url: "/api/v1/admin/tasks?includeTerminal=true",
        headers: { cookie: admin.cookie },
      });
    }
    expect(listedResponse.json().tasks[0]?.state).toBe("FINISHED");

    expect(listedResponse.statusCode).toBe(200);
    expect(listedResponse.json().tasks[0]).not.toHaveProperty("payload");

    const schedule = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/tasks/schedules",
      headers: { cookie: admin.cookie },
      payload: { type: "LIBRARY_SCAN", payload: { label: "scheduled" }, expression: "15 2 * * *" },
    });
    expect(schedule.statusCode).toBe(201);
    expect(schedule.json().schedule).toMatchObject({ type: "LIBRARY_SCAN", expression: "15 2 * * *", enabled: true });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/admin/tasks" });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
