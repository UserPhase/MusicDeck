import { findItunesPreview, trustedPreviewUrl } from "./previewPlayback";

test("finds an exact iTunes preview using the artist and title", async () => {
  const fetchImpl = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      results: [{
        trackName: "Digital Love",
        artistName: "Daft Punk",
        previewUrl: "https://audio-ssl.itunes.apple.com/digital-love.m4a",
      }],
    }),
  }));

  await expect(findItunesPreview({
    title: "Digital Love",
    artist: "Daft Punk",
  }, fetchImpl)).resolves.toBe("https://audio-ssl.itunes.apple.com/digital-love.m4a");

  expect(fetchImpl.mock.calls[0][0]).toContain("term=Daft+Punk+Digital+Love");
  expect(fetchImpl.mock.calls[0][0]).toContain("entity=song");
  expect(fetchImpl.mock.calls[0][0]).toContain("limit=1");
});

test("rejects malformed and untrusted preview URLs", async () => {
  expect(trustedPreviewUrl("http://audio-ssl.itunes.apple.com/file.m4a")).toBeNull();
  expect(trustedPreviewUrl("https://example.com/file.mp3")).toBeNull();
});

test("aborts a stalled iTunes preview lookup and returns null", async () => {
  jest.useFakeTimers();
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  const fetchImpl = jest.fn(() => new Promise(() => {}));

  const lookup = findItunesPreview(
    { title: "Digital Love", artist: "Daft Punk" },
    fetchImpl,
    5000
  );

  jest.advanceTimersByTime(5000);

  await expect(lookup).resolves.toBeNull();
  expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  expect(warning).toHaveBeenCalledWith(
    "iTunes preview lookup timed out.",
    expect.any(Error)
  );

  warning.mockRestore();
  jest.useRealTimers();
});

test("returns null when the preview lookup fails over the network", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  const fetchImpl = jest.fn(async () => {
    throw new Error("network unavailable");
  });

  await expect(findItunesPreview({
    title: "Digital Love",
    artist: "Daft Punk",
  }, fetchImpl)).resolves.toBeNull();

  expect(warning).toHaveBeenCalledWith(
    "iTunes preview lookup failed.",
    expect.any(Error)
  );
  warning.mockRestore();
});
