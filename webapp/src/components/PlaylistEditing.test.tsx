import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useTrackSelection } from "../hooks/useTrackSelection";
import VirtualizedTrackList from "./VirtualizedTrackList";

jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../api/musicdeck", () => ({ getCoverUrl: () => null }));
jest.mock("../utils/downloadManager", () => ({
  readOfflineTrack: async () => null, isDeviceDownloadPending: () => false,
  subscribeDeviceDownload: () => () => {},
}));
jest.mock("./TrackDownloadButton", () => () => null);

const tracks = Array.from({ length: 5000 }, (_, index) => ({
  id: index % 2 === 0 ? "duplicate-song" : `song-${index}`, title: `Track ${index}`, artist: "Artist",
  artistId: "artist-1", albumId: "album-1", album: "Album",
  playlistItemId: `occurrence-${index}`,
}));
const ids = tracks.map((track) => track.playlistItemId);
let frames: Map<number, FrameRequestCallback>;
const originalResizeObserver = global.ResizeObserver;
const originalRequestFrame = global.requestAnimationFrame;
const originalCancelFrame = global.cancelAnimationFrame;

beforeEach(() => {
  frames = new Map();
  let next = 0;
  global.requestAnimationFrame = (callback) => { frames.set(++next, callback); return next; };
  global.cancelAnimationFrame = (id) => { frames.delete(id); };
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains("virtual-track-window") ? -(this.closest("[data-scroller]")?.scrollTop || 0) : 0;
    return { top, bottom: top + 640, left: 0, right: 1000, x: 0, y: top, width: 1000, height: 640, toJSON() {} };
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
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}
function Harness({ onReorder = jest.fn(), disabled = false }) {
  const selection = useTrackSelection(ids, "playlist");
  return <MemoryRouter><div data-scroller style={{ height: 640, overflowY: "auto" }}>
    <output aria-label="Selected count">{selection.selectedCount}</output>
    <VirtualizedTrackList itemCount={tracks.length} getItem={(index) => tracks[index]}
      getItemKey={(index) => ids[index]} dataKey="playlist" onPlay={() => {}}
      selection={selection} onReorder={onReorder} editingDisabled={disabled} />
  </div></MemoryRouter>;
}
function transfer() {
  return { setData: jest.fn(), setDragImage: jest.fn(), effectAllowed: "all", dropEffect: "none" };
}
function dragEvent(type: "dragOver" | "drop", target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, clientY: number) {
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(target, event);
}

test("range selection crosses unmounted indices and Select All stays virtualized", async () => {
  const { container } = render(<Harness />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("row", { name: "Track 0 by Artist" }));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Reorder/ })).not.toBeInTheDocument();
  const parent = container.querySelector<HTMLElement>("[data-scroller]")!;
  parent.scrollTop = 1000 * 64;
  fireEvent.scroll(parent);
  flushFrames();
  fireEvent.click(screen.getByRole("row", { name: "Track 1000 by Artist" }), { shiftKey: true });
  expect(screen.getByLabelText("Selected count")).toHaveTextContent("1001");
  fireEvent.keyDown(screen.getByRole("row", { name: "Track 1000 by Artist" }), { key: "a", ctrlKey: true });
  expect(screen.getByLabelText("Selected count")).toHaveTextContent("5000");
  expect(container.querySelectorAll(".track").length).toBeLessThan(25);
  await act(async () => {});
});

test("group drag survives source virtualization, computes offscreen boundaries and autoscrolls", async () => {
  const onReorder = jest.fn();
  const { container } = render(<Harness onReorder={onReorder} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("row", { name: "Track 0 by Artist" }));
  fireEvent.click(screen.getByRole("row", { name: "Track 2 by Artist" }), { ctrlKey: true });
  const row = screen.getByRole("row", { name: "Track 0 by Artist" });
  const dataTransfer = transfer();
  fireEvent.dragStart(row.querySelector(".track-title-text")!, { dataTransfer });
  expect(dataTransfer.effectAllowed).toBe("move");
  expect(document.querySelector(".track-drag-feedback")).toHaveTextContent("Moving 2 tracks");
  const parent = container.querySelector<HTMLElement>("[data-scroller]")!;
  parent.scrollTop = 800 * 64;
  fireEvent.scroll(parent);
  flushFrames();
  expect(row).toBeInTheDocument();
  expect(row.closest("[data-slot]")).toHaveStyle({ position: "absolute" });
  const list = container.querySelector<HTMLElement>(".virtual-track-window")!;
  dragEvent("dragOver", list, dataTransfer, 638);
  flushFrames();
  expect(parent.scrollTop).toBeGreaterThan(800 * 64);
  expect(container.querySelector(".track-drop-marker")).toBeInTheDocument();
  dragEvent("dragOver", list, dataTransfer, 300);
  const previousMarker = parseFloat(container.querySelector<HTMLElement>(".track-drop-marker")!.style.top);
  parent.scrollTop += 640;
  fireEvent.scroll(parent);
  flushFrames();
  expect(parseFloat(container.querySelector<HTMLElement>(".track-drop-marker")!.style.top)).toBeGreaterThan(previousMarker);
  const boundary = Math.floor((parent.scrollTop + 100) / 64) + ((parent.scrollTop + 100) % 64 >= 32 ? 1 : 0);
  dragEvent("drop", list, dataTransfer, 100);
  expect(onReorder).toHaveBeenCalledWith(["occurrence-0", "occurrence-2"], boundary);
  expect(document.querySelector(".track-drag-feedback")).not.toBeInTheDocument();
  expect(container.querySelectorAll(".track").length).toBeLessThan(25);
  await act(async () => {});
});

test("external drags are ignored; Alt+arrows reorder and Escape clears selection", async () => {
  const onReorder = jest.fn();
  const { container, rerender } = render(<Harness onReorder={onReorder} />);
  await act(async () => {});
  const list = container.querySelector<HTMLElement>(".virtual-track-window")!;
  dragEvent("drop", list, transfer(), 300);
  expect(onReorder).not.toHaveBeenCalled();
  const row = screen.getByRole("row", { name: "Track 2 by Artist" });
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "ArrowUp", altKey: true });
  expect(onReorder).toHaveBeenCalledWith(["occurrence-2"], 1);
  fireEvent.keyDown(row, { key: "Escape" });
  expect(screen.getByLabelText("Selected count")).toHaveTextContent("0");
  rerender(<Harness onReorder={onReorder} disabled />);
  expect(row).toHaveAttribute("draggable", "false");
  fireEvent.keyDown(screen.getByRole("row", { name: "Track 2 by Artist" }), { key: "a", ctrlKey: true });
  expect(screen.getByLabelText("Selected count")).toHaveTextContent("0");
  await act(async () => {});
});

test.each([".track-title-text", ".track-number", ".track-duration", ".track-row-actions"])(
  "a drag from %s moves the row without needing a handle or prior selection", async (selector) => {
    const onReorder = jest.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    await act(async () => {});
    const row = screen.getByRole("row", { name: "Track 2 by Artist" });
    const dataTransfer = transfer();
    fireEvent.pointerDown(row.querySelector(selector)!);
    fireEvent.dragStart(row.querySelector(selector)!, { dataTransfer });
    expect(screen.getByLabelText("Selected count")).toHaveTextContent("1");
    expect(document.querySelector(".track-drag-feedback")).toHaveTextContent("Moving 1 track");
    dragEvent("drop", container.querySelector<HTMLElement>(".virtual-track-window")!, dataTransfer, 300);
    expect(onReorder).toHaveBeenCalledWith(["occurrence-2"], 5);
    await act(async () => {});
  },
);

test.each([".track-artist", ".track-album-link", ".track-play", ".track-menu"])(
  "links and buttons (%s) cannot initiate a row drag", async (selector) => {
    const onReorder = jest.fn();
    const { container } = render(<Harness onReorder={onReorder} />);
    await act(async () => {});
    const row = screen.getByRole("row", { name: "Track 0 by Artist" });
    const control = row.querySelector(selector)!;
    const dataTransfer = transfer();
    fireEvent.pointerDown(control);
    // Browsers can report the ancestor as the drag source, even when the
    // initial press was on a nested control. Neither event may move the row.
    expect(fireEvent.dragStart(row, { dataTransfer })).toBe(false);
    expect(fireEvent.dragStart(control, { dataTransfer })).toBe(false);
    dragEvent("drop", container.querySelector<HTMLElement>(".virtual-track-window")!, dataTransfer, 300);
    expect(onReorder).not.toHaveBeenCalled();
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    expect(document.querySelector(".track-drag-feedback")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Selected count")).toHaveTextContent("0");
    // A subsequent press on the row can still drag normally.
    fireEvent.pointerDown(row);
    fireEvent.dragStart(row, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("move");
    fireEvent.dragEnd(row);
    await act(async () => {});
  },
);

test("busy playlists cannot begin a drag", async () => {
  const onReorder = jest.fn();
  const { container } = render(<Harness onReorder={onReorder} disabled />);
  await act(async () => {});
  const row = screen.getByRole("row", { name: "Track 0 by Artist" });
  const dataTransfer = transfer();
  expect(row).toHaveAttribute("draggable", "false");
  expect(fireEvent.dragStart(row, { dataTransfer })).toBe(false);
  dragEvent("drop", container.querySelector<HTMLElement>(".virtual-track-window")!, dataTransfer, 300);
  expect(onReorder).not.toHaveBeenCalled();
  expect(document.querySelector(".track-drag-feedback")).not.toBeInTheDocument();
});
