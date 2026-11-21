import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getStarred, request } from "../api/musicdeck";
import { deletePlaylist, getPlaylist, getPlaylists, getRecentlyPlayedPlaylists } from "../api/playlists";
import { usePlayer } from "../context/PlayerContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import Playlists from "./Playlists";

jest.mock("../api/playlists", () => ({
  deletePlaylist: jest.fn(), getPlaylist: jest.fn(), getPlaylists: jest.fn(), getRecentlyPlayedPlaylists: jest.fn(),
}));
jest.mock("../api/musicdeck", () => ({
  getCoverUrl: () => null, getStarred: jest.fn(), request: jest.fn(),
  LISTENING_ACTIVITY_CHANGED_EVENT: "musicdeck:listening-activity-changed",
}));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: jest.fn() }));
jest.mock("../components/LikedAlbumsSection", () => () => null);
jest.mock("../hooks/useSmartPlaylists", () => ({
  useSmartPlaylists: () => ({ items: [
    { id: "smart-a", name: "Smart Alpha", createdAt: "2026-02-01" },
    { id: "smart-z", name: "Smart Zulu", createdAt: "2026-03-01" },
  ] }),
}));

beforeEach(() => {
  usePlayer.mockReturnValue({ likedSongIds: new Set(), isPlaying: false });
  useMediaQuery.mockReturnValue(false);
});

test("sorts each playlist type independently of the visibility filter", async () => {
  getPlaylists.mockResolvedValue([
    { id: "a", name: "Alpha", createdAt: "2026-03-01" },
    { id: "z", name: "Zulu", createdAt: "2026-02-01" },
  ]);
  const { container } = render(<MemoryRouter><Playlists /></MemoryRouter>);
  await screen.findByText("Alpha");
  const names = () => Array.from(container.querySelectorAll(".playlist-title"), item => item.textContent);
  const choose = name => {
    fireEvent.click(screen.getByRole("button", { name: "Filter playlists" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  };
  expect(names()).toEqual(["Liked Songs", "Alpha", "Zulu", "Smart Alpha", "Smart Zulu"]);
  choose("Z–A");
  expect(names()).toEqual(["Liked Songs", "Zulu", "Alpha", "Smart Zulu", "Smart Alpha"]);
  choose("Newest");
  expect(names()).toEqual(["Liked Songs", "Alpha", "Zulu", "Smart Zulu", "Smart Alpha"]);
  choose("Oldest");
  expect(names()).toEqual(["Liked Songs", "Zulu", "Alpha", "Smart Alpha", "Smart Zulu"]);
  choose("Smart playlists");
  expect(names()).toEqual(["Liked Songs", "Smart Alpha", "Smart Zulu"]);
  choose("Regular playlists");
  expect(names()).toEqual(["Liked Songs", "Zulu", "Alpha"]);
});

test("keeps empty Liked Songs pinned through mobile sorting and search", async () => {
  useMediaQuery.mockReturnValue(true);
  getPlaylists.mockResolvedValue([{ id: "a", name: "Alpha" }, { id: "z", name: "Zulu" }]);
  getRecentlyPlayedPlaylists.mockResolvedValue([{ id: "smart-z" }, { id: "z" }]);
  request.mockResolvedValue({ playlists: [{ id: "a", position: 2 }, { id: "z", position: 1 }] });
  render(<MemoryRouter><Playlists /></MemoryRouter>);

  const list = within(screen.getByRole("list", { name: "Library playlists" }));
  expect(list.getByRole("link", { name: "Liked Songs" })).toHaveAccessibleDescription("Pinned \u00b7 0 songs");
  await list.findByRole("link", { name: "Alpha" });
  const names = () => list.getAllByRole("link").map(link => link.querySelector(".playlist-title").textContent);
  const choose = (name) => {
    fireEvent.click(screen.getByRole("button", { name: "Sort playlists" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  };
  expect(list.queryByRole("link", { name: "Downloads" })).not.toBeInTheDocument();
  expect(names().slice(0, 2)).toEqual(["Liked Songs", "Alpha"]);
  choose("Recently played");
  await waitFor(() => expect(names().slice(0, 3)).toEqual(["Liked Songs", "Smart Zulu", "Zulu"]));
  choose("Custom order");
  await waitFor(() => expect(names().slice(0, 3)).toEqual(["Liked Songs", "Zulu", "Alpha"]));
  choose("Alphabetical");
  expect(names().slice(0, 2)).toEqual(["Liked Songs", "Alpha"]);
  fireEvent.click(screen.getByRole("button", { name: "Search playlists" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Smart Alpha" } });
  expect(names()).toEqual(["Liked Songs", "Smart Alpha"]);
});

test("follows the playlist playback source and offers protected mobile row actions", async () => {
  useMediaQuery.mockReturnValue(true);
  const song = { id: "track-1", origin: "liked" };
  const queueTracks = jest.fn();
  getPlaylists.mockResolvedValue([{ id: "a", name: "Alpha", songCount: 1, permissions: { canManage: true } }]);
  getStarred.mockResolvedValue([song]);
  getPlaylist.mockResolvedValue({ entry: [{ ...song, tastePlaylistId: "a" }] });
  usePlayer.mockReturnValue({ likedSongIds: new Set([song.id]), currentSong: song, isPlaying: true, queueTracks });
  const page = <MemoryRouter><Playlists /></MemoryRouter>;
  const { rerender } = render(page);
  const liked = screen.getByRole("link", { name: "Liked Songs" });
  const alpha = await screen.findByRole("link", { name: "Alpha" });
  expect(within(liked).getByRole("img", { name: "Now playing" })).toBeInTheDocument();
  expect(within(alpha).queryByRole("img")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "More options for Liked Songs" }));
  expect(screen.queryByRole("menuitem", { name: "Delete playlist" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to queue" }));
  await waitFor(() => expect(queueTracks).toHaveBeenCalledWith([song]));
  usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { ...song, origin: "playlist", tastePlaylistId: "a" } });
  rerender(<MemoryRouter><Playlists /></MemoryRouter>);
  expect(within(alpha).getByRole("img", { name: "Now playing" })).toBeInTheDocument();
  expect(within(liked).queryByRole("img")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "More options for Alpha" }));
  expect(screen.getByRole("menuitem", { name: "Edit details" })).toHaveAttribute("href", "/playlist/a");
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  getPlaylists.mockResolvedValue([]);
  try {
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete playlist" }));
    await waitFor(() => expect(alpha).not.toBeInTheDocument());
    expect(deletePlaylist).toHaveBeenCalledWith("a");
    expect(liked).toBeInTheDocument();
  } finally {
    confirm.mockRestore();
  }
});
