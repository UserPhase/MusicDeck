import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Search from "./Search";
import { searchNavidrome, startRadio } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn((id) => (id ? `/api/artwork/${id}` : null)),
  getUserSettings: jest.fn(async () => []),
  startRadio: jest.fn(async () => []),
  updateUserSettings: jest.fn(async () => []),
  searchNavidrome: jest.fn(),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(async () => []),
  addSongToPlaylist: jest.fn(),
}));

const mockPlaySong = jest.fn();
const mockPlaySongFromSource = jest.fn();
const mockPlayQueue = jest.fn();

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    playSong: mockPlaySong,
    playSongFromSource: mockPlaySongFromSource,
    playQueue: mockPlayQueue,
  }),
}));

function renderSearch(query = "love") {
  return render(
    <MemoryRouter initialEntries={[`/search?q=${query}`]}>
      <Search />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("uses shared empty state for an empty query", () => {
  renderSearch("");

  expect(screen.getByText(/search for an artist, album or song/i)).toHaveClass("library-empty");
});

test("renders songs, albums, artists, playlists, and availability from universal results", async () => {
  searchNavidrome.mockResolvedValue({
    degraded: true,
    results: {
      track: [{ type: "track", id: "track-1", title: "Song", artist: "Artist", album: "Album", coverArt: null, metadata: { artistId: "artist-1", albumId: "album-1", durationSeconds: 120 }, source: { kind: "library", count: 1 }, provider: "library", availability: { state: "degraded", availableSourceCount: 1 } }],
      album: [{ type: "album", id: "album-1", title: "Album", artist: "Artist", coverArt: null, metadata: {}, source: { kind: "library", count: 2 }, provider: "library", availability: { state: "available", availableSourceCount: 2 } }],
      artist: [{ type: "artist", id: "artist-1", title: "Artist", metadata: {}, source: { kind: "library", count: 1 }, provider: "library", availability: { state: "degraded", availableSourceCount: 1 } }],
      playlist: [{ type: "playlist", id: "playlist-1", title: "Road Trip", metadata: {}, source: { kind: "musicdeck", count: 1 }, provider: "musicdeck", availability: null }],
    },
  });

  renderSearch();

  expect(await screen.findByRole("heading", { name: "Songs" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Albums" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Artists" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Playlists" })).toBeInTheDocument();
  expect(screen.getByText("Road Trip")).toBeInTheDocument();
  expect(screen.getAllByLabelText("Availability: Partially available").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Availability: 2 sources")).toBeInTheDocument();
  expect(screen.getByText(/some music is temporarily unavailable/i)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Songs" }).closest("section")).toHaveClass("search-group-songs");
  expect(screen.getByRole("heading", { name: "Albums" }).closest("section")).toHaveClass("search-group-albums");
  expect(screen.getByRole("heading", { name: "Artists" }).closest("section")).toHaveClass("search-group-artists");
  expect(screen.getByRole("heading", { name: "Playlists" }).closest("section")).toHaveClass("search-group-playlists");
});

test("uses shared loading and error states", async () => {
  searchNavidrome.mockImplementation(() => new Promise(() => {}));
  const { unmount } = renderSearch();

  expect(await screen.findByText(/searching for "love"/i)).toHaveClass("loading");
  unmount();

  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  searchNavidrome.mockRejectedValue(new Error("Search unavailable"));
  renderSearch();

  expect(await screen.findByText("Search unavailable")).toHaveClass("error");
  consoleError.mockRestore();
});

test("shows a clear no-results state", async () => {
  searchNavidrome.mockResolvedValue({
    results: { track: [], album: [], artist: [], playlist: [] },
  });

  renderSearch();

  expect(await screen.findByText(/no results found/i)).toHaveClass("library-empty");
});

test("renders external results without provider-specific UI and disables unavailable playback", async () => {
  searchNavidrome.mockResolvedValue({
    results: {
      track: [{
        type: "track",
        id: "external_itunes_1",
        title: "External Song",
        artist: "Artist",
        album: "Album",
        artwork: null,
        provider: "external",
        source: { kind: "external", count: 0 },
        availability: null,
        metadata: { durationSeconds: 180 },
      }],
      album: [],
      artist: [],
      playlist: [],
    },
  });

  renderSearch();

  expect(await screen.findByLabelText("Available externally")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play preview of External Song" })).toBeEnabled();
  expect(screen.queryByText(/itunes|navidrome|jellyfin/i)).toBeNull();
});

test("starts track radio from the existing track menu", async () => {
  const song = {
    type: "track",
    id: "md_track_1",
    title: "Digital Love",
    artist: "Daft Punk",
    album: "Discovery",
    provider: "library",
    source: { kind: "library", count: 1 },
    metadata: { artistId: "artist-1", albumId: "album-1" },
  };
  searchNavidrome.mockResolvedValue({
    results: { track: [song], album: [], artist: [], playlist: [] },
  });
  startRadio.mockResolvedValue([{ ...song, id: "md_track_2", title: "Something About Us" }]);

  renderSearch();

  fireEvent.click(await screen.findByRole("button", { name: /more options for digital love/i }));
  fireEvent.click(screen.getByRole("button", { name: /start radio/i }));

  await waitFor(() => {
    expect(startRadio).toHaveBeenCalledWith(expect.objectContaining({ type: "track", id: "md_track_1" }));
    expect(mockPlayQueue).toHaveBeenCalledWith([expect.objectContaining({ title: "Something About Us" })], 0);
  });
});

test("renders merged library results with a neutral external-source hint", async () => {
  searchNavidrome.mockResolvedValue({
    results: {
      track: [{
        type: "track",
        id: "md_track_1",
        title: "Digital Love",
        artist: "Daft Punk",
        album: "Discovery",
        artwork: null,
        provider: "library",
        providers: ["library", "external"],
        source: { kind: "library", count: 1, externalAvailable: true },
        availability: { state: "available", availableSourceCount: 1 },
        metadata: { durationSeconds: 300 },
      }],
      album: [],
      artist: [],
      playlist: [],
    },
  });

  renderSearch();

  expect(await screen.findByLabelText("Available externally")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play Digital Love" })).toBeEnabled();
  expect(screen.queryByText(/itunes|navidrome|jellyfin/i)).toBeNull();
});
