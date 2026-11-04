import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser, updateUser } from "../src/users/users.js";
import { deleteSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { STREAM_AUTH_CHECK_MS } from "../src/auth/session-stream.js";
import { serverLogs } from "../src/utils/logger.js";
import { DEFAULT_ACQUISITION_LIMITS } from "../src/domain/acquisition-limits.js";

describe("live SSE authorization", () => {
  test.each(["logout", "reset", "disable", "demote", "expire", "direct-demote"] as const)(
    "%s terminates log and acquisition streams and releases their resources", async (operation) => {
      const env = await createTestServer(undefined, {
        acquisitionLimits: { ...DEFAULT_ACQUISITION_LIMITS, sseGlobal: 1, ssePerUser: 1 },
      });
      const requests: http.ClientRequest[] = [];
      try {
        const target = await createUser(env.db, { username: "stream-admin", password: "stream-password", role: "admin" });
        if (!target) throw new Error("Missing fixture user");
        const auth = await login(env.app, "stream-admin", "stream-password");
        const master = await login(env.app);
        if (!auth.cookie || !master.cookie) throw new Error("Missing fixture cookies");
        const cookie = auth.cookie;
        const sessionId = cookie.split(";")[0].slice(`${SESSION_COOKIE}=`.length);
        await env.app.listen({ host: "127.0.0.1", port: 0 });
        const port = (env.app.server.address() as AddressInfo).port;
        const connect = async (path: string, loginCookie = cookie) => {
          const request = http.get({ host: "127.0.0.1", port, path, headers: { cookie: loginCookie }, agent: false });
          requests.push(request);
          const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
            request.once("response", resolve);
            request.once("error", reject);
          });
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { text += chunk; });
          return { response, text: () => text };
        };
        const baseline = serverLogs.emitter.listenerCount("entry");
        const originalSubscribe = env.acquisition.subscribe.bind(env.acquisition);
        const unsubscribed = vi.fn();
        vi.spyOn(env.acquisition, "subscribe").mockImplementation((listener) => {
          const unsubscribe = originalSubscribe(listener);
          return () => { unsubscribe(); unsubscribed(); };
        });
        const logs = await connect("/api/admin/logs/stream");
        const acquisitions = await connect("/api/acquisitions/events");
        await vi.waitFor(() => {
          expect(logs.text()).toContain("event: ready");
          expect(acquisitions.text()).toContain("event: connected");
        });
        serverLogs.push({ level: "info", source: "server", message: "authorized-before" });
        await vi.waitFor(() => expect(logs.text()).toContain("authorized-before"));
        expect(serverLogs.emitter.listenerCount("entry")).toBe(baseline + 1);
        const applyChange = async () => {
          switch (operation) {
            case "logout": deleteSession(env.db, sessionId); break;
            case "reset": await updateUser(env.db, target.id, { password: "reset-password" }); break;
            case "disable": await updateUser(env.db, target.id, { disabled: true }); break;
            case "demote": await updateUser(env.db, target.id, { role: "user" }); break;
            case "expire": env.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", sessionId); break;
            case "direct-demote": env.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(target.id); break;
          }
        };
        if (operation === "expire") {
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
          // New guards capture the fake interval so idle-expiry verification needs no real wait.
          requests.forEach((request) => request.destroy());
          vi.useRealTimers();
          await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
          const idleLogs = await connect("/api/admin/logs/stream");
          const idleAcquisitions = await connect("/api/acquisitions/events");
          await applyChange();
          await vi.advanceTimersByTimeAsync(STREAM_AUTH_CHECK_MS);
          vi.useRealTimers();
          await vi.waitFor(() => {
            expect(idleLogs.response.readableEnded).toBe(true);
            expect(idleAcquisitions.response.readableEnded).toBe(true);
          });
        } else {
          await applyChange();
          serverLogs.push({ level: "warn", source: "server", message: "must-not-reach-revoked-stream" });
          await env.acquisition.createJob(master.response.json().user.id, { candidate: { id: "other-user-event", provider: "missing" } });
          await vi.waitFor(() => {
            expect(logs.response.readableEnded).toBe(true);
            expect(acquisitions.response.readableEnded).toBe(true);
          });
          expect(logs.text()).not.toContain("must-not-reach-revoked-stream");
          expect(acquisitions.text()).not.toContain("other-user-event");
        }
        expect(serverLogs.emitter.listenerCount("entry")).toBe(baseline);
        expect(unsubscribed).toHaveBeenCalledTimes(operation === "expire" ? 2 : 1);
        const replacement = await connect("/api/acquisitions/events", master.cookie);
        expect(replacement.response.statusCode).toBe(200);
        const newLogs = await connect("/api/admin/logs/stream", master.cookie);
        expect(newLogs.response.statusCode).toBe(200);
      } finally {
        vi.useRealTimers();
        for (const request of requests) request.destroy();
        await closeTestServer(env.app, env.db);
        serverLogs.clear();
      }
    },
  );
});
