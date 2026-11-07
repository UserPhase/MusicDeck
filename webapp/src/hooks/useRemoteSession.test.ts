import { act, renderHook } from "@testing-library/react";
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
test("registers same-origin cookies-only control, publishes explicit playback claims and reconnects cleanly", async () => {
  const player = adapter();
  const { result, unmount } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  act(() => ws.open());
  expect(ws.url.pathname).toBe("/api/v1/remote");
  expect(ws.url.search).toBe("");
  expect(ws.sent[0]).toMatchObject({ type: "REGISTER", can_receive: false, state: initial });
  player.state.mockReturnValue({ ...initial, playing: true });
  act(() => jest.advanceTimersByTime(500));
  expect(ws.sent).toContainEqual({ type: "STATE", state: { ...initial, playing: true }, claim: true });
  act(() => ws.close(1006));
  expect(result.current.status).toBe("reconnecting");
  expect(result.current.error).toMatch(/disconnected/);
  act(() => jest.advanceTimersByTime(800));
  expect(FakeSocket.instances).toHaveLength(2);
  const next = FakeSocket.instances[1];
  act(() => next.open());
  expect(result.current.status).toBe("connected");
  // A late close from an old transport must not tear down the replacement.
  act(() => ws.onclose?.({ code: 1006, reason: "" }));
  expect(result.current.status).toBe("connected");
  unmount(); expect(next.readyState).toBe(3);
});

test("reduces background state traffic while keeping the same remote socket open", () => {
  const player = adapter();
  const { unmount } = renderHook(() => useRemoteSession("user", player));
  const ws = FakeSocket.instances[0];
  try {
    act(() => ws.open());
    act(() => setDesktopForeground(false));
    player.state.mockReturnValue({ ...initial, playing: true });
    act(() => jest.advanceTimersByTime(1999));
    expect(ws.sent).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(ws.sent[1]).toMatchObject({ type: "STATE", claim: true });
    player.state.mockReturnValue({ ...initial, playing: true, position_ms: 140000 });
    act(() => setDesktopForeground(true));
    expect(ws.sent[2]).toMatchObject({ type: "STATE", state: { position_ms: 140000 } });
    expect(ws.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.instances).toHaveLength(1);
  } finally {
    unmount();
    setDesktopForeground(null);
  }
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
  expect(player.start).toHaveBeenCalledWith(fresh);
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
  expect(player.command).toHaveBeenCalledWith({ type: "PLAY" });
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
