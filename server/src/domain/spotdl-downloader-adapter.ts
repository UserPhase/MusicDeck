import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DownloaderAdapter,
  DownloaderCapabilities,
  DownloadRequest,
  DownloadContext,
  DownloadResult,
  DownloadProgress,
  DownloadStage,
  DownloadErrorCode,
} from "./downloader-adapter.js";
import { DefaultProcessRunner, type ProcessHandle, type ProcessRunner } from "./process-runner.js";
import type { AcquiredFile } from "./acquisition.js";

const isWindows = process.platform === "win32";

/**
 * Best-effort auto-detection of the spotDL executable.
 *
 * spotDL is typically installed via `pip install spotdl`, which places a
 * console-script binary in the active Python's user/Scripts directory. That
 * directory is frequently not on PATH (especially on Windows with per-user
 * pip installs), so a bare "spotdl" spawn can fail even when spotDL is
 * installed and working. This checks a handful of standard install
 * locations before falling back to the bare command name (which still
 * works if the caller's PATH already includes it, e.g. inside the project's
 * Docker image).
 */
export function autoDetectSpotDLPath(): string {
  const home = os.homedir();
  const candidates: string[] = [];

  if (isWindows) {
    const appData = process.env.APPDATA;
    if (appData) {
      // Versioned per-user pip installs: %APPDATA%\Python\Python3XX\Scripts\spotdl.exe
      const pythonRoot = path.join(appData, "Python");
      if (fs.existsSync(pythonRoot)) {
        try {
          for (const entry of fs.readdirSync(pythonRoot)) {
            candidates.push(path.join(pythonRoot, entry, "Scripts", "spotdl.exe"));
          }
        } catch {}
      }
    }
    candidates.push(path.join(home, "AppData", "Roaming", "Python", "Scripts", "spotdl.exe"));
    candidates.push("C:\\Python314\\Scripts\\spotdl.exe");
    candidates.push("C:\\Python313\\Scripts\\spotdl.exe");
    candidates.push("C:\\Python312\\Scripts\\spotdl.exe");
  } else {
    candidates.push(path.join(home, ".local", "bin", "spotdl"));
    candidates.push("/usr/local/bin/spotdl");
    candidates.push("/usr/bin/spotdl");
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return "spotdl";
}

/**
 * Best-effort auto-detection of an FFmpeg binary.
 *
 * spotDL can download and manage its own FFmpeg copy (`spotdl --download-ffmpeg`),
 * which it stores under `~/.spotdl/ffmpeg[.exe]`. When a system-wide FFmpeg
 * isn't on PATH, prefer that spotDL-managed copy before falling back to the
 * bare command name.
 */
export function autoDetectFFmpegPath(): string {
  const home = os.homedir();
  const ext = isWindows ? ".exe" : "";
  const candidates = [
    path.join(home, ".spotdl", `ffmpeg${ext}`),
  ];

  if (isWindows) {
    candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
  } else {
    candidates.push("/usr/local/bin/ffmpeg");
    candidates.push("/usr/bin/ffmpeg");
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return "ffmpeg";
}

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".opus",
  ".wav",
  ".aac",
  ".alac",
  ".aiff",
]);

export type SpotDLAdapterOptions = {
  spotdlPath?: string;
  ffmpegPath?: string;
  processRunner?: ProcessRunner;
  runner?: ProcessRunner;
  defaultFormat?: "flac" | "mp3" | "m4a" | "opus" | "ogg";
  timeoutMs?: number;
  clientId?: string;
  clientSecret?: string;
  cookieFile?: string;
};

export type SpotDLDiagnosticResult = {
  spotdlInstalled: boolean;
  spotdlVersion?: string;
  ffmpegAvailable: boolean;
  ffmpegVersion?: string;
  spotdlPath: string;
  ffmpegPath: string;
};

/**
 * Hosts spotDL's underlying audio-provider backends actually understand for
 * a "manual audio URL" input (YouTube / YouTube Music, SoundCloud, Bandcamp).
 * Generic direct-file links (e.g. a `.flac`/`.mp3` URL from an unrelated
 * HTTP-hosting site) are NOT valid spotDL inputs — those belong to a plain
 * HTTP downloader adapter instead. Restricting this prevents spotDL from
 * greedily claiming candidates it cannot actually handle, which otherwise
 * wastes a full download attempt (and can hang) before falling back.
 */
const SPOTDL_SUPPORTED_MANUAL_HOSTS = [
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "soundcloud.com",
  "bandcamp.com",
];

export function isSpotDLCompatibleManualUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return SPOTDL_SUPPORTED_MANUAL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/**
 * Resolves the path spotDL/yt-dlp's --cookie-file should point at, alongside
 * spotDL's own config directory (mirroring Reverb's cookiesFilePath model).
 * Returns "" if the user config dir can't be resolved.
 */
export function cookiesFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || (isWindows ? process.env.APPDATA : path.join(os.homedir(), ".config"));
  if (!configDir) return "";
  return path.join(configDir, "spotdl", "cookies.txt");
}

/**
 * Persists admin-pasted cookies.txt (Netscape format) content to disk so it
 * can be handed to yt-dlp as a real file path. Mode 0600: this is
 * authenticated session data and must not be world-readable.
 */
export function writeCookiesFile(content: string): string {
  const filePath = cookiesFilePath();
  if (!filePath) {
    throw new Error("Could not resolve a config directory to store cookies.txt");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

export function normalizeManualUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    } else if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

export class SpotDLDownloaderAdapter implements DownloaderAdapter {
  readonly id = "spotdl";
  readonly name = "spotDL Downloader";
  readonly capabilities: DownloaderCapabilities = {
    spotifyTrack: true,
    textSearch: true,
    directUrl: true,
    album: true,
    playlist: true,
    metadata: true,
  };

  private spotdlPath: string;
  private ffmpegPath: string;
  private readonly processRunner: ProcessRunner;
  private readonly defaultFormat: string;
  private readonly timeoutMs: number;
  private clientId?: string;
  private clientSecret?: string;
  private cookieFile?: string;
  private readonly activeHandles = new Map<string, ProcessHandle>();

  constructor(options: SpotDLAdapterOptions = {}) {
    this.spotdlPath = options.spotdlPath || process.env.SPOTDL_PATH || autoDetectSpotDLPath();
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || autoDetectFFmpegPath();
    this.processRunner = options.processRunner || options.runner || new DefaultProcessRunner();
    this.defaultFormat = options.defaultFormat || "flac";
    this.timeoutMs = options.timeoutMs || 300_000; // 5 minutes timeout per download
    this.clientId = options.clientId || process.env.SPOTIFY_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.SPOTIFY_CLIENT_SECRET;
    this.cookieFile = options.cookieFile || process.env.SPOTDL_COOKIE_FILE;
  }

  /**
   * Applies admin-configured settings (Spotify app credentials, optional
   * YouTube cookies file, and binary path overrides) at runtime, so the
   * plugin settings UI can update behavior without restarting the server.
   * Any option left undefined keeps its previously configured value.
   */
  configure(options: SpotDLAdapterOptions): void {
    if (options.spotdlPath !== undefined) this.spotdlPath = options.spotdlPath || autoDetectSpotDLPath();
    if (options.ffmpegPath !== undefined) this.ffmpegPath = options.ffmpegPath || autoDetectFFmpegPath();
    if (options.clientId !== undefined) this.clientId = options.clientId || undefined;
    if (options.clientSecret !== undefined) this.clientSecret = options.clientSecret || undefined;
    if (options.cookieFile !== undefined) this.cookieFile = options.cookieFile || undefined;
  }

  canHandle(request: DownloadRequest): boolean {
    if (request.spotifyTrackUrl && request.spotifyTrackUrl.trim().length > 0) {
      return true;
    }
    if (request.spotifyTrackId && request.spotifyTrackId.trim().length > 0) {
      return true;
    }
    if (this.capabilities.directUrl && request.sourceUrl && isSpotDLCompatibleManualUrl(request.sourceUrl)) {
      return true;
    }
    if (request.candidate?.provider === this.id) {
      return true;
    }
    if (this.capabilities.textSearch && request.query && request.query.trim().length > 0) {
      return true;
    }
    return false;
  }

  async download(request: DownloadRequest, context: DownloadContext): Promise<DownloadResult> {
    const outputDir = context.tmpDir;
    fs.mkdirSync(outputDir, { recursive: true });

    // Handle Manual Audio URL + Spotify Metadata URL pipe syntax (Reverb model: "<audio-url>|<spotify-url>")
    const manualUrl = request.sourceUrl ? normalizeManualUrl(request.sourceUrl.replace(/\|/g, "")) : undefined;
    const spotifyUrl = request.spotifyTrackUrl;

    let target: string | undefined;
    if (manualUrl && spotifyUrl) {
      target = `${manualUrl}|${spotifyUrl}`;
    } else if (spotifyUrl) {
      target = spotifyUrl;
    } else if (manualUrl) {
      target = manualUrl;
    } else if (request.query) {
      target = request.query;
    } else if (request.requestedTrack) {
      target = [request.requestedTrack.artist, request.requestedTrack.title].filter(Boolean).join(" - ");
    }

    if (!target) {
      return {
        status: "failed",
        files: [],
        error: {
          code: "invalid-input",
          message: "No valid download target or query provided",
        },
      };
    }

    const outputTemplate = request.filenameTemplate
      ? (path.isAbsolute(request.filenameTemplate) ? request.filenameTemplate : path.join(outputDir, request.filenameTemplate))
      : path.join(outputDir, "{artists} - {title}.{output-ext}");

    const args: string[] = [
      "--simple-tui",
      "--audio", "youtube-music", "youtube",
      "--id3-separator", "; ",
      "--log-level", "DEBUG",
      "--output", outputTemplate,
      "--format", this.defaultFormat,
    ];

    if (this.ffmpegPath && this.ffmpegPath !== "ffmpeg") {
      args.push("--ffmpeg", this.ffmpegPath);
    }
    if (this.clientId && this.clientSecret) {
      args.push("--client-id", this.clientId, "--client-secret", this.clientSecret);
    }
    if (this.cookieFile) {
      args.push("--cookie-file", this.cookieFile);
    }

    args.push("download", target);

    let currentStage: DownloadStage = "downloading";
    let lastPercent: number | undefined;

    const onProgressLine = (line: string) => {
      const parsed = parseSpotDLProgress(line);
      if (parsed) {
        if (parsed.stage) currentStage = parsed.stage;
        if (parsed.percent !== undefined) lastPercent = parsed.percent;

        context.onProgress?.({
          jobId: context.jobId,
          bytesDownloaded: parsed.bytesDownloaded,
          totalBytes: parsed.totalBytes,
          percent: parsed.percent ?? lastPercent,
          speedBytesPerSecond: parsed.speedBytesPerSecond,
          stage: currentStage,
          message: line.trim(),
        });
      }
    };

    let handle: ProcessHandle | undefined;

    try {
      handle = this.processRunner.run(this.spotdlPath, args, {
        cwd: outputDir,
        signal: context.signal,
        timeoutMs: this.timeoutMs,
        onStdoutLine: onProgressLine,
        onStderrLine: onProgressLine,
      });

      this.activeHandles.set(context.jobId, handle);

      const result = await (handle.promise || handle.completion);

      if (context.signal.aborted) {
        return {
          status: "cancelled",
          files: [],
          error: {
            code: "cancelled",
            message: "Download cancelled by user",
          },
        };
      }

      if (result.exitCode !== 0) {
        const fullOutput = `${result.stdout}\n${result.stderr}`;
        const classifiedCode = classifySpotDLError(fullOutput, result.exitCode);
        return {
          status: "failed",
          files: [],
          error: {
            code: classifiedCode,
            message: `spotDL process exited with code ${result.exitCode}: ${extractErrorMessage(fullOutput)}`,
          },
        };
      }

      // Collect downloaded audio files
      const files = scanAudioFiles(outputDir, request);
      if (files.length === 0) {
        // spotDL can exit 0 even when it failed to actually acquire audio for
        // a specific track (e.g. the YouTube video it matched was removed,
        // is region-locked, or is otherwise unavailable — a real, external
        // failure unrelated to our process invocation). Surface the actual
        // underlying reason from spotDL's own output instead of a generic
        // message, so failures are diagnosable per-track.
        const fullOutput = `${result.stdout}\n${result.stderr}`;
        const reason = extractSpotDLFailureReason(fullOutput);
        return {
          status: "failed",
          files: [],
          error: {
            code: classifySpotDLError(fullOutput, 0),
            message: reason
              ? `spotDL could not obtain audio for this track: ${reason}`
              : "spotDL completed but produced no valid audio files in output directory",
          },
        };
      }

      return {
        status: "completed",
        files,
      };
    } catch (err: any) {
      if (context.signal.aborted || /abort/i.test(err?.message || "")) {
        return {
          status: "cancelled",
          files: [],
          error: {
            code: "cancelled",
            message: "Download was aborted",
          },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      const isNotFound = /enoent/i.test(message) || /not found/i.test(message);
      return {
        status: "failed",
        files: [],
        error: {
          code: isNotFound ? "executable-missing" : "general",
          message,
        },
      };
    } finally {
      this.activeHandles.delete(context.jobId);
    }
  }

  cancel(jobId: string): void {
    const handle = this.activeHandles.get(jobId);
    if (handle) {
      handle.kill("SIGTERM");
      this.activeHandles.delete(jobId);
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    const diagnostics = await this.detectBinaries();
    if (!diagnostics.spotdlInstalled) {
      return {
        ok: false,
        message: `spotDL is not installed or not accessible at '${this.spotdlPath}'`,
      };
    }
    if (!diagnostics.ffmpegAvailable) {
      return {
        ok: false,
        message: `spotDL found (${diagnostics.spotdlVersion || "unknown version"}), but FFmpeg is missing at '${this.ffmpegPath}'`,
      };
    }
    return {
      ok: true,
      message: `spotDL (${diagnostics.spotdlVersion || "installed"}) and FFmpeg (${diagnostics.ffmpegVersion || "available"}) are ready`,
    };
  }

  /** Alias used by admin diagnostics reporting; delegates to detectBinaries(). */
  async getDiagnostics(): Promise<SpotDLDiagnosticResult> {
    return this.detectBinaries();
  }

  async detectBinaries(): Promise<SpotDLDiagnosticResult> {
    let spotdlInstalled = false;
    let spotdlVersion: string | undefined;
    let ffmpegAvailable = false;
    let ffmpegVersion: string | undefined;

    try {
      const spotdlHandle = this.processRunner.run(this.spotdlPath, ["--version"], { timeoutMs: 5000 });
      const spotdlRes = await spotdlHandle.promise;
      if (spotdlRes.exitCode === 0 && spotdlRes.stdout.trim()) {
        spotdlInstalled = true;
        spotdlVersion = spotdlRes.stdout.trim().split("\n")[0];
      }
    } catch {}

    try {
      const ffmpegHandle = this.processRunner.run(this.ffmpegPath, ["-version"], { timeoutMs: 5000 });
      const ffmpegRes = await ffmpegHandle.promise;
      if (ffmpegRes.exitCode === 0 && ffmpegRes.stdout.trim()) {
        ffmpegAvailable = true;
        const firstLine = ffmpegRes.stdout.trim().split("\n")[0];
        const match = firstLine.match(/ffmpeg version ([^\s]+)/i);
        ffmpegVersion = match ? match[1] : firstLine;
      }
    } catch {}

    return {
      spotdlInstalled,
      spotdlVersion,
      ffmpegAvailable,
      ffmpegVersion,
      spotdlPath: this.spotdlPath,
      ffmpegPath: this.ffmpegPath,
    };
  }
}

/**
 * Parses live stdout / stderr progress output from spotDL.
 */
export function parseSpotDLProgress(line: string): Partial<DownloadProgress> | null {
  const result: Partial<DownloadProgress> = {};
  const trimmed = line.trim();

  // Stage identification
  if (/converting/i.test(trimmed)) {
    result.stage = "converting";
  } else if (/metadata|tagging|applying tags/i.test(trimmed)) {
    result.stage = "tagging";
  } else if (/downloading/i.test(trimmed)) {
    result.stage = "downloading";
  } else if (/processing/i.test(trimmed)) {
    result.stage = "processing";
  }

  // 1. Progress percentage: e.g. "45%" or "45.2%"
  const percentMatch = trimmed.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    const p = parseFloat(percentMatch[1]);
    if (!isNaN(p) && p >= 0 && p <= 100) {
      result.percent = Math.round(p);
    }
  }

  // 2. Download speed: e.g. "2.8MB/s", "500KB/s", "1.2 MiB/s"
  const speedMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])\/s/i);
  if (speedMatch) {
    const val = parseFloat(speedMatch[1]);
    const unit = speedMatch[2].toUpperCase();
    if (!isNaN(val)) {
      if (unit.startsWith("K")) result.speedBytesPerSecond = Math.round(val * 1024);
      else if (unit.startsWith("M")) result.speedBytesPerSecond = Math.round(val * 1024 * 1024);
      else if (unit.startsWith("G")) result.speedBytesPerSecond = Math.round(val * 1024 * 1024 * 1024);
      else result.speedBytesPerSecond = Math.round(val);
    }
  }

  // 3. Bytes downloaded / total bytes: e.g. "4.5M/10.0M" or "4500K/10000K"
  const bytesMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])\s*\/\s*(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])/i);
  if (bytesMatch) {
    const parseSize = (valStr: string, unitStr: string) => {
      const v = parseFloat(valStr);
      const u = unitStr.toUpperCase();
      if (isNaN(v)) return undefined;
      if (u.startsWith("K")) return Math.round(v * 1024);
      if (u.startsWith("M")) return Math.round(v * 1024 * 1024);
      if (u.startsWith("G")) return Math.round(v * 1024 * 1024 * 1024);
      return Math.round(v);
    };

    result.bytesDownloaded = parseSize(bytesMatch[1], bytesMatch[2]);
    result.totalBytes = parseSize(bytesMatch[3], bytesMatch[4]);
  }

  // 4. "Downloaded <song>" string indicates 100%
  if (/^downloaded\s+"/i.test(trimmed)) {
    result.percent = 100;
    result.stage = "processing";
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function classifySpotDLError(output: string, exitCode: number | null = null): DownloadErrorCode {
  const lower = output.toLowerCase();

  if (lower.includes("cancel") || lower.includes("aborted")) {
    return "cancelled";
  }
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429")) {
    return "rate-limited";
  }
  if (lower.includes("sign in to confirm") || lower.includes("login_required") || lower.includes("bot")) {
    return "authentication-failed";
  }
  if (lower.includes("not found") || lower.includes("no results") || lower.includes("could not find") || lower.includes("lookuperror")) {
    return "not-found";
  }
  if (lower.includes("video unavailable") || lower.includes("this video is not available") || lower.includes("private video") || lower.includes("not available in your country")) {
    return "retryable";
  }
  if (lower.includes("invalid_client") || lower.includes("spotifyexception") || lower.includes("cookie") || lower.includes("authentication") || lower.includes("403 forbidden")) {
    return "authentication-failed";
  }
  if (lower.includes("invalid") || lower.includes("usage:") || lower.includes("unrecognized argument") || lower.includes("queryerror")) {
    return "invalid-input";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("connection reset")) {
    return "retryable";
  }

  return "general";
}

/**
 * spotDL can exit with code 0 even when it failed to actually acquire audio
 * for a specific track — e.g. its matched YouTube video was removed,
 * region-locked, private, or otherwise unavailable. Pull the most useful,
 * human-readable reason out of spotDL's own debug/error output so failures
 * are diagnosable per-track instead of showing a generic message.
 */
function extractSpotDLFailureReason(output: string): string | undefined {
  const patterns: RegExp[] = [
    /ERROR:\s*\[[^\]]+\]\s*[^:]+:\s*(.+)/i, // yt-dlp: "ERROR: [youtube] <id>: This video is not available"
    /AudioProviderError:\s*(.+)/i,
    /(no usable results.*)/i,
    /(no results found.*)/i,
    /(video is not available)/i,
    /(private video)/i,
    /(video unavailable)/i,
    /(not available in your country)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1].trim().replace(/\s+/g, " ").slice(0, 300);
    }
  }
  return undefined;
}

function extractErrorMessage(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("Downloading") && !l.startsWith("Processing"));

  const errorLine = lines.find((l) => /error|exception|failed|fatal/i.test(l));
  return errorLine || lines.slice(-2).join(" ") || "Unknown error";
}

function scanAudioFiles(dir: string, request: DownloadRequest): AcquiredFile[] {
  const files: AcquiredFile[] = [];

  const walk = (currentDir: string) => {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            const rawName = path.basename(entry.name, ext);
            // SpotDL default template: "{artists} - {title}"
            let artist = request.requestedTrack?.artist || request.candidate?.artist;
            let title = request.requestedTrack?.title || request.candidate?.title || rawName;
            let album = request.requestedTrack?.album || request.candidate?.album;

            if (rawName.includes(" - ")) {
              const parts = rawName.split(" - ");
              if (parts.length >= 2) {
                if (!artist) artist = parts[0].trim();
                if (!title || title === rawName) title = parts.slice(1).join(" - ").trim();
              }
            }

            files.push({
              path: fullPath,
              name: entry.name,
              title,
              artist,
              album,
              size: stat.size,
            });
          }
        }
      }
    }
  };

  walk(dir);
  return files;
}
