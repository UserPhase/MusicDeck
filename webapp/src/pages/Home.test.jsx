import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Home from "./Home";
import { getReleaseFeed } from "../api/artistFollows";
import { getAlbum, getAlbums, getArtistPortrait, getArtistTracks, getArtists, getCoverUrl, getMediaCheckpoints, getMusicBrainzArtistPortrait, getRecentlyAddedSongs, getRecommendations } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { toUnifiedTrack } from "../types/track";
import { addSongToPlaylist, editPlaylistTracks, getPlaylists } from "../api/playlists";

jest.mock("../api/musicdeck", () => ({
  getAlbum: jest.fn(),
  getAlbums: jest.fn(),
  getArtistTracks: jest.fn(),
  getArtists: jest.fn(),
  getArtistPortrait: jest.fn(async () => null),
  getCoverUrl: jest.fn(),
  getMediaCheckpoints: jest.fn(),
  getMusicBrainzArtistPortrait: jest.fn(),
  getRecentlyAddedSongs: jest.fn(),
  getRecommendations: jest.fn(),
  getSavedDiscoveries: jest.fn(async () => ({ discoveries: [] })),
}));

jest.mock("../context/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../api/artistFollows", () => ({ getReleaseFeed: jest.fn(async () => ({ releases: [], artists: [], hasMore: false })) }));
jest.mock("../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../utils/downloadManager", () => ({
  isDownloadedToDevice: async () => false, readOfflineTrack: async () => null, deleteOfflineTrack: async () => {}, downloadToDevice: jest.fn(),
  isDeviceDownloadPending: () => false, subscribeDeviceDownload: () => () => {},
}));
jest.mock("../api/playlists", () => ({ getPlaylists: jest.fn(), addSongToPlaylist: jest.fn(), editPlaylistTracks: jest.fn() }));

const playSong = jest.fn();
const playQueue = jest.fn();
const album = { id: "album-1", name: "Discovery", artist: "Daft Punk", coverArt: "art-1" };
const song = { id: "track-1", title: "Digital Love", artist: "Daft Punk", artistId: "artist-1", coverArt: "art-1", duration: 241 };
const artist = { id: "artist-1", name: "Daft Punk", coverArt: "artist-art", playCount: 0 };

function renderHome({ recentlyPlayed = [song], albums = [album], artists = [artist], recommendations = [song], checkpoints = [] } = {}) {
  jest.clearAllMocks();
  getReleaseFeed.mockResolvedValue({ releases: [], artists: [], hasMore: false });
  getCoverUrl.mockImplementation((id) => id ? `/api/artwork/${id}` : null);
  useAuth.mockReturnValue({ session: { id: "sam", displayName: "Sam", username: "sam" } });
  usePlayer.mockReturnValue({ playSong, playQueue, recentlyPlayed });
  getMediaCheckpoints.mockResolvedValue({ items: checkpoints });
  getAlbums.mockResolvedValue(albums);
  getRecentlyAddedSongs.mockResolvedValue([song]);
  getArtists.mockResolvedValue(artists);
  getArtistPortrait.mockResolvedValue(null);
  getMusicBrainzArtistPortrait.mockResolvedValue(null);
  getArtistTracks.mockResolvedValue([song]);
  getRecommendations.mockResolvedValue({ sections: [{ id: "mix", items: recommendations }] });
  getAlbum.mockResolvedValue({ song: [song] });
  getPlaylists.mockResolvedValue([{ id: "playlist-1", name: "Favorites" }]);
  addSongToPlaylist.mockResolvedValue({ success: true });
  editPlaylistTracks.mockResolvedValue({ id: "playlist-1" });

  return render(<MemoryRouter><Home /></MemoryRouter>);
}

async function waitForHome() {
  expect(await screen.findByRole("heading", { name: "Discover Albums" })).toBeInTheDocument();
}

test("checks the same portrait fallback as artist pages for artists missing pictures", async () => {
  renderHome();
  await waitFor(() => expect(getMusicBrainzArtistPortrait).toHaveBeenCalledWith(artist.id));
});

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

test("keeps song discovery in two ordered sections within the split layout", async () => {
  renderHome();
  await waitForHome();

  const discovery = screen.getByRole("region", { name: "Track discovery" });
  expect(discovery).toHaveClass("home-discovery-split");
  const sections = Array.from(discovery.children);
  expect(sections).toHaveLength(2);
  expect(sections[0]).toHaveAttribute("aria-labelledby", "recent-tracks-title");
  expect(sections[1]).toHaveAttribute("aria-labelledby", "discover-tracks-title");
  sections.forEach((section) => expect(section).toHaveClass("home-track-panel"));
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

test("plays a recently heard track from Continue Listening", async () => {
  renderHome();
  await waitForHome();

  const section = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
  expect(section.querySelector(".track-cover-art img")).toHaveAttribute("src", "/api/artwork/art-1");
  expect(section.querySelector(".track-number-text")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: /digital love/i })[0]);
  expect(playSong).toHaveBeenCalledWith(toUnifiedTrack(song, "home"), 0);
  fireEvent.click(screen.getAllByRole("button", { name: "More options for Digital Love" })[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: /Add to Playlist/ }));
  await screen.findByRole("menuitem", { name: "Favorites" });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  fireEvent.click(screen.getByRole("menuitem", { name: "Favorites" }));
  await waitFor(() => expect(editPlaylistTracks).toHaveBeenCalledWith("playlist-1", { action: "add", trackIds: ["track-1"] }));
  expect(playSong).toHaveBeenCalledTimes(1);
});

test("plays an album through its fetched queue", async () => {
  renderHome();
  await screen.findAllByText("Discovery");

  fireEvent.click(screen.getAllByRole("button", { name: /play discovery/i })[0]);
  await waitFor(() => {
    expect(getAlbum).toHaveBeenCalledWith("album-1");
    expect(playQueue).toHaveBeenCalledWith([song], 0, {
      type: "album", id: "album-1", name: "Discovery", coverArt: "art-1",
    });
  });
});

test("shows an empty listening state instead of recently added songs when history is empty", async () => {
  renderHome({ recentlyPlayed: [] });
  await waitForHome();

  await waitFor(() => {
    const section = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
    expect(section.querySelectorAll(".track")).toHaveLength(0);
    expect(section).toHaveTextContent("Start listening and your recent music will appear here.");
  });
});

test("shows the last six listened songs even when collection progress is saved", async () => {
  const history = Array.from({ length: 8 }, (_, index) => ({ ...song, id: `recent-${index}`, title: `Recent song ${index}` }));
  renderHome({ recentlyPlayed: history, checkpoints: [{
    type: "album", mediaId: album.id, title: album.name, trackId: song.id,
    trackIndex: 0, trackCount: 1, positionSeconds: 102.125, progress: .42, capturedAt: 1,
  }] });
  await waitForHome();

  const section = screen.getByRole("heading", { name: "Continue Listening" }).closest("section");
  expect(section.querySelector(".home-track-list")).toHaveClass("home-continue-grid");
  expect(Array.from(section.querySelectorAll(".track-title")).map((title) => title.textContent)).toEqual(history.slice(0, 6).map((track) => track.title));
  expect(section.querySelectorAll(".track-cover-art")).toHaveLength(6);
  expect(section.querySelectorAll(".track-number-text")).toHaveLength(0);
  expect(within(section).queryByRole("button", { name: /Resume from Track/ })).not.toBeInTheDocument();
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
