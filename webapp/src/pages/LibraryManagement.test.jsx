import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import LibraryHealth from "./LibraryHealth";
import Albums from "./Albums";
import Artists from "./Artists";
import Tracks from "./Tracks";
import { getPlaylists } from "../api/playlists";
import {
  getTrackPage,
  getAlbumPage,
  getArtists,
  getLibraryHealth,
  getLibraryStatistics,
} from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  trackLibraryFilters: jest.requireActual("../api/musicdeck").trackLibraryFilters,
  getTrackPage: jest.fn(),
  getAlbumPage: jest.fn(),
  getArtists: jest.fn(),
  getArtistPortrait: async () => null,
  getMusicBrainzArtistPortrait: async () => null,
  getCoverUrl: jest.fn((id) => (id ? `/artwork/${id}` : null)),
  getLibraryHealth: jest.fn(),
  getLibraryStatistics: jest.fn(),
}));

const mockPlayLibraryTracks = jest.fn();

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(async () => []),
  addSongToPlaylist: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    playSong: jest.fn(),
    playSongFromSource: jest.fn(),
    playLibraryTracks: mockPlayLibraryTracks,
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

test("requests 100 tracks and keeps a whole-library search when sorting and starting shuffle", async () => {
  getTrackPage.mockImplementation(async ({ offset, limit, query }) => {
    const indices = query ? [1204] : Array.from({ length: Math.min(limit, 1205 - offset) }, (_, index) => index + offset);
    return { items: indices.map(index => ({ id: `track-${index}`, title: `Song ${index}` })),
      total: query ? 1 : 1205, revision: query ? "matches" : "library" };
  });
  render(<MemoryRouter><Tracks /></MemoryRouter>);
  await screen.findByText("1205 songs");
  expect(getTrackPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 100 }));
  expect(screen.getAllByRole("row").length).toBeLessThan(100);
  expect(mockPlayLibraryTracks).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Search tracks" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search tracks" }), { target: { value: "1204" } });
  await screen.findByRole("row", { name: /Song 1204/ });
  fireEvent.click(screen.getByRole("button", { name: "Sort tracks" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Longest first" }));
  await waitFor(() => expect(getTrackPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, limit: 100, query: "1204", sort: "duration-desc" })));
  const shuffle = screen.getByRole("button", { name: "Shuffle all" });
  await waitFor(() => expect(shuffle).toBeEnabled());
  fireEvent.click(shuffle);
  expect(mockPlayLibraryTracks).toHaveBeenCalledWith({
    trackId: null, shuffle: true, query: { query: "1204", sort: "duration-desc", favoritesOnly: false, unplayedOnly: false },
  }, expect.any(AbortSignal), undefined);
});

test("sorts and searches album pages without loading track collector data", async () => {
  getAlbumPage.mockImplementation(async ({ query, offset, limit, sort }) => {
    const total = query ? 1 : 1205;
    const items = Array.from({ length: Math.min(limit, total - offset) }, (_, index) => ({
      id: `album-${offset + index}`, name: query ? "Distant album" : `${sort} Album ${offset + index}`,
    }));
    return { items, total, revision: `${query}:${sort}` };
  });
  render(<MemoryRouter><Albums /></MemoryRouter>);
  await screen.findByText("1205 albums");
  expect(getAlbumPage).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Sort albums" }));
  expect(getAlbumPage).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Newest release" }));
  await waitFor(() => expect(getAlbumPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, limit: 100, sort: "newest" })));
  fireEvent.click(screen.getByRole("button", { name: "Search albums" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search albums" }), { target: { value: "distant" } });
  await screen.findByText("1 album");
  expect(getAlbumPage).toHaveBeenLastCalledWith(expect.objectContaining({ query: "distant", sort: "newest", limit: 100 }));
});

test("mounts the first 100 artist cards while searching every result", async () => {
  getArtists.mockResolvedValue(Array.from({ length: 1205 }, (_, index) => ({
    id: `artist-${index}`, name: `Artist ${index}`,
  })));
  render(<MemoryRouter><Artists /></MemoryRouter>);
  await screen.findByText("1205 artists");
  expect(screen.getAllByRole("link")).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: "Show more artists" }));
  expect(screen.getAllByRole("link")).toHaveLength(200);
  fireEvent.click(screen.getByRole("button", { name: "Search artists" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search artists" }), { target: { value: "1204" } });
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Artist 1204" })).toHaveAttribute("href", "/artist/artist-1204");
  expect(getArtists).toHaveBeenCalledTimes(1);
});
