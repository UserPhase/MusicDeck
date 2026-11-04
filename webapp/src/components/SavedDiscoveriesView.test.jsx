import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SavedDiscoveriesView from "./SavedDiscoveriesView";
import SaveDiscoveryButton from "./SaveDiscoveryButton";
import { externalActions } from "../services/externalActions";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { usePrivacy } from "../context/PrivacyContext";
import { createAcquisition, getAcquisitions, getSavedDiscoveries, saveDiscovery, removeSavedDiscovery, getAlbum, hydrateExternalPreviews } from "../api/musicdeck";

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: jest.fn() }));
jest.mock("../hooks/useAlbumArtwork", () => ({
  useAlbumArtwork: (item) => ({ url: item.coverUrl || null, onError: () => {} }),
}));
jest.mock("../api/musicdeck", () => ({
  getSavedDiscoveries: jest.fn(), saveDiscovery: jest.fn(), removeSavedDiscovery: jest.fn(),
  createAcquisition: jest.fn(), getAcquisition: jest.fn(), getAcquisitions: jest.fn(),
  getAlbum: jest.fn(), hydrateExternalPreviews: jest.fn(),
}));
const base = {
  id: "saved-1", provider: "deezer", external_id: "7", type: "album", title: "Night Drive", artist: "Neon",
  cover_url: "https://example.test/cover.jpg", metadata: { year: 2024 }, created_at: "2026-10-17T12:00:00Z", status: "IDLE",
};
let user = 0;
beforeEach(() => {
  jest.clearAllMocks();
  externalActions.reset();
  useAuth.mockReturnValue({ session: { id: `saved-view-${++user}` } });
  usePrivacy.mockReturnValue({ canImport: true, canMetadata: true });
  usePlayer.mockReturnValue({ playSong: jest.fn(), playQueue: jest.fn(), togglePlay: jest.fn(), currentSong: null, isPreview: false, isPlaying: false });
  hydrateExternalPreviews.mockResolvedValue([]);
  getSavedDiscoveries.mockResolvedValue({ discoveries: [base], warning: null });
  getAcquisitions.mockResolvedValue([]);
  removeSavedDiscovery.mockResolvedValue(null);
});
afterEach(() => { externalActions.reset(); });
const mount = (element = <SavedDiscoveriesView />) => render(<MemoryRouter>{element}</MemoryRouter>);

test("Listen plays the saved track preview through the global player without importing", async () => {
  getSavedDiscoveries.mockResolvedValue({ discoveries: [{ ...base, type: "track", metadata: { previewUrl: "https://cdns-preview.dzcdn.net/stream/preview.mp3", durationSeconds: 210 } }] });
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Listen to preview: Night Drive" }));
  await waitFor(() => expect(usePlayer().playSong).toHaveBeenCalledWith(expect.objectContaining({
    id: "external_deezer_track_7", previewUrl: "https://cdns-preview.dzcdn.net/stream/preview.mp3", metadataDuration: 210, external: true,
    coverUrl: base.cover_url,
  })));
  expect(hydrateExternalPreviews).not.toHaveBeenCalled();
  expect(createAcquisition).not.toHaveBeenCalled();
  const player = usePlayer();
  usePlayer.mockReturnValue({ ...player, currentSong: player.playSong.mock.calls[0][0], isPreview: true, isPlaying: true });
  view.rerender(<MemoryRouter><SavedDiscoveriesView /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Pause preview: Night Drive" }));
  expect(player.togglePlay).toHaveBeenCalledTimes(1);
  expect(player.playSong).toHaveBeenCalledTimes(1);
});

test("older saves resolve missing previews on demand and report unavailable previews without playing", async () => {
  getSavedDiscoveries.mockResolvedValue({ discoveries: [{ ...base, type: "track" }] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Listen to preview: Night Drive" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Preview unavailable for this track");
  expect(hydrateExternalPreviews).toHaveBeenCalledWith([expect.objectContaining({ id: "external_deezer_track_7", title: "Night Drive", artist: "Neon" })]);
  expect(usePlayer().playSong).not.toHaveBeenCalled();
  hydrateExternalPreviews.mockResolvedValue([{ id: "external_deezer_track_7", previewUrl: "https://example.test/preview.mp3" }]);
  fireEvent.click(screen.getByRole("button", { name: "Listen to preview: Night Drive" }));
  await waitFor(() => expect(usePlayer().playSong).toHaveBeenCalled());
});

test("album listening queues available previews and links to the album tracklist", async () => {
  getAlbum.mockResolvedValue({ song: [
    { id: "external_deezer_track_71", title: "First", artist: "Neon", source: { kind: "external" }, previewUrl: "https://example.test/first.mp3" },
    { id: "external_deezer_track_72", title: "Unavailable", source: { kind: "external" }, previewUrl: null },
  ] });
  mount();
  expect(await screen.findByRole("link", { name: "Open Night Drive" })).toHaveAttribute("href", "/album/external_deezer_album_7");
  fireEvent.click(screen.getByRole("button", { name: "Listen to preview: Night Drive" }));
  await waitFor(() => expect(usePlayer().playQueue).toHaveBeenCalledWith([
    expect.objectContaining({ id: "external_deezer_track_71", previewUrl: "https://example.test/first.mp3" }),
  ], 0));
  expect(getAlbum).toHaveBeenCalledWith("external_deezer_album_7");
  expect(createAcquisition).not.toHaveBeenCalled();
});

test("leaving the page during preview resolution never starts playback later", async () => {
  let finish;
  getAlbum.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Listen to preview: Night Drive" }));
  view.unmount();
  await act(async () => { finish({ song: [{ id: "external_deezer_track_1", previewUrl: "https://example.test/first.mp3" }] }); });
  expect(usePlayer().playQueue).not.toHaveBeenCalled();
});

test("Select all includes saved items beyond the visible page but skips active imports and can be cleared", async () => {
  const discoveries = Array.from({ length: 42 }, (_, index) => ({ ...base, id: `saved-${index}`, external_id: String(index), title: `Album ${index}` }));
  discoveries[0].status = "IMPORTING";
  getSavedDiscoveries.mockResolvedValue({ discoveries });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
  expect(screen.getByRole("button", { name: "Import Selected (41)" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: "Select Album 0" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select Album 0" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(screen.getByRole("button", { name: "Import Selected" })).toBeDisabled();
});

test("privacy permissions keep previews separate from imports", async () => {
  usePrivacy.mockReturnValue({ canImport: false, canMetadata: false });
  mount();
  expect(await screen.findByRole("button", { name: "Listen to preview: Night Drive" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Select all" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Import to Library" })).not.toBeInTheDocument();
  expect(getAlbum).not.toHaveBeenCalled();
});

test("saved shelf imports only selected items through the existing coordinated acquisition lifecycle", async () => {
  getSavedDiscoveries.mockResolvedValue({ discoveries: [base, { ...base, id: "saved-2", external_id: "8", title: "Daylight", type: "track" }] });
  createAcquisition.mockResolvedValue({ job: { id: "job-1", status: "queued" } });
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Night Drive" }));
  fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));
  await waitFor(() => expect(createAcquisition).toHaveBeenCalledTimes(1));
  expect(createAcquisition).toHaveBeenCalledWith(expect.objectContaining({
    albumId: "external_deezer_album_7", sourceProvider: "spotdl",
    result: expect.objectContaining({ type: "album", title: "Night Drive", provider: "deezer" }),
  }));
  expect(await screen.findByRole("button", { name: "Queued" })).toBeDisabled();
  expect(removeSavedDiscovery).not.toHaveBeenCalled();
});

test("failed import gives feedback and retains the selected bookmark for retry", async () => {
  createAcquisition.mockRejectedValue(new TypeError("Failed to fetch"));
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Night Drive" }));
  fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  expect(screen.getByRole("checkbox", { name: "Select Night Drive" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Retry import" })).toBeEnabled();
});

test("leaving the saved shelf stops the remainder of a bulk import submission", async () => {
  let finish;
  getSavedDiscoveries.mockResolvedValue({
    discoveries: [base, { ...base, id: "saved-2", external_id: "8", title: "Daylight" }],
  });
  createAcquisition.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Night Drive" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Daylight" }));
  fireEvent.click(screen.getByRole("button", { name: "Import Selected (2)" }));
  await waitFor(() => expect(createAcquisition).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { finish({ job: { id: "job-1", status: "completed" } }); });
  expect(createAcquisition).toHaveBeenCalledTimes(1);
});

test("completed imports disappear on refresh without a cleanup preference", async () => {
  mount();
  await screen.findByText("Night Drive");
  expect(screen.queryByRole("checkbox", { name: /Automatically remove/ })).not.toBeInTheDocument();
  expect(screen.getByText("Imported items are removed from this list automatically.")).toBeInTheDocument();
  getSavedDiscoveries.mockResolvedValue({ discoveries: [] });
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(await screen.findByText("A place for your next favorites.")).toBeInTheDocument();
});

test("offline refresh failures retain cached cards with a retry affordance", async () => {
  mount();
  await screen.findByText("Night Drive");
  getSavedDiscoveries.mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  expect(screen.getByText("Night Drive")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

test("unknown library status never earns an in-library badge or auto-pruning", async () => {
  getSavedDiscoveries.mockResolvedValue({
    discoveries: [{ ...base, status: "UNKNOWN", inLibrary: false }],
    warning: "Library status could not be checked.",
  });
  mount();
  await screen.findByText("Night Drive");
  expect(screen.getByRole("status")).toHaveTextContent("Library status could not be checked");
  expect(screen.queryByRole("button", { name: "In Library" })).not.toBeInTheDocument();
  expect(removeSavedDiscovery).not.toHaveBeenCalled();
});

test("failed removal retains the discovery and offers another attempt", async () => {
  removeSavedDiscovery.mockRejectedValue(new TypeError("Failed to fetch"));
  mount();
  await screen.findByText("Night Drive");
  fireEvent.click(screen.getByRole("button", { name: "Remove from Saved: Night Drive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach MusicDeck");
  expect(screen.getByText("Night Drive")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove from Saved: Night Drive" })).toBeEnabled());
  expect(removeSavedDiscovery).toHaveBeenCalledTimes(1);
});

test("bookmark toggle stores metadata only and shares its state across matching cards", async () => {
  getSavedDiscoveries.mockResolvedValue({ discoveries: [] });
  saveDiscovery.mockResolvedValue({ discovery: base });
  const album = { id: "external_deezer_album_7", title: "Night Drive", artist: "Neon", provider: "deezer" };
  mount(<><SaveDiscoveryButton kind="album" item={album} /><SaveDiscoveryButton kind="album" item={album} /></>);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Save for later: Night Drive" })[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole("button", { name: "Save for later: Night Drive" })[0]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove from Saved: Night Drive" })).toHaveLength(2));
  expect(saveDiscovery).toHaveBeenCalledWith(expect.objectContaining({ provider: "deezer", external_id: "7", type: "album" }));
  expect(createAcquisition).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Remove from Saved: Night Drive" })[1]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Save for later: Night Drive" })).toHaveLength(2));
});
