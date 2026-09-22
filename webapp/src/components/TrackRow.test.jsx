import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import TrackRow from "./TrackRow";


const mockTogglePlay = jest.fn();
const mockDownloadToDevice = jest.fn();
const mockIsDownloadedToDevice = jest.fn();
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
  downloadToDevice: (...args) => mockDownloadToDevice(...args),
  isDownloadedToDevice: (...args) => mockIsDownloadedToDevice(...args),
}));

jest.mock("./TrackDownloadButton", () => () => <span data-testid="download" />);
jest.mock("./TrackDownloadStatus", () => () => <span data-testid="download-status" />);
jest.mock("./TrackLikeButton", () => () => <button type="button">Like</button>);
jest.mock("./SourceMenu", () => () => <button type="button">Sources</button>);


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
  mockIsDownloadedToDevice.mockReset();
  mockIsDownloadedToDevice.mockResolvedValue(false);
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

  fireEvent.click(screen.getByText("Download to Device").closest("button"));

  await waitFor(() => {
    expect(mockDownloadToDevice).toHaveBeenCalledWith("track-1", "320kbps");
    expect(screen.getByText("320 kbps • Downloaded")).toBeInTheDocument();
  });
});
