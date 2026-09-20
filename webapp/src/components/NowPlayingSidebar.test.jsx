import { fireEvent, render, screen } from "@testing-library/react";

import NowPlayingSidebar from "./NowPlayingSidebar";
import { getTrackArtistBiography, getTrackLyrics } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../api/musicdeck", () => ({
  getCoverUrl: jest.fn(() => "/cover.jpg"),
  getTrackLyrics: jest.fn(async () => null),
  getTrackArtistBiography: jest.fn(async () => null),
}));

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

test("keeps the next queue preview visible and hands off to the queue sidebar", () => {
  const onOpenQueue = jest.fn();
  usePlayer.mockReturnValue({
    currentSong: { id: "current", title: "Current", artist: "Artist" },
    queueIndex: 0,
    queue: [
      { id: "current", title: "Current", artist: "Artist" },
      { id: "next", title: "Next Track", artist: "Artist", duration: 120 },
    ],
  });

  render(<NowPlayingSidebar isOpen onClose={jest.fn()} onOpenQueue={onOpenQueue} />);

  expect(screen.getByText("Next in queue")).toBeInTheDocument();
  expect(screen.getByText("Next Track")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
  expect(onOpenQueue).toHaveBeenCalledTimes(1);
  expect(getTrackLyrics).toHaveBeenCalledWith("current");
  expect(getTrackArtistBiography).toHaveBeenCalledWith("current");
});
