import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import AdminLogs, { formatLogTime } from "./AdminLogs";
import { clearAdminLogs, getAdminLogs } from "../../api/musicdeck";

jest.mock("../../api/musicdeck", () => ({
  getAdminLogs: jest.fn(),
  clearAdminLogs: jest.fn(),
  adminLogsStreamUrl: (after) => `/api/admin/logs/stream?after=${after}`,
}));

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  emit(type, data) {
    for (const handler of this.listeners[type] || []) handler({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

function entry(seq, level, message, extra = {}) {
  return { id: String(seq), seq, level, source: "server", message, timestamp: "2026-01-02T03:04:05.006Z", ...extra };
}

const initialEntries = [
  entry(1, "info", "server listening on 4534"),
  entry(2, "warn", "slow response from navidrome"),
  entry(3, "error", "acquisition failed", { stack: "Error: acquisition failed\n    at spotdl (adapter.ts:10)", meta: { jobId: "job-9" } }),
];

let originalEventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  originalEventSource = window.EventSource;
  window.EventSource = FakeEventSource;
  getAdminLogs.mockResolvedValue({ entries: initialEntries, stats: { capacity: 1000, lastSeq: 3 } });
  clearAdminLogs.mockResolvedValue(null);
});

afterEach(() => {
  window.EventSource = originalEventSource;
});

async function renderLogs() {
  const view = render(<AdminLogs />);
  await screen.findByText("server listening on 4534");
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return view;
}

function rows() {
  return within(screen.getByLabelText("Server log output")).queryAllByRole("listitem");
}

test("formats timestamps as HH:mm:ss.SSS", () => {
  const local = new Date(2026, 0, 2, 3, 4, 5, 6);
  expect(formatLogTime(local.toISOString())).toBe("03:04:05.006");
});

test("loads history, then streams from the last sequence number", async () => {
  await renderLogs();
  const source = FakeEventSource.instances[0];
  expect(source.url).toBe("/api/admin/logs/stream?after=3");
  expect(rows()).toHaveLength(3);

  act(() => {
    source.emit("ready", { stats: { capacity: 1000 } });
    source.emit("logs", { entries: [entry(3, "error", "duplicate"), entry(4, "info", "GET /api/health 200")] });
  });
  expect(screen.getByText("GET /api/health 200")).toBeInTheDocument();
  expect(screen.queryByText("duplicate")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Live");
});

test("filters by level and search text", async () => {
  await renderLogs();
  fireEvent.click(screen.getByRole("button", { name: /^Errors/ }));
  expect(rows()).toHaveLength(1);
  expect(screen.getByText("acquisition failed")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "navidrome" } });
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(screen.getByText("slow response from navidrome")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "job-9" } });
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(screen.getByText("acquisition failed")).toBeInTheDocument();
});

test("pausing holds incoming entries until resumed", async () => {
  await renderLogs();
  const source = FakeEventSource.instances[0];
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  act(() => source.emit("logs", { entries: [entry(4, "info", "held line")] }));
  expect(screen.queryByText("held line")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Resume · 1 new/ }));
  expect(screen.getByText("held line")).toBeInTheDocument();
});

test("expands stack traces and metadata for an entry", async () => {
  await renderLogs();
  const toggle = screen.getByRole("button", { name: /acquisition failed/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/at spotdl \(adapter\.ts:10\)/)).toBeInTheDocument();
  expect(screen.getByText(/"jobId": "job-9"/)).toBeInTheDocument();
});

test("clear asks for confirmation and empties the console", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  await renderLogs();
  fireEvent.click(screen.getByRole("button", { name: "Clear buffer" }));
  await waitFor(() => expect(clearAdminLogs).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect(screen.getByText(/No server log lines yet/)).toBeInTheDocument();
  confirm.mockRestore();
});

test("a cleared event from another admin empties the console", async () => {
  await renderLogs();
  act(() => FakeEventSource.instances[0].emit("cleared", {}));
  expect(rows()).toHaveLength(0);
});

test("export downloads a .log file and revokes the object URL", async () => {
  jest.useFakeTimers();
  const createObjectURL = jest.fn(() => "blob:logs");
  const revokeObjectURL = jest.fn();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  try {
    await renderLogs();
    fireEvent.click(screen.getByRole("button", { name: "Export .log" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    act(() => jest.runOnlyPendingTimers());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:logs");
  } finally {
    click.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    jest.useRealTimers();
  }
});

test("closes the stream on unmount", async () => {
  const { unmount } = await renderLogs();
  unmount();
  expect(FakeEventSource.instances[0].closed).toBe(true);
});
