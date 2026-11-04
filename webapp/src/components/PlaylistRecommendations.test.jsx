import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import PlaylistRecommendations from "./PlaylistRecommendations";
import { editPlaylistTracks, getPlaylistRecommendations } from "../api/playlists";
import { canStreamPreview, findItunesPreview } from "../utils/previewPlayback";
import { externalDiscoveryService } from "../services/externalDiscovery";

const mockPlay = jest.fn();
const mockStart = jest.fn();
const mockUnlock = jest.fn(async () => {});
let mockPolicy;
let mockSession;
const mockIdle = { state: "IDLE", message: null, progress: null, connectionLost: false };
jest.mock("../api/playlists", () => ({ getPlaylistRecommendations: jest.fn(), editPlaylistTracks: jest.fn(), getPlaylists: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({ playSong: mockPlay, audioEngine: { unlock: mockUnlock } }) }));
jest.mock("../utils/previewPlayback", () => ({ canStreamPreview: jest.fn(), findItunesPreview: jest.fn() }));
jest.mock("../services/externalDiscovery", () => ({ externalDiscoveryService: { hydrateMissingPreviews: jest.fn() } }));
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: mockSession }) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => mockPolicy }));
jest.mock("../services/externalActions", () => ({ useExternalAction: () => ({ snapshot: mockIdle, start: mockStart }) }));
jest.mock("./TrackDownloadButton", () => () => null);
jest.mock("./SaveDiscoveryButton", () => () => null);
jest.mock("./DiscoveryCards", () => ({ DiscoveryArtwork: () => <span data-testid="cover" /> }));
jest.mock("../services/storage/OfflineAuditor", () => ({
  useOfflineAudit: () => ({ status: "missing" }), offlineDisplayStatus: () => "not-downloaded",
  offlineAuditor: { recordDownloaded: jest.fn() },
}));
jest.mock("../utils/downloadManager", () => ({
  readOfflineTrack: async () => null, isDeviceDownloadPending: () => false, subscribeDeviceDownload: () => () => {},
}));
const seed = { id: "seed", title: "In Playlist", artist: "Artist", isDownloaded: true };
const owned = { id: "owned", title: "Owned Song", artistName: "Artist", albumName: "Owned Album", durationSeconds: 180,
  availability: { libraryAvailable: true, state: "available" } };
const missing = { id: "external_deezer_track_1", type: "track", title: "New Song", artist: "Other Artist", album: "New Album",
  provider: "deezer", external: true, source: { kind: "external", count: 0 }, previewUrl: "https://cdns-preview-a.dzcdn.net/test.mp3" };
beforeEach(() => {
  jest.clearAllMocks();
  canStreamPreview.mockResolvedValue(true);
  findItunesPreview.mockResolvedValue(null);
  externalDiscoveryService.hydrateMissingPreviews.mockResolvedValue([]);
  mockPolicy = { canMetadata: true, canImport: true, canArtwork: true };
  mockSession = { id: "listener", role: "admin" };
  getPlaylistRecommendations.mockImplementation(async (_id, source) => ({
    items: source === "library" ? [owned, seed] : [missing, { ...missing, id: "duplicate" }], canModify: true,
  }));
});
function view(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>
    <PlaylistRecommendations playlistId="mix" songs={[seed]} onPlaylistChange={jest.fn()} {...props} />
  </MemoryRouter></QueryClientProvider>);
}

test("local songs render before external lookup finishes, with covers, Add and Import actions", async () => {
  let resolve;
  getPlaylistRecommendations.mockImplementation((_id, source) => source === "library"
    ? Promise.resolve({ items: [owned, seed], canModify: true }) : new Promise((done) => { resolve = done; }));
  view();
  expect(await screen.findByRole("button", { name: "Add Owned Song to playlist" })).toBeEnabled();
  expect(screen.queryByText("New Song")).not.toBeInTheDocument();
  await act(async () => resolve({ items: [missing, { ...missing, id: "duplicate" }], canModify: true }));
  expect(await screen.findByRole("button", { name: "Import New Song" })).toBeEnabled();
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.getAllByTestId("cover")).toHaveLength(2);
  expect(screen.queryByText("In Playlist")).not.toBeInTheDocument();
  expect(screen.getByText("Owned Album")).toBeInTheDocument();
  expect(mockStart).not.toHaveBeenCalled();
});

test("Add serializes a local playlist edit and returns the updated playlist", async () => {
  let resolve;
  editPlaylistTracks.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const onPlaylistChange = jest.fn();
  view({ onPlaylistChange });
  const add = await screen.findByRole("button", { name: "Add Owned Song to playlist" });
  fireEvent.click(add); fireEvent.click(add);
  expect(editPlaylistTracks).toHaveBeenCalledTimes(1);
  expect(editPlaylistTracks).toHaveBeenCalledWith("mix", { action: "add", trackIds: ["owned"] });
  expect(add).toBeDisabled();
  const updated = { id: "mix", entry: [seed, owned] };
  await act(async () => resolve(updated));
  expect(onPlaylistChange).toHaveBeenCalledWith(updated);
});

test("missing songs preview through the global player and import only after an explicit click", async () => {
  view();
  await screen.findByRole("button", { name: "Import New Song" });
  fireEvent.click(screen.getByRole("button", { name: "Play preview of New Song" }));
  await waitFor(() => expect(mockPlay).toHaveBeenCalledWith(expect.objectContaining({ id: missing.id, previewUrl: missing.previewUrl, external: true })));
  expect(mockStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import New Song" }));
  expect(mockStart).toHaveBeenCalledTimes(1);
});

test("a stale recommendation preview falls back to a playable preview", async () => {
  const fallback = "https://audio-ssl.itunes.apple.com/fallback.m4a";
  canStreamPreview.mockImplementation(async url => url === fallback);
  findItunesPreview.mockResolvedValue(fallback);
  view();
  fireEvent.click(await screen.findByRole("button", { name: "Play preview of New Song" }));
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mockPlay).toHaveBeenCalledWith(expect.objectContaining({ id: missing.id, previewUrl: fallback })));
  expect(mockStart).not.toHaveBeenCalled();
});

test("privacy restrictions keep local recommendations and suppress external lookups", async () => {
  mockPolicy = { canMetadata: false, canImport: false, canArtwork: false };
  view();
  expect(await screen.findByRole("button", { name: "Add Owned Song to playlist" })).toBeEnabled();
  expect(getPlaylistRecommendations.mock.calls.map((call) => call[1])).toEqual(["library"]);
  expect(screen.queryByRole("button", { name: "Import New Song" })).not.toBeInTheDocument();
});

test("download permission is respected and refreshing reveals more candidates", async () => {
  mockSession = { id: "listener", role: "user", externalSearchEnabled: true, externalPlaybackEnabled: false };
  getPlaylistRecommendations.mockImplementation(async (_id, source) => ({ canModify: true,
    items: source === "external" ? [missing] : Array.from({ length: 10 }, (_, index) => ({ ...owned, id: `owned-${index}`, title: `Owned ${index}` })),
  }));
  view();
  expect(await screen.findByRole("button", { name: "Import New Song" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  expect(screen.queryByText("Owned 9")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText("Owned 9")).toBeInTheDocument();
});

test("failed Add leaves the recommendation available for retry", async () => {
  editPlaylistTracks.mockRejectedValue(new Error("Playlist unavailable"));
  const onPlaylistChange = jest.fn();
  view({ onPlaylistChange });
  fireEvent.click(await screen.findByRole("button", { name: "Add Owned Song to playlist" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Playlist unavailable");
  expect(screen.getByRole("button", { name: "Add Owned Song to playlist" })).toBeEnabled();
  expect(onPlaylistChange).not.toHaveBeenCalled();
});

test("external lookup failures preserve the local suggestions and offer a retry", async () => {
  getPlaylistRecommendations.mockImplementation(async (_id, source) => {
    if (source === "external") throw new Error("Discovery unavailable");
    return { items: [owned], canModify: true };
  });
  view();
  expect(await screen.findByRole("button", { name: "Add Owned Song to playlist" })).toBeEnabled();
  expect(await screen.findByRole("button", { name: "Retry recommendations" }, { timeout: 5000 })).toBeInTheDocument();
  getPlaylistRecommendations.mockImplementation(async (_id, source) => ({
    items: source === "external" ? [missing] : [owned], canModify: true,
  }));
  fireEvent.click(screen.getByRole("button", { name: "Retry recommendations" }));
  expect(await screen.findByRole("button", { name: "Import New Song" })).toBeEnabled();
});
