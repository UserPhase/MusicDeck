import {
  act,
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


function PlayerHarness() {
  const {
    playSong,
    playSongFromSource,
    playContext,
    playQueue,
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
    crossfadeDuration,
    changeCrossfadeDuration,
    streamQuality,
    changeStreamQuality,
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
      <div data-testid="crossfade-duration">
        {crossfadeDuration}
      </div>
      <div data-testid="stream-quality">
        {streamQuality}
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


function renderPlayer({ recentHistory = [] } = {}) {
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
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ results: [] }),
  }));
});


test("caps and validates recently played history received from the server", async () => {
  const recentHistory = Array.from({ length: 55 }, (_, index) => ({
    id: `history-${index}`,
  }));

  renderPlayer({ recentHistory });

  await waitFor(() => {
    expect(screen.getByTestId("recently-played")).toHaveTextContent("history-49");
  });

  const hydratedIds = screen.getByTestId("recently-played").textContent.split(",");
  expect(hydratedIds).toHaveLength(50);
  expect(hydratedIds).not.toContain("history-50");
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


test("duplicate ended events advance the queue only once", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("album-start"));

  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  recordRecentlyPlayed.mockClear();
  const audio = container.querySelector("audio");
  fireEvent.ended(audio);
  fireEvent.ended(audio);

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
  });

  expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  expect(recordRecentlyPlayed).toHaveBeenCalledTimes(1);
  expect(recordRecentlyPlayed).toHaveBeenCalledWith("song-2");
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
      expect.objectContaining({ id: "playable_preview", type: "preview" }),
      "original"
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

