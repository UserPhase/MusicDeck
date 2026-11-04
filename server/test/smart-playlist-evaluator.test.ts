import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { compileSmartPlaylistRule, SmartPlaylistEvaluator } from "../src/services/SmartPlaylistEvaluator.js";
import { InvalidSmartPlaylistRule, parseSmartPlaylistRule, type SmartPlaylistRule } from "../src/types/smart-playlist.js";
import type { Available, CatalogListResult } from "../src/domain/catalog.js";
import type { Track } from "../src/types.js";
import { createFakeBackend } from "./helpers.js";

let db: Database.Database;
let evaluator: SmartPlaylistEvaluator;
let base: Track;
const now = Date.parse("2026-10-17T12:00:00Z");
const day = 86_400_000;
beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runMigrations(db);
  db.prepare("INSERT INTO roles VALUES ('user','Listener')").run();
  for (const id of ["alice", "bob"]) db.prepare(`INSERT INTO users
    (id,username,password_hash,display_name,role,created_at,updated_at) VALUES (?,?,?,?,'user',?,?)`)
    .run(id, id, "unused", id, new Date(now).toISOString(), new Date(now).toISOString());
  evaluator = new SmartPlaylistEvaluator(db, () => now);
  base = (await createFakeBackend().listTracks())[0];
});
afterEach(async () => { await evaluator.close(); db.close(); });
const track = (id: string, changes: Partial<Track> = {}): Available<Track> => ({
  ...base, id, title: id, ...changes,
  availability: { state: "available", connectionId: "test", sourceCount: 1, availableSourceCount: 1, libraryAvailable: true },
});
const rule = (field: string, operator: string, value: unknown) => ({ field, operator, value });
const ids = (rules: unknown, user = "alice") => evaluator.evaluate(user, rules).tracks.map((item) => item.id);

test("similar songs use artist or shared genre with tagged tempo and exclude the seed", () => {
  evaluator.replaceCatalog({ degraded: false, items: [
    track("seed", { artistName: "Neon", genres: ["Synthwave"], bpm: 120 }),
    track("same-artist", { artistName: "Neon", genres: ["Rock"], bpm: 180 }),
    track("near-tempo", { artistName: "Another", genres: ["synthwave"], bpm: 130 }),
    track("unknown-tempo", { artistName: "Third", genres: ["Synthwave"], bpm: null }),
    track("far-tempo", { artistName: "Fourth", genres: ["Synthwave"], bpm: 190 }),
    track("unrelated", { artistName: "Fifth", genres: ["Jazz"], bpm: 120 }),
  ] });
  expect(ids(rule("similar_to", "matches", "seed"))).toEqual(["near-tempo", "unknown-tempo"]);
  expect(ids(rule("similar_to", "matches", "missing"))).toEqual([]);
  expect(ids({ operator: "AND", rules: [rule("similar_to", "matches", "seed"), rule("artist", "equals", "Neon")] })).toEqual([]);
  expect(() => parseSmartPlaylistRule(rule("similar_to", "contains", "seed"))).toThrow();
  const hostile = "' OR 1=1 --";
  expect(compileSmartPlaylistRule(rule("similar_to", "matches", hostile)).params).toEqual([hostile]);
  expect(ids(rule("similar_to", "matches", hostile))).toEqual([]);
});

test("song search is bounded, treats wildcards literally and can resolve a saved seed", () => {
  evaluator.replaceCatalog({ degraded: false, items: [
    track("seed", { title: "Night Drive", artistName: "Neon" }), track("literal", { title: "100%_song" }),
    ...Array.from({ length: 20 }, (_, index) => track(`many-${index}`, { title: `Night ${index}` })),
  ] });
  expect(evaluator.findSeeds("Night")).toHaveLength(12);
  expect(evaluator.findSeeds("%_")).toEqual([expect.objectContaining({ id: "literal" })]);
  expect(evaluator.findSeeds("", "seed")).toEqual([expect.objectContaining({ title: "Night Drive", artist: "Neon" })]);
  expect(evaluator.findSeeds("N")).toEqual([]);
});

test("mix size caps the collection and stable ordering makes preview, pagination and save agree", () => {
  evaluator.replaceCatalog({ degraded: false, items: Array.from({ length: 40 }, (_, index) => track(`mix-${index}`, { year: 1985 })) });
  const mix = { size: 25, order: "variety" as const, seed: 42 };
  const rules = rule("year", "equals", 1985);
  const full = evaluator.evaluate("alice", rules, { mix, limit: 100 });
  const first = evaluator.evaluate("alice", rules, { mix, limit: 12 });
  const second = evaluator.evaluate("alice", rules, { mix, offset: 12, limit: 100 });
  expect(full.total).toBe(25); expect(full.available).toBe(40);
  expect([...first.tracks, ...second.tracks].map(item => item.id)).toEqual(full.tracks.map(item => item.id));
  expect(first.selectionToken).toBe(full.selectionToken);
  expect(evaluator.evaluate("alice", rules, { mix, offset: 25 }).tracks).toEqual([]);
  expect(evaluator.evaluate("alice", rules, { mix: { ...mix, seed: 43 }, limit: 100 }).selectionToken).not.toBe(full.selectionToken);
  expect(evaluator.evaluate("alice", rules, { limit: 100 }).total).toBe(40);
});

test("era mixes prefer original release years while retaining normal year comparisons", () => {
  evaluator.replaceCatalog({ degraded: false, items: [track("remaster", { year: 2015, originalReleaseYear: 1984 }),
    track("original", { year: 1987 }), track("modern", { year: 2015 }), track("unknown", { year: null })] });
  expect(ids({ operator: "AND", rules: [rule("era_year", "greater_than", 1979), rule("era_year", "less_than", 1990)] })).toEqual(["original", "remaster"]);
  expect(ids(rule("year", "equals", 2015))).toEqual(["modern", "remaster"]);
});

test("rediscovery prioritises the longest-unheard songs and keeps history and likes personal", () => {
  evaluator.replaceCatalog({ degraded: false, items: [track("old"), track("newer"), track("never"), track("other")] });
  event("old-play", "old", "complete", 100); event("newer-play", "newer", "complete", 40); event("other-play", "other", "complete", 100, "bob");
  db.prepare("INSERT INTO favorites VALUES ('alice','old',?)").run(new Date(now).toISOString());
  const rules = { operator: "AND", rules: [rule("play_count", "greater_than", 0), rule("last_played", "not_in_last_days", 30)] };
  const result = evaluator.evaluate("alice", rules, { mix: { size: 25, order: "rediscover", seed: 1 } });
  expect(result.tracks.map(item => item.id)).toEqual(["old", "newer"]);
  expect(ids({ ...rules, rules: [...rules.rules, rule("is_favorite", "equals", true)] })).toEqual(["old"]);
});
function event(id: string, trackId: string, type: string, daysAgo = 0, userId = "alice") {
  db.prepare(`INSERT INTO listening_events(id,user_id,track_id,event_type,created_at)
    VALUES (?,?,?,?,?)`).run(id, userId, trackId, type, new Date(now - daysAgo * day).toISOString());
}

test("nested AND/OR evaluates typed metadata, booleans, nulls and literal LIKE escaping", () => {
  evaluator.replaceCatalog({ degraded: false, items: [
    track("first", { genres: ["Synthwave", "Electronic"], year: 2020, bpm: 120 }),
    track("second", { genres: ["Jazz"], year: 1960, bpm: null }),
    track("100%_literal", { genres: undefined, year: null }),
  ] });
  expect(ids({ operator: "AND", rules: [
    rule("genre", "contains", "sYnTh"), { operator: "OR", rules: [rule("year", "greater_than", 2018), rule("bpm", "less_than", 90)] },
  ] })).toEqual(["first"]);
  expect(ids(rule("title", "contains", "%_"))).toEqual(["100%_literal"]);
  expect(ids(rule("year", "not_equals", 1960))).toEqual(["first"]);
  expect(ids(rule("bpm", "equals", 120))).toEqual(["first"]);
  expect(ids(rule("genre", "equals", "synthwave"))).toEqual(["first"]);
  expect(ids(rule("genre", "not_equals", "Electronic"))).toEqual(["second"]);
  expect(ids(rule("title", "not_equals", "first"))).toEqual(["100%_literal", "second"]);
  db.prepare("INSERT INTO favorites VALUES ('alice','first',?)").run(new Date(now).toISOString());
  expect(ids(rule("is_favorite", "equals", true))).toEqual(["first"]);
  expect(ids(rule("is_favorite", "equals", true), "bob")).toEqual([]);
  expect(ids(rule("is_favorite", "not_equals", true))).toEqual(["100%_literal", "second"]);
});

test("SQL text never contains user values and hostile/wrongly typed expressions are rejected", () => {
  const injection = "' OR 1=1; DROP TABLE users;--";
  const compiled = compileSmartPlaylistRule(rule("title", "equals", injection));
  expect(compiled.where).not.toContain(injection);
  expect(compiled.params).toEqual([injection]);
  evaluator.replaceCatalog({ degraded: false, items: [track("first")] });
  expect(ids(rule("title", "equals", injection))).toEqual([]);
  for (const invalid of [
    { operator: "AND", rules: [] }, rule("title; DROP TABLE users", "equals", "x"),
    rule("year", "contains", "2018"), rule("year", "equals", "2018"), rule("year", "equals", 2018.5),
    rule("is_favorite", "equals", 1), rule("last_played", "in_last_days", -1),
    rule("last_played", "equals", "yesterday"), rule("title", "equals", ""),
    { operator: "AND", rules: Array.from({ length: 101 }, () => rule("year", "equals", 2020)) },
  ]) expect(() => parseSmartPlaylistRule(invalid)).toThrow(InvalidSmartPlaylistRule);
  let deep: unknown = rule("year", "equals", 2020);
  for (let i = 0; i < 8; i++) deep = { operator: "AND", rules: [deep] };
  expect(() => parseSmartPlaylistRule(deep)).toThrow(/nested/);
  expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(2);
});

test("counts user listens without double-crediting legacy mirrors and sees new events immediately", () => {
  evaluator.replaceCatalog({ degraded: false, items: [track("first"), track("second")] });
  event("play-1", "first", "complete", 31);
  event("skip-1", "second", "skip", 1);
  event("other", "second", "complete", 0, "bob");
  db.prepare("INSERT INTO recently_played(id,user_id,track_id,played_at) VALUES ('legacy','alice','first',?)").run(new Date(now - 31 * day).toISOString());
  expect(ids(rule("play_count", "equals", 1))).toEqual(["first"]);
  expect(ids(rule("skip_count", "greater_than", 0))).toEqual(["second"]);
  event("play-2", "first", "complete");
  expect(ids(rule("play_count", "equals", 2))).toEqual(["first"]);
  expect(ids(rule("play_count", "equals", 1), "bob")).toEqual(["second"]);
  expect(ids(rule("play_count", "less_than", 1), "bob")).toEqual(["first"]);
  expect(ids({ operator: "OR", rules: [
    rule("title", "equals", "first"),
    { operator: "AND", rules: [rule("play_count", "equals", 1), rule("skip_count", "equals", 0)] },
  ] }, "bob")).toEqual(["first", "second"]);
});

test("relative dates include never-played only for not_in_last_days and respect exact cutoff", () => {
  evaluator.replaceCatalog({ degraded: false, items: [track("never"), track("old"), track("recent"), track("boundary")] });
  event("old-event", "old", "complete", 31);
  event("recent-event", "recent", "complete", 1);
  event("boundary-event", "boundary", "complete", 30);
  expect(ids(rule("last_played", "in_last_days", 30))).toEqual(["boundary", "recent"]);
  expect(ids(rule("last_played", "not_in_last_days", 30))).toEqual(["never", "old"]);
  expect(ids(rule("last_played", "less_than", new Date(now - 30 * day).toISOString()))).toEqual(["old"]);
  expect(ids(rule("last_played", "equals", new Date(now - day).toISOString()))).toEqual(["recent"]);
});

test("activity summaries follow heartbeat updates, deletions, legacy pruning and user cascades", () => {
  evaluator.replaceCatalog({ degraded: false, items: [track("first"), track("second")] });
  event("heartbeat", "first", "progress");
  expect(ids(rule("play_count", "equals", 1))).toEqual([]);
  db.prepare("UPDATE listening_events SET event_type='complete',counted=1,listened_seconds=35 WHERE id='heartbeat'").run();
  expect(ids(rule("play_count", "equals", 1))).toEqual(["first"]);
  db.prepare("UPDATE listening_events SET track_id='second' WHERE id='heartbeat'").run();
  expect(ids(rule("play_count", "equals", 1))).toEqual(["second"]);
  db.prepare("DELETE FROM listening_events WHERE id='heartbeat'").run();
  expect(ids(rule("play_count", "equals", 1))).toEqual([]);
  db.prepare("INSERT INTO recently_played(id,user_id,track_id,played_at) VALUES ('recent','alice','first',?)").run(new Date(now).toISOString());
  expect(ids(rule("last_played", "in_last_days", 30))).toEqual(["first"]);
  db.prepare("UPDATE recently_played SET track_id='second' WHERE id='recent'").run();
  expect(ids(rule("last_played", "in_last_days", 30))).toEqual(["second"]);
  db.prepare("DELETE FROM recently_played").run();
  expect(ids(rule("last_played", "in_last_days", 30))).toEqual([]);
  event("skip", "first", "skip");
  db.prepare("DELETE FROM users WHERE id='alice'").run();
  expect(db.prepare("SELECT * FROM smart_playlist_activity WHERE user_id='alice'").all()).toEqual([]);
});

test("migration backfills existing per-user history once and retains triggers on subsequent starts", () => {
  event("legacy-play", "first", "play", 31);
  event("legacy-skip", "second", "skip", 1);
  db.prepare("INSERT INTO recently_played(id,user_id,track_id,played_at) VALUES ('mirror','alice','first',?)").run(new Date(now - 31 * day).toISOString());
  for (const table of ["listening_events", "recently_played"]) {
    for (const operation of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER smart_${table}_${operation}`);
  }
  db.exec(`DROP VIEW taste_listening_events; DROP VIEW taste_recently_played;
    DROP TRIGGER taste_feedback_insert; DROP TRIGGER taste_feedback_update; DROP TRIGGER taste_feedback_delete;
    DROP TABLE taste_private_periods; DROP TABLE taste_track_exclusions; DROP TABLE taste_settings;
    ALTER TABLE playlists DROP COLUMN exclude_from_taste;
    ALTER TABLE listening_events DROP COLUMN taste_excluded; ALTER TABLE listening_events DROP COLUMN context_playlist_id; ALTER TABLE listening_events DROP COLUMN taste_recording_key;
    ALTER TABLE recently_played DROP COLUMN taste_excluded; ALTER TABLE recently_played DROP COLUMN playback_session_id; ALTER TABLE recently_played DROP COLUMN taste_recording_key;
    ALTER TABLE recommendation_feedback DROP COLUMN identity_album;
    DROP TABLE similar_mix_previews; DROP TABLE similar_mix_vectors; DROP TABLE similar_mix_external_tracks;
    ALTER TABLE playlist_items DROP COLUMN external_track_json;
    ALTER TABLE recommendation_feedback DROP COLUMN identity_title; ALTER TABLE recommendation_feedback DROP COLUMN identity_artist;
    DROP TABLE smart_playlist_genres;
    DROP TABLE smart_playlist_track_payloads;
    DROP TABLE smart_playlist_tracks;
    DROP TABLE smart_playlist_activity;
    DROP TABLE smart_playlist_catalog_state;
    DROP TABLE smart_playlists;
    DROP INDEX smart_recent_user_track;
    DELETE FROM schema_migrations WHERE id IN (33,37,42,43);`);
  runMigrations(db);
  runMigrations(db);
  evaluator.replaceCatalog({ degraded: false, items: [track("first"), track("second")] });
  expect(ids(rule("play_count", "equals", 1))).toEqual(["first"]);
  expect(ids(rule("skip_count", "equals", 1))).toEqual(["second"]);
  event("new-play", "first", "complete");
  expect(ids(rule("play_count", "equals", 2))).toEqual(["first"]);
});

test("upgrades the already-applied legacy smart playlist schema without losing mixes or cached tracks", () => {
  const first = track("first", { genres: ["Synthwave", "Electronic"], year: 1985 });
  const second = track("second", { genres: ["Jazz"] });
  evaluator.replaceCatalog({ degraded: false, items: [first, second] });
  event("legacy-play", "first", "play", 31);
  event("legacy-skip", "second", "skip", 1);
  db.prepare("INSERT INTO recently_played(id,user_id,track_id,played_at) VALUES ('mirror','alice','first',?)")
    .run(new Date(now - 31 * day).toISOString());
  db.prepare(`INSERT INTO smart_playlists(id,user_id,name,rules_json,created_at,updated_at,options_json)
    VALUES ('saved-mix','alice','Eighties',?,?,?,?)`).run(
      JSON.stringify(rule("year", "equals", 1985)), new Date(now).toISOString(), new Date(now).toISOString(),
      JSON.stringify({ size: 25, order: "variety", seed: 42 }));
  const saved = db.prepare("SELECT * FROM smart_playlists").all();
  for (const table of ["listening_events", "recently_played"]) {
    for (const operation of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER smart_${table}_${operation}`);
  }
  // The original migration 33 stored JSON inline and had no activity/genre tables.
  db.exec(`DROP TABLE smart_playlist_genres;
    DROP TABLE smart_playlist_track_payloads;
    DROP TABLE smart_playlist_activity;
    DROP TABLE smart_playlist_tracks;
    CREATE TABLE smart_playlist_tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
      genre TEXT, year INTEGER, bpm REAL, track_json TEXT NOT NULL, revision TEXT NOT NULL,
      original_year INTEGER
    );
    CREATE INDEX smart_tracks_year ON smart_playlist_tracks(year);
    DELETE FROM schema_migrations WHERE id=39;`);
  for (const item of [first, second]) db.prepare(`INSERT INTO smart_playlist_tracks
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.title, item.artistName, item.albumName,
      item.genres?.[0], item.year ?? null, null, JSON.stringify(item), "legacy", null);

  runMigrations(db);
  runMigrations(db);

  expect(db.prepare("SELECT * FROM smart_playlists").all()).toEqual(saved);
  expect(db.prepare("PRAGMA table_info(smart_playlist_tracks)").all())
    .not.toContainEqual(expect.objectContaining({ name: "track_json" }));
  expect(evaluator.evaluate("alice", rule("genre", "equals", "Electronic")).tracks).toEqual([first]);
  expect(ids(rule("play_count", "equals", 1))).toEqual(["first"]);
  expect(ids(rule("skip_count", "equals", 1))).toEqual(["second"]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

  // Startup/periodic refresh must work, not fail on the old NOT NULL JSON column.
  evaluator.replaceCatalog({ degraded: false, items: [first] });
  expect(db.prepare("SELECT track_id FROM smart_playlist_track_payloads").all()).toEqual([{ track_id: "first" }]);
  event("new-play", "first", "complete");
  expect(ids(rule("play_count", "equals", 2))).toEqual(["first"]);
  db.prepare("DELETE FROM listening_events WHERE id='new-play'").run();
  expect(ids(rule("play_count", "equals", 1))).toEqual(["first"]);
});

test("forward smart playlist migration also preserves an already-current projection and per-user counts", () => {
  const item = track("current", { genres: ["Electronic", "Synthwave"] });
  evaluator.replaceCatalog({ degraded: false, items: [item] });
  event("play", "current", "complete");
  const state = db.prepare("SELECT * FROM smart_playlist_catalog_state").all();
  const activity = db.prepare("SELECT * FROM smart_playlist_activity").all();
  db.prepare("DELETE FROM schema_migrations WHERE id=39").run();
  runMigrations(db);
  runMigrations(db);
  expect(db.prepare("SELECT * FROM smart_playlist_activity").all()).toEqual(activity);
  expect(db.prepare("SELECT * FROM smart_playlist_catalog_state").all()).toEqual(state);
  expect(evaluator.evaluate("alice", rule("genre", "equals", "Synthwave")).tracks).toEqual([item]);
});

test("catalog replacement removes missing tracks only on a complete snapshot and paginates deterministically", () => {
  const tracks = [track("c"), track("a"), track("b")];
  evaluator.replaceCatalog({ items: tracks, degraded: false });
  const result = evaluator.evaluate("alice", rule("title", "not_equals", "missing"), { limit: 1, offset: 1 });
  expect(result.total).toBe(3);
  expect(result.tracks[0].id).toBe("b");
  evaluator.replaceCatalog({ items: [tracks[0]], degraded: true });
  expect(evaluator.evaluate("alice", rule("title", "not_equals", "missing")).total).toBe(3);
  evaluator.replaceCatalog({ items: [tracks[0]], degraded: false });
  expect(ids(rule("title", "not_equals", "missing"))).toEqual(["c"]);
});

test("a slow periodic refresh cannot replace a newer completed scan snapshot", async () => {
  let publish: (snapshot: CatalogListResult<Track>) => void = () => {};
  let finish: (snapshot: CatalogListResult<Track> & { revision: string }) => void = () => {};
  const unsubscribe = vi.fn();
  const catalog = {
    subscribeTrackSnapshots: (listener: typeof publish) => { publish = listener; return unsubscribe; },
    tracksForWindow: () => new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; }),
  };
  evaluator.connect(catalog, () => {});
  publish({ items: [track("newer")], degraded: false });
  finish({ items: [track("older")], degraded: false, revision: "older" });
  await evaluator.close();
  expect(ids(rule("title", "not_equals", "missing"))).toEqual(["newer"]);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("failed refreshes retain the previous catalog but expose degraded status and log the error", async () => {
  evaluator.replaceCatalog({ items: [track("kept")], degraded: false });
  const error = new Error("Backend unavailable");
  const log = vi.fn();
  evaluator.connect({
    subscribeTrackSnapshots: () => () => {},
    tracksForWindow: async () => { throw error; },
  }, log);
  await evaluator.close();
  expect(log).toHaveBeenCalledWith(error);
  const result = evaluator.evaluate("alice", rule("title", "equals", "kept"));
  expect(result.total).toBe(1);
  expect(result.warning).toContain("unavailable");
});

test("evaluates full SQL count and sample over 20000 tracks and listening rows below 25 ms p95", () => {
  evaluator.replaceCatalog({ degraded: false, items: Array.from({ length: 20_000 }, (_, i) =>
    track(`track-${String(i).padStart(5, "0")}`, { genres: [i % 2 ? "Jazz" : "Synthwave"], year: 2020, bpm: 120 })) });
  db.transaction(() => {
    for (let i = 0; i < 20_000; i++) event(`listen-${i}`, `track-${String(i).padStart(5, "0")}`, "complete", 31);
  })();
  const rules: SmartPlaylistRule = { operator: "AND", rules: [
    { field: "genre", operator: "contains", value: "Synthwave" },
    { field: "year", operator: "greater_than", value: 2018 },
    { field: "play_count", operator: "greater_than", value: 0 },
    { field: "last_played", operator: "not_in_last_days", value: 30 },
  ] };
  const timings = Array.from({ length: 30 }, () => {
    const start = performance.now();
    const result = evaluator.evaluate("alice", rules, { limit: 12 });
    const elapsed = performance.now() - start;
    expect(result.total).toBe(10_000);
    expect(result.tracks).toHaveLength(12);
    return elapsed;
  }).sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * .95) - 1];
  console.info(`Smart playlist SQL: p95=${p95.toFixed(2)}ms max=${timings[timings.length - 1].toFixed(2)}ms`);
  expect(p95).toBeLessThan(25);
  const mixStart = performance.now();
  const mix = evaluator.evaluate("alice", rules, { limit: 12, mix: { size: 50, order: "rediscover", seed: 42 } });
  const mixTime = performance.now() - mixStart;
  expect(mix.total).toBe(50);
  expect(mix.tracks).toHaveLength(12);
  expect(mix.selectionToken).toHaveLength(64);
  console.info(`Guided 20000-track mix: ${mixTime.toFixed(2)}ms`);
});
