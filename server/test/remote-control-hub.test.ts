import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

const origin = "http://localhost:4534";
const state = { current_track: { id: "track-1", title: "Long set" }, position_ms: 102345.678, duration_ms: 600000, playing: true, volume: .7 };
const empty = { ...state, current_track: null, playing: false, position_ms: 0 };
const snapshot = {
  trackId: "track-1", exactPositionMs: 102345.678, playing: true, volume: .7,
  queueState: {
    entries: ["a", "b", "c"].map((occurrenceId) => ({ occurrenceId, trackId: "track-1", title: "Long set",
      artist: "DJ", album: "Live", duration: 600 })),
    index: 1, repeatOne: false, shuffle: true, shuffleMode: "smart", shuffleSeed: 42, albumAware: true,
    context: { type: "playlist", id: "mix", name: "Mix", coverArt: null },
  },
};
type Message = Record<string, unknown>;
let current: Awaited<ReturnType<typeof createTestServer>>;
let url: string;
let cookie: string;
let otherCookie: string;
const sockets: WebSocket[] = [];
class Peer {
  readonly messages: Message[] = [];
  constructor(readonly socket: WebSocket) {
    sockets.push(socket);
    socket.on("message", (raw) => { this.messages.push(JSON.parse(raw.toString()) as Message); });
  }
  send(message: object) { this.socket.send(JSON.stringify(message)); }
  async take(type: string, predicate: (message: Message) => boolean = () => true): Promise<Message> {
    let index = -1;
    await vi.waitFor(() => {
      index = this.messages.findIndex((message) => message.type === type && predicate(message));
      expect(index, `Expected ${type}; received ${JSON.stringify(this.messages)}`).toBeGreaterThanOrEqual(0);
    }, { timeout: 2500, interval: 5 });
    return this.messages.splice(index, 1)[0];
  }
}
async function connect(deviceId: string, options: { cookie?: string; playing?: boolean; ready?: boolean } = {}) {
  const ws = new WebSocket(url, { origin, headers: { Cookie: options.cookie || cookie } });
  const peer = new Peer(ws);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  peer.send({ type: "REGISTER", device_id: deviceId, device_name: deviceId, device_type: "computer", can_receive: options.ready ?? true,
    state: options.playing ? state : empty });
  await peer.take("DEVICES", (message) => JSON.stringify(message.devices).includes(deviceId));
  return peer;
}
async function pair() {
  const source = await connect("source", { playing: true });
  const target = await connect("target");
  return { source, target };
}
async function prepare(source: Peer, target: Peer) {
  target.send({ type: "TRANSFER_PLAYBACK", requestId: "handoff", targetId: "target" });
  const request = await source.take("REQUEST_SNAPSHOT");
  source.send({ type: "SNAPSHOT", transferId: request.transferId, snapshot });
  expect(await target.take("INITIALIZE_PLAYER")).toMatchObject({ snapshot });
  return request.transferId;
}
beforeAll(async () => {
  current = await createTestServer(undefined, { publicUrl: origin, corsOrigin: origin });
  cookie = (await login(current.app)).cookie!;
  await createUser(current.db, { username: "other-remote", password: "other-password" });
  otherCookie = (await login(current.app, "other-remote", "other-password")).cookie!;
  await current.app.listen({ host: "127.0.0.1", port: 0 });
  const address = current.app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  url = `ws://127.0.0.1:${address.port}/api/v1/remote`;
});
afterEach(async () => {
  const closing = sockets.splice(0).map((ws) => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once("close", () => resolve()); ws.terminate();
  }));
  await Promise.all(closing);
  // Wait for server-side close cleanup before another test registers the same ID.
  await new Promise((resolve) => setTimeout(resolve, 20));
});
afterAll(async () => { await closeTestServer(current.app, current.db); });

test("requires an authenticated cookie and configured Origin before upgrading", async () => {
  for (const headers of [{ Origin: "https://hostile.test", Cookie: cookie }, { Origin: origin }, { Cookie: cookie }]) {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode || 0); });
      ws.on("error", () => {});
      ws.on("open", () => reject(new Error("Unauthorized upgrade accepted")));
    });
    expect(code).toBe(headers.Origin === origin ? 401 : 403);
  }
  expect((await current.app.inject({ url: "/api/v1/remote", headers: { cookie } })).statusCode).toBe(426);
});
test("isolates device registries and commands by user, and cleans up a disconnected player", async () => {
  const { source, target } = await pair();
  const stranger = await connect("stranger", { cookie: otherCookie, playing: true });
  stranger.send({ type: "STATE", state, claim: false });
  expect(JSON.stringify(await stranger.take("DEVICES"))).not.toContain('"source"');
  stranger.send({ type: "COMMAND", requestId: "denied", targetId: "source", command: { type: "PAUSE" } });
  expect(await stranger.take("ERROR")).toMatchObject({ requestId: "denied", message: "No active player is connected" });
  source.socket.close();
  expect(await target.take("DEVICES", (message) => !JSON.stringify(message.devices).includes('"source"'))).toMatchObject({
    devices: [expect.objectContaining({ device_id: "target", is_active_player: false })],
  });
});
test("routes only target-bound acknowledgements, rejects invalid commands, and handles 50 fractional seeks", async () => {
  const { source, target } = await pair();
  for (let index = 0; index < 50; index++) target.send({ type: "COMMAND", requestId: `seek-${index}`, command: { type: "SEEK", position_ms: 100000 + index + .125 } });
  for (let index = 0; index < 50; index++) {
    const execute = await source.take("EXECUTE");
    expect(execute.command).toEqual({ type: "SEEK", position_ms: 100000 + index + .125 });
    if (index === 0) {
      target.send({ type: "COMMAND_RESULT", requestId: execute.requestId, ok: true });
      expect(await target.take("ERROR")).toMatchObject({ message: "Unknown command acknowledgement" });
    }
    source.send({ type: "COMMAND_RESULT", requestId: execute.requestId, ok: true });
    expect(await target.take("COMMAND_RESULT")).toMatchObject({ requestId: `seek-${index}`, ok: true });
  }
  target.send({ type: "COMMAND", requestId: "negative", command: { type: "SEEK", position_ms: -1 } });
  expect(await target.take("ERROR")).toMatchObject({ message: "Invalid remote message" });
});
test("prepares without pausing source, commits a fresh fractional position and preserves repeated occurrences", async () => {
  const { source, target } = await pair();
  const transferId = await prepare(source, target);
  expect(source.messages.some((message) => message.type === "PAUSE_FOR_TRANSFER")).toBe(false);
  target.send({ type: "READY", transferId });
  expect(await source.take("PAUSE_FOR_TRANSFER")).toMatchObject({ transferId });
  const fresh = { ...snapshot, exactPositionMs: 104987.654 };
  source.send({ type: "SOURCE_PAUSED", transferId, snapshot: fresh });
  expect(await target.take("START_TRANSFER")).toMatchObject({ snapshot: fresh });
  expect(target.messages.some((message) => message.type === "TRANSFER_RESULT")).toBe(false);
  target.send({ type: "STARTED", transferId });
  expect(await target.take("TRANSFER_RESULT")).toMatchObject({ requestId: "handoff", ok: true });
  expect(await target.take("DEVICES", (message) => JSON.stringify(message.devices).includes('"device_id":"target","device_name":"target","device_type":"computer","is_active_player":true')))
    .toMatchObject({ devices: expect.arrayContaining([expect.objectContaining({ device_id: "target", is_active_player: true,
      playing: true, position_ms: 104987.654, current_track: state.current_track })]) });
  target.send({ type: "STARTED", transferId });
  expect(await target.take("ERROR")).toMatchObject({ message: "Stale playback transfer" });
});
test("failed preparation leaves source untouched; concurrent transfers cannot replace the active handshake", async () => {
  const { source, target } = await pair();
  const transferId = await prepare(source, target);
  target.send({ type: "TRANSFER_PLAYBACK", requestId: "competing", targetId: "source" });
  expect(await target.take("ERROR")).toMatchObject({ requestId: "competing", message: "A playback transfer is already in progress" });
  target.send({ type: "TRANSFER_FAILED", transferId, message: "Autoplay permission missing" });
  expect(await source.take("ABORT_TRANSFER")).toMatchObject({ resume: false });
  expect(await target.take("TRANSFER_RESULT")).toMatchObject({ ok: false, message: "Autoplay permission missing" });
  expect(source.messages.some((message) => message.type === "PAUSE_FOR_TRANSFER")).toBe(false);
});
test("queue changes abort before target starts and restore the source's latest playing intent", async () => {
  const { source, target } = await pair();
  const transferId = await prepare(source, target);
  target.send({ type: "READY", transferId });
  await source.take("PAUSE_FOR_TRANSFER");
  source.send({ type: "SOURCE_PAUSED", transferId, snapshot: { ...snapshot, playing: false, queueState: { ...snapshot.queueState, index: 2 } } });
  expect(await source.take("ABORT_TRANSFER")).toMatchObject({ resume: false });
  expect(await target.take("TRANSFER_RESULT")).toMatchObject({ ok: false, message: "The source queue changed during transfer" });
  expect(target.messages.some((message) => message.type === "START_TRANSFER")).toBe(false);
});
test("a confirmed target start failure resumes the source; ambiguous disconnect never does", async () => {
  const { source, target } = await pair();
  let transferId = await prepare(source, target);
  target.send({ type: "READY", transferId }); await source.take("PAUSE_FOR_TRANSFER");
  source.send({ type: "SOURCE_PAUSED", transferId, snapshot }); await target.take("START_TRANSFER");
  target.send({ type: "TRANSFER_FAILED", transferId, message: "Browser blocked playback" });
  expect(await source.take("ABORT_TRANSFER")).toMatchObject({ resume: true });
  await target.take("TRANSFER_RESULT");
  transferId = await prepare(source, target);
  target.send({ type: "READY", transferId }); await source.take("PAUSE_FOR_TRANSFER");
  source.send({ type: "SOURCE_PAUSED", transferId, snapshot }); await target.take("START_TRANSFER");
  target.socket.terminate();
  expect(await source.take("ABORT_TRANSFER")).toMatchObject({ resume: false });
});
test("logout immediately revokes a live socket", async () => {
  const sessionCookie = (await login(current.app)).cookie!;
  const peer = await connect("revoked", { cookie: sessionCookie });
  const closed = new Promise<number>((resolve) => peer.socket.once("close", (code) => resolve(code)));
  await current.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: sessionCookie } });
  expect(await closed).toBe(4001);
});

test("validates unique occurrences and the exact 5,000-entry queue boundary", async () => {
  const { source, target } = await pair();
  target.send({ type: "TRANSFER_PLAYBACK", requestId: "large", targetId: "target" });
  const { transferId } = await source.take("REQUEST_SNAPSHOT");
  for (const queueState of [{ ...snapshot.queueState, index: 99 }, { ...snapshot.queueState, entries: [] }]) {
    source.send({ type: "SNAPSHOT", transferId, snapshot: { ...snapshot, queueState } });
    expect(await source.take("ERROR")).toMatchObject({ message: "Invalid remote message" });
  }
  source.send({ type: "SNAPSHOT", transferId, snapshot: { ...snapshot,
    queueState: { ...snapshot.queueState, entries: [snapshot.queueState.entries[0], snapshot.queueState.entries[0]] } } });
  expect(await source.take("ERROR")).toMatchObject({ message: "Invalid remote message" });
  const entries = Array.from({ length: 5001 }, (_, index) => ({ ...snapshot.queueState.entries[0], occurrenceId: `occ-${index}` }));
  source.send({ type: "SNAPSHOT", transferId, snapshot: { ...snapshot, queueState: { ...snapshot.queueState, entries } } });
  expect(await source.take("ERROR")).toMatchObject({ message: "Invalid remote message" });
  source.send({ type: "SNAPSHOT", transferId, snapshot: { ...snapshot, queueState: { ...snapshot.queueState, entries: entries.slice(0, 5000) } } });
  const initialized = await target.take("INITIALIZE_PLAYER");
  expect((initialized.snapshot as typeof snapshot).queueState.entries).toHaveLength(5000);
});

test("a timed-out prepare releases the handshake without pausing or auto-resuming the source", async () => {
  const { source, target } = await pair();
  vi.useFakeTimers();
  try {
    await prepare(source, target);
    await vi.advanceTimersByTimeAsync(20001);
  } finally { vi.useRealTimers(); }
  expect(await source.take("ABORT_TRANSFER")).toMatchObject({ resume: false });
  expect(await target.take("TRANSFER_RESULT")).toMatchObject({ ok: false, message: "Playback transfer timed out" });
  expect(source.messages.some((message) => message.type === "PAUSE_FOR_TRANSFER")).toBe(false);
});
