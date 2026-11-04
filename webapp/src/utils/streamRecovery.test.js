import {
  hasPlaybackProgressed,
  streamRecoveryBackoffMs,
} from "./streamRecovery";

test("retries immediately, then backs off exponentially up to a cap", () => {
  expect([1, 2, 3, 4, 5, 6, 10].map(streamRecoveryBackoffMs))
    .toEqual([0, 1000, 2000, 4000, 8000, 16000, 16000]);
  expect(streamRecoveryBackoffMs(Number.NaN)).toBe(0);
});

test("only counts real forward progress with buffered data as recovered", () => {
  expect(hasPlaybackProgressed({ readyState: 4, currentTime: 12 }, 10)).toBe(true);
  expect(hasPlaybackProgressed({ readyState: 4, currentTime: 10.1 }, 10)).toBe(false);
  expect(hasPlaybackProgressed({ readyState: 2, currentTime: 12 }, 10)).toBe(false);
  expect(hasPlaybackProgressed(null, 0)).toBe(false);
});

