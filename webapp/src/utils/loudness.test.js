import { loudnessGainDb, trackGainDb } from "./loudness";
import normalizeTrackData from "./normalizeTrackData";
import { createQueueSnapshot, readQueueSnapshot, queueStorageKey } from "./queuePersistence";

test("targets share measurements and always protect peaks", () => {
  const loudness = { integratedLufs: -10, truePeakDb: -1 };
  expect(loudnessGainDb(loudness, -18)).toBe(-8);
  expect(loudnessGainDb(loudness, -14)).toBe(-4);
  expect(loudnessGainDb({ integratedLufs: -24, truePeakDb: -2 }, -14)).toBe(1);
  expect(loudnessGainDb({ integratedLufs: NaN, truePeakDb: -1 }, -14)).toBeUndefined();
  expect(loudnessGainDb(loudness, 14)).toBeUndefined();
  expect(trackGainDb({ normalizationGainDb: 1 }, -18)).toBeUndefined();
});

test("measurements survive search normalization and queue restoration", () => {
  const loudness = { integratedLufs: -10, truePeakDb: -1 };
  const track = normalizeTrackData({ id: "song", metadata: { loudness } });
  expect(track.loudness).toEqual(loudness);
  const snapshot = createQueueSnapshot({ currentSong: track, queue: [track], queueIndex: 0 });
  const storage = { getItem: key => key === queueStorageKey("user") ? JSON.stringify(snapshot) : null };
  const restored = readQueueSnapshot(storage, "user").queueItems[0];
  expect(trackGainDb(restored, -18)).toBe(-8);
});
