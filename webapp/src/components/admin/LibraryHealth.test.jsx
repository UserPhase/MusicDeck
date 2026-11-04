import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import LibraryHealth from "./LibraryHealth";
import {
  getAdminHealthScan,
  pruneOrphanedTracks,
  rescanLibraryArtwork,
  startAdminHealthScan,
} from "../../api/musicdeck";

jest.mock("../../api/musicdeck", () => ({
  getAdminHealthScan: jest.fn(),
  startAdminHealthScan: jest.fn(),
  rescanLibraryArtwork: jest.fn(),
  pruneOrphanedTracks: jest.fn(),
}));

const summary = {
  albums: 12, tracks: 140, artists: 9, trackRecords: 143, missingArtwork: 2, metadataIssues: 1, duplicates: 0,
  unavailable: 0, incompleteAlbums: 1, syncMismatches: 1, orphanedTracks: 3, danglingReferences: 0,
};

function status(overrides = {}) {
  return {
    id: "health-1", state: "completed", phase: null, processed: 10, total: 10, startedAt: null,
    finishedAt: "2025-01-01T00:00:00.000Z", error: null, warnings: [], staleReason: null,
    report: {
      completedAt: "2025-01-01T00:00:00.000Z", degraded: false, summary, issueTotal: 2, prune: null,
      issues: [
        { type: "missing-artwork", itemType: "album", itemId: "a1", title: "No Cover", detail: "Missing artwork" },
        { type: "orphaned-track", itemType: "track", itemId: "t9", title: "Unknown track", detail: "No longer listed" },
      ],
    },
    ...overrides,
  };
}

afterEach(() => {
  jest.useRealTimers();
});

test("renders the latest report with summary, issues and repair actions", async () => {
  getAdminHealthScan.mockResolvedValue(status());
  render(<LibraryHealth />);

  expect(await screen.findByRole("heading", { name: "Library health check" })).toBeInTheDocument();
  expect(screen.getByText("Orphaned track records").nextSibling).toHaveTextContent("3");
  expect(screen.getByRole("table", { name: "Library issues" })).toHaveTextContent("No Cover");
  expect(screen.getByText("Orphaned record")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Re-scan Artwork" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Prune Orphaned Tracks (3)" })).toBeEnabled();
  expect(startAdminHealthScan).not.toHaveBeenCalled();
});

test("starts a first check automatically and polls progress until it completes", async () => {
  jest.useFakeTimers();
  getAdminHealthScan
    .mockResolvedValueOnce({ ...status(), state: "idle", id: null, report: null })
    .mockResolvedValueOnce(status({ state: "running", phase: "catalog", processed: 5, total: 10, report: null }))
    .mockResolvedValueOnce(status());
  startAdminHealthScan.mockResolvedValue({ started: true, status: status({ state: "running", phase: "listing", processed: 0, total: 0, report: null }) });

  render(<LibraryHealth />);
  await act(async () => {});
  expect(startAdminHealthScan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("progressbar", { name: "Health check progress" })).toHaveAttribute("aria-valuenow", "0");

  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.getByRole("progressbar", { name: "Health check progress" })).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByText(/Checking artwork, metadata and album sync/)).toBeInTheDocument();

  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Library issues" })).toBeInTheDocument();
});

test("keeps polling with a clear warning when the connection drops", async () => {
  jest.useFakeTimers();
  getAdminHealthScan
    .mockResolvedValueOnce(status({ state: "running", phase: "records", processed: 1, total: 4 }))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(status());

  render(<LibraryHealth />);
  await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.getByText(/Can't reach MusicDeck.*continues on the server/)).toBeInTheDocument();

  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(screen.queryByText(/continues on the server/)).not.toBeInTheDocument();
  expect(getAdminHealthScan).toHaveBeenCalledTimes(3);
});

test("re-scan artwork reports that the report needs a fresh check", async () => {
  getAdminHealthScan.mockResolvedValue(status());
  rescanLibraryArtwork.mockResolvedValue({ started: true, status: status({ staleReason: "A media server rescan was requested. Run the health check again once it finishes." }) });
  render(<LibraryHealth />);

  fireEvent.click(await screen.findByRole("button", { name: "Re-scan Artwork" }));
  expect(await screen.findByText(/Media server rescan started/)).toBeInTheDocument();
  expect(screen.getByText(/Run the health check again once it finishes/)).toBeInTheDocument();
});

test("prune needs confirmation, then reports what was removed", async () => {
  jest.useFakeTimers();
  getAdminHealthScan
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(status({
      id: "health-2",
      report: { ...status().report, summary: { ...summary, orphanedTracks: 1 }, prune: { prunedTracks: 2, keptInPlaylists: 1, removedFavorites: 1, removedRatings: 0, skippedReason: null } },
    }));
  pruneOrphanedTracks.mockResolvedValue({ started: true, status: status({ id: "health-2", state: "running", phase: "listing" }) });

  render(<LibraryHealth />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Prune Orphaned Tracks (3)" }));
  expect(pruneOrphanedTracks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Prune Orphaned Tracks (3)" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm prune" })); });
  expect(pruneOrphanedTracks).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.getByText("Removed 2 orphaned track records, plus 1 favorite and 0 ratings that pointed to them. Kept 1 record still used by playlists.")).toBeInTheDocument();
});

test("prune is disabled when the latest check was degraded, and failures are shown", async () => {
  getAdminHealthScan.mockResolvedValue(status({
    warnings: ["Some media servers did not respond. Their records were not checked for orphans."],
    report: { ...status().report, degraded: true },
  }));
  startAdminHealthScan.mockRejectedValue(new Error("Only admins can do that"));
  render(<LibraryHealth />);

  expect(await screen.findByRole("button", { name: "Prune Orphaned Tracks (3)" })).toBeDisabled();
  expect(screen.getByText(/Some media servers did not respond/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run health check" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Only admins can do that"));
});

test("shows a load error instead of an empty dashboard", async () => {
  getAdminHealthScan.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<LibraryHealth />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach MusicDeck. Check your connection and try again.");
});
