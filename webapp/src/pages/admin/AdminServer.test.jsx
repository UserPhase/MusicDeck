import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AdminServer from "./AdminServer";
import {
  getAdminHealth,
  getAdminLibraryScanStatus,
  getServerSettings,
  triggerAdminLibraryScan,
  updateServerSettings,
} from "../../api/musicdeck";

jest.mock("../../api/musicdeck", () => ({
  cleanupAdminAcquisitions: jest.fn(),
  getAdminAcquisitions: jest.fn(),
  getAdminBackendConnections: jest.fn(),
  getAdminHealth: jest.fn(),
  getAdminLibraryScanStatus: jest.fn(),
  getDownloaderDiagnostics: jest.fn(),
  getServerSettings: jest.fn(),
  scanAdminAcquisitions: jest.fn(),
  triggerAdminLibraryScan: jest.fn(),
  updateServerSettings: jest.fn(),
}));

jest.mock("./AdminLogs", () => () => null);

const idleStatus = {
  expression: null,
  stored: "",
  enabled: false,
  valid: true,
  timezone: "UTC",
  nextRunAt: null,
  running: false,
  currentRun: null,
  lastRun: null,
};

function settingsWith(schedule) {
  return [
    { key: "jobs.maxConcurrency", value: "2" },
    ...(schedule === undefined ? [] : [{ key: "library.scanSchedule", value: JSON.stringify(schedule) }]),
  ];
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/server"]}>
      <Routes>
        <Route path="/admin/server/*" element={<AdminServer />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  getAdminHealth.mockResolvedValue({ ok: true, backend: "navidrome", database: "ok" });
  getAdminLibraryScanStatus.mockResolvedValue(idleStatus);
  // Mirrors the server's upsert: keys missing from the PATCH keep their stored value.
  updateServerSettings.mockImplementation(async (payload) => {
    const stored = await getServerSettings.mock.results.at(-1)?.value;
    const previous = stored?.find((row) => row.key === "library.scanSchedule");
    return settingsWith(
      "library.scanSchedule" in payload
        ? payload["library.scanSchedule"]
        : previous && JSON.parse(previous.value)
    );
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows a weekly schedule and saves edits as cron", async () => {
  getServerSettings.mockResolvedValue(settingsWith("0 3 * * 0"));
  renderPage();

  const frequency = await screen.findByLabelText("Frequency");
  expect(frequency).toHaveValue("weekly");
  expect(screen.getByLabelText("Day of week")).toHaveValue("0");
  expect(screen.getByLabelText("Time")).toHaveValue("03:00");
  expect(screen.getByText("Scans automatically every Sunday at 03:00 AM")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Day of week"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("Time"), { target: { value: "22:30" } });
  expect(screen.getByText("Scans automatically every Friday at 10:30 PM")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save server settings" }));
  await waitFor(() =>
    expect(updateServerSettings).toHaveBeenCalledWith({
      "jobs.maxConcurrency": 2,
      "library.scanSchedule": "30 22 * * 5",
    })
  );
  expect(await screen.findByText("Server settings saved.")).toBeInTheDocument();
});

test("hides the time picker when disabled and saves an empty schedule", async () => {
  getServerSettings.mockResolvedValue(settingsWith("0 3 * * *"));
  renderPage();

  fireEvent.change(await screen.findByLabelText("Frequency"), { target: { value: "disabled" } });
  expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Day of week")).not.toBeInTheDocument();
  expect(screen.getByText("Automatic scans are disabled")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save server settings" }));
  await waitFor(() =>
    expect(updateServerSettings).toHaveBeenCalledWith(expect.objectContaining({ "library.scanSchedule": "" }))
  );
});

test("preserves an unsupported legacy expression until the admin resets it", async () => {
  getServerSettings.mockResolvedValue(settingsWith("*/15 * * * *"));
  renderPage();

  expect(await screen.findByText("*/15 * * * *")).toBeInTheDocument();
  expect(screen.getByLabelText("Frequency")).toHaveValue("daily");

  fireEvent.click(screen.getByRole("button", { name: "Save server settings" }));
  await waitFor(() => expect(updateServerSettings).toHaveBeenCalledWith({ "jobs.maxConcurrency": 2 }));

  fireEvent.click(screen.getByRole("button", { name: "Reset to Daily at 03:00" }));
  expect(screen.queryByText("*/15 * * * *")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save server settings" }));
  await waitFor(() =>
    expect(updateServerSettings).toHaveBeenLastCalledWith({
      "jobs.maxConcurrency": 2,
      "library.scanSchedule": "0 3 * * *",
    })
  );
});

test("starts a manual scan, shows a spinner and polls until it finishes", async () => {
  jest.useFakeTimers();
  getServerSettings.mockResolvedValue(settingsWith(""));
  const runningStatus = {
    ...idleStatus,
    running: true,
    currentRun: { trigger: "manual", status: "running", startedAt: "2024-01-01T10:00:00.000Z" },
  };
  triggerAdminLibraryScan.mockResolvedValue({ started: true, alreadyRunning: false, status: runningStatus });
  renderPage();

  fireEvent.click(await screen.findByRole("button", { name: "Scan library now" }));
  const busy = await screen.findByRole("button", { name: "Scanning…" });
  expect(busy).toBeDisabled();
  expect(screen.getByText("Library scan started.")).toBeInTheDocument();

  getAdminLibraryScanStatus.mockResolvedValue({
    ...idleStatus,
    lastRun: {
      trigger: "manual",
      status: "succeeded",
      startedAt: "2024-01-01T10:00:00.000Z",
      finishedAt: "2024-01-01T10:01:00.000Z",
    },
  });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });

  expect(await screen.findByRole("button", { name: "Scan library now" })).toBeEnabled();
  expect(screen.getByText("Completed")).toBeInTheDocument();
});
