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
import { playlistOrder, playlistPlaybackContext } from "../utils/playlistPlayback";

import {
  getCurrentSession,
  getRecentlyPlayed,
  getAutoplayTracks,
  getPlaylist,
  getRandomSongs,
  getTrackCollection,
  getStarred,
  getStreamUrl,
  inspectAudioStream,
  prepareNormalizedPlayback,
  getUserSettings,
  updateUserSettings,
  getSilenceAnalysis,
  SILENCE_ANALYZED_EVENT,
  analyzeSilence,
  USER_SETTINGS_CHANGED_EVENT,
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
  getPlaylist: jest.fn(),
  getRandomSongs: jest.fn(),
  getTrackCollection: jest.fn(),
  RECOMMENDATION_FEEDBACK_CHANGED_EVENT: "musicdeck:recommendation-feedback-changed",
  getStarred: jest.fn(),
  getStreamUrl: jest.fn(),
  inspectAudioStream: jest.fn(),
  prepareNormalizedPlayback: jest.fn(),
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(async () => []),
  getSilenceAnalysis: jest.fn(),
  SILENCE_ANALYZED_EVENT: "musicdeck:silence-analyzed",
  analyzeSilence: jest.fn(),
  USER_SETTINGS_CHANGED_EVENT: "musicdeck:user-settings-changed",
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

const librarySelection = { query: { query: "live", sort: "title-asc", favoritesOnly: false, unplayedOnly: false }, trackId: null, shuffle: true };

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
    loopPlaylistId,
    isLooping,
    repeatMode,
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
    seekToSeconds,
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
    isEndlessPlaybackEnabled,
    changeEndlessPlaybackEnabled,
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
      <button onClick={() => seekToSeconds(15.5)}>seek-local</button>
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
      <button onClick={() => playContext(songs, songs.length - 1, { type: "playlist", id: "test-playlist", name: "Test playlist", coverArt: null })}>
        playlist-from-last
      </button>
      <button onClick={() => togglePlaylistLoop("test-playlist")} aria-pressed={loopPlaylistId === "test-playlist"}>loop-only-playlist</button>
      <button onClick={() => playContext([songs[2]], 0, { type: "collection", id: "test-playlist", playlistLoopId: "test-playlist",
        name: "Test playlist", coverArt: null })}>filtered-playlist</button>
      <button onClick={() => playQueue(songs, 0, { type: "playlist", id: "test-playlist", name: "Test playlist", coverArt: null })}>
        playlist-from-start
      </button>
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
      <button onClick={() => changeEndlessPlaybackEnabled(false)}>
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
      <div data-testid="repeat-mode">{repeatMode}</div>
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
        {String(isEndlessPlaybackEnabled)}
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
  endless = false,
} = {}) {
  if (!normalize) localStorage.setItem("playerNormalizationEnabled", "false");
  if (endless) localStorage.setItem("playerAutoplayEnabled", "true");
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
  getPlaylist.mockResolvedValue(null);
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
  saveMediaCheckpoint.mockResolvedValue({ checkpoint: null });
  getStreamUrl.mockImplementation(
    (songId) => `/stream/${songId}`
  );
  HTMLMediaElement.prototype.play = jest.fn(
    () => Promise.resolve()
  );
  HTMLMediaElement.prototype.pause = jest.fn();

  const tree = (content) => (
    <AuthProvider>
      <PlayerProvider>
        {content}
      </PlayerProvider>
    </AuthProvider>
  );
  const view = render(tree(children));
  return { ...view, rerenderPlayer: (content = children) => view.rerender(tree(content)) };
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
  // Most player tests model a registered, standalone device. Remote tests override the registry.
  jest.spyOn(remoteSessionModule, "useRemoteSession").mockReturnValue({
    status: "connected", devices: [], deviceId: "local", activeDevice: null, isRemote: false,
    enabled: false, busy: false, error: "", name: "Local",
    command: jest.fn(async () => {}), transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn(),
  });
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

test("live Smart Shuffle moves recent tracks later without interrupting playback or losing them", async () => {
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
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-3,song-2");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  activeAudio(container).currentTime = 0;
  fireEvent.click(screen.getByText("previous"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-3,song-2");
  fireEvent.click(screen.getByText("shuffle"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3");
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
  fireEvent.click(screen.getByText("loop"));
  fireEvent.ended(audioDecks(container)[0]);
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
});

test("a pending autoplay refill cannot overwrite a newer queue order", async () => {
  renderPlayer({ endless: true });
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

test("editing a paused cloud queue publishes the local edit and ignores newer peer snapshots", async () => {
  const random = jest.spyOn(Math, "random").mockReturnValue(0);
  let checkpoint = { index: 0, position: 15, repeatOne: false, shuffle: false, shuffleSeed: null,
    shuffleMode: "standard", albumAware: false, volume: .65, wasPlaying: false, context: null, capturedAt: Date.now() };
  const content = { version: 2, entries: songs.map((track, index) => ({ entryId: `desk-${index}`, track })) };
  request.mockImplementation(async (url, options) => {
    if (url.endsWith("/content/peer-content")) return content;
    if (options?.method === "POST") return { contentId: "local-content" };
    if (options?.method === "PUT") return { saved: true, sequence: JSON.parse(options.body).sequence };
    return { sessions: [{ deviceId: "peer", contentId: "peer-content", checkpoint, trackCount: 3 }], namedQueues: [] };
  });
  renderPlayer();
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("loop"));
  checkpoint = { ...checkpoint, capturedAt: Date.now() + 60_000 };
  await act(async () => queueSyncClient.refresh());
  expect(screen.getByTestId("repeat-mode")).toHaveTextContent("all");
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-3,song-2");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  await waitFor(() => expect(request.mock.calls.some(([url, options]) => {
    if (!url.endsWith("/queue-session") || options?.method !== "PUT") return false;
    const saved = JSON.parse(options.body).checkpoint;
    return saved.repeatAll === true && saved.shuffle === true && saved.index === 0 && saved.position === 15;
  })).toBe(true));
  fireEvent.click(screen.getByText("shuffle"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3");
  random.mockRestore();
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

test("resumes a saved browser queue without waiting for the device list", async () => {
  localStorage.setItem(queueStorageKey("user-1"), JSON.stringify(createQueueSnapshot({
    currentSong: songs[1], queue: songs, queueIndex: 1,
    currentTime: 42.75, wasPlaying: true,
  })));
  const connection = {
    status: "connecting", deviceId: "browser", devices: [], activeDevice: null, isRemote: false,
    enabled: false, busy: false, error: "", name: "Browser",
    command: jest.fn(async () => {}), transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn(),
  };
  const remote = jest.spyOn(remoteSessionModule, "useRemoteSession").mockReturnValue(connection);
  const { container, rerenderPlayer } = renderPlayer();
  const audio = container.querySelector("audio");
  await waitFor(() => expect(audio).toHaveAttribute("src", "/stream/song-2"));
  Object.defineProperty(audio, "duration", { configurable: true, value: 180 });
  await act(async () => { fireEvent.loadedMetadata(audio); });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(audio.currentTime).toBeCloseTo(42.75);

  const desktop = {
    device_id: "desk", device_name: "MusicDeck Desktop", device_type: "computer", is_active_player: true,
    can_receive: true, current_track: { id: "desktop-song", title: "Desktop song" },
    position_ms: 1000, duration_ms: 180000, playing: true, volume: .8,
  };
  remote.mockReturnValue({ ...connection, status: "connected", devices: [desktop], activeDevice: desktop, isRemote: true });
  rerenderPlayer(<PlayerHarness />);
  expect(screen.getByTestId("current-song")).toHaveTextContent("desktop-song");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
  expect(connection.command).toHaveBeenCalledWith({ type: "PAUSE" });
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

test("requests analysis for an unscanned library track when silence trimming is enabled", async () => {
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

test("applies manual analysis to the active stream even after its automatic attempt failed", async () => {
  const { container } = renderPlayer({
    userSettings: [{ key: "playback.silenceTrim.enabled", value: "true" }],
  });
  analyzeSilence.mockResolvedValueOnce({ status: "failed" });
  await playerReady();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(analyzeSilence).toHaveBeenCalledWith("song-1", expect.anything()));
  const audio = activeAudio(container);
  startDeckPlaying(audio, 100, 0);
  Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(0);
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 500);
  act(() => window.dispatchEvent(new CustomEvent(SILENCE_ANALYZED_EVENT, {
    detail: { trackId: "song-1", analysis: {
      status: "completed", thresholdDb: -35, minSilenceSeconds: 0.5,
      leadingSilenceSeconds: 1.5, trailingSilenceSeconds: 2, durationSeconds: 100,
    } },
  })));
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(1.4));
  expect(activeAudio(container)).toBe(audio);
  expect(analyzeSilence.mock.calls.filter(([id]) => id === "song-1")).toHaveLength(1);
});

test("a saved trim toggle applies to the active stream and preserves original listening timestamps", async () => {
  const { container } = renderPlayer({
    silenceAnalysis: {
      status: "completed", leadingSilenceSeconds: 0.8, trailingSilenceSeconds: 20, durationSeconds: 100,
    },
  });
  await playerReady();
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const audio = activeAudio(container);
  startDeckPlaying(audio, 100, 0);
  Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
  fireEvent.loadedMetadata(audio);
  expect(getSilenceAnalysis).not.toHaveBeenCalled();

  const setTrim = (enabled) => window.dispatchEvent(new CustomEvent(USER_SETTINGS_CHANGED_EVENT, {
    detail: { "playback.silenceTrim.enabled": enabled },
  }));
  jest.spyOn(Date, "now").mockReturnValue(Date.now() + 500);
  act(() => setTrim(true));
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(0.7));

  act(() => setTrim(false));
  audio.currentTime = 90;
  fireEvent.timeUpdate(audio);
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(activeAudio(container)).toBe(audio);
  fireEvent.ended(audio);
  await waitFor(() => expect(recordListeningEvent).toHaveBeenCalledWith(expect.objectContaining({
    trackId: "song-1", durationSeconds: 100, listenedSeconds: 0, finished: true,
  })));
  expect(recordListeningEvent.mock.calls.filter(([report]) => report.finished)).toHaveLength(1);
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

test("clears a playback failure when the same library track starts on a manual retry", async () => {
  const { container } = renderPlayer();
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(new Error("temporary failure"));
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("unavailable")).toHaveTextContent("true"));

  fireEvent.click(screen.getByText("toggle-play"));
  fireEvent.playing(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("unavailable")).toHaveTextContent("false"));
  expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
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

test.each([false, true])("playlist loop replays the full filtered playlist and clears queued radio tracks with Endless Playback %s", async (endless) => {
  const { container } = renderPlayer({ endless, children: <><PlayerHarness /><RadioQueueHarness /></> });
  function RadioQueueHarness() {
    const { queueTracks } = usePlayer();
    return <button onClick={() => queueTracks([{ id: "outside-playlist", autoplayGenerated: true }])}>queue-radio-track</button>;
  }
  await playerReady();
  getPlaylist.mockResolvedValue({ entry: songs });
  fireEvent.click(screen.getByText("filtered-playlist"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-3"));
  fireEvent.click(screen.getByText("queue-radio-track"));
  expect(screen.getByTestId("queue").textContent).toBe("song-3,outside-playlist");

  const loop = screen.getByRole("button", { name: "loop-only-playlist" });
  fireEvent.click(loop);
  expect(loop).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(screen.getByTestId("queue").textContent).toBe("song-3"));
  await waitFor(async () => expect((await readLocalQueue("user-1"))?.head.checkpoint).toMatchObject({
    loopPlaylistId: "test-playlist", context: { playlistLoopId: "test-playlist" },
  }));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3");
  expect(getAutoplayTracks).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
  fireEvent.click(loop);
  expect(loop).toHaveAttribute("aria-pressed", "false");
});

test("looped endings replay the active track while manual next still advances", async () => {
  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => {
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  });

  fireEvent.click(screen.getByText("loop"));
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
  expect(getRandomSongs).not.toHaveBeenCalled();
});


test("Endless Playback appends seeded recommendations before a single track ends", async () => {
  const { container } = renderPlayer({ endless: true });
  await playerReady();
  getAutoplayTracks.mockResolvedValueOnce([songs[0], {
    ...songs[2], recommendationGenerated: true, autoplayGenerated: true,
  }, ...Array.from({ length: 24 }, (_, index) => ({ id: `recommended-${index}` }))]);
  fireEvent.click(screen.getByText("direct"));

  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-3"));
  expect(screen.getByTestId("queue").textContent.split(",")).toHaveLength(26);
  expect(getAutoplayTracks).toHaveBeenCalledWith("song-1", 30, ["song-1"], {}, expect.any(AbortSignal));
  expect(getRandomSongs).not.toHaveBeenCalled();
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");

  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-3"));
  expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
});

test("a short recommendation list queues immediately and library tracks fill the sidebar preview", async () => {
  const { container } = renderPlayer({ endless: true });
  await playerReady();
  getAutoplayTracks.mockResolvedValueOnce([songs[1], songs[2]]);
  let finishLibraryRefill;
  getRandomSongs.mockImplementationOnce(() => new Promise((resolve) => { finishLibraryRefill = resolve; }));
  fireEvent.click(screen.getByText("direct"));

  await waitFor(() => expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3"));
  expect(getRandomSongs).toHaveBeenCalledWith(28, expect.any(AbortSignal));
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");

  const library = Array.from({ length: 25 }, (_, index) => ({ id: `library-${index}` }));
  await act(async () => finishLibraryRefill([
    songs[0], songs[1], { id: "unavailable", availability: { libraryAvailable: false } }, ...library,
  ]));
  expect(screen.getByTestId("queue").textContent.split(",")).toEqual([
    "song-1", "song-2", "song-3", ...library.slice(0, 23).map(({ id }) => id),
  ]);
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-2"));
});

test.each([
  ["empty", () => Promise.resolve([])],
  ["failed", () => Promise.reject(new Error("Recommendations offline"))],
])("an %s recommendation refill falls back to library tracks before the queue ends", async (_result, refill) => {
  const { container } = renderPlayer({ endless: true });
  await playerReady();
  getAutoplayTracks.mockImplementationOnce(refill);
  getRandomSongs.mockResolvedValueOnce([songs[1]]);
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2"));
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(getRandomSongs).toHaveBeenCalledWith(30, expect.any(AbortSignal));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
  expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
});

test("library playback continues at the queue end while a random-track refill is pending", async () => {
  localStorage.setItem("musicdeck:playback:autoplayRecommendations", "false");
  const { container } = renderPlayer({ endless: true });
  let finishRefill;
  getRandomSongs.mockImplementationOnce(() => new Promise((resolve) => { finishRefill = resolve; }));
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(finishRefill).toBeDefined());
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("queue-index")).toHaveTextContent("1"));
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-1");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("true");

  await act(async () => finishRefill([songs[2]]));
  expect(screen.getByTestId("queue")).not.toHaveTextContent("song-3");
  expect(getAutoplayTracks).not.toHaveBeenCalled();
});

test("a pending refill at the end of a preview cannot block or extend a new queue", async () => {
  const { container } = renderPlayer({ endless: true });
  let finishRefill;
  getRandomSongs.mockImplementationOnce(() => new Promise((resolve) => { finishRefill = resolve; }));
  fireEvent.click(screen.getByText("catalog-with-preview"));
  await waitFor(() => expect(finishRefill).toBeDefined());
  fireEvent.ended(activeAudio(container));

  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1"));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("queue-index")).toHaveTextContent("1"));
  await act(async () => finishRefill([songs[2]]));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-1");
});

test("disabling Endless Playback removes the prepared refill and lets the current track finish", async () => {
  const { container } = renderPlayer({ endless: true });
  getAutoplayTracks.mockResolvedValueOnce([songs[1]]);
  fireEvent.click(screen.getByText("direct"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2"));

  fireEvent.click(screen.getByText("disable-autoplay"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1");
  expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("none"));
});

test("Endless Playback wraps a partial playlist from its full first track", async () => {
  const { container } = renderPlayer({ endless: true });
  fireEvent.click(screen.getByText("playlist-from-last"));
  await waitFor(() => expect(screen.getByTestId("queue").textContent).toBe("song-3"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  fireEvent.ended(activeAudio(container));

  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3");
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  expect(getPlaylist).not.toHaveBeenCalled();
  expect(getAutoplayTracks).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
});

test("a restored playlist preloads its full order before wrapping a saved tail", async () => {
  const context = { type: "playlist", id: "test-playlist", name: "Test playlist", coverArt: null };
  await writeLocalQueue("user-1", {
    version: 2, entries: [{ entryId: "saved-tail", track: { ...songs[2], tastePlaylistId: context.id } }],
  }, {
    index: 0, position: 12, repeatOne: false, shuffle: false, shuffleSeed: null, shuffleMode: "standard",
    albumAware: false, volume: 1, wasPlaying: false, context, capturedAt: Date.now(),
  });
  const { container } = renderPlayer({ userSettings: [{ key: "playback.autoplay.enabled", value: "true" }] });
  getPlaylist.mockResolvedValueOnce({ entry: songs });
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-3"));
  await waitFor(() => expect(screen.getByTestId("autoplay-enabled")).toHaveTextContent("true"));
  fireEvent.click(screen.getByText("toggle-play"));
  await waitFor(() => expect(getPlaylist).toHaveBeenCalledWith(context.id, expect.any(AbortSignal)));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-3"));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3"));
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(getRandomSongs).not.toHaveBeenCalled();
});

test.each([false, true])("Endless Playback reshuffles a playlist with repeat queue set to %s", async (repeatQueue) => {
  jest.spyOn(Math, "random").mockReturnValue(0.99);
  const { container } = renderPlayer({ endless: true });
  fireEvent.click(screen.getByText("shuffle"));
  fireEvent.click(screen.getByText("playlist-from-start"));
  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-1"));
  if (repeatQueue) fireEvent.click(screen.getByText("loop"));
  const original = screen.getByTestId("queue").textContent.split(",");
  for (const id of original.slice(1)) {
    fireEvent.ended(activeAudio(container));
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent(id));
  }
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(screen.getByTestId("queue-index")).toHaveTextContent("0"));

  const reshuffled = screen.getByTestId("queue").textContent.split(",");
  expect(reshuffled).not.toEqual(original);
  expect([...reshuffled].sort()).toEqual([...original].sort());
  expect(screen.getByTestId("current-song")).toHaveTextContent(reshuffled[0]);
  expect(getAutoplayTracks).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("shuffle"));
  expect(screen.getByTestId("queue").textContent.split(",")).toEqual([
    reshuffled[0], ...songs.map(song => song.id).filter(id => id !== reshuffled[0]),
  ]);
});

test("a playlist finishes with Endless Playback off by default", async () => {
  const { container } = renderPlayer();
  fireEvent.click(screen.getByText("playlist-from-last"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  fireEvent.ended(activeAudio(container));

  await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("none"));
  expect(getPlaylist).not.toHaveBeenCalled();
  expect(getRandomSongs).not.toHaveBeenCalled();
});

test("auto-refill appends new tracks once two or fewer remain without interrupting playback", async () => {
  const refill = [songs[1], { id: "refill-1", title: "Refill One" }, { id: "refill-2", title: "Refill Two" }];
  const { container } = renderPlayer({ endless: true });
  await playerReady();
  getAutoplayTracks.mockResolvedValue(refill);

  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3,refill-1,refill-2"));
  // Two upcoming tracks: ask for enough to fill the sidebar, plus spares for duplicates.
  expect(getAutoplayTracks).toHaveBeenCalledTimes(1);
  expect(getAutoplayTracks).toHaveBeenCalledWith("song-1", 28, ["song-1", "song-2", "song-3"], {}, expect.any(AbortSignal));
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
  const { container } = renderPlayer({ endless: true });
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
  const { container } = renderPlayer({ endless: true });
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
  renderPlayer({ endless: true });
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


test("shuffle toggles only the upcoming order and preserves the current audio position", async () => {
  const random = jest.spyOn(Math, "random").mockReturnValue(0);

  const { container } = renderPlayer();

  fireEvent.click(screen.getByText("album-start"));

  await waitFor(() => {
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "song-1,song-2,song-3"
    );
  });
  const audio = activeAudio(container);
  audio.currentTime = 13.5;
  const playCount = HTMLMediaElement.prototype.play.mock.calls.length;

  fireEvent.click(screen.getByText("shuffle"));

  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
  expect(screen.getByTestId("queue")).toHaveTextContent(
    "song-1,song-3,song-2"
  );
  expect(screen.getByTestId("queue-index")).toHaveTextContent("0");

  fireEvent.click(screen.getByText("shuffle"));

  expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("false");
  expect(screen.getByTestId("queue").textContent).toBe("song-1,song-2,song-3");
  expect(activeAudio(container)).toBe(audio);
  expect(audio.currentTime).toBe(13.5);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount);

  random.mockRestore();
});


test("loop mode cycles off, queue, and one", () => {
  renderPlayer();
  expect(screen.getByTestId("repeat-mode")).toHaveTextContent("off");
  fireEvent.click(screen.getByText("loop"));
  expect(screen.getByTestId("repeat-mode")).toHaveTextContent("all");
  fireEvent.click(screen.getByText("loop"));
  expect(screen.getByTestId("repeat-mode")).toHaveTextContent("one");
  fireEvent.click(screen.getByText("loop"));
  expect(screen.getByTestId("repeat-mode")).toHaveTextContent("off");
});

test("repeat queue wraps a normal queue before Endless Playback can refill it", async () => {
  const { container } = renderPlayer({ endless: true });
  fireEvent.click(screen.getByText("loop"));
  fireEvent.click(screen.getByText("album"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-2"));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-3"));
  fireEvent.ended(activeAudio(container));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1"));
  expect(getAutoplayTracks).not.toHaveBeenCalled();
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

test("a gateway error from optional loudness normalization leaves audio playing", async () => {
  const { container } = renderPlayer({ normalize: true });
  let fail;
  prepareNormalizedPlayback.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await act(async () => fireEvent.click(screen.getByText("direct")));
  const audio = activeAudio(container);
  audio.currentTime = 25;
  await act(async () => fail(Object.assign(new Error("Gateway error"), { status: 502 })));
  expect(audio).toHaveAttribute("src", "/stream/song-1");
  expect(audio.currentTime).toBe(25);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

test("uses Web Audio for smooth boosts while keeping the volume slider and source intact", async () => {
  const gain = { value: 1, cancelScheduledValues: jest.fn(), setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() };
  const node = { gain, connect: jest.fn(), disconnect: jest.fn() };
  const context = { state: "running", currentTime: 10, destination: {}, createGain: jest.fn(() => node), createMediaElementSource: jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn() })), close: jest.fn(async () => {}) };
  window.AudioContext = jest.fn(() => context);
  const originalActivation = Object.getOwnPropertyDescriptor(navigator, "userActivation");
  const activation = { hasBeenActive: false };
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
  try {
    const { container } = renderPlayer({ normalize: true });
    let finish;
    prepareNormalizedPlayback.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    activation.hasBeenActive = true;
    fireEvent.click(screen.getByText("direct"));
    const audio = container.querySelector("audio");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    audio.currentTime = 17;
    await act(async () => finish({ status: "ready", streamUrl: normalizedUrl(), gainDb: 6 }));
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(1, 10);
    const [target, end] = gain.linearRampToValueAtTime.mock.calls.at(-1);
    expect(target).toBeCloseTo(10 ** (6 / 20));
    expect(end).toBeCloseTo(22);
    expect(audio.volume).toBe(1);
    fireEvent.click(screen.getByText("volume-half"));
    // The master GainNode carries the slider level; the element stays at unity.
    expect(audio.volume).toBe(1);
    expect(gain.setValueAtTime.mock.calls.at(-1)[0]).toBeCloseTo(10 ** (-10 / 20));
    expect(audio.currentTime).toBe(17);
    expect(audio).toHaveAttribute("src", "/stream/song-1");
    // One source node per deck, each created once and never re-created on reloads.
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(2);
  } finally {
    delete window.AudioContext;
    if (originalActivation) Object.defineProperty(navigator, "userActivation", originalActivation);
    else Reflect.deleteProperty(navigator, "userActivation");
  }
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
  const upcomingUrl = normalizedUrl("b");
  let finishUpcoming;
  prepareNormalizedPlayback.mockImplementation(id => id === "song-2"
    ? new Promise(resolve => { finishUpcoming = resolve; })
    : Promise.resolve({ status: "unavailable" }));
  await playerReady();

  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(prepareNormalizedPlayback).toHaveBeenCalledWith("song-2", null, null, expect.any(AbortSignal), "original", -16));
  await act(async () => finishUpcoming({ status: "ready", streamUrl: upcomingUrl, gainDb: -6 }));
  expect(activeAudio(container)).toHaveAttribute("src", "/stream/song-1");

  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", upcomingUrl));
  expect(activeAudio(container).volume).toBe(1);
});

test("retargeting a prepared track holds its position and leaves prior tracks out of analysis", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer({ normalize: true });
    const url = normalizedUrl("b");
    prepareNormalizedPlayback.mockImplementation(id => Promise.resolve(id === "song-2"
      ? { status: "ready", streamUrl: url, gainDb: -6, integratedLufs: -16, truePeakDb: -2,
        loudness: { integratedLufs: -10, truePeakDb: -1 } }
      : { status: "unavailable" }));
    await playerReady();
    fireEvent.click(screen.getByText("album-start"));
    await act(async () => {});
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", url));
    const { audio, loads } = streamingDeck(container);
    startDeckPlaying(audio, 180, 24);
    fireEvent.timeUpdate(audio);
    fireEvent.click(screen.getByText("target-18"));
    await act(async () => jest.advanceTimersByTime(8000));
    expect(audio).toHaveAttribute("src", url);
    expect(audio.currentTime).toBe(24);
    expect(audio.volume).toBeCloseTo(10 ** (-2 / 20));
    expect(loads).toEqual([]);
    expect(prepareNormalizedPlayback).not.toHaveBeenCalledWith("song-1", null, null, expect.anything(), "original", -18);
  } finally { jest.useRealTimers(); }
});

test("an expired normalized stream falls back at the same position and applies only the original gain", async () => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer({ normalize: true });
    prepareNormalizedPlayback.mockImplementation(id => Promise.resolve(id === "song-2"
      ? { status: "ready", streamUrl: normalizedUrl("b"), gainDb: -6,
        integratedLufs: -16, truePeakDb: -2,
        loudness: { integratedLufs: -10, truePeakDb: -1, gainDb: -6 } }
      : { status: "unavailable" }));
    await playerReady();
    fireEvent.click(screen.getByText("album-start"));
    await act(async () => {});
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(activeAudio(container)).toHaveAttribute("src", normalizedUrl("b")));
    const { audio, loads } = streamingDeck(container);
    startDeckPlaying(audio, 180, 24);
    fireEvent.timeUpdate(audio);
    expect(audio.volume).toBe(1);
    Object.defineProperty(audio, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(audio);

    expect(loads).toEqual([expect.stringMatching(/\/stream\/song-2$/)]);
    audio.currentTime = 0;
    await act(async () => fireEvent.loadedMetadata(audio));
    expect(audio.currentTime).toBe(24);
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-2");
    await act(async () => jest.advanceTimersByTime(16000));
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20));
  } finally { jest.useRealTimers(); }
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
  const { container } = renderPlayer({ endless: true });
  let finishRefill;
  getAutoplayTracks.mockImplementationOnce(() => new Promise((resolve) => { finishRefill = resolve; }));
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(finishRefill).toBeDefined());
  expect(container.querySelector("audio")).toHaveAttribute("src", "/stream/song-1");
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  await act(async () => finishRefill([]));
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
    startDeckPlaying(incoming, 100, 0);

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


test.each([false, true])("crossfade with silence trimming %s sends one completion and both checkpoints during a pending inspection", async (trim) => {
  jest.useFakeTimers();
  try {
    const { container } = renderPlayer(trim ? {
      userSettings: [{ key: "playback.silenceTrim.enabled", value: "true" }],
      silenceAnalysis: { status: "completed", leadingSilenceSeconds: 1, trailingSilenceSeconds: 20, durationSeconds: 180 },
    } : {});
    inspectAudioStream.mockImplementation(() => new Promise(() => {}));
    getStreamUrl.mockImplementation((id) => `/api/tracks/${id}/stream`);
    await playerReady();
    fireEvent.click(screen.getByText("transition-crossfade"));
    fireEvent.click(screen.getByText("crossfade-three"));
    fireEvent.click(screen.getByText("resume-collection"));
    await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
    const firstInspection = inspectAudioStream.mock.calls.find(([id]) => id === "song-2");
    expect(firstInspection).toBeDefined();
    const outgoing = activeAudio(container);
    const incoming = idleAudio(container, outgoing);
    startDeckPlaying(outgoing, 180, 102.125);
    fireEvent.loadedMetadata(outgoing);
    fireEvent.playing(outgoing);
    fireEvent.timeUpdate(outgoing);
    if (trim) await waitFor(() => expect(getSilenceAnalysis).toHaveBeenCalledWith("song-2", expect.any(Object)));

    await act(async () => {
      jest.advanceTimersByTime(31_000);
      outgoing.currentTime = trim ? 157.2 : 177;
      fireEvent.timeUpdate(outgoing);
    });
    expect(incoming).toHaveAttribute("src", expect.stringMatching(/^\/api\/tracks\/song-3\/stream\?inspectionId=/));
    expect(screen.getByTestId("queue-index")).toHaveTextContent("1");

    startDeckPlaying(incoming, 180, 2.5);
    await act(async () => {
      if (trim) {
        outgoing.currentTime = 160.2;
        fireEvent.timeUpdate(outgoing);
      }
      fireEvent.ended(outgoing);
      fireEvent.ended(outgoing);
      jest.advanceTimersByTime(3500);
    });
    expect(screen.getByTestId("current-song")).toHaveTextContent("song-3");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("2");
    expect(outgoing).not.toHaveAttribute("src");
    expect(firstInspection[2].aborted).toBe(true);
    expect(inspectAudioStream).toHaveBeenLastCalledWith("song-3", expect.any(String), expect.any(AbortSignal));

    const completed = () => recordListeningEvent.mock.calls.map(([body]) => body).filter((body) => body.finished);
    await waitFor(() => expect(completed()).toEqual([expect.objectContaining({ trackId: "song-2", durationSeconds: 180 })]));
    fireEvent.click(screen.getByText("toggle-play"));
    await waitFor(() => expect(saveMediaCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      type: "album", mediaId: "long-album", trackId: "song-3", trackIndex: 2, positionSeconds: 2.5, durationSeconds: 180,
    }), expect.any(AbortSignal)));
    await waitFor(() => expect(request.mock.calls.some(([url, options]) =>
      url === "/api/v1/user/queue-session" && options?.method === "PUT" && JSON.parse(options.body).checkpoint.index === 2
    )).toBe(true));
    expect(completed()).toHaveLength(1);
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
    await act(async () => {
      fireEvent.loadedMetadata(audio);
      fireEvent.canPlay(audio);
    });
    expect(audio.currentTime).toBe(0);
    act(() => fireEvent.playing(audio));
    expect(screen.getByTestId("playback-message")).toHaveTextContent("restarted");
    expect(screen.getByTestId("queue-index")).toHaveTextContent("0");
  } finally {
    jest.useRealTimers();
  }
});

test.each([false, true])("reloads the same URL and then a fresh stream with inspection set to %s", async (inspect) => {
  localStorage.setItem("musicdeck:playback:streamInspection", String(inspect));
  inspectAudioStream.mockResolvedValue({ source: null, output: null, delivery: null });
  const view = renderPlayer();
  getStreamUrl.mockImplementation((songId) => `/api/tracks/${songId}/stream?source=primary`);
  fireEvent.click(screen.getByText("album-start"));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const { audio, loads } = streamingDeck(view.container);
  const original = audio.src;
  const originalId = new URL(original, window.location.origin).searchParams.get("inspectionId");
  expect(originalId).toBeTruthy();
  if (inspect) await waitFor(() => expect(inspectAudioStream).toHaveBeenCalledWith("song-1", originalId, expect.any(AbortSignal)));

  jest.useFakeTimers();
  try {
    act(() => fireEvent.waiting(audio));
    act(() => jest.advanceTimersByTime(3500));
    expect(loads).toEqual([original]);

    act(() => fireEvent.error(audio));
    act(() => jest.advanceTimersByTime(1000));
    expect(loads).toHaveLength(2);
    const fresh = new URL(loads[1], window.location.origin);
    const freshId = fresh.searchParams.get("inspectionId");
    expect(freshId).toBeTruthy();
    expect(freshId).not.toBe(originalId);
    expect(fresh.searchParams.get("retryFrom")).toBe(originalId);
    expect(fresh.searchParams.get("inspect")).toBe(inspect ? null : "false");

    audio.currentTime = 0;
    await act(async () => fireEvent.loadedMetadata(audio));
    expect(audio.currentTime).toBe(95);
    expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement();
    if (inspect) expect(inspectAudioStream).toHaveBeenLastCalledWith("song-1", freshId, expect.any(AbortSignal));
    else expect(inspectAudioStream).not.toHaveBeenCalled();
  } finally {
    view.unmount();
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

test("retries a failed library stream at 0:00 without marking the track unavailable", async () => {
  const { container } = await startAlbum();
  const { audio, loads } = streamingDeck(container, { position: 0, readyState: 0 });
  Object.defineProperty(audio, "error", { configurable: true, value: { code: 4 } });

  fireEvent.error(audio);
  expect(loads).toEqual(["/stream/song-1"]);
  expect(screen.getByTestId("playback-message")).toHaveTextContent("Reconnecting");
  expect(screen.getByTestId("unavailable")).toHaveTextContent("false");

  Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
  fireEvent.loadedMetadata(audio);
  await waitFor(() => expect(screen.getByTestId("playback-message")).toBeEmptyDOMElement());
  expect(screen.getByTestId("current-song")).toHaveTextContent("song-1");
  expect(screen.getByTestId("queue")).toHaveTextContent("song-1,song-2,song-3");
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
    fireEvent.click(screen.getByRole("button", { name: "album-start" }));
    await waitFor(() => expect(activeAudio(view.container)).toHaveAttribute("src", "/stream/song-1"));
    await act(async () => { adapter.pause(); });
    const previousQueue = screen.getByTestId("queue").textContent;
    const previousVolume = screen.getByTestId("volume").textContent;
    HTMLMediaElement.prototype.play.mockClear();
    getListeningTrack.mockResolvedValue({ id: "song-1", title: "Live set", duration: 600, source: { kind: "library" } });
    const snapshot = { trackId: "song-1", exactPositionMs: 123456.789, playing: true, volume: .4,
      queueState: { entries: ["first", "repeat", "third"].map((occurrenceId, index) => ({
        occurrenceId, trackId: index === 2 ? "song-2" : "song-1", title: "Live set", artist: "DJ", album: "Mix", duration: 600,
        resume: { type: "playlist", mediaId: "mix", title: "Mix", trackIndex: index + 3, trackCount: 9, occurrenceId: `playlist-${index}` },
      })), index: 1, repeatOne: true, shuffle: true, shuffleMode: "smart", shuffleSeed: 42, albumAware: true,
        context: { type: "playlist", id: "mix", name: "Mix", coverArt: null } } };
    let complete = false;
    let preparation;
    const transfer = new AbortController();
    await act(async () => {
      preparation = adapter.prepare(snapshot, transfer.signal).then(() => { complete = true; });
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
    saveMediaCheckpoint.mockClear();
    recordListeningEvent.mockClear();
    await act(async () => { await adapter.start({ ...snapshot, exactPositionMs: 125789.123 }, transfer.signal); });
    expect(audio.currentTime).toBe(125.789123);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("is-playing")).toHaveTextContent("true");
    expect(screen.getByTestId("volume")).toHaveTextContent("0.4");
    await act(async () => { await adapter.command({ type: "SEEK", position_ms: 321789.456 }); });
    expect(audio.currentTime).toBe(321789.456 / 1000);
    fireEvent.timeUpdate(audio);
    expect(saveMediaCheckpoint).not.toHaveBeenCalled();
    expect(recordListeningEvent).not.toHaveBeenCalled();
    await act(async () => { transfer.abort(); });
    expect(screen.getByTestId("queue")).toHaveTextContent(previousQueue);
    expect(screen.getByTestId("volume")).toHaveTextContent(previousVolume);
    expect(screen.getByTestId("is-playing")).toHaveTextContent("false");
  } finally { view.unmount(); hook.mockRestore(); }
});

test("remote now-playing and transport controls reflect the selected device without echoing target commands", async () => {
  let adapter;
  let playback;
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
    return { status: "connected", devices: [active], deviceId: "phone", activeDevice: active, isRemote: true, playback,
      enabled: true, busy: false, error: "", name: "Phone", command, transfer: jest.fn(), enable: jest.fn(), rename: jest.fn(), clearError: jest.fn() };
  });
  const playlist = { id: "large-playlist", name: "Large playlist" };
  const playlistView = { query: "", sort: "custom", descending: false, locale: "en-US" };
  const playlistTracks = Array.from({ length: 1001 }, (_, index) => ({
    id: `track-${index % 1000}`, playlistItemId: `entry-${index}`,
  }));
  function LocalRestore() {
    const { currentSong, restoreSavedQueue, playLibraryTracks, playQueue, playContext } = usePlayer();
    return <>
      <div data-testid="live-metadata">{currentSong?.artist} / {currentSong?.coverArt}</div>
      <button onClick={() => restoreSavedQueue({ version: 2, entries: [{ entryId: "local-saved", track: songs[0] }] },
        { ...checkpoint, wasPlaying: false })}>restore-local-queue</button>
      <button onClick={() => playLibraryTracks(librarySelection, new AbortController().signal)}>remote library shuffle</button>
      <button onClick={() => playQueue(playlistTracks, 0, playlistPlaybackContext(playlist, playlistView), playlistView)}>remote playlist</button>
      <button onClick={() => playContext(playlistTracks, 1000, playlistPlaybackContext(playlist, playlistView), playlistView)}>remote playlist from entry</button>
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
    fireEvent.click(screen.getByText("loop"));
    expect(command).toHaveBeenLastCalledWith({ type: "TOGGLE_REPEAT" });
    fireEvent.click(screen.getByText("shuffle"));
    expect(command).toHaveBeenLastCalledWith({ type: "TOGGLE_SHUFFLE" });
    fireEvent.click(screen.getByRole("button", { name: "loop-only-playlist" }));
    expect(command).toHaveBeenLastCalledWith({ type: "SET_PLAYLIST_LOOP", playlist_id: "test-playlist", enabled: true });
    expect(screen.getByTestId("repeat-mode")).toHaveTextContent("off");
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
    fireEvent.click(screen.getByRole("button", { name: "remote library shuffle" }));
    expect(command).toHaveBeenLastCalledWith({ type: "PLAY_LIBRARY_TRACKS", selection: librarySelection });
    expect(getTrackCollection).not.toHaveBeenCalled();
    const order = playlistOrder(playlistTracks);
    fireEvent.click(screen.getByRole("button", { name: "remote playlist", exact: true }));
    expect(command).toHaveBeenLastCalledWith({ type: "PLAY_PLAYLIST", selection: {
      playlistId: playlist.id, startIndex: 0, fromHere: false, view: playlistView, order,
    } });
    fireEvent.click(screen.getByRole("button", { name: "remote playlist from entry" }));
    expect(command).toHaveBeenLastCalledWith({ type: "PLAY_PLAYLIST", selection: {
      playlistId: playlist.id, startIndex: 1000, fromHere: true, view: playlistView, order,
    } });
    expect(getPlaylist).not.toHaveBeenCalled();
    const commandsSent = command.mock.calls.length;
    playback = { ...active, track: active.current_track, is_playing: true, revision: 2, queue: {
      ...checkpoint, repeatAll: true, shuffle: true, loopPlaylistId: "test-playlist",
      entries: [active.current_track, songs[1], songs[0]].map((track, index) => ({
        occurrenceId: `live-${index}`, trackId: track.id, title: track.title,
      })),
    } };
    view.rerenderPlayer();
    await act(async () => queueSyncClient.refresh());
    expect(screen.getByTestId("queue").textContent).toBe("remote-song,song-2,song-1");
    expect(screen.getByTestId("repeat-mode")).toHaveTextContent("all");
    expect(screen.getByTestId("shuffle-enabled")).toHaveTextContent("true");
    expect(command).toHaveBeenCalledTimes(commandsSent);
    const loopPlaylist = screen.getByRole("button", { name: "loop-only-playlist" });
    expect(loopPlaylist).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(loopPlaylist);
    expect(command).toHaveBeenLastCalledWith({ type: "SET_PLAYLIST_LOOP", playlist_id: "test-playlist", enabled: false });
    expect(adapter.state().current_track).toBe(null);
    expect(getStreamUrl).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "restore-local-queue" }));
    expect(screen.getByTestId("current-song")).toHaveTextContent("remote-song");
    fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));
    expect(command).toHaveBeenLastCalledWith({ type: "PAUSE" });
  } finally { view.unmount(); hook.mockRestore(); }
});

test("disconnecting a remote command that is waiting for a local load leaves that load alone", async () => {
  let adapter;
  const mock = remoteSessionModule.useRemoteSession;
  const session = mock();
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return session;
  });
  const view = renderPlayer();
  try {
    await playerReady();
    let finishPlay;
    HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise(resolve => { finishPlay = resolve; }));
    fireEvent.click(screen.getByText("context-first"));
    await waitFor(() => expect(finishPlay).toBeDefined());
    await act(async () => { await adapter.command({ type: "TOGGLE_REPEAT" }); });
    expect(adapter.queue()).toMatchObject({ repeatAll: true, repeatOne: false });
    await act(async () => { await adapter.command({ type: "TOGGLE_SHUFFLE" }); });
    expect(adapter.queue()).toMatchObject({ shuffle: true, index: 0 });
    expect(adapter.queue().entries.slice(1)).toEqual([
      expect.objectContaining({ unshuffledIndex: expect.any(Number) }),
      expect.objectContaining({ unshuffledIndex: expect.any(Number) }),
    ]);
    await act(async () => { await adapter.command({ type: "SET_PLAYLIST_LOOP", playlist_id: "test-playlist", enabled: true }); });
    expect(adapter.queue()).toMatchObject({ loopPlaylistId: "test-playlist", repeatOne: false });
    expect(adapter.queue()).not.toHaveProperty("repeatAll");
    const paused = HTMLMediaElement.prototype.pause.mock.calls.length;
    const controller = new AbortController();
    const operation = adapter.command({ type: "SEEK", position_ms: 10000 }, controller.signal);
    const cancelled = expect(operation).rejects.toThrow("cancelled");
    await act(async () => { controller.abort(); });
    await cancelled;
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(paused);
    expect(activeAudio(view.container)).toHaveAttribute("src", "/stream/song-1");
    await act(async () => { finishPlay(); });
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
    let playing;
    let acknowledged = false;
    await act(async () => {
      playing = adapter.command({
        type: "PLAY_SELECTION", tracks: songs, start_index: 1, from_here: true,
        context: { type: "album", id: "album-1", name: "Album", coverArt: null },
      }).then(() => { acknowledged = true; });
    });
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("song-2"));
    expect(screen.getByTestId("queue")).toHaveTextContent("song-2,song-3");
    expect(activeAudio(view.container)).toHaveAttribute("src", "/stream/song-2");
    expect(acknowledged).toBe(false);
    const audio = activeAudio(view.container);
    startDeckPlaying(audio, 200, 0);
    fireEvent.playing(audio);
    await act(async () => { await playing; });
    expect(acknowledged).toBe(true);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  } finally { view.unmount(); hook.mockRestore(); }
});

test("the active device resolves a 1,205-track library reference and retains the complete shuffled repeat queue", async () => {
  let adapter;
  const session = remoteSessionModule.useRemoteSession();
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return session;
  });
  const tracks = Array.from({ length: 1205 }, (_, index) => ({ id: `large-${index}`, title: `Track ${index}` }));
  getTrackCollection.mockResolvedValue(tracks);
  const view = renderPlayer();
  try {
    await playerReady();
    const controller = new AbortController();
    let result;
    await act(async () => {
      result = adapter.command({ type: "PLAY_LIBRARY_TRACKS", selection: librarySelection }, controller.signal);
    });
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent(/^large-/));
    const audio = activeAudio(view.container);
    startDeckPlaying(audio, 200, 0);
    fireEvent.playing(audio);
    await act(async () => { await result; });
    expect(getTrackCollection).toHaveBeenCalledWith(librarySelection.query, controller.signal);
    expect(adapter.queue().shuffle).toBe(true);
    expect(adapter.queue().entries).toHaveLength(1205);
    expect(new Set(adapter.queue().entries.map(entry => entry.trackId))).toEqual(new Set(tracks.map(track => track.id)));
    await act(async () => { await adapter.command({ type: "TOGGLE_REPEAT" }); });
    expect(adapter.queue().repeatAll).toBe(true);
  } finally { view.unmount(); hook.mockRestore(); }
});

test.each([999, 1000, 1001])("resolves a %i-entry playlist with duplicate tracks in exact order on the active device", async count => {
  let adapter;
  const session = remoteSessionModule.useRemoteSession();
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return session;
  });
  const viewOptions = { query: "", sort: "custom", descending: false, locale: "en-US" };
  const entry = Array.from({ length: count }, (_, index) => ({
    id: `playlist-track-${index % (count - 1)}`, playlistItemId: `playlist-occurrence-${index}`, title: `Song ${index}`,
  }));
  const playlist = { id: "remote-playlist", name: "Remote set", entry };
  const view = renderPlayer();
  getPlaylist.mockResolvedValue(playlist);
  try {
    await playerReady();
    const controller = new AbortController();
    let result;
    await act(async () => {
      result = adapter.command({ type: "PLAY_PLAYLIST", selection: {
        playlistId: playlist.id, startIndex: 0, fromHere: false, view: viewOptions, order: playlistOrder(entry),
      } }, controller.signal);
    });
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("playlist-track-0"));
    const audio = activeAudio(view.container);
    startDeckPlaying(audio, 200, 0);
    fireEvent.playing(audio);
    await act(async () => { await result; });
    expect(getPlaylist).toHaveBeenCalledWith(playlist.id, controller.signal, { cache: "no-store" });
    const queue = adapter.queue();
    expect(queue.entries.map(row => [row.trackId, row.resume.occurrenceId]))
      .toEqual(entry.map(track => [track.id, track.playlistItemId]));
    expect(new Set(queue.entries.map(row => row.occurrenceId)).size).toBe(count);
    expect(queue.context).toMatchObject({ id: playlist.id, type: "playlist" });
  } finally { view.unmount(); hook.mockRestore(); }
});

test("starts at the chosen filtered and sorted playlist occurrence and rejects stale or empty views", async () => {
  let adapter;
  const session = remoteSessionModule.useRemoteSession();
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockImplementation((_user, player) => {
    adapter = player;
    return session;
  });
  const entry = [
    { id: "same", playlistItemId: "first", title: "Echo 2", artist: "Café" },
    { id: "other", playlistItemId: "second", title: "Echo 10", artist: "Café" },
    { id: "same", playlistItemId: "third", title: "Echo 2", artist: "Café" },
    { id: "omitted", playlistItemId: "fourth", title: "Unrelated", artist: "Other" },
  ];
  const playlist = { id: "remote-playlist", name: "Remote set", entry };
  const command = { type: "PLAY_PLAYLIST", selection: { playlistId: playlist.id, startIndex: 1, fromHere: true,
    view: { query: "cafe", sort: "title", descending: true, locale: "en-US" },
    order: playlistOrder([entry[1], entry[0], entry[2]]),
  } };
  const view = renderPlayer();
  getPlaylist.mockResolvedValue(playlist);
  try {
    await playerReady();
    let result;
    await act(async () => { result = adapter.command(command); });
    await waitFor(() => expect(screen.getByTestId("current-song")).toHaveTextContent("same"));
    const audio = activeAudio(view.container);
    startDeckPlaying(audio, 200, 0);
    fireEvent.playing(audio);
    await act(async () => { await result; });
    const queue = adapter.queue();
    expect(queue.entries.map(row => row.trackId)).toEqual(["same", "same"]);
    expect(new Set(queue.entries.map(row => row.occurrenceId)).size).toBe(2);
    expect(queue.context).toMatchObject({ id: playlist.id, type: "collection", playlistLoopId: playlist.id });

    getPlaylist.mockResolvedValueOnce({ ...playlist, entry: [entry[2], entry[1], entry[0], entry[3]] });
    await act(async () => { await expect(adapter.command(command)).rejects.toThrow(/playlist order changed/i); });
    getPlaylist.mockResolvedValueOnce({ ...playlist, entry: [] });
    await act(async () => { await expect(adapter.command(command)).rejects.toThrow(/no matching playlist tracks/i); });
    expect(adapter.queue()).toEqual(queue);
  } finally { view.unmount(); hook.mockRestore(); }
});

test("default collection playback seeks and saves playback while a quality request is pending", async () => {
  localStorage.clear();
  const { container } = renderPlayer();
  inspectAudioStream.mockImplementation(() => new Promise(() => {}));
  getStreamUrl.mockImplementation((id) => `/api/tracks/${id}/stream`);
  await playerReady();
  fireEvent.click(screen.getByRole("button", { name: "resume-collection" }));
  await waitFor(() => expect(screen.getByTestId("is-playing")).toHaveTextContent("true"));
  const audio = activeAudio(container);
  startDeckPlaying(audio, 180, 0);
  fireEvent.loadedMetadata(audio);
  const original = audio.src;
  fireEvent.click(screen.getByRole("button", { name: "seek-local" }));
  expect(audio.currentTime).toBeCloseTo(15.5);
  expect(audio.src).toBe(original);
  fireEvent.click(screen.getByRole("button", { name: "toggle-play" }));

  await waitFor(() => expect(recordListeningEvent).toHaveBeenCalledWith(expect.objectContaining({
    ownerUserId: "user-1", trackId: "song-2", finished: false,
  })));
  await waitFor(() => expect(request.mock.calls.some(([url, options]) =>
    url === "/api/v1/user/queue-session" && options?.method === "PUT"
  )).toBe(true));
  await waitFor(() => expect(saveMediaCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
    type: "album", mediaId: "long-album", trackId: "song-2", positionSeconds: 15.5, completed: false,
  }), expect.any(AbortSignal)));
  expect(inspectAudioStream).toHaveBeenCalledWith("song-2", expect.any(String), expect.any(AbortSignal));
  expect(getAutoplayTracks).not.toHaveBeenCalled();
});

test("local controls play, seek and advance without the hub or background endpoints", async () => {
  localStorage.clear();
  localStorage.setItem("musicdeck:playback:remoteControl", "false");
  localStorage.setItem("musicdeck:playback:serverNormalization", "false");
  localStorage.setItem("musicdeck:playback:streamInspection", "false");
  localStorage.setItem("musicdeck:playback:queueCloudSync", "false");
  localStorage.setItem("musicdeck:playback:listeningEvents", "false");
  localStorage.setItem("musicdeck:playback:mediaSessions", "false");
  localStorage.setItem("musicdeck:playback:autoplayRecommendations", "false");
  localStorage.setItem("musicdeck:playback:audioEffects", "false");
  localStorage.setItem("musicdeck:playback:silenceTrimming", "false");
  const command = jest.fn(async () => { throw new Error("Device control offline"); });
  const active = { device_id: "desk", device_name: "Desk", device_type: "computer", is_active_player: true,
    can_receive: true, current_track: null, position_ms: 0, duration_ms: 0, playing: false, volume: 1 };
  const hook = jest.spyOn(remoteSessionModule, "useRemoteSession").mockReturnValue({
    status: "connected", devices: [active], deviceId: "desk", activeDevice: active, isRemote: false,
      enabled: true, ordersCommands: true, busy: false, error: "", name: "Desk", command, transfer: jest.fn(),
      enable: jest.fn(), rename: jest.fn(), clearError: jest.fn(),
  });
  const view = renderPlayer({ normalize: true, userSettings: [{ key: "playback.silenceTrim.enabled", value: "true" }] });
  getStreamUrl.mockImplementation((songId) => `/api/tracks/${songId}/stream`);
  try {
    await waitFor(() => expect(getStarred).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "context-first" }));
    await waitFor(() => expect(activeAudio(view.container)).toHaveAttribute("src", expect.stringMatching(/^\/api\/tracks\/song-1\/stream\?/)));
    const audio = activeAudio(view.container);
    startDeckPlaying(audio, 200, 10);
    fireEvent.loadedMetadata(audio);
    fireEvent.playing(audio);
    fireEvent.click(screen.getByRole("button", { name: "seek-local" }));
    expect(audio.currentTime).toBeCloseTo(15.5);
    fireEvent.ended(audio);
    await waitFor(() => expect(activeAudio(view.container)).toHaveAttribute("src", expect.stringMatching(/^\/api\/tracks\/song-2\/stream\?/)));
    expect(command).not.toHaveBeenCalled();
    expect(inspectAudioStream).not.toHaveBeenCalled();
    expect(prepareNormalizedPlayback).not.toHaveBeenCalled();
    expect(getSilenceAnalysis).not.toHaveBeenCalled();
    expect(saveMediaCheckpoint).not.toHaveBeenCalled();
    expect(recordListeningEvent).not.toHaveBeenCalled();
    expect(getListeningConfig).not.toHaveBeenCalled();
    expect(getRecentlyPlayed).not.toHaveBeenCalled();
    expect(getAutoplayTracks).not.toHaveBeenCalled();
    expect(hook.mock.calls.every(([userId]) => userId === null)).toBe(true);
    expect(request.mock.calls.some(([url]) => url.includes("/queue-session"))).toBe(false);
  } finally { view.unmount(); hook.mockRestore(); }
});
