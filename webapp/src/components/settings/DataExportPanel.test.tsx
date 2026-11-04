import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DataExportPanel from "./DataExportPanel";
import { downloadUserData, getDataExportSummary } from "../../api/musicdeck";

jest.mock("../../api/musicdeck", () => ({ downloadUserData: jest.fn(), getDataExportSummary: jest.fn() }));
const getSummary = jest.mocked(getDataExportSummary);
const download = jest.mocked(downloadUserData);
const summary = {
  playlists: [{ id: "one", name: "Night Archive", tracks: 15, estimatedBytes: { m3u8: 4096, xspf: 8192 } }],
  counts: { playlists: 1, playlistTracks: 15, history: 50000, favorites: 20, feedback: 3, ratings: 4, settings: 12, smartPlaylists: 2, savedDiscoveries: 5 },
  estimatedBytes: { history: 12_000_000, favorites: 6000, settings: 2000, json: 25_000_000, zip: 5_000_000 },
  notes: ["No audio files are included."],
};
beforeEach(() => { jest.clearAllMocks(); getSummary.mockResolvedValue(summary); });
afterEach(() => jest.restoreAllMocks());

test("shows counts and estimated sizes before downloading; format selectors support individual/all playlists", async () => {
  render(<DataExportPanel />);
  expect(screen.getByRole("status")).toHaveTextContent("Counting");
  expect(await screen.findByText("50,000")).toBeInTheDocument();
  expect(screen.getByText("~11.4 MB")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Playlist" }), { target: { value: "one" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Playlist format" }), { target: { value: "xspf" } });
  fireEvent.click(screen.getByRole("button", { name: "Download playlists" }));
  await waitFor(() => expect(download).toHaveBeenCalledWith("playlists", "xspf", "one"));
  expect(getSummary).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("Download requested");
  fireEvent.change(screen.getByRole("combobox", { name: "Playlist" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Download playlists" }));
  await waitFor(() => expect(download).toHaveBeenLastCalledWith("playlists", "xspf", undefined));
});

test("exports CSV, JSON favorites, account settings and unified JSON/ZIP without buffering Blobs", async () => {
  const blob = jest.spyOn(window, "Blob");
  render(<DataExportPanel />);
  await screen.findByText("50,000");
  for (const [label, kind, format] of [
    ["Download history CSV", "history", "csv"], ["Download favorites JSON", "favorites", "json"],
    ["Or download saved account settings only", "settings", "json"], ["Download full bundle", "bundle", "zip"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(download).toHaveBeenLastCalledWith(kind, format, undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeEnabled());
  }
  fireEvent.change(screen.getByRole("combobox", { name: "Bundle format" }), { target: { value: "json" } });
  fireEvent.click(screen.getByRole("button", { name: "Download full bundle" }));
  await waitFor(() => expect(download).toHaveBeenLastCalledWith("bundle", "json", undefined));
  expect(blob).not.toHaveBeenCalled();
});

test("network failure is explicit and Retry restores counts; failed auth preflight never starts a download", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  getSummary.mockRejectedValueOnce(new Error("Server unreachable"));
  render(<DataExportPanel />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
  fireEvent.click(screen.getByRole("button", { name: "Retry export details" }));
  await screen.findByText("50,000");
  getSummary.mockRejectedValueOnce(new Error("Authentication required"));
  fireEvent.click(screen.getByRole("button", { name: "Download full bundle" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Authentication required");
  expect(download).not.toHaveBeenCalled();
});

test("empty collections disable matching downloads and unmount aborts pending requests", async () => {
  getSummary.mockResolvedValueOnce({ ...summary, playlists: [], counts: { ...summary.counts, playlists: 0, history: 0 } });
  const { unmount } = render(<DataExportPanel />);
  await screen.findByRole("button", { name: "Download full bundle" });
  expect(screen.getByRole("button", { name: "Download playlists" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download history CSV" })).toBeDisabled();
  let resolve: (value: typeof summary) => void = () => {};
  getSummary.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  fireEvent.click(screen.getByRole("button", { name: "Download full bundle" }));
  const signal = getSummary.mock.calls[getSummary.mock.calls.length - 1][0];
  expect(screen.getByRole("button", { name: "Preparing download..." })).toBeDisabled();
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(summary));
  expect(download).not.toHaveBeenCalled();
});

test("a playlist deleted since the estimate is not downloaded", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  render(<DataExportPanel />);
  await screen.findByText("50,000");
  fireEvent.change(screen.getByRole("combobox", { name: "Playlist" }), { target: { value: "one" } });
  getSummary.mockResolvedValueOnce({ ...summary, playlists: [] });
  fireEvent.click(screen.getByRole("button", { name: "Download playlists" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  expect(download).not.toHaveBeenCalled();
});
