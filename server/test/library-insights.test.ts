import { afterEach, describe, expect, test, vi } from "vitest";

import { setTrackFavorite } from "../src/domain/favorites.js";
import { addRecentlyPlayed } from "../src/domain/recently-played.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup() {
  current = await createTestServer();
  return current;
}

async function userId(db: Awaited<ReturnType<typeof createTestServer>>["db"]) {
  return (db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("LibraryInsightsService", () => {
  test("omits historical ratings from the track catalog", async () => {
    const { libraryInsights, db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];

    db.prepare("INSERT INTO media_ratings VALUES (?, 'track', ?, 5, '2026', '2026')").run(id, track.id);
    const result = await libraryInsights.tracks({ userId: id });
    expect(result.tracks[0]).not.toHaveProperty("rating");
  });

  test("supports composable favorite, play-count, played, duration, and metadata filters", async () => {
    const { libraryInsights, db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    await setTrackFavorite(db, id, track.id, true);
    addRecentlyPlayed(db, id, track.id);

    const result = await libraryInsights.tracks({
      userId: id,
      filters: [
        { field: "favorite", op: "boolean", value: true },
        { field: "playCount", op: "gte", value: 1 },
        { field: "durationSeconds", op: "gte", value: 100 },
        { field: "artistName", op: "contains", value: "artist" },
      ],
    });

    expect(result.tracks).toEqual([
      expect.objectContaining({ id: track.id, favorite: true, playCount: 1, played: true }),
    ]);
  });

  test("counts all matching tracks but copies only the requested page", async () => {
    const { libraryInsights, db, catalog } = await setup();
    const id = await userId(db);
    const [base] = (await catalog.tracksForWindow()).items;
    const readStreamUrl = vi.fn((trackId: string) => `/stream/${trackId}`);
    const items = Array.from({ length: 6 }, (_, index) => {
      const trackId = `track-${index}`;
      return {
        ...base, id: trackId, title: index % 2 === 0 ? "Match" : "Skip", playCount: 10,
        get streamUrl() { return readStreamUrl(trackId); },
      };
    });
    vi.spyOn(catalog, "tracksForWindow").mockResolvedValue({ items, revision: "test-page", degraded: true });

    const filters = [
      { field: "title", value: "Match" },
      { field: "playCount", value: 0 },
    ];
    const filtered = await libraryInsights.tracks({ userId: id, filters, offset: 1, limit: 1 });
    expect(filtered).toMatchObject({
      tracks: [{ id: "track-2", playCount: 0 }], total: 3, revision: "test-page", degraded: true,
    });
    expect(readStreamUrl.mock.calls).toEqual([["track-2"]]);

    readStreamUrl.mockClear();
    const empty = await libraryInsights.tracks({ userId: id, filters, offset: 3, limit: 1 });
    expect(empty).toMatchObject({ tracks: [], total: 3 });
    expect(readStreamUrl).not.toHaveBeenCalled();

    const unfiltered = await libraryInsights.tracks({ userId: id, offset: 3, limit: 1 });
    expect(unfiltered).toMatchObject({ tracks: [{ id: "track-3" }], total: 6 });
    expect(readStreamUrl.mock.calls).toEqual([["track-3"]]);
  });

  test("saves and lists reusable filter combinations", async () => {
    const { libraryInsights, db } = await setup();
    const id = await userId(db);

    const saved = libraryInsights.saveFilter(id, "Unplayed favorites", [
      { field: "played", op: "boolean", value: false },
      { field: "favorite", op: "boolean", value: true },
    ]);

    expect(saved).toMatchObject({ name: "Unplayed favorites" });
    expect(libraryInsights.listFilters(id)).toEqual([
      expect.objectContaining({ id: saved.id, name: "Unplayed favorites" }),
    ]);
  });

  test("returns a collection of tracks by favorite artists", async () => {
    const { libraryInsights, db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    libraryInsights.setFavorite(id, "track", track.id, true);

    const artists = await libraryInsights.collection(id, "favorite-artists");

    expect(artists.tracks).toEqual([expect.objectContaining({ id: track.id })]);
  });

  test("reports library health and collection statistics without modifying media", async () => {
    const { libraryInsights, db } = await setup();
    const id = await userId(db);

    const health = await libraryInsights.health(id);
    const stats = await libraryInsights.statistics(id);

    expect(health.summary).toMatchObject({
      albums: 1,
      tracks: 1,
      artists: 1,
      missingArtwork: 0,
      metadataIssues: 0,
      unavailable: 0,
    });
    expect(stats.collection).toMatchObject({
      tracks: 1,
      albums: 1,
      artists: 1,
      totalDurationSeconds: 180,
      playedPercentage: 0,
      favoritePercentage: 0,
    });
  });

  test("uses conservative canonical identities for duplicate detection", async () => {
    const { libraryInsights, db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    const duplicate = { ...track, id: "track-copy", providerId: "track-copy" };
    catalog.listTracks = async () => ({
      items: [track, duplicate],
      degraded: false,
    });

    const health = await libraryInsights.health(id);

    expect(health.summary.duplicates).toBe(2);
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "duplicate-track", itemId: track.id }),
      expect.objectContaining({ type: "duplicate-track", itemId: duplicate.id }),
    ]));
  });

  test("serves library management endpoints with authentication", async () => {
    const { app, catalog } = await setup();
    const { cookie } = await login(app);
    const track = (await catalog.listTracks()).items[0];

    const rating = await app.inject({
      method: "PUT",
      url: `/api/library/track/${track.id}/rating`,
      headers: { cookie },
      payload: { rating: 4 },
    });
    const filtered = await app.inject({
      method: "POST",
      url: "/api/library/tracks/filter",
      headers: { cookie },
      payload: { filters: [{ field: "id", op: "eq", value: track.id }] },
    });
    const health = await app.inject({ method: "GET", url: "/api/library/health", headers: { cookie } });
    const stats = await app.inject({ method: "GET", url: "/api/library/statistics", headers: { cookie } });

    expect(rating.statusCode).toBe(404);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().tracks).toHaveLength(1);
    expect(health.statusCode).toBe(200);
    expect(stats.statusCode).toBe(200);
  });
});
