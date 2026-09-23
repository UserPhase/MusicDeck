import { afterEach, describe, expect, test, vi } from "vitest";

import { RecommendationService } from "../src/domain/recommendations.js";
import { addRecentlyPlayed } from "../src/domain/recently-played.js";
import { listRecentlyPlayed } from "../src/domain/recently-played.js";
import { setTrackFavorite } from "../src/domain/favorites.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup() {
  current = await createTestServer();
  return current;
}

async function userId(db: Awaited<ReturnType<typeof createTestServer>>["db"]) {
  const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  return user.id;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("RecommendationService", () => {
  test("builds favorites mix from local favorite and listening signals with explanations", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];

    await setTrackFavorite(db, id, track.id, true);
    addRecentlyPlayed(db, id, track.id);
    const service = new RecommendationService(db, catalog);
    service.recordListeningEvent(id, track.id, "complete", 1);

    const result = await service.recommend({ userId: id, kind: "favorites-mix", limit: 5 });

    expect(result).toEqual([
      expect.objectContaining({
        id: track.id,
        title: "Track One",
        metadata: expect.objectContaining({ recommendationReason: "From your favorites" }),
      }),
    ]);
  });

  test("continue listening favors recently played tracks deterministically", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    addRecentlyPlayed(db, id, track.id);

    const service = new RecommendationService(db, catalog);
    const result = await service.recommend({ userId: id, kind: "continue-listening", limit: 5 });

    expect(result[0]).toMatchObject({ id: track.id });
    expect(result[0].metadata.recommendationReason).toBe("Recently played");
  });

  test("excludes plays older than the rolling 45-day window", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    addRecentlyPlayed(db, id, track.id, new Date(Date.now() - 46 * 86_400_000).toISOString());

    const service = new RecommendationService(db, catalog);
    expect(await listRecentlyPlayed(db, catalog, id)).toEqual([]);
    expect(await service.recommend({ userId: id, kind: "continue-listening", limit: 5 })).toEqual([]);
  });

  test("deep cuts prefer unplayed tracks by a recently favored artist, not high-count tracks", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const base = (await catalog.listTracks()).items[0];
    const popular = { ...base, id: "popular", playCount: 12 };
    const deepCut = { ...base, id: "deep-cut", title: "Unheard song", playCount: 0 };
    const overplayed = { ...base, id: "overplayed", title: "Familiar song", playCount: 25 };
    const locallyPlayed = { ...base, id: "locally-played", title: "Repeated here", playCount: null };
    const fakeCatalog = { listTracks: async () => ({ items: [popular, deepCut, overplayed, locallyPlayed], degraded: false }) } as any;
    addRecentlyPlayed(db, id, popular.id);
    const service = new RecommendationService(db, fakeCatalog);
    service.recordListeningEvent(id, locallyPlayed.id, "complete", 1);
    service.recordListeningEvent(id, locallyPlayed.id, "complete", 1);

    const results = await service.recommend({ userId: id, kind: "forgotten-favorites", limit: 5 });
    expect(results.map((item) => item.id)).toContain("deep-cut");
    expect(results.map((item) => item.id)).not.toContain("overplayed");
    expect(results.map((item) => item.id)).not.toContain("locally-played");
  });

  test("not-interested and blocked album feedback remove candidates", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    const service = new RecommendationService(db, catalog);
    service.setFeedback(id, "block-album", "album", track.albumId!);

    const result = await service.recommend({ userId: id, kind: "favorites-mix", limit: 5 });

    expect(result).toEqual([]);
  });

  test("more-like-this boosts a candidate without provider-specific logic", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    const service = new RecommendationService(db, catalog);
    service.setFeedback(id, "more-like-this", "track", track.id);

    const result = await service.recommend({ userId: id, kind: "discover", limit: 5 });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: track.id }),
    ]));
  });

  test("track radio excludes the seed and returns a playable queue model", async () => {
    const { db, catalog } = await setup();
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    const service = new RecommendationService(db, catalog);

    const result = await service.radio({
      type: "track",
      id: track.id,
      title: track.title,
      artist: track.artistName,
      album: track.albumName,
      artistId: track.artistId,
      albumId: track.albumId,
    }, id, 10);

    expect(result.some((item) => item.id === track.id)).toBe(false);
    expect(result.every((item) => item.type === "track")).toBe(true);
  });
});

describe("Recommendation API", () => {
  test("serves recently added songs for a history-free homepage", async () => {
    const backend = createFakeBackend();
    const original = await backend.listTracks();
    const older = { ...original[0], id: "older", providerId: "older", title: "Older", addedAt: "2025-01-01T00:00:00Z" };
    const newer = { ...original[0], id: "newer", providerId: "newer", title: "Newer", addedAt: "2026-01-01T00:00:00Z" };
    current = await createTestServer(createFakeBackend({ listTracks: vi.fn(async () => [older, newer]) }));
    const { cookie } = await login(current.app);

    const response = await current.app.inject({
      method: "GET", url: "/api/tracks/recently-added?limit=1", headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tracks.map((track: { title: string }) => track.title)).toEqual(["Newer"]);
  });
  test("scrobbles a qualified play using the provider's native track ID", async () => {
    const scrobbleTrack = vi.fn(async () => undefined);
    current = await createTestServer(createFakeBackend({ scrobbleTrack } as any));
    const { app, catalog } = current;
    const { cookie } = await login(app);
    const track = (await catalog.listTracks()).items[0];

    const response = await app.inject({
      method: "POST", url: "/api/listening-events", headers: { cookie },
      payload: { trackId: track.id, eventType: "complete", completionRatio: 0.5 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().scrobbled).toBe(true);
    expect(scrobbleTrack).toHaveBeenCalledWith("track-1", expect.any(Number));
  });
  test("returns only non-empty recommendation sections", async () => {
    const { app, db, catalog } = await setup();
    const { cookie } = await login(app);
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];
    await setTrackFavorite(db, id, track.id, true);

    const response = await app.inject({
      method: "GET",
      url: "/api/recommendations?kinds=favorites-mix,forgotten-favorites&limit=5",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sections).toEqual([
      expect.objectContaining({ id: "favorites-mix", title: "Made for you" }),
      expect.objectContaining({ id: "forgotten-favorites", title: "Forgotten favorites" }),
    ]);
  });

  test("records listening events and feedback through authenticated endpoints", async () => {
    const { app, db, catalog } = await setup();
    const { cookie } = await login(app);
    const id = await userId(db);
    const track = (await catalog.listTracks()).items[0];

    const event = await app.inject({
      method: "POST",
      url: "/api/listening-events",
      headers: { cookie },
      payload: { trackId: track.id, eventType: "complete", completionRatio: 1 },
    });
    const feedback = await app.inject({
      method: "POST",
      url: "/api/recommendations/feedback",
      headers: { cookie },
      payload: { action: "more-like-this", itemType: "track", itemId: track.id },
    });

    expect(event.statusCode).toBe(201);
    expect(feedback.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM listening_events WHERE user_id = ?").get(id)).toMatchObject({ count: 1 });
    expect(await listRecentlyPlayed(db, catalog, id)).toHaveLength(1);
  });

  test("creates a track radio queue through the existing normalized track model", async () => {
    const { app, catalog } = await setup();
    const { cookie } = await login(app);
    const track = (await catalog.listTracks()).items[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/recommendations/radio",
      headers: { cookie },
      payload: {
        type: "track",
        id: track.id,
        title: track.title,
        artist: track.artistName,
        album: track.albumName,
        artistId: track.artistId,
        albumId: track.albumId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tracks.every((item: any) => item.type === "track")).toBe(true);
    expect(response.json().tracks.some((item: any) => item.id === track.id)).toBe(false);
  });
});
