import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

let current: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;
let otherCookie: string;
let trackId: string;
beforeAll(async () => {
  const defaults = createFakeBackend();
  const originalTrack = await defaults.getTrack("track-1");
  if (!originalTrack) throw new Error("Missing test track");
  const bytes = Buffer.alloc(42); bytes.write("fLaC"); bytes.writeUIntBE(34, 5, 3);
  bytes.writeBigUInt64BE((96000n << 44n) | (1n << 41n) | (23n << 36n), 18);
  current = await createTestServer(createFakeBackend({
    getTrack: async () => ({ ...originalTrack, audioMetadata: { codec: "flac", bitrateKbps: 1000, container: "flac", sampleRateHz: null, bitDepth: null, channels: null } }),
    fetchStream: vi.fn(async () => ({
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      status: 200, headers: new Headers({ "content-type": "audio/flac" }), audioStream: { direct: true, requestedBitrateKbps: null },
    })),
  }));
  cookie = (await login(current.app)).cookie!;
  await createUser(current.db, { username: "quality-listener", password: "listener-password" });
  otherCookie = (await login(current.app, "quality-listener", "listener-password")).cookie!;
  const library = await current.app.inject({ method: "GET", url: "/api/tracks", headers: { cookie } });
  trackId = library.json().tracks[0].id;
});
afterAll(async () => { await closeTestServer(current.app, current.db); });
test("requires authentication, a bounded safe token and a known library track", async () => {
  expect((await current.app.inject({ url: `/api/v1/stream/inspect/${trackId}?inspectionId=id` })).statusCode).toBe(401);
  for (const query of ["", "?inspectionId=bad%20token", `?inspectionId=${"a".repeat(101)}`, "?inspectionId=id&userId=other"]) {
    expect((await current.app.inject({ url: `/api/v1/stream/inspect/${trackId}${query}`, headers: { cookie } })).statusCode).toBe(400);
  }
  expect((await current.app.inject({ url: "/api/v1/stream/inspect/missing?inspectionId=id", headers: { cookie } })).statusCode).toBe(404);
});
test("observes actual stream bytes and returns private sanitized account-scoped diagnostics", async () => {
  const response = await current.app.inject({ url: `/api/tracks/${trackId}/stream?inspectionId=pipe`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload.length).toBe(42);
  const inspection = await current.app.inject({ url: `/api/v1/stream/inspect/${trackId}?inspectionId=pipe`, headers: { cookie } });
  expect(inspection.statusCode).toBe(200);
  expect(inspection.headers["cache-control"]).toBe("private, no-store");
  expect(inspection.json()).toMatchObject({ source: { codec: "FLAC" }, output: { mode: "DIRECT_STREAM", bitDepth: 24, sampleRateHz: 96000 }, delivery: { bytes: 42 } });
  expect(inspection.body).not.toMatch(/sourceConnectionId|password|streamUrl|sourceUrl/);
  const isolated = await current.app.inject({ url: `/api/v1/stream/inspect/${trackId}?inspectionId=pipe`, headers: { cookie: otherCookie } });
  expect(isolated.json()).toMatchObject({ output: { mode: "UNKNOWN" }, delivery: { bytes: 0, state: "waiting" } });
});
