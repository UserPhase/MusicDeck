import Database from "better-sqlite3";
import fs from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PlaylistRecommendationService } from "../src/domain/playlist-recommendations.js";
import { normalizeDeezerChart } from "../src/domain/deezer-discovery.js";
import type { Available } from "../src/domain/catalog.js";
import type { Playlist, Track } from "../src/types.js";
import type { DiscoveryCatalog } from "../src/services/discovery/deezerDiscoveryCatalog.js";
import { createFakeBackend, createTestServer, closeTestServer, login } from "./helpers.js";
import { createUser, getUserById } from "../src/users/users.js";

let db: Database.Database;
let base: Track;
beforeEach(async () => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE recommendation_feedback(user_id TEXT,item_type TEXT,item_id TEXT,action TEXT,updated_at TEXT DEFAULT '',identity_title TEXT,identity_artist TEXT,identity_album TEXT)");
  base = (await createFakeBackend().listTracks())[0];
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });
const local = (id: string, changes: Partial<Track> = {}): Available<Track> => ({
  ...base, id, title: id, artistName: "Artist One", genres: ["Rock"], ...changes,
  availability: { state: "available", connectionId: "test", sourceCount: 1, availableSourceCount: 1, libraryAvailable: true },
});
const playlist = (tracks: Track[]): Playlist => ({ id: "playlist", providerId: "playlist", name: "My mix",
  description: null, artworkId: null, artworkUrl: null, songCount: tracks.length, tracks });
function external(id: number, title: string, artist = "Artist One", isrc?: string) {
  return normalizeDeezerChart({ artists: { data: [] }, albums: { data: [] }, tracks: { data: [{
    id, title, duration: 180, isrc, artist: { id: artist === "Artist One" ? 1 : 2, name: artist },
    album: { id: 10, title: "Album" }, preview: `https://cdns-preview-a.dzcdn.net/${id}.mp3`,
  }] } }).tracks[0];
}
function setup(items: Available<Track>[], degraded = false) {
  const library = { listTracks: vi.fn(async () => ({ items, degraded })) };
  const artist = { id: "external_deezer_artist_1", external: true as const, provider: "deezer" as const,
    source: { kind: "external" as const, count: 0 as const }, deezerUrl: null, coverArt: null, type: "artist" as const, name: "Artist One" };
  const discovery: DiscoveryCatalog = { searchArtist: vi.fn(async () => artist), related: vi.fn(async () => []),
    tracks: vi.fn(async () => []), albums: vi.fn(async () => []), charts: vi.fn() };
  const service = new PlaylistRecommendationService(db, library, discovery);
  return { service, library, discovery };
}

test("library suggestions follow playlist artists/tags, exclude existing recordings and do no external work", async () => {
  const seed = local("seed", { title: "Already Here", identityHints: { isrc: "US1234567890" } });
  const { service, discovery } = setup([seed, local("same", { title: "Already Here - Remastered 2024" }),
    local("same-isrc", { identityHints: { isrc: "US1234567890" } }), local("new"),
    local("similar", { artistName: "Another artist", genres: ["Rock"] }),
    local("unrelated", { artistName: "Unrelated", genres: ["Jazz"] })]);
  const result = await service.get("listener", playlist([seed]), false);
  expect(result.items.map((item) => item.id).sort()).toEqual(["new", "similar"]);
  expect(discovery.searchArtist).not.toHaveBeenCalled();
  expect(result.items.every((item) => item.recommendationReason)).toBe(true);
});

test("external suggestions resolve owned recordings to local IDs and retain downloadable previews", async () => {
  const seed = local("seed", { title: "In Playlist" });
  const owned = local("owned", { title: "Owned", identityHints: { isrc: "US1234567890" } });
  const { service, discovery } = setup([seed, owned]);
  vi.mocked(discovery.tracks).mockResolvedValue([external(1, "In Playlist"), external(2, "New"),
    external(3, "New"), external(4, "Different title", "Artist One", "US1234567890"), external(5, "New (Live)")]);
  const result = await service.get("listener", playlist([seed]), true);
  expect(result.items.map((item) => item.id).sort()).toEqual([
    "external_deezer_track_2", "external_deezer_track_5", "owned",
  ]);
  expect(result.items.find((item) => item.id === "external_deezer_track_2"))
    .toMatchObject({ external: true, previewUrl: expect.stringContaining(".mp3") });
  expect(discovery.charts).not.toHaveBeenCalled();
});

test("hidden tracks/artists and unavailable owned files are excluded without proposing duplicate downloads", async () => {
  const seed = local("seed");
  const blocked = local("blocked", { artistId: "blocked-artist", artistName: "Blocked" });
  const offline = { ...local("offline", { title: "Offline" }), availability: {
    state: "unavailable" as const, connectionId: "test", sourceCount: 1, availableSourceCount: 0, libraryAvailable: false,
  } };
  const { service, discovery } = setup([seed, blocked, offline]);
  db.prepare("INSERT INTO recommendation_feedback(user_id,item_type,item_id,action) VALUES ('listener','artist','blocked-artist','block-artist')").run();
  vi.mocked(discovery.tracks).mockResolvedValue([external(1, "Offline"), external(2, "Other", "Blocked")]);
  expect((await service.get("listener", playlist([seed]), false)).items).toEqual([]);
  expect((await service.get("listener", playlist([seed]), true)).items).toEqual([]);
  expect((await service.get("another-listener", playlist([seed]), false)).items.map((item) => item.id)).toEqual(["blocked"]);
});

test("empty and degraded libraries avoid external calls; external failures preserve usable results", async () => {
  const seed = local("seed");
  const broken = setup([seed, local("new")], true);
  expect((await broken.service.get("listener", playlist([]), true)).items).toEqual([]);
  expect((await broken.service.get("listener", playlist([seed]), true)).message).toMatch(/library sources/);
  expect(broken.discovery.searchArtist).not.toHaveBeenCalled();
  expect((await broken.service.get("listener", playlist([seed]), false)).items).toHaveLength(1);
  const good = setup([seed]);
  vi.mocked(good.discovery.related).mockRejectedValue(new Error("offline"));
  vi.mocked(good.discovery.tracks).mockResolvedValue([external(1, "New")]);
  const result = await good.service.get("listener", playlist([seed]), true);
  expect(result.items).toHaveLength(1); expect(result.message).toMatch(/Some external/);
});

test("lookup fan-out is bounded and concurrent playlist loads share inventory and work", async () => {
  const seeds = Array.from({ length: 30 }, (_, index) => local(`seed-${index}`, { artistName: `Artist ${index}` }));
  const { service, library, discovery } = setup(seeds);
  const mix = playlist(seeds);
  await Promise.all([service.get("listener", mix, true), service.get("listener", mix, true)]);
  expect(discovery.searchArtist).toHaveBeenCalledTimes(3);
  expect(library.listTracks).toHaveBeenCalledTimes(1);
  expect(vi.mocked(discovery.tracks).mock.calls.length).toBeLessThanOrEqual(6);
});

test("recommendation routes authenticate, isolate private playlists and honor external-search permission", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } }));
  const env = await createTestServer(createFakeBackend(), {}, undefined, fetcher);
  try {
    const owner = await createUser(env.db, { username: "owner", password: "password-owner" });
    await createUser(env.db, { username: "other", password: "password-other" });
    const mix = await env.playlists.create("Private", owner!);
    await env.playlists.addTrack(mix.id, (await env.catalog.listTracks()).items[0].id);
    const url = `/api/v1/playlists/${mix.id}/recommendations`;
    expect((await env.app.inject(url)).statusCode).toBe(401);
    const other = await login(env.app, "other", "password-other");
    expect((await env.app.inject({ url, headers: { cookie: other.cookie! } })).statusCode).toBe(404);
    const signedIn = await login(env.app, "owner", "password-owner");
    const headers = { cookie: signedIn.cookie! };
    expect((await env.app.inject({ url, headers })).statusCode).toBe(200);
    env.db.prepare("UPDATE users SET external_search_enabled=0 WHERE id=?").run(owner!.id);
    expect(getUserById(env.db, owner!.id)?.externalSearchEnabled).toBe(false);
    const response = await env.app.inject({ url: `${url}?source=external`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], canModify: true });
    expect(response.json().message).toMatch(/disabled/);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await env.app.inject({ url: `${url}?source=invalid`, headers })).statusCode).toBe(400);
  } finally {
    await closeTestServer(env.app, env.db);
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});

test("local-only policy retains library recommendations and prevents all external lookups", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
  const env = await createTestServer(createFakeBackend(), { localOnlyMode: true }, undefined, fetcher);
  try {
    const user = getUserById(env.db, (env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id)!;
    const mix = await env.playlists.create("Local mix", user);
    await env.playlists.addTrack(mix.id, (await env.catalog.listTracks()).items[0].id);
    const signedIn = await login(env.app);
    const url = `/api/v1/playlists/${mix.id}/recommendations`;
    const headers = { cookie: signedIn.cookie! };
    expect((await env.app.inject({ url, headers })).statusCode).toBe(200);
    expect((await env.app.inject({ url: `${url}?source=external`, headers })).json()).toMatchObject({ items: [] });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await closeTestServer(env.app, env.db);
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});
