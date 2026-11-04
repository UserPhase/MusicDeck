import { createListeningTracker } from "./listeningTracker";

let clock;
let audio;
let report;
let onCounted;
let tracker;
const song = { id: "track-1", title: "Test", artist: "Artist", album: "Album", duration: 180 };

beforeEach(() => {
  jest.useFakeTimers();
  sessionStorage.clear();
  clock = Date.parse("2026-10-08T12:00:00Z");
  audio = new EventTarget();
  Object.assign(audio, { currentTime: 0, duration: 180, playbackRate: 1, seeking: false, loop: false });
  report = jest.fn(async (payload) => ({ counted: payload.listenedSeconds >= Math.min(30, payload.durationSeconds) }));
  onCounted = jest.fn();
  tracker = createListeningTracker({ report, onCounted, now: () => clock, storage: sessionStorage, userId: "user-1" });
});
afterEach(() => { tracker.suspend(); jest.useRealTimers(); });
const settle = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };
function advance(seconds, mediaSeconds = seconds) {
  clock += seconds * 1000;
  audio.currentTime += mediaSeconds;
  tracker.sample();
}

test("privacy survives an older in-flight acknowledgement and retains the original playlist context", async () => {
  tracker.suspend(); let privateListening = false, playlistId = "party";
  let finish;
  report.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  tracker = createListeningTracker({ report, onCounted, now: () => clock, storage: sessionStorage, userId: "user-1", getTasteContext: () => ({ privateListening, playlistId }) });
  tracker.begin(song, audio); advance(10); await settle();
  privateListening = true; tracker.markTaste(); privateListening = false; playlistId = "different-list";
  finish({ counted: false }); await settle();
  const pending = JSON.parse(sessionStorage.getItem("musicdeck:listening-pending:user-1"));
  expect(pending[0]).toMatchObject({ privateListening: true, playlistId: "party" });
  tracker.flush(); await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ privateListening: true, playlistId: "party" }));
});

test("server-side privacy decisions retract local heuristics and remain sticky after a delayed acknowledgement", async () => {
  tracker.suspend(); const excluded = jest.fn(); report.mockResolvedValue({ counted: false, tasteExcluded: true });
  tracker = createListeningTracker({ report, onCounted, onTasteExcluded: excluded, now: () => clock, storage: sessionStorage, userId: "user-1" });
  tracker.begin(song, audio); advance(10); await settle();
  expect(excluded).toHaveBeenCalledWith(expect.objectContaining({ trackId: song.id }), true);
  tracker.flush(); await settle(); expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ excludeFromTaste: true }));
});

test("reports exactly when the scrobble point (20 s or 50%, whichever is first) is crossed, once", async () => {
  tracker.begin(song, audio);
  advance(12);
  await settle();
  const heartbeat = report.mock.calls.length;
  expect(heartbeat).toBe(1);
  advance(7.5);
  await settle();
  expect(report).toHaveBeenCalledTimes(heartbeat);
  // Only 8 s since the heartbeat: this report is the scrobble trigger, not the 10 s cadence.
  advance(0.5);
  await settle();
  expect(report).toHaveBeenCalledTimes(heartbeat + 1);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 20, finished: false }));
  advance(1);
  await settle();
  expect(report).toHaveBeenCalledTimes(heartbeat + 1);

  tracker.finish();
  await settle();
  const short = { ...song, id: "short", duration: 16 };
  audio.duration = 16;
  audio.currentTime = 0;
  report.mockClear();
  tracker.begin(short, audio);
  advance(7.5);
  await settle();
  expect(report).not.toHaveBeenCalled();
  advance(0.5);
  await settle();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ trackId: "short", listenedSeconds: 8 }));
});

test("starting playback creates no counted listen; heartbeat reports actual cumulative seconds", async () => {
  tracker.begin(song, audio);
  expect(report).not.toHaveBeenCalled();
  advance(10);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 10, finished: false }));
  expect(onCounted).not.toHaveBeenCalled();
  advance(20);
  await settle();
  expect(onCounted).toHaveBeenCalledTimes(1);
  advance(10);
  await settle();
  expect(onCounted).toHaveBeenCalledTimes(1);
});

test("seeking forward and stalling do not invent listening time", async () => {
  tracker.begin(song, audio);
  advance(5);
  audio.dispatchEvent(new Event("seeking"));
  audio.currentTime = 150;
  clock += 1000;
  audio.dispatchEvent(new Event("seeked"));
  advance(5);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 10 }));
  const reports = report.mock.calls.length;
  advance(40, 0);
  await settle();
  expect(report).toHaveBeenCalledTimes(reports);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 10 }));
  expect(onCounted).not.toHaveBeenCalled();
});

test("pause and resume retain one session and exclude time spent paused", async () => {
  tracker.begin(song, audio);
  advance(10);
  audio.dispatchEvent(new Event("pause"));
  await settle();
  const id = report.mock.calls[0][0].playbackSessionId;
  clock += 60_000;
  audio.dispatchEvent(new Event("playing"));
  advance(20);
  await settle();
  expect(report.mock.calls.every(([payload]) => payload.playbackSessionId === id)).toBe(true);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 30 }));
});

test("interrupted playback resumes its persisted id and cumulative duration after refresh", async () => {
  tracker.begin(song, audio);
  advance(20);
  tracker.suspend();
  await settle();
  const previous = report.mock.calls[0][0].playbackSessionId;
  tracker = createListeningTracker({ report, onCounted, now: () => clock, storage: sessionStorage, userId: "user-1" });
  clock += 60_000;
  tracker.begin(song, audio);
  advance(10);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ playbackSessionId: previous, listenedSeconds: 30 }));
});

test("legitimate repeats create distinct sessions, including native audio.loop wraps", async () => {
  tracker.begin(song, audio);
  advance(30);
  await settle();
  const first = report.mock.calls[0][0].playbackSessionId;
  tracker.finish();
  audio.currentTime = 0;
  tracker.begin(song, audio, false);
  advance(30);
  await settle();
  expect(report.mock.calls.at(-1)[0].playbackSessionId).not.toBe(first);
  advance(149);
  await settle();
  audio.loop = true;
  audio.currentTime = 0;
  clock += 1000;
  tracker.sample();
  advance(30);
  await settle();
  expect(new Set(report.mock.calls.map(([payload]) => payload.playbackSessionId)).size).toBe(3);
});

test("native loops credit the complete outgoing tail and retain short-track repeats", async () => {
  audio.duration = 12;
  audio.loop = true;
  tracker.begin({ ...song, duration: 12 }, audio);
  advance(11);
  await settle();
  audio.currentTime = 0;
  clock += 1000;
  tracker.sample();
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 12, finished: true }));
  const first = report.mock.calls.at(-1)[0].playbackSessionId;
  advance(12);
  await settle();
  expect(report.mock.calls.at(-1)[0]).toMatchObject({ listenedSeconds: 12 });
  expect(report.mock.calls.at(-1)[0].playbackSessionId).not.toBe(first);
});

test("subsecond loop wraps are not mistaken for a seek", async () => {
  audio.duration = 0.5;
  audio.loop = true;
  tracker.begin({ ...song, duration: 0.5 }, audio);
  advance(0.25);
  audio.currentTime = 0;
  clock += 250;
  tracker.sample();
  await settle();
  // The scrobble-point report (0.25 s) is still in flight at the wrap, so the
  // final report is delivered by the outbox retry.
  clock += 10_000;
  jest.advanceTimersByTime(1000);
  await settle();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ listenedSeconds: 0.5, finished: true }));
});

test("crossfade handoff preserves the actual overlap rather than losing the incoming intro", async () => {
  clock += 6000;
  audio.currentTime = 6;
  tracker.begin(song, audio, false, 6, clock - 6000);
  advance(24);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
    listenedSeconds: 30, startedAt: new Date(clock - 30_000).toISOString(),
  }));
});

test("short tracks use the full track duration and playback speed still measures real time", async () => {
  tracker.begin({ ...song, duration: 12 }, audio);
  audio.duration = 12;
  advance(11);
  await settle();
  expect(onCounted).not.toHaveBeenCalled();
  advance(1);
  await settle();
  expect(onCounted).toHaveBeenCalledTimes(1);
  tracker.finish();
  audio.playbackRate = 2;
  audio.currentTime = 0;
  audio.duration = 180;
  tracker.begin(song, audio, false);
  advance(10, 20);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ listenedSeconds: 10 }));
});

test("failed reports are logged and the next report retries with the same cumulative session", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  report.mockRejectedValueOnce(new Error("offline"));
  tracker.begin(song, audio);
  advance(10);
  await settle();
  expect(log).toHaveBeenCalled();
  const id = report.mock.calls[0][0].playbackSessionId;
  advance(10);
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ playbackSessionId: id, listenedSeconds: 20 }));
  log.mockRestore();
});

test("dispose removes listeners and timers; user sessions remain isolated", () => {
  tracker.begin(song, audio);
  expect(jest.getTimerCount()).toBe(1);
  tracker.suspend();
  expect(jest.getTimerCount()).toBe(0);
  expect(sessionStorage.getItem("musicdeck:listening-session:user-1")).not.toBeNull();
  expect(sessionStorage.getItem("musicdeck:listening-session:user-2")).toBeNull();
});

test("failed final reports survive a track change and refresh in the same user-scoped outbox", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  report.mockRejectedValue(new Error("offline"));
  tracker.begin(song, audio);
  advance(30);
  tracker.finish();
  await settle();
  const stored = JSON.parse(sessionStorage.getItem("musicdeck:listening-pending:user-1"));
  expect(stored).toEqual([expect.objectContaining({ listenedSeconds: 30, finished: true })]);
  tracker.suspend();
  report.mockResolvedValue({ counted: true });
  tracker = createListeningTracker({ report, now: () => clock, storage: sessionStorage, userId: "user-1" });
  await settle();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
    playbackSessionId: stored[0].playbackSessionId, listenedSeconds: 30, finished: true,
  }));
  expect(JSON.parse(sessionStorage.getItem("musicdeck:listening-pending:user-1"))).toEqual([]);
  log.mockRestore();
});
