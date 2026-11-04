import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { DEFAULT_ACQUISITION_LIMITS } from "../src/domain/acquisition-limits.js";
import { SseConnectionLimiter } from "../src/utils/sse.js";

describe("acquisition event capacity", () => {
  test("reservations are bounded and release is idempotent", () => {
    const limiter = new SseConnectionLimiter(1, 2);
    const first = limiter.reserve("a")!;
    expect(limiter.reserve("a")).toBeNull();
    const second = limiter.reserve("b")!;
    expect(limiter.reserve("c")).toBeNull();
    first();
    first();
    expect(limiter.reserve("c")).not.toBeNull();
    expect(limiter.reserve("d")).toBeNull();
    second();
    expect(limiter.reserve("d")).not.toBeNull();
  });

  test("real sockets enforce caps before subscriptions, filter events, and release on disconnect and shutdown", async () => {
    const env = await createTestServer(createFakeBackend(), {
      acquisitionLimits: { ...DEFAULT_ACQUISITION_LIMITS, ssePerUser: 1, sseGlobal: 2 },
    });
    const requests: http.ClientRequest[] = [];
    const streams: Array<{ request: http.IncomingMessage; response: http.ServerResponse }> = [];
    env.app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/api/acquisitions/events") streams.push({ request: request.raw, response: reply.raw });
    });
    try {
      const a = await createUser(env.db, { username: "sse-a", password: "password-a" });
      const b = await createUser(env.db, { username: "sse-b", password: "password-b" });
      if (!a || !b) throw new Error("Missing SSE test users");
      const loginA = await login(env.app, "sse-a", "password-a");
      const loginB = await login(env.app, "sse-b", "password-b");
      const admin = await login(env.app);
      if (!loginA.cookie || !loginB.cookie || !admin.cookie) throw new Error("Missing test login cookie");
      await env.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (env.app.server.address() as AddressInfo).port;
      const originalSubscribe = env.acquisition.subscribe.bind(env.acquisition);
      const unsubscribed = vi.fn();
      const subscribe = vi.spyOn(env.acquisition, "subscribe").mockImplementation((listener) => {
        const stop = originalSubscribe(listener);
        return () => { stop(); unsubscribed(); };
      });
      const connect = async (cookie: string) => {
        const request = http.get({ host: "127.0.0.1", port, path: "/api/acquisitions/events", headers: { cookie }, agent: false });
        requests.push(request);
        const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
          request.once("response", resolve);
          request.once("error", reject);
        });
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        return { request, response, text: () => text };
      };
      const first = await connect(loginA.cookie);
      await vi.waitFor(() => expect(first.text()).toContain("event: connected"));
      const deniedUser = await connect(loginA.cookie);
      expect(deniedUser.response.statusCode).toBe(429);
      expect(deniedUser.response.headers["retry-after"]).toBe("30");
      expect(subscribe).toHaveBeenCalledTimes(1);
      const second = await connect(loginB.cookie);
      const deniedGlobal = await connect(admin.cookie);
      expect(deniedGlobal.response.statusCode).toBe(429);
      expect(subscribe).toHaveBeenCalledTimes(2);

      await env.acquisition.createJob(a.id, { candidate: { id: "event-a", provider: "missing" } });
      await env.acquisition.createJob(b.id, { candidate: { id: "event-b", provider: "missing" } });
      await vi.waitFor(() => {
        expect(first.text()).toContain(a.id);
        expect(second.text()).toContain(b.id);
      });
      expect(first.text()).not.toContain(b.id);
      expect(second.text()).not.toContain(a.id);
      first.request.destroy();
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
      const replacement = await connect(loginA.cookie);
      expect(replacement.response.statusCode).toBe(200);
      const secondServerStream = streams.find((stream) => stream.request.headers.cookie === loginB.cookie);
      if (!secondServerStream) throw new Error("Missing server-side SSE response");
      secondServerStream.response.emit("error", new Error("Fixture connection failure"));
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(2));
      const afterError = await connect(admin.cookie);
      expect(afterError.response.statusCode).toBe(200);
      const adminServerStream = streams.find((stream) => stream.request.headers.cookie === admin.cookie && !stream.response.writableEnded);
      if (!adminServerStream) throw new Error("Missing server-side administrator SSE request");
      adminServerStream.request.emit("aborted");
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(3));
      const afterAbort = await connect(admin.cookie);
      expect(afterAbort.response.statusCode).toBe(200);
      await env.app.close();
      await vi.waitFor(() => expect(replacement.response.destroyed).toBe(true));
      expect(unsubscribed).toHaveBeenCalledTimes(5);
    } finally {
      for (const request of requests) request.destroy();
      await closeTestServer(env.app, env.db);
    }
  });
});
