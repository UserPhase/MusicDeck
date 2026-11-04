import fs from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ExploreDiscoveryService } from "../src/domain/explore-discovery.js";
import { normalizeDeezerChart } from "../src/domain/deezer-discovery.js";
import type { DiscoveryCatalog } from "../src/services/discovery/deezerDiscoveryCatalog.js";
import { createUser } from "../src/users/users.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>>;
let userId: string;
beforeEach(async () => {
  env = await createTestServer();
  await login(env.app);
  userId = (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await closeTestServer(env.app, env.db);
  fs.rmSync(env.directory, { recursive: true, force: true });
});
const rawArtist = (id: number) => ({ id, name: `Artist ${id}`, picture_xl: `https://cdn-images.dzcdn.net/artist/${id}.jpg` });
const normalized = (id: number, count = 8) => normalizeDeezerChart({
  artists: { data: [rawArtist(id)] },
  albums: { data: Array.from({ length: count }, (_, index) => ({ id: id * 1000 + index, title: `Release ${index}`, artist: rawArtist(id) })) },
  tracks: { data: Array.from({ length: count }, (_, index) => ({
    id: id * 100 + index, title: `New song ${index}`, duration: 180,
    preview: `https://cdns-preview-a.dzcdn.net/${id}-${index}.mp3`, artist: rawArtist(id),
    album: { id: id * 1000 + index, title: `Release ${index}` },
  })) },
});
async function setup() {
  const base = (await env.catalog.listTracks()).items[0];
  const inventory = [{ ...base, id: "owned", title: "Already owned", artistId: "local-artist-1", artistName: "Artist 1",
    albumId: "owned-album", albumName: "Owned Album", identityHints: { isrc: "USOWN000001" } }];
  vi.spyOn(env.catalog, "listTracks").mockImplementation(async () => ({ items: inventory, degraded: false }));
  vi.spyOn(env.catalog, "listAlbums").mockResolvedValue({ items: [], degraded: false });
  vi.spyOn(env.catalog, "listArtists").mockResolvedValue({ items: [], degraded: false });
  const seeds = { discoverySeeds: vi.fn(() => [{ name: "Artist 1", score: 10 }, { name: "Artist 2", score: 5 }, { name: "Artist 3", score: 3 }]) };
  const catalog: DiscoveryCatalog = {
    searchArtist: vi.fn(async (name) => normalized(Number(name.split(" ").at(-1))).artists[0]),
    related: vi.fn(async () => [4, 5, 6, 7, 8].map((id) => normalized(id).artists[0])),
    tracks: vi.fn(async (artist) => normalized(Number(artist.id.split("_").at(-1))).tracks),
    albums: vi.fn(async (artist) => normalized(Number(artist.id.split("_").at(-1))).albums),
    charts: vi.fn(async () => normalized(9)),
  };
  let now = 0;
  const service = new ExploreDiscoveryService(env.db, env.catalog, seeds, catalog, () => now);
  return { service, catalog, seeds, inventory, base, advance: () => { now += 15_001; } };
}

test("songs/albums mix favourites and adjacent artists; the artist shelf excludes owned artists", async () => {
  const { service, catalog } = await setup();
  const result = await service.get(userId);
  expect(result.personalized).toBe(true);
  expect(result.degraded).toBe(false);
  for (const shelf of [result.tracks, result.albums]) {
    const favouriteCount = shelf.filter((item) => item.discoveryGroup === "favourite").length;
    const adjacentCount = shelf.filter((item) => item.discoveryGroup === "adjacent").length;
    expect(favouriteCount).toBeGreaterThanOrEqual(3);
    expect(Math.abs(favouriteCount - adjacentCount)).toBeLessThanOrEqual(1);
    expect(shelf.filter((item) => item.discoveryGroup === "adjacent").length).toBeGreaterThanOrEqual(3);
    expect(shelf.every((item) => item.external && item.source.kind === "external")).toBe(true);
    expect(new Set(shelf.map((item) => item.id)).size).toBe(shelf.length);
  }
  expect(result.artists.some((artist) => artist.name === "Artist 1")).toBe(false);
  expect(result.artists.some((artist) => artist.name === "Artist 4")).toBe(true);
  expect(result.tracks).toHaveLength(6);
  expect(result.tracks.every((track) => track.previewUrl && track.metadata.artistId && track.metadata.albumId)).toBe(true);
  expect(result.tracks.find((track) => track.discoveryGroup === "adjacent")?.recommendationReason).toMatch(/Because you listen/);
  expect(catalog.searchArtist).toHaveBeenCalledTimes(3);
  expect(catalog.related).toHaveBeenCalledTimes(3);
  expect(catalog.tracks).toHaveBeenCalledTimes(6);
  expect(catalog.albums).toHaveBeenCalledTimes(6);
  expect(catalog.charts).not.toHaveBeenCalled();
});

test("owned tracks match across provider IDs, punctuation, remasters and ISRC; album editions and duplicate recordings are excluded", async () => {
  const { service, catalog, inventory, base } = await setup();
  inventory.push({ ...base, id: "another-owned", artistName: "Artist 1", artistId: "local-artist-1", title: "Same, Song!", albumName: "Other" });
  const tracks = normalized(1).tracks;
  const additions = [
    { ...tracks[0], id: "external_deezer_track_990", title: "Already owned" },
    { ...tracks[0], id: "external_deezer_track_991", title: "Completely different metadata", isrc: "USOWN000001" },
    { ...tracks[0], id: "external_deezer_track_992", title: "Same Song - Remastered 2024" },
    { ...tracks[1], id: "external_deezer_track_993", title: tracks[0].title },
  ];
  vi.mocked(catalog.tracks).mockImplementation(async (artist) => artist.id.endsWith("_1") ? [...additions, ...tracks] : normalized(4).tracks);
  vi.mocked(catalog.albums).mockImplementation(async (artist) => artist.id.endsWith("_1")
    ? [{ ...normalized(1).albums[0], title: "Owned Album (Deluxe Edition)" }, ...normalized(1).albums] : normalized(4).albums);
  const result = await service.get(userId);
  expect(result.tracks.some((track) => ["990", "991", "992"].some((suffix) => track.id.endsWith(`_${suffix}`)))).toBe(false);
  expect(result.albums.some((album) => album.title.includes("Owned Album"))).toBe(false);
  expect(result.tracks.filter((track) => track.artist === "Artist 1" && track.title === tracks[0].title)).toHaveLength(1);
});

test("library artists are excluded across provider IDs and spelling variants without removing their missing songs/albums", async () => {
  const { service, catalog } = await setup();
  vi.mocked(env.catalog.listArtists).mockResolvedValue({ items: [
    { id: "local-known-four", name: "ÀRTIST 4" } as never,
  ], degraded: false });
  const result = await service.get(userId);
  expect(result.artists.some((artist) => ["Artist 1", "Artist 4"].includes(artist.name))).toBe(false);
  expect(result.artists.filter((artist) => artist.discoveryGroup === "adjacent").map((artist) => artist.name)).toEqual(["Artist 5", "Artist 6", "Artist 7", "Artist 8"]);
  expect(result.tracks.some((track) => track.artist === "Artist 1")).toBe(true);
  expect(result.albums.some((album) => album.artist === "Artist 1")).toBe(true);
  expect(catalog.tracks).toHaveBeenCalledTimes(6);
  expect(catalog.related).toHaveBeenCalledTimes(3);
});

test("artists leave the discovery shelf after their first track is imported", async () => {
  const { service, inventory, base, advance } = await setup();
  expect((await service.get(userId)).artists.some((artist) => artist.name === "Artist 4")).toBe(true);
  inventory.push({ ...base, id: "first-artist-four-track", artistName: "Artist 4", title: "First import" });
  advance();
  const result = await service.get(userId);
  expect(result.artists.some((artist) => artist.name === "Artist 4")).toBe(false);
  expect(result.artists.some((artist) => artist.name === "Artist 7")).toBe(true);
});

test("a single favourite fills seven new artist slots after ownership, blocking and duplicate filters without extra catalogue downloads", async () => {
  const { service, catalog, seeds } = await setup();
  seeds.discoverySeeds.mockReturnValue([{ name: "Artist 1", score: 10 }]);
  vi.mocked(env.catalog.listArtists).mockResolvedValue({ items: [
    { id: "local-four", name: "Artist 4" } as never,
    { id: "local-six", name: "Artist 6" } as never,
  ], degraded: false });
  env.recommendations.local.setFeedback(userId, "block-artist", "artist", "external_deezer_artist_5");
  vi.mocked(catalog.related).mockResolvedValue([1, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    .map((id) => normalized(id).artists[0]));
  const result = await service.get(userId);
  expect(result.artists.map((artist) => artist.name)).toEqual([
    "Artist 7", "Artist 8", "Artist 9", "Artist 10", "Artist 11", "Artist 12", "Artist 13",
  ]);
  expect(new Set(result.artists.map((artist) => artist.id)).size).toBe(7);
  expect(catalog.related).toHaveBeenCalledTimes(1);
  // Only the favourite and three neighbours need track/album data; artist
  // cards six and seven do not cause further catalogue requests.
  expect(catalog.tracks).toHaveBeenCalledTimes(4);
  expect(catalog.albums).toHaveBeenCalledTimes(4);
});

test("cold-start artist suggestions also exclude library artists", async () => {
  const { service, seeds } = await setup();
  seeds.discoverySeeds.mockReturnValue([]);
  vi.mocked(env.catalog.listArtists).mockResolvedValue({ items: [
    { id: "local-chart-artist", name: "Artist 9" } as never,
  ], degraded: false });
  const result = await service.get(userId);
  expect(result.personalized).toBe(false);
  expect(result.artists).toEqual([]);
  expect(result.tracks.length).toBeGreaterThan(0);
});

test("feedback is applied on each request, including local artist blocks matched to external names", async () => {
  const { service, catalog } = await setup();
  const first = await service.get(userId);
  const hidden = first.tracks.find((track) => track.discoveryGroup === "favourite")!;
  env.recommendations.local.setFeedback(userId, "hide", "track", hidden.id);
  env.recommendations.local.setFeedback(userId, "block-artist", "artist", "external_deezer_artist_4");
  env.recommendations.local.setFeedback(userId, "block-artist", "artist", "local-artist-1");
  vi.mocked(catalog.tracks).mockClear();
  const next = await service.get(userId);
  expect(next.tracks.some((track) => track.id === hidden.id || ["Artist 1", "Artist 4"].includes(track.artist))).toBe(false);
  expect(next.artists.some((artist) => ["Artist 1", "Artist 4"].includes(artist.name))).toBe(false);
  expect(next.albums.some((album) => ["Artist 1", "Artist 4"].includes(album.artist))).toBe(false);
  expect(vi.mocked(catalog.tracks).mock.calls.some(([artist]) => ["Artist 1", "Artist 4"].includes(artist.name))).toBe(false);
});

test("non-Latin album titles remain distinct while their deluxe editions deduplicate", async () => {
  const { service, inventory, base, catalog } = await setup();
  inventory.push({ ...base, id: "japanese", title: "Song", artistName: "Artist 1", albumName: "青い月" });
  vi.mocked(catalog.albums).mockImplementation(async (artist) => artist.id.endsWith("_1") ? [
    { ...normalized(1).albums[0], title: "青い月 (Deluxe Edition)" },
    { ...normalized(1).albums[1], title: "赤い月" },
  ] : []);
  const result = await service.get(userId);
  expect(result.albums.some((album) => album.title === "赤い月")).toBe(true);
  expect(result.albums.some((album) => album.title.includes("青い月"))).toBe(false);
});

test("new imports disappear after the short inventory refresh, even while external metadata is reused", async () => {
  const { service, inventory, base, advance } = await setup();
  const first = await service.get(userId);
  const target = first.tracks[0];
  inventory.push({ ...base, id: "newly-imported", title: target.title, artistName: target.artist, albumName: target.album || "" });
  advance();
  expect((await service.get(userId)).tracks.some((track) => track.id === target.id)).toBe(false);
  expect(env.catalog.listTracks).toHaveBeenCalledTimes(2);
});

test("partial external failures preserve successful suggestions; library outages never substitute unchecked music", async () => {
  const { service, catalog, advance } = await setup();
  vi.mocked(catalog.related).mockRejectedValue(new Error("Provider unavailable"));
  const result = await service.get(userId);
  expect(result.degraded).toBe(true);
  expect(result.tracks.length).toBeGreaterThan(0);
  expect(result.tracks.every((track) => track.discoveryGroup === "favourite")).toBe(true);
  vi.mocked(env.catalog.listTracks).mockRejectedValue(new Error("Library offline"));
  advance();
  const offline = await service.get(userId);
  expect(offline.tracks).toEqual([]);
  expect(offline.message).toContain("library could not be checked");
});

test("cold start uses clearly labelled external picks rather than unplayed local songs", async () => {
  const { service, seeds, catalog } = await setup();
  seeds.discoverySeeds.mockReturnValue([]);
  const result = await service.get(userId);
  expect(result.personalized).toBe(false);
  expect(result.tracks.every((track) => track.discoveryGroup === "popular")).toBe(true);
  expect(result.message).toContain("Listen to songs");
  expect(catalog.searchArtist).not.toHaveBeenCalled();
});

test("actual taste seeds are account-scoped and include unplayed liked songs and liked external albums", async () => {
  const { inventory, base } = await setup();
  const other = await createUser(env.db, { username: "other", password: "other-password" });
  if (!other) throw new Error("Missing test user");
  env.recommendations.local.recordListeningEvent(other.id, inventory[0].id, "complete");
  expect(env.recommendations.local.discoverySeeds(userId, inventory)).toEqual([]);
  env.db.prepare("INSERT INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?)")
    .run(userId, inventory[0].id, new Date().toISOString());
  expect(env.recommendations.local.discoverySeeds(userId, inventory)[0].name).toBe("Artist 1");
  env.libraryInsights.setFavorite(userId, "album", "external_deezer_album_20", true,
    { name: "An external favourite", artist: "Unowned Artist", coverUrl: null });
  expect(env.recommendations.local.discoverySeeds(userId, inventory).map((seed) => seed.name)).toContain("Unowned Artist");
  const skipped = { ...base, id: "skipped", artistName: "Skipped Artist" };
  env.recommendations.local.recordListeningEvent(userId, skipped.id, "skip");
  expect(env.recommendations.local.discoverySeeds(userId, [...inventory, skipped]).map((seed) => seed.name)).not.toContain("Skipped Artist");
});

test("route requires authentication and respects privacy policy", async () => {
  const cookie = (await login(env.app)).cookie!;
  const response = await env.app.inject({ method: "GET", url: "/api/discovery/personalized" });
  expect(response.statusCode).toBe(401);
  await env.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie },
    payload: { localOnly: true, allowMetadata: true, allowArtwork: true, allowImports: true } });
  const blocked = await env.app.inject({ method: "GET", url: "/api/discovery/personalized", headers: { cookie } });
  expect(blocked.statusCode).toBe(403);
});

test("authenticated route resolves external artists and related releases without exposing listening history", async () => {
  const { inventory } = await setup();
  env.recommendations.local.recordListeningEvent(userId, inventory[0].id, "complete");
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/artist") return new Response(JSON.stringify({ data: [rawArtist(1)] }));
    if (url.pathname.endsWith("/related")) return new Response(JSON.stringify({ data: [rawArtist(4)] }));
    const id = Number(url.pathname.split("/")[2]);
    const data = normalized(id);
    const raw = url.pathname.endsWith("/albums")
      ? data.albums.map((album, index) => ({ id: id * 1000 + index, title: album.title }))
      : data.tracks.map((track, index) => ({ id: id * 100 + index, title: track.title, duration: 180,
        artist: rawArtist(id), album: { id: id * 1000 + index, title: track.album }, preview: track.previewUrl }));
    return new Response(JSON.stringify({ data: raw }));
  });
  vi.stubGlobal("fetch", fetcher);
  const cookie = (await login(env.app)).cookie!;
  const response = await env.app.inject({ method: "GET", url: "/api/discovery/personalized", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json().tracks).toHaveLength(6);
  expect(new Set(response.json().tracks.map((track: { discoveryGroup: string }) => track.discoveryGroup))).toEqual(new Set(["favourite", "adjacent"]));
  expect(JSON.stringify(response.json())).not.toContain(userId);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes(userId))).toBe(true);
});
