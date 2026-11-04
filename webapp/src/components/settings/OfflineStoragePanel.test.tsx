import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfflineStoragePanel from "./OfflineStoragePanel";
import { calculateStorageUsage, clearImageCache, purgeOfflineTracks, purgeStaleWebCache } from "../../services/storage/StorageManager";

jest.mock("../../services/storage/StorageManager", () => ({
  calculateStorageUsage: jest.fn(), clearImageCache: jest.fn(), purgeOfflineTracks: jest.fn(), purgeStaleWebCache: jest.fn(),
}));
const inspect = jest.mocked(calculateStorageUsage);
const clear = jest.mocked(clearImageCache);
const purge = jest.mocked(purgeOfflineTracks);
const stale = jest.mocked(purgeStaleWebCache);
beforeEach(() => {
  jest.clearAllMocks();
  inspect.mockResolvedValue({ supported: true, usage: 32 * 1024 ** 3, quota: 64 * 1024 ** 3, offlineTracks: 12, offlineBytes: 1024 ** 3 });
  clear.mockResolvedValue(1); purge.mockResolvedValue(12); stale.mockResolvedValue(2);
});
afterEach(() => jest.restoreAllMocks());

test("shows real quota values and distinguishes track inventory from total origin usage", async () => {
  render(<OfflineStoragePanel />);
  expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "32.0 GB used of 64.0 GB total quota");
  expect(screen.getByText(/12 stored track records/)).toHaveTextContent("1.0 GB");
  expect(screen.getByText(/Verified, explicitly saved audio plays from Downloads/)).toBeInTheDocument();
});
test("clears only artwork and refreshes its estimate immediately", async () => {
  render(<OfflineStoragePanel />);
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Clear Cover Art Cache" }));
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
  expect(clear).toHaveBeenCalledTimes(1);
  expect(purge).not.toHaveBeenCalled();
  expect(stale).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("1 cache buckets removed");
});
test("keeps audio and current shell intact when purging stale cache", async () => {
  render(<OfflineStoragePanel />);
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Purge Stale Web Cache" }));
  await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
  expect(purge).not.toHaveBeenCalled();
  expect(await screen.findByText(/Purge Stale Web Cache complete/)).toBeInTheDocument();
});
test("requires explicit confirmation before deleting audio", async () => {
  render(<OfflineStoragePanel />);
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Remove offline tracks" }));
  expect(purge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep downloads" }));
  expect(purge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove offline tracks" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/12 track records removed/)).toBeInTheDocument();
});
test("disables duplicate actions and shows cleanup errors explicitly", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  let reject: (error: Error) => void = () => {};
  clear.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  render(<OfflineStoragePanel />);
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Clear Cover Art Cache" }));
  expect(screen.getByRole("button", { name: "Purge Stale Web Cache" })).toBeDisabled();
  await act(async () => { reject(new Error("Quota cache access denied")); });
  expect(screen.getByRole("alert")).toHaveTextContent("Quota cache access denied");
  expect(screen.queryByText(/complete\./)).not.toBeInTheDocument();
});
test("does not invent a zero-sized quota when estimates are unsupported", async () => {
  inspect.mockResolvedValue({ supported: false, usage: null, quota: null, offlineTracks: null, offlineBytes: null });
  render(<OfflineStoragePanel />);
  expect(await screen.findByText("Storage usage estimates are unavailable in this browser.")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
