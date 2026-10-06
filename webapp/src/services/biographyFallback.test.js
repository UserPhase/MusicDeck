import { getWikipediaBiography, sanitizeBiographyExtract } from "./biographyFallback";

beforeEach(() => localStorage.clear());

test("loads a biography through the authenticated same-origin API and caches by artist", async () => {
  const fetchSummary = jest.fn(async () => ({
    ok: true,
    json: async () => ({ biography: {
      text: "<b>Michael Jackson</b> was an American singer. [1]",
      url: "https://en.wikipedia.org/wiki/Michael_Jackson",
    } }),
  }));
  const first = await getWikipediaBiography("michael-id", "Michael Jackson", fetchSummary);
  const second = await getWikipediaBiography("michael-id", "Michael Jackson", fetchSummary);
  expect(first).toEqual({ text: "Michael Jackson was an American singer.",
    source: "wikipedia", url: "https://en.wikipedia.org/wiki/Michael_Jackson" });
  expect(second).toEqual(first);
  expect(fetchSummary).toHaveBeenCalledTimes(1);
  expect(fetchSummary).toHaveBeenCalledWith("/api/metadata/artist-biography?artist=Michael+Jackson",
    expect.objectContaining({ credentials: "include" }));
});

test("coalesces in-flight requests and handles genuinely missing biographies", async () => {
  const fetchSummary = jest.fn(async () => ({ ok: true, json: async () => ({ biography: null }) }));
  const results = await Promise.all([
    getWikipediaBiography("missing-id", "Missing", fetchSummary),
    getWikipediaBiography("missing-id", "Missing", fetchSummary),
  ]);
  expect(results).toEqual([null, null]);
  expect(fetchSummary).toHaveBeenCalledTimes(1);
});

test("surfaces service errors rather than treating them as missing biographies", async () => {
  await expect(getWikipediaBiography("offline-id", "Offline Artist", async () => ({
    ok: false, status: 502,
  }))).rejects.toThrow("Artist biography lookup failed (502)");
  expect(sanitizeBiographyExtract("Singer. ".repeat(300)).length).toBeLessThanOrEqual(800);
});
