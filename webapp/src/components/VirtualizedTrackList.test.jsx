import { act, fireEvent, render, screen } from "@testing-library/react";
import { memo, useRef, useState } from "react";
import { updateViewState, useRouteScrollRestoration } from "../hooks/useViewStateStore";
import { PlayerItemStateProvider } from "../context/PlayerItemState";
import VirtualizedTrackList from "./VirtualizedTrackList";
import AlbumGrid from "./AlbumGrid";
import { MemoryRouter } from "react-router-dom";

const mockRowRenders = new Map();
jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../api/musicdeck", () => ({ getCoverUrl: (id) => `/cover/${id}` }));
jest.mock("./TrackRow", () => {
  const React = require("react");
  const { useTrackPlayer, useTrackFavorite } = require("../context/PlayerItemState");
  return { __esModule: true, default: React.memo(function Row({ song, index }) {
    const playback = useTrackPlayer(song.id);
    const favorite = useTrackFavorite(song.id);
    mockRowRenders.set(song.id, (mockRowRenders.get(song.id) || 0) + 1);
    return <div className="track" role="row" tabIndex={0} aria-rowindex={index + 2}>
      {song.title}
      <span>{playback.isPlaying ? "playing" : ""}</span>
      <button aria-label={`Favorite ${song.id}`} aria-pressed={favorite.isLiked}
        onClick={() => favorite.toggleLikeSong(song)}>Favorite</button>
    </div>;
  }) };
});

let observers;
let frameCallbacks;
let measuredHeight;
const originalResizeObserver = global.ResizeObserver;
const originalRequestFrame = global.requestAnimationFrame;
const originalCancelFrame = global.cancelAnimationFrame;

beforeEach(() => {
  mockRowRenders.clear();
  observers = [];
  frameCallbacks = new Map();
  measuredHeight = 80;
  let nextFrame = 0;
  global.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frameCallbacks.set(id, callback);
    return id;
  };
  global.cancelAnimationFrame = (id) => frameCallbacks.delete(id);
  global.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const scroller = this.closest("[data-scroller]");
    return {
      top: this.classList.contains("virtual-track-window") || this.classList.contains("virtual-album-window")
        ? -(scroller?.scrollTop || 0) : 0,
      height: this.hasAttribute("data-slot") ? measuredHeight : 640,
      width: 1000, bottom: 640, left: 0, right: 1000, x: 0, y: 0, toJSON() {},
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  global.ResizeObserver = originalResizeObserver;
  global.requestAnimationFrame = originalRequestFrame;
  global.cancelAnimationFrame = originalCancelFrame;
});

function flushFrames() {
  act(() => {
    const batch = [...frameCallbacks.values()];
    frameCallbacks.clear();
    batch.forEach((callback) => callback(0));
  });
}
const tracks = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), title: `Track ${index}` }));
const getItem = (index) => tracks[index];
const play = () => {};
const Scroller = ({ children }) => <div data-scroller style={{ overflowY: "auto", height: 640 }}>{children}</div>;

function RestoredScroller() {
  const ref = useRef(null);
  useRouteScrollRestoration(ref);
  return <div ref={ref} data-scroller style={{ overflowY: "auto", height: 640 }}>
    <VirtualizedTrackList itemCount={10000} getItem={getItem} onPlay={play} />
  </div>;
}

test("route restoration mounts the destination virtual rows synchronously before an animation frame", () => {
  updateViewState("anonymous", "/library/tracks", { scrollPosition: 64000.25 });
  const { container } = render(<MemoryRouter initialEntries={["/library/tracks"]}><RestoredScroller /></MemoryRouter>);
  expect(container.querySelector("[data-scroller]").scrollTop).toBe(64000.25);
  expect(screen.getByText("Track 1000")).toBeInTheDocument();
  expect(screen.queryByText("Track 0")).not.toBeInTheDocument();
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(17);
});

test("10,000 tracks mount only the viewport and 2–3 overscan rows, even after a large jump", () => {
  const onRangeChange = jest.fn();
  const { container, unmount } = render(<Scroller>
    <VirtualizedTrackList itemCount={10000} getItem={getItem} onPlay={play} onRangeChange={onRangeChange} />
  </Scroller>);
  expect(screen.getAllByRole("row").length).toBe(12);
  const scroller = container.querySelector("[data-scroller]");
  act(() => { scroller.scrollTop = 64000; fireEvent.scroll(scroller); });
  flushFrames();
  expect(screen.getAllByRole("row").length).toBe(16);
  expect(screen.getByText("Track 1000")).toBeInTheDocument();
  expect(screen.queryByText("Track 0")).not.toBeInTheDocument();
  expect(onRangeChange).toHaveBeenLastCalledWith(997, 1013);
  const window = container.querySelector(".virtual-track-window");
  const spacers = [...window.children].filter((element) => element.hasAttribute("aria-hidden"));
  expect(spacers.reduce((sum, element) => sum + parseFloat(element.style.height), 0) +
    container.querySelectorAll("[data-slot]").length * 64).toBe(640000);
  unmount();
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  expect(frameCallbacks.size).toBe(0);
});

test("favorite #452 renders only #452; playback ticks render zero rows", () => {
  const readItem = jest.fn(getItem);
  const List = memo(() => <VirtualizedTrackList itemCount={10000} getItem={readItem} onPlay={play} />);
  function Harness() {
    const [likes, setLikes] = useState(new Set());
    const [tick, setTick] = useState(0);
    return <PlayerItemStateProvider value={{
      currentSong: tracks[452], isPlaying: true, likedSongIds: likes, currentTime: tick,
      toggleLikeSong: (song) => setLikes((current) => new Set([...current, song.id])),
    }}>
      <button onClick={() => setTick((value) => value + 1)}>Tick</button>
      <Scroller><List /></Scroller>
    </PlayerItemStateProvider>;
  }
  const { container } = render(<Harness />);
  const scroller = container.querySelector("[data-scroller]");
  act(() => { scroller.scrollTop = 450 * 64; fireEvent.scroll(scroller); });
  flushFrames();
  mockRowRenders.clear();
  readItem.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Favorite 452" }));
  expect([...mockRowRenders.entries()]).toEqual([["452", 1]]);
  expect(readItem).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Favorite 452" })).toHaveAttribute("aria-pressed", "true");
  mockRowRenders.clear();
  fireEvent.click(screen.getByText("Tick"));
  expect(mockRowRenders.size).toBe(0);
  expect(readItem).not.toHaveBeenCalled();
});

test("uncached slots keep their height and expose loading placeholders", () => {
  const { container } = render(<Scroller><VirtualizedTrackList itemCount={10000}
    getItem={() => undefined} onPlay={play} /></Scroller>);
  expect(screen.getAllByRole("row").length).toBe(12);
  expect(screen.getByLabelText("Loading track 1")).toHaveAttribute("aria-busy", "true");
  const last = container.querySelector(".virtual-track-window").lastElementChild;
  expect(parseFloat(last.style.height)).toBe(640000 - 12 * 64);
});

test("dynamic heights are measured and resize corrections preserve the visible anchor", () => {
  const { container, unmount } = render(<Scroller><VirtualizedTrackList itemCount={10000}
    getItem={getItem} onPlay={play} dynamicHeight /></Scroller>);
  const scroller = container.querySelector("[data-scroller]");
  act(() => { scroller.scrollTop = 400; fireEvent.scroll(scroller); });
  flushFrames();
  const before = scroller.scrollTop;
  measuredHeight = 100;
  act(() => {
    observers.filter((observer) => [...observer.targets].some((target) => target.hasAttribute("data-slot")))
      .forEach((observer) => observer.callback([]));
  });
  expect(scroller.scrollTop).toBeGreaterThan(before);
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(17);
  unmount();
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
});

test("keyboard End scrolls to and focuses the final virtual row", () => {
  const { container } = render(<Scroller><VirtualizedTrackList itemCount={10000}
    getItem={getItem} onPlay={play} /></Scroller>);
  const row = screen.getAllByRole("row")[0];
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "End" });
  flushFrames();
  expect(document.activeElement).toHaveTextContent("Track 9999");
  expect(container.querySelectorAll("[data-slot]").length).toBeLessThanOrEqual(17);
});

test("2,000 albums render only visible matrix rows and lazy, dimensioned images", () => {
  const albums = Array.from({ length: 2000 }, (_, index) => ({
    id: String(index), name: `Album ${index}`, coverArt: String(index), artist: "Artist",
  }));
  const { container } = render(<MemoryRouter><Scroller>
    <AlbumGrid itemCount={2000} getItem={(index) => albums[index]} />
  </Scroller></MemoryRouter>);
  expect(container.querySelectorAll(".virtual-album-row").length).toBeLessThanOrEqual(5);
  expect(container.querySelectorAll(".album-card-shell").length).toBeLessThanOrEqual(25);
  const image = screen.getAllByRole("img")[0];
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("decoding", "async");
  expect(image).toHaveAttribute("width", "180");
  expect(image).toHaveAttribute("src", "/cover/0");
  // A failed cover advances to the metadata fallback rather than disappearing.
  fireEvent.error(image);
  expect(image).toHaveAttribute("src", "/api/metadata/album-artwork?artist=Artist&album=Album+0");
  const scroller = container.querySelector("[data-scroller]");
  act(() => { scroller.scrollTop = 30000; fireEvent.scroll(scroller); });
  flushFrames();
  expect(container.querySelectorAll(".album-card-shell").length).toBeLessThanOrEqual(45);
  expect(screen.queryByText("Album 0")).not.toBeInTheDocument();
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
  act(() => observers.filter((observer) =>
    [...observer.targets].some((target) => target.classList.contains("virtual-album-window")))
    .forEach((observer) => observer.callback([])));
  flushFrames();
  expect(container.querySelector(".virtual-album-row").style.gridTemplateColumns)
    .toBe("repeat(2, minmax(0, 1fr))");
  expect(container.querySelectorAll(".album-card-shell").length).toBeLessThanOrEqual(18);
});
