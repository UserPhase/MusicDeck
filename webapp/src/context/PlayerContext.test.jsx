import "fake-indexeddb/auto";
import { clearLocalQueue, readLocalQueue, writeLocalQueue } from "../services/storage/QueueDatabase";
import { queueSyncClient } from "../services/QueueSyncClient";
import { rememberDownloadOwner } from "../services/storage/offlineIdentity";
global.structuredClone = require("vm").runInThisContext("structuredClone");
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
import * as remoteSessionModule from "../hooks/useRemoteSession";

import {
  getCurrentSession,
  getRecentlyPlayed,
  getAutoplayTracks,
  getStarred,
  getStreamUrl,
  prepareNormalizedPlayback,
  getUserSettings,
  updateUserSettings,
  getSilenceAnalysis,
  analyzeSilence,
  getPlayableSources,
  reportPlaybackSession as recordListeningEvent,
  getListeningConfig,
  saveMediaCheckpoint,
  getListeningTrack,
  request,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  getCurrentSession: jest.fn(),
  request: jest.fn(),
  getRecentlyPlayed: jest.fn(),
  getAutoplayTracks: jest.fn(),
  RECOMMENDATION_FEEDBACK_CHANGED_EVENT: "musicdeck:recommendation-feedback-changed",
  getStarred: jest.fn(),
  getStreamUrl: jest.fn(),
  prepareNormalizedPlayback: jest.fn(),
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(async () => []),
  getSilenceAnalysis: jest.fn(),
  analyzeSilence: jest.fn(),
  getPlayableSources: jest.fn(),
  reportPlaybackSession: jest.fn(),
  getListeningConfig: jest.fn(async () => ({ thresholdSeconds: 30 })),
  saveMediaCheckpoint: jest.fn(async () => ({ checkpoint: null })),
  getListeningTrack: jest.fn(),
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

const albumGainSongs = [
  { id: "quiet", title: "Quiet intro", normalizationGainDb: -14, replayGain: { trackGainDb: 6, albumGainDb: -6, albumPeak: .9 } },
  { id: "loud", title: "Loud track", replayGain: { trackGainDb: -12, albumGainDb: -6, albumPeak: .9 } },
];

function AlbumPlaybackHarness() {
  const { playContext, changeAlbumAware, changeNormalizationTarget, isAlbumAware } = usePlayer();
  return <>
    <button onClick={() => playContext(albumGainSongs, 0, { type: "album", id: "record", name: "Record" })}>album-gain</button>
    <button onClick={() => playContext(albumGainSongs, 0, { type: "playlist", id: "mix", name: "Mix" })}>mixtape-gain</button>
    <button onClick={() => changeAlbumAware(true)}>album-aware-on</button>
    <button onClick={() => changeAlbumAware(false)}>album-aware-off</button>
    <button onClick={() => changeNormalizationTarget(-18)}>album-target</button>
    <div data-testid="album-aware">{String(isAlbumAware)}</div>
    <PlayerHarness />
  </>;
}

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

// The engine alternates between decks and releases (removes the src of) the
// one it stops using, so the audible deck is the one with a source.
function activeAudio(container) {
  const decks = Array.from(audioDecks(container));
  return decks.find((deck) => deck.hasAttribute("src")) ?? decks[0];
}

// Playback can start before the mocked session resolves; the listening tracker
// and queue persistence only exist once a user is signed in.
async function playerReady() {
  await waitFor(() => expect(getListeningConfig).toHaveBeenCalled());
  await waitFor(() => expect(getStarred).toHaveBeenCalled());
}

// jsdom never starts media, so `paused` stays true. The engine only plans
// transitions and trim endings for a deck that is really playing.
function startDeckPlaying(deck, duration, position) {
  Object.defineProperty(deck, "paused", { configurable: true, get: () => false });
  Object.defineProperty(deck, "duration", { configurable: true, value: duration });
  deck.currentTime = position;
}

function idleAudio(container, active) {
  return Array.from(audioDecks(container)).find((deck) => deck !== active);
}


function PlayerHarness() {
  const {
    playSong,
    playSongFromSource,
    playContext,
    playQueue,
    resumeMedia,
    moveQueueItem,
    nextSong,
    previousSong,
    toggleShuffle,
    isShuffleEnabled,
    shuffleMode,
    changeShuffleMode,
    toggleLoop,
    togglePlaylistLoop,
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
    changeVolume,
    togglePlay,
    crossfadeDuration,
    changeCrossfadeDuration,
    transitionMode,
    changeTransitionMode,
    streamQuality,
    changeStreamQuality,
    applyStreamQuality,
    downloadQuality,
    changeDownloadQuality,
    isReplayGainEnabled,
    changeReplayGainEnabled,
    normalizationTarget,
    changeNormalizationTarget,
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
      <button onClick={() => changeVolume(0.5)}>volume-half</button>
      <button onClick={() => changeVolume(0)}>volume-mute</button>
      <button onClick={() => changeVolume(1)}>volume-full</button>
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
      <button onClick={() => {
        togglePlaylistLoop("test-playlist");
        void playQueue(songs, songs.length - 1, { type: "playlist", id: "test-playlist", name: "Test playlist", coverArt: null });
      }}>loop-playlist-from-end</button>
      <button onClick={() => resumeMedia(songs, 1, { type: "album", id: "long-album", name: "Long Album", coverArt: null }, 102.125)}>
        resume-collection
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
      <button onClick={() => changeShuffleMode("smart")}>smart-shuffle</button>
      <button onClick={() => changeShuffleMode("standard")}>standard-shuffle</button>
      <div data-testid="shuffle-mode">{shuffleMode}</div>
      <button onClick={toggleLoop}>
        loop
      </button>
      <button onClick={() => changeCrossfadeDuration(3)}>
        crossfade-three
      </button>
      <button onClick={() => changeTransitionMode("crossfade")}>transition-crossfade</button>
      <button onClick={() => changeTransitionMode("none")}>transition-none</button>
      <button onClick={() => changeTransitionMode("bogus")}>transition-invalid</button>
      <div data-testid="transition-mode">{transitionMode}</div>
      <button onClick={() => changeStreamQuality("320")}>
        quality-320
      </button>
      <button onClick={() => { void applyStreamQuality("direct"); }}>quality-direct-now</button>
      <button onClick={() => { void applyStreamQuality("256"); }}>quality-256-now</button>
      <button onClick={() => changeDownloadQuality("256kbps")}>
        download-quality-256
      </button>
      <button onClick={() => changeReplayGainEnabled(true)}>
        enable-replay-gain
      </button>
      <button onClick={() => changeReplayGainEnabled(false)}>disable-normalization</button>
      <button onClick={() => changeNormalizationTarget(-18)}>target-18</button>
      <button onClick={() => changeNormalizationTarget(-14)}>target-14</button>
      <div data-testid="normalization-target">{normalizationTarget}</div>
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
  normalize = false,
} = {}) {
  if (!normalize) localStorage.setItem("playerNormalizationEnabled", "false");
  prepareNormalizedPlayback.mockResolvedValue({ status: "unavailable" });
  getCurrentSession.mockResolvedValue({
    authenticated: true,
    user: {
      id: "user-1",
      username: "test-user",
      displayName: "Test User",
      role: "user",
    },
  });

  getAutoplayTracks.mockResolvedValue([]);
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
  saveMediaCheckpoint.mockResolvedValue({ checkpoint: null });
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


async function savedQueue() {
  const saved = await readLocalQueue("user-1", false);
  if (!saved) throw new Error("Queue has not committed to IndexedDB yet");
  const checkpoint = saved.head.checkpoint;
  return { queueItems: saved.content.entries.map(entry => entry.track), queueTrackIds: saved.content.entries.map(entry => entry.track.id),
    currentTrackId: saved.content.entries[checkpoint.index]?.track.id, playbackProgressSeconds: checkpoint.position,
    wasPlaying: checkpoint.wasPlaying, shuffleSeed: checkpoint.shuffleSeed };
}
beforeEach(async () => {
  await clearLocalQueue("user-1");
  localStorage.clear();
  sessionStorage.clear();
  jest.clearAllMocks();
  request.mockResolvedValue({ sessions: [], namedQueues: [], saved: true, contentId: "fixture-content" });
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => String(url).includes('/api/v1/taste-profile') ? ({ privateListening: false, revision: 0, resetBefore: null, providerHistoryDisabled: false, excludedPlaylistIds: [], excludedTrackIds: [] }) : ({ results: [] }),
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("desktop time updates keep the exact audio position without rerendering player context consumers", async () => {
  window.__MUSICDECK_DESKTOP__ = true;
  let now = performance.now();
  const clock = jest.spyOn(performance, "now").mockImplementation(() => now);
  const rendered = jest.fn();
  function PlaybackProbe() {
    rendered(usePlayer());
    return null;
  }
  try {
    const { container, unmount } = renderPlayer({ children: <><PlayerHarness /><PlaybackProbe /></> });
    await playerReady();
    fireEvent.click(screen.getByText("album-start"));
    await waitFor(() => expect(activeAudio(container).getAttribute("src")).toBeTruthy());
    const audio = activeAudio(container);
    startDeckPlaying(audio, 200, 10);
    fireEvent.durationChange(audio);
    await waitFor(() => expect(rendered.mock.lastCall[0].duration).toBe(200));
    await waitFor(async () => expect((await savedQueue()).currentTrackId).toBe("song-1"));

    const before = rendered.mock.calls.length;
    for (const position of [10.25, 10.5, 11.25]) {
      audio.currentTime = position;
      fireEvent.timeUpdate(audio);
    }
    expect(rendered.mock.calls).toHaveLength(before);
    expect(rendered.mock.lastCall[0].readPlaybackPosition()).toBe(11.25);

    now += 5100;
    audio.currentTime = 12.125;
    fireEvent.timeUpdate(audio);
    await waitFor(async () => expect((await savedQueue()).playbackProgressSeconds).toBe(12.125));
    unmount();
  } finally {
    clock.mockRestore();
    delete window.__MUSICDECK_DESKTOP__;
  }
});

test("smart shuffle excludes account recency without interrupting the current track and keeps backward history order", async () => {
  const { container } = renderPlayer({
    recentHistory: [{ ...songs[1], playedAt: new Date().toISOString() }],
    userSettings: [{ key: "playback.shuffleMode", value: '"smart"' }],
  });
  await playerReady();
  await waitFor(() => expect(screen.getByTestId("shuffle-mode")).toHaveTextContent("smart"));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;
  fireEvent.click(screen.getByText("shuffle"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  expect(screen.getByTestId("playback-message")).toHaveTextContent(/left out 1/);
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  activeAudio(container).currentTime = 0;
  fireEvent.click(screen.getByText("previous"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3");
});

test("records actually started tracks before scrobbling and excludes them from a replacement smart queue", async () => {
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("album"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  fireEvent.playing(activeAudio(container));
  await waitFor(() => expect(JSON.parse(localStorage.getItem("musicdeck:shuffle-history:v1:user-1"))).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "song-2", playedAt: expect.any(Number) })]),
  ));
  expect(recordListeningEvent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("smart-shuffle"));
  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3");
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith({ "playback.shuffleMode": "smart" }));
  expect(localStorage.getItem("playerShuffleMode")).toBe("smart");
});

test("restores account-scoped two-hour history and ignores another account's recent tracks", async () => {
  localStorage.setItem("musicdeck:shuffle-history:v1:user-1", JSON.stringify([
    { id: "song-2", playedAt: Date.now() - 60_000 },
  ]));
  localStorage.setItem("musicdeck:shuffle-history:v1:other-user", JSON.stringify([
    { id: "song-3", playedAt: Date.now() - 60_000 },
  ]));
  renderPlayer({ userSettings: [{ key: "playback.shuffleMode", value: '"smart"' }] });
  await playerReady();
  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3"));
});

test("restores the saved seed and materialized smart order without resampling", async () => {
  localStorage.setItem("playerShuffleMode", "smart");
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[0], queue: [songs[0], songs[2], songs[1]], queueIndex: 0,
    isShuffleEnabled: true, shuffleSeed: 0,
  })));
  renderPlayer();
  await playerReady();
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2"));
  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  await waitFor(async () => expect((await savedQueue()).shuffleSeed).toBe(0));
});

test("a stale account preference fetch cannot undo a newer shuffle choice", async () => {
  let finish;
  getUserSettings.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("smart-shuffle"));
  await act(async () => { finish([{ key: "playback.shuffleMode", value: '"standard"' }]); });
  expect(screen.getByTestId("shuffle-mode")).toHaveTextContent("smart");
  expect(localStorage.getItem("playerShuffleMode")).toBe("smart");
});

test("failed shuffle account sync is explicit while keeping the device preference", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  updateUserSettings.mockRejectedValueOnce(new Error("Offline"));
  renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("smart-shuffle"));
  await waitFor(() => expect(screen.getByTestId("playback-message")).toHaveTextContent(/account sync failed/));
  expect(localStorage.getItem("playerShuffleMode")).toBe("smart");
  expect(error).toHaveBeenCalledWith("Could not sync shuffle mode:", expect.any(Error));
  error.mockRestore();
});

test("moves upcoming entries both ways without touching playback, source tracks, or persistence progress", async () => {
  const { container } = renderPlayer();
  await playerReady();
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
  // Only the new upcoming track is prepared; the playing one keeps its stream.
  expect(getStreamUrl.mock.calls.slice(streams).map(([id]) => id)).toEqual(["song-3"]);
  expect(songs.map((song) => song.id)).toEqual(["song-1", "song-2", "song-3"]);
  await waitFor(async () => expect((await savedQueue())).toMatchObject({
    queueTrackIds: ["song-1", "song-3", "song-2"], playbackProgressSeconds: 42,
  }));
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
  getAutoplayTracks.mockImplementationOnce(() => new Promise((resolve) => { finishRefill = resolve; }));
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

test("shows the latest account queue automatically and starts it only when Play is pressed", async () => {
  let checkpoint = { index: 1, position: 102.25, repeatOne: false, shuffle: false, shuffleSeed: null,
    shuffleMode: "standard", albumAware: false, volume: .65, wasPlaying: true, context: null, capturedAt: Date.now() };
  const content = { version: 2, entries: songs.map((track, index) => ({ entryId: `desk-${index}`, track: { ...track, duration: 200 } })) };
  request.mockImplementation(async (url, options) => {
    if (url.endsWith("/queue-session") && options?.method !== "PUT") return {
      sessions: [{ deviceId: "desk", deviceName: "Desktop", contentId: "shared-content", checkpoint,
        sequence: 1, updatedAt: checkpoint.capturedAt, trackCount: 3 }], namedQueues: [],
    };
    if (url.endsWith("/content/shared-content")) return content;
    return { saved: true, contentId: "local-content" };
  });
  const { container } = renderPlayer();
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("current-time")).toHaveTextContent("102.25");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([url, options]) => url.endsWith("/queue-session") && options?.method === "PUT")).toBe(false);

  checkpoint = { ...checkpoint, position: 106.5, capturedAt: checkpoint.capturedAt + 100 };
  await act(async () => { await queueSyncClient.refresh(); });
  expect(screen.getByTestId("current-time")).toHaveTextContent("106.5");
  expect(request.mock.calls.filter(([url]) => url.endsWith("/content/shared-content"))).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  const audio = activeAudio(container);
  expect(audio).toHaveAttribute("src", "/stream/song-2");
  Object.defineProperty(audio, "duration", { configurable: true, value: 200 });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBeCloseTo(106.5);
});

test("restores the remembered account's local queue when the server cannot authenticate offline", async () => {
  await rememberDownloadOwner("user-1");
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({ currentSong: songs[2], queue: songs, queueIndex: 2, currentTime: 17.25, volume: 0.4 })));
  getCurrentSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  renderPlayer();
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("current-time")).toHaveTextContent("17.25"); expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  expect(getStarred).not.toHaveBeenCalled(); expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

test("resumes a previously playing track after restoring its media position", async () => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    volume: 0.35, currentTime: 42.75, wasPlaying: true,
  })));
  const { container } = renderPlayer();
  const audio = container.querySelector("audio");

  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  expect(audio.volume).toBeCloseTo(0.35 ** (Math.log2(10) / 2));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(audio);

  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  expect(audio.currentTime).toBeCloseTo(42.75);
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  await waitFor(async () => expect((await savedQueue()).wasPlaying).toBe(true));
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
  await waitFor(async () => expect((await savedQueue()).wasPlaying).toBe(false));

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
  await waitFor(async () => expect((await savedQueue()).wasPlaying).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1"));
  expect(audio).not.toHaveAttribute("src");
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  fireEvent.click(document.body);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test("persists a paused playback state instead of auto-resuming it", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-1"));
  fireEvent.play(container.querySelector("audio"));
  await waitFor(async () => expect((await savedQueue()).wasPlaying).toBe(true));
  fireEvent.pause(container.querySelector("audio"));
  await waitFor(async () => expect((await savedQueue()).wasPlaying).toBe(false));
});

test("saves the audio element's precise position when the page unloads", async () => {
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByRole("button", { name: "direct" }));
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-1"));
  fireEvent.play(audio);
  audio.currentTime = 42.75;
  fireEvent(window, new Event("pagehide"));

  await waitFor(async () => expect((await savedQueue())).toMatchObject({
    currentTrackId: "song-1", playbackProgressSeconds: 42.75, wasPlaying: true,
  }));
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

  await waitFor(() => expect(getSilenceAnalysis).toHaveBeenCalledWith("song-1", { thresholdDb: -35, minSilenceSeconds: 0.5 }));
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
    expect(screen.getByTestId("playback-message")).toHaveTextContent("This track could not be played.");
  });
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");

  // Network errors reconnect (see the recovery tests); undecodable media is reported.
  const audio = activeAudio(container);
  Object.defineProperty(audio, "error", { configurable: true, value: { code: 3 } });
  fireEvent.error(audio);
  await waitFor(() => expect(screen.getByTestId("playback-message")).toHaveTextContent("This track could not be decoded."));
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
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
  await playerReady();

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
  await playerReady();
  const start = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(start);
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  expect(recordListeningEvent).not.toHaveBeenCalled();

  const audio = activeAudio(container);
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 90 });
  await act(async () => { fireEvent.timeUpdate(audio); });
  expect(recordListeningEvent).not.toHaveBeenCalled();
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
  await playerReady();
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
  await playerReady();
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


test("playlist loop wraps from the last track to the first", async () => {
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("loop-playlist-from-end"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", `/stream/${songs.at(-1).id}`));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1"));
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
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
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;
  fireEvent.ended(audio);

  await waitFor(() => {
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays + 1);
  });
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");
  expect(activeAudio(container).currentTime).toBe(0);
  expect(screen.getByTestId("current-time")).toHaveTextContent("0");

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
  getAutoplayTracks.mockClear();
  fireEvent.ended(container.querySelector("audio"));

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("none");
  });

  expect(screen.getByTestId("queue")).toHaveTextContent("");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("-1");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  expect(getAutoplayTracks).not.toHaveBeenCalled();
});


test("a depleted queue fetches another track only when autoplay is enabled", async () => {
  const { container } = renderPlayer();
  await playerReady();

  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });
  // The background refill found nothing, so the queue really ends.
  await waitFor(() => expect(getAutoplayTracks).toHaveBeenCalledTimes(1));

  getAutoplayTracks.mockClear();
  getAutoplayTracks.mockResolvedValue([songs[1]]);
  fireEvent.ended(activeAudio(container));

  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
  });

  expect(getAutoplayTracks).toHaveBeenNthCalledWith(1, "song-1", 10, ["song-1"]);
});

test("auto-refill appends new tracks once two or fewer remain without interrupting playback", async () => {
  const refill = [songs[1], { id: "refill-1", title: "Refill One" }, { id: "refill-2", title: "Refill Two" }];
  const { container } = renderPlayer();
  await playerReady();
  getAutoplayTracks.mockResolvedValue(refill);

  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,refill-1,refill-2"));
  // Two upcoming tracks: ask for enough to reach ten upcoming, plus spares for duplicates.
  expect(getAutoplayTracks).toHaveBeenCalledTimes(1);
  expect(getAutoplayTracks).toHaveBeenCalledWith("song-1", 13, ["song-1", "song-2", "song-3"]);
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");

  // Three upcoming: no refill.
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  expect(getAutoplayTracks).toHaveBeenCalledTimes(1);

  // Two upcoming again: one more attempt, and already queued tracks are skipped.
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(getAutoplayTracks).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,refill-1,refill-2");
});

test("smart refill excludes recent candidates without reordering the manually edited queue", async () => {
  localStorage.setItem("musicdeck:shuffle-history:v1:user-1", JSON.stringify([
    { id: "heard", artist: "Recent artist", playedAt: Date.now() - 1000 },
  ]));
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("smart-shuffle"));
  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(getAutoplayTracks).toHaveBeenCalled());
  fireEvent.click(screen.getByText("move-later"));
  const manualOrder = screen.getByTestId("queue").textContent;
  getAutoplayTracks.mockResolvedValueOnce([
    { id: "heard", artist: "Recent artist" },
    { id: "fresh-1", artist: "New artist" },
    { id: "fresh-2", artist: "Other artist" },
  ]);
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("queue").textContent).toContain("fresh-"));
  const order = screen.getByTestId("queue").textContent.split(",");
  expect(order.slice(0, 3).join(",")).toBe(manualOrder);
  expect(order.slice(3).sort()).toEqual(["fresh-1", "fresh-2"]);
  expect(order).not.toContain("heard");
  expect(activeAudio(container)).toHaveAttribute("src", `/stream/${order[1]}`);
});

test("hidden recommendations are removed from upcoming autoplay without interrupting the current track", async () => {
  const { container } = renderPlayer();
  await playerReady();
  getAutoplayTracks.mockResolvedValue([
    { id: "auto-1", recommendationGenerated: true, artistId: "hidden-artist" },
    { id: "auto-2", recommendationGenerated: true, artistId: "hidden-artist" },
    { id: "auto-3", recommendationGenerated: true, artistId: "other-artist" },
  ]);
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("auto-1,auto-2,auto-3"));
  act(() => window.dispatchEvent(new CustomEvent("musicdeck:recommendation-feedback-changed", {
    detail: { action: "block-artist", itemType: "artist", itemId: "hidden-artist" },
  })));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,auto-3"));
  expect(screen.getByTestId("queue")).not.toHaveTextContent("auto-1");
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");
});

test("feedback arriving during a refill prevents stale recommendations from entering the queue", async () => {
  renderPlayer();
  await playerReady();
  let finish;
  getAutoplayTracks.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(getAutoplayTracks).toHaveBeenCalledTimes(1));
  act(() => window.dispatchEvent(new CustomEvent("musicdeck:recommendation-feedback-changed", {
    detail: { action: "hide", itemType: "track", itemId: "hidden" },
  })));
  await act(async () => finish([{ id: "hidden", recommendationGenerated: true }]));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("queue")).not.toHaveTextContent("hidden");
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


test.each([true, false])("applying a bitrate now retains occurrence, exact position and playing intent (%s)", async (playing) => {
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("album"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  const audio = activeAudio(container);
  startDeckPlaying(audio, 600, 109.875);
  fireEvent.timeUpdate(audio);
  if (!playing) fireEvent.click(screen.getByText("toggle-play"));
  const queue = screen.getByTestId("queue").textContent;
  const calls = HTMLMediaElement.prototype.play.mock.calls.length;
  fireEvent.click(screen.getByText("quality-256-now"));
  await waitFor(() => expect(getStreamUrl).toHaveBeenLastCalledWith("song-2", null, "256"));
  expect(updateUserSettings).toHaveBeenCalledWith({ "playback.streamQuality": "256" });
  const reloaded = activeAudio(container);
  Object.defineProperty(reloaded, "duration", { configurable: true, value: 600 });
  fireEvent.loadedMetadata(reloaded);
  await waitFor(() => expect(reloaded.currentTime).toBe(109.875));
  expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
  expect(screen.getByTestId("queue")).toHaveTextContent(queue);
  expect(screen.getByTestId("stream-quality")).toHaveTextContent("256");
  expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(playing ? calls + 1 : calls);
});

test("direct passthrough bypasses server normalization and retains client ReplayGain", async () => {
  const { container } = renderPlayer({ normalize: true });
  await playerReady();
  fireEvent.click(screen.getByText("replay-gain-song"));
  await waitFor(() => expect(activeAudio(container).volume).toBeCloseTo(10 ** (-6 / 20)));
  prepareNormalizedPlayback.mockClear();
  fireEvent.click(screen.getByText("quality-direct-now"));
  await waitFor(() => expect(getStreamUrl).toHaveBeenLastCalledWith("replay-gain-song", null, "direct"));
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/replay-gain-song");
  expect(activeAudio(container).volume).toBeCloseTo(10 ** (-6 / 20));
  expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
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
  expect(localStorage.getItem("playerNormalizationEnabled")).toBe("true");

  fireEvent.click(screen.getByText("replay-gain-song"));
  await waitFor(() => {
    expect(screen.getByTestId("current-song")).toHaveTextContent("replay-gain-song");
  });

  await waitFor(() => expect(container.querySelector("audio").volume).toBeCloseTo(10 ** (-6 / 20)));
  fireEvent.click(screen.getByText("volume-half"));
  expect(container.querySelector("audio").volume).toBeCloseTo(10 ** (-16 / 20));
});

const normalizedUrl = (digit = "a") => `/api/playback/normalized/${digit.repeat(64)}`;

test("changing target smoothly adjusts measured audio without changing source or position", async () => {
  jest.useFakeTimers();
  songs[0].loudness = { integratedLufs: -10, truePeakDb: -1 };
  try {
    const { container } = renderPlayer({ normalize: true });
    await act(async () => {});
    fireEvent.click(screen.getByText("direct"));
    const audio = container.querySelector("audio");
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
    audio.currentTime = 42;
    fireEvent.click(screen.getByText("target-18"));
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
    await act(async () => jest.advanceTimersByTime(4500));
    expect(audio.volume).toBeCloseTo(10 ** (-8 / 20));
    fireEvent.click(screen.getByText("target-14"));
    await act(async () => jest.advanceTimersByTime(8500));
    expect(audio.volume).toBeCloseTo(10 ** (-4 / 20));
    expect(audio.currentTime).toBe(42);
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
  } finally { delete songs[0].loudness; jest.useRealTimers(); }
});

test("ignores an old target's pending result after a new target is selected", async () => {
  const { container } = renderPlayer({ normalize: true });
  await playerReady();
  jest.useFakeTimers();
  try {
    await act(async () => {});
    const pending = new Map();
    prepareNormalizedPlayback.mockImplementation((_id, _source, _preview, _signal, _quality, target) => new Promise(resolve => pending.set(target, resolve)));
    fireEvent.click(screen.getByText("direct"));
    fireEvent.click(screen.getByText("target-18"));
    await act(async () => pending.get(-18)({ status: "measured", gainDb: -8, integratedLufs: -10, truePeakDb: -1 }));
    await act(async () => jest.advanceTimersByTime(17000));
    const audio = container.querySelector("audio");
    expect(audio.volume).toBeCloseTo(10 ** (-8 / 20));
    await act(async () => pending.get(-16)({ status: "measured", gainDb: -6, integratedLufs: -10, truePeakDb: -1 }));
    await act(async () => jest.advanceTimersByTime(5000));
    expect(audio.volume).toBeCloseTo(10 ** (-8 / 20));
  } finally { jest.useRealTimers(); }
});

test("starts immediately and applies late measured gain without replacing or restarting audio", async () => {
  jest.useFakeTimers();
  localStorage.setItem("playerReplayGainEnabled", "false");
  const { container } = renderPlayer({ normalize: true });
  let finish;
  prepareNormalizedPlayback.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByText("direct"));
  const audio = container.querySelector("audio");
  expect(audio).toHaveAttribute("src", "/stream/song-1");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
  audio.currentTime = 8;
  await act(async () => finish({ status: "ready", streamUrl: normalizedUrl(), gainDb: -6 }));
  expect(audio.volume).toBeCloseTo(1);
  await act(async () => jest.advanceTimersByTime(13000));
  expect(audio).toHaveAttribute("src", "/stream/song-1");
  expect(audio.currentTime).toBe(8);
  expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test("pausing remains effective when background preparation finishes", async () => {
  const { container } = renderPlayer({ normalize: true });
  let finish;
  prepareNormalizedPlayback.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByText("direct"));
  const audio = container.querySelector("audio");
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  fireEvent.click(screen.getByText("toggle-play"));
  fireEvent.pause(audio);
  await act(async () => finish({ status: "ready", streamUrl: normalizedUrl(), gainDb: -4 }));
  expect(audio).toHaveAttribute("src", "/stream/song-1");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
});

test("polls processing jobs and applies measurements while audio continues playing", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer({ normalize: true });
    prepareNormalizedPlayback.mockResolvedValueOnce({ status: "processing", gainDb: -3 })
      .mockResolvedValue({ status: "ready", gainDb: -6, streamUrl: normalizedUrl() });
    await act(async () => fireEvent.click(screen.getByText("direct")));
    const audio = container.querySelector("audio");
    expect(audio.volume).toBeCloseTo(1);
    audio.currentTime = 25;
    await act(async () => jest.advanceTimersByTime(1500));
    expect(audio.volume).toBeGreaterThan(0.9);
    await act(async () => jest.advanceTimersByTime(13000));
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
    expect(audio.currentTime).toBe(25);
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(prepareNormalizedPlayback).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test("uses Web Audio for smooth boosts while keeping the volume slider and source intact", async () => {
  const gain = { value: 1, cancelScheduledValues: jest.fn(), cancelAndHoldAtTime: jest.fn(), setValueAtTime: jest.fn(), setValueCurveAtTime: jest.fn() };
  const node = { gain, connect: jest.fn(), disconnect: jest.fn() };
  const context = { state: "running", currentTime: 10, destination: {}, createGain: jest.fn(() => node), createMediaElementSource: jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn() })), close: jest.fn(async () => {}) };
  window.AudioContext = jest.fn(() => context);
  try {
    const { container } = renderPlayer({ normalize: true });
    let finish;
    prepareNormalizedPlayback.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByText("direct"));
    const audio = container.querySelector("audio");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    audio.currentTime = 17;
    await act(async () => finish({ status: "ready", streamUrl: normalizedUrl(), gainDb: 6 }));
    const [curve, start, duration] = gain.setValueCurveAtTime.mock.calls[0];
    expect(curve[0]).toBe(1);
    expect(curve[curve.length - 1]).toBeCloseTo(10 ** (6 / 20));
    expect(start).toBe(10);
    expect(duration).toBeCloseTo(12);
    expect(audio.volume).toBe(1);
    fireEvent.click(screen.getByText("volume-half"));
    // The master GainNode carries the slider level; the element stays at unity.
    expect(audio.volume).toBe(1);
    expect(gain.setValueAtTime.mock.calls.at(-1)[0]).toBeCloseTo(10 ** (-10 / 20));
    expect(audio.currentTime).toBe(17);
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    // One source node per deck, each created once and never re-created on reloads.
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(2);
  } finally { delete window.AudioContext; }
});

test("a late analysis for a previous song cannot change the current deck's gain", async () => {
  jest.useFakeTimers();
  const { container } = renderPlayer({ normalize: true });
  const pending = new Map();
  prepareNormalizedPlayback.mockImplementation(id => new Promise(resolve => pending.set(id, resolve)));
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(pending.has("song-1")).toBe(true));
  fireEvent.click(screen.getByText("replay-gain-song"));
  await act(async () => pending.get("replay-gain-song")({ status: "ready", streamUrl: normalizedUrl("b"), gainDb: -4 }));
  const audio = activeAudio(container);
  await act(async () => jest.advanceTimersByTime(9000));
  expect(audio.volume).toBeCloseTo(10 ** (-4 / 20));
  await act(async () => pending.get("song-1")({ status: "ready", streamUrl: normalizedUrl(), gainDb: -20 }));
  expect(audio).toHaveAttribute("src", "/stream/replay-gain-song");
  expect(audio.volume).toBeCloseTo(10 ** (-4 / 20));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  jest.useRealTimers();
});

test("previews start through the same-origin streaming proxy and retain their duration", async () => {
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockResolvedValue({ status: "ready", streamUrl: normalizedUrl(), gainDb: -3 });
  fireEvent.click(screen.getByText("catalog-with-preview"));
  const audio = container.querySelector("audio");
  expect(audio).toHaveAttribute("src", `/api/playback/preview?url=${encodeURIComponent(catalogSongWithPreview.previewUrl)}`);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(prepareNormalizedPlayback).toHaveBeenCalledWith(catalogSongWithPreview.id, null, catalogSongWithPreview.previewUrl, expect.anything(), "original", -16);
  expect(screen.getByTestId("is-preview")).toHaveTextContent("true");
  Object.defineProperty(audio, "duration", { configurable: true, value: 30 });
  fireEvent.loadedMetadata(audio);
  expect(screen.getByTestId("preview-duration")).toHaveTextContent("30");
});

test("Next never waits for an unfinished preparation and joins the existing job", async () => {
  jest.useFakeTimers();
  const { container } = renderPlayer({ normalize: true });
  let finishNext;
  prepareNormalizedPlayback.mockImplementation(id => id === "song-2"
    ? new Promise(resolve => { finishNext = resolve; })
    : Promise.resolve({ status: "ready", streamUrl: normalizedUrl("a"), gainDb: -3 }));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(finishNext).toBeDefined());
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  const audio = activeAudio(container);
  expect(audio).toHaveAttribute("src", "/stream/song-2");
  expect(prepareNormalizedPlayback.mock.calls.filter(([id]) => id === "song-2")).toHaveLength(1);
  await act(async () => finishNext({ status: "ready", streamUrl: normalizedUrl("b"), gainDb: -6 }));
  await act(async () => jest.advanceTimersByTime(13000));
  expect(audio).toHaveAttribute("src", "/stream/song-2");
  expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
  jest.useRealTimers();
});

test("import-analyzed tracks start at the measured gain and skip repeat preparation", async () => {
  songs[0].normalizationGainDb = -6;
  try {
    const { container } = renderPlayer({ normalize: true });
    fireEvent.click(screen.getByText("direct"));
    const audio = container.querySelector("audio");
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("disable-normalization"));
    expect(audio.volume).toBe(1);
  } finally { delete songs[0].normalizationGainDb; }
});

test("already prepared upcoming tracks start from the normalized cache without double gain", async () => {
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockResolvedValue({ status: "ready", streamUrl: normalizedUrl(), gainDb: -6 });
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(prepareNormalizedPlayback).toHaveBeenCalledWith("song-3", null, null, expect.anything(), "original", -16));
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", normalizedUrl()));
  expect(activeAudio(container).volume).toBe(1);
});

test("crossfade starts the next deck even while both normalization jobs are pending", async () => {
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByText("transition-crossfade"));
  fireEvent.click(screen.getByText("crossfade-three"));
  fireEvent.click(screen.getByText("context-first"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const outgoing = activeAudio(container);
  const incoming = idleAudio(container, outgoing);
  startDeckPlaying(outgoing, 100, 97);
  fireEvent.timeUpdate(outgoing);
  await waitFor(() => expect(incoming).toHaveAttribute("src", "/stream/song-2"));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test("starting an album never waits for optional autoplay recommendations", async () => {
  const { container } = renderPlayer();
  getAutoplayTracks.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByText("album-start"));
  expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-1");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

test("resuming a collection seeks the engine to fractional seconds after metadata and syncs the correct track on pause", async () => {
  const { container } = renderPlayer();
  await playerReady();
  fireEvent.click(screen.getByText("shuffle"));
  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  fireEvent.click(screen.getByText("resume-collection"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  const audio = activeAudio(container);
  Object.defineProperty(audio, "duration", { configurable: true, value: 600 });
  fireEvent.loadedMetadata(audio);
  await waitFor(() => expect(audio.currentTime).toBe(102.125));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("false");
  startDeckPlaying(audio, 600, 109.875);
  fireEvent.playing(audio);
  fireEvent.timeUpdate(audio);
  fireEvent.click(screen.getByText("toggle-play"));
  await waitFor(() => expect(saveMediaCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
    type: "album", mediaId: "long-album", trackId: "song-2", trackIndex: 1, trackCount: 3,
    positionSeconds: 109.875, durationSeconds: 600,
  }), expect.any(AbortSignal)));
  await waitFor(async () => expect((await savedQueue()).queueItems[1].mediaResume)
    .toMatchObject({ type: "album", mediaId: "long-album", trackIndex: 1 }));
});

test("restored playback resumes at its saved position without waiting for analysis", async () => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    volume: 0.5, currentTime: 42, wasPlaying: true,
  })));
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockImplementation(() => new Promise(() => {}));
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(audio);
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  expect(audio.currentTime).toBe(42);
  expect(audio.volume).toBeCloseTo(10 ** (-10 / 20));
});

test("analysis failures do not interrupt or restart playback", async () => {
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockRejectedValue(new Error("Offline"));
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-1");
  expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

test("disabling normalization on a paused song keeps its position and never unpauses it", async () => {
  jest.useFakeTimers();
  const { container } = renderPlayer({ normalize: true });
  prepareNormalizedPlayback.mockResolvedValue({ status: "ready", streamUrl: normalizedUrl(), gainDb: -4 });
  fireEvent.click(screen.getByText("direct"));
  const audio = container.querySelector("audio");
  await act(async () => {});
  await act(async () => jest.advanceTimersByTime(9000));
  expect(audio.volume).toBeCloseTo(10 ** (-4 / 20));
  audio.currentTime = 24;
  fireEvent.timeUpdate(audio);
  fireEvent.pause(audio);
  fireEvent.click(screen.getByText("disable-normalization"));
  // Swapping streams reloads the song on the idle deck at the saved position.
  const reloaded = activeAudio(container);
  expect(reloaded).toHaveAttribute("src", "/stream/song-1");
  Object.defineProperty(reloaded, "duration", { configurable: true, value: 180 });
  fireEvent.loadedMetadata(reloaded);
  expect(reloaded.currentTime).toBe(24);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  jest.useRealTimers();
});

test("maps slider loudness to audio gain and persists the slider position", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  const [audio] = audioDecks(container);
  fireEvent.click(screen.getByText("volume-half"));
  expect(audio.volume).toBeCloseTo(10 ** (-10 / 20));
  expect(screen.getByTestId("volume")).toHaveTextContent("0.5");
  expect(localStorage.getItem("playerVolume")).toBe("0.5");
  fireEvent.click(screen.getByText("volume-mute"));
  expect(audio.volume).toBe(0);
  fireEvent.click(screen.getByText("volume-full"));
  expect(audio.volume).toBe(1);
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


test("ordered album playback keeps album gain and pauses instead of applying track normalization or crossfade", async () => {
  const { container } = renderPlayer({ normalize: true, children: <AlbumPlaybackHarness />, userSettings: [
    { key: "playback.albumAware", value: "true" },
    { key: "playback.silenceTrim.enabled", value: "true" },
    { key: "playback.transitionMode", value: '"crossfade"' },
  ] });
  await playerReady();
  await waitFor(() => expect(screen.getByTestId("album-aware")).toHaveTextContent("true"));
  fireEvent.click(screen.getByText("album-gain"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/quiet"));
  const quiet = activeAudio(container);
  expect(quiet.volume).toBeCloseTo(10 ** (-6 / 20));
  startDeckPlaying(quiet, 100, 97);
  fireEvent.playing(quiet);
  fireEvent.timeUpdate(quiet);
  expect(getSilenceAnalysis).not.toHaveBeenCalled();
  expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
  expect(screen.getByTestId("current-song")).toHaveTextContent("quiet");
  fireEvent.click(screen.getByText("album-target"));
  expect(quiet.volume).toBeCloseTo(10 ** (-6 / 20));
  fireEvent.ended(quiet);
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("loud"));
  expect(activeAudio(container).volume).toBeCloseTo(10 ** (-6 / 20));
  expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
  const history = JSON.parse(localStorage.getItem("musicdeck:shuffle-history:v1:user-1"));
  expect(history.map((play) => play.id)).toEqual(["quiet", "loud"]);
});

test("album awareness is opt-in and never changes playlist track normalization", async () => {
  const { container } = renderPlayer({ normalize: true, children: <AlbumPlaybackHarness /> });
  await playerReady();
  expect(screen.getByTestId("album-aware")).toHaveTextContent("false");
  fireEvent.click(screen.getByText("album-aware-on"));
  fireEvent.click(screen.getByText("mixtape-gain"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/quiet"));
  expect(activeAudio(container).volume).toBeCloseTo(10 ** (-14 / 20));
  expect(localStorage.getItem("playerAlbumAware")).toBe("true");
});

test("a restored album retains album gain and its paused position without preloading it", async () => {
  const tracks = albumGainSongs.map((song, albumTrackIndex) => ({ ...song, albumPlaybackId: "record", albumTrackIndex }));
  await writeLocalQueue("user-1", { version: 2, entries: tracks.map((track, i) => ({ entryId: `q${i}`, track })) }, {
    index: 0, position: 42, volume: 1, wasPlaying: false, repeatOne: false, shuffle: false, shuffleSeed: null,
    shuffleMode: "standard", albumAware: true, context: null, capturedAt: Date.now(),
  });
  const { container } = renderPlayer({ normalize: true });
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("quiet"));
  expect(getStreamUrl).not.toHaveBeenCalledWith("quiet", null, "original");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(activeAudio(container)).not.toHaveAttribute("src");
  fireEvent.click(screen.getByText("toggle-play"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/quiet"));
  expect(activeAudio(container).volume).toBeCloseTo(10 ** (-6 / 20));
  const audio = activeAudio(container);
  Object.defineProperty(audio, "duration", { configurable: true, value: 100 });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(42);
  expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
});

test("album policy toggles keep a paused track selected and never unpause it", async () => {
  const { container } = renderPlayer({ normalize: true, children: <AlbumPlaybackHarness /> });
  await playerReady();
  fireEvent.click(screen.getByText("album-gain"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/quiet"));
  const audio = activeAudio(container);
  startDeckPlaying(audio, 100, 42);
  fireEvent.playing(audio);
  fireEvent.click(screen.getByText("toggle-play"));
  const playCalls = HTMLMediaElement.prototype.play.mock.calls.length;
  fireEvent.click(screen.getByText("album-aware-on"));
  await waitFor(() => expect(screen.getByTestId("album-aware")).toHaveTextContent("true"));
  expect(screen.getByTestId("current-song")).toHaveTextContent("quiet");
  expect(screen.getByTestId("queue")).toHaveTextContent("quiet,loud");
  expect(screen.getByTestId("current-time")).toHaveTextContent("42");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCalls);
  fireEvent.click(screen.getByText("album-aware-off"));
  await waitFor(() => expect(screen.getByTestId("album-aware")).toHaveTextContent("false"));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCalls);
});

test("crossfade starts the next queued track on the idle deck and hands it off", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer();
    fireEvent.click(screen.getByText("transition-crossfade"));
    fireEvent.click(screen.getByText("crossfade-three"));
    fireEvent.click(screen.getByText("context-first"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
    const outgoing = activeAudio(container);
    const incoming = idleAudio(container, outgoing);
    startDeckPlaying(outgoing, 100, 97);

    await act(async () => fireEvent.timeUpdate(outgoing));
    expect(getStreamUrl).toHaveBeenCalledWith("song-2", null, "original");
    expect(incoming).toHaveAttribute("src", "/stream/song-2");
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");

    // Equal-power ramp: both decks sit at cos(pi/4) halfway through the 3 s window.
    await act(async () => jest.advanceTimersByTime(1500));
    expect(outgoing.volume).toBeCloseTo(Math.SQRT1_2, 1);
    expect(incoming.volume).toBeCloseTo(Math.SQRT1_2, 1);

    fireEvent.click(screen.getByText("volume-half"));
    const master = 10 ** (-10 / 20);
    await act(async () => jest.advanceTimersByTime(750));
    expect(outgoing.volume).toBeCloseTo(master * Math.cos((0.75 * Math.PI) / 2), 1);
    expect(incoming.volume).toBeCloseTo(master * Math.sin((0.75 * Math.PI) / 2), 1);

    await act(async () => jest.advanceTimersByTime(800));
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");
    expect(incoming.volume).toBeCloseTo(master);
    expect(outgoing).not.toHaveAttribute("src");
  } finally {
    jest.useRealTimers();
  }
});


test("reordering during crossfade keeps current progress and cancels the stale incoming track", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer();
    fireEvent.click(screen.getByText("transition-crossfade"));
    fireEvent.click(screen.getByText("crossfade-three"));
    fireEvent.click(screen.getByText("context-first"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
    const outgoing = activeAudio(container);
    const incoming = idleAudio(container, outgoing);
    startDeckPlaying(outgoing, 100, 97);
    await act(async () => fireEvent.timeUpdate(outgoing));
    await act(async () => jest.advanceTimersByTime(1500));
    expect(incoming).toHaveAttribute("src", "/stream/song-2");
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;

    fireEvent.click(screen.getByText("move-later"));
    expect(outgoing.currentTime).toBe(97);
    expect(outgoing).toHaveAttribute("src", "/stream/song-1");
    expect(outgoing.volume).toBe(1);
    expect(incoming).not.toHaveAttribute("src");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);

    await act(async () => jest.advanceTimersByTime(4000));
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
    expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3,song-2");
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  } finally {
    jest.useRealTimers();
  }
});

test("transition mode is global, persists locally, and ignores unknown modes", () => {
  renderPlayer();
  expect(screen.getByTestId("transition-mode")).toHaveTextContent("gapless");

  fireEvent.click(screen.getByText("transition-crossfade"));
  expect(screen.getByTestId("transition-mode")).toHaveTextContent("crossfade");
  expect(localStorage.getItem("playerTransitionMode")).toBe("crossfade");

  fireEvent.click(screen.getByText("transition-invalid"));
  expect(screen.getByTestId("transition-mode")).toHaveTextContent("crossfade");

  fireEvent.click(screen.getByText("transition-none"));
  expect(screen.getByTestId("transition-mode")).toHaveTextContent("none");
  expect(localStorage.getItem("playerTransitionMode")).toBe("none");
});

test("a saved crossfade duration from before transition modes keeps crossfading", () => {
  localStorage.setItem("playerCrossfadeDuration", "12");
  renderPlayer();
  expect(screen.getByTestId("transition-mode")).toHaveTextContent("crossfade");
  expect(screen.getByTestId("crossfade-duration")).toHaveTextContent("10");
});

test("transition mode none never overlaps tracks even with a saved crossfade duration", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer();
    fireEvent.click(screen.getByText("transition-none"));
    fireEvent.click(screen.getByText("crossfade-three"));
    fireEvent.click(screen.getByText("context-first"));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
    const outgoing = activeAudio(container);
    const incoming = idleAudio(container, outgoing);
    startDeckPlaying(outgoing, 100, 97);
    await act(async () => fireEvent.timeUpdate(outgoing));
    // "none" never overlaps tracks, regardless of the saved crossfade duration.
    expect(incoming).not.toHaveAttribute("src");
    expect(outgoing.volume).toBe(1);
  } finally {
    jest.useRealTimers();
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

  const audio = activeAudio(container);
  Object.defineProperty(audio, "paused", { configurable: true, get: () => false });

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

// Byte-range capable streams report a seekable range; live transcodes do not.
function setSeekable(audio, seekable) {
  Object.defineProperty(audio, "seekable", {
    configurable: true,
    value: seekable ? { length: 1, start: () => 0, end: () => 180 } : { length: 0, start: () => 0, end: () => 0 },
  });
}

function streamingDeck(container, { position = 95, readyState = 2 } = {}) {
  const audio = activeAudio(container);
  Object.defineProperty(audio, "paused", { configurable: true, get: () => false });
  Object.defineProperty(audio, "readyState", { configurable: true, writable: true, value: readyState });
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  setSeekable(audio, true);
  audio.currentTime = position;
  fireEvent.timeUpdate(audio);
  // Count every stream (re)load the provider requests on this deck.
  const loads = [];
  Object.defineProperty(audio, "src", {
    configurable: true,
    get() { return this.getAttribute("src") || ""; },
    set(value) { loads.push(value); this.setAttribute("src", value); },
  });
  return { audio, loads };
}

async function startAlbum() {
  const rendered = renderPlayer();
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  return rendered;
}

test("reconnects a stalled stream at the saved position without changing the queue", async () => {
  const { container } = await startAlbum();
  const { audio, loads } = streamingDeck(container);
  const streams = getStreamUrl.mock.calls.length;
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;

  jest.useFakeTimers();
  try {
    fireEvent.waiting(audio);
    act(() => jest.advanceTimersByTime(3499));
    expect(loads).toHaveLength(0);
    expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();

    act(() => jest.advanceTimersByTime(1));
    expect(loads).toEqual(["/stream/song-1"]);
    expect(screen.getByTestId("playback-message")).toHaveTextContent("Reconnecting");

    // The reload resets the element; pause/timeupdate during it must not leak into state.
    audio.currentTime = 0;
    fireEvent.pause(audio);
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
    expect(screen.getByTestId("current-time")).toHaveTextContent("95");

    // Recovery completes once the resumed play() settles.
    await act(async () => fireEvent.loadedMetadata(audio));
    expect(audio.currentTime).toBe(95);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays + 1);

    act(() => fireEvent.playing(audio));
    expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
    expect(screen.getByTestId("unavailable")).toHaveTextContent("false");
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
    expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
    expect(getStreamUrl).toHaveBeenCalledTimes(streams);

    // Recovery is complete: no further reloads are scheduled.
    act(() => jest.advanceTimersByTime(60_000));
    expect(loads).toHaveLength(1);

    // An unseekable live transcode clamps the seek, so the user is told it restarted.
    fireEvent.waiting(audio);
    act(() => jest.advanceTimersByTime(3500));
    expect(loads).toHaveLength(2);
    setSeekable(audio, false);
    audio.currentTime = 0;
    await act(async () => fireEvent.loadedMetadata(audio));
    expect(audio.currentTime).toBe(0);
    act(() => fireEvent.playing(audio));
    expect(screen.getByTestId("playback-message")).toHaveTextContent("restarted");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  } finally {
    jest.useRealTimers();
  }
});

test("retries network errors with backoff, then keeps the position for a manual resume", async () => {
  const { container } = await startAlbum();
  const { audio, loads } = streamingDeck(container);
  Object.defineProperty(audio, "error", { configurable: true, value: { code: 2 } });

  jest.useFakeTimers();
  try {
    act(() => fireEvent.error(audio));
    expect(loads).toHaveLength(1);
    expect(screen.getByTestId("playback-message")).toHaveTextContent("Reconnecting");
    expect(screen.getByTestId("unavailable")).toHaveTextContent("false");

    // A failed reconnect may report any error code.
    Object.defineProperty(audio, "error", { configurable: true, value: { code: 4 } });
    for (const backoff of [1000, 2000, 4000, 8000]) {
      const attempts = loads.length;
      act(() => fireEvent.error(audio));
      act(() => jest.advanceTimersByTime(backoff - 1));
      expect(loads).toHaveLength(attempts);
      act(() => jest.advanceTimersByTime(1));
      expect(loads).toHaveLength(attempts + 1);
    }

    act(() => fireEvent.error(audio));
    expect(loads).toHaveLength(5);
    expect(screen.getByTestId("playback-message")).toHaveTextContent("Lost connection");
    expect(screen.getByTestId("unavailable")).toHaveTextContent("true");
    expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
    // The source stays attached so a manual resume reconnects the same stream.
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    expect(screen.getByTestId("current-time")).toHaveTextContent("95");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  } finally {
    jest.useRealTimers();
  }

  fireEvent.click(screen.getByText("toggle-play"));
  await waitFor(() => expect(loads).toHaveLength(6));
  audio.currentTime = 0;
  act(() => fireEvent.loadedMetadata(audio));
  expect(audio.currentTime).toBe(95);
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
});

test("ignores a stalled download while buffered playback keeps advancing", async () => {
  const { container } = await startAlbum();
  const { audio, loads } = streamingDeck(container, { position: 40, readyState: 4 });

  jest.useFakeTimers();
  try {
    fireEvent.stalled(audio);
    audio.currentTime = 43;
    act(() => jest.advanceTimersByTime(3500));
    act(() => jest.runOnlyPendingTimers());
    expect(loads).toHaveLength(0);
    expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
  } finally {
    jest.useRealTimers();
  }
});

test("pausing during a reconnect restores the position without resuming audio", async () => {
  const { container } = await startAlbum();
  const { audio, loads } = streamingDeck(container);
  const plays = HTMLMediaElement.prototype.play.mock.calls.length;

  jest.useFakeTimers();
  try {
    fireEvent.waiting(audio);
    act(() => jest.advanceTimersByTime(3500));
    expect(loads).toHaveLength(1);

    fireEvent.click(screen.getByText("toggle-play"));
    expect(screen.getByTestId("is-playing")).toHaveTextContent("false");

    audio.currentTime = 0;
    act(() => fireEvent.loadedMetadata(audio));
    expect(audio.currentTime).toBe(95);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
    expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();

    act(() => jest.advanceTimersByTime(60_000));
    expect(loads).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test("remote preparation restores duplicate queue occurrences paused, waits for real data, then starts at the fresh fractional position", async () => {
  let adapter;
  const session = { status: "connected", devices: [], deviceId: "target", activeDevice: null, isRemote: false, enabled: true,
    busy: false, error: "", name: "Target", command: jest.fn(), transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn() };
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => { adapter = player; return session; });
  const view = renderPlayer();
  try {
    await playerReady();
    getListeningTrack.mockResolvedValue({ id: "song-1", title: "Live set", duration: 600, source: { kind: "library" } });
    const snapshot = { trackId: "song-1", exactPositionMs: 123456.789, playing: true, volume: .4,
      queueState: { entries: ["first", "repeat", "third"].map((occurrenceId, index) => ({
        occurrenceId, trackId: index === 2 ? "song-2" : "song-1", title: "Live set", artist: "DJ", album: "Mix", duration: 600,
        resume: { type: "playlist", mediaId: "mix", title: "Mix", trackIndex: index + 3, trackCount: 9, occurrenceId: `playlist-${index}` },
      })), index: 1, repeatOne: true, shuffle: true, shuffleMode: "smart", shuffleSeed: 42, albumAware: true,
        context: { type: "playlist", id: "mix", name: "Mix", coverArt: null } } };
    let complete = false;
    let preparation;
    await act(async () => {
      preparation = adapter.prepare(snapshot, new AbortController().signal).then(() => { complete = true; });
    });
    await waitFor(() => expect(activeAudio(view.container)).toHaveAttribute("src", "/stream/song-1"));
    const audio = activeAudio(view.container);
    expect(complete).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    Object.defineProperty(audio, "duration", { configurable: true, value: 600 });
    Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(123.456789);
    expect(complete).toBe(false);
    Object.defineProperty(audio, "readyState", { configurable: true, value: 3 });
    fireEvent.canPlay(audio);
    await act(async () => { await preparation; });
    expect(complete).toBe(true);
    const captured = adapter.capture();
    expect(captured.queueState.entries.map((entry) => entry.trackId)).toEqual(["song-1", "song-1", "song-2"]);
    expect(new Set(captured.queueState.entries.map((entry) => entry.occurrenceId)).size).toBe(3);
    expect(captured.queueState).toMatchObject({ index: 1, repeatOne: true, shuffle: true, shuffleMode: "smart", shuffleSeed: 42, albumAware: true });
    expect(captured.queueState.entries[1].resume).toEqual(snapshot.queueState.entries[1].resume);
    expect(captured.playing).toBe(false);
    HTMLMediaElement.prototype.play.mockImplementation(function () {
      Object.defineProperty(this, "paused", { configurable: true, value: false });
      return Promise.resolve();
    });
    await act(async () => { await adapter.start({ ...snapshot, exactPositionMs: 125789.123 }); });
    expect(audio.currentTime).toBe(125.789123);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
    expect(screen.getByTestId("volume")).toHaveTextContent("0.4");
    await act(async () => { await adapter.command({ type: "SEEK", position_ms: 321789.456 }); });
    expect(audio.currentTime).toBe(321789.456 / 1000);
  } finally { view.unmount(); hook.mockRestore(); }
});

test("remote now-playing and transport controls reflect the selected device without echoing target commands", async () => {
  let adapter;
  const active = { device_id: "desk", queue_device_id: "desk-queue", device_name: "Desk", device_type: "computer", is_active_player: true, can_receive: true,
    current_track: { id: "remote-song", title: "Remote set", artist: "Remote artist", cover_art: "mdart_remote" },
    position_ms: 42125, duration_ms: 600000, playing: true, volume: .8 };
  const checkpoint = { index: 0, position: 42, repeatOne: false, shuffle: false, shuffleSeed: null,
    shuffleMode: "standard", albumAware: false, volume: .8, wasPlaying: true, context: null, capturedAt: Date.now() };
  request.mockImplementation(async (url) => url.endsWith("/content/desk-content")
    ? { version: 2, entries: [active.current_track, ...songs.slice(0, 2)].map((track, index) => ({ entryId: `desk-${index}`, track })) }
    : { sessions: [{ deviceId: "desk-queue", contentId: "desk-content", checkpoint, trackCount: 3 }], namedQueues: [] });
  const command = jest.fn(async () => {});
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return { status: "connected", devices: [active], deviceId: "phone", activeDevice: active, isRemote: true,
      enabled: true, busy: false, error: "", name: "Phone", command, transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn() };
  });
  function LocalRestore() {
    const { currentSong, restoreSavedQueue } = usePlayer();
    return <>
      <div data-testid="live-metadata">{currentSong?.artist} / {currentSong?.coverArt}</div>
      <button onClick={() => restoreSavedQueue({ version: 2, entries: [{ entryId: "local-saved", track: songs[0] }] },
        { ...checkpoint, wasPlaying: false })}>restore-local-queue</button>
    </>;
  }
  const view = renderPlayer({ children: <><PlayerHarness /><LocalRestore /></> });
  try {
    await playerReady();
    expect(screen.getByTestId("current-song")).toHaveTextContent("remote-song");
    expect(screen.getByTestId("live-metadata")).toHaveTextContent("Remote artist / mdart_remote");
    expect(screen.getByTestId("current-time")).toHaveTextContent("42.125");
    expect(screen.getByTestId("volume")).toHaveTextContent("0.8");
    await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("remote-song,song-1,song-2"));
    fireEvent.click(screen.getByText("move-later"));
    expect(command).toHaveBeenCalledWith({ type: "MOVE_QUEUE_ENTRY", entry_id: "desk-1", target_id: "desk-2" });
    fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
    expect(command).toHaveBeenCalledWith({ type: "PAUSE" });
    fireEvent.click(screen.getByRole("button", { name: "direct" }));
    expect(command).toHaveBeenLastCalledWith({
      type: "PLAY_SELECTION", tracks: [expect.objectContaining({ id: "song-1" })],
      start_index: 0, from_here: false, context: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "album" }));
    expect(command).toHaveBeenLastCalledWith({
      type: "PLAY_SELECTION", tracks: songs.map(song => expect.objectContaining({ id: song.id })),
      start_index: 1, from_here: false, context: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "context-second" }));
    expect(command).toHaveBeenLastCalledWith({
      type: "PLAY_SELECTION", tracks: songs.map(song => expect.objectContaining({ id: song.id })),
      start_index: 1, from_here: true, context: { type: "album", id: "", name: "Album", coverArt: null },
    });
    expect(adapter.state().current_track).toBe(null);
    expect(getStreamUrl).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "restore-local-queue" }));
    expect(screen.getByTestId("current-song")).toHaveTextContent("remote-song");
    fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
    expect(command).toHaveBeenLastCalledWith({ type: "PAUSE" });
  } finally { view.unmount(); hook.mockRestore(); }
});

test("loads a controller's selection on the active player from the requested track", async () => {
  let adapter;
  const command = jest.fn();
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return { status: "connected", devices: [], deviceId: "desk", activeDevice: null, isRemote: false,
      enabled: true, busy: false, error: "", name: "Desk", command, transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn() };
  });
  const view = renderPlayer();
  try {
    await playerReady();
    await act(async () => adapter.command({
      type: "PLAY_SELECTION", tracks: songs, start_index: 1, from_here: true,
      context: { type: "album", id: "album-1", name: "Album", coverArt: null },
    }));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
    expect(screen.getByTestId("queue")).toHaveTextContent("song-2,song-3");
    expect(activeAudio(view.container)).toHaveAttribute("src", "/stream/song-2");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  } finally { view.unmount(); hook.mockRestore(); }
});
