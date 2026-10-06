import { afterEach, describe, expect, test, vi } from "vitest";
import { DeezerDiscoveryService, normalizeDeezerChart } from "../src/domain/deezer-discovery.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

const xlAlbum = "https://cdn-images.dzcdn.net/images/cover/album/1000x1000.jpg";
const xlArtist = "https://cdn-images.dzcdn.net/images/artist/artist/1000x1000.jpg";
const payload = {
  tracks: { data: [{ id: 301, title: "Chart Song", duration: 209, artist: { id: 101, name: "Chart Artist" }, album: { id: 201, title: "Chart Album", cover_xl: xlAlbum } }] },
  albums: { data: [{ id: 201, title: "Chart Album", cover_xl: xlAlbum, artist: { id: 101, name: "Chart Artist" } }] },
  artists: { data: [{ id: 101, name: "Chart Artist", picture_xl: xlArtist }] },
};

afterEach(() => vi.unstubAllGlobals());

describe("Deezer discovery", () => {
  test("normalizes chart entities with XL artwork and a formatted duration", () => {
    const chart = normalizeDeezerChart(payload);
    expect(chart.artists[0]).toMatchObject({ id: "external_deezer_artist_101", name: "Chart Artist", coverArt: { url: xlArtist }, external: true });
    expect(chart.albums[0]).toMatchObject({ id: "external_deezer_album_201", title: "Chart Album", artist: "Chart Artist", coverArt: { url: xlAlbum } });
    expect(chart.tracks[0]).toMatchObject({ id: "external_deezer_track_301", title: "Chart Song", artist: "Chart Artist", duration: 209, durationLabel: "3:29", coverArt: { url: xlAlbum } });
  });

  test.each(["preview", "preview_url", "previewUrl", "audio_preview_url"])(
    "preserves chart preview aliases from %s",
    (previewKey) => {
      const previewUrl = "https://cdns-preview-a.dzcdn.net/chart-preview.mp3";
      const chart = normalizeDeezerChart({
        ...payload,
        tracks: {
          data: [{
            ...payload.tracks.data[0],
            [previewKey]: previewUrl,
            isrc: "USABC2400001",
          }],
        },
      });
      expect(chart.tracks[0]).toMatchObject({
        previewUrl,
        isrc: "USABC2400001",
        source: { kind: "external" },
      });
    }
  );

  test("shares one keyless request and serves the cached chart", async () => {
    const fetchChart = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(payload), { status: 200 }));
    const service = new DeezerDiscoveryService(fetchChart);
    const [first, second] = await Promise.all([service.getCharts(), service.getCharts()]);
    expect(first).toEqual(second);
    expect((await service.getCharts()).albums[0].title).toBe("Chart Album");
    expect(fetchChart).toHaveBeenCalledTimes(1);
    expect(fetchChart.mock.calls[0][0]).toBe("https://api.deezer.com/chart?limit=14");
  });

  test("exposes charts only through the authenticated same-origin route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const { app, db } = await createTestServer();
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/discovery/external" });
      expect(unauthorized.statusCode).toBe(401);
      const { cookie } = await login(app);
      const response = await app.inject({ method: "GET", url: "/api/discovery/external", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().tracks[0].durationLabel).toBe("3:29");
    } finally {
      await closeTestServer(app, db);
    }
  });

  test("hydrates chart previews through keyless Deezer search without delaying charts", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      data: [{ id: 301, title: "Chart Song", preview: "https://cdns-preview-a.dzcdn.net/chart-preview.mp3", artist: { name: "Chart Artist" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { app, db } = await createTestServer();
    try {
      const { cookie } = await login(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/discovery/external/previews",
        headers: { cookie },
        payload: { tracks: [{ id: "external_deezer_track_301", title: "Chart Song", artist: "Chart Artist" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        tracks: [{ id: "external_deezer_track_301", previewUrl: "https://cdns-preview-a.dzcdn.net/chart-preview.mp3" }],
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("https://api.deezer.com/search");
    } finally {
      await closeTestServer(app, db);
    }
  });
});
