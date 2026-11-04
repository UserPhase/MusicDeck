import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { constants, setPriority } from "node:os";
import { Worker } from "node:worker_threads";
import type { CatalogService } from "../../domain/catalog.js";
import { autoDetectFFmpegPath } from "../../domain/spotdl-downloader-adapter.js";
import { safeMusicPath } from "../../services/media/safeMusicPath.js";
import type { SonicRecommendationService } from "../../services/SonicRecommendationService.js";
import type { TaskDefinition } from "../../services/TaskManager.js";
import { SONIC_SAMPLE_RATE } from "./sonicFeatureWorker.js";

const SAMPLE_SECONDS = 30;
const PCM_BYTES = SAMPLE_SECONDS * SONIC_SAMPLE_RATE * 2;
export const SONIC_TASK = "SONIC_AUDIO_ANALYSIS" as const;

async function decode(file: string, ffmpeg: string, threads: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const input = await open(file, "r");
  try {
    signal.throwIfAborted();
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const child = spawn(ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe",
        "-threads", String(threads), "-filter_threads", String(threads),
        "-probesize", "2000000", "-analyzeduration", "2000000", "-i", "pipe:0",
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(SAMPLE_SECONDS),
        "-ar", String(SONIC_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1",
      ], { stdio: [input.fd, "pipe", "ignore"], windowsHide: true });
      if (child.pid) {
        try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Platform policy may forbid reprioritization. */ }
      }
      const pcm = new Uint8Array(PCM_BYTES);
      let size = 0;
      let failure: Error | undefined;
      const abort = () => { child.kill("SIGKILL"); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.on("error", error => { failure = error; });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (size + chunk.length > PCM_BYTES) {
          failure = new Error("Decoder exceeded the sonic sample limit.");
          abort();
          return;
        }
        pcm.set(chunk, size);
        size += chunk.length;
      });
      child.once("close", code => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0 || size < 2048 || size % 2 !== 0) reject(new Error("FFmpeg could not decode a supported audio sample."));
        else resolve(pcm.buffer.slice(0, size));
      });
    });
  } finally {
    await input.close();
  }
}

function features(pcm: ArrayBuffer, signal: AbortSignal): Promise<Float32Array> {
  signal.throwIfAborted();
  const built = new URL("./sonicFeatureWorker.js", import.meta.url);
  const source = existsSync(built) ? built : new URL("./sonicFeatureWorker.ts", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      workerData: { kind: "musicdeck-sonic", pcm }, transferList: [pcm], execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    let vector: Float32Array | undefined;
    let failure: Error | undefined;
    const abort = () => { void worker.terminate().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    worker.once("message", (result: { features?: Float32Array; error?: string }) => {
      vector = result.features;
      if (result.error) failure = new Error(result.error);
    });
    worker.once("error", error => { failure = error instanceof Error ? error : new Error("Sonic worker failed."); });
    worker.once("exit", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0 || !vector) reject(new Error("The sonic feature worker exited without a vector."));
      else resolve(vector);
    });
  });
}

async function fileRevision(file: string): Promise<string | null> {
  const info = await stat(file);
  if (!info.isFile()) return null;
  return createHash("sha256").update(JSON.stringify([file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])).digest("hex");
}

export function createSonicAnalysisRunner(service: SonicRecommendationService,
  catalog: Pick<CatalogService, "tracksForWindow" | "resolveTrackFile">, musicRoot: string,
  analyze = async (file: string, threads: number, signal: AbortSignal) => {
    const pcm = await decode(file, process.env.FFMPEG_PATH || autoDetectFFmpegPath(), threads, signal);
    return features(pcm, signal);
  },
): TaskDefinition<Record<string, never>> {
  return {
    validate(payload): payload is Record<string, never> {
      return service.settings.enabled && Boolean(payload) && typeof payload === "object" &&
        !Array.isArray(payload) && Object.keys(payload!).length === 0;
    },
    async run(_payload, task) {
      if (!service.settings.enabled) return;
      await task.checkpoint();
      const { items } = await catalog.tracksForWindow();
      const tracks = [...new Set(items.map(item => item.id))];
      let processed = 0, indexed = 0, skipped = 0, failed = 0;
      const report = () => task.report({
        itemsProcessed: processed, totalItems: tracks.length,
        percent: tracks.length ? 100 * processed / tracks.length : 100,
        message: `${indexed} indexed · ${skipped} unavailable · ${failed} failed`,
      });
      report();
      for (const trackId of tracks) {
        while (service.settings.enabled) {
          await task.checkpoint();
          if (!service.settings.enabled) return;
          const attempt = new AbortController();
          const detach = task.onYield?.(() => attempt.abort()) ?? (() => {});
          const signal = AbortSignal.any([task.signal, attempt.signal, AbortSignal.timeout(30_000)]);
          try {
            const source = await catalog.resolveTrackFile(trackId);
            signal.throwIfAborted();
            const content = service.contentRevision(trackId);
            let file: string | null = null;
            let revision: string | null = null;
            if (source?.filePath && content !== undefined) {
              try {
                file = safeMusicPath(musicRoot, source.filePath);
                revision = await fileRevision(file);
              } catch { /* Provider audio can live on another host or outside the managed root. */ }
            }
            signal.throwIfAborted();
            if (!file || !revision || content === undefined) {
              skipped++;
            } else if (service.hasCurrent(trackId, revision, content)) {
              indexed++;
            } else {
              service.remove(trackId);
              const vector = await analyze(file, service.settings.threads, signal);
              signal.throwIfAborted();
              const unchanged = revision === await fileRevision(safeMusicPath(musicRoot, file));
              signal.throwIfAborted();
              if (unchanged && service.put(trackId, revision, content, vector)) indexed++;
              else skipped++;
            }
            break;
          } catch (error) {
            task.throwIfCancelled();
            if (attempt.signal.aborted) continue;
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && (error as NodeJS.ErrnoException)?.syscall?.startsWith("spawn")) {
              throw new Error("FFmpeg is unavailable. Install it or configure FFMPEG_PATH.");
            }
            failed++;
            task.log?.("stderr", `Sonic analysis failed for track ${trackId}.`);
            break;
          } finally {
            detach();
          }
        }
        if (!service.settings.enabled) return;
        processed++;
        report();
      }
    },
  };
}
