import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DownloadsView from "./DownloadsView";
import { offlineDownloadEngine as engine, storageBoundary } from "../services/storage/OfflineDownloadEngine";
import { autoDownloadPolicies } from "../services/storage/AutoDownloadPolicyManager";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { getAcquisitions } from "../api/musicdeck";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylists: async () => [{ id: "p", name: "Road trip" }] }));
jest.mock("../api/musicdeck", () => ({ getAcquisitions: jest.fn() }));
jest.mock("../components/TrackRow", () => ({ __esModule: true, default: ({ song, onPlay, action }: any) => <div><button onClick={onPlay}>Play {song.title}</button>{action}</div> }));
jest.mock("../services/storage/OfflineDownloadEngine", () => ({
  messageOf: (error: Error) => error.message, storageBoundary: jest.fn(),
  offlineDownloadEngine: { subscribe: () => () => {}, getSnapshot: jest.fn(), readVerifiedTrack: jest.fn(), verifyIntegrity: jest.fn(), purgeDownloadedTrack: jest.fn() },
}));
jest.mock("../services/storage/AutoDownloadPolicyManager", () => ({
  AUTO_POLICIES_CHANGED: "policies", autoDownloadPolicies: { list: async () => [], allowsUnknownNetwork: async () => false, setPolicy: jest.fn(), setAllowUnknownNetwork: jest.fn() },
}));
const track = { key: "a", owner: "alice", track_id: "one", track: { id: "one", title: "Saved song" }, file_size: 100, checksum: "hash", status: "verified", quality: "320kbps" };
const playContext = jest.fn();
function mount() { return render(<MemoryRouter><DownloadsView /></MemoryRouter>); }
beforeEach(() => {
  jest.clearAllMocks();
  (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: false });
  (usePlayer as jest.Mock).mockReturnValue({ playContext });
  (engine.getSnapshot as jest.Mock).mockReturnValue({ tracks: [track], jobs: [], collections: [{ key: "p", kind: "playlist", name: "Road trip", trackIds: ["one", "two"] }], error: null });
  (engine.readVerifiedTrack as jest.Mock).mockResolvedValue(track);
  (storageBoundary as jest.Mock).mockResolvedValue({ mode: "web", usage: 100, quota: 1000, persistent: false });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
});
afterEach(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });

test("opens verified downloads offline without treating the local account as authenticated", async () => {
  mount();
  const play = await screen.findByRole("button", { name: "Play downloads" });
  await waitFor(() => expect(play).toBeEnabled()); fireEvent.click(play);
  await waitFor(() => expect(playContext).toHaveBeenCalledWith([expect.objectContaining({ id: "one", offlineOnly: true })], 0, expect.objectContaining({ type: "downloads" })));
  expect(screen.getByText(/Local Downloads mode/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  expect(getAcquisitions).not.toHaveBeenCalled();
});

test("shows server download progress and refreshes until the job completes", async () => {
  jest.useFakeTimers();
  try {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: true, session: { id: "alice" } });
    const job = { id: "job", requestedTitle: "Server song", progress: { percent: 42 } };
    (getAcquisitions as jest.Mock).mockResolvedValueOnce([{ ...job, status: "downloading" }])
      .mockResolvedValue([{ ...job, status: "completed" }]);
    const view = mount();
    expect(await screen.findByRole("progressbar", { name: "Server song download progress" })).toHaveAttribute("value", "42");
    expect(getAcquisitions).toHaveBeenCalledWith({ ownOnly: true, signal: expect.any(AbortSignal) });
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Server song download progress" })).not.toBeInTheDocument();
    view.unmount();
  } finally {
    jest.useRealTimers();
  }
});
test("does not make an unreadable manifest entry playable", async () => {
  (engine.readVerifiedTrack as jest.Mock).mockResolvedValue(null);
  mount();
  await screen.findByText("Take your music with you");
  expect(screen.getByRole("button", { name: "Play downloads" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Play Saved song" })).not.toBeInTheDocument();
});
test("keeps partial saved playlist membership visible without a server request", async () => {
  mount(); await screen.findByRole("button", { name: "Play Saved song" });
  fireEvent.click(screen.getByRole("button", { name: "Playlists" }));
  expect(screen.getByText("Road trip")).toBeInTheDocument();
  expect(screen.getByText(/1 \/ 2 tracks verified/)).toHaveTextContent("Partially downloaded");
});
test("saves the Favorites rule and reports integrity diagnostic results", async () => {
  (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: true });
  (engine.verifyIntegrity as jest.Mock).mockResolvedValue({ verified: 1, damaged: 2 });
  mount(); await screen.findByRole("button", { name: "Play Saved song" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Auto-download Favorites" }));
  await waitFor(() => expect(autoDownloadPolicies.setPolicy).toHaveBeenCalledWith({ kind: "favorites", id: "favorites", name: "Favorites", enabled: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Verify Offline Files Integrity" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Verify Offline Files Integrity" }));
  expect(await screen.findByText("1 files verified. 2 files need downloading again.")).toBeInTheDocument();
});
