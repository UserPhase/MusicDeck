import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import type { Db } from "../db/database.js";
import { readContentRevision } from "../services/media/contentRevision.js";
import type { SourceResolver } from "./source-resolver.js";
import { autoDetectFFmpegPath } from "./spotdl-downloader-adapter.js";
import type { ProcessRunner } from "./process-runner.js";
import { DefaultProcessRunner } from "./process-runner.js";

/** Default silencedetect tuning: conservative enough to avoid trimming
 * legitimate quiet intros/outros while still catching true dead air. */
export const DEFAULT_SILENCE_THRESHOLD_DB = -35;
export const DEFAULT_MIN_SILENCE_SECONDS = 0.5;
export type SilenceParameters = { thresholdDb: number; minSilenceSeconds: number };
export function silenceParameters(options: Partial<SilenceParameters> = {}): SilenceParameters {
  const thresholdDb = options.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const minSilenceSeconds = options.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS;
  if (!Number.isFinite(thresholdDb) || thresholdDb < -100 || thresholdDb > 0 ||
    !Number.isFinite(minSilenceSeconds) || minSilenceSeconds <= 0 || minSilenceSeconds > 30) throw new Error("Invalid silence analysis settings");
  return { thresholdDb, minSilenceSeconds };
}

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
  getFFmpegPath?: () => string;
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
  private readonly shutdown = new AbortController();
  private readonly jobs = new Map<string, Promise<SilenceAnalysisRow>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly db: Db,
    private readonly sourceResolver: SourceResolver,
    private readonly options: SilenceAnalysisOptions = {}
  ) {
    this.ffmpegPath = options.ffmpegPath || autoDetectFFmpegPath();
    this.processRunner = options.processRunner || new DefaultProcessRunner();
    this.tmpDir = path.resolve(options.tmpDir || os.tmpdir());
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  getAnalysis(trackId: string, options?: Partial<SilenceParameters>): SilenceAnalysisRow | null {
    if (options) {
      const parameters = silenceParameters(options);
      const row = this.db.prepare(`SELECT analysis_json FROM track_silence_analysis_profiles
        WHERE track_id = ? AND threshold_db = ? AND min_silence_seconds = ? AND revision = ?`)
        .get(trackId, parameters.thresholdDb, parameters.minSilenceSeconds, this.revision(trackId)) as { analysis_json: string } | undefined;
      return row ? JSON.parse(row.analysis_json) as SilenceAnalysisRow : null;
    }
    const row = this.db.prepare(
      "SELECT * FROM track_silence_analysis WHERE track_id = ?"
    ).get(trackId) as DbRow | undefined;

    return row ? fromDbRow(row) : null;
  }

  private revision(trackId: string): string {
    return readContentRevision(this.db, trackId) ?? "";
  }

  private persist(row: Omit<SilenceAnalysisRow, "updatedAt">): SilenceAnalysisRow {
    const now = new Date().toISOString();

    this.db.transaction(() => {
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
      `).run(row.trackId, row.status, row.leadingSilenceSeconds, row.trailingSilenceSeconds,
        row.durationSeconds, row.thresholdDb, row.minSilenceSeconds, row.errorMessage, row.analyzedAt, now);
      this.db.prepare(`INSERT OR REPLACE INTO track_silence_analysis_profiles
        (track_id, threshold_db, min_silence_seconds, revision, analysis_json) VALUES (?, ?, ?, ?, ?)`)
        .run(row.trackId, row.thresholdDb, row.minSilenceSeconds, this.revision(row.trackId), JSON.stringify({ ...row, updatedAt: now }));
    })();

    return { ...row, updatedAt: now };
  }

  /**
   * Downloads the track's stream to a temp file and runs ffmpeg silencedetect
   * against it. For valid settings, processing failures are persisted as a
   * `failed`/`unavailable` analysis row so playback can gracefully fall back
   * to the full track.
   */
  async analyzeTrack(
    trackId: string,
    options: { thresholdDb?: number; minSilenceSeconds?: number } = {}
  ): Promise<SilenceAnalysisRow> {
    await this.sourceResolver.refreshContentRevision?.(trackId);
    const parameters = silenceParameters(options);
    const revision = this.revision(trackId);
    const key = JSON.stringify([trackId, parameters, revision]);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const job = this.analyzeOnce(trackId, parameters, revision).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }

  private async reserve(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < 2) { this.active++; return; }
    if (this.waiting.length >= 4) throw new Error("Silence analysis queue is busy");
    await new Promise<void>((resolve, reject) => {
      const resume = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { const index = this.waiting.indexOf(resume); if (index >= 0) this.waiting.splice(index, 1); reject(new Error("Silence analysis interrupted")); };
      this.waiting.push(resume); signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async analyzeOnce(trackId: string, { thresholdDb, minSilenceSeconds }: SilenceParameters, revision: string): Promise<SilenceAnalysisRow> {
    const now = new Date().toISOString();
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.shutdown.signal.addEventListener("abort", abort, { once: true });
    if (this.shutdown.signal.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    let directory: string | undefined;
    let reserved = false;

    try {
      await this.reserve(controller.signal); reserved = true;
      controller.signal.throwIfAborted();
      const stream = await Promise.race([
        this.sourceResolver.fetchStream(trackId).then(async stream => {
          if (controller.signal.aborted) { await stream.body?.cancel(); throw new Error("Silence analysis interrupted"); }
          return stream;
        }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Silence analysis interrupted")), { once: true })),
      ]);
      if (!stream.body || stream.status !== 200) {
        await stream.body?.cancel();
        throw new Error("No playable stream available for analysis");
      }

      directory = await fs.promises.mkdtemp(path.join(this.tmpDir, "musicdeck-silence-"));
      const tempFilePath = path.join(directory, "input");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(stream.body as any),
        new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 256 * 1024 * 1024 ? new Error("Track exceeds silence analysis size limit") : null, chunk);
        } }),
        fs.createWriteStream(tempFilePath), { signal: controller.signal }
      );

      const result = await this.processRunner.run(
        this.options.getFFmpegPath?.() || this.ffmpegPath,
        [
          "-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe",
          "-i", tempFilePath,
          "-map", "0:a:0",
          "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`,
          "-f", "null",
          "-",
        ],
        { timeoutMs: this.timeoutMs, signal: controller.signal }
      ).promise;
      controller.signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error("FFmpeg silence analysis failed");
      await this.sourceResolver.refreshContentRevision?.(trackId);
      if (this.revision(trackId) !== revision) throw new Error("Track changed during silence analysis; retry with the current audio");

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

      const row = {
        trackId,
        status: this.shutdown.signal.aborted ? "unavailable" as const : "failed" as const,
        leadingSilenceSeconds: null,
        trailingSilenceSeconds: null,
        durationSeconds: null,
        thresholdDb,
        minSilenceSeconds,
        errorMessage: message,
        analyzedAt: now,
      };
      return this.shutdown.signal.aborted || this.revision(trackId) !== revision
        ? { ...row, status: "unavailable", updatedAt: now } : this.persist(row);
    } finally {
      clearTimeout(timer); this.shutdown.signal.removeEventListener("abort", abort);
      if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (reserved) { const next = this.waiting.shift(); if (next) next(); else this.active--; }
    }
  }

  async close() { this.shutdown.abort(); await Promise.allSettled(this.jobs.values()); }
}
