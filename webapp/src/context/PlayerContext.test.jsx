import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import {
  AuthProvider,
} from "./AuthContext";

import {
  PlayerProvider,
  usePlayer,
} from "./PlayerContext";
import { createQueueSnapshot, queueStorageKey } from "../utils/queuePersistence";

import {
  getCurrentSession,
  getRecentlyPlayed,
  getRandomSongs,
  getStarred,
  getStreamUrl,
  getUserSettings,
  getSilenceAnalysis,
  analyzeSilence,
  getPlayableSources,
  reportPlaybackSession as recordListeningEvent,
  getListeningConfig,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  getCurrentSession: jest.fn(),
  getRecentlyPlayed: jest.fn(),
  getRandomSongs: jest.fn(),
  getStarred: jest.fn(),
  getStreamUrl: jest.fn(),
  getUserSettings: jest.fn(),
  getSilenceAnalysis: jest.fn(),
  analyzeSilence: jest.fn(),
  getPlayableSources: jest.fn(),
  reportPlaybackSession: jest.fn(),
  getListeningConfig: jest.fn(async () => ({ thresholdSeconds: 30 })),
  LISTENING_ACTIVITY_CHANGED_EVENT: "musicdeck:listening-activity-changed",
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

const catalogSongWithPreview = {
  ...catalogSong,
  id: "external_deezer_43",
  previewUrl: "https://cdns-preview-a.dzcdn.net/stream.mp3",
};

const replayGainSong = {
  id: "replay-gain-song",
  title: "Normalized song",
  replayGain: { trackGainDb: -6 },
};

const previewSource = {
  id: "playable_preview",
  type: "preview",
  provider: "external",
  availability: "available",
  quality: { codec: "MP3", lossless: false, durationSeconds: 30 },
};

function audioDecks(container) {
  // Audio elements have no implicit ARIA role to query with Testing Library.
  // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
  return container.querySelectorAll("audio");
}


function PlayerHarness() {
  const {
    playSong,
    playSongFromSource,
    playContext,
    playQueue,
    moveQueueItem,
    nextSong,
    previousSong,
    toggleShuffle,
    isShuffleEnabled,
    toggleLoop,
    isLooping,
    queue,
    queueIndex,
    recentlyPlayed,
    isPreview,
    previewDurationSeconds,
    playbackUnavailable,
    currentSong,
    isPlaying,
    playbackMessage,
    currentTime,
    volume,
    togglePlay,
    crossfadeDuration,
    changeCrossfadeDuration,
    streamQuality,
    changeStreamQuality,
    downloadQuality,
    changeDownloadQuality,
    isReplayGainEnabled,
    changeReplayGainEnabled,
    layoutDensity,
    changeLayoutDensity,
    autoOpenSidebar,
    changeAutoOpenSidebar,
    isAutoplayEnabled,
    changeAutoplayEnabled,
    autoDownloadLiked,
    changeAutoDownloadLiked,
    activeSidebar,
    setActiveSidebar,
  } = usePlayer();

  return (
    <>
      <button onClick={() => playSong(songs[0])}>
        direct
      </button>
      <button onClick={togglePlay}>toggle-play</button>
      <button onClick={() => playSongFromSource(songs[0], { id: "playable_external", type: "external" })}>
        external
      </button>
      <button onClick={() => playSong(catalogSong)}>
        catalog
      </button>
      <button onClick={() => playSong(catalogSongWithPreview)}>
        catalog-with-preview
      </button>
      <button onClick={() => playSong(replayGainSong)}>
        replay-gain-song
      </button>
      <button onClick={() => playQueue(songs, 1)}>
        album
      </button>
      <button onClick={() => playContext(songs, 1, { type: "album", name: "Album" })}>
        context-second
      </button>
      <button onClick={() => playContext(songs, 0, { type: "album", name: "Album" })}>
        context-first
      </button>
      <button onClick={() => playQueue(songs, 0)}>
        album-start
      </button>
      <button onClick={() => playQueue([songs[0], songs[1], songs[0], songs[2]], 0)}>duplicates</button>
      <button onClick={() => moveQueueItem(1, 2)}>move-later</button>
      <button onClick={() => moveQueueItem(2, 1)}>move-earlier</button>
      <button onClick={() => moveQueueItem(3, 1)}>move-last-first</button>
      <button onClick={() => moveQueueItem(3, 2)}>move-last-second</button>
      <button onClick={() => {
        for (const [from, to] of [[0, 1], [1, 0], [-1, 1], [1, 99], [NaN, 1], [1, 1.5], [1, 1]]) moveQueueItem(from, to);
      }}>invalid-moves</button>
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
      <button onClick={toggleShuffle}>
        shuffle
      </button>
      <button onClick={toggleLoop}>
        loop
      </button>
      <button onClick={() => changeCrossfadeDuration(3)}>
        crossfade-three
      </button>
      <button onClick={() => changeStreamQuality("320")}>
        quality-320
      </button>
      <button onClick={() => changeDownloadQuality("256kbps")}>
        download-quality-256
      </button>
      <button onClick={() => changeReplayGainEnabled(true)}>
        enable-replay-gain
      </button>
      <button onClick={() => changeLayoutDensity("compact")}>
        compact-layout
      </button>
      <button onClick={() => changeAutoOpenSidebar(true)}>
        enable-auto-open-sidebar
      </button>
      <button onClick={() => changeAutoplayEnabled(false)}>
        disable-autoplay
      </button>
      <button onClick={() => changeAutoDownloadLiked(true)}>
        enable-auto-download-liked
      </button>
      <button onClick={() => setActiveSidebar("now-playing")}>open-now-playing</button>
      <button onClick={() => setActiveSidebar("queue")}>open-queue</button>
      <button onClick={() => setActiveSidebar("invalid")}>open-invalid</button>
      <div data-testid="active-sidebar">{activeSidebar}</div>
      <div data-testid="shuffle-enabled">
        {String(isShuffleEnabled)}
      </div>
      <div data-testid="loop-enabled">
        {String(isLooping)}
      </div>
      <div data-testid="queue">
        {queue.map((song) => song.id).join(",")}
      </div>
      <div data-testid="queue-index">
        {queueIndex}
      </div>
      <div data-testid="recently-played">
        {recentlyPlayed.map((song) => song.id).join(",")}
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
      <div data-testid="current-song">
        {currentSong?.id || "none"}
      </div>
      <div data-testid="is-playing">
        {String(isPlaying)}
      </div>
      <div data-testid="playback-message">{playbackMessage}</div>
      <div data-testid="current-time">{currentTime}</div>
      <div data-testid="volume">{volume}</div>
      <div data-testid="crossfade-duration">
        {crossfadeDuration}
      </div>
      <div data-testid="stream-quality">
        {streamQuality}
      </div>
      <div data-testid="download-quality">
        {downloadQuality}
      </div>
      <div data-testid="replay-gain-enabled">
        {String(isReplayGainEnabled)}
      </div>
      <div data-testid="layout-density">
        {layoutDensity}
      </div>
      <div data-testid="auto-open-sidebar">
        {String(autoOpenSidebar)}
      </div>
      <div data-testid="autoplay-enabled">
        {String(isAutoplayEnabled)}
      </div>
      <div data-testid="auto-download-liked">
        {String(autoDownloadLiked)}
      </div>
    </>
  );
}


function renderPlayer({
  recentHistory = [],
  userSettings = [],
  silenceAnalysis = null,
  children = <PlayerHarness />,
} = {}) {
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
  getRecentlyPlayed.mockResolvedValue(recentHistory);
  getStarred.mockResolvedValue([]);
  getUserSettings.mockResolvedValue(userSettings);
  getSilenceAnalysis.mockResolvedValue(silenceAnalysis);
  analyzeSilence.mockResolvedValue({
    status: "completed",
    leadingSilenceSeconds: 1.25,
    trailingSilenceSeconds: 0.75,
  });
  getPlayableSources.mockResolvedValue({ sources: [], selectedSource: null });
  recordListeningEvent.mockImplementation(async (payload) => ({
    counted: payload.listenedSeconds >= Math.min(30, payload.durationSeconds || Infinity),
  }));
  getListeningConfig.mockResolvedValue({ thresholdSeconds: 30 });
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
        {children}
      </PlayerProvider>
    </AuthProvider>
  );
}


beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ results: [] }),
  }));
});

test("moves upcoming entries both ways without touching playback, source tracks, or persistence progress", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  const [audio] = audioDecks(container);
  audio.currentTime = 42;
  fireEvent.timeUpdate(audio);
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;
  const streams = getStreamUrl.mock.calls.length;
  fireEvent.click(screen.getByText("move-later"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
  expect(audio.currentTime).toBe(42);
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  expect(getStreamUrl).toHaveBeenCalledTimes(streams);
  expect(songs.map((song) => song.id)).toEqual(["song-1", "song-2", "song-3"]);
  expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1")))).toMatchObject({
    queueTrackIds: ["song-1", "song-3", "song-2"], playbackProgressSeconds: 42,
  });
  fireEvent.click(screen.getByText("invalid-moves"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
  fireEvent.click(screen.getByText("move-earlier"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
});

test("reorders duplicate occurrences by position and Next/Previous follow the reordered sequence", async () => {
  renderPlayer();
  fireEvent.click(screen.getByText("duplicates"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-1,song-3"));
  fireEvent.click(screen.getByText("move-last-first"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2,song-1");
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  fireEvent.click(screen.getByText("previous"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  fireEvent.click(screen.getByText("move-earlier"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,song-1");
});

test("preserves manual ordering under shuffle and repeat-one, with manual Next still advancing", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  const random = jest.spyOn(Math, "random").mockReturnValue(0);
  fireEvent.click(screen.getByText("shuffle"));
  random.mockRestore();
  fireEvent.click(screen.getByText("move-earlier"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  fireEvent.click(screen.getByText("loop"));
  fireEvent.ended(audioDecks(container)[0]);
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
});

test("a pending autoplay refill cannot overwrite a newer queue order", async () => {
  renderPlayer();
  fireEvent.click(screen.getByText("duplicates"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-1,song-3"));
  let finishRefill;
  getRandomSongs.mockImplementationOnce(() => new Promise((resolve) => { finishRefill = resolve; }));
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(finishRefill).toBeDefined());
  fireEvent.click(screen.getByText("move-last-first"));
  // The current index is now 1; only indices 2 and 3 are movable.
  fireEvent.click(screen.getByText("move-last-second"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,song-1");
  await act(async () => finishRefill([{ id: "autoplay", title: "Autoplay" }]));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,song-1,autoplay");
});

test("reordered queues survive navigation and replacement of layout consumers", async () => {
  const view = (preset) => (
    <MemoryRouter>
      <Link to="/library">Navigate to library</Link>
      <Routes>
        <Route path="/" element={<PlayerHarness key={preset} />} />
        <Route path="/library" element={<PlayerHarness key={`library-${preset}`} />} />
      </Routes>
    </MemoryRouter>
  );
  const { container, rerender } = renderPlayer({ children: view("spotify") });
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  const [audio] = audioDecks(container);
  audio.currentTime = 42;
  fireEvent.timeUpdate(audio);
  fireEvent.click(screen.getByText("move-later"));
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;
  fireEvent.click(screen.getByRole("link", { name: "Navigate to library" }));
  for (const preset of ["apple", "ytmusic", "soundcloud", "spotify"]) {
    rerender(<AuthProvider><PlayerProvider>{view(preset)}</PlayerProvider></AuthProvider>);
    expect(audioDecks(container)[0]).toBe(audio);
    expect(audio.currentTime).toBe(42);
    expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  }
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
});

test("rehydrates the queue and progress without starting audio until Play", async () => {
  const saved = createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    isShuffleEnabled: true, isLooping: true, volume: 0.35, currentTime: 42,
  });
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(saved));
  const { container } = renderPlayer();

  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  expect(screen.getByTestId("loop-enabled")).toHaveTextContent("true");
  expect(screen.getByTestId("volume")).toHaveTextContent("0.35");
  expect(screen.getByTestId("current-time")).toHaveTextContent("42");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(getStreamUrl).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-2");
  Object.defineProperty(container.querySelector("audio"), "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(container.querySelector("audio"));
  expect(container.querySelector("audio").currentTime).toBeCloseTo(42);
});

test("resumes a previously playing track after restoring its media position", async () => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    volume: 0.35, currentTime: 42.75, wasPlaying: true,
  })));
  const { container } = renderPlayer();
  const audio = container.querySelector("audio");

  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(audio);

  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  expect(audio.currentTime).toBeCloseTo(42.75);
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1"))).wasPlaying).toBe(true);
});

test.each(["click", "keydown"])("retries browser-blocked restore on the first %s", async (interaction) => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    volume: 0.35, currentTime: 42, wasPlaying: true,
  })));
  const { container } = renderPlayer();
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  const blocked = Object.assign(new Error("Autoplay blocked"), { name: "NotAllowedError" });
  HTMLMediaElement.prototype.play
    .mockRejectedValueOnce(blocked)
    .mockResolvedValue(undefined);
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(audio);

  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("false"));
  expect(audio.currentTime).toBeCloseTo(42);
  expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1"))).wasPlaying).toBe(false);

  if (interaction === "click") fireEvent.click(document.body);
  else fireEvent.keyDown(window, { key: "Space" });

  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  expect(audio.currentTime).toBeCloseTo(42);
  fireEvent.click(document.body);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test("does not resume a stale blocked track after the user selects another song", async () => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    volume: 1, currentTime: 42, wasPlaying: true,
  })));
  const { container } = renderPlayer();
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(Object.assign(new Error("Blocked"), { name: "NotAllowedError" }));
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(audio);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1"))).wasPlaying).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-1"));
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  fireEvent.click(document.body);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test("persists a paused playback state instead of auto-resuming it", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-1"));
  fireEvent.play(container.querySelector("audio"));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1"))).wasPlaying).toBe(true));
  fireEvent.pause(container.querySelector("audio"));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1"))).wasPlaying).toBe(false));
});

test("saves the audio element's precise position when the page unloads", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-1"));
  fireEvent.play(audio);
  audio.currentTime = 42.75;
  fireEvent(window, new Event("pagehide"));

  expect(JSON.parse(localStorage.getItem(queueStorageKey("user-1")))).toMatchObject({
    currentTrackId: "song-1", playbackProgressSeconds: 42.75, wasPlaying: true,
  });
});


test("caps and validates recently played history received from the server", async () => {
  const recentHistory = Array.from({ length: 55 }, (_, index) => ({
    id: `history-${index}`,
    playedAt: new Date().toISOString(),
  }));

  renderPlayer({ recentHistory });

  await waitFor(() => {
    expect(screen.getByTestId("recently-played")).toHaveTextContent("history-49");
  });

  const hydratedIds = screen.getByTestId("recently-played").textContent.split(",");
  expect(hydratedIds).toHaveLength(50);
  expect(hydratedIds).not.toContain("history-50");
});

test("preserves persistent history older than 45 days during hydration", async () => {
  renderPlayer({ recentHistory: [
    { id: "old", playedAt: new Date(Date.now() - 46 * 86_400_000).toISOString() },
    { id: "current", playedAt: new Date().toISOString() },
  ] });
  await waitFor(() => expect(screen.getByTestId("recently-played")).toHaveTextContent("current"));
  expect(screen.getByTestId("recently-played")).toHaveTextContent("old");
});

test("ignores malformed recently played history received from the server", async () => {
  renderPlayer({ recentHistory: { items: [] } });

  await waitFor(() => {
    expect(getRecentlyPlayed).toHaveBeenCalled();
  });

  expect(screen.getByTestId("recently-played")).toHaveTextContent("");
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

test("automatically analyzes an unscanned library track when silence trimming is enabled", async () => {
  renderPlayer({
    userSettings: [
      { key: "playback.silenceTrim.enabled", value: "true" },
      { key: "playback.silenceTrim.thresholdDb", value: "-28" },
      { key: "playback.silenceTrim.minSilenceSeconds", value: "0.8" },
    ],
  });

  await waitFor(() => expect(getUserSettings).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "direct" }));

  await waitFor(() => {
    expect(analyzeSilence).toHaveBeenCalledWith("song-1", {
      thresholdDb: -28,
      minSilenceSeconds: 0.8,
    });
  });
});

test("uses saved silence analysis without rescanning an analyzed track", async () => {
  renderPlayer({
    userSettings: [
      { key: "playback.silenceTrim.enabled", value: "true" },
    ],
    silenceAnalysis: {
      status: "completed",
      leadingSilenceSeconds: 1,
      trailingSilenceSeconds: 0.5,
    },
  });

  await waitFor(() => expect(getUserSettings).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "direct" }));

  await waitFor(() => expect(getSilenceAnalysis).toHaveBeenCalledWith("song-1"));
  expect(analyzeSilence).not.toHaveBeenCalled();
});

test("playing the active track toggles playback without rebuilding its queue", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("album-start"));

  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  getStreamUrl.mockClear();
  HTMLMediaElement.prototype.pause.mockClear();
  fireEvent.click(screen.getByText("direct"));

  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  expect(getStreamUrl).not.toHaveBeenCalled();
  expect(screen.getByTestId("queue")).toHaveTextContent(
    "song-1,song-2,song-3"
  );
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
});

test("reports play rejection and media errors for the current track", async () => {
  const { container } = renderPlayer();
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(new Error("network unavailable"));
  fireEvent.click(screen.getByText("direct"));

  await waitFor(() => {
    expect(screen.getByTestId("unavailable")).toHaveTextContent("true");
    expect(screen.getByTestId("playback-message")).toHaveTextContent("network unavailable");
  });

  const audio = container.querySelector("audio");
  Object.defineProperty(audio, "error", { configurable: true, value: { code: 2 } });
  fireEvent.error(audio);
  expect(screen.getByTestId("playback-message")).toHaveTextContent("network error");
});

test("ignores a late play rejection from a superseded track request", async () => {
  renderPlayer();
  let rejectPrevious;
  HTMLMediaElement.prototype.play
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectPrevious = reject; }))
    .mockResolvedValueOnce();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  fireEvent.click(screen.getByText("replay-gain-song"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("replay-gain-song"));

  await act(async () => rejectPrevious(new Error("stale failure")));
  expect(screen.getByTestId("unavailable")).toHaveTextContent("false");
  expect(screen.getByTestId("playback-message")).toHaveTextContent("");
});


test("selected normalized source reaches the stream URL helper", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("external"));

  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith(
      "song-1",
      expect.objectContaining({ id: "playable_external", type: "external" }),
      "original"
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

test("server deletion removes queued tracks and stops a deleted current song", async () => {
  renderPlayer();
  fireEvent.click(screen.getByText("album"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  act(() => window.dispatchEvent(new CustomEvent("musicdeck:server-deleted", { detail: { trackIds: ["song-3"] } })));
  expect(screen.getByTestId("queue")).not.toHaveTextContent("song-3");
  act(() => window.dispatchEvent(new CustomEvent("musicdeck:server-deleted", { detail: { trackIds: ["song-2"] } })));
  expect(screen.getByTestId("current-song")).toHaveTextContent("none");
  expect(screen.getByTestId("queue")).not.toHaveTextContent("song-2");
});


test("duplicate ended events advance the queue only once", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("album-start"));

  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  recordListeningEvent.mockClear();
  const audio = container.querySelector("audio");
  fireEvent.ended(audio);
  fireEvent.ended(audio);

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
  });

  expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  expect(recordListeningEvent.mock.calls.filter(([payload]) => payload.finished && payload.trackId === "song-1")).toHaveLength(1);
  expect(recordListeningEvent).toHaveBeenCalledWith(expect.objectContaining({ trackId: "song-1", listenedSeconds: 0, finished: true }));
});

test("records cumulative actual listening time rather than a seeked position", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  expect(recordListeningEvent).not.toHaveBeenCalled();

  const audio = container.querySelector("audio");
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 90 });
  fireEvent.timeUpdate(audio);
  expect(recordListeningEvent).not.toHaveBeenCalled();
  const clock = jest.spyOn(Date, "now");
  const start = Date.now();
  clock.mockReturnValue(start + 30_000);
  audio.currentTime = 120;
  fireEvent.timeUpdate(audio);
  await waitFor(() => expect(recordListeningEvent).toHaveBeenCalledWith(expect.objectContaining({ trackId: "song-1", listenedSeconds: 30, finished: false })));
  clock.mockRestore();
  getRecentlyPlayed.mockResolvedValue([{ ...songs[0], playedAt: new Date().toISOString() }]);
  fireEvent(window, new Event("musicdeck:listening-activity-changed"));
  await waitFor(() => expect(screen.getByTestId("recently-played")).toHaveTextContent("song-1"));
});

test("a late recent-history response cannot overwrite a newer canonical refresh", async () => {
  renderPlayer();
  await waitFor(() => expect(getRecentlyPlayed).toHaveBeenCalledTimes(1));
  let resolveOld;
  getRecentlyPlayed.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  fireEvent(window, new Event("musicdeck:listening-activity-changed"));
  await waitFor(() => expect(getRecentlyPlayed).toHaveBeenCalledTimes(2));
  getRecentlyPlayed.mockResolvedValueOnce([{ ...songs[1], playedAt: new Date().toISOString() }]);
  fireEvent(window, new Event("musicdeck:listening-activity-changed"));
  await waitFor(() => expect(screen.getByTestId("recently-played")).toHaveTextContent("song-2"));
  await act(async () => resolveOld([{ ...songs[0], playedAt: new Date().toISOString() }]));
  expect(screen.getByTestId("recently-played")).toHaveTextContent("song-2");
  expect(screen.getByTestId("recently-played")).not.toHaveTextContent("song-1");
});

test("long tracks use 30 actual seconds rather than four minutes of playback position", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const audio = container.querySelector("audio");
  Object.defineProperty(audio, "duration", { configurable: true, value: 1000 });
  Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 0 });
  expect(recordListeningEvent).not.toHaveBeenCalled();
  const clock = jest.spyOn(Date, "now");
  const start = Date.now();
  clock.mockReturnValue(start + 30_000);
  audio.currentTime = 30;
  fireEvent.timeUpdate(audio);
  await waitFor(() => expect(recordListeningEvent).toHaveBeenCalledWith(expect.objectContaining({ trackId: "song-1", listenedSeconds: 30, durationSeconds: 1000 })));
  clock.mockRestore();
});

test("explicit previous-button restarts create a new listening session", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const audio = container.querySelector("audio");
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 0 });
  const start = Date.now();
  const clock = jest.spyOn(Date, "now");
  try {
    clock.mockReturnValue(start + 30_000);
    audio.currentTime = 30;
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(recordListeningEvent).toHaveBeenCalled());
    const first = recordListeningEvent.mock.calls[0][0].playbackSessionId;
    fireEvent.click(screen.getByText("previous"));
    expect(audio.currentTime).toBe(0);
    clock.mockReturnValue(start + 60_000);
    audio.currentTime = 30;
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(new Set(recordListeningEvent.mock.calls.map(([payload]) => payload.playbackSessionId)).size).toBe(2));
    expect(recordListeningEvent.mock.calls.at(-1)[0].playbackSessionId).not.toBe(first);
  } finally {
    clock.mockRestore();
  }
});


test("looped endings replay the active track while manual next still advances", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  fireEvent.click(screen.getByText("loop"));
  const audio = container.querySelector("audio");
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    writable: true,
    value: 42,
  });

  getStreamUrl.mockClear();
  fireEvent.ended(audio);

  await waitFor(() => {
    expect(audio.currentTime).toBe(0);
  });

  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  expect(getStreamUrl).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("next"));

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
  });
});


test("a depleted queue stops without fetching random tracks when autoplay is disabled", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  fireEvent.click(screen.getByText("disable-autoplay"));
  getRandomSongs.mockClear();
  fireEvent.ended(container.querySelector("audio"));

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("none");
  });

  expect(screen.getByTestId("queue")).toHaveTextContent("");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("-1");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  expect(getRandomSongs).not.toHaveBeenCalled();
});


test("a depleted queue fetches another track only when autoplay is enabled", async () => {
  const { container } = renderPlayer();
  getRandomSongs.mockResolvedValue([songs[1]]);

  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  getRandomSongs.mockClear();
  fireEvent.ended(container.querySelector("audio"));

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
  });

  expect(getRandomSongs).toHaveBeenCalledTimes(1);
});


test("context playback starts at the clicked track and queues only the remaining tracks", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("context-second"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent("song-2,song-3");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
    expect(getStreamUrl).toHaveBeenCalledWith("song-2", null, "original");
  });
});


test("context playback shuffles only tracks after the clicked track", async () => {
  const random = jest.spyOn(Math, "random").mockReturnValue(0);
  renderPlayer();

  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("context-first"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  });

  random.mockRestore();
});


test("shuffle mode stays active and randomizes only upcoming songs", async () => {
  const random = jest.spyOn(Math, "random").mockReturnValue(0);

  renderPlayer();

  fireEvent.click(screen.getByText("album-start"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "song-1,song-2,song-3"
    );
  });

  fireEvent.click(screen.getByText("shuffle"));

  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  expect(screen.getByTestId("queue")).toHaveTextContent(
    "song-1,song-3,song-2"
  );
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");

  fireEvent.click(screen.getByText("shuffle"));

  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("false");

  random.mockRestore();
});


test("loop mode toggles independently of playback queue state", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("loop"));
  expect(screen.getByTestId("loop-enabled")).toHaveTextContent("true");

  fireEvent.click(screen.getByText("loop"));
  expect(screen.getByTestId("loop-enabled")).toHaveTextContent("false");
});


test("crossfade duration is global and persists locally", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("crossfade-three"));

  expect(screen.getByTestId("crossfade-duration")).toHaveTextContent("3");
  expect(localStorage.getItem("playerCrossfadeDuration")).toBe("3");
});


test("stream quality is global, persistent, and applied to newly loaded streams", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("quality-320"));
  expect(screen.getByTestId("stream-quality")).toHaveTextContent("320");
  expect(localStorage.getItem("playerStreamQuality")).toBe("320");

  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith("song-1", null, "320");
  });
});


test("download quality is global and persists independently from stream quality", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("download-quality-256"));

  expect(screen.getByTestId("download-quality")).toHaveTextContent("256kbps");
  expect(screen.getByTestId("stream-quality")).toHaveTextContent("original");
  expect(localStorage.getItem("playerDownloadQuality")).toBe("256kbps");
});


test("ReplayGain adjusts the newly loaded track volume when enabled", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("enable-replay-gain"));
  expect(screen.getByTestId("replay-gain-enabled")).toHaveTextContent("true");
  expect(localStorage.getItem("playerReplayGainEnabled")).toBe("true");

  fireEvent.click(screen.getByText("replay-gain-song"));
  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("replay-gain-song");
  });

  expect(container.querySelector("audio").volume).toBeCloseTo(10 ** (-6 / 20));
});


test("layout density is global, persistent, and marks the document for shared track rows", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("compact-layout"));

  expect(screen.getByTestId("layout-density")).toHaveTextContent("compact");
  expect(localStorage.getItem("playerLayoutDensity")).toBe("compact");
  expect(document.documentElement.dataset.layoutDensity).toBe("compact");
});

test("sidebar state accepts only the supported views", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("open-now-playing"));
  expect(screen.getByTestId("active-sidebar")).toHaveTextContent("now-playing");

  fireEvent.click(screen.getByText("open-queue"));
  expect(screen.getByTestId("active-sidebar")).toHaveTextContent("queue");

  fireEvent.click(screen.getByText("open-invalid"));
  expect(screen.getByTestId("active-sidebar")).toHaveTextContent("none");
});


test("queue behavior preferences are global and persist locally", () => {
  renderPlayer();

  fireEvent.click(screen.getByText("enable-auto-open-sidebar"));
  fireEvent.click(screen.getByText("disable-autoplay"));
  fireEvent.click(screen.getByText("enable-auto-download-liked"));

  expect(screen.getByTestId("auto-open-sidebar")).toHaveTextContent("true");
  expect(screen.getByTestId("autoplay-enabled")).toHaveTextContent("false");
  expect(screen.getByTestId("auto-download-liked")).toHaveTextContent("true");
  expect(localStorage.getItem("playerAutoOpenSidebar")).toBe("true");
  expect(localStorage.getItem("playerAutoplayEnabled")).toBe("false");
  expect(localStorage.getItem("playerAutoDownloadLiked")).toBe("true");
});


test("crossfade starts the next queued track on the idle deck and hands it off", async () => {
  const frames = [];
  const animationSpy = jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  const cancelAnimationSpy = jest
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
  const nowSpy = jest
    .spyOn(performance, "now")
    .mockReturnValue(1000);

  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("context-first"));
  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  });

  fireEvent.click(screen.getByText("crossfade-three"));

  const [outgoingAudio, incomingAudio] = container.querySelectorAll("audio");
  Object.defineProperty(outgoingAudio, "duration", {
    configurable: true,
    value: 100,
  });
  Object.defineProperty(outgoingAudio, "currentTime", {
    configurable: true,
    writable: true,
    value: 97,
  });

  fireEvent.timeUpdate(outgoingAudio);

  await waitFor(() => {
    expect(getStreamUrl).toHaveBeenCalledWith("song-2", null, "original");
    expect(frames.length).toBeGreaterThan(0);
  });

  act(() => {
    frames.shift()(2500);
  });
  expect(outgoingAudio.volume).toBeCloseTo(0.5);
  expect(incomingAudio.volume).toBeCloseTo(0.5);

  act(() => {
    frames.shift()(4000);
  });

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  });
  expect(incomingAudio.volume).toBe(1);

  animationSpy.mockRestore();
  cancelAnimationSpy.mockRestore();
  nowSpy.mockRestore();
});


test("reordering during crossfade keeps current progress and cancels the stale incoming track", async () => {
  const frames = [];
  const animation = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancellation = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const now = jest.spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { container } = renderPlayer();
    fireEvent.click(screen.getByText("context-first"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
    fireEvent.click(screen.getByText("crossfade-three"));
    const [outgoing, incoming] = audioDecks(container);
    Object.defineProperty(outgoing, "duration", { configurable: true, value: 100 });
    outgoing.currentTime = 97;
    fireEvent.timeUpdate(outgoing);
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => frames.shift()(2500));
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    fireEvent.click(screen.getByText("move-later"));
    expect(outgoing.currentTime).toBe(97);
    expect(outgoing).toHaveAttribute("src", "/stream/song-1");
    expect(outgoing.volume).toBe(1);
    expect(incoming).not.toHaveAttribute("src");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
    act(() => frames.shift()(4000));
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
    expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  } finally {
    animation.mockRestore();
    cancellation.mockRestore();
    now.mockRestore();
  }
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
    expect(getStreamUrl).toHaveBeenCalledWith("song-1", null, "original");
  });

  expect(getPlayableSources).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-preview")).toHaveTextContent("false");
  expect(screen.getByTestId("unavailable")).toHaveTextContent("false");
});


test("a catalog track without an embedded preview never resolves a full external source", async () => {
  renderPlayer();

  getPlayableSources.mockResolvedValue({
    sources: [previewSource],
    selectedSource: previewSource,
  });

  fireEvent.click(screen.getByText("catalog"));

  await waitFor(() => {
    expect(screen.getByTestId("unavailable")).toHaveTextContent("true");
  });

  expect(getPlayableSources).not.toHaveBeenCalled();
  expect(getStreamUrl).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-preview")).toHaveTextContent("false");
});

test("an embedded external preview plays directly before source resolution", async () => {
  renderPlayer();

  fireEvent.click(screen.getByText("catalog-with-preview"));

  await waitFor(() => {
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  expect(getPlayableSources).not.toHaveBeenCalled();
  expect(getStreamUrl).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-preview")).toHaveTextContent("true");
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

  fireEvent.click(screen.getByText("catalog-with-preview"));

  await waitFor(() => {
    expect(screen.getByTestId("is-preview")).toHaveTextContent("true");
  });
  expect(screen.getByTestId("preview-duration")).toHaveTextContent("30");

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
  expect(recordListeningEvent).not.toHaveBeenCalled();
});
