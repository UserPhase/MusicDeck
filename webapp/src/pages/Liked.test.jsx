import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Liked from "./Liked";
import { getStarred } from "../api/musicdeck";
import { getPlaylists } from "../api/playlists";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getStarred: jest.fn(),
}));

jest.mock("../api/playlists", () => ({
  getPlaylists: jest.fn(),
  addSongToPlaylist: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

jest.mock("../components/TrackListHeader", () => () => null);
jest.mock("../components/TrackRow", () => ({ song, index, onPlay }) => (
  <button type="button" onClick={() => onPlay(song, index)}>{song.title}</button>
));

const songs = [
  { id: "track-1", title: "First song", artist: "Artist", album: "Album", duration: 120 },
  { id: "track-2", title: "Second song", artist: "Artist", album: "Album", duration: 140 },
];

const playContext = jest.fn();
const playQueue = jest.fn();
const addToQueue = jest.fn();
const toggleShuffle = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  getStarred.mockResolvedValue(songs);
  getPlaylists.mockResolvedValue([]);
  usePlayer.mockReturnValue({
    playContext,
    playQueue,
    addToQueue,
    playSongFromSource: jest.fn(),
    downloadQuality: "320kbps",
    isShuffleEnabled: false,
    toggleShuffle,
  });
});

function renderLiked() {
  return render(
    <MemoryRouter>
      <Liked />
    </MemoryRouter>
  );
}

test("uses the playlist hero and action layout while preserving liked-songs playback context", async () => {
  renderLiked();

  const title = await screen.findByRole("heading", { name: "Liked Songs" });
  expect(title.closest(".playlist-page-info")).toBeInTheDocument();
  expect(title.closest(".playlist-header")).toHaveClass("playlist-header");
  expect(title.closest(".liked-page")).toHaveClass("detail-hero-gradient");

  fireEvent.click(screen.getByRole("button", { name: "Toggle shuffle" }));
  expect(toggleShuffle).toHaveBeenCalledTimes(1);

  expect(screen.getByRole("button", { name: "Download liked songs to this device" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "First song" }));
  expect(playContext).toHaveBeenCalledWith(songs, 0, {
    type: "collection",
    id: "liked-songs",
    name: "Liked Songs",
    coverArt: null,
  });

  fireEvent.click(screen.getByRole("button", { name: /Play/ }));
  await waitFor(() => expect(playQueue).toHaveBeenCalledWith(songs, 0, {
    type: "collection",
    id: "liked-songs",
    name: "Liked Songs",
    coverArt: null,
  }));
});

test("adds all liked songs to the queue from the page options menu", async () => {
  renderLiked();

  fireEvent.click(await screen.findByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add 2 tracks to queue" }));

  expect(addToQueue).toHaveBeenNthCalledWith(1, songs[0], 0, songs);
  expect(addToQueue).toHaveBeenNthCalledWith(2, songs[1], 1, songs);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
