import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { runMigrations } from "../src/db/migrations.js";
import { listeningHistory, listeningStatistics, recordPlayback, type PlaybackEvent } from "../src/domain/listening-activity.js";

let current: Awaited<ReturnType<typeof createTestServer>>;
let cookie: string;
let listenerCookie: string;
let adminId: string;
const now = Date.parse("2026-10-08T12:00:00Z");
const event = (id = "session-00000001", trackId = "track-1", seconds = 30): PlaybackEvent => ({
  playbackSessionId: id, trackId, startedAt: new Date(now - 180_000).toISOString(),
  listenedSeconds: seconds, durationSeconds: 180, finished: false,
  track: { title: "Night Music", artist: "Test Artist", album: "First Album",
    artistId: "artist-1", albumId: "album-1", coverArt: "cover-1" },
});

beforeAll(async () => {
  current = await createTestServer();
  const admin = await login(current.app);
  if (!admin.cookie) throw new Error("Admin login failed");
  cookie = admin.cookie;
  await createUser(current.db, { username: "listener", password: "listener-password", role: "user" });
  const listener = await login(current.app, "listener", "listener-password");
  if (!listener.cookie) throw new Error("Listener login failed");
  listenerCookie = listener.cookie;
  adminId = (current.db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
});
beforeEach(() => {
  current.db.exec("DELETE FROM listening_events; DELETE FROM recently_played; DELETE FROM server_settings WHERE key = 'listening.thresholdSeconds'");
});
afterAll(async () => { await closeTestServer(current.app, current.db); });

describe("persistent playback sessions", () => {
  test("start and short listens are not counted; cumulative actual time is counted at 30 seconds", () => {
    expect(recordPlayback(current.db, adminId, event(undefined, undefined, 0), now).counted).toBe(false);
    expect(recordPlayback(current.db, adminId, event(undefined, undefined, 29), now).counted).toBe(false);
    expect(recordPlayback(current.db, adminId, event(), now)).toMatchObject({ counted: true, newlyCounted: true });
    expect(recordPlayback(current.db, adminId, event(undefined, undefined, 60), now)).toMatchObject({ listenedSeconds: 60, newlyCounted: false });
    expect(listeningStatistics(current.db, adminId, "all", now).overview).toMatchObject({ plays: 1, listeningSeconds: 60 });
  });

  test("duplicate and out-of-order reports do not double-count or reduce duration", () => {
    recordPlayback(current.db, adminId, event(undefined, undefined, 60), now);
    recordPlayback(current.db, adminId, event(), now);
    recordPlayback(current.db, adminId, { ...event(undefined, undefined, 60), finished: true }, now);
    const stats = listeningStatistics(current.db, adminId, "all", now);
    expect(stats.overview).toMatchObject({ plays: 1, listeningSeconds: 60, uniqueSongs: 1 });
  });

  test("short tracks require their full duration and do not qualify on start", () => {
    expect(recordPlayback(current.db, adminId, { ...event(undefined, undefined, 8), durationSeconds: 12 }, now).counted).toBe(false);
    expect(recordPlayback(current.db, adminId, { ...event(undefined, undefined, 12), durationSeconds: 12 }, now).counted).toBe(true);
  });

  test("authoritative media duration can correct initial metadata without discarding seconds", () => {
    recordPlayback(current.db, adminId, event(undefined, undefined, 8), now);
    expect(recordPlayback(current.db, adminId, { ...event(undefined, undefined, 12), durationSeconds: 12 }, now))
      .toMatchObject({ counted: true, listenedSeconds: 12 });
  });

  test("unknown artist and album placeholders do not count as real distinct identities", () => {
    recordPlayback(current.db, adminId, {
      ...event(), track: { title: "Unlabeled song", artist: "Unknown artist", album: "Unknown album" },
    }, now);
    expect(listeningStatistics(current.db, adminId, "all", now).overview)
      .toMatchObject({ plays: 1, uniqueSongs: 1, uniqueArtists: 0, uniqueAlbums: 0 });
  });

  test("threshold is configurable and cumulative time is bounded by session elapsed time", () => {
    current.db.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES (?,?,?)")
      .run("listening.thresholdSeconds", "45", new Date(now).toISOString());
    expect(recordPlayback(current.db, adminId, event(), now).counted).toBe(false);
    expect(recordPlayback(current.db, adminId, event(undefined, undefined, 45), now).counted).toBe(true);
    expect(recordPlayback(current.db, adminId, { ...event("session-00000002", "track-2", 200), startedAt: new Date(now - 1000).toISOString() }, now))
      .toMatchObject({ listenedSeconds: 1, counted: false });
  });

  test("same track repeated in a new session is a separate listen", async () => {
    recordPlayback(current.db, adminId, event(), now);
    recordPlayback(current.db, adminId, event("session-00000002"), now);
    const history = await listeningHistory(current.db, current.catalog, adminId, { period: "all", search: "", limit: 30 }, now);
    expect(history.items).toHaveLength(2);
    expect(new Set(history.items.map((item) => item.id)).size).toBe(2);
    expect(listeningStatistics(current.db, adminId, "all", now).overview).toMatchObject({ plays: 2, uniqueSongs: 1 });
  });

  test("a session cannot be repurposed for another track or timestamp", () => {
    recordPlayback(current.db, adminId, event(), now);
    expect(() => recordPlayback(current.db, adminId, event(undefined, "track-2"), now)).toThrow("cannot be reused");
    expect(() => recordPlayback(current.db, adminId, { ...event(), startedAt: new Date(now + 10_000).toISOString() }, now)).toThrow("timestamp");
  });
});

describe("history and analytics", () => {
  test("keyset pagination preserves repeated events and has no page-boundary duplicates", async () => {
    for (let index = 0; index < 65; index++) recordPlayback(current.db, adminId, event(`session-${String(index).padStart(8, "0")}`), now);
    const first = await listeningHistory(current.db, current.catalog, adminId, { period: "all", search: "", limit: 30 }, now);
    const second = await listeningHistory(current.db, current.catalog, adminId, {
      period: "all", search: "", limit: 30, cursor: JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()),
    }, now);
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(30);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(60);
  });

  test("search covers song, artist and album; SQL wildcards are literal", async () => {
    recordPlayback(current.db, adminId, event(), now);
    for (const search of ["Night", "Artist", "Album"]) {
      expect((await listeningHistory(current.db, current.catalog, adminId, { period: "all", search, limit: 30 }, now)).items).toHaveLength(1);
    }
    expect((await listeningHistory(current.db, current.catalog, adminId, { period: "all", search: "%", limit: 30 }, now)).items).toHaveLength(0);
  });

  test("statistics count real durations, repeats and distinct metadata identities", () => {
    recordPlayback(current.db, adminId, event(), now);
    recordPlayback(current.db, adminId, event("session-00000002", "track-1", 60), now);
    recordPlayback(current.db, adminId, { ...event("session-00000003", "track-2", 45),
      track: { title: "New Song", artist: "Another Artist", artistId: "artist-2", album: "Second Album", albumId: "album-2" } }, now);
    recordPlayback(current.db, adminId, event("session-00000004", "track-3", 5), now);
    const stats = listeningStatistics(current.db, adminId, "all", now);
    expect(stats.overview).toMatchObject({ listeningSeconds: 140, plays: 3, uniqueSongs: 2, uniqueArtists: 2, uniqueAlbums: 2 });
    expect(stats.topSongs[0]).toMatchObject({ key: "track-1", plays: 2, listeningSeconds: 90 });
    expect(stats.daily).toEqual([expect.objectContaining({ bucket: "2026-10-08", listeningSeconds: 140, plays: 3 })]);
    expect(stats.hourly).toEqual([expect.objectContaining({ bucket: "11", listeningSeconds: 140 })]);
  });

  test("periods exclude older events, including previous calendar years", () => {
    const old = Date.parse("2025-01-01T12:00:00Z");
    recordPlayback(current.db, adminId, { ...event(), startedAt: new Date(old - 180_000).toISOString() }, old);
    expect(listeningStatistics(current.db, adminId, "all", now).overview).toMatchObject({ plays: 1 });
    for (const period of ["7", "30", "90", "year"] as const) {
      expect(listeningStatistics(current.db, adminId, period, now).overview).toMatchObject({ plays: 0, listeningSeconds: 0 });
    }
  });

  test("snapshots keep deleted tracks visible without consulting a music provider", async () => {
    recordPlayback(current.db, adminId, event(undefined, "deleted-track"), now);
    const history = await listeningHistory(current.db, current.catalog, adminId, { period: "all", search: "", limit: 30 }, now);
    expect(history.items[0].track).toMatchObject({ id: "deleted-track", title: "Night Music", artist: "Test Artist" });
  });
});

describe("authenticated API", () => {
  test("all activity reads and playback writes require authentication", async () => {
    for (const url of ["/api/listening-activity/history", "/api/listening-activity/statistics", "/api/listening-activity/config"]) {
      expect((await current.app.inject({ url })).statusCode).toBe(401);
    }
    expect((await current.app.inject({ method: "POST", url: "/api/listening-events", payload: event() })).statusCode).toBe(401);
  });

  test("user identity comes from the session, not supplied IDs; recent and full history share events", async () => {
    const payload = { ...event(), startedAt: new Date(Date.now() - 180_000).toISOString(), userId: "forged" };
    const response = await current.app.inject({ method: "POST", url: "/api/listening-events", headers: { cookie }, payload });
    expect(response.statusCode).toBe(200);
    for (const url of ["/api/listening-activity/history", "/api/listening-activity/statistics", "/api/recently-played"]) {
      const admin = await current.app.inject({ url, headers: { cookie } });
      const listener = await current.app.inject({ url, headers: { cookie: listenerCookie } });
      expect(admin.statusCode).toBe(200);
      expect(listener.statusCode).toBe(200);
      if (url.endsWith("history")) { expect(admin.json().items).toHaveLength(1); expect(listener.json().items).toEqual([]); }
      if (url.endsWith("statistics")) { expect(admin.json().overview.plays).toBe(1); expect(listener.json().overview.plays || 0).toBe(0); }
      if (url.endsWith("recently-played")) { expect(admin.json().tracks).toHaveLength(1); expect(listener.json().tracks).toEqual([]); }
    }
    expect((await current.app.inject({ method: "POST", url: "/api/listening-events", headers: { cookie }, payload })).json().newlyCounted).toBe(false);
  });

  test("invalid reports, period, cursor and pagination limit return explicit 400 errors", async () => {
    for (const url of ["/api/listening-activity/history?cursor=broken", "/api/listening-activity/history?limit=1000", "/api/listening-activity/statistics?period=bad"]) {
      expect((await current.app.inject({ url, headers: { cookie } })).statusCode).toBe(400);
    }
    expect((await current.app.inject({ method: "POST", url: "/api/listening-events", headers: { cookie },
      payload: { ...event(), listenedSeconds: -1 } })).statusCode).toBe(400);
  });

  test("queued reports cannot cross accounts during a logout/login race", async () => {
    const response = await current.app.inject({
      method: "POST", url: "/api/listening-events", headers: { cookie: listenerCookie },
      payload: { ...event(), ownerUserId: adminId, startedAt: new Date(Date.now() - 180_000).toISOString() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("USER_MISMATCH");
    expect(current.db.prepare("SELECT COUNT(*) AS count FROM listening_events").get()).toEqual({ count: 0 });
  });
});

test("migration preserves legacy plays without inventing durations or duplicating recent mirrors", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
      CREATE TABLE listening_events(id TEXT PRIMARY KEY,user_id TEXT,track_id TEXT,event_type TEXT,completion_ratio REAL,created_at TEXT);
      CREATE TABLE recently_played(id TEXT PRIMARY KEY,user_id TEXT,track_id TEXT,played_at TEXT);
      INSERT INTO listening_events VALUES ('old','u','t','complete',1,'2026-10-01T12:00:00.000Z');
      INSERT INTO recently_played VALUES ('mirror','u','t','2026-10-01T12:00:01.000Z'),('unmirrored','u','t2','2026-09-01T12:00:00.000Z');`);
    const insert = db.prepare("INSERT INTO schema_migrations VALUES (?, 'existing', '')");
    for (let id = 1; id <= 24; id++) insert.run(id);
    runMigrations(db);
    const rows = db.prepare("SELECT counted,listened_seconds FROM listening_events").all();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([expect.objectContaining({ counted: 1, listened_seconds: null }), expect.objectContaining({ counted: 1, listened_seconds: null })]);
  } finally { db.close(); }
});

test("history and exact listening seconds survive reopening the SQLite database", async () => {
  const first = await createTestServer();
  let second: Awaited<ReturnType<typeof createTestServer>> | undefined;
  let firstClosed = false;
  try {
    const user = first.db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    recordPlayback(first.db, user.id, event(undefined, undefined, 42), now);
    await closeTestServer(first.app, first.db);
    firstClosed = true;
    second = await createTestServer(undefined, { databasePath: path.join(first.directory, "musicdeck.sqlite") });
    expect(listeningStatistics(second.db, user.id, "all", now).overview).toMatchObject({ plays: 1, listeningSeconds: 42 });
    const history = await listeningHistory(second.db, second.catalog, user.id, { period: "all", search: "", limit: 30 }, now);
    expect(history.items[0]).toMatchObject({ listenedSeconds: 42, track: { title: "Night Music" } });
  } finally {
    if (!firstClosed) await closeTestServer(first.app, first.db);
    if (second) await closeTestServer(second.app, second.db);
    fs.rmSync(first.directory, { recursive: true, force: true });
    if (second) fs.rmSync(second.directory, { recursive: true, force: true });
  }
});
