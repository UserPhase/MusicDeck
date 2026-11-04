import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { memo, Profiler, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { PlayerItemStateProvider } from "../context/PlayerItemState";
import * as playerItems from "../context/PlayerItemState";
import TrackRow from "./TrackRow";
import VirtualizedTrackList from "./VirtualizedTrackList";
import { readOfflineTrack } from "../utils/downloadManager";

jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../utils/downloadManager", () => ({
  isDeviceDownloadPending: () => false,
  subscribeDeviceDownload: () => () => {},
  readOfflineTrack: jest.fn(),
  deleteOfflineTrack: jest.fn(() => Promise.resolve()),
  describeOfflineRecordProblem: (...args) => jest.requireActual("../utils/downloadManager").describeOfflineRecordProblem(...args),
  OfflineDownloadError: class OfflineDownloadError extends Error {},
  downloadToDevice: jest.fn(),
}));

const songs = Array.from({ length: 17 }, (_, index) => ({
  id: String(index + 444), title: `Song ${index + 444}`, artist: "Artist",
  duration: 120, isDownloaded: true,
}));
const play = () => {};

test("real row subtrees isolate favorites, playback changes and device-download events", async () => {
  readOfflineTrack.mockResolvedValue(null);
  const onRender = jest.fn();
  const rowRenders = jest.spyOn(playerItems, "useTrackPlayer");
  const Rows = memo(function Rows() {
    return songs.map((song, index) => <Profiler key={song.id} id={song.id} onRender={onRender}>
      <TrackRow song={song} index={index} onPlay={play} />
    </Profiler>);
  });
  function Harness() {
    const [likes, setLikes] = useState(new Set());
    const [current, setCurrent] = useState(songs[8]);
    return <PlayerItemStateProvider value={{
      currentSong: current, isPlaying: true, likedSongIds: likes,
      togglePlay: play,
    }}>
      <button onClick={() => setLikes(new Set([songs[8].id]))}>Like current track</button>
      <button onClick={() => setCurrent(songs[9])}>Next</button>
      <Rows />
    </PlayerItemStateProvider>;
  }
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await waitFor(() => expect(readOfflineTrack).toHaveBeenCalledTimes(17));
  onRender.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Like current track" }));
  expect(onRender).not.toHaveBeenCalled();
  onRender.mockClear();
  rowRenders.mockClear();
  fireEvent.click(screen.getByText("Next"));
  expect([...new Set(onRender.mock.calls.map(([id]) => id))].sort()).toEqual(["452", "453"]);
  expect(rowRenders.mock.calls.map(([id]) => id).sort()).toEqual(["452", "453"]);
  onRender.mockClear();
  readOfflineTrack.mockImplementation(async (id) => (id === "452"
    ? { trackId: "452", quality: "320kbps", size: 5, blob: new Blob(["audio"]) }
    : null));
  act(() => window.dispatchEvent(new CustomEvent("musicdeck:offline-download", { detail: { trackId: "452" } })));
  // The auditor verifies the stored file before the row updates; only #452 may re-render.
  await waitFor(() => expect(onRender).toHaveBeenCalled());
  expect([...new Set(onRender.mock.calls.map(([id]) => id))]).toEqual(["452"]);
  rowRenders.mockRestore();
});

test("10,000 real track rows retain fewer than 700 DOM elements across a large scroll jump", async () => {
  readOfflineTrack.mockResolvedValue(null);
  const largeLibrary = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index), title: `Library Song ${index}`, artist: "Artist",
    duration: 120, isDownloaded: true,
  }));
  const { container, unmount } = render(<MemoryRouter>
    <PlayerItemStateProvider value={{}}>
      <VirtualizedTrackList itemCount={10000} getItem={(index) => largeLibrary[index]} onPlay={play} />
    </PlayerItemStateProvider>
  </MemoryRouter>);
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(14);
  expect(container.querySelectorAll("*").length).toBeLessThan(600);
  const bounds = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { top: this.classList.contains("virtual-track-window") ? -64000 : 0,
      height: 64, width: 1000, bottom: 64, left: 0, right: 1000, x: 0, y: 0, toJSON() {} };
  });
  fireEvent.scroll(window);
  await waitFor(() => expect(screen.getByText("Library Song 1000")).toBeInTheDocument());
  expect(screen.queryByText("Library Song 0")).not.toBeInTheDocument();
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(18);
  expect(container.querySelectorAll("*").length).toBeLessThan(700);
  unmount();
  bounds.mockRestore();
});
