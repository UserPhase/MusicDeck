import { loudnessGainDb, preparedPlaybackGainDb, trackGainDb } from "./loudness";
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

test("normalization avoids boosting near-silence or unverified legacy gain", () => {
  expect(loudnessGainDb({ integratedLufs: -67, truePeakDb: -48 }, -16)).toBe(0);
  expect(loudnessGainDb({ integratedLufs: -67, truePeakDb: 0 }, -16)).toBe(-1);
  expect(trackGainDb({ normalizationGainDb: 9 }, -16)).toBeUndefined();
  expect(trackGainDb({ normalizationGainDb: 9, replayGain: { trackPeak: 1 } }, -16)).toBe(-1);
});

test("retargeting a prepared file keeps its total boost and peak within bounds", () => {
  expect(preparedPlaybackGainDb({ integratedLufs: -28, truePeakDb: -18 },
    { integratedLufs: -40, truePeakDb: -30 }, -14)).toBe(0);
  expect(preparedPlaybackGainDb({ integratedLufs: -16, truePeakDb: -1.2 },
    { integratedLufs: -26, truePeakDb: -11.2 }, -14)).toBeCloseTo(0.2);
  expect(preparedPlaybackGainDb({ integratedLufs: -20, truePeakDb: -4 }, null, -14)).toBe(0);
  expect(preparedPlaybackGainDb({ integratedLufs: -16, truePeakDb: -2 },
    { integratedLufs: -10, truePeakDb: -1 }, -18)).toBe(-2);
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
