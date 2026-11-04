import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { SmartPlaylistEvaluator } from "../src/services/SmartPlaylistEvaluator.js";
import { SimilarMixEngine } from "../src/services/SimilarMixEngine.js";
import { PrivacyManager } from "../src/services/PrivacyManager.js";
import type { Track } from "../src/types.js";

let db: Database.Database;
let engines: SimilarMixEngine[] = [];
afterEach(async () => { await Promise.all(engines.map(engine => engine.close())); engines = []; db?.close(); });
const track = (id: string, artist = `Artist ${id}`): Track => ({ id, title: `Song ${id}`, artistName: artist, artistId: `artist-${artist}`,
  providerId: id, albumId: `album-${id}`, albumName: "Album", durationSeconds: 180, trackNumber: null, artworkId: null, artworkUrl: null, streamUrl: "" });
function setup(localCount = 70) {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); runMigrations(db);
  db.exec(`INSERT INTO roles VALUES('user','Listener'); INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES('alice','alice','unused','Alice','user','2026-01-01','2026-01-01'),('bob','bob','unused','Bob','user','2026-01-01','2026-01-01')`);
  let now = Date.now();
  const evaluator = new SmartPlaylistEvaluator(db, () => now);
  const seeds = Array.from({ length: 5 }, (_, i) => track(`seed-${i}`, `Seed Artist ${i}`));
  const candidates = Array.from({ length: 120 }, (_, i) => track(`candidate-${i}`, `Candidate Artist ${Math.floor(i / 3)}`));
  const library = [...seeds, ...candidates.slice(0, localCount)];
  const publish = (items = library, degraded = false) => { now++; evaluator.replaceCatalog({ items: items as any, degraded }); };
  publish();
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)), title = url.searchParams.get("track");
    return new Response(JSON.stringify({ similartracks: { track: candidates.map((candidate, index) => ({
      name: candidate.title, artist: { name: candidate.artistName }, match: String(1 - index / 150), mbid: "",
    })) } }), { status: 200 });
  }) as ReturnType<typeof vi.fn> & typeof fetch;
  const makeEngine = (overrides: Partial<ConstructorParameters<typeof SimilarMixEngine>[1]> = {}) => {
    const engine = new SimilarMixEngine(db, { apiKey: () => "test-key", fetchImpl: fetcher, now: () => now, requestSpacingMs: 0, ...overrides }); engines.push(engine); return engine;
  };
  return { seeds, candidates, library, publish, fetcher, makeEngine, advance: (ms: number) => { now += ms; } };
}
const input = (ids: string[], extra = {}) => ({ seedTrackIds: ids, scope: "HYBRID_MIX" as const, adventurousness: 0.5, shuffleSeed: "fixed", ...extra });
function feedback(type: string, id: string, action: string, title: string | null = null, artist: string | null = null) {
  db.prepare(`INSERT INTO recommendation_feedback(user_id,item_type,item_id,action,weight,created_at,updated_at,identity_title,identity_artist)
    VALUES('alice',?,?,?,-1,'2026-01-01','2026-01-01',?,?)`).run(type, id, action, title, artist);
}

test("blends five seeds, preserves scope, excludes seed recordings, and shifts discovery share with adventurousness", async () => {
  const { seeds, fetcher, makeEngine } = setup(), engine = makeEngine();
  const familiar = await engine.generate("alice", input(seeds.map(row => row.id), { adventurousness: 0 }));
  const adventurous = await engine.generate("alice", input(seeds.map(row => row.id), { adventurousness: 1 }));
  expect(familiar.tracks).toHaveLength(25); expect(familiar.tracks.every(row => row.inLibrary)).toBe(true);
  expect(adventurous.tracks).toHaveLength(25); expect(adventurous.tracks.every(row => !row.inLibrary)).toBe(true);
  expect(new Set(adventurous.tracks.map(row => row.id)).size).toBe(25);
  expect(adventurous.tracks.every(row => row.reason.includes("5 of your seed"))).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(5);
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get("method")).toBe("track.getSimilar"); expect(url.searchParams.get("format")).toBe("json");
  expect(url.searchParams.has("api_sig")).toBe(false);
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "User-Agent": expect.stringContaining("MusicDeck") });
  const local = await engine.generate("alice", input([seeds[0].id], { scope: "LIBRARY_ONLY", adventurousness: 1 }));
  expect(local.tracks.every(row => row.inLibrary)).toBe(true);
});

test("applies live track, artist and cross-provider identity exclusions even for locks and cached vectors", async () => {
  const { seeds, candidates, makeEngine } = setup(), engine = makeEngine();
  const request = input([seeds[0].id], { scope: "LIBRARY_ONLY" });
  const first = await engine.generate("alice", request), hidden = first.tracks[0], blocked = first.tracks[1];
  feedback("track", hidden.id, "hide"); feedback("artist", blocked.track.artistId!, "block-artist");
  feedback("track", "external_deezer_track_999", "hide", candidates[2].title, candidates[2].artistName);
  const second = await engine.generate("alice", request);
  expect(second.tracks.some(row => row.id === hidden.id || row.artist === blocked.artist || row.id === candidates[2].id)).toBe(false);
  await expect(engine.generate("alice", { ...request, lockedTrackIds: [hidden.id] })).rejects.toMatchObject({ statusCode: 409 });
  expect(() => engine.materialize("alice", [hidden.id])).toThrow("hidden");
  const bob = await engine.generate("bob", request); expect(bob.tracks.some(row => row.id === hidden.id)).toBe(true);
});

test("honors the hybrid discovery proportion even when relaxing artist diversity is necessary", async () => {
  const { candidates, publish, makeEngine, seeds } = setup();
  candidates.forEach(row => { row.artistName = "One prolific artist"; row.artistId = "one-artist"; }); publish();
  const result = await makeEngine().generate("alice", input([seeds[0].id], { adventurousness: 0.4 }));
  expect(result.tracks).toHaveLength(25); expect(result.tracks.filter(row => !row.inLibrary)).toHaveLength(10);
});

test("scores familiarity using original listening counts and favorites without putting user data in the shared vector cache", async () => {
  const { seeds, makeEngine } = setup(), engine = makeEngine(), request = input([seeds[0].id], { scope: "LIBRARY_ONLY", adventurousness: 0 });
  const first = await engine.generate("alice", request), chosen = first.tracks[10];
  db.prepare("INSERT INTO favorites VALUES('alice',?,'2026-01-01')").run(chosen.id);
  const insert = db.prepare("INSERT INTO recently_played(id,user_id,track_id,played_at) VALUES(?,'alice',?,'2026-01-01')");
  for (let i = 0; i < 20; i++) insert.run(`play-${i}`, chosen.id);
  const next = await engine.generate("alice", request), bob = await engine.generate("bob", request);
  expect(next.tracks.find(row => row.id === chosen.id)!.familiarity).toBe(1);
  expect(next.tracks.find(row => row.id === chosen.id)!.score).toBeGreaterThan(first.tracks.find(row => row.id === chosen.id)!.score);
  expect(bob.tracks.find(row => row.id === chosen.id)!.familiarity).toBe(0.25);
});

test("coalesces requests, reloads persistent vectors after restart and repairs corrupt cache payloads", async () => {
  const { seeds, makeEngine, fetcher } = setup(), engine = makeEngine(), request = input([seeds[0].id]);
  const [a, b] = await Promise.all([engine.generate("alice", request), engine.generate("alice", request)]);
  expect(a.tracks.map(row => row.id)).toEqual(b.tracks.map(row => row.id)); expect(fetcher).toHaveBeenCalledTimes(1);
  const restarted = makeEngine(); expect((await restarted.generate("alice", request)).cached).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  db.prepare("UPDATE similar_mix_vectors SET payload_json='broken'").run();
  const repaired = makeEngine(); expect((await repaired.generate("alice", request)).tracks).toHaveLength(25); expect(fetcher).toHaveBeenCalledTimes(2);
});

test("handles HTTP-200 API errors, persists rate-limit backoff, and falls back to stale vectors on provider failure", async () => {
  const { seeds, makeEngine, fetcher, advance } = setup(), engine = makeEngine(), request = input([seeds[0].id]);
  await engine.generate("alice", request); advance(8 * 86_400_000);
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: 29, message: "Rate limit exceeded" }), { status: 200 }));
  const stale = await engine.generate("alice", request); expect(stale.tracks).toHaveLength(25); expect(stale.warnings.join(" ")).toContain("rate limiting");
  const calls = fetcher.mock.calls.length, restarted = makeEngine();
  expect((await restarted.generate("alice", request)).tracks).toHaveLength(25); expect(fetcher).toHaveBeenCalledTimes(calls);
  advance(6 * 60_000); fetcher.mockImplementation(async () => new Response("{\"error\":10}", { status: 200 }));
  const badKey = await engine.generate("alice", request); expect(badKey.warnings.join(" ")).toContain("API key");
});

test("supports external seeds, deterministic refresh, locked selections and cached second-hop traversal", async () => {
  const { candidates, makeEngine, fetcher } = setup(), engine = makeEngine();
  const external = engine.registerExternalSeed("External seed", "Other artist");
  const request = input([external.id], { scope: "DISCOVERY_ONLY", adventurousness: 0.8 });
  const first = await engine.generate("alice", request), locked = first.tracks[0].id;
  const next = await engine.generate("alice", { ...request, shuffleSeed: "different", lockedTrackIds: [locked], excludeTrackIds: [first.tracks[1].id] });
  expect(next.tracks.some(row => row.id === locked)).toBe(true); expect(next.tracks.some(row => row.id === first.tracks[1].id)).toBe(false);
  expect(next.tracks.map(row => row.id)).not.toEqual(first.tracks.map(row => row.id));
  expect(() => engine.materialize("alice", [next.tracks[0].id])).not.toThrow();
  // Warm a bridge from the first vector, then traverse it without another network request.
  const bridge = engine.registerExternalSeed(candidates[0].title, candidates[0].artistName);
  await engine.generate("alice", input([bridge.id])); const before = fetcher.mock.calls.length;
  await engine.generate("alice", request); expect(fetcher).toHaveBeenCalledTimes(before);
});

test("honors local-only privacy without sending seed metadata and rejects invalid inputs and degraded discovery", async () => {
  const { seeds, library, publish, makeEngine, fetcher } = setup(), engine = makeEngine(), privacy = new PrivacyManager(db, true);
  await privacy.run(async () => {
    const result = await engine.generate("alice", input([seeds[0].id], { scope: "LIBRARY_ONLY" }));
    expect(result.warnings.join(" ")).toContain("disabled"); expect(fetcher).not.toHaveBeenCalled();
    await expect(engine.generate("alice", input([seeds[0].id]))).rejects.toMatchObject({ statusCode: 403 });
  });
  await expect(engine.generate("alice", input([]))).rejects.toMatchObject({ statusCode: 400 });
  await expect(engine.generate("alice", input(seeds.map(row => row.id), { adventurousness: 2 }))).rejects.toMatchObject({ statusCode: 400 });
  publish(library, true); await expect(engine.generate("alice", input([seeds[0].id]))).rejects.toThrow("Reconnect");
});

test("generates warmed five-seed mixes in less than 20ms against a 10,000-track library", async () => {
  const { seeds, library, publish, makeEngine, fetcher } = setup(), engine = makeEngine();
  publish([...library, ...Array.from({ length: 10_000 }, (_, i) => track(`unrelated-${i}`))]);
  const request = input(seeds.map(row => row.id)); await engine.generate("alice", request);
  for (let i = 0; i < 5; i++) await engine.generate("alice", request);
  const durations: number[] = [];
  for (let i = 0; i < 20; i++) { const result = await engine.generate("alice", request); expect(result.cached).toBe(true); durations.push(result.generatedInMs); }
  expect(fetcher).toHaveBeenCalledTimes(5);
  console.info("Cached similar-mix timings (ms)", { max: Math.max(...durations), mean: durations.reduce((a, b) => a + b) / durations.length });
  expect(Math.max(...durations)).toBeLessThan(20);
});
