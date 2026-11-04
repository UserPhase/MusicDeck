import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ActivityCenter from "./ActivityCenter";
import useTaskStream, { createTaskStreamStore } from "../hooks/useTaskStream";
import { clearTaskHistory, controlTask, getTaskLogs, setTaskPriority } from "../api/musicdeck";

jest.mock("../hooks/useTaskStream", () => ({
  ...jest.requireActual("../hooks/useTaskStream"), __esModule: true, default: jest.fn(),
}));
jest.mock("../api/musicdeck", () => ({
  taskStreamUrl: () => "/api/v1/admin/tasks/stream", controlTask: jest.fn(),
  clearTaskHistory: jest.fn(), getTaskLogs: jest.fn(), setTaskPriority: jest.fn(),
}));
class FakeSource {
  static current;
  listeners = {};
  onerror = null;
  close = jest.fn();
  constructor() { FakeSource.current = this; }
  addEventListener(kind, listener) { this.listeners[kind] = listener; }
  emit(kind, data) { this.listeners[kind]?.({ data: JSON.stringify(data) }); }
}
const originalSource = global.EventSource;
const metrics = { memoryBytes: 128 * 1024 ** 2, freeMemoryBytes: 2 * 1024 ** 3, totalMemoryBytes: 4 * 1024 ** 3, loadPerCore: .25, activeStreams: 1, activeWorkers: 1, maxConcurrent: 2, constrained: false };
const task = (id, state, patch = {}) => ({
  id, type: "SPOTDL_IMPORT", state, priority: 300, error: null,
  progress: { percent: 25, itemsProcessed: 1, totalItems: 4, memoryBytes: 128, message: `Processing ${id}` },
  createdAt: "2026-10-01T01:00:00Z", updatedAt: "2026-10-01T01:00:00Z",
  startedAt: state === "QUEUED" ? null : "2026-10-01T01:00:00Z",
  finishedAt: ["FINISHED", "FAILED"].includes(state) ? "2026-10-01T02:00:00Z" : null, ...patch,
});
let stop;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  global.EventSource = FakeSource;
  jest.spyOn(window, "confirm").mockReturnValue(true);
  getTaskLogs.mockResolvedValue({ entries: [] });
});
afterEach(() => {
  act(() => stop?.());
  global.EventSource = originalSource;
  jest.useRealTimers();
  jest.restoreAllMocks();
});
function setup(tasks = []) {
  const store = createTaskStreamStore();
  stop = store.start();
  useTaskStream.mockReturnValue(store);
  const view = render(<MemoryRouter><ActivityCenter /></MemoryRouter>);
  act(() => FakeSource.current.emit("ready", { tasks, metrics }));
  return { store, ...view };
}
const flush = async () => { await act(async () => {}); act(() => jest.advanceTimersByTime(100)); };

test("shows live resource metrics, separate job sections, row progress and reconnect status", () => {
  setup([task("live", "PROCESSING"), task("pending", "QUEUED"), task("done", "FINISHED")]);
  expect(screen.getByRole("heading", { name: "Activity center" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Server resources" })).toHaveTextContent("128.0 MiB");
  expect(screen.getByRole("region", { name: "Active tasks" })).toHaveTextContent("live");
  expect(screen.getByRole("region", { name: "Task queue" })).toHaveTextContent("pending");
  expect(screen.getByRole("region", { name: "Task history & audit log" })).toHaveTextContent("done");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  act(() => FakeSource.current.onerror());
  expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
});

test("wires pause, resume, cancel and priority, with explicit control failures", async () => {
  const live = task("live", "PROCESSING");
  const pending = task("pending", "QUEUED");
  setup([live, pending]);
  const row = within(screen.getByRole("article", { name: "spotDL import live" }));
  controlTask.mockResolvedValueOnce({ task: { ...live, state: "PAUSED" } });
  fireEvent.click(row.getByRole("button", { name: "Pause" }));
  await flush();
  expect(controlTask).toHaveBeenLastCalledWith("live", "pause");
  expect(row.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  controlTask.mockRejectedValueOnce(new Error("Session expired"));
  fireEvent.click(row.getByRole("button", { name: "Resume" }));
  await flush();
  expect(row.getByRole("alert")).toHaveTextContent("Session expired");
  controlTask.mockResolvedValueOnce({ task: { ...live, state: "CANCELLED" } });
  fireEvent.click(row.getByRole("button", { name: "Cancel" }));
  await flush();
  expect(controlTask).toHaveBeenLastCalledWith("live", "cancel");
  const queued = within(screen.getByRole("article", { name: "spotDL import pending" }));
  fireEvent.change(queued.getByLabelText("Priority"), { target: { value: "901" } });
  setTaskPriority.mockResolvedValueOnce({ task: { ...pending, priority: 901 } });
  fireEvent.click(queued.getByRole("button", { name: "Apply priority" }));
  await flush();
  expect(setTaskPriority).toHaveBeenCalledWith("pending", 901);
});

test("filters history, expands redacted process traces and clears only confirmed terminal history", async () => {
  setup([task("live", "PROCESSING"), task("done", "FINISHED"), task("broken", "FAILED", { error: "Download failed" })]);
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "FAILED" } });
  expect(screen.queryByRole("article", { name: "spotDL import done" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "broken" } });
  const failed = within(screen.getByRole("article", { name: "spotDL import broken" }));
  getTaskLogs.mockResolvedValueOnce({ entries: [{ seq: 1, at: "2026-10-01T02:00:00Z", source: "stderr", message: "password=[REDACTED] <script>not HTML</script>" }] });
  fireEvent.click(failed.getByRole("button", { name: "View diagnostics" }));
  await flush();
  expect(failed.getByLabelText("Diagnostics for broken")).toHaveTextContent("[stderr] password=[REDACTED] <script>not HTML</script>");
  expect(document.querySelector("script")).toBeNull();
  window.confirm.mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
  expect(clearTaskHistory).not.toHaveBeenCalled();
  clearTaskHistory.mockResolvedValueOnce({ ids: ["done", "broken"] });
  fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
  await flush();
  expect(screen.queryByRole("article", { name: "spotDL import broken" })).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "spotDL import live" })).toBeInTheDocument();
});

test("diagnostic fetch errors are retryable and missing historical traces are explained", async () => {
  setup([task("broken", "FAILED")]);
  getTaskLogs.mockRejectedValueOnce(new Error("Server unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
  await flush();
  expect(screen.getByRole("alert")).toHaveTextContent("Server unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Refresh diagnostics" }));
  await flush();
  expect(screen.getByText(/No retained trace/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("an initial disconnect does not present an unconfirmed empty queue as success", () => {
  const store = createTaskStreamStore();
  stop = store.start();
  useTaskStream.mockReturnValue(store);
  render(<MemoryRouter><ActivityCenter /></MemoryRouter>);
  expect(screen.getByText(/No task state has been confirmed/)).toBeInTheDocument();
  expect(screen.queryByText("All quiet.")).not.toBeInTheDocument();
});
