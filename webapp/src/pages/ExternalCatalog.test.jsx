import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import Album from "./Album";
import Artist from "./Artist";
import Explore from "./Explore";
import {
  getAlbum,
  getArtist,
  getExplore,
  getRecommendations,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getArtist: jest.fn(),
  getCoverUrl: jest.fn((id) => (id ? `/artwork/${id}` : null)),
  getExplore: jest.fn(),
  getRecommendations: jest.fn(async () => ({ sections: [], degraded: false })),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(async () => []),
  addSongToPlaylist: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

const playSong = jest.fn();
const playQueue = jest.fn();
const playSongFromSource = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  getRecommendations.mockResolvedValue({ sections: [], degraded: false });
  usePlayer.mockReturnValue({
    playSong,
    playQueue,
    playSongFromSource,
  });
});

test("renders an external album in the shared album page", async () => {
  getAlbum.mockResolvedValue({
    id: "external_itunes_album_10",
    name: "External Album",
    artist: "External Artist",
    artistId: "external_itunes_artist_20",
    year: 2025,
    genre: "Alternative",
    label: "Example Label",
    coverArt: "extart_album",
    song: [{
      id: "external_itunes_30",
      type: "track",
      title: "External Song",
      artist: "External Artist",
      album: "External Album",
      duration: 180,
      coverArt: "extart_track",
      source: { kind: "external", count: 0 },
      provider: "external",
      metadata: {},
    }],
  });

  render(
    <MemoryRouter initialEntries={["/album/external_itunes_album_10"]}>
      <Routes>
        <Route path="/album/:id" element={<Album />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "External Album" })).toBeInTheDocument();
  expect(screen.getByText(/Alternative/)).toBeInTheDocument();
  expect(screen.getByText(/Example Label/)).toBeInTheDocument();
  expect(screen.getByText("External Song")).toBeInTheDocument();
  expect(screen.getByLabelText(/available externally/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /play external song from another source/i })).toBeInTheDocument();
});

test("renders an external artist in the shared artist page and links albums", async () => {
  getArtist.mockResolvedValue({
    id: "external_itunes_artist_20",
    name: "External Artist",
    coverArt: null,
    albumCount: 1,
    album: [{
      id: "external_itunes_album_10",
      name: "External Album",
      year: 2025,
      coverArt: "extart_album",
      source: { kind: "external", count: 0 },
      provider: "external",
    }],
    tracks: [{
      id: "external_itunes_30",
      type: "track",
      title: "External Song",
      artist: "External Artist",
      album: "External Album",
      duration: 180,
      source: { kind: "external", count: 0 },
      provider: "external",
      metadata: { albumId: "external_itunes_album_10" },
    }],
  });

  render(
    <MemoryRouter initialEntries={["/artist/external_itunes_artist_20"]}>
      <Routes>
        <Route path="/artist/:id" element={<Artist />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "External Artist" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /external album/i })).toHaveAttribute(
    "href",
    "/album/external_itunes_album_10"
  );
  expect(screen.getByText("External Song")).toBeInTheDocument();
});

test("renders native Explore recommendation sections when data exists", async () => {
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getRecommendations.mockResolvedValue({
    sections: [{
      id: "discover",
      title: "Discover something new",
      items: [{
        id: "md_track_1",
        type: "track",
        title: "Recommended Song",
        artist: "Artist One",
        coverArt: "art-1",
        metadata: { recommendationReason: "Because you listen to Artist One" },
      }],
    }],
    degraded: false,
  });

  render(
    <MemoryRouter>
      <Explore />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: /discover something new/i })).toBeInTheDocument();
  expect(screen.getByText("Because you listen to Artist One")).toBeInTheDocument();
});

test("renders Explore discovery using neutral results", async () => {
  getExplore.mockResolvedValue({
    albums: [{
      id: "external_itunes_album_10",
      title: "External Album",
      artist: "External Artist",
      coverArt: "extart_album",
      source: { kind: "external", count: 0 },
    }],
    artists: [{
      id: "external_itunes_artist_20",
      title: "External Artist",
      coverArt: null,
      source: { kind: "external", count: 0 },
    }],
    songs: [{
      id: "external_itunes_30",
      title: "External Song",
      artist: "External Artist",
      coverArt: "extart_track",
      source: { kind: "external", count: 0 },
      metadata: {},
    }],
    degraded: false,
  });

  render(
    <MemoryRouter>
      <Explore />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: /new discoveries/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /external album/i })).toHaveAttribute(
    "href",
    "/album/external_itunes_album_10"
  );
  const artistSection = screen.getByRole("heading", { name: /artists to explore/i }).closest("section");
  expect(artistSection?.querySelector('a[href="/artist/external_itunes_artist_20"]')).not.toBeNull();
  await waitFor(() => {
    expect(screen.getAllByLabelText(/available externally/i).length).toBeGreaterThan(0);
  });
});
