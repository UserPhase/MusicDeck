import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  AuthProvider,
} from "./AuthContext";

import {
  PlayerProvider,
  usePlayer,
} from "./PlayerContext";

import {
  getCurrentSession,
  getRecentlyPlayed,
  getRandomSongs,
  getStarred,
  getStreamUrl,
  getUserSettings,
  getSilenceAnalysis,
  getPlayableSources,
  recordRecentlyPlayed,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  getCurrentSession: jest.fn(),
  getRecentlyPlayed: jest.fn(),
  getRandomSongs: jest.fn(),
  getStarred: jest.fn(),
  getStreamUrl: jest.fn(),
  getUserSettings: jest.fn(),
  getSilenceAnalysis: jest.fn(),
  getPlayableSources: jest.fn(),
  recordRecentlyPlayed: jest.fn(),
  starSong: jest.fn(),
  unstarSong: jest.fn(),
}));


const songs = [
  { id: "song-1", title: "Song one" },
  { id: "song-2", title: "Song two" },
  { id: "song-3", title: "Song three" },
];

const playlistSongs = [
  { id: "playlist-1", title: "Playlist one" },
  { id: "playlist-2", title: "Playlist two" },
];

const catalogSong = {
  id: "external_deezer_42",
  title: "Catalog only",
  source: { kind: "external" },
  availability: { libraryAvailable: false },
};

const previewSource = {
  id: "playable_preview",
  type: "preview",
  provider: "external",
  availability: "available",
  quality: { codec: "MP3", lossless: false, durationSeconds: 30 },
};


function PlayerHarness() {
  const {
    playSong,
    playSongFromSource,
    playQueue,
    nextSong,
    previousSong,
    queue,
    queueIndex,
    isPreview,
    previewDurationSeconds,
    playbackUnavailable,
  } = usePlayer();

  return (
    <>
      <button onClick={() => playSong(songs[0])}>
        direct
      </button>
      <button onClick={() => playSongFromSource(songs[0], { id: "playable_external", type: "external" })}>
        external
      </button>
      <button onClick={() => playSong(catalogSong)}>
        catalog
      </button>
      <button onClick={() => playQueue(songs, 1)}>
        album
      </button>
      <button onClick={() => playQueue(playlistSongs, 1)}>
        playlist
      </button>
      <button onClick={() => playQueue([], 0)}>
        empty
      </button>
      <button onClick={nextSong}>
        next
      </button>
      <button onClick={previousSong}>
        previous
      </button>
      <div data-testid="queue">
        {queue.map((song) => song.id).join(",")}
      </div>
      <div data-testid="queue-index">
        {queueIndex}
      </div>
      <div data-testid="is-preview">
        {String(isPreview)}
      </div>
      <div data-testid="preview-duration">
        {String(previewDurationSeconds)}
      </div>
      <div data-testid="unavailable">
        {String(playbackUnavailable)}
      </div>
    </>
  );
}


function renderPlayer() {
  getCurrentSession.mockResolvedValue({
    authenticated: true,
    user: {
      id: "user-1",
      username: "test-user",
      displayName: "Test User",
      role: "user",
    },
  });

  getRandomSongs.mockResolvedValue([]);
  getRecentlyPlayed.mockResolvedValue([]);
  getStarred.mockResolvedValue([]);
  getUserSettings.mockResolvedValue([]);
  getSilenceAnalysis.mockResolvedValue(null);
  getPlayableSources.mockResolvedValue({ sources: [], selectedSource: null });
  recordRecentlyPlayed.mockResolvedValue(undefined);
  getStreamUrl.mockImplementation(
    (songId) => `/stream/${songId}`
  );
  HTMLMediaElement.prototype.play = jest.fn(
    () => Promise.resolve()
  );
  HTMLMediaElement.prototype.pause = jest.fn();

  return render(
    <AuthProvider>
      <PlayerProvider>
        <PlayerHarness />
      </PlayerProvider>
    </AuthProvider>
  );
}


beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});


test("direct playback creates a single-song queue and replaces an old queue", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("album"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "song-1,song-2,song-3"
    );
  });

  fireEvent.click(screen.getByText("direct"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "song-1"
    );
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  });
});

test("selected normalized source reaches the stream URL helper", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("external"));

  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith(
      "song-1",
      expect.objectContaining({ id: "playable_external", type: "external" })
    );
  });
});


test("album queues honor their start index and support next and previous", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("album"));

  await waitFor(() => {
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  });

  fireEvent.click(screen.getByText("next"));

  await waitFor(() => {
    expect(screen.getByTestId("queue-index")).toHaveTextContent("2");
  });

  fireEvent.click(screen.getByText("previous"));

  await waitFor(() => {
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  });
});


test("playlist queues honor their start index", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("playlist"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "playlist-1,playlist-2"
    );
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  });
});


test("empty queues are ignored safely", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("empty"));
  fireEvent.click(screen.getByText("next"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent("");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("-1");
  });
});


test("a library track plays locally without resolving an external source", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("direct"));

  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith("song-1", null);
  });

  expect(getPlayableSources).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-preview")).toHaveTextContent("false");
  expect(screen.getByTestId("unavailable")).toHaveTextContent("false");
});


test("a track missing from the library transparently plays an external preview", async () => {
  renderPlayer();

  getPlayableSources.mockResolvedValue({
    sources: [previewSource],
    selectedSource: previewSource,
  });

  fireEvent.click(screen.getByText("catalog"));

  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith(
      "external_deezer_42",
      expect.objectContaining({ id: "playable_preview", type: "preview" })
    );
  });

  expect(getPlayableSources).toHaveBeenCalledWith(
    expect.objectContaining({ id: "external_deezer_42" })
  );

  await waitFor(() => {
    expect(screen.getByTestId("is-preview")).toHaveTextContent("true");
  });

  expect(screen.getByTestId("preview-duration")).toHaveTextContent("30");
  expect(screen.getByTestId("unavailable")).toHaveTextContent("false");
});


test("a track with no preview falls back to the unavailable state", async () => {
  renderPlayer();

  getPlayableSources.mockResolvedValue({ sources: [], selectedSource: null });

  fireEvent.click(screen.getByText("catalog"));

  await waitFor(() => {
    expect(screen.getByTestId("unavailable")).toHaveTextContent("true");
  });

  expect(getStreamUrl).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-preview")).toHaveTextContent("false");
});


test("preview playback stops at the preview endpoint", async () => {
  const { container } = renderPlayer();

  getPlayableSources.mockResolvedValue({
    sources: [previewSource],
    selectedSource: previewSource,
  });

  fireEvent.click(screen.getByText("catalog"));

  await waitFor(() => {
    expect(screen.getByTestId("is-preview")).toHaveTextContent("true");
  });

  const audio = container.querySelector("audio");

  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    value: 12,
  });
  HTMLMediaElement.prototype.pause.mockClear();
  fireEvent.timeUpdate(audio);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();

  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    value: 30.5,
  });
  fireEvent.timeUpdate(audio);

  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

