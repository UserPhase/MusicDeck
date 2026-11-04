import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { LibraryService } from "../src/domain/library.js";
import { CatalogService } from "../src/domain/catalog.js";
import { SourceResolver } from "../src/domain/source-resolver.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import { SilenceAnalysisService } from "../src/domain/silence-analysis.js";
import { LoudnessService, playbackIdentity } from "../src/services/media/loudnessService.js";
import { withTrackContent, trackContentHint } from "../src/services/media/contentRevision.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
import type { Track } from "../src/types.js";
import { createFakeBackend } from "./helpers.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-content-revision-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(":memory:"); runMigrations(db); cleanups.push(() => db.close());
  const file = path.join(directory, "song.mp3"); fs.writeFileSync(file, "original audio");
  const library = new LibraryService(db, { musicRoot: directory });
  const ref = { connectionId: "source", providerItemId: "song" };
  const backend = createFakeBackend({
    getTrack: vi.fn(async () => withTrackContent({ id: "song", providerId: "song", title: "Song", artistName: "Artist", albumName: "Album",
      artistId: null, albumId: null, durationSeconds: 60, trackNumber: 1, artworkId: null, artworkUrl: null, streamUrl: "" } satisfies Track,
    { path: file, size: 14 })),
    fetchStream: vi.fn(async () => ({ status: 200, headers: new Headers(), body: new Response(fs.readFileSync(file)).body })),
    scanLibrary: vi.fn(async () => ({ scanning: false })),
  });
  const registry = new ProviderRegistry([{ connectionId: ref.connectionId, type: "navidrome", name: "Library", enabled: true, provider: backend }]);
  const catalog = new CatalogService(registry, library);
  const resolver = new SourceResolver(registry, library);
  const id = library.ensureId("track", ref);
  return { db, directory, file, library, ref, backend, catalog, resolver, id };
}
function replaceAudio(file: string) {
  const before = fs.statSync(file);
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, "replaced audio"); // Same byte count; size alone cannot detect it.
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, file);
}
function runner(stderr: string): ProcessRunner {
  return { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 0, stdout: "", stderr }), kill() {} })) };
}
const silenceOutput = "Duration: 00:01:00.00\n[silencedetect] silence_start: 0\n[silencedetect] silence_end: 2 | silence_duration: 2\n";
const measurement = JSON.stringify({ input_i: "-25", input_tp: "-12", input_lra: "2", input_thresh: "-35", target_offset: "0", output_i: "-16", output_tp: "-3" });

test("ordinary reads preserve a durable revision, but same-size atomic replacements invalidate it", async () => {
  const env = fixture(); await env.catalog.getTrack(env.id);
  const revision = env.library.getContentRevision(env.id);
  await env.catalog.getTrack(env.id); await env.library.refreshContentRevision(env.id);
  expect(env.library.getContentRevision(env.id)).toBe(revision);
  expect(new LibraryService(env.db).getContentRevision(env.id)).toBe(revision);
  replaceAudio(env.file);
  await new LibraryService(env.db, { musicRoot: env.directory }).refreshContentRevision(env.id);
  expect(env.library.getContentRevision(env.id)).not.toBe(revision);
  const changed = env.library.getContentRevision(env.id);
  await env.catalog.getTrack(env.id);
  expect(env.library.getContentRevision(env.id)).toBe(changed);
});

test("changed provider metadata and explicit rescans invalidate content without changing stable IDs", async () => {
  const env = fixture();
  const id = env.library.ensureId("track", env.ref, { fingerprint: "etag-one" });
  const initial = env.library.getContentRevision(id);
  expect(env.library.ensureId("track", env.ref, { fingerprint: "etag-one" })).toBe(id);
  expect(env.library.getContentRevision(id)).toBe(initial);
  env.library.ensureId("track", env.ref, { fingerprint: "etag-two" });
  expect(env.library.getContentRevision(id)).not.toBe(initial);
  const changed = env.library.getContentRevision(id);
  await env.catalog.scanLibrary();
  expect(env.library.getContentRevision(id)).not.toBe(changed);
});

test("sparse provider responses do not erase known attributes or churn revisions", () => {
  const env = fixture();
  const observe = (fields: Record<string, unknown>) => env.library.ensureId("track", env.ref, trackContentHint(withTrackContent({}, fields)));
  observe({ path: "song.mp3", size: 100, etag: "one" });
  const revision = env.library.getContentRevision(env.id);
  observe({ etag: "one" }); observe({ size: 100, path: "song.mp3" });
  expect(env.library.getContentRevision(env.id)).toBe(revision);
  observe({ size: 101 }); expect(env.library.getContentRevision(env.id)).not.toBe(revision);
});

test("a previously observed local file disappearing invalidates its content revision", async () => {
  const env = fixture(); await env.catalog.getTrack(env.id);
  const revision = env.library.getContentRevision(env.id);
  fs.unlinkSync(env.file); await env.library.refreshContentRevision(env.id);
  expect(env.library.getContentRevision(env.id)).not.toBe(revision);
  const missing = env.library.getContentRevision(env.id);
  await env.library.refreshContentRevision(env.id);
  expect(env.library.getContentRevision(env.id)).toBe(missing);
});

test("upgrading an existing library preserves IDs and discards unversioned silence caches", async () => {
  const env = fixture();
  const silence = new SilenceAnalysisService(env.db, env.resolver, { tmpDir: env.directory, processRunner: runner(silenceOutput) });
  cleanups.push(() => silence.close()); await silence.analyzeTrack(env.id);
  expect(silence.getAnalysis(env.id)?.status).toBe("completed");
  // Reconstruct the preceding schema, including an existing cached analysis.
  env.db.exec(`ALTER TABLE library_items DROP COLUMN content_revision;
    ALTER TABLE library_item_sources DROP COLUMN content_fingerprint;
    ALTER TABLE library_item_sources DROP COLUMN content_metadata_json;
    ALTER TABLE library_item_sources DROP COLUMN file_fingerprint;
    ALTER TABLE library_item_sources DROP COLUMN file_path;
    DELETE FROM schema_migrations WHERE id = 38;`);
  runMigrations(env.db);
  expect(env.library.ensureId("track", env.ref)).toBe(env.id);
  expect(env.library.getContentRevision(env.id)).toMatch(/^[a-f0-9]{32}$/);
  expect(silence.getAnalysis(env.id)).toBeNull();
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM track_silence_analysis_profiles").get()).toEqual({ n: 0 });
});

test("provider paths stay private and symlinks outside the music root are never fingerprinted", async () => {
  const env = fixture();
  const track = await env.backend.getTrack("song");
  expect(JSON.stringify(track)).not.toContain(env.directory);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-outside-"));
  cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(env.directory, "escape"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(outside, "outside.mp3"), "outside audio");
  env.library.ensureId("track", env.ref, { filePath: path.join(link, "outside.mp3") });
  const revision = env.library.getContentRevision(env.id);
  await env.library.refreshContentRevision(env.id);
  expect(env.library.getContentRevision(env.id)).toBe(revision);
  expect(env.db.prepare("SELECT file_fingerprint FROM library_item_sources WHERE library_item_id = ?").get(env.id)).toEqual({ file_fingerprint: null });
});

test("replaced files lose both silence cache forms and acquire fresh loudness measurements", async () => {
  const env = fixture(); await env.catalog.getTrack(env.id);
  const loudnessRunner = runner(measurement), silenceRunner = runner(silenceOutput);
  const loudness = new LoudnessService(env.db, { cacheDir: path.join(env.directory, "cache"), getFFmpegPath: () => "stub", processRunner: loudnessRunner });
  const silence = new SilenceAnalysisService(env.db, env.resolver, { tmpDir: env.directory, processRunner: silenceRunner });
  cleanups.push(() => loudness.close(), () => silence.close());
  const identity = () => playbackIdentity(env.id, env.library.getContentRevision(env.id));
  expect((await loudness.analyzeTrack(identity(), () => env.resolver.fetchStream(env.id))).measured).toBe(true);
  await silence.analyzeTrack(env.id);
  expect(silence.getAnalysis(env.id)?.status).toBe("completed");
  expect(silence.getAnalysis(env.id, { thresholdDb: -35, minSilenceSeconds: 0.5 })?.status).toBe("completed");
  const track = (await env.catalog.getTrack(env.id))!;
  expect(loudness.trackLoudness(track)?.integratedLufs).toBe(-25);
  replaceAudio(env.file); await env.library.refreshContentRevision(env.id);
  expect(loudness.trackLoudness(track)).toBeUndefined();
  expect(silence.getAnalysis(env.id)).toBeNull();
  expect(silence.getAnalysis(env.id, { thresholdDb: -35, minSilenceSeconds: 0.5 })).toBeNull();
  expect((await loudness.analyzeTrack(identity(), () => env.resolver.fetchStream(env.id))).reused).toBe(false);
  await silence.analyzeTrack(env.id);
  expect(loudnessRunner.run).toHaveBeenCalledTimes(2); expect(silenceRunner.run).toHaveBeenCalledTimes(2);
});

test("an analysis crossing a content revision boundary cannot populate the new silence cache", async () => {
  const env = fixture(); await env.catalog.getTrack(env.id);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const processRunner: ProcessRunner = { run: vi.fn(() => ({ promise: wait.then(() => ({ exitCode: 0, stdout: "", stderr: silenceOutput })), kill() {} })) };
  const silence = new SilenceAnalysisService(env.db, env.resolver, { tmpDir: env.directory, processRunner });
  cleanups.push(() => silence.close());
  const pending = silence.analyzeTrack(env.id);
  await vi.waitFor(() => expect(processRunner.run).toHaveBeenCalledOnce());
  replaceAudio(env.file); release();
  expect((await pending).status).toBe("unavailable");
  expect(silence.getAnalysis(env.id)).toBeNull();
});

test("loudness work for a replaced file cannot publish a stale measurement", async () => {
  const env = fixture(); await env.catalog.getTrack(env.id);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const processRunner: ProcessRunner = { run: vi.fn(() => ({ promise: wait.then(() => ({ exitCode: 0, stdout: "", stderr: measurement })), kill() {} })) };
  const loudness = new LoudnessService(env.db, { cacheDir: path.join(env.directory, "cache"), getFFmpegPath: () => "stub", processRunner,
    refreshContentRevision: id => env.library.refreshContentRevision(id) });
  cleanups.push(() => loudness.close());
  const pending = loudness.analyzeTrack(playbackIdentity(env.id, env.library.getContentRevision(env.id)), () => env.resolver.fetchStream(env.id));
  await vi.waitFor(() => expect(processRunner.run).toHaveBeenCalledOnce());
  replaceAudio(env.file); release();
  expect((await pending).measured).toBe(false);
  expect(env.db.prepare("SELECT COUNT(*) AS n FROM playback_loudness_measurements").get()).toEqual({ n: 0 });
});
