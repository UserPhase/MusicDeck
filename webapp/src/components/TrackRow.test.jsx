import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import TrackRow from "./TrackRow";


const mockTogglePlay = jest.fn();
const mockDownloadToDevice = jest.fn();
const mockReadOfflineTrack = jest.fn();
let mockCurrentSong = null;
let mockIsPlaying = false;

jest.mock("../context/PlayerContext", () => ({
  usePlayer: () => ({
    currentSong: mockCurrentSong,
    downloadQuality: "320kbps",
    isPlaying: mockIsPlaying,
    togglePlay: mockTogglePlay,
  }),
}));

jest.mock("../utils/downloadManager", () => ({
  isDeviceDownloadPending: () => false,
  subscribeDeviceDownload: () => () => {},
  downloadToDevice: (...args) => mockDownloadToDevice(...args),
  readOfflineTrack: (...args) => mockReadOfflineTrack(...args),
  deleteOfflineTrack: jest.fn(() => Promise.resolve()),
  describeOfflineRecordProblem: (...args) => jest.requireActual("../utils/downloadManager").describeOfflineRecordProblem(...args),
  OfflineDownloadError: jest.requireActual("../utils/downloadManager").OfflineDownloadError,
}));

jest.mock("./TrackDownloadButton", () => () => <span data-testid="download" />);


const song = {
  id: "track-1",
  title: "Midnight Signal",
  artist: "MusicDeck",
  artistId: "artist-1",
  album: "Command Center",
  albumId: "album-1",
  duration: 185,
  isDownloaded: true,
};


beforeEach(() => {
  mockCurrentSong = null;
  mockIsPlaying = false;
  mockTogglePlay.mockClear();
  mockDownloadToDevice.mockReset();
  mockDownloadToDevice.mockResolvedValue({ trackId: song.id });
  mockReadOfflineTrack.mockReset();
  mockReadOfflineTrack.mockResolvedValue(null);
});

test("hovering a track does not re-render the row", async () => {
  const onRender = jest.fn();
  const onPlay = jest.fn();
  const { container } = render(
    <MemoryRouter>
      <Profiler id="track" onRender={onRender}>
        <TrackRow song={song} index={0} onPlay={onPlay} />
      </Profiler>
    </MemoryRouter>
  );
  await waitFor(() => expect(mockReadOfflineTrack).toHaveBeenCalled());
  const rendersBeforeHover = onRender.mock.calls.length;
  fireEvent.mouseOver(container.querySelector(".track"));
  expect(onRender).toHaveBeenCalledTimes(rendersBeforeHover);
});

test("links each credited artist to their own page without playing or selecting the track", () => {
  const onPlay = jest.fn();
  const onSelect = jest.fn();
  const collaboration = { ...song, artist: "Earth, Wind & Fire; Guest",
    artistCredits: [{ id: "artist-1", name: "Earth, Wind & Fire" }, { id: "artist-2", name: "Guest" }] };
  render(<MemoryRouter><Routes>
    <Route path="/" element={<TrackRow song={collaboration} index={0} onPlay={onPlay} onSelect={onSelect} />} />
    <Route path="/artist/artist-2" element={<h1>Guest artist page</h1>} />
  </Routes></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Earth, Wind & Fire" })).toHaveAttribute("href", "/artist/artist-1");
  fireEvent.click(screen.getByRole("link", { name: "Guest" }));
  expect(screen.getByRole("heading", { name: "Guest artist page" })).toBeInTheDocument();
  expect(onPlay).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});

test("right-click opens a keyboard-accessible row menu and leaves links' native menus alone", () => {
  const onPlay = jest.fn();
  render(<MemoryRouter><TrackRow song={song} index={0} onPlay={onPlay} /></MemoryRouter>);
  const row = screen.getByRole("row");
  fireEvent.contextMenu(screen.getByRole("link", { name: "MusicDeck" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.contextMenu(row, { clientX: 240, clientY: 160 });
  expect(screen.getByRole("menu", { name: "Actions for Midnight Signal" })).toHaveStyle({ top: "160px" });
  expect(screen.getByRole("menuitem", { name: /Add to Queue/ })).toHaveFocus();
  expect(onPlay).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "More options for Midnight Signal" })).toHaveFocus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});


test("plays a new track from click and keyboard activation", () => {
  const onPlay = jest.fn();
  const { container } = render(
    <MemoryRouter>
      <TrackRow song={song} index={0} onPlay={onPlay} />
    </MemoryRouter>
  );
  const row = container.querySelector(".track");

  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "Enter" });

  expect(onPlay).toHaveBeenCalledTimes(2);
  expect(onPlay).toHaveBeenLastCalledWith(song, 0);
});

test("editable rows select without autoplay; explicit Play, double-click and Enter still play", () => {
  const onPlay = jest.fn();
  const onSelect = jest.fn();
  const { container } = render(<MemoryRouter><TrackRow song={song} index={7} onPlay={onPlay} onSelect={onSelect} selected /></MemoryRouter>);
  const row = container.querySelector(".track");
  fireEvent.click(row, { shiftKey: true });
  expect(onSelect).toHaveBeenLastCalledWith(7, expect.objectContaining({ shiftKey: true }));
  fireEvent.keyDown(row, { key: " ", ctrlKey: true });
  expect(onSelect).toHaveBeenLastCalledWith(7, expect.objectContaining({ ctrlKey: true }));
  expect(onPlay).not.toHaveBeenCalled();
  fireEvent.doubleClick(row);
  fireEvent.keyDown(row, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Play Midnight Signal" }));
  expect(onPlay).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(row).toHaveAttribute("aria-selected", "true");
});


test("toggles the active track without rebuilding its context", () => {
  mockCurrentSong = song;
  mockIsPlaying = true;
  const onPlay = jest.fn();

  render(
    <MemoryRouter>
      <TrackRow song={song} index={0} onPlay={onPlay} />
    </MemoryRouter>
  );

  fireEvent.click(screen.getByRole("button", { name: "Pause Midnight Signal" }));

  expect(mockTogglePlay).toHaveBeenCalledTimes(1);
  expect(onPlay).not.toHaveBeenCalled();
});


test("renders the shared columns and page-specific action menu slot", () => {
  const { container } = render(
    <MemoryRouter>
      <TrackRow
        song={song}
        index={0}
        onPlay={jest.fn()}
        menu={<div role="menu">Custom actions</div>}
        onToggleMenu={jest.fn()}
      />
    </MemoryRouter>
  );

  expect(screen.getByRole("link", { name: "MusicDeck" })).toHaveAttribute("href", "/artist/artist-1");
  expect(screen.getByRole("link", { name: "Command Center" })).toHaveAttribute("href", "/album/album-1");
  expect(screen.getByText("3:05")).toBeInTheDocument();
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(container.querySelector(".track").children).toHaveLength(6);
  expect(screen.queryByTestId("download-status")).not.toBeInTheDocument();
  expect(container.querySelector(".track-server-placeholder")).toHaveTextContent("\u2063");
  expect(screen.getByText("Download to Device").closest("button")).toBeInTheDocument();
  expect(screen.getByText("320 kbps")).toBeInTheDocument();
});


test("downloads a server track for offline playback at the selected quality", async () => {
  render(
    <MemoryRouter>
      <TrackRow
        song={song}
        index={0}
        onPlay={jest.fn()}
        menu={<div />}
        onToggleMenu={jest.fn()}
      />
    </MemoryRouter>
  );

  mockDownloadToDevice.mockImplementation(async () => {
    mockReadOfflineTrack.mockResolvedValue({ trackId: "track-1", quality: "320kbps", size: 5, blob: new Blob(["audio"]) });
    return { trackId: "track-1" };
  });
  fireEvent.click(screen.getByText("Download to Device").closest("button"));

  await waitFor(() => {
    expect(mockDownloadToDevice).toHaveBeenCalledWith("track-1", "320kbps", song);
    expect(screen.getByText("320 kbps • Downloaded")).toBeInTheDocument();
  });
});


test("offers a re-download for a damaged offline copy and explains failures", async () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  const { OfflineDownloadError } = jest.requireActual("../utils/downloadManager");
  const damaged = { ...song, id: "track-damaged", title: "Damaged Signal" };
  // The stored blob is shorter than the recorded size: a truncated download.
  mockReadOfflineTrack.mockResolvedValue({ trackId: "track-damaged", quality: "320kbps", size: 10, blob: new Blob(["short"]) });
  mockDownloadToDevice.mockRejectedValue(new OfflineDownloadError(
    "Not enough storage on this device. Remove some offline downloads and try again.",
    "quota-exceeded"
  ));
  render(
    <MemoryRouter>
      <TrackRow song={damaged} index={0} onPlay={jest.fn()} menu={<div />} onToggleMenu={jest.fn()} />
    </MemoryRouter>
  );

  expect(await screen.findByText("Re-download to Device")).toBeInTheDocument();
  expect(screen.getByText("Offline copy is missing or damaged")).toBeInTheDocument();
  expect(screen.queryByText(/� Downloaded/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("Re-download to Device").closest("button"));
  expect(await screen.findByText(/Not enough storage on this device/)).toBeInTheDocument();
  expect(mockDownloadToDevice).toHaveBeenCalledWith("track-damaged", "320kbps", damaged);
  consoleError.mockRestore();
});
