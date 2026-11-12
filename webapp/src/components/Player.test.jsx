import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Player from "./Player";
import { usePlayer } from "../context/PlayerContext";
import { RemoteSessionContext } from "../context/RemoteSessionContext";
import { CastContext } from "../context/CastContext";
import { setDesktopForeground } from "../services/visualActivity";

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

test("the speaker button mutes and restores the previous volume", () => {
  const changeVolume = jest.fn();
  usePlayer.mockReturnValue({ ...usePlayer(), changeVolume, volume: 0.37 });
  const player = <MemoryRouter><Player /></MemoryRouter>;
  const view = render(player);
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(changeVolume).toHaveBeenLastCalledWith(0);

  usePlayer.mockReturnValue({ ...usePlayer(), volume: 0 });
  view.rerender(<MemoryRouter><Player /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
  expect(changeVolume).toHaveBeenLastCalledWith(0.37);
});

test("the progress thumb follows fractional playback positions and can still seek to zero", () => {
  const seek = jest.fn();
  const readPlaybackPosition = jest.fn(() => 10);
  let draw;
  const schedule = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { draw = callback; return 1; });
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  try {
    usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { id: "one", title: "Song" },
      currentTime: 10, duration: 200, isPlaying: true, readPlaybackPosition, seek });
    const view = render(<MemoryRouter><Player /></MemoryRouter>);
    const progress = screen.getByRole("slider", { name: "Song progress" });
    expect(progress.valueAsNumber).toBe(5);
    readPlaybackPosition.mockReturnValue(10.25);
    draw();
    expect(progress.valueAsNumber).toBeCloseTo(5.125);
    expect(seek).not.toHaveBeenCalled();
    fireEvent.change(progress, { target: { value: "0" } });
    expect(seek).toHaveBeenLastCalledWith(0);
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(1);
  } finally {
    schedule.mockRestore();
    cancel.mockRestore();
  }
});

test("the main player toggles shuffle without showing a shuffle-mode dropdown", () => {
  const changeShuffleMode = jest.fn();
  const toggleShuffle = jest.fn();
  usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { id: "one", title: "Song" }, shuffleMode: "smart", changeShuffleMode, toggleShuffle });
  render(<MemoryRouter><Player /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: /Shuffle mode/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Turn on shuffle" }));
  expect(toggleShuffle).toHaveBeenCalledTimes(1);
  expect(changeShuffleMode).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("stops visual progress updates in the background and catches up on focus without pausing audio", () => {
  const schedule = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(17);
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const readPlaybackPosition = jest.fn(() => 10);
  usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { id: "one", title: "Song" },
    currentTime: 10, duration: 200, isPlaying: true, readPlaybackPosition });
  const togglePlay = usePlayer().togglePlay;
  try {
    const view = render(<MemoryRouter><Player /></MemoryRouter>);
    expect(schedule).toHaveBeenCalledTimes(1);
    const progress = screen.getByRole("slider", { name: "Song progress" });
    expect(progress.valueAsNumber).toBe(5);
    act(() => setDesktopForeground(false));
    expect(cancel).toHaveBeenCalledWith(17);
    schedule.mockClear();
    readPlaybackPosition.mockClear();
    usePlayer.mockReturnValue({ ...usePlayer(), currentTime: 40 });
    view.rerender(<MemoryRouter><Player /></MemoryRouter>);
    expect(schedule).not.toHaveBeenCalled();
    expect(readPlaybackPosition).not.toHaveBeenCalled();
    expect(progress.valueAsNumber).toBe(5);
    readPlaybackPosition.mockReturnValue(40);
    act(() => setDesktopForeground(true));
    expect(progress.valueAsNumber).toBe(20);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(togglePlay).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    setDesktopForeground(null);
    schedule.mockRestore();
    cancel.mockRestore();
  }
});

test("desktop playback updates the scrubber once per second without a frame loop", () => {
  window.__MUSICDECK_DESKTOP__ = true;
  const schedule = jest.spyOn(window, "requestAnimationFrame");
  const listeners = new Set();
  let position = 10;
  const idleTimer = { status: "idle" };
  const audioEngine = {
    sleepTimer: { subscribe: () => () => {}, getSnapshot: () => idleTimer },
    on: jest.fn((event, listener) => {
      expect(event).toBe("timeUpdate");
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const advance = (seconds) => act(() => {
    position = seconds;
    listeners.forEach(listener => listener({ position }));
  });
  usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { id: "one", title: "Song" },
    currentTime: 10, duration: 200, isPlaying: true, audioEngine, readPlaybackPosition: () => position });
  try {
    const view = render(<MemoryRouter><Player /></MemoryRouter>);
    const progress = screen.getByRole("slider", { name: "Song progress" });
    expect(progress.valueAsNumber).toBe(5);
    advance(10.75);
    expect(progress.valueAsNumber).toBe(5);
    advance(11.25);
    expect(progress.valueAsNumber).toBeCloseTo(5.625);
    expect(schedule).not.toHaveBeenCalled();

    act(() => setDesktopForeground(false));
    expect(listeners.size).toBe(0);
    advance(20);
    expect(progress.valueAsNumber).toBeCloseTo(5.625);
    act(() => setDesktopForeground(true));
    expect(progress.valueAsNumber).toBe(10);
    view.unmount();
    expect(listeners.size).toBe(0);
  } finally {
    delete window.__MUSICDECK_DESKTOP__;
    setDesktopForeground(null);
    schedule.mockRestore();
  }
});

test("audio quality sits beside the song title and devices sit beside Queue with Cast inside the centred dialog", () => {
  usePlayer.mockReturnValue({ ...usePlayer(), currentSong: { id: "one", title: "Song" } });
  const cast = { supported: true, allowed: true, available: false, connected: false, device: "", loading: false, error: "", volume: null,
    connect: jest.fn(), disconnect: jest.fn() };
  const { container } = render(<MemoryRouter><RemoteSessionContext.Provider value={null}><CastContext.Provider value={cast}>
    <Player />
  </CastContext.Provider></RemoteSessionContext.Provider></MemoryRouter>);
  const right = container.querySelector(".player-right");
  expect(right).toContainElement(screen.getByRole("button", { name: "Open queue sidebar" }));
  const controls = within(screen.getByRole("group", { name: "Playback devices" }));
  expect(right).toContainElement(controls.getByRole("button", { name: "Choose playback device" }));
  expect(container.querySelector(".now-title")).toContainElement(screen.getByRole("button", { name: /Audio quality/ }));
  expect(right).not.toContainElement(screen.getByRole("button", { name: /Audio quality/ }));
  expect(container.querySelector(".now-title")).not.toContainElement(screen.getByRole("button", { name: "Choose playback device" }));
  expect(screen.queryByRole("button", { name: "Cast to a speaker" })).not.toBeInTheDocument();
  fireEvent.click(controls.getByRole("button", { name: "Choose playback device" }));
  const dialog = screen.getByRole("dialog", { name: "Choose where it plays." });
  expect(dialog.closest(".remote-device-backdrop")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Cast to a speaker" })).toBeInTheDocument();
  expect(cast.connect).not.toHaveBeenCalled();
});

test("the mobile player exposes the device picker beside Now Playing", () => {
  const cast = { supported: true, allowed: true, available: false, connected: false, device: "", loading: false, error: "", volume: null,
    connect: jest.fn(), disconnect: jest.fn() };
  const { container } = render(<MemoryRouter><CastContext.Provider value={cast}>
    <Player mobile />
  </CastContext.Provider></MemoryRouter>);
  const picker = screen.getByRole("button", { name: "Choose playback device" });
  expect(container.querySelector(".player-audio-tools-mobile")).toContainElement(picker);
  fireEvent.click(picker);
  expect(screen.getByRole("dialog", { name: "Choose where it plays." })).toBeInTheDocument();
});
