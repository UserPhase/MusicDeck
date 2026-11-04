import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AlbumLikeButton from "./AlbumLikeButton";
import Sidebar from "./Sidebar";
import Playlists from "../pages/Playlists";
import { useAuth } from "../context/AuthContext";
import { artistOverviewQueryClient } from "../api/artistOverviewQuery";
import { getLikedAlbums, setMediaFavorite } from "../api/musicdeck";
import { getPlaylists } from "../api/playlists";

jest.mock("../api/musicdeck", () => ({
  getLikedAlbums: jest.fn(), setMediaFavorite: jest.fn(),
  getCoverUrl: (cover) => cover ? `/api/artwork/${cover}` : null,
}));
jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn(async () => []), createPlaylist: jest.fn() }));
jest.mock("../hooks/useAlbumArtwork", () => ({ useAlbumArtwork: () => ({ url: null, onError: () => {} }) }));
jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/ImportContext", () => ({ useImport: () => ({ job: null, openProgressToken: 0 }) }));
const album = { id: "external_deezer_album_7", name: "Night Drive", artist: "Neon", coverArt: "cover-7" };
const layout = () => <MemoryRouter><Sidebar /><AlbumLikeButton album={album} /><Playlists /></MemoryRouter>;
beforeEach(() => {
  artistOverviewQueryClient.clear();
  jest.clearAllMocks();
  useAuth.mockReturnValue({ session: { id: "user-1" } });
  getLikedAlbums.mockResolvedValue([]);
  getPlaylists.mockResolvedValue([]);
  setMediaFavorite.mockResolvedValue({ ok: true });
});
afterEach(() => artistOverviewQueryClient.clear());

test("liking an undownloaded album adds it immediately under Playlists and unliking removes it", async () => {
  render(layout());
  const heart = screen.getByRole("button", { name: "Like album" });
  await waitFor(() => expect(heart).toBeEnabled());
  fireEvent.click(heart);
  fireEvent.click(heart);
  await screen.findByRole("button", { name: "Unlike album" });
  expect(setMediaFavorite).toHaveBeenCalledTimes(1);
  expect(setMediaFavorite).toHaveBeenCalledWith("album", album.id, true,
    { name: album.name, artist: album.artist, coverUrl: "/api/artwork/cover-7" });
  const navigation = screen.getByRole("region", { name: "Playlists" });
  expect(within(navigation).getByRole("link", { name: "Night Drive" })).toHaveAttribute("href", `/album/${album.id}`);
  const section = screen.getByRole("region", { name: "Liked Albums" });
  expect(within(section).getByRole("link", { name: /Night Drive/ })).toHaveAttribute("href", `/album/${album.id}`);
  fireEvent.click(screen.getByRole("button", { name: "Unlike album" }));
  await screen.findByRole("button", { name: "Like album" });
  await waitFor(() => expect(screen.queryByRole("link", { name: "Night Drive" })).not.toBeInTheDocument());
  expect(setMediaFavorite).toHaveBeenLastCalledWith("album", album.id, false, undefined);
});

test("persisted likes restore on reload and switching accounts never exposes another user's albums", async () => {
  getLikedAlbums.mockResolvedValue([album]);
  const view = render(layout());
  expect(await screen.findByRole("button", { name: "Unlike album" })).toHaveAttribute("aria-pressed", "true");
  getLikedAlbums.mockResolvedValue([]);
  useAuth.mockReturnValue({ session: { id: "user-2" } });
  view.rerender(layout());
  expect(screen.queryByRole("link", { name: "Night Drive" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Like album" })).toBeEnabled());
});

test("failed saves leave the heart and both collections unchanged, and can be retried", async () => {
  setMediaFavorite.mockRejectedValueOnce(new Error("Couldn't save. Try again."));
  render(layout());
  const heart = screen.getByRole("button", { name: "Like album" });
  await waitFor(() => expect(heart).toBeEnabled());
  fireEvent.click(heart);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
  expect(heart).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByRole("link", { name: "Night Drive" })).not.toBeInTheDocument();
  fireEvent.click(heart);
  await screen.findByRole("button", { name: "Unlike album" });
});
