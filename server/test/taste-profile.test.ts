import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { TasteProfileManager, tasteRecordingKey, tasteTarget } from "../src/services/TasteProfileManager.js";
import { recordPlayback, type PlaybackEvent } from "../src/domain/listening-activity.js";
import { addRecentlyPlayed } from "../src/domain/recently-played.js";
import { RecommendationEngine } from "../src/services/RecommendationEngine.js";
import { SmartPlaylistEvaluator } from "../src/services/SmartPlaylistEvaluator.js";
import type { Available } from "../src/domain/catalog.js";
import type { SessionUser, Track } from "../src/types.js";

let db: Database.Database, service: TasteProfileManager, evaluator: SmartPlaylistEvaluator, engine: RecommendationEngine;
let now: number;
const track = (id: string, title = id, artist = "Artist"): Available<Track> => ({ id, title, providerId: id, artistName: artist, artistId: `artist-${artist}`, albumName: "Album", albumId: `album-${artist}`,
  streamUrl: "", durationSeconds: 180, artworkId: null, artworkUrl: null, trackNumber: null, genres: ["Ambient"], availability: { libraryAvailable: true, state: "available", playable: true } as any });
const tracks = [track("seed"), track("party", "Party Song", "Party Artist"), track("calm", "Calm", "Calm Artist")];
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); runMigrations(db); now = Date.now();
  db.exec(`INSERT INTO roles VALUES('user','Listener'); INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES('alice','alice','unused','Alice','user','2026','2026'),('bob','bob','unused','Bob','user','2026','2026')`);
  service = new TasteProfileManager(db, () => now); evaluator = new SmartPlaylistEvaluator(db, () => now); evaluator.replaceCatalog({ items: tracks, degraded: false });
  engine = new RecommendationEngine(db, () => now);
  engine.replaceCatalog(tracks);
});
afterEach(() => db.close());
const user = { id: "alice", role: "user" } as SessionUser;
function event(id: string, extra: Partial<PlaybackEvent> = {}): PlaybackEvent {
  return { playbackSessionId: id, trackId: "party", startedAt: new Date(now - 40_000).toISOString(), reportedAt: new Date(now).toISOString(),
    listenedSeconds: 35, durationSeconds: 180, finished: true, track: { title: "Party Song", artist: "Party Artist", album: "Album" }, ...extra };
}
function record(report: PlaybackEvent, owner = "alice", outbox?: (id: string, seconds: number, duration: number | null) => void) {
  const result = recordPlayback(db, owner, report, now, outbox);
  if (result.newlyCounted) addRecentlyPlayed(db, owner, report.trackId, report.startedAt, { excluded: result.tasteExcluded, sessionId: report.playbackSessionId, recordingKey: result.recordingKey });
  return result;
}
const count = (table: string, owner = "alice") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(owner) as { n: number }).n;
function hide(type: string, id: string, title: string, artist: string, album: string | null = null) {
  db.prepare(`INSERT INTO recommendation_feedback(user_id,item_type,item_id,action,weight,created_at,updated_at,identity_title,identity_artist,identity_album)
    VALUES('alice',?,?,'hide',-1,'2026','2026',?,?,?)`).run(type, id, title, artist, album);
}

test("private qualified plays keep history and scrobble callbacks while leaving affinity and recent heuristics unchanged", () => {
  const before = engine.select("alice", "seed").map(row => [row.track.id, row.score]);
  service.setPrivate("alice", true, service.state("alice").revision);
  const outbox = vi.fn(), report = event("private-session");
  const result = record(report, "alice", outbox);
  expect(result).toMatchObject({ counted: true, scrobbleDue: true, tasteExcluded: true }); expect(outbox).toHaveBeenCalled();
  expect(count("listening_events")).toBe(1); expect(count("recently_played")).toBe(1);
  expect(count("taste_listening_events")).toBe(0); expect(count("taste_recently_played")).toBe(0);
  expect(engine.select("alice", "seed").map(row => [row.track.id, row.score])).toEqual(before);
  expect(service.canUseProviderHistory("alice")).toBe(false);
  expect(db.prepare("SELECT plays,recent_plays FROM smart_playlist_activity WHERE user_id='alice' AND track_id='party'").get()).toEqual({ plays: 0, recent_plays: 0 });
});

test("mid-session privacy retracts already counted affinity and cannot be undone by older reports or turning privacy off", () => {
  const startedAt = new Date(now - 100_000).toISOString(), initial = event("ongoing-session", { startedAt, finished: false }); record(initial);
  expect(count("taste_listening_events")).toBe(1);
  now += 1000; service.setPrivate("alice", true, service.state("alice").revision); expect(count("taste_listening_events")).toBe(0); expect(count("taste_recently_played")).toBe(0);
  now += 1000; service.setPrivate("alice", false, service.state("alice").revision);
  record({ ...initial, listenedSeconds: 5, privateListening: false, reportedAt: new Date(now).toISOString() });
  expect(count("taste_listening_events")).toBe(0);
  now += 50_000; record(event("public-new-session", { startedAt: new Date(now - 40_000).toISOString() }));
  expect(count("taste_listening_events")).toBe(1);
});

test("delayed offline reports retain their captured privacy and correct historical policy interval", () => {
  service.setPrivate("alice", true, 0); now += 60_000; service.setPrivate("alice", false, service.state("alice").revision);
  const snapshot = event("offline-session", { startedAt: new Date(now - 55_000).toISOString(), reportedAt: new Date(now - 10_000).toISOString(), privateListening: true });
  now += 100_000; expect(record(snapshot).tasteExcluded).toBe(true);
  const earlier = event("earlier-public", { startedAt: new Date(now - 300_000).toISOString(), reportedAt: new Date(now - 250_000).toISOString(), privateListening: false });
  expect(record(earlier).tasteExcluded).toBe(false);
});

test("active server privacy cannot be bypassed by backdating a client report", () => {
  service.setPrivate("alice", true, 0);
  const earlier = event("delayed-public-before-private", { startedAt: new Date(now - 60_000).toISOString(), reportedAt: new Date(now - 10_000).toISOString(), privateListening: false });
  expect(record(earlier).tasteExcluded).toBe(true);
  expect(record(event("overlapping-private-session")).tasteExcluded).toBe(true);
});

test("playlist exclusions apply only to that origin, retain history and respect ownership", () => {
  db.exec("INSERT INTO playlists(id,owner_user_id,name,created_at,updated_at) VALUES('party-list','alice','Party','2026','2026')");
  service.setPlaylist(user, "party-list", true);
  expect(record(event("playlist-session", { playlistId: "party-list" })).tasteExcluded).toBe(true);
  expect(record(event("direct-session")).tasteExcluded).toBe(false);
  expect(count("listening_events")).toBe(2); expect(count("taste_listening_events")).toBe(1);
  expect(() => service.setPlaylist({ id: "bob", role: "user" } as SessionUser, "party-list", false)).toThrow("not editable");
  service.setPlaylist(user, "party-list", false); expect(db.prepare("SELECT exclude_from_taste FROM playlists WHERE id='party-list'").get()).toEqual({ exclude_from_taste: 0 });
});

test("reset clears all recommendation counts but preserves history, favorites, playlists and explicit feedback", () => {
  record(event("public-before-reset")); db.exec("INSERT INTO favorites VALUES('alice','party','2026'); INSERT INTO playlists(id,owner_user_id,name,created_at,updated_at) VALUES('saved','alice','Saved','2026','2026')");
  hide("track", "calm", "Calm", "Calm Artist"); const old = event("late-pre-reset"); now += 5000;
  service.reset("alice", service.state("alice").revision);
  expect(count("taste_listening_events")).toBe(0); expect(count("taste_recently_played")).toBe(0); expect(count("listening_events")).toBe(1);
  expect(count("favorites")).toBe(1); expect(count("recommendation_feedback")).toBe(1); expect(db.prepare("SELECT id FROM playlists WHERE id='saved'").get()).toBeTruthy();
  expect(record(old).tasteExcluded).toBe(true);
  now += 50_000; expect(record(event("after-reset")).tasteExcluded).toBe(false); expect(count("taste_listening_events")).toBe(1);
});

test("canonical track, artist and album feedback matches external aliases and restores all negative aliases together", () => {
  hide("track", "external_deezer_track_1", "Party Song", "Party Artist"); hide("track", "external_itunes_track_2", "Party Song", "Party Artist");
  let allowed = service.feedbackFilter("alice"); expect(allowed(tasteTarget(tracks[1]))).toBe(false);
  expect(service.hidden("alice")[0]).toMatchObject({ title: "Party Song", aliases: 2 });
  service.restore("alice", "track", "external_deezer_track_1"); expect(count("recommendation_feedback")).toBe(0);
  hide("artist", "external_artist_other", "wrong track title", "Party Artist");
  allowed = service.feedbackFilter("alice"); expect(allowed(tasteTarget(tracks[1]))).toBe(false); expect(service.hidden("alice")[0].title).toBe("Party Artist");
  service.restore("alice", "artist", "external_artist_other");
  hide("album", "other-provider-album", "Album", "Party Artist", "Album"); expect(service.feedbackFilter("alice")(tasteTarget(tracks[1]))).toBe(false);
  expect(service.feedbackFilter("bob")(tasteTarget(tracks[1]))).toBe(true);
});

test("song exclusions affect activity rather than candidate availability and do not erase explicit favorites", () => {
  record(event("eligible-before-exclusion")); service.setTrack("alice", { id: "party" }, true);
  expect(count("taste_listening_events")).toBe(0); expect(service.feedbackFilter("alice")(tasteTarget(tracks[1]))).toBe(true);
  now += 1000; expect(record(event("excluded-recording")).tasteExcluded).toBe(true);
  service.setTrack("alice", { id: "party" }, false); expect(count("taste_listening_events")).toBe(1);
  const alias = { ...tracks[1], id: "other-track" }; service.setTrack("alice", tasteTarget(tracks[1]), true);
  expect(service.decision("alice", { trackId: alias.id, startedAt: new Date(now).toISOString(), track: { title: alias.title, artist: alias.artistName } }).excluded).toBe(true);
  expect(tasteRecordingKey("Party Song", "Party Artist")).toBe(tasteRecordingKey("party song", "party artist"));
});

test("preferences, exclusions and history flags survive serialization to a new SQLite connection without crossing accounts", () => {
  service.setPrivate("alice", true, 0); record(event("persistent-private")); record(event("bob-public"), "bob");
  const reopened = new Database(db.serialize());
  try {
    const restored = new TasteProfileManager(reopened, () => now); expect(restored.state("alice").privateListening).toBe(true); expect(restored.state("bob").privateListening).toBe(false);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM taste_listening_events WHERE user_id='alice'").get()).toEqual({ n: 0 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM taste_listening_events WHERE user_id='bob'").get()).toEqual({ n: 1 });
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
  } finally { reopened.close(); }
});
