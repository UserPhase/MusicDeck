import { getWikipediaBiography, sanitizeBiographyExtract } from "./biographyFallback";

const summary = (title, description, extract, type = "standard") => ({
  ok: true, status: 200, json: async () => ({ title, description, extract, type }),
});

beforeEach(() => localStorage.clear());

test("accepts a musical exact match, sanitizes it, and reuses the artist-ID cache", async () => {
  const fetchSummary = jest.fn(async () => summary(
    "Michael Jackson", "American singer", "<b>Michael Jackson</b> was an American singer. [1] [citation needed]",
  ));
  const first = await getWikipediaBiography("michael-id", "Michael Jackson", fetchSummary);
  const second = await getWikipediaBiography("michael-id", "Michael Jackson", fetchSummary);

  expect(first).toEqual({ text: "Michael Jackson was an American singer.", source: "wikipedia", url: "https://en.wikipedia.org/wiki/Michael_Jackson" });
  expect(second).toEqual(first);
  expect(fetchSummary).toHaveBeenCalledTimes(1);
});

test("rejects disambiguation and non-musical pages before accepting a band page", async () => {
  const fetchSummary = jest.fn(async (url) => {
    if (url.endsWith("/Nirvana")) return summary("Nirvana", "religious concept", "Nirvana is a Buddhist concept.", "disambiguation");
    if (url.endsWith("/Nirvana_(musician)")) return { ok: false, status: 404 };
    if (url.endsWith("/Nirvana_(band)")) return summary("Nirvana (band)", "American rock band", "Nirvana was an American rock band.");
    throw new Error(`Unexpected title: ${url}`);
  });
  const result = await getWikipediaBiography("nirvana-id", "Nirvana", fetchSummary);

  expect(result.text).toBe("Nirvana was an American rock band.");
  expect(fetchSummary).toHaveBeenCalledTimes(3);
  expect(result.url).toBe("https://en.wikipedia.org/wiki/Nirvana_(band)");
});

test("does not accept an unrelated exact-name article", async () => {
  const fetchSummary = jest.fn(async (url) => url.endsWith("/Muse")
    ? summary("Muse", "mythological figure", "A muse was a mythological source of inspiration.")
    : summary("Muse (band)", "English rock band", "Muse are an English rock band."));
  const result = await getWikipediaBiography("muse-id", "Muse", fetchSummary);
  expect(result.text).toBe("Muse are an English rock band.");
  expect(fetchSummary).toHaveBeenCalledTimes(2);
});

test("limits a long extract and fails quietly when offline", async () => {
  expect(sanitizeBiographyExtract("Singer. ".repeat(300)).length).toBeLessThanOrEqual(800);
  await expect(getWikipediaBiography("offline-id", "Offline Artist", async () => {
    throw new Error("offline");
  })).resolves.toBeNull();
});
