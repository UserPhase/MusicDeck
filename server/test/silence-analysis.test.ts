import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import type { ProcessHandle, ProcessOptions, ProcessRunner } from "../src/domain/process-runner.js";
import {
  SilenceAnalysisService,
  parseSilenceIntervals,
  parseDurationSeconds,
  deriveTrimBounds,
} from "../src/domain/silence-analysis.js";
import type { SourceResolver } from "../src/domain/source-resolver.js";
import type { StreamResult } from "../src/backends/stream-provider.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function fakeStream(): StreamResult {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    status: 200,
    headers: new Headers(),
  };
}

function fakeSourceResolver(overrides: Partial<SourceResolver> = {}): SourceResolver {
  return {
    fetchStream: vi.fn(async () => fakeStream()),
    fetchArtwork: vi.fn(),
    hasSource: vi.fn(() => true),
    ...overrides,
  } as unknown as SourceResolver;
}

/** A ProcessRunner stub that returns canned ffmpeg-style stderr output
 * instead of spawning a real process. */
function stubProcessRunner(stderr: string, exitCode = 0): ProcessRunner {
  return {
    run(_command: string, _args: string[], _options?: ProcessOptions): ProcessHandle {
      const promise = Promise.resolve({ exitCode, stdout: "", stderr, signal: null });
      return {
        pid: 1234,
        kill: () => {},
        cancel: () => {},
        promise,
        completion: promise,
      };
    },
  };
}

function failingProcessRunner(message: string): ProcessRunner {
  return {
    run(): ProcessHandle {
      const promise = Promise.reject(new Error(message));
      return {
        pid: undefined,
        kill: () => {},
        cancel: () => {},
        promise,
        completion: promise,
      };
    },
  };
}

describe("silence interval / duration parsing", () => {
  it("parses paired silence_start/silence_end intervals", () => {
    const stderr = `
      [silencedetect @ 0x1] silence_start: 0
      [silencedetect @ 0x1] silence_end: 1.2 | silence_duration: 1.2
      [silencedetect @ 0x1] silence_start: 178.5
    `;

    const intervals = parseSilenceIntervals(stderr);
    expect(intervals).toEqual([
      { start: 0, end: 1.2 },
      { start: 178.5, end: null },
    ]);
  });

  it("parses the ffmpeg Duration header", () => {
    const stderr = "Duration: 00:03:00.50, start: 0.000000, bitrate: 320 kb/s";
    expect(parseDurationSeconds(stderr)).toBeCloseTo(180.5, 3);
  });

  it("returns null duration when absent", () => {
    expect(parseDurationSeconds("no duration here")).toBeNull();
  });
});

describe("deriveTrimBounds", () => {
  it("detects only leading silence", () => {
    const bounds = deriveTrimBounds([{ start: 0, end: 2 }], 180);
    expect(bounds.leadingSilenceSeconds).toBeCloseTo(2, 3);
    expect(bounds.trailingSilenceSeconds).toBe(0);
  });

  it("detects only trailing silence", () => {
    const bounds = deriveTrimBounds([{ start: 177, end: 180 }], 180);
    expect(bounds.leadingSilenceSeconds).toBe(0);
    expect(bounds.trailingSilenceSeconds).toBeCloseTo(3, 3);
  });

  it("detects both leading and trailing silence", () => {
    const bounds = deriveTrimBounds(
      [
        { start: 0, end: 1.5 },
        { start: 176, end: 180 },
      ],
      180
    );
    expect(bounds.leadingSilenceSeconds).toBeCloseTo(1.5, 3);
    expect(bounds.trailingSilenceSeconds).toBeCloseTo(4, 3);
  });

  it("reports no silence when no intervals touch the track edges", () => {
    // A pause in the middle of the track must not be treated as trimmable.
    const bounds = deriveTrimBounds([{ start: 90, end: 91 }], 180);
    expect(bounds.leadingSilenceSeconds).toBe(0);
    expect(bounds.trailingSilenceSeconds).toBe(0);
  });

  it("handles a trailing silence_start with no silence_end (runs to EOF)", () => {
    const bounds = deriveTrimBounds([{ start: 177, end: null }], 180);
    expect(bounds.trailingSilenceSeconds).toBeCloseTo(3, 3);
  });
});

describe("SilenceAnalysisService", () => {
  it("persists leading-silence-only analysis", async () => {
    const db = createTestDb();
    const stderr = `
      Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s
      [silencedetect @ 0x1] silence_start: 0
      [silencedetect @ 0x1] silence_end: 2 | silence_duration: 2
    `;
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: stubProcessRunner(stderr),
      ffmpegPath: "ffmpeg",
    });

    const result = await service.analyzeTrack("md_track1");

    expect(result.status).toBe("completed");
    expect(result.leadingSilenceSeconds).toBeCloseTo(2, 3);
    expect(result.trailingSilenceSeconds).toBe(0);
    expect(service.getAnalysis("md_track1")?.status).toBe("completed");
  });

  it("persists trailing-silence-only analysis", async () => {
    const db = createTestDb();
    const stderr = `
      Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s
      [silencedetect @ 0x1] silence_start: 178
      [silencedetect @ 0x1] silence_end: 180 | silence_duration: 2
    `;
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: stubProcessRunner(stderr),
      ffmpegPath: "ffmpeg",
    });

    const result = await service.analyzeTrack("md_track2");

    expect(result.leadingSilenceSeconds).toBe(0);
    expect(result.trailingSilenceSeconds).toBeCloseTo(2, 3);
  });

  it("persists analysis with both leading and trailing silence", async () => {
    const db = createTestDb();
    const stderr = `
      Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s
      [silencedetect @ 0x1] silence_start: 0
      [silencedetect @ 0x1] silence_end: 1 | silence_duration: 1
      [silencedetect @ 0x1] silence_start: 179
      [silencedetect @ 0x1] silence_end: 180 | silence_duration: 1
    `;
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: stubProcessRunner(stderr),
      ffmpegPath: "ffmpeg",
    });

    const result = await service.analyzeTrack("md_track3");

    expect(result.leadingSilenceSeconds).toBeCloseTo(1, 3);
    expect(result.trailingSilenceSeconds).toBeCloseTo(1, 3);
  });

  it("persists a completed analysis with zero silence when none is detected", async () => {
    const db = createTestDb();
    const stderr = "Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s";
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: stubProcessRunner(stderr),
      ffmpegPath: "ffmpeg",
    });

    const result = await service.analyzeTrack("md_track4");

    expect(result.status).toBe("completed");
    expect(result.leadingSilenceSeconds).toBe(0);
    expect(result.trailingSilenceSeconds).toBe(0);
  });

  it("persists a failed analysis and does not throw when ffmpeg is unavailable", async () => {
    const db = createTestDb();
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: failingProcessRunner("spawn ffmpeg ENOENT"),
      ffmpegPath: "ffmpeg",
    });

    const result = await service.analyzeTrack("md_track5");

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/ENOENT/);
    expect(result.leadingSilenceSeconds).toBeNull();
    expect(result.trailingSilenceSeconds).toBeNull();
    expect(service.getAnalysis("md_track5")?.status).toBe("failed");
  });

  it("persists a failed analysis when no playable source is available", async () => {
    const db = createTestDb();
    const service = new SilenceAnalysisService(
      db,
      fakeSourceResolver({
        fetchStream: vi.fn(async () => {
          throw new Error("No playable source is available for this item");
        }),
      }),
      { processRunner: stubProcessRunner(""), ffmpegPath: "ffmpeg" }
    );

    const result = await service.analyzeTrack("md_missing");

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/No playable source/);
  });

  it("re-analysis with different parameters overwrites the previous row", async () => {
    const db = createTestDb();
    const stderr = `
      Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s
      [silencedetect @ 0x1] silence_start: 0
      [silencedetect @ 0x1] silence_end: 2 | silence_duration: 2
    `;
    const service = new SilenceAnalysisService(db, fakeSourceResolver(), {
      processRunner: stubProcessRunner(stderr),
      ffmpegPath: "ffmpeg",
    });

    await service.analyzeTrack("md_track6", { thresholdDb: -40, minSilenceSeconds: 1 });
    const second = await service.analyzeTrack("md_track6", { thresholdDb: -20, minSilenceSeconds: 0.25 });

    expect(second.thresholdDb).toBe(-20);
    expect(second.minSilenceSeconds).toBe(0.25);
    expect(service.getAnalysis("md_track6")?.thresholdDb).toBe(-20);
  });

  it("returns null for a track that has never been analyzed", () => {
    const db = createTestDb();
    const service = new SilenceAnalysisService(db, fakeSourceResolver());
    expect(service.getAnalysis("md_never_analyzed")).toBeNull();
  });
});
