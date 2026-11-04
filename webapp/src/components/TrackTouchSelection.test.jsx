import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TrackRow from "./TrackRow";
import TrackActionScope from "./TrackActionScope";

jest.mock("../context/PlayerContext", () => ({ usePlayer: () => ({}) }));
jest.mock("../services/storage/OfflineAuditor", () => ({ useOfflineAudit: () => ({ status: "missing" }), offlineDisplayStatus: () => "not-downloaded" }));
jest.mock("../utils/downloadManager", () => ({ isDeviceDownloadPending: () => false, subscribeDeviceDownload: () => () => {} }));
jest.mock("./TrackDownloadButton", () => () => null);
jest.mock("./UniversalTrackContextMenu", () => ({ song }) => <div role="menu" data-track-selection-menu="">{song.title}</div>);
const tracks = [
  { id: "a", title: "First", artist: "Artist", artistId: "artist", album: "Album", albumId: "album", source: { kind: "library" } },
  { id: "b", title: "Second", artist: "Artist", album: "Album", source: { kind: "library" } },
];
const point = (x = 20, y = 20, identifier = 1) => ({ clientX: x, clientY: y, identifier });
const start = (element, touches = [point()]) => fireEvent.touchStart(element, { touches });
const advance = (ms) => act(() => jest.advanceTimersByTime(ms));
const row = () => screen.getByRole("row", { name: "First by Artist" });
function Harness({ onPlay = jest.fn(), dataKey = "collection", items = tracks }) {
  return <MemoryRouter><TrackActionScope tracks={items} dataKey={dataKey}>
    <div role="grid">{items.map((song, index) => <TrackRow key={index} song={song} index={index} onPlay={onPlay} />)}</div>
  </TrackActionScope></MemoryRouter>;
}
beforeEach(() => { jest.useFakeTimers(); Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }); });
afterEach(() => { jest.useRealTimers(); });
test("a 500 ms hold enters selection mode, selects once, and suppresses the trailing compatibility click", () => {
  const play = jest.fn(); render(<Harness onPlay={play} />);
  expect(screen.queryByRole("button", { name: "Select tracks" })).not.toBeInTheDocument();
  start(row()); advance(499); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  advance(1); expect(screen.getByLabelText("Select First")).toBeChecked();
  advance(2000); // Releasing a longer hold must still consume its compatibility click.
  fireEvent.touchEnd(row(), { touches: [] }); fireEvent.click(row(), { detail: 1 });
  expect(screen.getByLabelText("Select First")).toBeChecked(); expect(play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("row", { name: "Second by Artist" }));
  expect(screen.getByLabelText("Select Second")).toBeChecked();
  expect(screen.getByText("2 selected")).toBeInTheDocument();
});
test("ordinary taps play and scrolling or moving more than ten pixels cancels a hold", () => {
  const play = jest.fn(); render(<Harness onPlay={play} />);
  start(row()); advance(100); fireEvent.touchEnd(row(), { touches: [] }); fireEvent.click(row()); expect(play).toHaveBeenCalledTimes(1);
  start(row()); advance(300); fireEvent.touchMove(row(), { touches: [point(21, 40)] }); advance(500);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row()); fireEvent.scroll(window); advance(500); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
test("cancelled or multi-touch gestures never select a track", () => {
  render(<Harness />); start(row()); fireEvent.touchCancel(row()); advance(500);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row(), [point(), point(40, 20, 2)]); advance(500); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row()); fireEvent.touchStart(row(), { touches: [point(), point(40, 20, 2)] }); advance(500);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row()); fireEvent.touchStart(screen.getByRole("row", { name: "Second by Artist" }), { touches: [point(), point(40, 20, 2)] }); advance(500);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
test("links retain navigation and their native context menus, including in selection mode", () => {
  const play = jest.fn(); render(<Harness onPlay={play} />);
  const artist = screen.getByRole("link", { name: "Artist" });
  start(artist); advance(600); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.contextMenu(artist); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  start(row()); advance(500);
  fireEvent.touchEnd(row(), { touches: [] });
  fireEvent.click(artist); expect(screen.getByLabelText("Select First")).toBeChecked();
  expect(play).not.toHaveBeenCalled();
});
test("selection mode stays active after the last checkbox clears, and Done returns to normal playback", () => {
  const play = jest.fn(); render(<Harness onPlay={play} />);
  start(row()); advance(500);
  fireEvent.touchEnd(row(), { touches: [] });
  fireEvent.click(screen.getByLabelText("Select First"));
  expect(screen.getByLabelText("Select First")).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Done selecting" }));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); fireEvent.click(row()); expect(play).toHaveBeenCalledTimes(1);
});
test("recycled rows, collection changes and unmounts cancel pending holds", () => {
  const view = render(<Harness />); start(row()); advance(300);
  view.rerender(<Harness items={[{ ...tracks[0], id: "replacement" }, tracks[1]]} />); advance(300);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row()); advance(300); view.rerender(<Harness dataKey="another" />); advance(300);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  start(row()); view.unmount(); expect(() => advance(1000)).not.toThrow();
});
test("holding a menu's non-interactive text never starts a row selection gesture", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "More options for First" }));
  start(screen.getByRole("menu")); advance(600);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
test("a keyboard or assistive click on an inline link is never consumed as a touch compatibility click", () => {
  const play = jest.fn(); render(<Harness onPlay={play} />);
  start(row()); advance(500);
  fireEvent.click(screen.getByRole("link", { name: "Artist" }), { detail: 0 });
  expect(screen.getByLabelText("Select First")).toBeChecked();
  expect(play).not.toHaveBeenCalled();
});
test("Ctrl+A and Escape operate on a focused collection row without requiring playlist-specific handlers", () => {
  render(<Harness />);
  fireEvent.keyDown(row(), { key: "a", ctrlKey: true });
  expect(screen.getByText("2 selected")).toBeInTheDocument();
  fireEvent.keyDown(row(), { key: "Escape" });
  expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
});
test("removing another row preserves the selected track's identity", () => {
  const view = render(<Harness />);
  const second = screen.getByRole("row", { name: "Second by Artist" });
  start(second); advance(500);
  fireEvent.touchEnd(second, { touches: [] });
  view.rerender(<Harness items={[tracks[1]]} />);
  expect(screen.getByLabelText("Select Second")).toBeChecked();
});
