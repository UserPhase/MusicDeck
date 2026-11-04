import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { SilenceScanService } from "../src/services/media/silenceScanService.js";
import { SilenceAnalysisService } from "../src/domain/silence-analysis.js";
import { ScanParametersConflict } from "../src/services/media/libraryAnalysisScanService.js";
import { registerSilenceScanRoutes } from "../src/routes/silence-scan-routes.js";
import { createSession } from "../src/auth/sessions.js";
import type { CatalogService } from "../src/domain/catalog.js";
import type { SourceResolver } from "../src/domain/source-resolver.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
import type { Track } from "../src/types.js";

let db: Database.Database;
let directory: string;
let scan: SilenceScanService | undefined;
let analysis: SilenceAnalysisService | undefined;
const defaults = { thresholdDb: -35, minSilenceSeconds: 0.5 };
const stderr = "Duration: 00:03:00.00\nsilence_start: 0\nsilence_end: 1\nsilence_start: 179\nsilence_end: 180";
beforeEach(async () => {
  db = new Database(":memory:"); runMigrations(db);
  db.prepare("INSERT INTO roles (name, description) VALUES ('admin', 'Admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at) VALUES ('listener', 'listener', 'unused', 'Listener', 'admin', '', '')").run();
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musicdeck-silence-scan-test-"));
  scan = undefined; analysis = undefined;
});
afterEach(async () => {
  await Promise.all([scan?.close(), analysis?.close()]);
  db.close(); await fs.promises.rm(directory, { recursive: true, force: true });
});
function catalog(ids: string[]): CatalogService {
  for (const id of ids) db.prepare("INSERT OR IGNORE INTO library_items(id,type,created_at,updated_at) VALUES (?, 'track', '', '')").run(id);
  const tracks = ids.map(id => ({ id, title: id, artistName: "Artist" } as Track));
  return { listTracks: vi.fn(async () => ({ items: tracks, degraded: false })),
    getTrack: vi.fn(async id => tracks.find(t => t.id === id) ?? null) } as unknown as CatalogService;
}
function analyzer(failId?: string) {
  const order: string[] = [];
  const resolver = { fetchStream: vi.fn(async (id: string) => {
    order.push(id);
    if (id === failId) throw new Error("Unavailable source");
    return { status: 200, headers: new Headers(), body: new ReadableStream({ start(c) { c.enqueue(Buffer.from("original")); c.close(); } }) };
  }) } as unknown as SourceResolver;
  const runner: ProcessRunner = { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 0, stdout: "", stderr }), kill() {} })) };
  analysis = new SilenceAnalysisService(db, resolver, { tmpDir: directory, getFFmpegPath: () => "configured-ffmpeg", processRunner: runner });
  return { resolver, runner, order };
}

it("uses heard/playlist priority, skips matching results, counts errors and allows retries", async () => {
  const library = catalog(["other", "playlist", "heard", "cached", "broken"]);
  const { order, runner } = analyzer("broken");
  await analysis!.analyzeTrack("cached", defaults); order.length = 0;
  db.prepare("INSERT INTO recently_played (id, user_id, track_id, played_at) VALUES ('played', 'listener', 'heard', '')").run();
  db.prepare("INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at) VALUES ('playlist', 'listener', 'Playlist', '', '')").run();
  db.prepare("INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at) VALUES ('entry', 'playlist', 0, 'source', 'provider', 'playlist', '')").run();
  scan = new SilenceScanService(db, library, analysis!);
  const first = scan.start("listener", defaults);
  expect(scan.start("listener", defaults).id).toBe(first.id);
  await vi.waitFor(() => expect(scan!.status()?.status).toBe("completed"));
  expect(order).toEqual(["heard", "playlist", "broken", "other"]);
  expect(scan.status()).toMatchObject({ totalTracks: 5, completedTracks: 4, skippedTracks: 1, failedTracks: 1, parameters: defaults });
  expect(runner.run).toHaveBeenCalledTimes(4);
  expect(vi.mocked(runner.run).mock.calls[0][0]).toBe("configured-ffmpeg");
  expect(await fs.promises.readdir(directory)).toEqual([]);
  const next = scan.start("listener", defaults);
  expect(next.id).not.toBe(first.id);
  await vi.waitFor(() => expect(scan!.status()).toMatchObject({ id: next.id, status: "completed", skippedTracks: 4, failedTracks: 1 }));
});

it("keeps separate results for different silence settings and invalidates a changed track", async () => {
  catalog(["song"]);
  const { runner } = analyzer();
  await analysis!.analyzeTrack("song", defaults);
  const different = { thresholdDb: -28, minSilenceSeconds: 1 };
  expect(analysis!.getAnalysis("song", different)).toBeNull();
  await analysis!.analyzeTrack("song", different);
  expect(analysis!.getAnalysis("song", defaults)).toMatchObject({ status: "completed", ...defaults });
  expect(analysis!.getAnalysis("song", different)).toMatchObject({ status: "completed", ...different });
  expect(runner.run).toHaveBeenCalledTimes(2);
  db.prepare("UPDATE library_items SET content_revision = 'changed' WHERE id = 'song'").run();
  expect(analysis!.getAnalysis("song", defaults)).toBeNull();
});

it("deduplicates simultaneous analyses and treats nonzero FFmpeg exits as failures", async () => {
  const { runner, resolver } = analyzer();
  vi.mocked(runner.run).mockReturnValue({ promise: Promise.resolve({ exitCode: 1, stdout: "", stderr }), kill() {} });
  const [a, b] = await Promise.all([analysis!.analyzeTrack("song", defaults), analysis!.analyzeTrack("song", defaults)]);
  expect(a).toEqual(b);
  expect(a.status).toBe("failed");
  expect(resolver.fetchStream).toHaveBeenCalledTimes(1);
  expect(runner.run).toHaveBeenCalledTimes(1);
  expect(await fs.promises.readdir(directory)).toEqual([]);
});

it("resumes interrupted scans with the original settings and rejects conflicting starts", async () => {
  const library = catalog(["a", "b"]);
  analyzer();
  let release!: () => void;
  const realAnalyze = analysis!.analyzeTrack.bind(analysis!);
  const spy = vi.spyOn(analysis!, "analyzeTrack").mockImplementation(async (id, options) => {
    if (id === "b") await new Promise<void>(resolve => { release = resolve; });
    return realAnalyze(id, options);
  });
  scan = new SilenceScanService(db, library, analysis!);
  const parameters = { thresholdDb: -28, minSilenceSeconds: 0.8 };
  const first = scan.start("listener", parameters);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(() => scan!.start("listener", defaults)).toThrow(ScanParametersConflict);
  const closing = scan.close(); release(); await closing;
  expect(scan.status()).toMatchObject({ status: "running", completedTracks: 1 });
  spy.mockRestore();
  scan = new SilenceScanService(db, library, analysis!); scan.resume();
  await vi.waitFor(() => expect(scan!.status()).toMatchObject({ id: first.id, status: "completed", completedTracks: 2, skippedTracks: 1, parameters }));
  expect(library.listTracks).toHaveBeenCalledTimes(1);
});

it("authenticates scan endpoints, validates parameters and returns progress without waiting", async () => {
  const library = catalog(["song"]); analyzer();
  scan = new SilenceScanService(db, library, analysis!);
  const app = Fastify(); await app.register(cookie);
  await registerSilenceScanRoutes(app, db, scan, analysis);
  const headers = { cookie: `musicdeck_session=${createSession(db, "listener").id}` };
  try {
    expect((await app.inject({ url: "/api/playback/silence-scan" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/playback/silence-scan", payload: {} })).statusCode).toBe(401);
    for (const payload of [{ thresholdDb: 20 }, { minSilenceSeconds: 0 }, { minSilenceSeconds: 31 }, { url: "http://localhost/secret" }]) {
      expect((await app.inject({ method: "POST", url: "/api/playback/silence-scan", headers, payload })).statusCode).toBe(400);
    }
    const result = await app.inject({ method: "POST", url: "/api/playback/silence-scan", headers, payload: defaults });
    expect(result.statusCode).toBe(202);
    await vi.waitFor(() => expect(scan!.status()?.status).toBe("completed"));
    const status = await app.inject({ url: "/api/playback/silence-scan", headers });
    expect(status.json().scan).toMatchObject({ id: result.json().scan.id, completedTracks: 1, parameters: defaults });
  } finally { await app.close(); }
});

it("shutdown interrupts a stalled source without caching a failed analysis", async () => {
  const resolver = { fetchStream: vi.fn(() => new Promise(() => {})) } as unknown as SourceResolver;
  analysis = new SilenceAnalysisService(db, resolver);
  const pending = analysis.analyzeTrack("stalled", defaults);
  await vi.waitFor(() => expect(resolver.fetchStream).toHaveBeenCalled());
  await analysis.close();
  expect((await pending).status).toBe("unavailable");
  expect(analysis.getAnalysis("stalled", defaults)).toBeNull();
});
