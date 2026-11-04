import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NewReleasesView, { NewReleasesShelf } from "./NewReleasesView";
import { getReleaseFeed, scanReleases, unfollowArtist } from "../api/artistFollows";
import { request } from "../api/musicdeck";
let mockOwner = "alice", mockCanMetadata = true, mockCanImport = true;
const mockPlay = jest.fn(), mockImport = jest.fn(), mockSave = jest.fn(), mockRemove = jest.fn();
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => ({ canMetadata: mockCanMetadata, canImport: mockCanImport, canArtwork: true }) }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({ playSong: mockPlay }) }));
jest.mock("../api/artistFollows", () => ({ getReleaseFeed: jest.fn(), scanReleases: jest.fn(), unfollowArtist: jest.fn(), followsChanged: jest.fn() }));
jest.mock("../api/musicdeck", () => ({ request: jest.fn() }));
jest.mock("../services/externalActions", () => ({ useExternalAction: () => ({ snapshot: { state: "IDLE" }, start: mockImport }) }));
jest.mock("../hooks/useSavedDiscoveries", () => ({ useSavedDiscoveries: () => ({ enabled: true, items: [], save: mockSave, remove: mockRemove }),
  discoveryInput: (_kind: string, item: any) => ({ provider: item.provider, external_id: item.providerId, type: "album", title: item.title, artist: item.artist }) }));
const release = { id: "external_itunes_album_101", provider: "itunes", providerId: "101", title: "New Horizons", artist: "Night Pilot",
  artistId: "external_itunes_artist_17", releaseDate: "2026-11-01", albumType: "EP", coverUrl: "/api/artwork/external/cover", storeUrl: "https://music.apple.com/us/album/101", trackCount: 5 };
const artist = { key: "key-one", artistId: release.artistId, artistName: release.artist, provider: "itunes", followedAt: "2026-11-01", checkedAt: null, nextScanAt: "2026-11-02", error: null };
const feed = { releases: [release], artists: [artist], hasMore: false };
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = "alice"; mockCanMetadata = true; mockCanImport = true;
  (getReleaseFeed as jest.Mock).mockResolvedValue(feed); (scanReleases as jest.Mock).mockResolvedValue({ taskId: "task" });
  (unfollowArtist as jest.Mock).mockResolvedValue(null); mockSave.mockResolvedValue(true); mockImport.mockResolvedValue({ state: "QUEUED" });
  (request as jest.Mock).mockResolvedValue({ tracks: [{ id: "external_itunes_track_2", title: "Dawn", artist: "Night Pilot", previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a", source: { kind: "external" } }] });
});
const show = () => render(<MemoryRouter><NewReleasesView /></MemoryRouter>);

test("renders release dates, types and store attribution without importing or playing on load", async () => {
  show(); await screen.findByRole("article", { name: "New Horizons by Night Pilot" });
  expect(screen.getByText("EP")).toBeInTheDocument(); expect(screen.getByRole("link", { name: /Listen on Apple Music/ })).toHaveAttribute("href", release.storeUrl);
  expect(mockImport).not.toHaveBeenCalled(); expect(mockPlay).not.toHaveBeenCalled(); expect(scanReleases).not.toHaveBeenCalled();
  expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-11-01");
});
test("loads track previews only on demand and plays the selected sample", async () => {
  show(); fireEvent.click(await screen.findByRole("button", { name: "Preview tracks" }));
  fireEvent.click(await screen.findByRole("button", { name: /Dawn/ }));
  expect(request).toHaveBeenCalledWith("/api/albums/external_itunes_album_101/tracks", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(mockPlay).toHaveBeenCalledWith(expect.objectContaining({ title: "Dawn", external: true }));
  fireEvent.click(screen.getByRole("button", { name: "Close tracks" })); fireEvent.click(screen.getByRole("button", { name: "Preview tracks" }));
  expect(request).toHaveBeenCalledTimes(1);
});
test("wishlist and import remain independent explicit actions", async () => {
  show(); fireEvent.click(await screen.findByRole("button", { name: "Save to wishlist" }));
  await waitFor(() => expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ provider: "itunes", external_id: "101", type: "album" })));
  expect(mockImport).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Import via spotDL" })); expect(mockImport).toHaveBeenCalledTimes(1);
});
test("manual release checks are absent and a failed unfollow retains the feed", async () => {
  show(); await screen.findByRole("article");
  expect(screen.queryByRole("button", { name: "Check releases" })).not.toBeInTheDocument();
  (unfollowArtist as jest.Mock).mockRejectedValueOnce(new Error("Connection interrupted"));
  fireEvent.click(screen.getByRole("button", { name: "Unfollow Night Pilot" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted"));
  expect(screen.getByRole("article", { name: "New Horizons by Night Pilot" })).toBeInTheDocument();
  expect(unfollowArtist).toHaveBeenCalledWith("alice", artist.key, expect.any(AbortSignal));
});
test("privacy policy disables metadata and import actions while keeping cached cards readable", async () => {
  mockCanMetadata = false; mockCanImport = false; show();
  expect(await screen.findByRole("button", { name: "Preview tracks" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Import via spotDL" })).toBeDisabled(); expect(screen.getByText(/cached feed remains/)).toBeInTheDocument();
});
test("account switches abort old feed requests and discard their results", async () => {
  let resolve!: (value: unknown) => void;
  (getReleaseFeed as jest.Mock).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = show(); const oldSignal = (getReleaseFeed as jest.Mock).mock.calls[0][2]; mockOwner = "bob";
  (getReleaseFeed as jest.Mock).mockResolvedValue({ releases: [], artists: [], hasMore: false });
  view.rerender(<MemoryRouter><NewReleasesView /></MemoryRouter>);
  await act(async () => { resolve(feed); });
  expect(oldSignal.aborted).toBe(true); expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
test("pagination requests a bounded second page and shelf links to the dedicated feed", async () => {
  (getReleaseFeed as jest.Mock).mockResolvedValue({ ...feed, hasMore: true }); const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  await waitFor(() => expect(getReleaseFeed).toHaveBeenCalledWith(30, 30, expect.any(AbortSignal)));
  view.unmount(); render(<MemoryRouter><NewReleasesShelf /></MemoryRouter>);
  const shelf = await screen.findByRole("region", { name: "New Releases from Artists You Follow" });
  expect(within(shelf).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/new-releases");
  await waitFor(() => expect(getReleaseFeed).toHaveBeenCalledWith(0, 6, expect.any(AbortSignal)));
});
test("keeps the Home shelf hidden while loading and when the feed is empty", async () => {
  let resolve!: (value: unknown) => void;
  (getReleaseFeed as jest.Mock).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<MemoryRouter><NewReleasesShelf /></MemoryRouter>);
  const region = { name: "New Releases from Artists You Follow" };
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument();
  await act(async () => { resolve({ ...feed, releases: [] }); });
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument();
});
test("metadata errors allow retrying previews and do not start an import", async () => {
  (request as jest.Mock).mockRejectedValueOnce(new Error("Provider temporarily unavailable"));
  show(); fireEvent.click(await screen.findByRole("button", { name: "Preview tracks" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Provider temporarily unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Preview tracks" })); expect(await screen.findByRole("button", { name: /Dawn/ })).toBeEnabled();
  expect(mockImport).not.toHaveBeenCalled();
});
