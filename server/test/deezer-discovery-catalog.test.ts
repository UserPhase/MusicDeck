import { expect, test, vi } from "vitest";
import { DeezerDiscoveryCatalog } from "../src/services/discovery/deezerDiscoveryCatalog.js";

const artist = { id: 27, name: "Daft Punk", picture_xl: "https://cdn-images.dzcdn.net/artist/27.jpg" };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test("coalesces identical requests, caches shared metadata for six hours and uses no authentication", async () => {
  const fetcher = vi.fn(async () => json({ data: [artist] }));
  let now = 0;
  const catalog = new DeezerDiscoveryCatalog(fetcher, undefined, () => now);
  const [first, second] = await Promise.all([catalog.searchArtist("Daft Punk"), catalog.searchArtist("Daft Punk")]);
  expect(first).toEqual(second);
  expect(first?.id).toBe("external_deezer_artist_27");
  now += 5 * 60 * 60_000;
  expect(await catalog.searchArtist("Daft Punk")).toEqual(first);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toMatchObject(["https://api.deezer.com/search/artist?q=Daft+Punk&limit=5", { headers: { Accept: "application/json" } }]);
});

test("limits concurrent upstream requests across different artist searches", async () => {
  let active = 0;
  let peak = 0;
  const fetcher = vi.fn(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return json({ data: [artist] });
  });
  const catalog = new DeezerDiscoveryCatalog(fetcher);
  await Promise.all(Array.from({ length: 10 }, (_, index) => catalog.searchArtist(`Artist ${index}`)));
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(10);
});

test("malformed candidates cannot remove valid tracks and album pages retain the requested artist", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/top?") ? json({ data: [
    { id: "invalid", title: "Bad", duration: 1 },
    { id: 1, title: "Good", duration: 180, artist, album: { id: 7, title: "Record" }, preview: "https://cdns-preview-a.dzcdn.net/preview.mp3" },
  ] }) : json({ data: [{ id: 7, title: "Record" }] }));
  const catalog = new DeezerDiscoveryCatalog(fetcher);
  const externalArtist = { id: "external_deezer_artist_27", name: "Daft Punk", type: "artist", external: true,
    provider: "deezer", source: { kind: "external", count: 0 }, deezerUrl: null, coverArt: null } as const;
  expect(await catalog.tracks(externalArtist)).toMatchObject([{ title: "Good", previewUrl: "https://cdns-preview-a.dzcdn.net/preview.mp3" }]);
  expect(await catalog.albums(externalArtist)).toMatchObject([{ title: "Record", artist: "Daft Punk" }]);
  await expect(catalog.related({ ...externalArtist, id: "../../outside" })).rejects.toThrow("Invalid discovery artist ID");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("expired metadata survives a temporary provider outage and failed requests are throttled", async () => {
  let now = 0;
  const fetcher = vi.fn(async () => json({ data: [artist] }));
  const catalog = new DeezerDiscoveryCatalog(fetcher, undefined, () => now);
  const first = await catalog.searchArtist("Daft Punk");
  now = 6 * 60 * 60_000 + 1;
  fetcher.mockRejectedValue(new Error("Offline"));
  expect(await catalog.searchArtist("Daft Punk")).toEqual(first);
  expect(await catalog.searchArtist("Daft Punk")).toEqual(first);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("similar names do not silently resolve to a different artist", async () => {
  const fetcher = vi.fn(async () => json({ data: [{ ...artist, name: "Daft Punk Tribute" }] }));
  expect(await new DeezerDiscoveryCatalog(fetcher).searchArtist("Daft Punk")).toBeNull();
});

test("requests a bounded related-artist pool large enough to fill seven new artist cards", async () => {
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => json({ data: Array.from({ length: 20 }, (_, index) => ({ ...artist, id: index + 100, name: `Related ${index}` })) }));
  const catalog = new DeezerDiscoveryCatalog(fetcher);
  const seed = { id: "external_deezer_artist_27", name: "Daft Punk", type: "artist", external: true,
    provider: "deezer", source: { kind: "external", count: 0 }, deezerUrl: null, coverArt: null } as const;
  expect(await catalog.related(seed)).toHaveLength(20);
  expect(fetcher.mock.calls[0][0]).toBe("https://api.deezer.com/artist/27/related?limit=20");
});
