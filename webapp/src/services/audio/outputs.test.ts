import { replayGainLevel } from "./outputs";

test("album gain and peak preserve the same relative scale across an album", () => {
  const quiet = { trackGainDb: 6, trackPeak: .1, albumGainDb: -6, albumPeak: .9 };
  const loud = { ...quiet, trackGainDb: -12, trackPeak: .9 };
  expect(replayGainLevel(quiet, true)).toBeCloseTo(10 ** (-6 / 20));
  expect(replayGainLevel(loud, true)).toBe(replayGainLevel(quiet, true));
  expect(replayGainLevel(quiet)).not.toBe(replayGainLevel(loud));
});

test("missing album gain never falls back to per-track correction", () => {
  expect(replayGainLevel({ trackGainDb: -12 }, true)).toBe(1);
  expect(replayGainLevel({ albumGainDb: NaN, trackGainDb: -12 }, true)).toBe(1);
  expect(replayGainLevel({ albumGainDb: 6, albumPeak: 1 }, true)).toBeCloseTo(10 ** (-1 / 20));
  expect(replayGainLevel({ albumGainDb: 6 }, true)).toBe(1);
});
