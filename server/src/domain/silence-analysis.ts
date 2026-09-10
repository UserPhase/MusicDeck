import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { Db } from "../db/database.js";
import type { SourceResolver } from "./source-resolver.js";
import { autoDetectFFmpegPath } from "./spotdl-downloader-adapter.js";
import type { ProcessRunner } from "./process-runner.js";
import { DefaultProcessRunner } from "./process-runner.js";

/** Default silencedetect tuning: conservative enough to avoid trimming
 * legitimate quiet intros/outros while still catching true dead air. */
export const DEFAULT_SILENCE_THRESHOLD_DB = -35;
export const DEFAULT_MIN_SILENCE_SECONDS = 0.5;

export type SilenceAnalysisStatus = "completed" | "failed" | "unavailable";

export type SilenceAnalysisRow = {
  trackId: string;
  status: SilenceAnalysisStatus;
  leadingSilenceSeconds: number | null;
  trailingSilenceSeconds: number | null;
  durationSeconds: number | null;
  thresholdDb: number;
  minSilenceSeconds: number;
  errorMessage: string | null;
  analyzedAt: string;
  updatedAt: string;
};

type DbRow = {
  track_id: string;
  status: string;
  leading_silence_seconds: number | null;
  trailing_silence_seconds: number | null;
  duration_seconds: number | null;
  threshold_db: number;
  min_silence_seconds: number;
  error_message: string | null;
  analyzed_at: string;
  updated_at: string;
};

function fromDbRow(row: DbRow): SilenceAnalysisRow {
  return {
    trackId: row.track_id,
    status: row.status as SilenceAnalysisStatus,
    leadingSilenceSeconds: row.leading_silence_seconds,
    trailingSilenceSeconds: row.trailing_silence_seconds,
    durationSeconds: row.duration_seconds,
    thresholdDb: row.threshold_db,
    minSilenceSeconds: row.min_silence_seconds,
    errorMessage: row.error_message,
    analyzedAt: row.analyzed_at,
    updatedAt: row.updated_at,
  };
}

/** Parses ffmpeg silencedetect stderr output into silence intervals. Each
 * `silence_start` is paired with the next `silence_end` in order; a trailing
 * `silence_start` with no matching `silence_end` means the silence runs to
 * end-of-stream (ffmpeg does not always emit a final `silence_end` for the
 * decoder's last partial buffer). */
export function parseSilenceIntervals(stderr: string): Array<{ start: number; end: number | null }> {
  const intervals: Array<{ start: number; end: number | null }> = [];
  const startRegex = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  const endRegex = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;

  const starts: number[] = [];
  const ends: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = startRegex.exec(stderr))) {
    starts.push(Number(match[1]));
  }
  while ((match = endRegex.exec(stderr))) {
    ends.push(Number(match[1]));
  }

  for (let i = 0; i < starts.length; i++) {
    intervals.push({ start: starts[i], end: ends[i] ?? null });
  }

  return intervals;
}

/** Parses the `Duration: HH:MM:SS.ms` line ffmpeg prints for the input file. */
export function parseDurationSeconds(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

/** Given parsed silence intervals and the stream duration, derive the
 * leading/trailing silence durations. Only silence touching the very start
 * or very end of the track counts as trim-able "dead air"; silence in the
 * middle of the track (a real pause between passages) is intentionally
 * ignored. */
export function deriveTrimBounds(
  intervals: Array<{ start: number; end: number | null }>,
  durationSeconds: number | null
): { leadingSilenceSeconds: number; trailingSilenceSeconds: number } {
  let leadingSilenceSeconds = 0;
  let trailingSilenceSeconds = 0;

  const first = intervals[0];
  if (first && first.start <= 0.05 && first.end !== null) {
    leadingSilenceSeconds = Math.max(0, first.end - first.start);
  }

  const last = intervals[intervals.length - 1];
  if (last) {
    if (last.end === null && durationSeconds !== null) {
      // Silence ran to the end of the decoded stream without an explicit
      // silence_end (common for the final buffer).
      trailingSilenceSeconds = Math.max(0, durationSeconds - last.start);
    } else if (
      last.end !== null &&
      durationSeconds !== null &&
      durationSeconds - last.end <= 0.25
    ) {
      trailingSilenceSeconds = Math.max(0, durationSeconds - last.start);
    }
  }

  return { leadingSilenceSeconds, trailingSilenceSeconds };
}

export type SilenceAnalysisOptions = {
  ffmpegPath?: string;
  processRunner?: ProcessRunner;
  tmpDir?: string;
  timeoutMs?: number;
};

/**
 * Server-side FFmpeg `silencedetect`-based trim analysis.
 *
 * Downloads the track's playable bytes through the existing SourceResolver
 * (the same path playback already uses) into a temp file, runs ffmpeg
 * silencedetect against it, and persists the derived leading/trailing
 * silence bounds. Source audio files are never modified. Results are cached
 * in the database; call `analyzeTrack` again (e.g. via the manual
 * re-analysis endpoint) to recompute with different parameters.
 */
export class SilenceAnalysisService {
  private readonly ffmpegPath: string;
  private readonly processRunner: ProcessRunner;
  private readonly tmpDir: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly sourceResolver: SourceResolver,
    options: SilenceAnalysisOptions = {}
  ) {
    this.ffmpegPath = options.ffmpegPath || autoDetectFFmpegPath();
    this.processRunner = options.processRunner || new DefaultProcessRunner();
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  getAnalysis(trackId: string): SilenceAnalysisRow | null {
    const row = this.db.prepare(
      "SELECT * FROM track_silence_analysis WHERE track_id = ?"
    ).get(trackId) as DbRow | undefined;

    return row ? fromDbRow(row) : null;
  }

  private persist(row: Omit<SilenceAnalysisRow, "updatedAt">): SilenceAnalysisRow {
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO track_silence_analysis (
        track_id, status, leading_silence_seconds, trailing_silence_seconds,
        duration_seconds, threshold_db, min_silence_seconds, error_message,
        analyzed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        status = excluded.status,
        leading_silence_seconds = excluded.leading_silence_seconds,
        trailing_silence_seconds = excluded.trailing_silence_seconds,
        duration_seconds = excluded.duration_seconds,
        threshold_db = excluded.threshold_db,
        min_silence_seconds = excluded.min_silence_seconds,
        error_message = excluded.error_message,
        analyzed_at = excluded.analyzed_at,
        updated_at = excluded.updated_at
    `).run(
      row.trackId,
      row.status,
      row.leadingSilenceSeconds,
      row.trailingSilenceSeconds,
      row.durationSeconds,
      row.thresholdDb,
      row.minSilenceSeconds,
      row.errorMessage,
      row.analyzedAt,
      now
    );

    return { ...row, updatedAt: now };
  }

  /**
   * Downloads the track's stream to a temp file and runs ffmpeg silencedetect
   * against it. Always resolves (never throws) — failures are persisted as a
   * `failed`/`unavailable` analysis row so playback can gracefully fall back
   * to the full track.
   */
  async analyzeTrack(
    trackId: string,
    options: { thresholdDb?: number; minSilenceSeconds?: number } = {}
  ): Promise<SilenceAnalysisRow> {
    const thresholdDb = options.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
    const minSilenceSeconds = options.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS;
    const now = new Date().toISOString();

    let tempFilePath: string | null = null;

    try {
      const stream = await this.sourceResolver.fetchStream(trackId);

      if (!stream.body) {
        throw new Error("No playable stream available for analysis");
      }

      tempFilePath = path.join(this.tmpDir, `musicdeck-silence-${trackId}-${Date.now()}.tmp`);
      await pipeline(
        Readable.fromWeb(stream.body as any),
        fs.createWriteStream(tempFilePath)
      );

      const result = await this.processRunner.run(
        this.ffmpegPath,
        [
          "-i", tempFilePath,
          "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`,
          "-f", "null",
          "-",
        ],
        { timeoutMs: this.timeoutMs }
      ).promise;

      const durationSeconds = parseDurationSeconds(result.stderr);
      const intervals = parseSilenceIntervals(result.stderr);
      const { leadingSilenceSeconds, trailingSilenceSeconds } = deriveTrimBounds(intervals, durationSeconds);

      return this.persist({
        trackId,
        status: "completed",
        leadingSilenceSeconds,
        trailingSilenceSeconds,
        durationSeconds,
        thresholdDb,
        minSilenceSeconds,
        errorMessage: null,
        analyzedAt: now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Silence analysis failed";

      return this.persist({
        trackId,
        status: "failed",
        leadingSilenceSeconds: null,
        trailingSilenceSeconds: null,
        durationSeconds: null,
        thresholdDb,
        minSilenceSeconds,
        errorMessage: message,
        analyzedAt: now,
      });
    } finally {
      if (tempFilePath) {
        fs.promises.unlink(tempFilePath).catch(() => {});
      }
    }
  }
}
