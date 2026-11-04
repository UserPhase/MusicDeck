import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TaskManager, type ManagedTask } from "../src/services/TaskManager.js";
import { createLibraryScanRunner } from "../src/tasks/runners/libraryScanRunner.js";
import { createSpotdlRunner } from "../src/tasks/runners/spotdlRunner.js";
import { SpotifyPlaylistImportService } from "../src/domain/spotify-playlist-import.js";
import type { DownloaderAdapter, DownloadContext, DownloadRequest, DownloadResult } from "../src/domain/downloader-adapter.js";
import type { SourceCandidate } from "../src/domain/source-discovery.js";
import { CatalogService } from "../src/domain/catalog.js";
import { LibraryService } from "../src/domain/library.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import { runMigrations } from "../src/db/migrations.js";
import { getUserById } from "../src/users/users.js";
import { SqliteImportJobRepository } from "../src/infrastructure/persistence/sqliteImportJobRepository.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function manager(db: Database.Database) {
  const value = new TaskManager(db, {
    maxConcurrent: 1, minFreeMemoryBytes: 0, maxCpuLoadPerCore: 100, monitorIntervalMs: 10_000,
  });
  cleanups.push(() => value.close());
  return value;
}

async function fixture(backend = createFakeBackend()) {
  const value = await createTestServer(backend);
  cleanups.push(async () => {
    await closeTestServer(value.app, value.db);
    fs.rmSync(value.directory, { recursive: true, force: true });
  });
  return value;
}

describe("registered cooperative task runners", () => {
  test("startup registers real library scans and imports instead of returning unregistered-type conflicts", async () => {
    const backend = createFakeBackend({ scanLibrary: vi.fn(async () => ({ scanning: false })) });
    const { app, db } = await fixture(backend);
    const admin = await login(app);
    const scan = await app.inject({
      method: "POST", url: "/api/v1/admin/tasks", headers: { cookie: admin.cookie },
      payload: { type: "LIBRARY_SCAN", payload: {} },
    });
    expect(scan.statusCode).toBe(202);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT state FROM background_tasks WHERE id = ?").get(scan.json().task.id);
      expect(row).toMatchObject({ state: "FINISHED" });
    });
    expect(backend.scanLibrary).toHaveBeenCalledOnce();
    const invalid = await app.inject({
      method: "POST", url: "/api/v1/admin/tasks", headers: { cookie: admin.cookie },
      payload: { type: "SPOTDL_IMPORT", payload: { command: "arbitrary executable" } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  test("library index batches are at most 50 tracks and yield to live media streams", async () => {
    const template = (await createFakeBackend().listTracks())[0];
    const tracks = Array.from({ length: 123 }, (_, index) => ({ ...template, id: `track-${index}`, providerId: `track-${index}` }));
    const backend = createFakeBackend({
      scanLibrary: vi.fn(async () => ({ scanning: false })),
      listTracks: vi.fn(async () => tracks),
    });
    const db = new Database(":memory:");
    cleanups.push(() => { db.close(); });
    runMigrations(db);
    const catalog = new CatalogService(new ProviderRegistry([{
      connectionId: "test", type: "navidrome", name: "Test", enabled: true, provider: backend,
    }]), new LibraryService(db));
    const tasks = manager(db);
    tasks.register("LIBRARY_SCAN", createLibraryScanRunner(catalog));
    const counts: number[] = [];
    let releaseStream: (() => void) | undefined;
    tasks.subscribe((event, task) => {
      if (event === "task.progress" && task.progress.itemsProcessed > 0) {
        counts.push(task.progress.itemsProcessed);
        if (counts.length === 1) releaseStream = tasks.acquireMediaStream();
      }
    });
    const job = tasks.enqueue("LIBRARY_SCAN", {}, "admin");
    await vi.waitFor(() => expect(tasks.get(job.id)?.state).toBe("PAUSED"));
    expect(counts).toEqual([50]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE type = 'track'").get()).toEqual({ count: 50 });
    releaseStream!();
    expect((await tasks.waitForSettlement(job.id)).state).toBe("FINISHED");
    expect(counts).toEqual([50, 100, 123]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE type = 'track'").get()).toEqual({ count: 123 });
  });

  test("acquisition cancellation waits for the worker before removing partial files and retains progress events", async () => {
    const env = await fixture();
    const tasks = manager(env.db);
    tasks.register("SPOTDL_IMPORT", createSpotdlRunner(env.acquisition));
    env.acquisition.bindTaskManager(tasks);
    let release!: () => void;
    let staging = "";
    let abortSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const acquire = vi.fn(async (_candidate: SourceCandidate, context: { tmpDir: string; signal: AbortSignal; onProgress?: (bytes: number, total: number, percent: number) => void }) => {
      staging = context.tmpDir;
      abortSignal = context.signal;
      fs.writeFileSync(path.join(staging, "partial.mp3"), "partial");
      context.onProgress?.(50, 100, 50);
      await gate;
      context.signal.throwIfAborted();
      return { files: [] };
    });

    env.acquisitionProviders.register({ id: "managed-test", name: "Managed test", canAcquire: (candidate) => candidate.provider === "managed-test", acquire });
    const user = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const events: Array<{ event: string; task: ManagedTask }> = [];
    tasks.subscribe((event, task) => events.push({ event, task }));
    const job = await env.acquisition.createJob(user.id, { candidate: { id: "candidate", provider: "managed-test", title: "Test" } });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const task = tasks.list()[0];
    expect(task.type).toBe("SPOTDL_IMPORT");
    expect(task.progress.percent).toBe(50);
    expect(events.some(({ event, task }) => event === "task.progress" && task.progress.percent === 50)).toBe(true);
    await tasks.cancel(task.id);
    expect(abortSignal?.aborted).toBe(true);
    expect(fs.existsSync(staging)).toBe(true);
    expect(tasks.get(task.id)?.state).toBe("PROCESSING");
    release();
    expect((await tasks.waitForSettlement(task.id)).state).toBe("CANCELLED");
    expect(fs.existsSync(staging)).toBe(false);
    expect(env.acquisition.getJob(job.id)?.status).toBe("cancelled");
  });

  test("cancelling a queued acquisition updates its existing lifecycle without spawning a downloader", async () => {
    const env = await fixture();
    const tasks = manager(env.db);
    tasks.register("LIBRARY_SCAN", {
      validate: (value): value is object => Boolean(value && typeof value === "object"),
      async run(_payload, context) {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    tasks.register("SPOTDL_IMPORT", createSpotdlRunner(env.acquisition));
    env.acquisition.bindTaskManager(tasks);
    const blocker = tasks.enqueue("LIBRARY_SCAN", {}, "admin");
    await vi.waitFor(() => expect(tasks.get(blocker.id)?.state).toBe("PROCESSING"));
    const acquire = vi.fn(async () => ({ files: [] }));
    env.acquisitionProviders.register({ id: "queued-test", name: "Queued test", canAcquire: () => true, acquire });
    const user = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const job = await env.acquisition.createJob(user.id, { candidate: { id: "candidate", provider: "queued-test", title: "Queued" } });
    const task = tasks.findPending("SPOTDL_IMPORT", { kind: "acquisition", jobId: job.id })!;
    expect(task.state).toBe("QUEUED");
    await tasks.cancel(task.id);
    await vi.waitFor(() => expect(env.acquisition.getJob(job.id)?.status).toBe("cancelled"));
    expect(acquire).not.toHaveBeenCalled();
  });

  test("successful acquisitions are executed through the registered runner", async () => {
    const env = await fixture();
    const tasks = manager(env.db);
    tasks.register("SPOTDL_IMPORT", createSpotdlRunner(env.acquisition));
    env.acquisition.bindTaskManager(tasks);
    env.acquisitionProviders.register({
      id: "success-test", name: "Success test", canAcquire: () => true,
      async acquire(_candidate, context) {
        const file = path.join(context.tmpDir, "song.mp3");
        fs.writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(256)]));
        return { files: [{ path: file, name: "song.mp3", title: "Song", artist: "Artist", size: 259 }] };
      },
    });
    const user = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const job = await env.acquisition.createJob(user.id, { candidate: { id: "candidate", provider: "success-test", title: "Song" } });
    const task = tasks.list({ includeTerminal: true }).find((value) => value.type === "SPOTDL_IMPORT")!;
    expect((await tasks.waitForSettlement(task.id)).state).toBe("FINISHED");
    expect(env.acquisition.getJob(job.id)?.status).toBe("completed");
    expect(fs.existsSync(env.acquisition.getJob(job.id)!.files![0].path)).toBe(true);
  });

  test("playlist imports pause between tracks, pass cancellation to downloads, and clean their scoped staging files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-task-playlist-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = await fixture();
    const tasks = manager(env.db);
    const songs = [1, 2].map((position) => ({
      position, url: `https://open.spotify.com/track/song${position}`,
      title: `Song ${position}`, artist: "Artist", album: "Album", duration: 180,
    }));
    let unblockFirst!: () => void;
    let unblockSecond!: () => void;
    const first = new Promise<void>((resolve) => { unblockFirst = resolve; });
    const second = new Promise<void>((resolve) => { unblockSecond = resolve; });
    let secondSignal: AbortSignal | undefined;
    const staging: string[] = [];
    const download = vi.fn(async (request: DownloadRequest, context: DownloadContext): Promise<DownloadResult> => {
      staging.push(context.tmpDir);
      if (staging.length === 1) await first;
      else { secondSignal = context.signal; await second; }
      context.signal.throwIfAborted();
      const file = path.join(root, path.basename(request.spotifyTrackUrl!) + ".mp3");
      fs.writeFileSync(file, "audio");
      return { status: "completed", files: [{ path: file, name: path.basename(file), size: 5 }] };
    });
    const downloader: DownloaderAdapter = {
      id: "test", name: "Test",
      capabilities: { spotifyTrack: true, album: false, playlist: true, textSearch: false, directUrl: false, metadata: true },
      canHandle: () => true,
      download,
      fetchPlaylistTracks: async () => ({ status: "completed", files: [], playlistTracks: songs }),
    };
    const service = new SpotifyPlaylistImportService(
      createFakeBackend({ search: async () => ({ tracks: [], artists: [], albums: [] }), scanLibrary: async () => ({ scanning: false }) }),
      env.playlists,
      downloader, root, async () => new Response("{}"),
    );
    tasks.register("SPOTDL_IMPORT", createSpotdlRunner(undefined, service));
    service.bindTaskManager(tasks);
    const row = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const user = getUserById(env.db, row.id)!;
    const job = service.start("https://open.spotify.com/playlist/test14", user);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const task = tasks.list()[0];
    tasks.pause(task.id);
    unblockFirst();
    await vi.waitFor(() => expect(tasks.get(task.id)?.state).toBe("PAUSED"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(download).toHaveBeenCalledOnce();
    tasks.resume(task.id);
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    await tasks.cancel(task.id);
    expect(secondSignal?.aborted).toBe(true);
    expect(fs.existsSync(staging[1])).toBe(true);
    unblockSecond();
    expect((await tasks.waitForSettlement(task.id)).state).toBe("CANCELLED");
    expect(staging.every((directory) => !fs.existsSync(directory))).toBe(true);
    expect(service.get(job.id, user.id)?.status).toBe("failed");
  });
});

describe("task runner persistence", () => {
  test("resumes an interrupted playlist using its existing paused task rather than duplicating it", async () => {
    const env = await fixture();
    const tasks = manager(env.db);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-task-resume-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const row = env.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    const user = getUserById(env.db, row.id)!;
    const repository = new SqliteImportJobRepository(env.db);
    const jobId = "interrupted-playlist";
    repository.save({
      user, playlistUrl: "https://open.spotify.com/playlist/test14",
      job: { id: jobId, userId: user.id, status: "running", stage: "downloading", playlistId: "existing-playlist",
        manifest: [{ position: 1, status: "COMPLETED", providerTrackId: "track-1",
          source: { position: 1, url: "https://open.spotify.com/track/song1", title: "Song", artist: "Artist", duration: 180 } }] },
    });
    const downloader: DownloaderAdapter = {
      id: "resume", name: "Resume",
      capabilities: { spotifyTrack: true, album: false, playlist: true, textSearch: false, directUrl: false, metadata: true },
      canHandle: () => true, download: vi.fn(),
      fetchPlaylistTracks: vi.fn(),
    };
    const service = new SpotifyPlaylistImportService(env.backend, env.playlists, downloader, root,
      async () => new Response("{}"), "Spotify Imports", undefined, repository);
    tasks.register("SPOTDL_IMPORT", createSpotdlRunner(undefined, service));
    const task = tasks.enqueue("SPOTDL_IMPORT", { kind: "playlist", jobId }, user.id);
    tasks.pause(task.id);
    service.bindTaskManager(tasks);
    service.resumeInterrupted((id) => getUserById(env.db, id));
    expect(tasks.list()).toHaveLength(1);
    tasks.resume(task.id);
    expect((await tasks.waitForSettlement(task.id)).state).toBe("FINISHED");
    expect(service.get(jobId, user.id)?.status).toBe("completed");
    expect(downloader.download).not.toHaveBeenCalled();
    expect(downloader.fetchPlaylistTracks).not.toHaveBeenCalled();
  });

  test("upgrades legacy task-type constraints without losing paused tasks or schedules", async () => {
    const db = new Database(":memory:");
    cleanups.push(() => { db.close(); });
    const initial = manager(db);
    initial.register("LIBRARY_SCAN", {
      validate: (value): value is object => Boolean(value && typeof value === "object"),
      run: async () => {},
    });
    const completed = initial.enqueue("LIBRARY_SCAN", {}, "owner");
    await initial.waitForSettlement(completed.id);
    initial.setSchedule("LIBRARY_SCAN", {}, "0 2 * * *", "owner");
    await initial.close();
    db.exec("DROP TABLE background_task_logs");
    for (const table of ["background_tasks", "background_task_schedules"]) {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string };
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_previous`);
      db.exec(sql.replace("'SPOTDL_IMPORT',", ""));
      db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_previous; DROP TABLE ${table}_previous`);
    }
    db.prepare("UPDATE background_tasks SET state = 'PAUSED' WHERE id = ?").run(completed.id);
    const restored = manager(db);
    expect(restored.get(completed.id)?.state).toBe("PAUSED");
    expect(restored.listSchedules()).toHaveLength(1);
    restored.register("SPOTDL_IMPORT", {
      validate: (value): value is object => Boolean(value && typeof value === "object"),
      run: async () => {},
    });
    expect((await restored.waitForSettlement(restored.enqueue("SPOTDL_IMPORT", {}, "owner").id)).state).toBe("FINISHED");
    restored.setSchedule("SPOTDL_IMPORT", {}, "0 3 * * *", "owner");
    expect(restored.listSchedules()).toHaveLength(2);
  });

  test("settlement observers are rejected on shutdown while queued work remains durable", async () => {
    const db = new Database(":memory:");
    cleanups.push(() => { db.close(); });
    const tasks = manager(db);
    tasks.register("LIBRARY_SCAN", {
      validate: (value): value is object => Boolean(value && typeof value === "object"),
      run: async () => {},
    });
    const release = tasks.acquireMediaStream();
    const task = tasks.enqueue("LIBRARY_SCAN", {}, "owner");
    const outcome = expect(tasks.waitForSettlement(task.id)).rejects.toThrow("closed");
    await tasks.close();
    await outcome;
    expect(tasks.get(task.id)?.state).toBe("QUEUED");
    release();
  });
});
