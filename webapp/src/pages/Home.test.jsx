import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Home from "./Home";
import {
  getAlbum,
  getCoverUrl,
  getExplore,
  getRandomAlbums,
  getRandomSongs,
  getRecommendations,
  getStarred,
} from "../api/musicdeck";
import {
  getPlaylists,
} from "../api/playlists";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getCoverUrl: jest.fn(),
  getExplore: jest.fn(),
  getRandomAlbums: jest.fn(),
  getRandomSongs: jest.fn(),
  getRecommendations: jest.fn(),
  getStarred: jest.fn(),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(),
}));

jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

const playSong = jest.fn();
const playQueue = jest.fn();

const album = {
  id: "album-1",
  name: "Discovery",
  artist: "Daft Punk",
  coverArt: "art-1",
};

const song = {
  id: "track-1",
  title: "Digital Love",
  artist: "Daft Punk",
  artistId: "artist-1",
  coverArt: "art-1",
};

const favorite = {
  id: "track-liked",
  title: "One More Time",
  artist: "Daft Punk",
  artistId: "artist-1",
  coverArt: "art-liked",
};

const playlist = {
  id: "playlist-1",
  name: "Evening Drive",
  songCount: 12,
  coverArt: "mdplart_sig1_mdpl_1",
  coverMode: "collage",
};

function renderHome({
  session = { displayName: "Sam", username: "sam" },
  recentlyPlayed = [song],
  randomAlbums = [album],
  randomSongs = [song],
  favorites = [favorite],
  playlists = [playlist],
  recommendations = [],
  favoritesReject = false,
  playlistsReject = false,
} = {}) {
  jest.clearAllMocks();

  getCoverUrl.mockImplementation((id, size) =>
    id ? `/api/artwork/${id}${size ? `?size=${size}` : ""}` : null
  );

  useAuth.mockReturnValue({ session });
  usePlayer.mockReturnValue({
    playSong,
    playQueue,
    recentlyPlayed,
  });

  getRandomAlbums.mockResolvedValue(randomAlbums);
  getRandomSongs.mockResolvedValue(randomSongs);
  getExplore.mockResolvedValue({ albums: [], artists: [], songs: [], degraded: false });
  getRecommendations.mockResolvedValue({ sections: recommendations, degraded: false });
  if (favoritesReject) {
    getStarred.mockRejectedValue(new Error("Favorites unavailable"));
  } else {
    getStarred.mockResolvedValue(favorites);
  }
  if (playlistsReject) {
    getPlaylists.mockRejectedValue(new Error("Playlists unavailable"));
  } else {
    getPlaylists.mockResolvedValue(playlists);
  }
  getAlbum.mockResolvedValue({ song: [song] });

  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

async function waitForHome() {
  expect(await screen.findByRole("heading", { name: /discover albums/i })).toBeInTheDocument();
}

test("greets the authenticated user by display name", async () => {
  renderHome();

  expect(screen.getByRole("heading", { name: /welcome back, sam/i })).toBeInTheDocument();
  await waitForHome();
});

test("greets with a sensible fallback", async () => {
  renderHome({ session: null });

  expect(screen.getByRole("heading", { name: /welcome back, there/i })).toBeInTheDocument();
  await waitForHome();
});

test("renders Continue Listening from PlayerContext without another recent request", async () => {
  renderHome({ recentlyPlayed: [song] });

  await waitForHome();

  expect(screen.getByRole("heading", { name: /continue listening/i })).toBeInTheDocument();
  expect(screen.getAllByText("Digital Love").length).toBeGreaterThan(0);
});

test("renders favorites when available", async () => {
  renderHome({ favorites: [favorite] });

  expect(await screen.findByRole("heading", { name: /your favorites/i })).toBeInTheDocument();
  expect(screen.getByText("One More Time")).toBeInTheDocument();
});

test("omits favorites when empty", async () => {
  renderHome({ favorites: [] });

  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: /your favorites/i })).toBeNull();
  });
});

test("renders playlists when available", async () => {
  renderHome({ playlists: [playlist] });

  expect(await screen.findByRole("heading", { name: /your playlists/i })).toBeInTheDocument();
  expect(screen.getByText("Evening Drive")).toBeInTheDocument();
});

test("Home playlist cards render the resolved playlist artwork as a thumbnail", async () => {
  renderHome({ playlists: [playlist] });

  expect(await screen.findByRole("heading", { name: /your playlists/i })).toBeInTheDocument();

  const cover = screen.getByAltText("Evening Drive cover");

  expect(cover).toHaveAttribute(
    "src",
    "/api/artwork/mdplart_sig1_mdpl_1?size=300"
  );
});

test("Home playlist cards fall back to the placeholder without artwork", async () => {
  const { container } = renderHome({
    playlists: [{ ...playlist, coverArt: null, coverMode: null }],
  });

  expect(await screen.findByRole("heading", { name: /your playlists/i })).toBeInTheDocument();
  expect(screen.queryByAltText("Evening Drive cover")).toBeNull();
  expect(container.querySelector(".playlist-cover-icon")).toBeInTheDocument();
});

test("omits playlists when empty", async () => {
  renderHome({ playlists: [] });

  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: /your playlists/i })).toBeNull();
  });
});

test("renders personalized recommendation sections with explanations", async () => {
  renderHome({
    recommendations: [{
      id: "favorites-mix",
      title: "Made for you",
      items: [{ ...song, metadata: { recommendationReason: "From your favorites" } }],
    }],
  });

  expect(await screen.findByRole("heading", { name: /made for you/i })).toBeInTheDocument();
  expect(screen.getByText("From your favorites")).toBeInTheDocument();
});

test("renders Discover Albums and Try Something Different from random data", async () => {
  renderHome();

  expect(await screen.findByRole("heading", { name: /discover albums/i })).toBeInTheDocument();
  expect(await screen.findByText("Discovery")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /try something different/i })).toBeInTheDocument();
  expect(screen.getAllByText("Digital Love").length).toBeGreaterThan(0);
});

test("optional-section failure does not prevent other Home content", async () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

  renderHome({ favoritesReject: true });

  await waitForHome();

  expect(screen.getByRole("heading", { name: /continue listening/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /discover albums/i })).toBeInTheDocument();
  expect(await screen.findByText(/could not load favorites/i)).toBeInTheDocument();

  consoleError.mockRestore();
});

test("existing playback actions remain functional", async () => {
  renderHome();

  await waitForHome();

  fireEvent.click(screen.getAllByRole("button", { name: /play digital love/i })[0]);
  expect(playSong).toHaveBeenCalledWith(song);

  expect(await screen.findByText("Discovery")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: /play discovery/i })[0]);

  await waitFor(() => {
    expect(getAlbum).toHaveBeenCalledWith("album-1");
    expect(playQueue).toHaveBeenCalledWith([song], 0);
  });
});
