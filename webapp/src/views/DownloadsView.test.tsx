import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DownloadsView from "./DownloadsView";
import { offlineDownloadEngine as engine, storageBoundary } from "../services/storage/OfflineDownloadEngine";
import { autoDownloadPolicies } from "../services/storage/AutoDownloadPolicyManager";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { cancelAcquisition, getAcquisitions, retryAcquisition } from "../api/musicdeck";
import { useMediaQuery } from "../hooks/useMediaQuery";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylists: async () => [{ id: "p", name: "Road trip" }] }));
jest.mock("../api/musicdeck", () => ({ cancelAcquisition: jest.fn(), getAcquisitions: jest.fn(), retryAcquisition: jest.fn() }));
jest.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: jest.fn(() => false) }));
jest.mock("../components/TrackRow", () => ({ __esModule: true, default: ({ song, onPlay, action, menuAction }: any) =>
  <div><button onClick={onPlay}>Play {song.title}</button>{action}
    {menuAction && <div data-testid="track-actions">{menuAction(jest.fn())}</div>}</div> }));
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

test("shows server download progress and treats a partial result as settled", async () => {
  jest.useFakeTimers();
  try {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: true, session: { id: "alice" } });
    const job = { id: "job", requestedTitle: "Server song", progress: { percent: 42 } };
    (getAcquisitions as jest.Mock).mockResolvedValueOnce([{ ...job, status: "downloading" }])
      .mockResolvedValue([{ ...job, status: "partial", errorMessage: "Imported 1 of 2 tracks" }]);
    const view = mount();
    expect(await screen.findByRole("progressbar", { name: "Server song download progress" })).toHaveAttribute("value", "42");
    expect(getAcquisitions).toHaveBeenCalledWith({ ownOnly: true, signal: expect.any(AbortSignal) });
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(screen.getByText("Partially imported")).toBeInTheDocument();
    expect(screen.getByText("0 active")).toBeInTheDocument();
    expect(screen.getByText("Imported 1 of 2 tracks")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Server song download progress" })).not.toBeInTheDocument();
    view.unmount();
  } finally {
    jest.useRealTimers();
  }
});

test("retries a partial server download and can cancel it during the cooldown", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: true, session: { id: "alice" } });
  const job = { id: "job", requestedTitle: "Server album" };
  const waiting = { ...job, status: "downloading", stage: "provider_cooldown" };
  const cancelled = { ...job, status: "cancelled" };
  (getAcquisitions as jest.Mock).mockResolvedValueOnce([{
    ...job, status: "partial", trackErrors: [{ position: 2, title: "Missing song", message: "The provider timed out." }],
  }]).mockResolvedValueOnce([waiting]).mockResolvedValue([cancelled]);
  (retryAcquisition as jest.Mock).mockResolvedValueOnce({ job: waiting });
  (cancelAcquisition as jest.Mock).mockResolvedValueOnce({ job: cancelled });
  mount();

  const retry = await screen.findByRole("button", { name: "Retry download for Server album" });
  fireEvent.click(screen.getByText("Track errors (1)"));
  expect(screen.getByText(/Missing song .* The provider timed out/)).toBeInTheDocument();
  fireEvent.click(retry);
  expect(retryAcquisition).toHaveBeenCalledWith("job");
  expect(await screen.findByText("Waiting for the source provider cooldown")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel download for Server album" }));
  expect(cancelAcquisition).toHaveBeenCalledWith("job");
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();
});
test("does not make an unreadable manifest entry playable", async () => {
  (engine.readVerifiedTrack as jest.Mock).mockResolvedValue(null);
  mount();
  await screen.findByText("Take your music with you");
  expect(screen.getByRole("button", { name: "Play downloads" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Play Saved song" })).not.toBeInTheDocument();
});
test("mobile downloads remove a verified track through its track actions and confirmation", async () => {
  (useMediaQuery as jest.Mock).mockReturnValue(true);
  try {
    mount();
    await screen.findByRole("button", { name: "Play Saved song" });
    expect(screen.getByRole("table", { name: "Verified offline tracks" })).toHaveClass("track-list--mobile");
    const remove = screen.getByRole("menuitem", { name: "Remove download" });
    expect(screen.getByTestId("track-actions")).toContainElement(remove);
    fireEvent.click(remove);
    expect(engine.purgeDownloadedTrack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove download" }));
    expect(engine.purgeDownloadedTrack).toHaveBeenCalledWith("one");
    await screen.findByText("Offline audio removed.");
  } finally {
    (useMediaQuery as jest.Mock).mockReturnValue(false);
  }
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
