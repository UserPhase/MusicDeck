import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Home from "./Home";
import { getAlbum, getAlbums, getArtistPortrait, getArtistTracks, getArtists, getCoverUrl, getRecentlyAddedSongs, getRecommendations } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getAlbums: jest.fn(),
  getArtistTracks: jest.fn(),
  getArtists: jest.fn(),
  getArtistPortrait: jest.fn(async () => null),
  getCoverUrl: jest.fn(),
  getRecentlyAddedSongs: jest.fn(),
  getRecommendations: jest.fn(),
}));

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));

const playSong = jest.fn();
const playQueue = jest.fn();
const album = { id: "album-1", name: "Discovery", artist: "Daft Punk", coverArt: "art-1" };
const song = { id: "track-1", title: "Digital Love", artist: "Daft Punk", artistId: "artist-1", coverArt: "art-1", duration: 241 };
const artist = { id: "artist-1", name: "Daft Punk", coverArt: "artist-art", playCount: 0 };

function renderHome({ recentlyPlayed = [song], albums = [album], artists = [artist], recommendations = [song] } = {}) {
  jest.clearAllMocks();
  getCoverUrl.mockImplementation((id) => id ? `/api/artwork/${id}` : null);
  useAuth.mockReturnValue({ session: { displayName: "Sam", username: "sam" } });
  usePlayer.mockReturnValue({ playSong, playQueue, recentlyPlayed });
  getAlbums.mockResolvedValue(albums);
  getRecentlyAddedSongs.mockResolvedValue([song]);
  getArtists.mockResolvedValue(artists);
  getArtistPortrait.mockResolvedValue(null);
  getArtistTracks.mockResolvedValue([song]);
  getRecommendations.mockResolvedValue({ sections: [{ id: "mix", items: recommendations }] });
  getAlbum.mockResolvedValue({ song: [song] });

  return render(<MemoryRouter><Home /></MemoryRouter>);
}

async function waitForHome() {
  expect(await screen.findByRole("heading", { name: "Discover Albums" })).toBeInTheDocument();
}

test("renders the artist shelves and discovery sections with a personalized greeting", async () => {
  renderHome();

  expect(screen.getByRole("heading", { name: "Welcome back, Sam" })).toBeInTheDocument();
  await waitForHome();

  [
    "Continue Listening",
    "Recently Added Albums",
    "Discover Artists",
    "Recently Added Songs",
    "Discover Tracks",
    "Discover Albums",
    "Unexplored Artists",
    "Try Something Different",
  ].forEach((heading) => expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument());
});

test("plays an artist through its fetched tracks", async () => {
  renderHome();
  await waitForHome();

  fireEvent.click(screen.getAllByRole("button", { name: /play daft punk/i })[0]);
  await waitFor(() => {
    expect(getArtistTracks).toHaveBeenCalledWith("artist-1");
    expect(playQueue).toHaveBeenCalledWith([song], 0);
  });
});

test("plays a continued-listening track", async () => {
  renderHome();
  await waitForHome();

  fireEvent.click(screen.getAllByRole("button", { name: /digital love/i })[0]);
  expect(playSong).toHaveBeenCalledWith(song);
});

test("plays an album through its fetched queue", async () => {
  renderHome();
  await screen.findAllByText("Discovery");

  fireEvent.click(screen.getAllByRole("button", { name: /play discovery/i })[0]);
  await waitFor(() => {
    expect(getAlbum).toHaveBeenCalledWith("album-1");
    expect(playQueue).toHaveBeenCalledWith([song], 0);
  });
});

test("keeps the listening hero useful when history is empty", async () => {
  renderHome({ recentlyPlayed: [] });
  await waitForHome();

  await waitFor(() => {
    const section = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
    expect(section.querySelectorAll(".home-continue-card")).toHaveLength(1);
  });
});

test("ranks local discover albums and artists from listening-based recommendations", async () => {
  const secondAlbum = { id: "album-2", name: "Homework", artist: "Daft Punk", coverArt: "art-2" };
  const secondArtist = { id: "artist-2", name: "Justice", coverArt: "art-3" };
  renderHome({
    albums: [album, secondAlbum],
    artists: [artist, secondArtist],
    recommendations: [{ ...song, metadata: { albumId: "album-2", artistId: "artist-2" } }],
  });

  await waitFor(() => {
    const albumSection = screen.getByRole("heading", { name: "Discover Albums" }).closest("section");
    const artistSection = screen.getByRole("heading", { name: "Discover Artists" }).closest("section");
    expect(albumSection.querySelector(".album-title")).toHaveTextContent("Homework");
    expect(artistSection.querySelector(".home-artist-card a")).toHaveTextContent("Justice");
  });
});
