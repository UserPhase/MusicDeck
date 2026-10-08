import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import {
  LogBuffer,
  createLogCaptureStream,
  formatConsoleArgs,
  parsePinoLine,
  redactText,
  registerLogSecret,
  serverLogs,
} from "../src/utils/logger.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

afterEach(async () => {
  serverLogs.clear();
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("LogBuffer", () => {
  test("keeps only the newest entries when the count cap is reached", () => {
    const buffer = new LogBuffer(3);
    for (let i = 1; i <= 5; i += 1) buffer.push({ level: "info", source: "server", message: `m${i}` });
    expect(buffer.list().map((entry) => entry.message)).toEqual(["m3", "m4", "m5"]);
    expect(buffer.stats()).toMatchObject({ size: 3, capacity: 3, lastSeq: 5 });
  });

  test("evicts old entries to stay under the byte cap", () => {
    const buffer = new LogBuffer(1_000, 2_000);
    for (let i = 0; i < 20; i += 1) buffer.push({ level: "info", source: "server", message: "x".repeat(300) });
    const stats = buffer.stats();
    expect(stats.bytes).toBeLessThanOrEqual(2_000);
    expect(stats.size).toBeLessThan(20);
    expect(stats.size).toBeGreaterThan(0);
  });

  test("truncates oversized messages", () => {
    const buffer = new LogBuffer();
    const entry = buffer.push({ level: "error", source: "server", message: "y".repeat(20_000) });
    expect(entry.message.length).toBeLessThan(9_000);
    expect(entry.message).toContain("[truncated");
  });

  test("filters by level, after and limit (newest kept)", () => {
    const buffer = new LogBuffer();
    buffer.push({ level: "info", source: "server", message: "a" });
    buffer.push({ level: "error", source: "server", message: "b" });
    buffer.push({ level: "error", source: "server", message: "c" });
    buffer.push({ level: "warn", source: "server", message: "d" });
    expect(buffer.list({ level: "error" }).map((e) => e.message)).toEqual(["b", "c"]);
    expect(buffer.list({ limit: 2 }).map((e) => e.message)).toEqual(["c", "d"]);
    expect(buffer.list({ after: 2 }).map((e) => e.message)).toEqual(["c", "d"]);
  });

  test("subscribe delivers entries and clear events, and unsubscribes cleanly", () => {
    const buffer = new LogBuffer();
    const seen: string[] = [];
    let cleared = 0;
    const unsubscribe = buffer.subscribe((entry) => seen.push(entry.message), () => { cleared += 1; });
    buffer.push({ level: "info", source: "server", message: "one" });
    buffer.clear();
    unsubscribe();
    buffer.push({ level: "info", source: "server", message: "two" });
    expect(seen).toEqual(["one"]);
    expect(cleared).toBe(1);
    expect(buffer.emitter.listenerCount("entry")).toBe(0);
    expect(buffer.emitter.listenerCount("clear")).toBe(0);
  });
});

describe("redaction", () => {
  test("masks tokens, cookies, subsonic auth and credential fields", () => {
    const output = redactText([
      "Authorization: Bearer abc.def.ghijkl",
      "cookie: musicdeck_session=s3cr3tvalue; other=1",
      "GET /rest/ping?u=admin&t=deadbeef&s=salty&p=enc:abc",
      '{"password":"hunter22","clientSecret":"xyz123"}',
      "API_KEY=supersecret token=abc",
    ].join("\n"));
    expect(output).not.toMatch(/abc\.def|s3cr3tvalue|deadbeef|salty|enc:abc|hunter22|xyz123|supersecret/);
    expect(output).toContain("u=admin");
  });

  test("masks registered literal secrets anywhere in text", () => {
    registerLogSecret("my-navidrome-pass-42");
    expect(redactText("connect failed for my-navidrome-pass-42 at host")).toBe("connect failed for [REDACTED] at host");
  });

  test("masks sensitive keys inside meta objects and strips ANSI", () => {
    const buffer = new LogBuffer();
    const entry = buffer.push({
      level: "info",
      source: "server",
      message: "\u001b[31mred\u001b[0m",
      meta: { req: { headers: { cookie: "a=b", authorization: "x", host: "localhost" } }, apiKey: "k" },
    });
    expect(entry.message).toBe("red");
    expect(entry.meta).toEqual({ req: { headers: { cookie: "[REDACTED]", authorization: "[REDACTED]", host: "localhost" } }, apiKey: "[REDACTED]" });
  });
});

describe("log capture", () => {
  test("parses pino request and error lines", () => {
    const request = parsePinoLine(JSON.stringify({ level: 30, time: 1_700_000_000_000, msg: "request completed", req: { method: "GET", url: "/api/health" }, res: { statusCode: 200 }, responseTime: 4.2, reqId: "req-1" }));
    expect(request).toMatchObject({ level: "info", source: "server" });
    expect(request?.message).toContain("GET /api/health");
    expect(request?.message).toContain("200");

    const failure = parsePinoLine(JSON.stringify({ level: 50, msg: "boom", err: { type: "Error", message: "boom", stack: "Error: boom\n    at x" } }));
    expect(failure).toMatchObject({ level: "error", message: "boom" });
    expect(failure?.stack).toContain("at x");

    expect(parsePinoLine(JSON.stringify({ level: 40, msg: "careful" }))?.level).toBe("warn");
    expect(parsePinoLine("plain text line")).toMatchObject({ level: "info", message: "plain text line" });
  });

  test("the capture stream forwards output and records each line", () => {
    const buffer = new LogBuffer();
    const written: string[] = [];
    const stream = createLogCaptureStream(buffer, { write: (chunk: string) => { written.push(chunk); return true; } } as any);
    stream.write(`${JSON.stringify({ level: 30, msg: "one" })}\n${JSON.stringify({ level: 50, msg: "two" })}\n`);
    expect(written).toHaveLength(1);
    expect(buffer.list().map((e) => [e.level, e.message])).toEqual([["info", "one"], ["error", "two"]]);
  });

  test("formats console arguments and keeps the first error stack", () => {
    const error = new Error("disk full");
    const formatted = formatConsoleArgs(["Import failed", error, { id: 3 }]);
    expect(formatted.message).toContain("Import failed");
    expect(formatted.message).toContain("Error: disk full");
    expect(formatted.stack).toContain("disk full");
  });
});

describe("admin log routes", () => {
  test("require an authenticated admin", async () => {
    current = await createTestServer();
    const { app, db } = current;
    await createUser(db, { username: "listener", password: "listener-password", role: "user" });
    const listener = await login(app, "listener", "listener-password");

    for (const [method, url] of [["GET", "/api/admin/logs"], ["DELETE", "/api/admin/logs"], ["GET", "/api/admin/logs/stream"]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: { cookie: listener.cookie } })).statusCode).toBe(403);
    }
  });

  test("list, filter, validate and clear the buffer", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);
    serverLogs.clear();
    serverLogs.push({ level: "info", source: "server", message: "hello" });
    serverLogs.push({ level: "error", source: "server", message: "broken" });

    const all = await app.inject({ method: "GET", url: "/api/admin/logs", headers: { cookie } });
    expect(all.statusCode).toBe(200);
    expect(all.json().entries.map((e: { message: string }) => e.message)).toEqual(["hello", "broken"]);
    expect(all.json().stats.size).toBe(2);

    const errors = await app.inject({ method: "GET", url: "/api/admin/logs?level=error&limit=10", headers: { cookie } });
    expect(errors.json().entries.map((e: { message: string }) => e.message)).toEqual(["broken"]);

    expect((await app.inject({ method: "GET", url: "/api/admin/logs?level=fatal", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/admin/logs?limit=5000", headers: { cookie } })).statusCode).toBe(400);

    const cleared = await app.inject({ method: "DELETE", url: "/api/admin/logs", headers: { cookie } });
    expect(cleared.statusCode).toBe(204);
    expect(serverLogs.list()).toEqual([]);
  });

  test("streams backlog and live entries over SSE and unsubscribes on disconnect", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);
    serverLogs.clear();
    const first = serverLogs.push({ level: "info", source: "server", message: "before-connect" });
    serverLogs.push({ level: "warn", source: "server", message: "missed-while-away" });
    const baseline = serverLogs.emitter.listenerCount("entry");

    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    let body = "";
    const request = http.get({ host: "127.0.0.1", port, path: `/api/admin/logs/stream?after=${first.seq}`, headers: { cookie } });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.on("response", resolve);
      request.on("error", reject);
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { body += chunk; });

    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out; received:\n${body}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    await waitFor(() => body.includes("missed-while-away"));
    expect(body).toContain("event: ready");
    expect(body).not.toContain("before-connect");
    expect(serverLogs.emitter.listenerCount("entry")).toBe(baseline + 1);

    serverLogs.push({ level: "error", source: "server", message: "live-entry" });
    await waitFor(() => body.includes("live-entry"));
    expect(body).toMatch(/id: \d+\nevent: logs/);

    serverLogs.clear();
    await waitFor(() => body.includes("event: cleared"));

    request.destroy();
    await waitFor(() => serverLogs.emitter.listenerCount("entry") === baseline);
  });
});
