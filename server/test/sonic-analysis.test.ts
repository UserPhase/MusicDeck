import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { SonicRecommendationService } from "../src/services/SonicRecommendationService.js";
import { TaskManager } from "../src/services/TaskManager.js";
import { createSonicAnalysisRunner, SONIC_TASK } from "../src/tasks/runners/sonicAnalysisRunner.js";
import { extractSonicFeatures, SONIC_SAMPLE_RATE } from "../src/tasks/runners/sonicFeatureWorker.js";
import type { CatalogService } from "../src/domain/catalog.js";
import { autoDetectFFmpegPath } from "../src/domain/spotdl-downloader-adapter.js";

let db: Database.Database;
let sonic: SonicRecommendationService;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runMigrations(db);
  sonic = new SonicRecommendationService(db);
  for (const id of ["seed", "close", "far"]) {
    db.prepare("INSERT INTO library_items(id,type,created_at,updated_at,content_revision) VALUES(?,'track','2026','2026','revision')").run(id);
  }
});
afterEach(() => db.close());
const axis = (first: number, second: number) => Float32Array.from({ length: 128 }, (_, i) => i === 0 ? first : i === 1 ? second : 0);

test("indexes normalized vectors, orders cosine neighbors, and excludes obsolete revisions", async () => {
  expect(sonic.settings.enabled).toBe(false);
  expect(sonic.put("seed", "file", "revision", axis(3, 4))).toBe(false);
  sonic.configure({ enabled: true, threads: 1, weight: 2.5 });
  sonic.put("seed", "file", "revision", axis(3, 4));
  sonic.put("close", "file", "revision", axis(6, 8));
  sonic.put("far", "file", "revision", axis(-4, 3));
  const matches = await sonic.nearest("seed");
  expect(matches.map(item => item.trackId)).toEqual(["close", "far"]);
  expect(matches[0].cosine).toBeCloseTo(1);
  expect(matches[1].cosine).toBeCloseTo(0);
  db.prepare("UPDATE library_items SET content_revision='new' WHERE id='close'").run();
  expect(await sonic.nearest("seed")).toEqual([{ trackId: "far", cosine: 0 }]);
  expect(sonic.counts()).toEqual({ indexed: 2, catalog: 3 });
});

test("extracts finite 128-dimensional descriptors and separates distant spectra", () => {
  const tone = (frequency: number, level: number) => extractSonicFeatures(Float32Array.from(
    { length: SONIC_SAMPLE_RATE * 2 }, (_, i) => level * Math.sin(2 * Math.PI * frequency * i / SONIC_SAMPLE_RATE)));
  const seed = tone(220, 0.7);
  const quiet = tone(220, 0.2);
  const high = tone(3000, 0.7);
  const cosine = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index], 0)
    / (Math.hypot(...a) * Math.hypot(...b));
  expect(seed).toHaveLength(128);
  expect(seed.every(Number.isFinite)).toBe(true);
  expect(cosine(seed, quiet)).toBeGreaterThan(0.99);
  expect(cosine(seed, high)).toBeLessThan(0.8);
});

const ffmpeg = process.env.FFMPEG_PATH || autoDetectFFmpegPath();
test.skipIf(spawnSync(ffmpeg, ["-version"], { windowsHide: true, stdio: "ignore" }).status !== 0)(
  "decodes local audio and persists features returned by the real worker", async () => {
    sonic.configure({ enabled: true, threads: 1, weight: 2.5 });
    const directory = await mkdtemp(join(tmpdir(), "sonic-worker-"));
    const file = join(directory, "track.wav");
    const wav = spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
      "-f", "wav", "pipe:1"], { windowsHide: true });
    expect(wav.status).toBe(0);
    await writeFile(file, wav.stdout);
    const tasks = new TaskManager(db, { minFreeMemoryBytes: 0, maxCpuLoadPerCore: 100 });
    const catalog = {
      tracksForWindow: async () => ({ items: [{ id: "seed" }] }),
      resolveTrackFile: async () => ({ connectionId: "test", filePath: file }),
    } as unknown as Pick<CatalogService, "tracksForWindow" | "resolveTrackFile">;
    tasks.register(SONIC_TASK, createSonicAnalysisRunner(sonic, catalog, directory));
    try {
      const task = tasks.enqueue(SONIC_TASK, {}, "admin");
      await expect.poll(() => tasks.get(task.id)?.state, { timeout: 4000 }).toBe("FINISHED");
      expect(sonic.counts().indexed).toBe(1);
    } finally {
      await tasks.close();
      await unlink(file);
      await rmdir(directory);
    }
  });

test("interrupts the active track immediately on stream and download pressure, then resumes it once", async () => {
  sonic.configure({ enabled: true, threads: 1, weight: 2.5 });
  const directory = await mkdtemp(join(tmpdir(), "sonic-fixture-"));
  const file = join(directory, "track.wav");
  await writeFile(file, "fixture audio");
  const tasks = new TaskManager(db, { maxConcurrent: 1, minFreeMemoryBytes: 0, maxCpuLoadPerCore: 100, monitorIntervalMs: 10_000 });
  const catalog = {
    tracksForWindow: async () => ({ items: [{ id: "seed" }] }),
    resolveTrackFile: async () => ({ connectionId: "test", filePath: file }),
  } as unknown as Pick<CatalogService, "tracksForWindow" | "resolveTrackFile">;
  const attempts: AbortSignal[] = [];
  let downloadRan = false;
  tasks.register("SPOTDL_DOWNLOAD", {
    validate: (payload): payload is object => typeof payload === "object" && payload !== null,
    async run() { downloadRan = true; },
  });
  tasks.register(SONIC_TASK, createSonicAnalysisRunner(sonic, catalog, directory, async (_file, threads, signal) => {
    expect(threads).toBe(1);
    attempts.push(signal);
    if (attempts.length === 3) return axis(1, 0);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }));
  try {
    const task = tasks.enqueue(SONIC_TASK, {}, "admin");
    await expect.poll(() => attempts.length).toBe(1);
    const release = tasks.acquireMediaStream();
    expect(attempts[0].aborted).toBe(true);
    await expect.poll(() => tasks.get(task.id)?.state).toBe("PAUSED");
    expect(sonic.counts().indexed).toBe(0);
    release();
    await expect.poll(() => attempts.length).toBe(2);
    tasks.enqueue("SPOTDL_DOWNLOAD", {}, "admin");
    expect(attempts[1].aborted).toBe(true);
    await expect.poll(() => tasks.get(task.id)?.state).toBe("FINISHED");
    expect(downloadRan).toBe(true);
    expect(attempts).toHaveLength(3);
    expect(sonic.counts().indexed).toBe(1);
  } finally {
    await tasks.close();
    await unlink(file);
    await rmdir(directory);
  }
});
