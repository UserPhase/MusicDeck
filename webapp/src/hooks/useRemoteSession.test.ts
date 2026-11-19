import { act, renderHook as renderTestHook, type RenderHookOptions } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { useRemoteSession } from "./useRemoteSession";
import { setDesktopForeground } from "../services/visualActivity";
import type { RemotePlaybackSnapshot, RemotePlayerAdapter, RemotePlayerState } from "../types/remoteSession";

const initial: RemotePlayerState = { current_track: { id: "one", title: "Set" }, position_ms: 123456.789, duration_ms: 600000, playing: false, volume: .6 };
const snapshot: RemotePlaybackSnapshot = { trackId: "one", exactPositionMs: 123456.789, playing: true, volume: .6,
  queueState: { entries: ["first", "repeat"].map((occurrenceId) => ({ occurrenceId, trackId: "one", title: "Set", artist: "DJ", album: "Live", duration: 600 })),
    index: 1, repeatOne: false, shuffle: true, shuffleMode: "smart", shuffleSeed: 42, albumAware: true, context: null } };
class FakeSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: URL) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  message(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}
const original = global.WebSocket;
function adapter() {
  return { state: jest.fn(() => initial), capture: jest.fn(() => snapshot), command: jest.fn(async () => {}),
    prepare: jest.fn(async (_snapshot: RemotePlaybackSnapshot, _signal: AbortSignal) => {}),
    start: jest.fn(async (_snapshot: RemotePlaybackSnapshot) => {}), pause: jest.fn(), enable: jest.fn(async () => {}) } satisfies RemotePlayerAdapter;
}
beforeEach(() => {
  jest.useFakeTimers(); FakeSocket.instances.length = 0;
  Object.defineProperty(global, "WebSocket", { configurable: true, value: FakeSocket });
});
afterEach(() => {
  jest.useRealTimers(); Object.defineProperty(global, "WebSocket", { configurable: true, value: original });
});
async function receive(ws: FakeSocket, message: object) { await act(async () => { ws.message(message); }); }

function renderHook<Result, Props>(callback: (props: Props) => Result, options?: RenderHookOptions<Props>) {
  const rendered = renderTestHook(callback, options);
  act(() => { jest.advanceTimersByTime(0); });
  return rendered;
}

test("opens a single socket when Strict Mode replays the startup effect", () => {
  const player = adapter();
  renderTestHook(() => useRemoteSession("user", player), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
  });
  expect(FakeSocket.instances).toHaveLength(0);
  act(() => { jest.advanceTimersByTime(0); });
  expect(FakeSocket.instances).toHaveLength(1);
});

test("a local pause failure cannot interrupt cleanup after explicit revocation", () => {
  const player = adapter();
  player.state.mockReturnValue({ ...initial, playing: true });
  const failure = new DOMException("Audio automation failed");
  player.pause.mockImplementationOnce(() => { throw failure; });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const { result, unmount } = renderHook(() => useRemoteSession("user", player));
  try {
    const ws = FakeSocket.instances[0];
    act(() => ws.open());
    act(() => ws.close(4002));
    expect(log).toHaveBeenCalledWith("Remote session:", failure);
    expect(result.current.status).toBe("reconnecting");
    act(() => jest.advanceTimersByTime(800));
    expect(FakeSocket.instances).toHaveLength(2);
  } finally {
    unmount();
    log.mockRestore();
  }
});

test("registers same-origin cookies-only control, publishes explicit playback claims and reconnects cleanly", async () => {
  const player = adapter();
  const { result, rerender, unmount } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  expect(ws.url.pathname).toBe("/api/v1/remote");
  expect(ws.url.search).toBe("");
  expect(ws.sent[0]).toMatchObject({ type: "REGISTER", can_receive: false, state: initial });
  player.state.mockReturnValue({ ...initial, playing: true });
  rerender();
  expect(ws.sent).toContainEqual({ type: "STATE", state: { ...initial, playing: true }, claim: true });
  act(() => ws.close(1006));
  expect(result.current.status).toBe("reconnecting");
  expect(result.current.error).toMatch(/disconnected/);
  act(() => jest.advanceTimersByTime(800));
  expect(FakeSocket.instances).toHaveLength(2);
  const next = FakeSocket.instances[1];
  act(() => next.open());
  expect(result.current.status).not.toBe("connected");
  await receive(next, { type: "DEVICES", devices: [] });
  expect(result.current.status).toBe("connected");
  // A late close from an old transport must not tear down the replacement.
  act(() => ws.onclose?.({ code: 1006, reason: "" }));
  act(() => ws.onerror?.());
  expect(result.current.status).toBe("connected");
  expect(result.current.error).toBe("");
  unmount(); expect(next.readyState).toBe(3);
});

test("samples only the playing device and backs off in the background without closing its socket", async () => {
  const player = adapter();
  const { result, rerender, unmount } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  try {
    act(() => ws.open());
    await receive(ws, { type: "DEVICES", devices: [] });
    const listenersBefore = player.state.mock.calls.length;
    act(() => jest.advanceTimersByTime(30_000));
    expect(player.state).toHaveBeenCalledTimes(listenersBefore);

    act(() => setDesktopForeground(false));
    player.state.mockReturnValue({ ...initial, playing: true });
    rerender();
    expect(ws.sent[1]).toMatchObject({ type: "STATE", claim: true });
    const now = Date.now();
    const state = { device_id: result.current.deviceId, track: initial.current_track, position_ms: initial.position_ms,
      duration_ms: initial.duration_ms, volume: initial.volume, updated_at: now, is_playing: true, revision: 1 };
    await receive(ws, { type: "INITIAL_STATE", state, server_time: now });
    player.state.mockReturnValue({ ...initial, playing: true, position_ms: 140000 });
    act(() => jest.advanceTimersByTime(19_999));
    expect(ws.sent).toHaveLength(2);
    act(() => jest.advanceTimersByTime(1));
    expect(ws.sent[2]).toMatchObject({ type: "STATE", state: { position_ms: 140000 } });

    player.state.mockReturnValue({ ...initial, playing: true, position_ms: 142000 });
    act(() => setDesktopForeground(true));
    expect(ws.sent[3]).toMatchObject({ type: "STATE", state: { position_ms: 142000 } });

    player.state.mockReturnValue({ ...initial, playing: false });
    rerender();
    const listenersAfterPause = player.state.mock.calls.length;
    act(() => jest.advanceTimersByTime(30_000));
    expect(player.state).toHaveBeenCalledTimes(listenersAfterPause);
    expect(ws.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.instances).toHaveLength(1);
  } finally {
    unmount();
    setDesktopForeground(null);
  }
});
test("publishes track and pause changes immediately without waking the position timer", () => {
  const player = adapter();
  const { rerender } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const state = { ...initial, playing: true, current_track: { id: "two", title: "Live", artist: "DJ" } };
  player.state.mockReturnValue(state);
  rerender();
  expect(ws.sent.at(-1)).toEqual({ type: "STATE", state, claim: true });
  player.state.mockReturnValue({ ...state, playing: false });
  rerender();
  expect(ws.sent.at(-1)).toEqual({ type: "STATE", state: { ...state, playing: false }, claim: false });
});
test("coalesces 500 continuous seeks into one latest-value command in an 80 ms window", async () => {
  const { result } = renderHook(() => useRemoteSession("user", adapter()));
  const ws = FakeSocket.instances[0]; act(() => ws.open());
  let commands: Promise<void>[] = [];
  act(() => {
    commands = Array.from({ length: 500 }, (_, index) => result.current.command({ type: "SEEK", position_ms: index + .125 }));
    jest.advanceTimersByTime(79);
  });
  expect(ws.sent.filter((message) => message.type === "COMMAND")).toHaveLength(0);
  act(() => jest.advanceTimersByTime(1));
  const sent = ws.sent.filter((message) => message.type === "COMMAND");
  expect(sent).toHaveLength(1);
  expect(sent[0].command).toEqual({ type: "SEEK", position_ms: 499.125 });
  await receive(ws, { type: "COMMAND_RESULT", requestId: sent[0].requestId, ok: true });
  await expect(Promise.all(commands)).resolves.toHaveLength(500);
});
test("uses the server snapshot clock, ignores older revisions, and clears the clock on disconnect", async () => {
  const { result } = renderHook(() => useRemoteSession("user", adapter()));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const now = Date.now();
  const state = { device_id: "desk", track: initial.current_track, position_ms: 10000,
    duration_ms: 600000, volume: .6, updated_at: now - 2000, is_playing: true, revision: 3 };
  await receive(ws, { type: "INITIAL_STATE", state, server_time: now, queue: snapshot.queueState });
  expect(result.current.readPosition?.()).toBeCloseTo(12);
  act(() => jest.advanceTimersByTime(500));
  expect(result.current.readPosition?.()).toBeCloseTo(12.5);
  await receive(ws, { type: "STATE_SYNC", state: { ...state, revision: 2, position_ms: 0 }, server_time: Date.now() });
  expect(result.current.playback?.revision).toBe(3);
  await receive(ws, { type: "STATE_SYNC", state: { ...state, revision: 4, position_ms: 12500, is_playing: false }, server_time: Date.now() });
  act(() => jest.advanceTimersByTime(500));
  expect(result.current.readPosition?.()).toBeCloseTo(12.5);
  expect(result.current.playback?.queue).toEqual(snapshot.queueState);
  act(() => ws.close(1006));
  expect(result.current.playback).toBeNull();
});
test("requires an explicit target gesture and preserves exact preparation/start payloads", async () => {
  const player = adapter();
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0]; act(() => ws.open());
  await act(async () => { await result.current.enable(); });
  expect(player.enable).toHaveBeenCalledTimes(1);
  expect(ws.sent[ws.sent.length - 1]).toMatchObject({ type: "REGISTER", can_receive: true });
  await receive(ws, { type: "INITIALIZE_PLAYER", transferId: "transfer", snapshot });
  expect(player.prepare).toHaveBeenCalledWith(snapshot, expect.any(AbortSignal));
  expect(ws.sent).toContainEqual({ type: "READY", transferId: "transfer" });
  expect(player.start).not.toHaveBeenCalled();
  const fresh = { ...snapshot, exactPositionMs: 125789.123 };
  await receive(ws, { type: "START_TRANSFER", transferId: "transfer", snapshot: fresh });
  expect(player.start).toHaveBeenCalledWith(fresh, expect.any(AbortSignal));
  expect(ws.sent).toContainEqual({ type: "STARTED", transferId: "transfer" });
  await receive(ws, { type: "TRANSFER_COMPLETE", transferId: "transfer" });
});
test("source keeps playing until PAUSE_FOR_TRANSFER and captures before pausing", async () => {
  const player = adapter();
  renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0]; act(() => ws.open());
  await receive(ws, { type: "REQUEST_SNAPSHOT", transferId: "transfer" });
  expect(player.pause).not.toHaveBeenCalled();
  expect(ws.sent).toContainEqual({ type: "SNAPSHOT", transferId: "transfer", snapshot });
  await receive(ws, { type: "PAUSE_FOR_TRANSFER", transferId: "transfer" });
  expect(player.capture).toHaveBeenCalledTimes(2);
  expect(player.pause).toHaveBeenCalledTimes(1);
  expect(ws.sent).toContainEqual({ type: "SOURCE_PAUSED", transferId: "transfer", snapshot });
  await receive(ws, { type: "ABORT_TRANSFER", transferId: "transfer", resume: true });
  expect(player.command).toHaveBeenCalledWith({ type: "PLAY" }, expect.any(AbortSignal));
});

test("expires queued executions and preserves the output on a transient close", async () => {
  const player = adapter();
  let complete!: () => void;
  player.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const now = Date.now();
  await receive(ws, { type: "INITIAL_STATE", server_time: now, state: {
    device_id: result.current.deviceId, track: initial.current_track, position_ms: 1000,
    duration_ms: 30000, is_playing: true, volume: 1, updated_at: now, revision: 1,
  } });
  await receive(ws, { type: "EXECUTE", requestId: "first", command: { type: "PLAY" },
    expiresAt: now + 8000, deadlineAt: now + 8000, timeoutMs: 8000 });
  await receive(ws, { type: "EXECUTE", requestId: "queued", command: { type: "SKIP", direction: "next" },
    expiresAt: now + 100, deadlineAt: now + 100, timeoutMs: 100 });
  act(() => jest.advanceTimersByTime(101));
  await act(async () => { complete(); });
  expect(player.command).toHaveBeenCalledTimes(1);
  expect(ws.sent).toContainEqual({
    type: "COMMAND_RESULT", requestId: "queued", expiresAt: now + 100, ok: false,
    message: "Playback command expired before execution",
  });
  act(() => ws.close(1006));
  expect(player.pause).not.toHaveBeenCalled();
});

test("only resets reconnect backoff after the application handshake", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  const { result } = renderHook(() => useRemoteSession("user", adapter()));
  try {
    const first = FakeSocket.instances[0];
    act(() => first.open());
    await receive(first, { type: "DEVICES", live_state_protocol: true, devices: [] });
    act(() => jest.advanceTimersByTime(12_500));
    const second = FakeSocket.instances[1];
    act(() => second.open());
    act(() => jest.advanceTimersByTime(12_999));
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => jest.advanceTimersByTime(1));
    const third = FakeSocket.instances[2];
    act(() => third.open());
    const now = Date.now();
    await receive(third, { type: "INITIAL_STATE", server_time: now, state: {
      device_id: null, track: null, position_ms: 0, duration_ms: 0, is_playing: false,
      volume: 1, updated_at: now, revision: 1,
    }});
    expect(result.current.status).toBe("connected");
    act(() => third.close(1011));
    act(() => jest.advanceTimersByTime(500));
    expect(FakeSocket.instances).toHaveLength(4);
  } finally {
    jest.restoreAllMocks();
  }
});

test("a wall clock jump does not move the remote playhead", async () => {
  const { result } = renderHook(() => useRemoteSession("user", adapter()));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const now = Date.now();
  const state = { device_id: "desk", track: initial.current_track, position_ms: 1000,
    duration_ms: 60000, is_playing: true, volume: 1, updated_at: now, revision: 1 };
  await receive(ws, { type: "INITIAL_STATE", state, server_time: now });
  act(() => { jest.setSystemTime(now + 3600_000); jest.advanceTimersByTime(100); });
  await receive(ws, { type: "STATE_SYNC", state: { ...state, revision: 2, position_ms: 1100, updated_at: now + 100 },
    server_time: now + 100 });
  expect(result.current.readPosition?.()).toBeCloseTo(1.1);
});

function ownedState(deviceId: string, now: number, revision = 1) {
  return { device_id: deviceId, track: initial.current_track, position_ms: 1000,
    duration_ms: 60000, is_playing: true, volume: 1, updated_at: now, revision };
}

async function acknowledgeLease(ws: FakeSocket) {
  const probe = ws.sent.filter(frame => frame.type === "RENEW_PLAYBACK_LEASE").at(-1);
  expect(probe).toBeDefined();
  await receive(ws, { type: "PLAYBACK_LEASE", sequence: probe?.sequence, leaseMs: 5_000,
    device_id: probe?.device_id, leaseGeneration: probe?.leaseGeneration });
}

test("rejoins the same owner after a socket error and pauses on authoritative takeover", async () => {
  const player = adapter();
  player.state.mockReturnValue({ ...initial, playing: true });
  const { result } = renderHook(() => useRemoteSession("user", player));
  const first = FakeSocket.instances[0];
  act(() => first.open());
  const device = result.current.deviceId;
  await receive(first, { type: "INITIAL_STATE", server_time: Date.now(), playbackLeaseProtocol: 1, playbackLeaseMs: 5_000, leaseGeneration: "lease-one",
    state: ownedState(device, Date.now()) });
  await acknowledgeLease(first);
  act(() => jest.advanceTimersByTime(2_000));
  const delayed = first.sent.filter(frame => frame.type === "RENEW_PLAYBACK_LEASE").at(-1);
  act(() => jest.advanceTimersByTime(2_200));
  await receive(first, { type: "PLAYBACK_LEASE", sequence: delayed?.sequence, leaseMs: 5_000,
    device_id: device, leaseGeneration: "lease-one" });
  act(() => jest.advanceTimersByTime(800));
  expect(player.pause).not.toHaveBeenCalled();
  let command!: Promise<void>;
  act(() => { command = result.current.command({ type: "PLAY" }); });
  const rejected = expect(command).rejects.toThrow("disconnected");
  act(() => first.onerror?.());
  await rejected;
  expect(player.pause).not.toHaveBeenCalled();

  act(() => jest.advanceTimersByTime(0));
  const rejoined = FakeSocket.instances[1];
  act(() => rejoined.open());
  expect(rejoined.sent[0]).toMatchObject({ type: "REGISTER", device_id: device, leaseGeneration: "lease-one" });
  await receive(rejoined, { type: "INITIAL_STATE", server_time: Date.now(), playbackLeaseProtocol: 1, playbackLeaseMs: 5_000, leaseGeneration: "lease-one",
    state: ownedState(device, Date.now()) });
  await acknowledgeLease(rejoined);
  expect(result.current.status).toBe("connected");
  expect(player.pause).not.toHaveBeenCalled();

  await receive(rejoined, { type: "STATE_SYNC", server_time: Date.now(), state: ownedState("phone", Date.now(), 2) });
  expect(player.pause).toHaveBeenCalledTimes(1);
});

test("a watchdog miss reconnects immediately and pauses only when the last ownership lease expires", async () => {
  const player = adapter();
  player.state.mockReturnValue({ ...initial, playing: true });
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const now = Date.now();
  await receive(ws, { type: "INITIAL_STATE", server_time: now, controlTimeoutMs: 25_000, playbackLeaseProtocol: 1, playbackLeaseMs: 5_000, leaseGeneration: "lease-one",
    state: ownedState(result.current.deviceId, now) });
  await acknowledgeLease(ws);
  for (let elapsed = 2_000; elapsed <= 24_000; elapsed += 2_000) {
    act(() => jest.advanceTimersByTime(2_000));
    await acknowledgeLease(ws);
  }
  act(() => jest.advanceTimersByTime(1_000));
  expect(ws.readyState).toBe(3);
  expect(result.current.status).toBe("reconnecting");
  expect(player.pause).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(3_899));
  expect(FakeSocket.instances).toHaveLength(2);
  expect(player.pause).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(player.pause).toHaveBeenCalledTimes(1);
});

test("an older server keeps playback working without a generation-based lease", async () => {
  const player = adapter();
  player.state.mockReturnValue({ ...initial, playing: true });
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  await receive(ws, { type: "INITIAL_STATE", server_time: Date.now(), playbackLeaseMs: 5_000,
    state: ownedState(result.current.deviceId, Date.now()) });
  act(() => jest.advanceTimersByTime(6_000));
  expect(ws.sent.some(frame => frame.type === "RENEW_PLAYBACK_LEASE")).toBe(false);
  expect(player.pause).not.toHaveBeenCalled();
});

test.each(["wrong-device", "stale-generation"])("a %s renewal cannot extend playback after a 1011 close", async (failure) => {
  const player = adapter();
  player.state.mockReturnValue({ ...initial, playing: true });
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  const device = result.current.deviceId;
  await receive(ws, { type: "INITIAL_STATE", server_time: Date.now(), playbackLeaseProtocol: 1, playbackLeaseMs: 5_000, leaseGeneration: "owner",
    state: ownedState(device, Date.now()) });
  await acknowledgeLease(ws);
  act(() => jest.advanceTimersByTime(2_000));
  const probe = ws.sent.filter(frame => frame.type === "RENEW_PLAYBACK_LEASE").at(-1);
  await receive(ws, { type: "PLAYBACK_LEASE", sequence: probe?.sequence, leaseMs: 5_000,
    device_id: failure === "wrong-device" ? "phone" : device,
    leaseGeneration: failure === "stale-generation" ? "stale" : "owner" });
  act(() => ws.close(1011, "Session storage temporarily unavailable"));
  expect(player.pause).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(0));
  expect(FakeSocket.instances).toHaveLength(2);
  act(() => jest.advanceTimersByTime(2_899));
  expect(player.pause).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(player.pause).toHaveBeenCalledTimes(1);
});

test("a disconnected handoff target stops provisional output and suppresses late STARTED", async () => {
  const player = adapter();
  let finish!: () => void;
  player.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  await act(async () => { await result.current.enable(); });
  await receive(ws, { type: "INITIALIZE_PLAYER", transferId: "handoff", snapshot });
  await receive(ws, { type: "START_TRANSFER", transferId: "handoff", snapshot, playbackLeaseMs: 5_000 });
  const signal = player.prepare.mock.calls[0][1];
  act(() => ws.close(1006));
  expect(signal.aborted).toBe(true);
  expect(player.pause).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  expect(ws.sent.some(frame => frame.type === "STARTED")).toBe(false);
  act(() => jest.advanceTimersByTime(0));
  expect(FakeSocket.instances).toHaveLength(2);
});

test("aborts a target start before confirming rollback and suppresses its late success", async () => {
  const player = adapter();
  let finish!: () => void;
  player.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  await act(async () => { await result.current.enable(); });
  await receive(ws, { type: "INITIALIZE_PLAYER", transferId: "handoff", snapshot });
  await receive(ws, { type: "START_TRANSFER", transferId: "handoff", snapshot });
  await receive(ws, { type: "ABORT_TRANSFER", transferId: "handoff" });
  const signal = player.prepare.mock.calls[0][1];
  expect(signal.aborted).toBe(true);
  expect(player.pause).toHaveBeenCalledTimes(1);
  expect(ws.sent).toContainEqual({ type: "TRANSFER_ROLLED_BACK", transferId: "handoff" });
  await act(async () => { finish(); });
  expect(ws.sent.some(frame => frame.type === "STARTED")).toBe(false);
});
test("account changes abort pending preparation and prevent a late READY or old commands", async () => {
  const player = adapter();
  let finish: (() => void) | undefined;
  player.prepare.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ user }) => useRemoteSession(user, player), { initialProps: { user: "one" } });
  const ws = FakeSocket.instances[0]; act(() => ws.open());
  await act(async () => { await result.current.enable(); });
  await receive(ws, { type: "INITIALIZE_PLAYER", transferId: "transfer", snapshot });
  const signal = player.prepare.mock.calls[0][1];
  rerender({ user: "two" });
  expect(signal.aborted).toBe(true);
  expect(player.pause).toHaveBeenCalled();
  await act(async () => { finish?.(); });
  expect(ws.sent.some((message) => message.type === "READY")).toBe(false);
  await receive(ws, { type: "EXECUTE", requestId: "late", command: { type: "PLAY" } });
  expect(player.command).not.toHaveBeenCalled();
});
test("target playback failure pauses before reporting failure; registry errors remain visible", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const player = adapter(); player.start.mockRejectedValue(new Error("Browser blocked audio"));
    const { result } = renderHook(() => useRemoteSession("user", player));
    const ws = FakeSocket.instances[0]; act(() => ws.open());
    await act(async () => { await result.current.enable(); });
    await receive(ws, { type: "INITIALIZE_PLAYER", transferId: "transfer", snapshot });
    await receive(ws, { type: "START_TRANSFER", transferId: "transfer", snapshot });
    expect(player.pause).toHaveBeenCalled();
    expect(ws.sent).toContainEqual({ type: "TRANSFER_FAILED", transferId: "transfer", message: "Browser blocked audio" });
    expect(result.current.error).toBe("Browser blocked audio");
    expect(ws.sent.some((message) => message.type === "STARTED")).toBe(false);
    await receive(ws, { type: "DEVICES", devices: [{ device_id: "invalid" }] });
    expect(result.current.error).toBe("Invalid remote device registry");
  } finally { log.mockRestore(); }
});
