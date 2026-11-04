import { afterEach, expect, test, vi } from "vitest";
import type { Album, Track } from "../src/types.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (current) await closeTestServer(current.app, current.db);
  current = null;
});

test("authenticated windows return bounded pages, true totals, stable revisions and legacy responses", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const tracks: Track[] = Array.from({ length: 251 }, (_, index) => ({
    id: `track-${index}`, providerId: `track-${index}`, title: `Track ${index}`,
    artistId: null, artistName: "Artist", albumId: null, albumName: "Album",
    durationSeconds: 180, trackNumber: index + 1, artworkId: null, artworkUrl: null,
    streamUrl: `/stream/${index}`,
  }));
  const albums: Album[] = Array.from({ length: 251 }, (_, index) => ({
    id: `album-${index}`, providerId: `album-${index}`, name: `Album ${index}`,
    artistId: null, artistName: "Artist", year: null, artworkId: null, artworkUrl: null, songCount: 1,
  }));
  const backend = createFakeBackend({
    listTracks: vi.fn(async () => tracks),
    listAlbums: vi.fn(async (limit = 500) => albums.slice(0, limit)),
    listAllAlbums: vi.fn(async () => albums),
  });
  current = await createTestServer(backend);
  const { app } = current;
  expect((await app.inject({ url: "/api/tracks?offset=0" })).statusCode).toBe(401);
  const { cookie } = await login(app);
  if (!cookie) throw new Error("Login did not issue a session cookie");
  const headers = { cookie };
  const [first, second] = await Promise.all([
    app.inject({ url: "/api/tracks?offset=0&limit=200", headers }),
    app.inject({ url: "/api/tracks?offset=230&limit=100", headers }),
  ]);
  expect(first.statusCode).toBe(200);
  expect(first.json().total).toBe(251);
  expect(first.json().tracks).toHaveLength(200);
  expect(second.json().tracks).toHaveLength(21);
  expect(second.json().tracks[0].title).toBe("Track 230");
  expect(second.json().revision).toBe(first.json().revision);
  expect(backend.listTracks).toHaveBeenCalledTimes(1);
  const empty = await app.inject({ url: "/api/tracks?offset=1000&limit=200", headers });
  expect(empty.json()).toMatchObject({ tracks: [], total: 251 });
  const filtered = await app.inject({
    method: "POST", url: "/api/library/tracks/filter", headers,
    payload: { filters: [{ field: "played", op: "boolean", value: false }], offset: 200, limit: 100 },
  });
  expect(filtered.json().tracks).toHaveLength(51);
  expect(filtered.json().total).toBe(251);
  expect(filtered.json().revision).toBe(first.json().revision);
  expect(backend.listTracks).toHaveBeenCalledTimes(1);
  const albumPage = await app.inject({ url: "/api/albums?offset=230&limit=200", headers });
  expect(albumPage.json().albums).toHaveLength(21);
  expect(albumPage.json().total).toBe(251);
  expect(backend.listAllAlbums).toHaveBeenCalledTimes(1);
  const legacyTracks = await app.inject({ url: "/api/tracks", headers });
  expect(legacyTracks.json().tracks).toHaveLength(251);
  expect(legacyTracks.json()).not.toHaveProperty("total");
  expect(backend.listTracks).toHaveBeenCalledTimes(2);
  const legacyAlbums = await app.inject({ url: "/api/albums?limit=20", headers });
  expect(legacyAlbums.json().albums).toHaveLength(20);
  expect(backend.listAlbums).toHaveBeenLastCalledWith(20);

  for (const query of ["offset=-1", "offset=1.5", "offset=0&limit=501", "offset=bad"]) {
    for (const resource of ["tracks", "albums"]) {
      expect((await app.inject({ url: `/api/${resource}?${query}`, headers })).statusCode).toBe(400);
    }
  }
  expect((await app.inject({ method: "POST", url: "/api/library/tracks/filter", headers,
    payload: { offset: -1 } })).statusCode).toBe(400);
  clock.mockReturnValue(now + 31_000);
  const refreshed = await app.inject({ url: "/api/tracks?offset=0", headers });
  expect(refreshed.json().revision).not.toBe(first.json().revision);
  expect(backend.listTracks).toHaveBeenCalledTimes(3);
}, 60_000);
