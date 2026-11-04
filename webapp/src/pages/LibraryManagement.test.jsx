import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import LibraryHealth from "./LibraryHealth";
import Tracks from "./Tracks";
import { getPlaylists } from "../api/playlists";
import {
  getTrackPage,
  getAllSongs,
  getLibraryHealth,
  getLibraryStatistics,
} from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  getTrackPage: jest.fn(),
  getAllSongs: jest.fn(),
  getCoverUrl: jest.fn((id) => (id ? `/artwork/${id}` : null)),
  getLibraryHealth: jest.fn(),
  getLibraryStatistics: jest.fn(),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(async () => []),
  addSongToPlaylist: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    playSong: jest.fn(),
    playSongFromSource: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  getPlaylists.mockResolvedValue([]);
});

test("renders library health and collection statistics", async () => {
  getLibraryHealth.mockResolvedValue({
    summary: {
      albums: 10,
      tracks: 100,
      missingArtwork: 2,
      metadataIssues: 3,
      duplicates: 1,
      unavailable: 0,
    },
    issues: [{ type: "missing-artwork", itemType: "album", itemId: "album-1", title: "Album", detail: "Missing artwork" }],
  });
  getLibraryStatistics.mockResolvedValue({
    collection: {
      artists: 8,
      totalDurationSeconds: 7200,
      playedPercentage: 50,
      favoritePercentage: 25,
    },
  });

  render(
    <MemoryRouter>
      <LibraryHealth />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: /library health/i })).toBeInTheDocument();
  expect(screen.getByText("100")).toBeInTheDocument();
  expect(screen.getByText("Metadata issues")).toBeInTheDocument();
  expect(screen.getByText("Played")).toBeInTheDocument();
});

test("applies composable track filters", async () => {
  getAllSongs.mockResolvedValue([{ id: "track-1", title: "Song", artist: "Artist", album: "Album", duration: 120 }]);
  getTrackPage.mockResolvedValue({
    items: [{ id: "track-1", title: "Song", artist: "Artist", album: "Album", duration: 120 }],
    total: 1,
  });

  render(
    <MemoryRouter>
      <Tracks />
    </MemoryRouter>
  );

  expect(await screen.findByText("Song")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
  fireEvent.click(screen.getByRole("button", { name: "Unplayed" }));

  await waitFor(() => {
    expect(getTrackPage).toHaveBeenCalledWith(expect.objectContaining({ filters: [
      { field: "favorite", op: "boolean", value: true },
      { field: "played", op: "boolean", value: false },
    ] }));
  });
  expect(await screen.findByText("Song")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  expect(screen.queryByRole("menuitem", { name: /rate song/i })).not.toBeInTheDocument();
});
