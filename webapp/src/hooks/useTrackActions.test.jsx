import { act, renderHook } from "@testing-library/react";
import { useTrackActions } from "./useTrackActions";
import { createPlaylist, editPlaylistTracks, getPlaylists } from "../api/playlists";
import { getUserSettings, sendRecommendationFeedback, updateUserSettings } from "../api/musicdeck";
import { downloadToDevice } from "../utils/downloadManager";
import { externalActions } from "../services/externalActions";
import { offlineAuditor } from "../services/storage/OfflineAuditor";
import { offlineDownloadEngine } from "../services/storage/OfflineDownloadEngine";

let mockOwner = "one", mockImport = true;
const mockPlayer = { queueTracks: jest.fn(), playTracksNext: jest.fn(), setTrackFavorite: jest.fn(), likedSongIds: new Set(), downloadQuality: "320kbps" };
const mockSave = jest.fn();
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => mockPlayer }));
jest.mock("../context/AuthContext", () => ({ useAuth: () => ({ session: { id: mockOwner } }) }));
jest.mock("../context/PrivacyContext", () => ({ usePrivacy: () => ({ canImport: mockImport }) }));
jest.mock("../api/playlists", () => ({ editPlaylistTracks: jest.fn(), createPlaylist: jest.fn(), getPlaylists: jest.fn() }));
jest.mock("../api/musicdeck", () => ({ getUserSettings: jest.fn(), updateUserSettings: jest.fn(), sendRecommendationFeedback: jest.fn() }));
jest.mock("../utils/downloadManager", () => ({ downloadToDevice: jest.fn() }));
jest.mock("../services/storage/OfflineAuditor", () => ({ offlineAuditor: { recordDownloaded: jest.fn() } }));
jest.mock("../services/storage/OfflineDownloadEngine", () => ({ offlineDownloadEngine: { getOwner: jest.fn(() => null), enqueueDownloads: jest.fn() } }));
jest.mock("../services/externalActions", () => ({ externalActions: { importExternalTrack: jest.fn() } }));
jest.mock("./useSavedDiscoveries", () => ({ useSavedDiscoveries: () => ({ save: mockSave }),
  discoveryInput: (_kind, item) => ({ provider: "deezer", external_id: item.id, title: item.title }) }));
const a = { id: "a", title: "A", artist: "Artist", album: "Album", duration: 180, source: { kind: "library" } };
const b = { ...a, id: "b", title: "B" };
const external = { ...a, id: "external_deezer_track_1", source: { kind: "external" }, external: true, provider: "deezer" };
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = "one"; mockImport = true; mockPlayer.likedSongIds = new Set();
  mockPlayer.setTrackFavorite.mockResolvedValue(undefined); editPlaylistTracks.mockResolvedValue({ id: "destination" });
  offlineAuditor.recordDownloaded.mockResolvedValue({ status: "verified" }); downloadToDevice.mockResolvedValue({});
  externalActions.importExternalTrack.mockResolvedValue({ state: "QUEUED" }); mockSave.mockResolvedValue(true);
  getUserSettings.mockResolvedValue([]); createPlaylist.mockResolvedValue({ id: "later" }); updateUserSettings.mockResolvedValue([]); getPlaylists.mockResolvedValue([]);
  offlineDownloadEngine.getOwner.mockReturnValue(null); offlineDownloadEngine.enqueueDownloads.mockResolvedValue(undefined);
});
test("single and batch queue actions preserve order and intentional playlist occurrences", async () => {
  const { result } = renderHook(() => useTrackActions([a, b, a]));
  await act(async () => { await result.current.playNext(); await result.current.addToQueue(); });
  expect(mockPlayer.playTracksNext).toHaveBeenCalledWith([a, b, a]);
  expect(mockPlayer.queueTracks).toHaveBeenCalledWith([a, b, a]);
});
test("playlist mutations deduplicate song IDs and use the existing atomic batch endpoint", async () => {
  const { result } = renderHook(() => useTrackActions([a, b, a]));
  await act(async () => { await result.current.addToPlaylist("destination"); });
  expect(editPlaylistTracks).toHaveBeenCalledWith("destination", { action: "add", trackIds: ["a", "b"] });
});
test("mixed favorites like the whole selection and an entirely liked selection unlikes it", async () => {
  mockPlayer.likedSongIds = new Set(["a"]);
  const { result, rerender } = renderHook(() => useTrackActions([a, b]));
  await act(async () => { await result.current.toggleFavorite(); });
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledWith(b, true);
  mockPlayer.likedSongIds = new Set(["a", "b"]); rerender();
  await act(async () => { await result.current.toggleFavorite(); });
  expect(mockPlayer.setTrackFavorite).toHaveBeenLastCalledWith(b, false);
});
test("reports partial failures instead of claiming the entire batch succeeded", async () => {
  mockPlayer.setTrackFavorite.mockRejectedValueOnce(new Error("Server unreachable"));
  const { result } = renderHook(() => useTrackActions([a, b]));
  await act(async () => { await expect(result.current.toggleFavorite()).rejects.toMatchObject({ completed: 1, failedIds: ["a"] }); });
  expect(result.current.error).toMatch(/1 completed; 1 failed/);
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledTimes(2);
});
test("downloads verified library audio and queues external imports without claiming they are offline", async () => {
  const { result } = renderHook(() => useTrackActions([a, external, a]));
  await act(async () => { expect(await result.current.downloadSelected()).toMatchObject({ completed: 2, imported: 1 }); });
  expect(downloadToDevice).toHaveBeenCalledTimes(1);
  expect(downloadToDevice).toHaveBeenCalledWith("a", "320kbps", a);
  expect(offlineAuditor.recordDownloaded).toHaveBeenCalledWith("a");
  expect(externalActions.importExternalTrack).toHaveBeenCalledWith(external);
});
test("validates mixed selection capabilities before mutating any tracks", async () => {
  mockImport = false;
  const { result } = renderHook(() => useTrackActions([a, external]));
  await act(async () => {
    await expect(result.current.downloadSelected()).rejects.toThrow("privacy settings");
    await expect(result.current.addToPlaylist("playlist")).rejects.toThrow("Import external tracks");
  });
  expect(downloadToDevice).not.toHaveBeenCalled(); expect(editPlaylistTracks).not.toHaveBeenCalled();
});
test("stops the rest of a batch when the signed-in account changes", async () => {
  let resolve;
  mockPlayer.setTrackFavorite.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(() => useTrackActions([a, b]));
  let pending;
  act(() => { pending = result.current.toggleFavorite(); });
  const rejected = expect(pending).rejects.toThrow("signed-in account changed");
  mockOwner = "two"; rerender();
  await act(async () => { resolve(); await rejected; });
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledTimes(1);
});
test("Save for Later gives library tracks an accessible playlist and uses saved discoveries for external tracks", async () => {
  const { result } = renderHook(() => useTrackActions([a, external]));
  await act(async () => { await result.current.saveForLater(); });
  expect(createPlaylist).toHaveBeenCalledWith("Saved for Later", expect.any(String));
  expect(updateUserSettings).toHaveBeenCalledWith({ "trackActions.savedForLaterPlaylist": "later" });
  expect(editPlaylistTracks).toHaveBeenCalledWith("later", { action: "add", trackIds: ["a"] });
  expect(mockSave).toHaveBeenCalledTimes(1);
});
test("hide uses the same feedback API for library and discovery tracks", async () => {
  const { result } = renderHook(() => useTrackActions([a, external]));
  await act(async () => { await result.current.hideFromRecommendations(); });
  expect(sendRecommendationFeedback).toHaveBeenCalledWith({ action: "hide", itemType: "track", itemId: external.id, title: external.title, artist: external.artist });
});
test("explicit downloads persist the whole device selection before returning and continue in the engine", async () => {
  offlineDownloadEngine.getOwner.mockReturnValue("one");
  const { result } = renderHook(() => useTrackActions([a, b]));
  await act(async () => { expect(await result.current.downloadSelected()).toMatchObject({ completed: 2, queued: 2 }); });
  expect(offlineDownloadEngine.enqueueDownloads).toHaveBeenCalledWith([a, b], "320kbps");
  expect(downloadToDevice).not.toHaveBeenCalled();
});
test("retrying a partially failed unlike does not undo already completed favorites", async () => {
  mockPlayer.likedSongIds = new Set(["a", "b"]);
  mockPlayer.setTrackFavorite.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(undefined);
  const { result, rerender } = renderHook(() => useTrackActions([a, b]));
  await act(async () => { await expect(result.current.toggleFavorite()).rejects.toThrow("1 failed"); });
  mockPlayer.likedSongIds = new Set(["a"]); rerender();
  await act(async () => { await result.current.toggleFavorite(); });
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledTimes(3);
  expect(mockPlayer.setTrackFavorite).toHaveBeenLastCalledWith(a, false);
});
test("invalid IDs produce a diagnostic before any queue or API mutation", async () => {
  const { result } = renderHook(() => useTrackActions([{ ...a, id: undefined }]));
  await act(async () => { await expect(result.current.addToQueue()).rejects.toThrow("valid ID"); });
  expect(result.current.error).toContain("valid ID");
  expect(mockPlayer.queueTracks).not.toHaveBeenCalled();
});
test("removing the invoking row does not cancel remaining batch mutations for the same signed-in owner", async () => {
  offlineDownloadEngine.getOwner.mockReturnValue("one");
  let finish;
  mockPlayer.setTrackFavorite.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useTrackActions([a, b]));
  let pending; act(() => { pending = result.current.toggleFavorite(); });
  unmount();
  await act(async () => { finish(); await pending; });
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledTimes(2);
});
test("navigation stops subsequent batch mutations even when the authenticated storage owner stays the same", async () => {
  offlineDownloadEngine.getOwner.mockReturnValue("one");
  let finish;
  mockPlayer.setTrackFavorite.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useTrackActions([a, b]));
  let pending; act(() => { pending = result.current.toggleFavorite(); });
  const rejected = expect(pending).rejects.toThrow("view or signed-in account changed");
  window.dispatchEvent(new Event("musicdeck:navigation"));
  await act(async () => { finish(); await rejected; });
  expect(mockPlayer.setTrackFavorite).toHaveBeenCalledTimes(1);
});
