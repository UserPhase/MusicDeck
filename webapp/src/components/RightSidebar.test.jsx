import { render, screen, waitFor } from "@testing-library/react";

import RightSidebar from "./RightSidebar";
import {
  getTrackArtistBiography,
  getTrackLyrics,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(() => "/cover.jpg"),
  getTrackLyrics: jest.fn(),
  getTrackArtistBiography: jest.fn(),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

test("loads Now Playing metadata again when the active track changes", async () => {
  getTrackLyrics.mockImplementation(async (id) => `Lyrics for ${id}`);
  getTrackArtistBiography.mockImplementation(async (id) => `Biography for ${id}`);
  usePlayer.mockReturnValue({
    currentSong: { id: "track-1", title: "First", artist: "Artist" },
    queue: [],
    queueIndex: -1,
  });

  const view = render(<RightSidebar isOpen onToggle={jest.fn()} />);

  expect(await screen.findByText("Lyrics for track-1")).toBeInTheDocument();
  expect(screen.getByText("Biography for track-1")).toBeInTheDocument();

  usePlayer.mockReturnValue({
    currentSong: { id: "track-2", title: "Second", artist: "Artist" },
    queue: [],
    queueIndex: -1,
  });
  view.rerender(<RightSidebar isOpen onToggle={jest.fn()} />);

  expect(await screen.findByText("Lyrics for track-2")).toBeInTheDocument();
  expect(screen.getByText("Biography for track-2")).toBeInTheDocument();
  await waitFor(() => {
    expect(getTrackLyrics).toHaveBeenLastCalledWith("track-2");
    expect(getTrackArtistBiography).toHaveBeenLastCalledWith("track-2");
  });
});
