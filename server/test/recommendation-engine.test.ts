import { performance } from "node:perf_hooks";
import fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RecommendationEngine, RECENT_PLAY_WINDOW_MS } from "../src/services/RecommendationEngine.js";
import { RecommendationService } from "../src/domain/recommendations.js";
import { addRecentlyPlayed } from "../src/domain/recently-played.js";
import { setTrackFavorite } from "../src/domain/favorites.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import type { Available } from "../src/domain/catalog.js";
import type { Track } from "../src/types.js";

let env: Awaited<ReturnType<typeof createTestServer>> | undefined;
afterEach(async () => {
  if (env) {
    await closeTestServer(env.app, env.db);
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
  env = undefined;
});

async function setup() {
  env = await createTestServer();
  const user = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  const base = (await env.catalog.listTracks()).items[0];
  const track = (id: string, tags: Partial<Track> = {}): Available<Track> => ({
    ...base, id, providerId: id, title: id, artistId: `artist-${id}`, artistName: id,
    genres: ["synthwave"], year: 2020, bpm: 120, moods: ["energetic"], ...tags,
  });
  return { ...env, userId: user.id, track };
}

describe("local recommendation scoring and exclusions", () => {
  test("scores genre, artist linkage, year, tempo, mood and personal affinity without catalog calls", async () => {
    const { db, userId, track } = await setup();
    const seed = track("seed", { relatedArtistIds: ["related"] });
    const close = track("close", { artistId: "related" });
    const distant = track("distant", { genres: ["jazz"], moods: ["calm"], year: 1960, bpm: 60 });
    const engine = new RecommendationEngine(db);
    engine.replaceCatalog([seed, close, distant]);
    const result = engine.select(userId, seed.id);
    expect(result.map(({ track }) => track.id)).toEqual(["close", "distant"]);
    expect(result[0].reason).toContain("synthwave");
    expect(result[0].reason).toContain("related artists");
    expect(result[0].score).toBeGreaterThan(result[1].score);
    await setTrackFavorite(db, userId, distant.id, true);
    engine.invalidate(userId);
    expect(engine.select(userId, seed.id).find(({ track }) => track.id === distant.id)!.score).toBeGreaterThan(result[1].score);
  });

  test("less-like-this reduces the track and neighboring genres immediately; feedback directions replace each other", async () => {
    const { db, catalog, userId, track } = await setup();
    const tracks = [track("seed"), track("negative"), track("neighbor"), track("different", { genres: ["jazz"] })];
    const service = new RecommendationService(db, catalog);
    service.engine.replaceCatalog(tracks);
    const score = () => service.engine.select(userId, "seed").find(({ track }) => track.id === "negative")!.score;
    const before = score();
    service.setFeedback(userId, "less-like-this", "track", "negative");
    expect(score()).toBeLessThan(before);
    const neighborBefore = service.engine.select(userId, "seed").find(({ track }) => track.id === "neighbor")!.score;
    service.setFeedback(userId, "more-like-this", "track", "negative");
    expect(score()).toBeGreaterThan(before);
    expect(service.engine.select(userId, "seed").find(({ track }) => track.id === "neighbor")!.score).toBeGreaterThan(neighborBefore);
    expect(db.prepare("SELECT action FROM recommendation_feedback WHERE item_id = 'negative'").all()).toEqual([{ action: "more-like-this" }]);
  });

  test("cached pools never return newly hidden tracks, artists, recent plays, or queued exclusions", async () => {
    const { db, catalog, userId, track } = await setup();
    const now = Date.now();
    const engine = new RecommendationEngine(db, () => now);
    const service = new RecommendationService(db, catalog);
    const tracks = ["seed", "hidden", "artist", "recent", "event", "old", "queued"].map((id) => track(id));
    engine.replaceCatalog(tracks);
    expect(engine.select(userId, "seed", 10)).toHaveLength(6);
    service.setFeedback(userId, "hide", "track", "hidden");
    service.setFeedback(userId, "block-artist", "artist", "artist-artist");
    engine.invalidate(userId);
    addRecentlyPlayed(db, userId, "recent", new Date(now - RECENT_PLAY_WINDOW_MS + 1).toISOString());
    addRecentlyPlayed(db, userId, "old", new Date(now - RECENT_PLAY_WINDOW_MS).toISOString());
    service.recordListeningEvent(userId, "event", "play");
    expect(engine.select(userId, "seed", 10, ["queued"]).map(({ track }) => track.id)).toEqual(["old"]);
    // A new play must be filtered even though the candidate pool is already cached.
    addRecentlyPlayed(db, userId, "old", new Date(now).toISOString());
    expect(engine.select(userId, "seed", 10, ["queued"])).toEqual([]);
  });

  test("personal feedback does not leak between users and skips reduce affinity", async () => {
    const { db, catalog, userId, track } = await setup();
    const service = new RecommendationService(db, catalog);
    service.engine.replaceCatalog([track("seed"), track("candidate")]);
    const before = service.engine.select(userId, "seed")[0].score;
    service.recordListeningEvent(userId, "candidate", "skip", 0.1);
    db.prepare("UPDATE listening_events SET created_at = '2020-01-01T00:00:00.000Z' WHERE track_id = 'candidate'").run();
    expect(service.engine.select(userId, "seed")[0].score).toBeLessThan(before);
    service.setFeedback(userId, "hide", "track", "candidate");
    expect(service.engine.select(userId, "seed")).toEqual([]);
    expect(service.engine.select("another-user", "seed").map(({ track }) => track.id)).toEqual(["candidate"]);
  });

  test("warm selections stay under 15ms at p95 with 20,000 catalog tracks and listening rows", async () => {
    const { db, userId, track } = await setup();
    const tracks = Array.from({ length: 20_000 }, (_, index) => track(String(index), {
      artistId: `artist-${index % 500}`, genres: [`genre-${index % 20}`],
    }));
    const engine = new RecommendationEngine(db);
    engine.replaceCatalog(tracks);
    const insert = db.prepare(`INSERT INTO listening_events
      (id,user_id,track_id,event_type,created_at,counted,finished) VALUES (?,?,?,'complete',?,1,1)`);
    db.transaction(() => {
      for (let index = 0; index < tracks.length; index++) {
        insert.run(`event-${index}`, userId, String(index), "2020-01-01T00:00:00.000Z");
      }
    })();
    engine.select(userId, "0", 10);
    const timings: number[] = [];
    for (let run = 0; run < 100; run++) {
      const start = performance.now();
      const result = engine.select(userId, "0", 10);
      timings.push(performance.now() - start);
      expect(result).toHaveLength(10);
      expect(new Set(result.map(({ track }) => track.id)).size).toBe(10);
    }
    timings.sort((a, b) => a - b);
    console.info(`20k-track cached recommendation p95: ${timings[94].toFixed(2)}ms`);
    expect(timings[94]).toBeLessThan(15);
  });
});

describe("autoplay API", () => {
  test("returns explained local candidates and applies track/artist hides immediately without another provider read", async () => {
    const { app, catalog, recommendations, userId, track } = await setup();
    const library = [track("seed"), track("hidden"), track("artist-hidden"), track("eligible")];
    const reads = vi.spyOn(catalog, "tracksForWindow").mockResolvedValue({ items: library, degraded: false, revision: "test" });
    await recommendations.local.refreshCatalog();
    const calls = reads.mock.calls.length;
    const { cookie } = await login(app);
    const request = () => app.inject({ method: "POST", url: "/api/recommendations/autoplay",
      headers: { cookie }, payload: { seedId: "seed", limit: 10 } });
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.json().tracks).toHaveLength(3);
    expect(first.json().tracks[0].metadata.recommendationReason).toContain("synthwave");
    for (const feedback of [
      { action: "hide", itemType: "track", itemId: "hidden" },
      { action: "block-artist", itemType: "artist", itemId: "artist-artist-hidden" },
    ]) {
      const result = await app.inject({ method: "POST", url: "/api/recommendations/feedback", headers: { cookie }, payload: feedback });
      expect(result.statusCode).toBe(200);
    }
    expect((await request()).json().tracks.map((item: { id: string }) => item.id)).toEqual(["eligible"]);
    addRecentlyPlayed(env!.db, userId, "eligible");
    expect((await request()).json().tracks).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(calls);
  });

  test("requires authentication, validates payloads, and reports unknown local seeds", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/recommendations/autoplay", payload: { seedId: "unknown" } })).statusCode).toBe(401);
    const { cookie } = await login(app);
    expect((await app.inject({ method: "POST", url: "/api/recommendations/autoplay", headers: { cookie }, payload: { seedId: "x", limit: 51 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/recommendations/autoplay", headers: { cookie }, payload: { seedId: "unknown" } })).statusCode).toBe(404);
  });
});
