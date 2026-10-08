import { fireEvent, render, screen } from "@testing-library/react";

import AppleHeaderPlayer from "./AppleHeaderPlayer";
import { usePlayer } from "../../../context/PlayerContext";
import { createAcquisition } from "../../../api/musicdeck";

jest.mock("../../../context/PlayerContext", () => ({ usePlayer: jest.fn() }));
jest.mock("../../../api/musicdeck", () => ({ createAcquisition: jest.fn() }));
jest.mock("../../../hooks/useAlbumArtwork", () => ({
  useAlbumArtwork: () => ({ url: null, onError: jest.fn() }),
}));
jest.mock("../../Player", () => ({ formatTime: (seconds) => `t${Math.floor(seconds || 0)}` }));

function state(overrides = {}) {
  return {
    currentSong: { id: "s1", title: "Midnight City", artist: "M83", album: "Hurry Up" },
    isPlaying: false,
    currentTime: 30,
    duration: 120,
    togglePlay: jest.fn(),
    seek: jest.fn(),
    nextSong: jest.fn(),
    previousSong: jest.fn(),
    toggleShuffle: jest.fn(),
    isShuffleEnabled: false,
    toggleLoop: jest.fn(),
    isLooping: true,
    volume: 0.5,
    changeVolume: jest.fn(),
    toggleLike: jest.fn(),
    isCurrentSongLiked: false,
    isPreview: false,
    playbackUnavailable: false,
    playbackMessage: "",
    activeSidebar: "none",
    setActiveSidebar: jest.fn(),
    ...overrides,
  };
}

test("drives playback through the shared player context", () => {
  const player = state();
  usePlayer.mockReturnValue(player);
  render(<AppleHeaderPlayer />);

  expect(screen.getByRole("region", { name: "Playback controls" })).toHaveTextContent("Midnight City");
  expect(screen.getByText("M83 — Hurry Up")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  fireEvent.click(screen.getByRole("button", { name: "Next song" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous song" }));
  fireEvent.click(screen.getByRole("button", { name: "Like song" }));
  fireEvent.change(screen.getByRole("slider", { name: "Song progress" }), { target: { value: "50" } });
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.2" } });

  expect(player.togglePlay).toHaveBeenCalled();
  expect(player.nextSong).toHaveBeenCalled();
  expect(player.previousSong).toHaveBeenCalled();
  expect(player.toggleLike).toHaveBeenCalled();
  expect(player.seek).toHaveBeenCalledWith(50);
  expect(player.changeVolume).toHaveBeenCalledWith(0.2);
  expect(screen.getByRole("button", { name: "Turn off repeat" })).toHaveAttribute("aria-pressed", "true");
});

test("toggles the lyrics and queue panels", () => {
  const player = state({ activeSidebar: "queue" });
  usePlayer.mockReturnValue(player);
  render(<AppleHeaderPlayer />);

  expect(screen.getByRole("button", { name: "Close queue sidebar" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Open lyrics panel" }));
  const updater = player.setActiveSidebar.mock.calls[0][0];
  expect(updater("queue")).toBe("now-playing");
  expect(updater("now-playing")).toBe("none");
});

test("shows an idle state and disables transport without a song", () => {
  usePlayer.mockReturnValue(state({ currentSong: null }));
  render(<AppleHeaderPlayer />);

  expect(screen.getByText("Nothing playing")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Like song" })).not.toBeInTheDocument();
});

test("imports the full song while a preview plays", async () => {
  createAcquisition.mockResolvedValue({});
  usePlayer.mockReturnValue(state({ isPreview: true, playbackMessage: "Preview only" }));
  render(<AppleHeaderPlayer />);

  expect(screen.getByRole("status")).toHaveTextContent("Preview only");
  fireEvent.click(screen.getByRole("button", { name: "Import full song" }));
  expect(await screen.findByRole("button", { name: "Import queued" })).toBeDisabled();
  expect(createAcquisition).toHaveBeenCalledWith(expect.objectContaining({ trackId: "s1", sourceProvider: "spotdl" }));
});
