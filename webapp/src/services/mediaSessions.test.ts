import { createMediaSessionTracker, resumeTrackIndex } from "./mediaSessions";
import type { MediaCheckpoint } from "./mediaSessions";
import type { PlaybackEngineEventMap, PlaybackSnapshot } from "./audio/types";

const context = { type: "playlist" as const, mediaId: "mix", title: "DJ set", trackIndex: 1, trackCount: 3, occurrenceId: "slot-b" };
const checkpoint: MediaCheckpoint = { ...context, trackId: "song", positionSeconds: 102.125,
  durationSeconds: 600, progress: .39, capturedAt: 1000, updatedAt: 1000 };
test("resume resolves duplicate occurrences after reorder, never substitutes a removed occurrence", () => {
  expect(resumeTrackIndex(checkpoint, [
    { id: "song", playlistItemId: "slot-b" }, { id: "song", playlistItemId: "slot-a" },
  ])).toBe(0);
  expect(resumeTrackIndex(checkpoint, [{ id: "song", playlistItemId: "slot-a" }])).toBe(-1);
  expect(resumeTrackIndex({ ...checkpoint, occurrenceId: null }, [{ id: "other" }, { id: "song" }])).toBe(1);
});

function setup() {
  let now = 10_000;
  const events = new EventTarget();
  let snapshot: PlaybackSnapshot = { key: "entry-b", state: "playing", position: 102.125, duration: 600, mode: "off", transition: null };
  const track = { id: "song", mediaResume: { ...context } };
  const save = jest.fn<Promise<void>, [unknown]>(async () => {});
  const onError = jest.fn();
  const engine = {
    on<K extends keyof PlaybackEngineEventMap>(type: K, listener: (event: PlaybackEngineEventMap[K]) => void) {
      const handle = (event: Event) => listener((event as CustomEvent<PlaybackEngineEventMap[K]>).detail);
      events.addEventListener(type, handle);
      return () => events.removeEventListener(type, handle);
    },
    getSnapshot: () => snapshot,
    getPosition: () => snapshot.position,
  };
  const tracker = createMediaSessionTracker({ engine, getTrack: (key) => key === "entry-b" ? track : undefined,
    save, onError, now: () => now });
  return { save, onError, track, tracker,
    advance: (seconds: number) => { now += seconds * 1000; },
    position: (seconds: number) => { snapshot = { ...snapshot, position: seconds }; },
    emit: <K extends keyof PlaybackEngineEventMap>(type: K, detail: PlaybackEngineEventMap[K]) => events.dispatchEvent(new CustomEvent(type, { detail })),
  };
}
test("throttles high-frequency progress to five seconds and flushes precise pause/navigation/pagehide position", () => {
  const fixture = setup();
  fixture.emit("timeUpdate", { key: "entry-b", position: 102.125, duration: 600 });
  expect(fixture.save).toHaveBeenCalledTimes(1);
  fixture.advance(4.9);
  fixture.emit("timeUpdate", { key: "entry-b", position: 107, duration: 600 });
  expect(fixture.save).toHaveBeenCalledTimes(1);
  fixture.advance(.1);
  fixture.emit("timeUpdate", { key: "entry-b", position: 107.125, duration: 600 });
  expect(fixture.save).toHaveBeenCalledTimes(2);
  fixture.position(108.375);
  fixture.emit("stateChange", { key: "entry-b", state: "paused" });
  expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ trackIndex: 1, positionSeconds: 108.375, occurrenceId: "slot-b" }));
  fixture.position(110.875);
  window.dispatchEvent(new Event("musicdeck:navigation"));
  expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ positionSeconds: 110.875 }));
  window.dispatchEvent(new Event("pagehide"));
  fixture.tracker.destroy();
  const count = fixture.save.mock.calls.length;
  window.dispatchEvent(new Event("pagehide"));
  fixture.emit("timeUpdate", { key: "entry-b", position: 120, duration: 600 });
  expect(fixture.save).toHaveBeenCalledTimes(count);
});
test("completion deletes only the last track's bookmark; errors surface and unknown tracks are ignored", async () => {
  const fixture = setup();
  fixture.emit("timeUpdate", { key: "entry-b", position: 599, duration: 600 });
  fixture.emit("trackEnd", { key: "entry-b" });
  expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ completed: false }));
  fixture.track.mediaResume.trackIndex = 2;
  fixture.emit("timeUpdate", { key: "entry-b", position: 599, duration: 600 });
  fixture.emit("trackEnd", { key: "entry-b" });
  expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ completed: true }));
  fixture.save.mockRejectedValueOnce(new Error("offline"));
  fixture.emit("timeUpdate", { key: "entry-b", position: 123, duration: 600 });
  fixture.tracker.flush();
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.onError).toHaveBeenCalledWith(expect.any(Error));
  const count = fixture.save.mock.calls.length;
  fixture.emit("timeUpdate", { key: "unrelated", position: 10, duration: 60 });
  fixture.tracker.flush();
  expect(fixture.save.mock.calls.length).toBeLessThanOrEqual(count + 1);
  fixture.tracker.destroy();
});
test("an explicit restart paused at zero overwrites the old collection position", () => {
  const fixture = setup();
  fixture.track.mediaResume.trackIndex = 0;
  fixture.position(0);
  fixture.emit("timeUpdate", { key: "entry-b", position: 0, duration: 600 });
  fixture.emit("stateChange", { key: "entry-b", state: "paused" });
  expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({
    trackIndex: 0, positionSeconds: 0, completed: false,
  }));
  fixture.tracker.destroy();
});
