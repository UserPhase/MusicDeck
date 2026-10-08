import { act, fireEvent, render as renderView, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";

import QueueSidebar from "./QueueSidebar";
import { usePlayer } from "../context/PlayerContext";
import { QUEUE_DRAG_THRESHOLD } from "../hooks/useQueueReorder";

jest.mock("../context/PlayerContext", () => ({
  usePlayer: jest.fn(),
}));

function render(view) {
  return renderView(<MemoryRouter>{view}</MemoryRouter>);
}

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  window.PointerEvent = class extends MouseEvent {
    constructor(type, options) {
      super(type, options);
      Object.defineProperties(this, {
        pointerId: { value: options.pointerId ?? 1 },
        pointerType: { value: options.pointerType ?? "mouse" },
        isPrimary: { value: options.isPrimary ?? true },
      });
    }
  };
});

afterAll(() => { window.PointerEvent = originalPointerEvent; });

function inputCapabilities({ coarse = false, primaryCoarse = coarse } = {}) {
  window.matchMedia = jest.fn((query) => ({
    matches: query === "(any-pointer: coarse)" ? coarse : query === "(pointer: coarse)" && primaryCoarse,
    addEventListener: jest.fn(), removeEventListener: jest.fn(),
  }));
}

beforeEach(() => {
  inputCapabilities();
  usePlayer.mockReturnValue({
    playHistory: [
      { id: "history-1", title: "Already Played", artist: "Artist A", duration: 90 },
    ],
    queue: [
      { id: "queue-1", title: "Up Next", artist: "Artist B", duration: 180 },
    ],
  });
});

test("switches between the queue and play-history tabs", () => {
  render(<QueueSidebar isOpen onClose={jest.fn()} />);

  expect(screen.getByRole("heading", { name: "Up next" })).toBeInTheDocument();
  expect(screen.getByText("Up Next")).toBeInTheDocument();
  expect(screen.queryByText("Already Played")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: "Recently Played" }));

  expect(screen.getByRole("heading", { name: "Recently played" })).toBeInTheDocument();
  expect(screen.getByText("Already Played")).toBeInTheDocument();
  expect(screen.queryByText("Up Next")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Recently Played" })).toHaveAttribute("aria-selected", "true");
});

test("shows only tracks after the active queue item", () => {
  usePlayer.mockReturnValue({
    playHistory: [],
    queueIndex: 0,
    queue: [
      { id: "current", title: "Playing Now", artist: "Artist" },
      { id: "next", title: "Actually Next", artist: "Artist" },
    ],
  });

  render(<QueueSidebar isOpen onClose={jest.fn()} />);

  expect(screen.queryByText("Playing Now")).not.toBeInTheDocument();
  expect(screen.getByText("Actually Next")).toBeInTheDocument();
});

const makeSongs = (count, prefix) =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, title: `${prefix} song ${index}`, artist: "Artist" }));

test("caps the queue view at 25 upcoming songs", () => {
  usePlayer.mockReturnValue({ playHistory: [], queueIndex: 0, queue: makeSongs(41, "q") });

  render(<QueueSidebar isOpen onClose={jest.fn()} />);

  expect(screen.getAllByRole("listitem")).toHaveLength(25);
  expect(screen.getByText("q song 25")).toBeInTheDocument();
  expect(screen.queryByText("q song 26")).not.toBeInTheDocument();
  expect(screen.queryByText(/more songs?/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show full queue" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(40);
  fireEvent.click(screen.getByRole("button", { name: "Show fewer tracks" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(25);
});

test("shows the 10 most recent songs and links to full history", () => {
  usePlayer.mockReturnValue({ playHistory: makeSongs(60, "h"), queue: [] });

  render(<QueueSidebar isOpen onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "Recently Played" }));

  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  expect(screen.queryByText("h song 10")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /View full history/ })).toHaveAttribute("href", "/listening-activity?tab=history");
});

test("closes through its dedicated close control", () => {
  const onClose = jest.fn();
  render(<QueueSidebar isOpen onClose={onClose} />);

  fireEvent.click(screen.getByRole("button", { name: "Close queue sidebar" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("does not render while closed", () => {
  const { container } = render(<QueueSidebar isOpen={false} onClose={jest.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

function ReorderableQueue() {
  const [queue, setQueue] = useState([
    { id: "current", title: "Playing" },
    { id: "duplicate", title: "First occurrence" },
    { id: "duplicate", title: "Second occurrence" },
    { id: "last", title: "Last song" },
  ]);
  usePlayer.mockReturnValue({
    queue, queueIndex: 0, playHistory: [],
    moveQueueItem: (from, to) => setQueue((current) => {
      const next = [...current];
      const [song] = next.splice(from, 1);
      next.splice(to, 0, song);
      return next;
    }),
  });
  return <QueueSidebar isOpen onClose={jest.fn()} />;
}

const visibleTitles = () => screen.getAllByRole("listitem").map((row) =>
  row.getAttribute("aria-label").replace(/, upcoming position \d+$/, ""));

function measureRows() {
  const rows = screen.getAllByRole("listitem");
  rows.forEach((row, index) => {
    jest.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: index * 54, bottom: index * 54 + 52, height: 52, left: 0, right: 300, width: 300,
    });
  });
  const list = screen.getByRole("tabpanel");
  jest.spyOn(list, "getBoundingClientRect").mockReturnValue({
    top: 0, bottom: 162, height: 162, left: 0, right: 300, width: 300,
  });
  return rows;
}

function pointerDown(target, y, pointerType = "mouse", extra = {}) {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType, button: 0, clientX: 100, clientY: y, ...extra });
}

function pointerMove(y, pointerType = "mouse", extra = {}) {
  fireEvent.pointerMove(window, { pointerId: 1, pointerType, clientX: 100, clientY: y, ...extra });
}

function pointerUp(y, pointerType = "mouse") {
  fireEvent.pointerUp(window, { pointerId: 1, pointerType, clientX: 100, clientY: y });
}

test("keyboard arrows reorder duplicates and keep focus without right-side arrow buttons", () => {
  render(<ReorderableQueue />);
  const row = screen.getByRole("listitem", { name: "First occurrence, upcoming position 1" });
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowDown" });
  expect(visibleTitles()).toEqual(["Second occurrence", "First occurrence", "Last song"]);
  expect(screen.getByRole("listitem", { name: "First occurrence, upcoming position 2" })).toHaveFocus();
  expect(screen.getByRole("listitem", { name: "First occurrence, upcoming position 2" })).toBe(row);
  expect(screen.getByRole("status")).toHaveTextContent("First occurrence moved to upcoming position 2.");
  fireEvent.keyDown(screen.getByRole("listitem", { name: "Last song, upcoming position 3" }), { key: "ArrowUp" });
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
  fireEvent.keyDown(screen.getByRole("listitem", { name: "Second occurrence, upcoming position 1" }), { key: "ArrowUp" });
  fireEvent.keyDown(screen.getByRole("listitem", { name: "First occurrence, upcoming position 3" }), { key: "ArrowDown" });
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
  expect(screen.queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Recently Played" }));
  expect(screen.queryByRole("button", { name: /Reorder/ })).not.toBeInTheDocument();
});

test("desktop rows drag from song text in both directions without rendering a handle", () => {
  render(<ReorderableQueue />);
  expect(screen.queryByRole("button", { name: /^Reorder/ })).not.toBeInTheDocument();
  const rows = measureRows();
  pointerDown(screen.getByText("First occurrence"), 26);
  pointerMove(150);
  expect(rows[0]).toHaveAttribute("data-dragging", "true");
  expect(rows[2]).toHaveAttribute("data-drop-edge", "after");
  expect(rows[1]).toHaveStyle({ transform: "translateY(-54px)" });
  expect(visibleTitles()).toEqual(["First occurrence", "Second occurrence", "Last song"]);
  pointerUp(150);
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
  const nextRows = measureRows();
  expect(nextRows[2]).toBe(rows[0]);
  pointerDown(nextRows[2], 135);
  pointerMove(20);
  expect(nextRows[0]).toHaveAttribute("data-drop-edge", "before");
  pointerUp(20);
  expect(visibleTitles()).toEqual(["First occurrence", "Second occurrence", "Last song"]);
});

test("requires six pixels of movement and leaves a normal click and context menu alone", () => {
  render(<ReorderableQueue />);
  const [row] = measureRows();
  const click = jest.fn();
  const contextMenu = jest.fn();
  row.addEventListener("click", click);
  row.addEventListener("contextmenu", contextMenu);
  pointerDown(row, 26);
  pointerMove(26 + QUEUE_DRAG_THRESHOLD - 1);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(31);
  fireEvent.click(row);
  expect(click).toHaveBeenCalledTimes(1);
  pointerDown(row, 26, "mouse", { button: 2 });
  pointerMove(150);
  fireEvent.contextMenu(row);
  expect(contextMenu).toHaveBeenCalledTimes(1);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerDown(row, 26);
  pointerMove(26 + QUEUE_DRAG_THRESHOLD);
  expect(row).toHaveAttribute("data-dragging", "true");
  pointerMove(150);
  pointerUp(150);
  fireEvent.click(row);
  expect(click).toHaveBeenCalledTimes(1);
});

test("action buttons, editable content, and modified mouse gestures do not initiate dragging", () => {
  render(<ReorderableQueue />);
  const [row] = measureRows();
  const button = screen.getByRole("button", { name: "Close queue sidebar" });
  pointerDown(button, 26);
  pointerMove(150);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(150);
  expect(visibleTitles()).toEqual(["First occurrence", "Second occurrence", "Last song"]);
  const text = screen.getByText("First occurrence");
  text.setAttribute("contenteditable", "true");
  pointerDown(text, 80);
  pointerMove(150);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(150);
  pointerDown(row, 80, "mouse", { altKey: true });
  pointerMove(150);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(150);
});

test("touch rows allow scrolling, while their labelled handles activate dragging", () => {
  inputCapabilities({ coarse: true });
  render(<ReorderableQueue />);
  const [row] = measureRows();
  const handle = screen.getByRole("button", { name: "Reorder First occurrence, position 1" });
  expect(handle).toHaveAccessibleDescription(/Arrow Up or Arrow Down/);
  pointerDown(row, 26, "touch");
  const scrollGesture = new window.PointerEvent("pointermove", {
    pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100, cancelable: true, bubbles: true,
  });
  fireEvent(window, scrollGesture);
  expect(scrollGesture.defaultPrevented).toBe(false);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(100, "touch");
  pointerDown(handle, 26, "touch");
  pointerMove(29, "touch");
  expect(row).not.toHaveAttribute("data-dragging");
  pointerMove(150, "touch");
  expect(row).toHaveAttribute("data-dragging", "true");
  pointerUp(150, "touch");
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
  expect(screen.getByRole("button", { name: "Reorder First occurrence, position 3" })).toHaveFocus();
});

test("hybrid devices switch handles by input type, not viewport width", () => {
  inputCapabilities({ coarse: true, primaryCoarse: false });
  render(<ReorderableQueue />);
  measureRows();
  expect(screen.queryByRole("button", { name: /^Reorder/ })).not.toBeInTheDocument();
  pointerDown(screen.getByText("First occurrence"), 26, "touch");
  expect(screen.getByRole("button", { name: "Reorder First occurrence, position 1" })).toBeInTheDocument();
  pointerUp(26, "touch");
  pointerDown(screen.getByText("First occurrence"), 26, "mouse");
  expect(screen.queryByRole("button", { name: /^Reorder/ })).not.toBeInTheDocument();
  pointerMove(150);
  pointerUp(150);
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
});

test("touch handles support keyboard movement and focus without swallowing Enter, Space or Tab", () => {
  inputCapabilities({ coarse: true });
  render(<ReorderableQueue />);
  const handle = screen.getByRole("button", { name: "Reorder First occurrence, position 1" });
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(screen.getByRole("button", { name: "Reorder First occurrence, position 2" })).toBe(handle);
  expect(handle).toHaveFocus();
  for (const key of ["Enter", " ", "Tab"]) {
    expect(fireEvent.keyDown(handle, { key })).toBe(true);
  }
  expect(visibleTitles()).toEqual(["Second occurrence", "First occurrence", "Last song"]);
});

test.each(["history", "close"])("switching to %s cancels dragging and cleans up its listeners", (destination) => {
  const queue = makeSongs(4, "q");
  const moveQueueItem = jest.fn();
  usePlayer.mockReturnValue({ queue, queueIndex: 0, moveQueueItem, playHistory: [] });
  const { rerender } = render(<QueueSidebar isOpen />);
  const [row] = measureRows();
  pointerDown(row, 26);
  pointerMove(150);
  if (destination === "history") fireEvent.click(screen.getByRole("tab", { name: "Recently Played" }));
  else rerender(<MemoryRouter><QueueSidebar isOpen={false} /></MemoryRouter>);
  pointerUp(150);
  expect(moveQueueItem).not.toHaveBeenCalled();
  expect(screen.queryByRole("listitem", { name: /upcoming/ })).not.toBeInTheDocument();
});

test("unrelated pointer events cannot commit the active drag", () => {
  render(<ReorderableQueue />);
  const [row] = measureRows();
  pointerDown(row, 26);
  pointerMove(150, "mouse", { pointerId: 2 });
  expect(row).not.toHaveAttribute("data-dragging");
  pointerMove(150);
  fireEvent.pointerUp(window, { pointerId: 2, clientY: 150 });
  expect(row).toHaveAttribute("data-dragging", "true");
  pointerUp(150);
  expect(visibleTitles()).toEqual(["Second occurrence", "Last song", "First occurrence"]);
});

test.each(["escape", "pointercancel", "blur"])("%s cancels a drag without changing queue order", (reason) => {
  render(<ReorderableQueue />);
  const [row] = measureRows();
  pointerDown(row, 26);
  pointerMove(150);
  if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
  else if (reason === "pointercancel") fireEvent.pointerCancel(window, { pointerId: 1 });
  else fireEvent.blur(window);
  expect(row).not.toHaveAttribute("data-dragging");
  pointerUp(150);
  expect(visibleTitles()).toEqual(["First occurrence", "Second occurrence", "Last song"]);
  expect(screen.getByRole("status")).toHaveTextContent("Queue reorder cancelled.");
});

test("edge dragging auto-scrolls and stops its animation frame on cancellation", () => {
  const frames = [];
  const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  try {
    inputCapabilities({ coarse: true });
    render(<ReorderableQueue />);
    measureRows();
    const list = screen.getByRole("tabpanel");
    Object.defineProperties(list, { scrollHeight: { value: 600 }, clientHeight: { value: 162 } });
    pointerDown(screen.getByRole("button", { name: "Reorder First occurrence, position 1" }), 26, "touch");
    pointerMove(160, "touch");
    act(() => frames.shift()());
    expect(list.scrollTop).toBeGreaterThan(0);
    pointerMove(1, "touch");
    act(() => frames.shift()());
    expect(list.scrollTop).toBe(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).toHaveBeenCalled();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});

test("repeated references to the same song retain independent occurrence keys", () => {
  const song = { id: "same", title: "Same track" };
  function IdenticalOccurrences() {
    const [queue, setQueue] = useState([{ id: "current" }, song, song, song]);
    usePlayer.mockReturnValue({
      queue, queueIndex: 0,
      moveQueueItem: (from, to) => setQueue((current) => {
        const next = [...current];
        const [entry] = next.splice(from, 1);
        next.splice(to, 0, entry);
        return next;
      }),
    });
    return <QueueSidebar isOpen />;
  }
  render(<IdenticalOccurrences />);
  const [first, second, third] = measureRows();
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(screen.getAllByRole("listitem")).toEqual([second, first, third]);
  expect(first).toHaveFocus();
});

test("ignores a stale drag after the playback queue changes", () => {
  const moveQueueItem = jest.fn();
  const queue = makeSongs(3, "q");
  usePlayer.mockReturnValue({ queue, queueIndex: 0, moveQueueItem });
  const { rerender } = render(<QueueSidebar isOpen />);
  const [row] = measureRows();
  pointerDown(row, 26);
  pointerMove(90);
  usePlayer.mockReturnValue({ queue: [...queue], queueIndex: 1, moveQueueItem });
  rerender(<MemoryRouter><QueueSidebar isOpen /></MemoryRouter>);
  pointerUp(90);
  expect(moveQueueItem).not.toHaveBeenCalled();
});
