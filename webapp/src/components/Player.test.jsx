import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Player from "./Player";
import { usePlayer } from "../context/PlayerContext";

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

beforeEach(() => {
  usePlayer.mockReturnValue({
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    togglePlay: jest.fn(),
    seek: jest.fn(),
    nextSong: jest.fn(),
    previousSong: jest.fn(),
    toggleShuffle: jest.fn(),
    isShuffleEnabled: false,
    toggleLoop: jest.fn(),
    isLooping: false,
    volume: 1,
    changeVolume: jest.fn(),
    toggleLike: jest.fn(),
    isCurrentSongLiked: false,
    isPreview: false,
    previewDurationSeconds: null,
    playbackUnavailable: false,
  });
});

test("the Queue button toggles the right sidebar callback instead of a local popover", () => {
  const onToggleQueueSidebar = jest.fn();

  render(
    <MemoryRouter>
      <Player isQueueSidebarOpen={false} onToggleQueueSidebar={onToggleQueueSidebar} />
    </MemoryRouter>
  );

  fireEvent.click(screen.getByRole("button", { name: "Open queue sidebar" }));
  expect(onToggleQueueSidebar).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Recently played")).not.toBeInTheDocument();
});
