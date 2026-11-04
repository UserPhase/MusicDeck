import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SmartPlaylists from "./SmartPlaylists";
import { deleteSmartPlaylist, getSmartPlaylist, getSmartPlaylistTracks, listSmartPlaylists, previewSmartPlaylist } from "../api/musicdeck";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../api/musicdeck", () => ({
  listSmartPlaylists: jest.fn(), getSmartPlaylistTracks: jest.fn(), deleteSmartPlaylist: jest.fn(),
  previewSmartPlaylist: jest.fn(), createSmartPlaylist: jest.fn(), updateSmartPlaylist: jest.fn(),
  getSmartPlaylist: jest.fn(),
}));
const playlist = { id: "smart-1", name: "Rediscovered", rules: { operator: "AND", rules: [
  { field: "genre", operator: "contains", value: "Synthwave" },
] } };
const track = { id: "one", title: "Night Drive", artist: "Neon", album: "Album" };
const playQueue = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  usePlayer.mockReturnValue({ playQueue });
  listSmartPlaylists.mockResolvedValue({ playlists: [playlist] });
  getSmartPlaylist.mockResolvedValue({ playlist });
  previewSmartPlaylist.mockResolvedValue({ total: 1, tracks: [track], warning: null, refreshedAt: "2026-10-17" });
  deleteSmartPlaylist.mockResolvedValue(null);
});

test("a saved smart playlist opens directly with its own name instead of a separate creation page", async () => {
  render(<MemoryRouter initialEntries={["/smart-playlist/smart-1"]}><Routes>
    <Route path="/smart-playlist/:id" element={<SmartPlaylists />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Rediscovered" })).toBeInTheDocument();
  expect(getSmartPlaylist).toHaveBeenCalledWith("smart-1");
  expect(screen.queryByRole("button", { name: "+ New smart playlist" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Value 1.1")).toHaveValue("Synthwave");
  expect(screen.getByRole("link", { name: "Back to playlists" })).toHaveAttribute("href", "/library/playlists");
});

test("opens a saved definition and evaluates all pages afresh when playing", async () => {
  getSmartPlaylistTracks.mockResolvedValueOnce({ total: 2, tracks: [track], warning: null, refreshedAt: "2026-10-17" })
    .mockResolvedValueOnce({ total: 2, tracks: [{ ...track, id: "two" }], warning: null, refreshedAt: "2026-10-17" });
  render(<SmartPlaylists />);
  fireEvent.click(await screen.findByRole("button", { name: "Rediscovered" }));
  expect(screen.getByLabelText("Value 1.1")).toHaveValue("Synthwave");
  fireEvent.click(screen.getByRole("button", { name: "Play matching tracks" }));
  await waitFor(() => expect(playQueue).toHaveBeenCalledWith([track, { ...track, id: "two" }], 0));
  expect(getSmartPlaylistTracks.mock.calls.map((call) => call.slice(0, 2))).toEqual([["smart-1", 0], ["smart-1", 1]]);
});

test("failed evaluation leaves the existing playback untouched", async () => {
  getSmartPlaylistTracks.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<SmartPlaylists />);
  fireEvent.click(await screen.findByRole("button", { name: "Rediscovered" }));
  fireEvent.click(screen.getByRole("button", { name: "Play matching tracks" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your current playback has not been changed");
  expect(playQueue).not.toHaveBeenCalled();
});

test("deletion is confirmed and only removes the saved rule collection", async () => {
  render(<SmartPlaylists />);
  fireEvent.click(await screen.findByRole("button", { name: "Rediscovered" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete smart playlist" }));
  expect(deleteSmartPlaylist).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await waitFor(() => expect(deleteSmartPlaylist).toHaveBeenCalledWith("smart-1"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Rediscovered" })).not.toBeInTheDocument());
  expect(screen.getByText("Smart playlist removed. Library tracks have not been deleted.")).toBeInTheDocument();
});

test("leaving the page while matches load never starts playback afterward", async () => {
  let finish;
  getSmartPlaylistTracks.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<SmartPlaylists />);
  fireEvent.click(await screen.findByRole("button", { name: "Rediscovered" }));
  fireEvent.click(screen.getByRole("button", { name: "Play matching tracks" }));
  view.unmount();
  await act(async () => { finish({ total: 1, tracks: [track], refreshedAt: "2026-10-17" }); });
  expect(playQueue).not.toHaveBeenCalled();
});
