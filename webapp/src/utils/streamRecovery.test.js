import {
  hasPlaybackProgressed,
  initialPlaybackUrl,
  replacementPlaybackUrl,
  streamRecoveryBackoffMs,
} from "./streamRecovery";

test.each([false, true])("rotates the stream ID with inspection set to %s", (inspect) => {
  const source = "http://localhost:4535/proxy/api/tracks/song/stream?source=primary&maxBitRate=192";
  const initial = new URL(initialPlaybackUrl(source, inspect));
  const first = new URL(replacementPlaybackUrl(initial.href));
  const second = new URL(replacementPlaybackUrl(first.href));
  const ids = [initial, first, second].map((url) => url.searchParams.get("inspectionId"));

  expect(ids).toEqual(Array(3).fill(expect.stringMatching(/^[a-zA-Z0-9_-]+$/)));
  expect(new Set(ids).size).toBe(3);
  expect(first.searchParams.get("retryFrom")).toBe(ids[0]);
  expect(second.searchParams.get("retryFrom")).toBe(ids[1]);
  for (const url of [initial, first, second]) {
    expect(url.origin + url.pathname).toBe(source.split("?")[0]);
    expect(url.searchParams.get("inspect")).toBe(inspect ? null : "false");
    expect(url.searchParams.get("source")).toBe("primary");
    expect(url.searchParams.get("maxBitRate")).toBe("192");
  }
});

test.each(["blob:offline", "/api/playback/normalized/file", "/api/playback/preview?url=example"])(
  "leaves non-library sources unchanged: %s", (source) => {
    expect(initialPlaybackUrl(source, false)).toBe(source);
    expect(replacementPlaybackUrl(source)).toBeNull();
  },
);

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

