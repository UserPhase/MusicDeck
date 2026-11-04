import { createTaskStreamStore, type ActivityTask } from "./useTaskStream";
import { clearTaskHistory, controlTask, setTaskPriority } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  taskStreamUrl: () => "/api/v1/admin/tasks/stream",
  controlTask: jest.fn(), clearTaskHistory: jest.fn(), setTaskPriority: jest.fn(),
}));

class FakeSource {
  static instances: FakeSource[] = [];
  listeners = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  close = jest.fn();
  constructor(public url: string, public options: EventSourceInit) { FakeSource.instances.push(this); }
  addEventListener(kind: string, listener: (event: { data: string }) => void) { this.listeners.set(kind, listener); }
  emit(kind: string, data: unknown) { this.listeners.get(kind)?.({ data: JSON.stringify(data) }); }
}
const originalSource = global.EventSource;
const metrics = { memoryBytes: 100, freeMemoryBytes: 200, totalMemoryBytes: 300, loadPerCore: .2, activeStreams: 1, activeWorkers: 1, maxConcurrent: 2, constrained: false };
const task = (id: string, patch: Partial<ActivityTask> = {}): ActivityTask => ({
  id, type: "LIBRARY_SCAN", state: "PROCESSING", priority: 200, error: null,
  createdAt: "2026-10-01T01:00:00Z", updatedAt: "2026-10-01T01:00:00Z",
  startedAt: "2026-10-01T01:00:00Z", finishedAt: null,
  progress: { percent: 0, itemsProcessed: 0, totalItems: 100, memoryBytes: 100, message: "Scanning" }, ...patch,
});
let stop: (() => void) | undefined;
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0);
  FakeSource.instances = [];
  Object.defineProperty(global, "EventSource", { configurable: true, writable: true, value: FakeSource });
  jest.clearAllMocks();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(global, "EventSource", { configurable: true, writable: true, value: originalSource });
});
function setup(tasks = [task("one"), task("two")]) {
  const store = createTaskStreamStore();
  stop = store.start();
  const source = FakeSource.instances[0];
  source.emit("ready", { tasks, metrics });
  return { store, source };
}

test("batches 100 Hz progress into row-only notifications without changing the structural snapshot", () => {
  const { store, source } = setup();
  expect(source.url).toBe("/api/v1/admin/tasks/stream");
  expect(source.options).toEqual({ withCredentials: true });
  const groups = store.getSnapshot();
  const groupListener = jest.fn();
  const one = jest.fn();
  const two = jest.fn();
  store.subscribe(groupListener);
  store.subscribeTask("one", one);
  store.subscribeTask("two", two);
  for (let i = 1; i <= 10; i++) {
    source.emit("task.progress", { task: { ...task("one"), progress: { ...task("one").progress, percent: i } } });
    jest.advanceTimersByTime(10);
  }
  expect(one).toHaveBeenCalledTimes(1);
  expect(two).not.toHaveBeenCalled();
  expect(groupListener).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toBe(groups);
  expect(store.getTask("one")?.progress.percent).toBe(10);
  source.emit("task.state", { task: task("one", { state: "FINISHED", finishedAt: "2026-10-01T02:00:00Z" }) });
  jest.advanceTimersByTime(100);
  expect(groupListener).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().history).toEqual(["one"]);
});

test("reconnects exponentially, replaces stale snapshots and closes timers on cleanup", () => {
  const { store, source } = setup();
  source.onerror?.();
  expect(source.close).toHaveBeenCalled();
  expect(store.getConnection().status).toBe("reconnecting");
  jest.advanceTimersByTime(499);
  expect(FakeSource.instances).toHaveLength(1);
  jest.advanceTimersByTime(1);
  const second = FakeSource.instances[1];
  second.onerror?.();
  jest.advanceTimersByTime(999);
  expect(FakeSource.instances).toHaveLength(2);
  jest.advanceTimersByTime(1);
  const third = FakeSource.instances[2];
  third.emit("ready", { tasks: [task("fresh", { state: "QUEUED", startedAt: null })], metrics });
  expect(store.getSnapshot()).toEqual({ active: [], queued: ["fresh"], history: [] });
  expect(store.getConnection().status).toBe("live");
  source.emit("task.state", { task: task("stale") });
  jest.advanceTimersByTime(100);
  expect(store.getTask("stale")).toBeUndefined();
  stop?.(); stop = undefined;
  jest.advanceTimersByTime(120_000);
  expect(third.close).toHaveBeenCalled();
  expect(FakeSource.instances).toHaveLength(3);
  expect(store.getSnapshot()).toEqual({ active: [], queued: [], history: [] });
});

test("reports malformed streams and reconnects when heartbeat/metrics stop", () => {
  const { store, source } = setup();
  source.emit("task.progress", { task: { id: "invalid" } });
  expect(store.getConnection()).toMatchObject({ status: "reconnecting", error: "Invalid task update." });
  jest.advanceTimersByTime(500);
  const second = FakeSource.instances[1];
  second.emit("ready", { tasks: [], metrics });
  jest.advanceTimersByTime(44_000);
  second.emit("heartbeat", { at: "now" });
  jest.advanceTimersByTime(44_000);
  expect(store.getConnection().status).toBe("live");
  jest.advanceTimersByTime(1000);
  expect(store.getConnection().error).toContain("stopped responding");
});

test("control responses cannot overwrite newer stream events, and history clear keeps active jobs", async () => {
  const { store, source } = setup([task("one"), task("done", { state: "FINISHED", finishedAt: "2026-10-01T02:00:00Z" })]);
  let finish: (value: { task: ActivityTask }) => void = () => {};
  jest.mocked(controlTask).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const request = store.act("one", "pause");
  source.emit("task.state", { task: task("one", { state: "FINISHED", finishedAt: "2026-10-01T02:00:00Z" }) });
  finish({ task: task("one", { state: "PAUSED" }) });
  await request;
  expect(store.getTask("one")?.state).toBe("FINISHED");
  source.emit("task.state", { task: task("active") });
  jest.mocked(clearTaskHistory).mockResolvedValue({ ids: ["done", "one"] });
  await store.clearHistory();
  expect(store.getSnapshot()).toEqual({ active: ["active"], queued: [], history: [] });
  source.emit("history.cleared", { ids: ["done"] });
  expect(store.getTask("active")).toBeDefined();
});

test("priority changes sort pending tasks while preserving stable equal-priority FIFO", async () => {
  const { store } = setup([task("first", { state: "QUEUED", startedAt: null }), task("second", { state: "QUEUED", startedAt: null })]);
  jest.mocked(setTaskPriority).mockResolvedValue({ task: task("second", { state: "QUEUED", startedAt: null, priority: 900 }) });
  await store.act("second", "priority", 900);
  jest.advanceTimersByTime(100);
  expect(store.getSnapshot().queued).toEqual(["second", "first"]);
  expect(setTaskPriority).toHaveBeenCalledWith("second", 900);
});

test("unsupported EventSource is explicit rather than silently returning an empty dashboard", () => {
  Object.defineProperty(global, "EventSource", { configurable: true, writable: true, value: undefined });
  const store = createTaskStreamStore();
  stop = store.start();
  expect(store.getConnection()).toMatchObject({ status: "unavailable", error: expect.stringContaining("does not support") });
});
