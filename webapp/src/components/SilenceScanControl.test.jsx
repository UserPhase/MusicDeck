import { act, fireEvent, render, screen } from "@testing-library/react";
import SilenceScanControl from "./SilenceScanControl";
import { getSilenceScan, startSilenceScan } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({ getSilenceScan: jest.fn(), startSilenceScan: jest.fn() }));
const parameters = { thresholdDb: -28, minSilenceSeconds: 0.8 };
const running = { id: "silence", status: "running", totalTracks: 12, completedTracks: 3, skippedTracks: 1,
  failedTracks: 0, currentTrack: "Artist — Song", parameters };
beforeEach(() => { jest.clearAllMocks(); getSilenceScan.mockResolvedValue(null); });

test("starts with the selected silence settings and shows progress beside the current-track action", async () => {
  jest.useFakeTimers();
  try {
    startSilenceScan.mockResolvedValue(running);
    render(<SilenceScanControl {...parameters}><button>Re-analyze current track</button></SilenceScanControl>);
    await act(async () => {});
    const group = screen.getByRole("group", { name: "Library silence scan" });
    expect(group).toContainElement(screen.getByRole("button", { name: "Re-analyze current track" }));
    getSilenceScan.mockResolvedValue(running);
    fireEvent.click(screen.getByRole("button", { name: "Analyze all tracks" }));
    await act(async () => {});
    expect(startSilenceScan).toHaveBeenCalledWith(parameters);
    expect(screen.getByRole("button", { name: "Analyzing library..." })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Library silence scan" })).toHaveAttribute("value", "3");
    expect(screen.getByText(/Scan settings: -28 dB/)).toBeInTheDocument();
    getSilenceScan.mockResolvedValue({ ...running, status: "completed", completedTracks: 11, failedTracks: 1 });
    await act(async () => jest.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Analyze all tracks" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("11 of 12 tracks · 1 failed");
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "12");
  } finally { jest.useRealTimers(); }
});

test("disables scans when trimming is off and keeps an existing scan visible after reopening", async () => {
  getSilenceScan.mockResolvedValue(running);
  render(<SilenceScanControl disabled {...parameters} />);
  expect(await screen.findByRole("button", { name: "Analyzing library..." })).toBeDisabled();
  expect(screen.getByText(/Silence trimming is off for your account/)).toBeInTheDocument();
  expect(screen.getByText("Artist — Song")).toBeInTheDocument();
  expect(startSilenceScan).not.toHaveBeenCalled();
});

test("rejects invalid settings before starting a scan", async () => {
  render(<SilenceScanControl thresholdDb={-35} minSilenceSeconds={0} />);
  expect(screen.getByRole("button", { name: "Analyze all tracks" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("greater than 0");
  expect(startSilenceScan).not.toHaveBeenCalled();
});

test("reports start failures and lets the user retry", async () => {
  startSilenceScan.mockRejectedValue(new Error("offline"));
  render(<SilenceScanControl {...parameters} />);
  fireEvent.click(screen.getByRole("button", { name: "Analyze all tracks" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not start the library scan");
  expect(screen.getByRole("button", { name: "Analyze all tracks" })).toBeEnabled();
});
