import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import LibraryHealth from "./LibraryHealth";
import Tracks from "./Tracks";
import {
  filterLibraryTracks,
  getAllSongs,
  getLibraryHealth,
  getLibraryStatistics,
  setMediaRating,
} from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  filterLibraryTracks: jest.fn(),
  getAllSongs: jest.fn(),
  getCoverUrl: jest.fn((id) => (id ? `/artwork/${id}` : null)),
  getLibraryHealth: jest.fn(),
  getLibraryStatistics: jest.fn(),
  setMediaRating: jest.fn(async () => ({ ok: true })),
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
  setMediaRating.mockResolvedValue({ ok: true });
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

test("applies composable track filters and sets ratings", async () => {
  getAllSongs.mockResolvedValue([{ id: "track-1", title: "Song", artist: "Artist", album: "Album", duration: 120 }]);
  filterLibraryTracks.mockResolvedValue([{ id: "track-1", title: "Song", artist: "Artist", album: "Album", duration: 120, rating: 5 }]);

  render(
    <MemoryRouter>
      <Tracks />
    </MemoryRouter>
  );

  expect(await screen.findByText("Song")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
  fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "5" } });

  await waitFor(() => {
    expect(filterLibraryTracks).toHaveBeenCalledWith([
      { field: "favorite", op: "boolean", value: true },
      { field: "rating", op: "gte", value: 5 },
    ]);
  });
  expect(await screen.findByText("Song")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
  fireEvent.click(screen.getByRole("button", { name: /rate song 5 stars/i }));
  expect(setMediaRating).toHaveBeenCalledWith("track", "track-1", 5);
});
