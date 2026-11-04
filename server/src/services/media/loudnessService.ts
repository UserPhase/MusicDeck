import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Db } from "../../db/database.js";
import type { StreamResult } from "../../backends/stream-provider.js";
import { DefaultProcessRunner, type ProcessRunner } from "../../domain/process-runner.js";
import { safeMusicPath } from "./safeMusicPath.js";
import type { Track } from "../../types.js";
import { readContentRevision } from "./contentRevision.js";

export const LOUDNESS_TARGET = -16;
export const TRUE_PEAK_LIMIT = -1;
// Older bundled FFmpeg versions cap LRA at 20; retain dynamics whenever possible.
const FILTER = `loudnorm=I=${LOUDNESS_TARGET}:TP=${TRUE_PEAK_LIMIT}:LRA=20`;
export function playbackIdentity(trackId: string, revision: string | null, source: string | null = null, playableSource: string | null = null, preview: string | null = null) {
  return JSON.stringify([trackId, preview, playableSource, source, revision]);
}
export type TrackLoudness = { integratedLufs: number; truePeakDb: number; gainDb: number };
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 192 * 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

type Measurement = {
  input_i: string; input_tp: string; input_lra: string;
  input_thresh: string; target_offset: string;
  output_i: string; output_tp: string;
};

export function parseLoudness(stderr: string): Measurement {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks?.length) throw new Error("Loudness measurement missing");
  const result = JSON.parse(blocks[blocks.length - 1]) as Measurement;
  for (const field of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset", "output_i", "output_tp"] as const) {
    if (result[field] === undefined || !Number.isFinite(Number(result[field]))) {
      throw new Error("Audio has no measurable loudness");
    }
  }
  return result;
}

export type PreparedPlayback =
  | { status: "ready"; streamUrl: string; integratedLufs: number; truePeakDb: number; gainDb?: number }
  | { status: "measured"; integratedLufs: number; truePeakDb: number; gainDb: number }
  | { status: "unavailable" };
export type BackgroundPlayback = PreparedPlayback | { status: "processing" | "unavailable"; gainDb?: number };

export function measuredPlaybackGain(measurement: { input_i: string | number; input_tp: string | number }, targetLufs = LOUDNESS_TARGET): number {
  // A first listen uses linear gain only. Preserve headroom rather than
  // compressing musical peaks while waiting for the fully prepared stream.
  return Math.max(-60, Math.min(12, targetLufs - Number(measurement.input_i), TRUE_PEAK_LIMIT - Number(measurement.input_tp)));
}
type CacheRow = { cache_key: string; external: number; expires_at: number; bytes: number; format: "flac" | "mp3" };
type Options = {
  cacheDir: string;
  getFFmpegPath: () => string;
  processRunner?: ProcessRunner;
  maxCacheBytes?: number;
  timeoutMs?: number;
  refreshContentRevision?: (trackId: string) => Promise<string | null>;
};

export type ImportedAudio = { title: string; artist: string; album: string; durationSeconds?: number | null };
const titleKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const artistKey = (value: string) => titleKey(value.split(/\s*;\s*|\s+\/\s+/)[0]);
type ImportedRow = {
  file_path: string; music_root: string; file_size: number; mtime_ms: number;
  duration_seconds: number; measurement_json: string;
};

/** Playback derivatives only. Originals and embedded tags are never rewritten.
 * Measurements and prepared streams survive restart; duplicate requests share a job.
 */
export class LoudnessService {
  private readonly runner: ProcessRunner;
  private readonly jobs = new Map<string, Promise<PreparedPlayback>>();
  private readonly failures = new Map<string, number>();
  private readonly imports = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private publication: Promise<void> = Promise.resolve();
  private maintenance?: Promise<void>;

  constructor(private readonly db: Db, private readonly options: Options) {
    this.runner = options.processRunner ?? new DefaultProcessRunner();
  }

  /** One analysis pass at import; do not transcode or alter original audio/tags. */
  async analyzeImportedFile(filePath: string, root: string, metadata: ImportedAudio): Promise<void> {
    safeMusicPath(root, filePath);
    const physical = fs.realpathSync(filePath);
    const before = fs.statSync(physical);
    if (!before.isFile() || !before.size || before.size > MAX_INPUT_BYTES) throw new Error("Invalid audio analysis input");
    const saved = this.db.prepare("SELECT * FROM imported_audio_loudness WHERE file_path = ?").get(physical) as ImportedRow | undefined;
    if (saved && saved.file_size === before.size && saved.mtime_ms === before.mtimeMs) return;
    const existing = this.imports.get(physical);
    if (existing) return existing;
    const job = (async () => {
      await this.reserveSlot();
      try {
        this.shutdown.signal.throwIfAborted();
        const result = await this.runner.run(this.options.getFFmpegPath(), [
          "-nostdin", "-hide_banner", "-nostats",
          "-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,flac,mov,ogg,wav,aac,aiff,matroska,webm",
          "-i", physical, "-map", "0:a:0", "-af", `${FILTER}:print_format=json`, "-f", "null", "-",
        ], { signal: this.shutdown.signal, timeoutMs: this.options.timeoutMs ?? 180_000 }).promise;
        if (result.exitCode !== 0) throw new Error("Imported audio loudness analysis failed");
        const measurement = parseLoudness(result.stderr);
        // Read the actual input duration. loudnorm's look-ahead can make output
        // progress timestamps shorter than the input on older bundled FFmpeg.
        const time = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(result.stderr);
        const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : Number(metadata.durationSeconds);
        safeMusicPath(fs.realpathSync(root), physical);
        const after = fs.statSync(physical);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Imported audio changed during analysis");
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Imported audio duration unavailable");
        this.db.prepare(`INSERT OR REPLACE INTO imported_audio_loudness
          (file_path, music_root, file_size, mtime_ms, title_key, artist_key, album_key, duration_seconds, measurement_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(physical, fs.realpathSync(root), after.size, after.mtimeMs,
          titleKey(metadata.title), artistKey(metadata.artist), titleKey(metadata.album), duration, JSON.stringify(measurement));
      } finally { this.releaseSlot(); }
    })().finally(() => this.imports.delete(physical));
    this.imports.set(physical, job);
    return job;
  }

  /** Exact canonical tags + duration, with ambiguity and file-change guards.
   * No per-row provider requests, file reads, or audio decoding on catalog pages. */
  private importedMeasurement(track: Pick<Track, "title" | "artistName" | "albumName" | "durationSeconds">): Measurement | undefined {
    if (!track.title || !track.artistName || !track.albumName || !track.durationSeconds) return undefined;
    const rows = this.db.prepare(`SELECT * FROM imported_audio_loudness
      WHERE title_key = ? AND artist_key = ? AND album_key = ? AND ABS(duration_seconds - ?) <= 1.5`)
      .all(titleKey(track.title), artistKey(track.artistName), titleKey(track.albumName), track.durationSeconds) as ImportedRow[];
    const measurements: Measurement[] = [];
    for (const row of rows) {
      try {
        safeMusicPath(row.music_root, row.file_path);
        const stat = fs.statSync(row.file_path);
        if (!stat.isFile() || stat.size !== row.file_size || stat.mtimeMs !== row.mtime_ms) continue;
        measurements.push(parseLoudness(row.measurement_json));
      } catch { /* Removed, replaced or inaccessible files must never supply a gain. */ }
    }
    // Different masters with identical tags must not borrow each other's gain.
    if (!measurements.length || measurements.some(value => Math.abs(Number(value.input_i) - Number(measurements[0].input_i)) > 0.1
      || Math.abs(Number(value.input_tp) - Number(measurements[0].input_tp)) > 0.1)) return undefined;
    return measurements[0];
  }

  gainForImportedTrack(track: Pick<Track, "title" | "artistName" | "albumName" | "durationSeconds">, targetLufs = LOUDNESS_TARGET) {
    const measured = this.importedMeasurement(track);
    return measured ? measuredPlaybackGain(measured, targetLufs) : undefined;
  }

  trackLoudness(track: Track): TrackLoudness | undefined {
    const measured = this.importedMeasurement(track) ?? this.measurement(this.measurementKey(playbackIdentity(track.id, readContentRevision(this.db, track.id)), false));
    return measured ? this.describeMeasurement(measured) : undefined;
  }

  private describeMeasurement(measurement: Measurement, targetLufs = LOUDNESS_TARGET): TrackLoudness {
    return { integratedLufs: Number(measurement.input_i), truePeakDb: Number(measurement.input_tp), gainDb: measuredPlaybackGain(measurement, targetLufs) };
  }

  private async reserveSlot() {
    this.shutdown.signal.throwIfAborted();
    if (this.waiting.length >= 4) throw new Error("Preparation queue full");
    if (this.active < 2) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const resume = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(resume);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("Preparation queue busy"));
      }, 10_000);
      this.waiting.push(resume);
    });
  }

  private releaseSlot() {
    const resume = this.waiting.shift();
    if (resume) resume();
    else this.active--;
  }

  private cacheKey(identity: string, external: boolean | "preview", bitRate?: number, targetLufs = LOUDNESS_TARGET) {
    return createHash("sha256").update(`v2:${targetLufs}:-1:LRA20:${external}:${bitRate ?? "flac"}:${identity}`).digest("hex");
  }

  private measurementKey(identity: string, external: boolean | "preview") {
    return createHash("sha256").update(`measurement-v1:${external}:${identity}`).digest("hex");
  }

  private measurement(key: string): Measurement | null {
    const row = this.db.prepare("SELECT measurement_json FROM playback_loudness_measurements WHERE cache_key = ? AND expires_at > ?").get(key, Date.now()) as { measurement_json: string } | undefined;
    if (!row) return null;
    try { return parseLoudness(row.measurement_json); } catch { return null; }
  }

  async prepareInBackground(identity: string, external: boolean | "preview", load: () => Promise<StreamResult>, bitRate?: number, targetLufs = LOUDNESS_TARGET): Promise<BackgroundPlayback> {
    if (bitRate !== undefined && ![128, 192, 256, 320].includes(bitRate)) return { status: "unavailable" };
    if (![-18, -16, -14].includes(targetLufs)) return { status: "unavailable" };
    const key = this.cacheKey(identity, external, bitRate, targetLufs);
    const measured = this.measurement(this.measurementKey(identity, external));
    const gain = measured ? { gainDb: measuredPlaybackGain(measured, targetLufs),
      loudness: { integratedLufs: Number(measured.input_i), truePeakDb: Number(measured.input_tp) } } : {};
    if (await this.getFile(key)) return { ...this.result(key), ...gain };
    if (this.shutdown.signal.aborted || (this.failures.get(key) ?? 0) > Date.now()) return { status: "unavailable", ...gain };
    // Start (or join) work without holding an HTTP response open. Polls can
    // obtain measured gain as soon as analysis finishes, before encoding does.
    void this.prepare(identity, external, load, bitRate, targetLufs);
    return { status: "processing", ...gain };
  }

  async prepare(identity: string, external: boolean | "preview", load: () => Promise<StreamResult>, bitRate?: number, targetLufs = LOUDNESS_TARGET, measureOnly = false): Promise<PreparedPlayback> {
    if (bitRate !== undefined && ![128, 192, 256, 320].includes(bitRate)) return { status: "unavailable" };
    // Include the processing recipe in the key so changes cannot reuse old levels.
    if (![-18, -16, -14].includes(targetLufs)) return { status: "unavailable" };
    const measurementKey = this.measurementKey(identity, external);
    const measured = measureOnly ? this.measurement(measurementKey) : null;
    if (measured) return { status: "measured", ...this.describeMeasurement(measured, targetLufs) };
    const key = measureOnly ? `analysis:${measurementKey}` : this.cacheKey(identity, external, bitRate, targetLufs);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    if (this.shutdown.signal.aborted || (this.failures.get(key) ?? 0) > Date.now()) return { status: "unavailable" };
    const job = this.prepareOnce(key, external, load, bitRate, targetLufs, measurementKey, measureOnly,
      () => this.assertCurrentContent(identity, external)).catch((error): PreparedPlayback => {
      console.warn(`[playback normalization] ${key.slice(0, 12)}: ${error instanceof Error ? error.message : "Preparation failed"}`);
      this.failures.set(key, Date.now() + 60_000);
      // Bound failed-ID bookkeeping as well as work/disk usage.
      if (this.failures.size > 500) this.failures.delete(this.failures.keys().next().value!);
      return { status: "unavailable" };
    }).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }

  async analyzeTrack(identity: string, load: () => Promise<StreamResult>): Promise<{ reused: boolean; measured: boolean }> {
    const reused = Boolean(this.measurement(this.measurementKey(identity, false)));
    const result = await this.prepare(identity, false, load, undefined, LOUDNESS_TARGET, true);
    return { reused, measured: result.status === "measured" };
  }

  private async assertCurrentContent(identity: string, external: boolean | "preview"): Promise<void> {
    if (external !== false) return;
    let parsed: unknown;
    try { parsed = JSON.parse(identity); } catch { return; }
    if (!Array.isArray(parsed) || parsed.length !== 5 || typeof parsed[0] !== "string"
      || (parsed[4] !== null && typeof parsed[4] !== "string")) return;
    const current = this.options.refreshContentRevision
      ? await this.options.refreshContentRevision(parsed[0]) : readContentRevision(this.db, parsed[0]);
    if (current !== parsed[4]) throw new Error("Track changed during loudness analysis; retry with the current audio");
  }

  private result(key: string): PreparedPlayback {
    const row = this.db.prepare("SELECT integrated_lufs, true_peak_db FROM playback_loudness_cache WHERE cache_key = ?").get(key) as { integrated_lufs: number; true_peak_db: number };
    return { status: "ready", streamUrl: `/api/playback/normalized/${key}`, integratedLufs: row.integrated_lufs, truePeakDb: row.true_peak_db };
  }

  async getFile(key: string): Promise<{ file: string; bytes: number; external: boolean; format: "flac" | "mp3" } | null> {
    if (!KEY_PATTERN.test(key)) return null;
    const row = this.db.prepare("SELECT * FROM playback_loudness_cache WHERE cache_key = ?").get(key) as CacheRow | undefined;
    if (!row || row.expires_at < Date.now() || !["flac", "mp3"].includes(row.format)) return null;
    const file = path.join(this.options.cacheDir, `${key}.${row.format}`);
    const stat = await fs.promises.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== row.bytes) return null;
    this.db.prepare("UPDATE playback_loudness_cache SET accessed_at = ? WHERE cache_key = ?").run(Date.now(), key);
    return { file, bytes: row.bytes, external: row.external === 1, format: row.format };
  }

  private async prepareOnce(key: string, external: boolean | "preview", load: () => Promise<StreamResult>, bitRate: number | undefined, targetLufs: number, measurementKey: string, measureOnly: boolean, assertCurrent: () => Promise<void>): Promise<PreparedPlayback> {
    if (await this.getFile(key)) return this.result(key);
    const binary = this.options.getFFmpegPath();
    if (!binary) throw new Error("FFmpeg unavailable");
    await this.reserveSlot();
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.shutdown.signal.addEventListener("abort", abort, { once: true });
    if (this.shutdown.signal.aborted) controller.abort();
    const timer = setTimeout(abort, this.options.timeoutMs ?? 180_000);
    let staging: string | undefined;
    try {
      controller.signal.throwIfAborted();
      await fs.promises.mkdir(this.options.cacheDir, { recursive: true });
      this.maintenance ??= this.removeAbandonedFiles();
      await this.maintenance;
      staging = await fs.promises.mkdtemp(path.join(this.options.cacheDir, ".preparing-"));
      const input = path.join(staging, "input");
      const format = bitRate ? "mp3" : "flac";
      const output = path.join(staging, `output.${format}`);
      // MP3 encoding can introduce intersample peaks: reserve an extra dB, then
      // measure the decoded finished file before publishing either format.
      const filterTarget = FILTER.replace("I=-16", `I=${targetLufs}`);
      const baseFilter = bitRate ? filterTarget.replace("TP=-1", "TP=-2") : filterTarget;
      const inputOptions = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,flac,mov,ogg,wav,aac,aiff,matroska,webm", ...(external === "preview" ? ["-t", "30"] : [])];
      const source = await Promise.race([
        load().then(async (source) => {
          if (controller.signal.aborted) { await source.body?.cancel(); throw new Error("Preparation cancelled"); }
          return source;
        }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Preparation timed out")), { once: true })),
      ]);
      controller.signal.throwIfAborted();
      if (source.status !== 200 || !source.body) throw new Error("Audio source unavailable");
      let received = 0;
      await pipeline(Readable.fromWeb(source.body as any), new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_INPUT_BYTES ? new Error("Audio exceeds preparation limit") : null, chunk);
      } }), fs.createWriteStream(input), { signal: controller.signal });
      let m = this.measurement(measurementKey);
      if (!m) {
        const measure = await this.runner.run(binary, ["-nostdin", "-hide_banner", ...inputOptions, "-i", input, "-map", "0:a:0", "-af", `${baseFilter}:print_format=json`, "-f", "null", "-"], { signal: controller.signal, timeoutMs: 120_000 }).promise;
        if (measure.exitCode !== 0) throw new Error(`Loudness analysis failed: ${measure.stderr.slice(-1200)}`);
        m = parseLoudness(measure.stderr);
        await assertCurrent();
        this.db.prepare("INSERT OR REPLACE INTO playback_loudness_measurements (cache_key, measurement_json, expires_at) VALUES (?, ?, ?)").run(measurementKey, JSON.stringify(m), Date.now() + CACHE_TTL);
      }
      await assertCurrent();
      if (measureOnly) return { status: "measured", ...this.describeMeasurement(m) };
      const filter = `${baseFilter}:measured_I=${Number(m.input_i)}:measured_TP=${Number(m.input_tp)}:measured_LRA=${Number(m.input_lra)}:measured_thresh=${Number(m.input_thresh)}:offset=${Number(m.target_offset)}:linear=true:print_format=json`;
      const codec = bitRate ? ["-c:a", "libmp3lame", "-b:a", `${bitRate}k`] : ["-c:a", "flac", "-sample_fmt", "s32"];
      const render = await this.runner.run(binary, ["-nostdin", "-hide_banner", "-y", ...inputOptions, "-i", input, "-map", "0:a:0", "-map_metadata", "-1", "-af", filter, "-ar", "48000", ...codec, "-fs", String(MAX_OUTPUT_BYTES), output], { signal: controller.signal, timeoutMs: 120_000 }).promise;
      if (render.exitCode !== 0) throw new Error(`Loudness preparation failed: ${render.stderr.slice(-1200)}`);
      const stat = await fs.promises.stat(output);
      if (!stat.size || stat.size >= MAX_OUTPUT_BYTES) throw new Error("Prepared audio exceeds limit");
      const verify = await this.runner.run(binary, ["-nostdin", "-hide_banner", ...inputOptions, "-i", output, "-map", "0:a:0", "-af", `${FILTER}:print_format=json`, "-f", "null", "-"], { signal: controller.signal, timeoutMs: 120_000 }).promise;
      if (verify.exitCode !== 0) throw new Error("Prepared audio verification failed");
      const normalized = parseLoudness(verify.stderr);
      if (Math.abs(Number(normalized.input_i) - targetLufs) > 1 || Number(normalized.input_tp) > TRUE_PEAK_LIMIT + 0.1) throw new Error("Prepared audio did not meet loudness target");
      controller.signal.throwIfAborted();
      // Serialize eviction + publication; concurrent preparations must not both
      // budget against the same free space and exceed the cache limit.
      const publish = this.publication.then(async () => {
        controller.signal.throwIfAborted();
        await this.prune(stat.size, key);
        await assertCurrent();
        const destination = path.join(this.options.cacheDir, `${key}.${format}`);
        await fs.promises.rename(output, destination);
        try { await assertCurrent(); }
        catch (error) { await fs.promises.rm(destination, { force: true }); throw error; }
        const now = Date.now();
        this.db.prepare(`INSERT OR REPLACE INTO playback_loudness_cache
          (cache_key, external, format, integrated_lufs, true_peak_db, bytes, expires_at, accessed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(key, external === "preview" ? 2 : Number(external), format, Number(normalized.input_i), Number(normalized.input_tp), stat.size, now + CACHE_TTL, now);
      });
      this.publication = publish.catch(() => {});
      await publish;
      return this.result(key);
    } finally {
      clearTimeout(timer);
      this.shutdown.signal.removeEventListener("abort", abort);
      if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      this.releaseSlot();
    }
  }

  private async prune(incoming: number, protectedKey: string) {
    this.db.prepare("DELETE FROM playback_loudness_measurements WHERE expires_at < ?").run(Date.now());
    const rows = this.db.prepare("SELECT * FROM playback_loudness_cache ORDER BY accessed_at ASC").all() as CacheRow[];
    let total = rows.filter(row => row.cache_key !== protectedKey).reduce((sum, row) => sum + row.bytes, incoming);
    for (const row of rows) {
      if (row.cache_key === protectedKey || !KEY_PATTERN.test(row.cache_key) || !["mp3", "flac"].includes(row.format)) continue;
      if (row.expires_at >= Date.now() && total <= (this.options.maxCacheBytes ?? 1024 * 1024 * 1024)) continue;
      try { await fs.promises.unlink(path.join(this.options.cacheDir, `${row.cache_key}.${row.format}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      this.db.prepare("DELETE FROM playback_loudness_cache WHERE cache_key = ?").run(row.cache_key);
      total -= row.bytes;
    }
    if (total > (this.options.maxCacheBytes ?? 1024 * 1024 * 1024)) throw new Error("Playback cache is full");
  }

  private async removeAbandonedFiles() {
    // Clean interrupted staging and uncommitted files after a restart. Restrict
    // removal to names owned by this cache and leave fresh files alone.
    for (const entry of await fs.promises.readdir(this.options.cacheDir, { withFileTypes: true })) {
      const staging = entry.isDirectory() && /^\.preparing-[a-zA-Z0-9]+$/.test(entry.name);
      const cached = entry.isFile() && /^([a-f0-9]{64})\.(flac|mp3)$/.exec(entry.name);
      if (!staging && !cached) continue;
      if (cached && this.db.prepare("SELECT 1 FROM playback_loudness_cache WHERE cache_key = ?").get(cached[1])) continue;
      const file = path.join(this.options.cacheDir, entry.name);
      const stat = await fs.promises.lstat(file);
      if (stat.mtimeMs > Date.now() - 10 * 60_000) continue;
      await fs.promises.rm(file, { recursive: staging, force: true });
    }
  }

  async close() {
    this.shutdown.abort();
    await Promise.allSettled([...this.jobs.values(), ...this.imports.values()]);
  }
}
