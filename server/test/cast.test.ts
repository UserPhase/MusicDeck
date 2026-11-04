import fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createTestServer, createFakeBackend, closeTestServer, login } from "./helpers.js";
import { deleteSession, SESSION_COOKIE } from "../src/auth/sessions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture() {
  const backend = createFakeBackend();
  const original = backend.getTrack;
  backend.getTrack = vi.fn(async (id) => {
    const track = await original(id);
    return track ? { ...track, audioMetadata: { codec: "FLAC", container: "FLAC", bitrateKbps: 1000,
      sampleRateHz: 44100, bitDepth: 16, channels: 2 } } : null;
  });
  const server = await createTestServer(backend, { publicUrl: "https://music.example.test" });
  cleanups.push(async () => { await closeTestServer(server.app, server.db); await fs.rm(server.directory, { recursive: true, force: true }); });
  const cookie = (await login(server.app)).cookie!;
  const track = (await server.catalog.listTracks()).items[0];
  if (!track) throw new Error("Expected a mapped library track in Cast fixture");
  return { ...server, cookie, track };
}

test("Cast issues track-only capabilities using the configured public origin, never session/provider credentials", async () => {
  const { app, cookie, track } = await fixture();
  const anonymous = await app.inject({ method: "POST", url: "/api/v1/cast/ticket", payload: { trackId: track.id } });
  expect(anonymous.statusCode).toBe(401);
  const issued = await app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie, host: "attacker.test" },
    payload: { trackId: track.id, maxBitRate: 256 } });
  expect(issued.statusCode).toBe(200);
  const ticket = issued.json();
  expect(ticket.contentType).toBe("audio/mpeg");
  expect(ticket.token).toMatch(/^[a-f0-9]{64}$/);
  expect(ticket.url).toBe(`https://music.example.test/api/v1/cast/stream?token=${ticket.token}`);
  expect(ticket.url).not.toContain("session");
  expect(issued.headers["cache-control"]).toContain("no-store");
  expect((await app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie },
    payload: { trackId: track.id, url: "https://attacker.test" } })).statusCode).toBe(400);
});

test("receiver streams require no cookies, support ranges/CORS and cannot select a different track or source", async () => {
  const current = await fixture();
  const issued = await current.app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie },
    payload: { trackId: current.track.id, maxBitRate: 256 } });
  const token = issued.json().token;
  const path = `/api/v1/cast/stream?token=${token}`;
  const response = await current.app.inject({ url: path, headers: { range: "bytes=0-2", origin: "https://receiver.example.test" } });
  expect(response.statusCode).toBe(206);
  expect([...response.rawPayload]).toEqual([1, 2, 3]);
  expect(response.headers["content-range"]).toBe("bytes 0-2/3");
  expect(response.headers["access-control-allow-origin"]).toBe("*");
  expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  expect(current.backend.fetchStream).toHaveBeenCalledWith("track-1", "bytes=0-2", 256);
  expect((await current.app.inject({ url: `${path}&trackId=other` })).statusCode).toBe(401);
  expect((await current.app.inject({ url: "/api/v1/cast/stream" })).statusCode).toBe(401);
  const preflight = await current.app.inject({ method: "OPTIONS", url: path, headers: {
    origin: "https://receiver.example.test", "access-control-request-method": "GET", "access-control-request-headers": "range",
  } });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-headers"]).toBe("Range");
});

test("revocation is session-owned and logout invalidates receiver range requests", async () => {
  const current = await fixture();
  const issue = await current.app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie },
    payload: { trackId: current.track.id } });
  const token = issue.json().token;
  const other = (await login(current.app)).cookie!;
  expect((await current.app.inject({ method: "DELETE", url: "/api/v1/cast/ticket", headers: { cookie: other }, payload: { token } })).statusCode).toBe(403);
  expect((await current.app.inject({ method: "DELETE", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie }, payload: { token } })).statusCode).toBe(204);
  expect((await current.app.inject({ url: `/api/v1/cast/stream?token=${token}` })).statusCode).toBe(401);
  const next = await current.app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie },
    payload: { trackId: current.track.id } });
  const session = current.app.parseCookie(current.cookie)[SESSION_COOKIE];
  deleteSession(current.db, session);
  expect((await current.app.inject({ url: new URL(next.json().url).pathname + new URL(next.json().url).search })).statusCode).toBe(401);
});

test("Local-Only blocks Cast issuance and receiver requests; leases expire and active tickets are bounded", async () => {
  const current = await fixture();
  const issue = () => current.app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie },
    payload: { trackId: current.track.id } });
  let token = "";
  for (let count = 0; count < 8; count++) {
    const result = await issue(); expect(result.statusCode).toBe(200); token = result.json().token;
  }
  expect((await issue()).statusCode).toBe(429);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
  expect((await current.app.inject({ url: `/api/v1/cast/stream?token=${token}` })).statusCode).toBe(401);
  vi.useRealTimers();
  const fresh = await issue();
  expect(fresh.statusCode).toBe(200);
  await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: current.cookie },
    payload: { localOnly: true, allowMetadata: true, allowImports: true, allowArtwork: true } });
  expect((await issue()).statusCode).toBe(403);
  expect((await current.app.inject({ url: `/api/v1/cast/stream?token=${fresh.json().token}` })).statusCode).toBe(403);
  expect(current.backend.fetchStream).not.toHaveBeenCalled();
  await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: current.cookie },
    payload: { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true } });
  expect((await current.app.inject({ url: `/api/v1/cast/stream?token=${fresh.json().token}` })).statusCode).toBe(401);
});

test("Cast MIME comes from server source metadata, and unknown direct formats require an explicit quality choice", async () => {
  const current = await fixture();
  const request = (maxBitRate?: number) => current.app.inject({
    method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie }, payload: { trackId: current.track.id, maxBitRate },
  });

  const direct = await request();
  expect(direct.statusCode).toBe(200);
  expect(direct.json().contentType).toBe("audio/flac");
  vi.spyOn(current.sourceResolver, "audioMetadata").mockResolvedValue(null);
  const unknown = await request();
  expect(unknown.statusCode).toBe(422);
  expect(unknown.json()).toMatchObject({ error: { code: "CAST_FORMAT_UNKNOWN" } });
  const compatible = await request(320);
  expect(compatible.statusCode).toBe(200);
  expect(compatible.json().contentType).toBe("audio/mpeg");
});

test("revoking a live receiver capability closes the HTTP stream and cancels the upstream reader", async () => {
  const current = await fixture();
  const cancelled = vi.fn();
  vi.mocked(current.backend.fetchStream).mockImplementation(async () => ({
    status: 200, headers: new Headers({ "content-type": "audio/flac" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel: cancelled,
    }),
  }));
  const issued = await current.app.inject({ method: "POST", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie },
    payload: { trackId: current.track.id } });
  const token = issued.json().token;
  await current.app.listen({ host: "127.0.0.1", port: 0 });
  const address = current.app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test listener");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/cast/stream?token=${token}`);
  if (!response.body) throw new Error("Expected receiver response body");
  const reader = response.body.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  await current.app.inject({ method: "DELETE", url: "/api/v1/cast/ticket", headers: { cookie: current.cookie }, payload: { token } });
  await expect(reader.read()).rejects.toThrow();
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  reader.releaseLock();
});
