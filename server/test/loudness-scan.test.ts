import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { LoudnessScanService } from "../src/services/media/loudnessScanService.js";
import { LoudnessService, playbackIdentity } from "../src/services/media/loudnessService.js";
import type { CatalogService } from "../src/domain/catalog.js";
import type { SourceResolver } from "../src/domain/source-resolver.js";
import { LibraryService } from "../src/domain/library.js";
import type { SourceProviderRegistry } from "../src/domain/source-provider-registry.js";
import { registerLoudnessRoutes } from "../src/routes/loudness-routes.js";
import { registerSettingsRoutes } from "../src/routes/settings-routes.js";
import { createSession } from "../src/auth/sessions.js";

let db: Database.Database;
let scan: LoudnessScanService;
let loudness: LoudnessService;
let directory: string;
const measurement = JSON.stringify({ input_i: "-10", input_tp: "-1", input_lra: "2", input_thresh: "-20", target_offset: "0", output_i: "-16", output_tp: "-7" });
const stream = () => ({ status: 200, headers: new Headers(), body: new ReadableStream({ start(c) { c.enqueue(Buffer.from("fixture")); c.close(); } }) });
beforeEach(async () => {
  db = new Database(":memory:"); runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('user', 'User'), ('admin', 'Admin')").run();
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musicdeck-scan-"));
  for (const user of ["first", "second"]) db.prepare("INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, 'unused', ?, ?, '', '')").run(user, user, user, user === "first" ? "admin" : "user");
});
afterEach(async () => {
  await Promise.all([scan?.close(), loudness?.close()]);
  db.close(); await fs.promises.rm(directory, { recursive: true, force: true });
});

function fixture(ids: string[], analyze?: (id: string) => Promise<{ measured: boolean; reused: boolean }>) {
  const base = Promise.resolve({ title: "Song", artistName: "Artist", albumName: "Album", durationSeconds: 180,
    providerId: "track", albumId: null, artistId: null, trackNumber: 1, artworkId: null, artworkUrl: null, streamUrl: "/stream" });
  const catalog = {
    listTracks: vi.fn(async () => ({ items: await Promise.all(ids.map(async id => ({ ...(await base), id }))), degraded: false })),
    getTrack: vi.fn(async (id: string) => ({ ...(await base), id })),
  } as unknown as CatalogService;
  for (const id of ids) db.prepare("INSERT OR IGNORE INTO library_items(id,type,created_at,updated_at) VALUES (?, 'track', '', '')").run(id);
  const analyzer = {
    trackLoudness: vi.fn(() => undefined),
    analyzeTrack: vi.fn(async (identity: string) => analyze ? analyze(JSON.parse(identity)[0]) : { measured: true, reused: false }),
  } as unknown as LoudnessService;
  scan = new LoudnessScanService(db, catalog, { fetchStream: vi.fn() } as unknown as SourceResolver, analyzer);
  return { catalog, analyzer };
}

it("prioritizes the requesting user's history, then playlists, then other tracks; accounts for failures", async () => {
  const order: string[] = [];
  const { analyzer } = fixture(["other", "playlist", "heard", "broken"], async id => {
    order.push(id); return { measured: id !== "broken", reused: id === "playlist" };
  });
  db.prepare("INSERT INTO recently_played (id, user_id, track_id, played_at) VALUES ('recent', 'first', 'heard', '')").run();
  db.prepare("INSERT INTO recently_played (id, user_id, track_id, played_at) VALUES ('other-recent', 'second', 'other', '')").run();
  db.prepare("INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at) VALUES ('list', 'first', 'List', '', '')").run();
  for (const id of ["one", "duplicate"]) db.prepare("INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, created_at, library_track_id) VALUES (?, 'list', 0, 'connection', 'native', '', 'playlist')").run(id);
  const job = scan.start("first");
  expect(scan.start("first").id).toBe(job.id);
  await vi.waitFor(() => expect(scan.status()?.status).toBe("completed"));
  expect(order).toEqual(["heard", "playlist", "broken", "other"]);
  expect(scan.status()).toMatchObject({ totalTracks: 4, completedTracks: 3, skippedTracks: 1, failedTracks: 1 });
  expect(analyzer.analyzeTrack).toHaveBeenCalledTimes(4);
});

it("scopes a member scan to distinct tracks in their active playlists and keeps its status private", async () => {
  const { catalog } = fixture(["owned", "other", "trash", "heard"]);
  const playlist = db.prepare("INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at, deleted_at) VALUES (?, ?, 'List', '', '', ?)");
  playlist.run("mine", "second", null);
  playlist.run("theirs", "first", null);
  playlist.run("trashed", "second", "2026-01-01");
  const item = db.prepare("INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, created_at, library_track_id) VALUES (?, ?, 0, 'source', 'native', '', ?)");
  item.run("one", "mine", "owned");
  item.run("duplicate", "mine", "owned");
  item.run("two", "theirs", "other");
  item.run("three", "trashed", "trash");
  db.prepare("INSERT INTO recently_played (id, user_id, track_id, played_at) VALUES ('recent', 'second', 'heard', '')").run();
  scan.start("second");
  await vi.waitFor(() => expect(scan.status("second")).toMatchObject({ status: "completed", totalTracks: 1, completedTracks: 1 }));
  expect(catalog.listTracks).not.toHaveBeenCalled();
  expect(vi.mocked(catalog.getTrack).mock.calls).toEqual([["owned"]]);
  db.prepare("UPDATE users SET role='user' WHERE id='first'").run();
  expect(scan.status("first")).toBeNull();
});

it("checkpoints a stopped scan and resumes pending tracks without recounting completed ones", async () => {
  let release!: () => void;
  const order: string[] = [];
  const { catalog, analyzer } = fixture(["a", "b", "c"], async id => {
    order.push(id);
    if (id === "b") await new Promise<void>(resolve => { release = resolve; });
    return { measured: true, reused: false };
  });
  const id = scan.start("first").id;
  await vi.waitFor(() => expect(release).toBeDefined());
  const closing = scan.close(); release(); await closing;
  expect(scan.status()).toMatchObject({ status: "running", completedTracks: 1 });
  vi.mocked(analyzer.analyzeTrack).mockResolvedValue({ measured: true, reused: true });
  scan = new LoudnessScanService(db, catalog, {} as SourceResolver, analyzer);
  scan.resume();
  await vi.waitFor(() => expect(scan.status()).toMatchObject({ id, status: "completed", completedTracks: 3, skippedTracks: 2 }));
  expect(catalog.listTracks).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["a", "b"]);
  expect(analyzer.analyzeTrack).toHaveBeenCalledTimes(4);
});

it("reuses valid measurements and continues after a track lookup fails", async () => {
  const { catalog, analyzer } = fixture(["cached", "gone", "new"]);
  vi.mocked(analyzer.trackLoudness).mockImplementation(track => track.id === "cached" ? { integratedLufs: -10, truePeakDb: -1, gainDb: -6 } : undefined);
  vi.mocked(catalog.getTrack).mockImplementation(async id => id === "gone" ? null : { id } as any);
  scan.start("first");
  await vi.waitFor(() => expect(scan.status()?.status).toBe("completed"));
  expect(scan.status()).toMatchObject({ completedTracks: 2, skippedTracks: 1, failedTracks: 1 });
  expect(analyzer.analyzeTrack).toHaveBeenCalledTimes(1);
});

it("analyses once without rendering and shares measurements across per-user targets", async () => {
  const runner = { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: measurement }), kill() {} })) };
  loudness = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "configured", processRunner: runner });
  const load = vi.fn(async () => stream());
  expect(await loudness.analyzeTrack(playbackIdentity("song", null), load)).toEqual({ measured: true, reused: false });
  expect(await loudness.analyzeTrack(playbackIdentity("song", null), load)).toEqual({ measured: true, reused: true });
  expect(runner.run).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT * FROM playback_loudness_cache").all()).toHaveLength(0);
  const stats = loudness.trackLoudness({ id: "song" } as any)!;
  expect(stats).toEqual({ integratedLufs: -10, truePeakDb: -1, gainDb: -6 });

  const app = Fastify(); await app.register(cookie);
  await registerSettingsRoutes(app, db);
  const { catalog } = fixture(["song"]);
  vi.mocked(catalog.getTrack).mockResolvedValue({ id: "song", loudness: stats } as any);
  await registerLoudnessRoutes(app, db, Object.assign(new LibraryService(db), { exists: () => true }), {} as SourceResolver, {} as SourceProviderRegistry, loudness, { scan, catalog });
  try {
    for (const [user, target, gain] of [["first", -18, -8], ["second", -14, -4]] as const) {
      const headers = { cookie: `musicdeck_session=${createSession(db, user).id}` };
      const saved = await app.inject({ method: "PATCH", url: "/api/settings/user", headers, payload: { settings: { "playback.normalization.targetLufs": target } } });
      expect(saved.statusCode).toBe(200);
      const result = await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "song", background: true } });
      expect(result.json()).toMatchObject({ status: "measured", gainDb: gain });
      expect((await app.inject({ method: "PATCH", url: "/api/settings/user", headers, payload: { settings: { "playback.normalization.targetLufs": 14 } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "song", targetLufs: -100 } })).statusCode).toBe(400);
    }
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: "/api/playback/loudness-scan" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/playback/loudness-scan", payload: {} })).statusCode).toBe(401);
    const headers = { cookie: `musicdeck_session=${createSession(db, "first").id}` };
    expect((await app.inject({ method: "POST", url: "/api/playback/loudness-scan", headers, payload: { url: "http://localhost/secret" } })).statusCode).toBe(400);
    const started = await app.inject({ method: "POST", url: "/api/playback/loudness-scan", headers, payload: {} });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(() => expect(scan.status()?.status).toBe("completed"));
    expect((await app.inject({ url: "/api/playback/loudness-scan", headers })).json().scan.id).toBe(started.json().scan.id);
  } finally { await app.close(); }
});
