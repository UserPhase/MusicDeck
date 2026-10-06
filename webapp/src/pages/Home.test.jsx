import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Home from "./Home";
import { getAlbum, getAlbums, getArtistPortrait, getArtistTracks, getArtists, getCoverUrl, getRecentlyAddedSongs, getRecommendations } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { toUnifiedTrack } from "../types/track";
import { addSongToPlaylist, getPlaylists } from "../api/playlists";

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
jest.mock("../utils/downloadManager", () => ({ isDownloadedToDevice: async () => false, downloadToDevice: jest.fn() }));
jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn(), addSongToPlaylist: jest.fn() }));

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
  getPlaylists.mockResolvedValue([{ id: "playlist-1", name: "Favorites" }]);
  addSongToPlaylist.mockResolvedValue({ success: true });

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

test("uses same-origin fallback covers for missing recent album and listening artwork", async () => {
  renderHome({
    albums: [{ id: "album-missing", name: "Discovery", artist: "Daft Punk", coverArt: null }],
    recentlyPlayed: [{ ...song, coverArt: null, album: "Discovery" }],
  });
  await waitForHome();
  const albums = screen.getByRole("heading", { name: "Recently Added Albums" }).closest("section");
  const listening = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
  const expected = "/api/metadata/album-artwork?artist=Daft+Punk&album=Discovery";
  expect(albums.querySelector("img")).toHaveAttribute("src", expected);
  expect(listening.querySelector("img")).toHaveAttribute("src", expected);
});

test("opens artists using the same linked portrait card as Explore", async () => {
  renderHome();
  await waitForHome();

  const section = screen.getByRole("heading", { name: "Discover Artists" }).closest("section");
  const link = await waitFor(() => {
    const card = section.querySelector(".explore-artist");
    expect(card).toHaveAttribute("href", "/artist/artist-1");
    return card;
  });
  expect(link.querySelector(".explore-artist-image")).toBeInTheDocument();
  expect(section.querySelector("button")).toBeNull();
});

test("plays a continued-listening track", async () => {
  renderHome();
  await waitForHome();

  const section = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
  expect(section.querySelector(".track-cover-art img")).toHaveAttribute("src", "/api/artwork/art-1");
  expect(section.querySelector(".track-number-text")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: /digital love/i })[0]);
  expect(playSong).toHaveBeenCalledWith(toUnifiedTrack(song, "home"), 0);
  fireEvent.click(screen.getAllByRole("button", { name: "More options for Digital Love" })[0]);
  await screen.findByRole("menuitem", { name: "Favorites" });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  fireEvent.click(screen.getByRole("menuitem", { name: "Favorites" }));
  await waitFor(() => expect(addSongToPlaylist).toHaveBeenCalledWith("playlist-1", "track-1"));
  expect(playSong).toHaveBeenCalledTimes(1);
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
    expect(section.querySelectorAll(".track")).toHaveLength(1);
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
    expect(albumSection.querySelector(".explore-card-name")).toHaveTextContent("Homework");
    expect(artistSection.querySelector(".explore-artist")).toHaveTextContent("Justice");
  });
});
