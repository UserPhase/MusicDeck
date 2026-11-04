import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoudnessScanControl from "./LoudnessScanControl";
import { getLoudnessScan, startLoudnessScan } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({ getLoudnessScan: jest.fn(), startLoudnessScan: jest.fn() }));
const running = { id: "scan", status: "running", totalTracks: 12, completedTracks: 3, skippedTracks: 1, failedTracks: 0, currentTrack: "Artist — Song" };
beforeEach(() => { jest.clearAllMocks(); getLoudnessScan.mockResolvedValue(null); });

test("keeps tracking an existing scan when normalization is disabled without allowing another start", async () => {
  jest.useFakeTimers();
  try {
    getLoudnessScan.mockResolvedValue(running);
    render(<LoudnessScanControl disabled />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Scanning..." })).toBeDisabled();
    expect(screen.getByText(/Normalization is off for your account/)).toBeInTheDocument();
    getLoudnessScan.mockResolvedValue({ ...running, status: "completed", completedTracks: 12 });
    await act(async () => jest.advanceTimersByTime(2000));
    const button = screen.getByRole("button", { name: "Scan all tracks" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(startLoudnessScan).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Scan complete: 12 of 12 tracks");
  } finally { jest.useRealTimers(); }
});

test("starts a background scan, disables duplicate starts and polls to completion", async () => {
  jest.useFakeTimers();
  try {
    startLoudnessScan.mockResolvedValue(running);
    render(<LoudnessScanControl />);
    await act(async () => {});
    getLoudnessScan.mockResolvedValue(running);
    fireEvent.click(screen.getByRole("button", { name: "Scan all tracks" }));
    await act(async () => {});
    expect(startLoudnessScan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Scanning..." })).toBeDisabled();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "3");
    expect(screen.getByText("Artist — Song")).toBeInTheDocument();
    getLoudnessScan.mockResolvedValue({ ...running, status: "completed", completedTracks: 11, failedTracks: 1 });
    await act(async () => jest.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Scan all tracks" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("11 of 12 tracks · 1 failed");
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "12");
  } finally { jest.useRealTimers(); }
});

test("reconnects to a scan after leaving Settings and reports start failures", async () => {
  getLoudnessScan.mockResolvedValue(running);
  const view = render(<LoudnessScanControl />);
  expect(await screen.findByRole("button", { name: "Scanning..." })).toBeDisabled();
  view.unmount();
  getLoudnessScan.mockResolvedValue(null);
  startLoudnessScan.mockRejectedValue(new Error("offline"));
  render(<LoudnessScanControl />);
  fireEvent.click(screen.getByRole("button", { name: "Scan all tracks" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not start"));
});
