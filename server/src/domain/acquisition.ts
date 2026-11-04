import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { CatalogService } from "./catalog.js";
import type { LibraryService } from "./library.js";
import type { SourcePipelineRegistry, SourceCandidate } from "./source-discovery.js";
import type { UnifiedSearchResult } from "./search.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";
import { listServerSettings } from "./settings.js";
import { SpotifyTrackResolver } from "./spotify-track-resolver.js";
import {
  DownloaderAdapterRegistry,
  type DownloaderAdapter,
  type DownloadRequest,
  type DownloadContext,
  type DownloadProgress,
  type DownloadStage,
  type DownloaderCapabilities,
} from "./downloader-adapter.js";
import type { ProcessRunner } from "./process-runner.js";
import { SpotDLDownloaderAdapter, SPOTDL_LIBRARY_TEMPLATE } from "./spotdl-downloader-adapter.js";
import { AcquisitionValidationError, canonicalSpotifyUrl, validateCandidateDownloadUrls } from "./acquisition-url-policy.js";
import { AcquisitionCapacityError, resolveAcquisitionLimits, type AcquisitionLimits } from "./acquisition-limits.js";
import { serverLogs } from "../utils/logger.js";
import type { TaskManager, TaskRunContext } from "../services/TaskManager.js";
import { currentPrivacyManager } from "../services/PrivacyManager.js";

export class AcquisitionJobError extends Error {
  constructor(public readonly code: "ACQUISITION_NOT_FOUND" | "ACQUISITION_NOT_RETRYABLE") {
    super(code === "ACQUISITION_NOT_FOUND" ? "Job not found" : "Only settled failed or cancelled jobs can be retried");
  }
}

function safeAcquisitionFailure(code: string | null): string {
  switch (code) {
    case "NO_CANDIDATES": return "No candidates found for requested recording";
    case "NO_ACQUIREABLE_SOURCE": return "No acquireable source found for requested recording";
    case "SERVER_RESTARTED": return "Acquisition was interrupted by server restart";
    case "CANCELLED": return "Cancelled by user";
    default: return "Acquisition failed. Please retry or contact an administrator.";
  }
}

export type AcquisitionJobStatus =
  | "queued"
  | "discovering"
  | "downloading"
  | "processing"
  | "importing"
  | "completed"
  | "failed"
  | "cancelled";

export type AcquisitionJob = {
  id: string;
  userId: string;
  status: AcquisitionJobStatus;
  sourceProvider?: string;
  sourceCandidateId?: string;
  requestedTrackId?: string;
  requestedAlbumId?: string;
  requestedTitle?: string;
  requestedArtist?: string;
  containerId?: string;
  autoPlay?: boolean;
  stage?: string;
  speedBytesPerSecond?: number;
  progress?: {
    bytesDownloaded?: number;
    totalBytes?: number;
    percent?: number;
    speedBytesPerSecond?: number;
    stage?: string;
  };
  files?: Array<{
    path: string;
    title?: string;
    artist?: string;
    album?: string;
    size?: number;
    status: string;
  }>;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AcquisitionProgressDetails = {
  percent?: number;
  speedBytesPerSecond?: number;
  stage?: DownloadStage | string;
};

export type AcquisitionContext = {
  jobId: string;
  tmpDir: string;
  onProgress: (
    bytesDownloaded: number,
    totalBytes?: number,
    percentOrDetails?: number | AcquisitionProgressDetails,
    speedBytesPerSecond?: number,
    stage?: string
  ) => void;
  signal: AbortSignal;
  checkpoint?: () => Promise<void>;
  onLog?: (source: "stdout" | "stderr", message: string) => void;
};

export type AcquiredFile = {
  path: string;
  playlistPosition?: number;
  name?: string;
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  durationSeconds?: number;
  size?: number;
  mimeType?: string;
};

export type AcquisitionResult = {
  files: AcquiredFile[];
};

export type AcquisitionInputType =
  | "text"
  | "direct-file"
  | "detail-url"
  | "spotify-track-url"
  | "container";

export interface AcquisitionProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedInputs?: readonly string[];
  readonly inputMode?: "text" | "spotify-url" | "either";
  canAcquire(candidate: SourceCandidate): boolean | Promise<boolean>;
  acquire(candidate: SourceCandidate, context: AcquisitionContext): Promise<AcquisitionResult>;
  test?(): Promise<{ ok: boolean; message?: string }>;
}

/**
 * DownloaderAcquisitionProvider wraps a DownloaderAdapter (such as SpotDL)
 * into an AcquisitionProvider.
 */
export class DownloaderAcquisitionProvider implements AcquisitionProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedInputs: readonly string[];
  readonly inputMode: "text" | "spotify-url" | "either";

  constructor(public readonly adapter: DownloaderAdapter) {
    this.id = adapter.id;
    this.name = adapter.name;
    const inputs: string[] = [];
    if (adapter.capabilities.spotifyTrack) inputs.push("spotify-track-url");
    if (adapter.capabilities.textSearch) inputs.push("text");
    if (adapter.capabilities.directUrl) inputs.push("detail-url", "direct-file");
    if (adapter.capabilities.album || adapter.capabilities.playlist) inputs.push("container");
    this.supportedInputs = inputs;
    this.inputMode =
      adapter.capabilities.spotifyTrack && adapter.capabilities.textSearch
        ? "either"
        : adapter.capabilities.spotifyTrack
          ? "spotify-url"
          : "text";
  }

  canAcquire(candidate: SourceCandidate): boolean | Promise<boolean> {
    if (this.adapter.id === "spotdl") {
      try { validateCandidateDownloadUrls(candidate); } catch { return false; }
    }
    if (candidate.provider === this.id || candidate.provider === this.adapter.id) return true;
    const spotifyUrl =
      candidate.metadata?.acquisitionInputs?.spotifyTrackUrl ||
      candidate.metadata?.spotifyTrackUrl ||
      (candidate.id.startsWith("https://open.spotify.com/") ? candidate.id : undefined);

    if (spotifyUrl && this.adapter.capabilities.spotifyTrack) {
      return true;
    }
    if (
      (candidate.id.startsWith("spotify:track:") || candidate.metadata?.acquisitionInputs?.spotifyTrackId || candidate.metadata?.spotifyTrackId) &&
      this.adapter.capabilities.spotifyTrack
    ) {
      return true;
    }
    // Delegate direct-URL matching to the adapter itself: a downloader adapter
    // (like spotDL) only understands a specific set of source hosts for a
    // "manual URL" input, and must not greedily claim generic direct-file
    // links intended for a plain HTTP downloader.
    const directUrl = (candidate.metadata?.acquisitionUrl as string) || (candidate.metadata?.downloadUrl as string);
    if (directUrl && this.adapter.capabilities.directUrl) {
      return this.adapter.canHandle({ sourceUrl: directUrl, outputDirectory: "" });
    }
    return false;
  }

  async acquire(candidate: SourceCandidate, context: AcquisitionContext): Promise<AcquisitionResult> {
    if (this.adapter.id === "spotdl") validateCandidateDownloadUrls(candidate);
    const rawSpotifyUrl =
      candidate.metadata?.acquisitionInputs?.spotifyTrackUrl ||
      candidate.metadata?.spotifyTrackUrl ||
      (candidate.id.startsWith("https://open.spotify.com/") ? candidate.id : undefined);
    const spotifyUrl = typeof rawSpotifyUrl === "string" ? rawSpotifyUrl : undefined;
    const rawSpotifyTrackId = candidate.metadata?.acquisitionInputs?.spotifyTrackId || candidate.metadata?.spotifyTrackId;
    const spotifyTrackId = typeof rawSpotifyTrackId === "string" ? rawSpotifyTrackId : undefined;
    const req: DownloadRequest = {
      spotifyTrackUrl: spotifyUrl,
      spotifyTrackId,
      query: candidate.title ? [candidate.artist, candidate.title].filter(Boolean).join(" - ") : undefined,
      sourceUrl: (candidate.metadata?.acquisitionUrl as string) || (candidate.metadata?.downloadUrl as string) || undefined,
      outputDirectory: context.tmpDir,
      ...(this.adapter.id === "spotdl" ? { filenameTemplate: SPOTDL_LIBRARY_TEMPLATE } : {}),
      candidate,
    };

    const dlContext: DownloadContext = {
      jobId: context.jobId,
      tmpDir: context.tmpDir,
      signal: context.signal,
      checkpoint: context.checkpoint,
      onLog: context.onLog,
      onProgress: (prog: DownloadProgress) => {
        context.onProgress(prog.bytesDownloaded || 0, prog.totalBytes, {
          percent: prog.percent,
          speedBytesPerSecond: prog.speedBytesPerSecond,
          stage: prog.stage,
        });
      },
    };

    const result = await this.adapter.download(req, dlContext);
    if (result.status === "failed") {
      throw new Error(result.error?.message || "Downloader failed to acquire track");
    }
    if (result.status === "cancelled") {
      throw new Error("Download was cancelled");
    }

    return {
      files: result.files,
    };
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    return this.adapter.test ? this.adapter.test() : { ok: true, message: `${this.name} is ready` };
  }
}

export type AcquisitionCreateOptions = {
  trackId?: string;
  albumId?: string;
  containerId?: string;
  candidateId?: string;
  candidate?: SourceCandidate;
  result?: UnifiedSearchResult;
  sourceProvider?: string;
  spotifyTrackUrl?: string;
  spotifyUrl?: string;
  autoPlay?: boolean;
};

export type AcquisitionAdminSummary = {
  activeJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalJobs: number;
  storageUsedBytes: number;
  tempStorageUsedBytes: number;
  musicRoot: string;
  downloadDirectory: string;
  maxConcurrentDownloads: number;
  autoScanLibrary: boolean;
  cleanupPolicy: string;
  recentJobs: AcquisitionJob[];
};

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".alac",
  ".wma",
]);

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function sanitizePathSegment(segment: string): string {
  if (!segment) return "Unknown";
  const normalized = segment.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  const candidate = parts.length > 0 ? parts[parts.length - 1] : "Unknown";

  let clean = candidate
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim()
    .replace(/[. ]+$/, "");

  const stem = clean.split(".")[0] || clean;
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    clean = `_${clean}`;
  }

  return clean || "Unknown";
}

export function resolveSafeDestination(baseDir: string, ...rawSubPaths: string[]): string {
  const normalizedBase = path.resolve(baseDir);
  for (const raw of rawSubPaths) {
    if (raw.includes("..") || path.isAbsolute(raw)) {
      const candidate = path.resolve(normalizedBase, raw);
      if (!candidate.startsWith(normalizedBase + path.sep) && candidate !== normalizedBase) {
        throw new Error("Path traversal detected in destination path");
      }
      throw new Error("Path traversal detected in destination path");
    }
  }

  const sanitizedParts = rawSubPaths.flatMap((sub) =>
    sub
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p !== "" && p !== "." && p !== "..")
      .map(sanitizePathSegment)
  );
  const resolved = path.resolve(normalizedBase, ...sanitizedParts);

  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error("Path traversal detected in destination path");
  }

  return resolved;
}

export function validateAudioFile(filePath: string): { valid: boolean; reason?: string; error?: string; format?: string } {
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: "File does not exist", error: "File does not exist" };
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { valid: false, reason: "File is empty", error: "File is empty" };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) {
    return { valid: false, reason: `Unsupported audio format: ${ext}`, error: `Unsupported audio format: ${ext}` };
  }

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(Math.min(512, stat.size));
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);

  if (bytesRead < 4) {
    return { valid: false, reason: "Unable to read file header", error: "Unable to read file header" };
  }

  const headerStr = buffer.toString("utf8", 0, bytesRead).toLowerCase();
  if (
    headerStr.includes("<!doctype html") ||
    headerStr.includes("<html") ||
    headerStr.includes("<?xml") ||
    headerStr.includes("<error") ||
    headerStr.includes("{\"error\"") ||
    headerStr.includes("404 not found") ||
    headerStr.includes("403 forbidden") ||
    headerStr.includes("access denied")
  ) {
    return { valid: false, reason: "Downloaded file is an HTML or text error response, not audio", error: "HTML error page" };
  }

  if (stat.size < 64) {
    return { valid: false, reason: "File size is too small to be valid media", error: "File size is too small to be valid media" };
  }

  const format = ext.replace(".", "");
  return { valid: true, format };
}

export function extractZipSafely(
  zipFilePath: string,
  destDir: string,
  options: { audioOnly?: boolean } = { audioOnly: true }
): string[] {
  const zipBuffer = fs.readFileSync(zipFilePath);
  const extractedFiles: string[] = [];
  let offset = 0;

  while (offset < zipBuffer.length - 30) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      // Not a local file header; advance
      offset++;
      continue;
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

    const fileNameStart = offset + 30;
    const fileName = zipBuffer.toString("utf8", fileNameStart, fileNameStart + fileNameLength);

    if (fileName.includes("..") || fileName.startsWith("/") || fileName.startsWith("\\")) {
      // Ignore and skip malicious path traversal entries safely
      const dataStart = fileNameStart + fileNameLength + extraFieldLength;
      offset = dataStart + compressedSize;
      continue;
    }

    const dataStart = fileNameStart + fileNameLength + extraFieldLength;
    if (dataStart + compressedSize > zipBuffer.length) {
      break;
    }

    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);
    offset = dataStart + compressedSize;

    if (fileName.endsWith("/") || fileName.endsWith("\\")) {
      continue;
    }

    const cleanBaseName = path.basename(fileName);
    if (options.audioOnly && !AUDIO_EXTENSIONS.has(path.extname(cleanBaseName).toLowerCase())) {
      continue;
    }

    let uncompressedBuffer: Buffer;
    if (compressionMethod === 0) {
      uncompressedBuffer = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      try {
        uncompressedBuffer = zlib.inflateRawSync(compressedData);
      } catch {
        continue;
      }
    } else {
      continue;
    }

    const outPath = resolveSafeDestination(destDir, cleanBaseName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, uncompressedBuffer);
    extractedFiles.push(outPath);
  }

  return extractedFiles;
}

export class AcquisitionProviderRegistry {
  private readonly providers = new Map<string, AcquisitionProvider>();

  register(provider: AcquisitionProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): AcquisitionProvider[] {
    return Array.from(this.providers.values());
  }

  get(id: string): AcquisitionProvider | undefined {
    return this.providers.get(id);
  }

  canAcquire(candidate: SourceCandidate): boolean {
    for (const provider of this.providers.values()) {
      try {
        if (provider.canAcquire(candidate)) {
          return true;
        }
      } catch {}
    }
    return false;
  }

  async findProviders(candidate: SourceCandidate): Promise<AcquisitionProvider[]> {
    const matching: AcquisitionProvider[] = [];
    for (const provider of this.providers.values()) {
      try {
        if (await provider.canAcquire(candidate)) {
          matching.push(provider);
        }
      } catch {
        // Isolation per provider
      }
    }
    return matching;
  }

  async findProvider(candidate: SourceCandidate, preferredProviderId?: string): Promise<AcquisitionProvider | null> {
    const matching = await this.findProviders(candidate);
    if (matching.length === 0) return null;
    if (preferredProviderId) {
      const preferred = matching.find((p) => p.id === preferredProviderId);
      if (preferred) return preferred;
    }
    return matching[0];
  }
}

type ContainerJobMemory = {
  inFlight?: Promise<AcquisitionJob>;
  jobId: string;
};

export type AcquisitionServiceOptions = {
  analyzeImportedFile?: (file: AcquiredFile) => Promise<void>;
  limits?: Partial<AcquisitionLimits>;
  now?: () => number;
  musicRoot?: string;
  downloadDir?: string;
  baseDir?: string;
  tmpDir?: string;
  maxConcurrentDownloads?: number;
  maxConcurrent?: number;
  jobTimeoutMs?: number;
  autoScan?: boolean;
  autoScanLibrary?: boolean;
  autoScanLibraryAfterImport?: boolean;
  sourcePipeline?: SourcePipelineRegistry;
  spotifyResolver?: SpotifyTrackResolver;
  fetchImpl?: typeof fetch;
  downloaderRegistry?: DownloaderAdapterRegistry;
  processRunner?: ProcessRunner;
};

export class AcquisitionService {
  private taskManager?: TaskManager;
  private readonly managedTasks = new Map<string, string>();

  bindTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
    const interrupted = this.db.prepare("SELECT id FROM acquisition_jobs WHERE status = 'failed' AND error_code = 'SERVER_RESTARTED'")
      .all() as Array<{ id: string }>;
    for (const job of interrupted) {
      for (const type of ["SPOTDL_IMPORT", "SPOTDL_DOWNLOAD"] as const) {
        const pending = manager.findPending(type, { kind: "acquisition", jobId: job.id });
        if (pending) void manager.cancel(pending.id).catch((error) => {
          console.error("Could not reconcile interrupted acquisition task", error);
        });
      }
    }
    this.scheduleNext();
  }

  async runManagedJob(jobId: string, context: TaskRunContext): Promise<void> {
    const current = this.getJob(jobId);
    if (!current || current.status !== "queued" || this.activeControllers.has(jobId)) {
      throw new Error("Acquisition job is not queued or is already running");
    }
    await this.processJob(jobId, context);
    const job = this.getJob(jobId);
    if (job?.status === "cancelled") {
      const error = new Error("Acquisition cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (job?.status !== "completed") throw new Error(job?.errorMessage ?? "Acquisition failed");
  }
  private readonly queue: string[] = [];
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly inFlightContainers = new Map<string, ContainerJobMemory>();
  private readonly jobInputs = new Map<string, { candidate?: SourceCandidate; result?: UnifiedSearchResult; spotifyTrackUrl?: string }>();
  private readonly admissions = new Map<string, number>();
  private readonly submissionBuckets = new Map<string, { count: number; expires: number }>();
  private globalSubmissions = { count: 0, expires: 0 };
  private readonly runningJobs = new Set<string>();
  private readonly workers = new Set<Promise<void>>();
  private readonly limits: AcquisitionLimits;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private stopped = false;
  private activeCount = 0;
  private isProcessing = false;
  private readonly baseMusicDir: string;
  private readonly tmpRoot: string;
  private readonly sourcePipeline?: SourcePipelineRegistry;
  public readonly spotifyResolver: SpotifyTrackResolver;
  public readonly registry: AcquisitionProviderRegistry;
  public readonly downloaderRegistry: DownloaderAdapterRegistry;

  constructor(
    private readonly db: Db,
    registry: AcquisitionProviderRegistry,
    private readonly library: LibraryService,
    private readonly catalog: CatalogService,
    private readonly pluginsOrEmit: any,
    private readonly options: AcquisitionServiceOptions = {}
  ) {
    this.limits = resolveAcquisitionLimits(options.limits);
    this.now = options.now || Date.now;
    this.registry = registry;
    this.sourcePipeline = options.sourcePipeline;
    this.spotifyResolver = options.spotifyResolver || new SpotifyTrackResolver({ db: this.db, fetchImpl: options.fetchImpl });
    this.baseMusicDir = path.resolve(options.musicRoot || options.downloadDir || options.baseDir || "./data/music");
    this.tmpRoot = path.resolve(options.tmpDir || "./data/acquisitions/tmp");

    this.downloaderRegistry = options.downloaderRegistry || new DownloaderAdapterRegistry();
    if (!options.downloaderRegistry) {
      this.downloaderRegistry.register(new SpotDLDownloaderAdapter({ runner: options.processRunner }));
    }

    // Register DownloaderAcquisitionProvider for downloader adapters
    for (const adapter of this.downloaderRegistry.getAll()) {
      if (!this.registry.get(adapter.id)) {
        this.registry.register(new DownloaderAcquisitionProvider(adapter));
      }
    }

    fs.mkdirSync(this.baseMusicDir, { recursive: true });
    fs.mkdirSync(this.tmpRoot, { recursive: true });

    this.recoverUnfinishedJobs();
    this.cleanupHistory();
    this.cleanupTimer = setInterval(() => {
      try { this.cleanupHistory(); } catch (error) { console.error("Acquisition retention cleanup failed", error); }
    }, this.limits.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  private reserveSubmission(userId: string, ownerId = userId): () => void {
    if (this.stopped) throw new AcquisitionCapacityError();
    this.cleanupHistory();
    const now = this.now();
    for (const [id, bucket] of this.submissionBuckets) {
      if (bucket.expires <= now) this.submissionBuckets.delete(id);
    }
    if (this.globalSubmissions.expires <= now) this.globalSubmissions = { count: 0, expires: now + this.limits.submissionWindowMs };
    let bucket = this.submissionBuckets.get(userId);
    if ((!bucket && this.submissionBuckets.size >= this.limits.maxRateEntries)
      || this.globalSubmissions.count >= this.limits.submissionsGlobal
      || (bucket && bucket.count >= this.limits.submissionsPerUser)) {
      throw new AcquisitionCapacityError(Math.max(1, Math.ceil(((bucket?.expires ?? this.globalSubmissions.expires) - now) / 1000)));
    }
    if (!bucket) {
      bucket = { count: 0, expires: now + this.limits.submissionWindowMs };
      this.submissionBuckets.set(userId, bucket);
    }
    bucket.count++;
    this.globalSubmissions.count++;
    const pending = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS own FROM acquisition_jobs WHERE status = 'queued'").get(ownerId) as { total: number; own: number | null };
    const reserved = [...this.admissions.values()].reduce((sum, count) => sum + count, 0);
    if (pending.total + reserved >= this.limits.maxPending
      || (pending.own || 0) + (this.admissions.get(ownerId) || 0) >= this.limits.maxPendingPerUser) {
      throw new AcquisitionCapacityError();
    }
    this.admissions.set(ownerId, (this.admissions.get(ownerId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.admissions.get(ownerId) || 1) - 1;
      if (count) this.admissions.set(ownerId, count);
      else this.admissions.delete(ownerId);
    };
  }

  public cleanupHistory(): void {
    for (const [id, bucket] of this.submissionBuckets) {
      if (bucket.expires <= this.now()) this.submissionBuckets.delete(id);
    }
    const exclusions = [...this.runningJobs];
    const terminal = `status IN ('completed', 'failed', 'cancelled')${exclusions.length ? ` AND id NOT IN (${exclusions.map(() => "?").join(",")})` : ""}`;
    this.db.prepare(`DELETE FROM acquisition_jobs WHERE ${terminal}
      AND (updated_at < ? OR id IN (
        SELECT id FROM acquisition_jobs WHERE ${terminal} ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
      ))`).run(...exclusions, new Date(this.now() - this.limits.retentionMs).toISOString(), ...exclusions, this.limits.maxRetainedJobs);
    for (const id of this.jobInputs.keys()) {
      const job = this.getJob(id);
      if (!job || ["completed", "failed", "cancelled"].includes(job.status)) this.jobInputs.delete(id);
    }
    for (const [key, value] of this.inFlightContainers) {
      if (!this.runningJobs.has(value.jobId)) this.inFlightContainers.delete(key);
    }
  }

  public getMusicRoot(): string {
    return this.baseMusicDir;
  }

  private readonly eventListeners = new Set<(event: string, payload: Record<string, unknown>) => void>();

  public subscribe(listener: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Build a synthetic SourceCandidate that represents "acquire this track
   * directly through a downloader adapter" (e.g. spotDL), used when no
   * SourceDiscoveryProvider produced a candidate. Only returns a candidate
   * if at least one registered downloader adapter declares it can actually
   * handle the available input (Spotify identity or plain text query).
   */
  private buildDownloaderCandidate(
    result: UnifiedSearchResult,
    spotifyTrackUrl: string | undefined,
    spotifyTrackId: string | undefined,
    preferredProviderId?: string
  ): SourceCandidate | null {
    const query = [result.artist, result.title].filter(Boolean).join(" - ") || result.title;
    const adapters = this.downloaderRegistry.getAll();
    if (adapters.length === 0) return null;

    const request: DownloadRequest = {
      spotifyTrackUrl,
      spotifyTrackId,
      query,
      outputDirectory: "",
    };

    let chosen: DownloaderAdapter | undefined;
    if (preferredProviderId) {
      // If a specific provider was explicitly requested (e.g. the user
      // clicked "Download with spotDL"), only ever use that adapter — don't
      // silently fall back to a different downloader the user didn't ask for.
      chosen = adapters.find((a) => a.id === preferredProviderId && a.canHandle(request));
    } else {
      chosen = adapters.find((a) => a.canHandle(request));
    }
    if (!chosen) return null;

    return {
      id: spotifyTrackId ? `spotify:track:${spotifyTrackId}` : `${chosen.id}:query:${query}`,
      provider: chosen.id,
      kind: "track",
      title: result.title || undefined,
      artist: result.artist || undefined,
      album: (result as any).album || undefined,
      metadata: {
        acquisitionInputs: {
          spotifyTrackUrl,
          spotifyTrackId,
          inputMode: spotifyTrackUrl ? "spotify-url" : "text",
        },
        spotifyTrackUrl,
        spotifyTrackId,
      },
    };
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, payload);
      } catch {}
    }
    if (typeof this.pluginsOrEmit === "function") {
      this.pluginsOrEmit(event, payload);
    } else if (this.pluginsOrEmit && typeof this.pluginsOrEmit.emit === "function") {
      this.pluginsOrEmit.emit(event, payload);
    }
  }

  private getMaxConcurrent(): number {
    const serverSettings = listServerSettings(this.db) as Array<{ key: string; value: string }>;
    const configured = serverSettings.find(
      (s) => s.key === "acquisition.maxConcurrentDownloads" || s.key === "jobs.maxConcurrency"
    );
    if (configured) {
      try {
        const parsed = JSON.parse(configured.value);
        if (typeof parsed === "number" && parsed > 0) return Math.min(Math.max(1, Math.floor(parsed)), 10);
      } catch {}
    }

    try {
      const pluginRow = this.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = 'on-demand-library'").get() as any;
      if (pluginRow?.config_json) {
        const pluginConfig = JSON.parse(pluginRow.config_json);
        const max = pluginConfig.maxConcurrentDownloads ?? pluginConfig.maxConcurrent;
        if (typeof max === "number" && max > 0) return Math.min(Math.max(1, Math.floor(max)), 10);
      }
    } catch {}

    return this.options.maxConcurrentDownloads || this.options.maxConcurrent || 1;
  }

  private getDownloadDirectory(): string {
    return this.baseMusicDir;
  }

  private isAutoScanEnabled(): boolean {
    const serverSettings = listServerSettings(this.db) as Array<{ key: string; value: string }>;
    const configured = serverSettings.find((s) => s.key === "acquisition.autoScanLibrary");
    if (configured) {
      try {
        const parsed = JSON.parse(configured.value);
        if (typeof parsed === "boolean") return parsed;
      } catch {}
    }

    try {
      const pluginRow = this.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = 'on-demand-library'").get() as any;
      if (pluginRow?.config_json) {
        const pluginConfig = JSON.parse(pluginRow.config_json);
        if (typeof pluginConfig.autoScanLibraryAfterImport === "boolean") return pluginConfig.autoScanLibraryAfterImport;
        if (typeof pluginConfig.autoScan === "boolean") return pluginConfig.autoScan;
      }
    } catch {}

    if (this.options.autoScanLibraryAfterImport !== undefined) return this.options.autoScanLibraryAfterImport;
    if (this.options.autoScanLibrary !== undefined) return this.options.autoScanLibrary;
    if (this.options.autoScan !== undefined) return this.options.autoScan;
    return true;
  }

  private mapRowToJob(row: any): AcquisitionJob {
    let files: any[] = [];
    try {
      files = JSON.parse(row.files_json || "[]");
    } catch {}

    return {
      id: row.id,
      userId: row.user_id,
      status: row.status as AcquisitionJobStatus,
      sourceProvider: row.source_provider || undefined,
      sourceCandidateId: row.source_candidate_id || undefined,
      requestedTrackId: row.requested_track_id || undefined,
      requestedAlbumId: row.requested_album_id || undefined,
      requestedTitle: typeof row.requested_title === "string" ? row.requested_title : undefined,
      requestedArtist: typeof row.requested_artist === "string" ? row.requested_artist : undefined,
      containerId: row.container_id || undefined,
      stage: row.stage || undefined,
      autoPlay: Boolean(row.auto_play),
      progress: {
        bytesDownloaded: row.bytes_downloaded || 0,
        totalBytes: row.total_bytes || undefined,
        percent: row.percent || undefined,
        speedBytesPerSecond: row.speed_bytes_per_second || undefined,
        stage: row.stage || undefined,
      },
      files,
      errorCode: row.error_code || undefined,
      errorMessage: row.error_message ? safeAcquisitionFailure(row.status === "cancelled" ? "CANCELLED" : row.error_code) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
    };
  }

  private updateJobInDb(
    jobId: string,
    updates: {
      status?: AcquisitionJobStatus;
      sourceProvider?: string;
      sourceCandidateId?: string;
      bytesDownloaded?: number;
      totalBytes?: number;
      percent?: number;
      stage?: string;
      speedBytesPerSecond?: number;
      autoPlay?: boolean;
      files?: any[];
      errorCode?: string;
      errorMessage?: string;
      completedAt?: string;
    }
  ): void {
    const current = this.db.prepare("SELECT * FROM acquisition_jobs WHERE id = ?").get(jobId) as any;
    if (!current) return;

    const now = new Date(this.now()).toISOString();
    const status = updates.status || current.status;
    const sourceProvider = updates.sourceProvider !== undefined ? updates.sourceProvider : (current.source_provider ?? null);
    const sourceCandidateId = updates.sourceCandidateId !== undefined ? updates.sourceCandidateId : (current.source_candidate_id ?? null);
    const bytesDownloaded = updates.bytesDownloaded !== undefined ? updates.bytesDownloaded : (current.bytes_downloaded ?? 0);
    const totalBytes = updates.totalBytes !== undefined ? updates.totalBytes : (current.total_bytes ?? null);
    const percent = updates.percent !== undefined ? updates.percent : (current.percent ?? 0);
    const stage = updates.stage !== undefined ? updates.stage : (current.stage ?? null);
    const speedBytesPerSecond = updates.speedBytesPerSecond !== undefined ? updates.speedBytesPerSecond : (current.speed_bytes_per_second ?? null);
    const autoPlay = updates.autoPlay !== undefined ? (updates.autoPlay ? 1 : 0) : (current.auto_play ?? 0);
    const filesJson = updates.files !== undefined ? JSON.stringify(updates.files) : (current.files_json ?? "[]");
    const errorCode = updates.errorCode !== undefined ? updates.errorCode : (current.error_code ?? null);
    const errorMessage = updates.errorMessage !== undefined ? updates.errorMessage : (current.error_message ?? null);
    const completedAt = updates.completedAt !== undefined ? updates.completedAt
      : ["completed", "failed", "cancelled"].includes(status) ? (current.completed_at || now) : null;

    this.db.prepare(`
      UPDATE acquisition_jobs SET
        status = ?,
        source_provider = ?,
        source_candidate_id = ?,
        bytes_downloaded = ?,
        total_bytes = ?,
        percent = ?,
        stage = ?,
        speed_bytes_per_second = ?,
        auto_play = ?,
        files_json = ?,
        error_code = ?,
        error_message = ?,
        updated_at = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      status ?? null,
      sourceProvider ?? null,
      sourceCandidateId ?? null,
      bytesDownloaded ?? 0,
      totalBytes ?? null,
      percent ?? 0,
      stage ?? null,
      speedBytesPerSecond ?? null,
      autoPlay ?? 0,
      filesJson ?? "[]",
      errorCode ?? null,
      errorMessage ?? null,
      now,
      completedAt ?? null,
      jobId
    );
  }

  async recoverUnfinishedJobs(): Promise<void> {
    const unfinished = this.db.prepare(`
      SELECT * FROM acquisition_jobs
      WHERE status IN ('queued', 'discovering', 'downloading', 'processing', 'importing')
    `).all() as any[];

    for (const row of unfinished) {
      this.updateJobInDb(row.id, {
        status: "failed",
        errorCode: "SERVER_RESTARTED",
        errorMessage: "Acquisition was interrupted by server restart",
      });
      const tmpDir = path.join(this.tmpRoot, row.id);
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  async createJob(
    userIdOrInput: string | (AcquisitionCreateOptions & { userId: string }),
    maybeInput?: AcquisitionCreateOptions
  ): Promise<AcquisitionJob> {
    currentPrivacyManager()?.assertExternalAllowed("imports");
    const userId = typeof userIdOrInput === "string" ? userIdOrInput : userIdOrInput.userId;
    const input: AcquisitionCreateOptions = typeof userIdOrInput === "string" ? (maybeInput || {}) : userIdOrInput;
    for (const url of [input.spotifyTrackUrl, input.spotifyUrl]) {
      if (url !== undefined) canonicalSpotifyUrl(url);
    }
    if (input.result) {
      validateCandidateDownloadUrls({ id: input.result.id, provider: "spotdl", metadata: input.result.metadata });
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 65_536) throw new AcquisitionValidationError();
    const release = this.reserveSubmission(userId);
    try {
      return await this.createReservedJob(userId, input, release);
    } finally {
      release();
      this.cleanupHistory();
    }
  }

  private async createReservedJob(userId: string, input: AcquisitionCreateOptions, release: () => void): Promise<AcquisitionJob> {
    if (input.candidate) {
      try {
        validateCandidateDownloadUrls(input.candidate);
      } catch (error) {
        // Only a server-registered provider accepting the candidate under its
        // own policy can handle other sources. SpotDL always revalidates.
        const providers = await this.registry.findProviders(input.candidate);
        if (input.candidate.provider === "spotdl" || !providers.some((provider) => !(provider instanceof DownloaderAcquisitionProvider))) throw error;
      }
    }
    const id = createId("acq");
    const now = new Date(this.now()).toISOString();

    const trackId = input.trackId || (input.result?.type === "track" ? input.result.id : undefined);
    const albumId = input.albumId || (input.result?.type === "album" ? input.result.id : undefined);
    const candidateId = input.candidateId || input.candidate?.id;
    let candidate = input.candidate;
    if (!candidate && candidateId) {
      candidate = { id: candidateId, provider: input.sourceProvider || "unknown" };
    }
    let result = input.result;

    if (!result && trackId) {
      try {
        const track = await this.catalog.getTrack(trackId);
        if (track) {
          result = {
            id: track.id,
            type: "track",
            title: track.title,
            subtitle: track.artistName || null,
            artist: track.artistName || null,
            album: track.albumName || null,
            artwork: track.artworkUrl ? { id: track.artworkId || track.artworkUrl, url: track.artworkUrl } : null,
            availability: (track as any).availability || null,
            provider: "library",
            source: { kind: "library", count: 1 },
            metadata: { durationSeconds: (track as any).durationSeconds || (track as any).duration },
          };
        }
      } catch {}
    } else if (!result && albumId) {
      try {
        const album = await this.catalog.getAlbum(albumId);
        if (album) {
          result = {
            id: album.id,
            type: "album",
            title: album.name,
            subtitle: album.artistName || null,
            artist: album.artistName || null,
            album: album.name,
            artwork: album.artworkUrl ? { id: album.artworkId || album.artworkUrl, url: album.artworkUrl } : null,
            availability: (album as any).availability || null,
            provider: "library",
            source: { kind: "library", count: 1 },
            metadata: {},
          };
        }
      } catch {}
    }

    const containerId = candidate?.container?.id || candidate?.id || (albumId ? `album:${albumId}` : input.containerId);

    // 1. Deduplication check: does recording already exist in local library?
    if (result && result.type === "track") {
      try {
        const localSearch = await this.catalog.search(result.title, ["tracks"]);
        const requestedTitle = normalizeMusicText(result.title);
        const requestedArtist = normalizeMusicText(result.artist);
        const requestedAlbum = normalizeMusicText(result.album);
        const requestedVersion = versionSignature(result.title);

        const existing = (localSearch.tracks || []).find((t) => {
          const titleMatches = normalizeMusicText(t.title) === requestedTitle;
          const artistMatches = normalizeMusicText(t.artistName) === requestedArtist;
          const albumMatches = !requestedAlbum || normalizeMusicText(t.albumName) === requestedAlbum;
          const versionMatches = versionSignature(t.title) === requestedVersion;
          return titleMatches && artistMatches && albumMatches && versionMatches;
        });

        if (existing) {
          const files = [{ path: existing.id, status: "already_in_library" }];
          this.db.prepare(`
            INSERT INTO acquisition_jobs (
              id, user_id, status, source_provider, source_candidate_id,
              requested_track_id, requested_album_id, container_id,
              bytes_downloaded, total_bytes, percent, stage, speed_bytes_per_second, auto_play, files_json,
              created_at, updated_at, completed_at
            ) VALUES (?, ?, 'completed', 'local-library', ?, ?, ?, ?, 0, 0, 100, 'completed', null, ?, ?, ?, ?, ?)
          `).run(id, userId, existing.id, trackId || null, albumId || null, containerId || null, input.autoPlay ? 1 : 0, JSON.stringify(files), now, now, now);

          const job = this.getJob(id)!;
          this.emitEvent("acquisition.created", { jobId: id, userId, status: "completed", alreadyInLibrary: true, autoPlay: input.autoPlay });
          this.emitEvent("acquisition.completed", { jobId: id, userId, status: "completed", files, autoPlay: input.autoPlay, trackId });
          return job;
        }
      } catch {}
    }

    // 2. Container deduplication check: is this container already in cache or in-flight?
    if (containerId) {
      const cachedContainer = this.db.prepare("SELECT * FROM acquisition_containers WHERE container_key = ?").get(containerId) as any;
      if (cachedContainer && cachedContainer.status === "ready") {
        let files: any[] = [];
        try { files = JSON.parse(cachedContainer.files_json || "[]"); } catch {}
        if (files.length > 0) {
          this.db.prepare(`
            INSERT INTO acquisition_jobs (
              id, user_id, status, source_provider, source_candidate_id,
              requested_track_id, requested_album_id, container_id,
              bytes_downloaded, total_bytes, percent, stage, speed_bytes_per_second, auto_play, files_json,
              created_at, updated_at, completed_at
            ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, 0, 0, 100, 'completed', null, ?, ?, ?, ?, ?)
          `).run(id, userId, cachedContainer.provider_id, cachedContainer.job_id, trackId || null, albumId || null, containerId, input.autoPlay ? 1 : 0, JSON.stringify(files), now, now, now);

          const job = this.getJob(id)!;
          this.emitEvent("acquisition.created", { jobId: id, userId, status: "completed", containerReused: true, autoPlay: input.autoPlay });
          this.emitEvent("acquisition.completed", { jobId: id, userId, status: "completed", files, autoPlay: input.autoPlay, trackId });
          return job;
        }
      }
    }

    const retainedInput = { candidate, result, spotifyTrackUrl: input.spotifyTrackUrl || input.spotifyUrl };
    // The duplicate check and insert share one synchronous transaction, so
    // concurrent submissions for the same item cannot both create a job.
    const activeDuplicateId = this.db.transaction((): string | null => {
      const duplicate = this.findActiveDuplicate(userId, { trackId, albumId });
      if (duplicate) return duplicate;
      this.db.prepare(`
        INSERT INTO acquisition_jobs (
          id, user_id, status, source_provider, source_candidate_id,
          requested_track_id, requested_album_id, container_id,
          bytes_downloaded, total_bytes, percent, stage, speed_bytes_per_second, auto_play, files_json,
          created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, 0, null, 0, 'queued', null, ?, '[]', ?, ?)
      `).run(
        id,
        userId,
        candidate?.provider || input.sourceProvider || null,
        candidate?.id || null,
        trackId || null,
        albumId || null,
        containerId || null,
        input.autoPlay ? 1 : 0,
        now,
        now
      );
      this.db.prepare("INSERT INTO acquisition_job_inputs (job_id, input_json) VALUES (?, ?)").run(
        id, JSON.stringify(retainedInput)
      );
      return null;
    })();
    if (activeDuplicateId) {
      const existing = this.getJob(activeDuplicateId);
      if (existing) return existing;
    }
    this.jobInputs.set(id, retainedInput);

    const job = this.getJob(id)!;
    this.emitEvent("acquisition.created", {
      jobId: id,
      userId,
      status: "queued",
      trackId,
      albumId,
      title: result?.title,
      artist: result?.artist,
      autoPlay: input.autoPlay,
    });

    this.queue.push(id);
    release();
    this.scheduleNext();

    return job;
  }

  /**
   * Returns this user's unfinished job for the same requested item, if any.
   * Matching is per user so job details never leak across accounts; jobs from
   * different users for one album still share a download via container reuse.
   */
  private findActiveDuplicate(
    userId: string,
    item: { trackId?: string; albumId?: string }
  ): string | null {
    const active = "status IN ('queued', 'discovering', 'downloading', 'processing', 'importing')";
    let row: { id: string } | undefined;
    if (item.trackId) {
      row = this.db.prepare(`SELECT id FROM acquisition_jobs WHERE user_id = ? AND ${active}
        AND requested_track_id = ? ORDER BY created_at, rowid LIMIT 1`).get(userId, item.trackId) as { id: string } | undefined;
    } else if (item.albumId) {
      row = this.db.prepare(`SELECT id FROM acquisition_jobs WHERE user_id = ? AND ${active}
        AND requested_album_id = ? AND requested_track_id IS NULL ORDER BY created_at, rowid LIMIT 1`).get(userId, item.albumId) as { id: string } | undefined;
    }
    return row?.id ?? null;
  }

  getJob(jobId: string, userId?: string, isAdmin = false): AcquisitionJob | null {
    let query = "SELECT * FROM acquisition_jobs WHERE id = ?";
    const params: any[] = [jobId];

    if (userId && !isAdmin) {
      query += " AND user_id = ?";
      params.push(userId);
    }

    const row = this.db.prepare(query).get(...params) as any;
    return row ? this.mapRowToJob(row) : null;
  }

  listJobs(userId?: string, isAdmin = false): AcquisitionJob[] {
    let query = `SELECT jobs.*,
      CASE WHEN json_valid(inputs.input_json) THEN COALESCE(json_extract(inputs.input_json, '$.result.title'), json_extract(inputs.input_json, '$.candidate.title')) END AS requested_title,
      CASE WHEN json_valid(inputs.input_json) THEN COALESCE(json_extract(inputs.input_json, '$.result.artist'), json_extract(inputs.input_json, '$.candidate.artist')) END AS requested_artist
      FROM acquisition_jobs jobs LEFT JOIN acquisition_job_inputs inputs ON inputs.job_id = jobs.id`;
    const params: any[] = [];

    if (userId && !isAdmin) {
      query += " WHERE jobs.user_id = ?";
      params.push(userId);
    }

    query += " ORDER BY jobs.created_at DESC LIMIT 100";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => this.mapRowToJob(r));
  }

  async cancelJob(jobId: string, userId?: string, isAdmin = false): Promise<boolean> {
    const job = this.getJob(jobId, userId, isAdmin);
    if (!job) return false;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return false;
    }

    const controller = this.activeControllers.get(jobId);
    if (controller) {
      controller.abort();
    }
    const taskId = this.managedTasks.get(jobId);
    if (taskId && this.taskManager) {
      const task = this.taskManager.get(taskId);
      if (task && ["QUEUED", "PROCESSING", "PAUSED"].includes(task.state)) {
        await this.taskManager.cancel(taskId);
      }
    }
    const queuedIndex = this.queue.indexOf(jobId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.jobInputs.delete(jobId);

    this.updateJobInDb(jobId, { status: "cancelled", errorMessage: "Cancelled by user" });

    const tmpDir = path.join(this.tmpRoot, jobId);
    if (!controller && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (error) {
        console.warn("Could not remove cancelled acquisition staging files", error);
      }
    }

    this.emitEvent("acquisition.cancelled", { jobId, userId: job.userId, status: "cancelled" });
    return true;
  }

  async retryJob(jobId: string, userId?: string, isAdmin = false): Promise<AcquisitionJob> {
    currentPrivacyManager()?.assertExternalAllowed("imports");
    const job = this.getJob(jobId, userId, isAdmin);
    if (!job) throw new AcquisitionJobError("ACQUISITION_NOT_FOUND");
    if (!["failed", "cancelled"].includes(job.status) || this.runningJobs.has(jobId)) {
      throw new AcquisitionJobError("ACQUISITION_NOT_RETRYABLE");
    }
    const release = this.reserveSubmission(userId || job.userId, job.userId);
    try {
      if (!this.getJob(jobId)) throw new AcquisitionJobError("ACQUISITION_NOT_FOUND");
      const saved = this.db.prepare("SELECT input_json FROM acquisition_job_inputs WHERE job_id = ?").get(jobId) as { input_json: string } | undefined;
      if (saved) this.jobInputs.set(jobId, JSON.parse(saved.input_json));
      this.db.prepare("UPDATE acquisition_jobs SET error_code = NULL, error_message = NULL, completed_at = NULL, total_bytes = NULL WHERE id = ?").run(jobId);
      this.updateJobInDb(jobId, { status: "queued", stage: "queued", bytesDownloaded: 0, percent: 0 });

      const updated = this.getJob(jobId)!;
      this.queue.push(jobId);
      release();
      this.scheduleNext();
      return updated;
    } finally { release(); }
  }

  private scheduleNext(): void {
    if (this.isProcessing || this.stopped) return;

    const maxConcurrent = this.getMaxConcurrent();
    while (this.activeCount < maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      this.runningJobs.add(jobId);
      this.activeCount++;
      const worker = this.dispatchJob(jobId)
        .catch((error) => {
          console.error("Acquisition worker failed", error);
          this.updateJobInDb(jobId, { status: "failed", errorCode: "ACQUISITION_FAILED", errorMessage: "Acquisition worker failed" });
        })
        .finally(() => {
          this.runningJobs.delete(jobId);
          this.managedTasks.delete(jobId);
          this.jobInputs.delete(jobId);
          for (const [key, value] of this.inFlightContainers) {
            if (value.jobId === jobId) this.inFlightContainers.delete(key);
          }
          this.activeCount--;
          this.cleanupHistory();
          this.scheduleNext();
          this.workers.delete(worker);
        });
      this.workers.add(worker);
    }
  }

  private async dispatchJob(jobId: string): Promise<void> {
    if (!this.taskManager) return this.processJob(jobId);
    const job = this.getJob(jobId);
    if (!job) throw new Error("Acquisition job not found");
    const task = this.taskManager.enqueue("SPOTDL_IMPORT", { kind: "acquisition", jobId }, job.userId);
    this.managedTasks.set(jobId, task.id);
    const settled = await this.taskManager.waitForSettlement(task.id);
    if (settled.state === "CANCELLED" && this.getJob(jobId)?.status === "queued") {
      this.updateJobInDb(jobId, { status: "cancelled", errorCode: "CANCELLED", errorMessage: "Cancelled by user" });
      this.emitEvent("acquisition.cancelled", { jobId, userId: job.userId, status: "cancelled" });
    }
    if (settled.state === "FAILED" && this.getJob(jobId)?.status === "queued") {
      throw new Error("Managed acquisition worker failed");
    }
  }

  private async processJob(jobId: string, task?: TaskRunContext): Promise<void> {
    const job = this.getJob(jobId);
    if (!job || job.status === "cancelled" || job.status === "completed") {
      return;
    }

    const tmpDir = path.join(this.tmpRoot, jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);
    const abort = () => controller.abort();
    task?.signal.addEventListener("abort", abort, { once: true });
    if (task?.signal.aborted) controller.abort();
    const checkpoint = async () => {
      await task?.checkpoint();
      controller.signal.throwIfAborted();
    };

    const jobInput = this.jobInputs.get(jobId);
    this.jobInputs.delete(jobId);
    let candidate = jobInput?.candidate;
    let result = jobInput?.result;

    try {
      await checkpoint();
      // 1. Resolve recording (result) if not yet resolved
      if (!result) {
        if (job.requestedTrackId) {
          try {
            const track = await this.catalog.getTrack(job.requestedTrackId);
            if (track) {
              result = {
                id: track.id,
                type: "track",
                title: track.title,
                subtitle: track.artistName || null,
                artist: track.artistName || null,
                album: track.albumName || null,
                artwork: track.artworkUrl ? { id: track.artworkId || track.artworkUrl, url: track.artworkUrl } : null,
                availability: (track as any).availability || null,
                provider: "library",
                source: { kind: "library", count: 1 },
                metadata: { durationSeconds: (track as any).durationSeconds || (track as any).duration },
              };
            }
          } catch {}
        } else if (job.requestedAlbumId) {
          try {
            const album = await this.catalog.getAlbum(job.requestedAlbumId);
            if (album) {
              result = {
                id: album.id,
                type: "album",
                title: album.name,
                subtitle: album.artistName || null,
                artist: album.artistName || null,
                album: album.name,
                artwork: album.artworkUrl ? { id: album.artworkId || album.artworkUrl, url: album.artworkUrl } : null,
                availability: (album as any).availability || null,
                provider: "library",
                source: { kind: "library", count: 1 },
                metadata: {},
              };
            }
          } catch {}
        }
      }

      if (!candidate && job.sourceCandidateId) {
        candidate = {
          id: job.sourceCandidateId,
          provider: job.sourceProvider || "unknown",
        };
      }

      // 2. Discovery stage if candidate is not predetermined
      const candidateProviderPairs: Array<{ candidate: SourceCandidate; provider: AcquisitionProvider }> = [];

      if (!candidate && result) {
        this.updateJobInDb(jobId, { status: "discovering" });
        this.emitEvent("acquisition.started", { jobId, userId: job.userId, status: "discovering" });

        let spotifyTrackUrl = jobInput?.spotifyTrackUrl;
        let spotifyTrackId: string | undefined;

        try {
          const spotifyResolution = await this.spotifyResolver.resolve(result, {
            manualUrl: spotifyTrackUrl,
          });
          if (spotifyResolution) {
            spotifyTrackUrl = spotifyResolution.url;
            spotifyTrackId = spotifyResolution.trackId;
          }
        } catch {}


        let discoveredCandidates = (await this.sourcePipeline?.discover(result, {
          spotifyTrackUrl,
          spotifyTrackId,
        })) || [];

        // A downloader adapter (e.g. spotDL) can acquire a track directly from
        // a resolved Spotify identity, or via its own text/query search
        // (e.g. spotDL falls back to YouTube search), without needing a
        // separate SourceDiscoveryProvider (like site-sources) to produce a
        // candidate first. If no discovery-provider candidates were found,
        // synthesize a direct candidate for any registered downloader adapter
        // that declares it can handle this input, so it still gets a chance
        // to run via the normal candidate/provider matching below.
        //
        // Public Spotify web lookup often can't produce a URL (the public
        // search page is a client-rendered SPA with no server-side markup to
        // scrape), so we must not require a resolved Spotify identity when
        // the caller explicitly requested a specific downloader provider
        // (e.g. the user clicked "Download with spotDL") — otherwise that
        // explicit choice would never be reachable for tracks Spotify lookup
        // fails on. We only fall back to a bare text-query candidate when a
        // provider was explicitly requested, to avoid every unrelated/failed
        // discovery silently kicking off an uncontrolled external download.
        if (discoveredCandidates.length === 0 && (spotifyTrackUrl || spotifyTrackId || job.sourceProvider)) {
          const downloaderCandidate = this.buildDownloaderCandidate(result, spotifyTrackUrl, spotifyTrackId, job.sourceProvider);
          if (downloaderCandidate) {
            discoveredCandidates = [downloaderCandidate];
          }
        }

        if (discoveredCandidates.length === 0) {
          this.updateJobInDb(jobId, {
            status: "failed",
            errorCode: "NO_CANDIDATES",
            errorMessage: "No candidates found for requested recording",
          });
          this.emitEvent("acquisition.failed", {
            jobId,
            userId: job.userId,
            status: "failed",
            errorCode: "NO_CANDIDATES",
            errorMessage: "No candidates found for requested recording",
          });
          return;
        }

        // Filter out preview-only sources! Preview sources must NEVER be used for acquisition.
        const nonPreviewCandidates = discoveredCandidates.filter((cand) => {
          if (cand.metadata?.preview || (cand.quality as any)?.preview) return false;
          if (cand.provider === "itunes-preview" || cand.id.startsWith("preview:") || cand.id.includes("itunes.apple.com")) return false;
          return true;
        });

        // Find acquireable candidates and their matching providers
        for (const cand of nonPreviewCandidates) {
          const provs = await this.registry.findProviders(cand);
          for (const prov of provs) {
            candidateProviderPairs.push({ candidate: cand, provider: prov });
          }
        }


        if (candidateProviderPairs.length === 0) {
          this.updateJobInDb(jobId, {
            status: "failed",
            errorCode: "NO_ACQUIREABLE_SOURCE",
            errorMessage: "No acquireable source found for discovered candidates",
          });
          this.emitEvent("acquisition.failed", {
            jobId,
            userId: job.userId,
            status: "failed",
            errorCode: "NO_ACQUIREABLE_SOURCE",
            errorMessage: "No acquireable source found for discovered candidates",
          });
          return;
        }

        // Sort / prioritize if user or job has preferred provider
        const preferredProvider = job.sourceProvider;
        if (preferredProvider) {
          candidateProviderPairs.sort((a, b) => (a.provider.id === preferredProvider ? -1 : b.provider.id === preferredProvider ? 1 : 0));
        }
      } else if (candidate) {
        const provs = await this.registry.findProviders(candidate);
        for (const prov of provs) {
          candidateProviderPairs.push({ candidate, provider: prov });
        }
      }

      if (candidateProviderPairs.length === 0) {
        this.updateJobInDb(jobId, {
          status: "failed",
          errorCode: "NO_ACQUIREABLE_SOURCE",
          errorMessage: "No acquireable source candidate found for requested recording",
        });
        this.emitEvent("acquisition.failed", {
          jobId,
          userId: job.userId,
          status: "failed",
          errorCode: "NO_ACQUIREABLE_SOURCE",
          errorMessage: "No acquireable source candidate found for requested recording",
        });
        return;
      }

      // Check if container already in flight / cached
      const firstCandidate = candidateProviderPairs[0].candidate;
      const containerKey = firstCandidate.container?.id || job.containerId;
      if (containerKey && this.inFlightContainers.has(containerKey)) {
        const inFlight = this.inFlightContainers.get(containerKey)!;
        if (inFlight.jobId !== jobId) {
          const parentJob = await inFlight.inFlight;
          if (parentJob && parentJob.status === "completed") {
            this.updateJobInDb(jobId, {
              status: "completed",
              files: parentJob.files,
              completedAt: new Date().toISOString(),
            });
            this.emitEvent("acquisition.completed", { jobId, userId: job.userId, status: "completed", files: parentJob.files });
            return;
          }
        }
      }

      if (containerKey) {
        this.inFlightContainers.set(containerKey, {
          jobId,
          inFlight: Promise.resolve(job),
        });
      }

      // 3. Perform download via provider with fallback across candidates/providers
      let acquisitionResult: AcquisitionResult | null = null;
      let selectedCandidate: SourceCandidate | null = null;
      let selectedProvider: AcquisitionProvider | null = null;
      let lastError: any = null;

      let lastProgressUpdate = 0;
      const context: AcquisitionContext = {
        jobId,
        tmpDir,
        signal: controller.signal,
        checkpoint,
        onLog: (source, message) => task?.log?.(source, message),
        onProgress: (bytesDownloaded, totalBytes, percentOrDetails, speedBytesPerSecond, stage) => {
          const now = Date.now();
          let percentVal: number | undefined;
          let speedVal = speedBytesPerSecond;
          let stageVal = stage;

          if (typeof percentOrDetails === "object" && percentOrDetails !== null) {
            percentVal = percentOrDetails.percent;
            speedVal = percentOrDetails.speedBytesPerSecond ?? speedVal;
            stageVal = percentOrDetails.stage ?? stageVal;
          } else if (typeof percentOrDetails === "number") {
            percentVal = percentOrDetails;
          }

          const percent = percentVal !== undefined
            ? percentVal
            : (totalBytes && totalBytes > 0 ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100)) : undefined);

          if (now - lastProgressUpdate > 250 || percent === 100 || stageVal) {
            lastProgressUpdate = now;
            task?.report({
              percent, speedBytesPerSecond: speedVal,
              message: [stageVal ?? "downloading", candidate?.artist, candidate?.title].filter(Boolean).join(" - "),
            });
            this.updateJobInDb(jobId, {
              bytesDownloaded,
              totalBytes,
              percent,
              speedBytesPerSecond: speedVal,
              stage: stageVal,
            });
            this.emitEvent("acquisition.progress", {
              jobId,
              userId: job.userId,
              bytesDownloaded,
              totalBytes,
              percent,
              speedBytesPerSecond: speedVal,
              stage: stageVal,
              autoPlay: job.autoPlay,
            });
          }
        },
      };

      for (const pair of candidateProviderPairs) {
        await checkpoint();

        selectedCandidate = pair.candidate;
        selectedProvider = pair.provider;


        this.updateJobInDb(jobId, {
          status: "downloading",
          sourceProvider: selectedProvider.id,
          sourceCandidateId: selectedCandidate.id,
          stage: "downloading",
        });
        this.emitEvent("acquisition.started", { jobId, userId: job.userId, status: "downloading", stage: "downloading", autoPlay: job.autoPlay });

        try {
          acquisitionResult = await selectedProvider.acquire(selectedCandidate, context);
          if (acquisitionResult && Array.isArray(acquisitionResult.files) && acquisitionResult.files.length > 0) {
            break;
          }
        } catch (err) {
          lastError = err;
          if (controller.signal.aborted) throw err;
        }
      }

      if (!acquisitionResult || !Array.isArray(acquisitionResult.files) || acquisitionResult.files.length === 0) {
        if (lastError) throw lastError;
        throw new Error("Acquisition provider did not produce any audio files");
      }

      // 4. Processing & Validation stage
      this.updateJobInDb(jobId, { status: "processing", stage: "processing" });
      this.emitEvent("acquisition.processing", { jobId, userId: job.userId, status: "processing", stage: "processing", autoPlay: job.autoPlay });

      const validatedFiles: AcquiredFile[] = [];
      for (const file of acquisitionResult.files) {
        await checkpoint();
        const val = validateAudioFile(file.path);
        if (!val.valid) {
          throw new Error(`Audio validation failed for ${path.basename(file.path)}: ${val.reason}`);
        }
        validatedFiles.push(file);
      }

      // 5. Importing stage
      this.updateJobInDb(jobId, { status: "importing", stage: "importing" });
      this.emitEvent("acquisition.importing", { jobId, userId: job.userId, status: "importing", stage: "importing", autoPlay: job.autoPlay });

      const downloadDir = this.getDownloadDirectory();
      const importedFiles: Array<{ path: string; title?: string; artist?: string; album?: string; size?: number; status: string }> = [];

      for (let i = 0; i < validatedFiles.length; i++) {
        await checkpoint();
        const file = validatedFiles[i];
        const artistName = file.artist || selectedCandidate?.artist || result?.artist || "Unknown Artist";
        const albumName = file.album || selectedCandidate?.album || result?.album || "Unknown Album";
        const trackTitle = file.title || selectedCandidate?.title || result?.title || path.basename(file.path, path.extname(file.path));
        const ext = path.extname(file.path) || ".flac";

        const trackNum = file.trackNumber !== undefined ? `${String(file.trackNumber).padStart(2, "0")} - ` : "";
        const fileName = `${trackNum}${trackTitle}${ext}`;
        const destPath = selectedProvider?.id === "spotdl"
          ? path.resolve(downloadDir, path.relative(tmpDir, file.path))
          : resolveSafeDestination(downloadDir, artistName, albumName, fileName);
        const relativeDestPath = path.relative(this.baseMusicDir, destPath);
        if (
          relativeDestPath === "" ||
          relativeDestPath.startsWith(`..${path.sep}`) ||
          relativeDestPath === ".." ||
          path.isAbsolute(relativeDestPath)
        ) {
          throw new Error(`Import destination is outside MUSIC_ROOT: ${destPath}`);
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const alreadyPresent = fs.existsSync(destPath) && fs.statSync(destPath).isFile() && fs.statSync(destPath).size > 0;
        if (!alreadyPresent) {
          const pendingPath = `${destPath}.musicdeck-importing`;
          try {
            fs.copyFileSync(file.path, pendingPath);
            fs.renameSync(pendingPath, destPath);
          } finally {
            if (fs.existsSync(pendingPath)) {
              fs.rmSync(pendingPath, { force: true });
            }
          }
        }

        const stat = fs.statSync(destPath);
        if (!stat.isFile() || stat.size === 0) {
          throw new Error(`Imported audio file was not written to MUSIC_ROOT: ${destPath}`);
        }
        try {
          await this.options.analyzeImportedFile?.({ ...file, path: destPath, title: trackTitle, artist: artistName, album: albumName });
        } catch (error) {
          console.warn("Imported track loudness analysis unavailable; playback will analyze on demand", error);
        }
        importedFiles.push({
          path: destPath,
          title: trackTitle,
          artist: artistName,
          album: albumName,
          size: stat.size,
          status: alreadyPresent ? "already_in_library" : "imported",
        });
        task?.report({
          itemsProcessed: i + 1,
          totalItems: validatedFiles.length,
          message: "Importing tracks",
        });

        // Register in LibraryService
        try {
          this.library.ensureId("track", {
            connectionId: "library",
            providerItemId: destPath,
          });
        } catch {}
      }

      // Trigger backend library scan if auto-scan is enabled
      if (this.isAutoScanEnabled()) {
        try {
          const scan = await this.catalog.scanLibrary(task);
          if (scan.failures.length) console.warn("Some library providers could not be scanned after import", scan.failures);
        } catch (error) {
          controller.signal.throwIfAborted();
          console.warn("Could not scan library after import", error);
        }
      }
      await checkpoint();

      // 6. Complete job
      const completedAt = new Date().toISOString();
      this.updateJobInDb(jobId, {
        status: "completed",
        stage: "completed",
        percent: 100,
        files: importedFiles,
        completedAt,
      });

      // Update container cache
      if (containerKey && selectedProvider) {
        this.db.prepare(`
          INSERT INTO acquisition_containers (container_key, provider_id, job_id, status, files_json, created_at, updated_at)
          VALUES (?, ?, ?, 'ready', ?, ?, ?)
          ON CONFLICT(container_key) DO UPDATE SET
            status = 'ready',
            files_json = excluded.files_json,
            updated_at = excluded.updated_at
        `).run(containerKey, selectedProvider.id, jobId, JSON.stringify(importedFiles), completedAt, completedAt);
      }

      this.emitEvent("acquisition.completed", {
        jobId,
        userId: job.userId,
        status: "completed",
        stage: "completed",
        files: importedFiles,
        completedAt,
        autoPlay: job.autoPlay,
        trackId: job.requestedTrackId,
        albumId: job.requestedAlbumId,
      });
      this.emitEvent("library.imported", {
        jobId,
        userId: job.userId,
        files: importedFiles,
        count: importedFiles.length,
      });
    } catch (err: any) {
      const isAborted = controller.signal.aborted || /abort/i.test(err?.message || "");
      const isNoCandidates = err?.code === "NO_CANDIDATES" || /no candidates/i.test(err?.message || "");
      const isNoAcquireable = err?.code === "NO_ACQUIREABLE_SOURCE" || /no acquireable source/i.test(err?.message || "");
      const status: AcquisitionJobStatus = isAborted ? "cancelled" : "failed";
      const errorCode = isAborted
        ? "CANCELLED"
        : isNoCandidates
          ? "NO_CANDIDATES"
          : isNoAcquireable
            ? "NO_ACQUIREABLE_SOURCE"
            : "ACQUISITION_FAILED";
      const errorMessage = safeAcquisitionFailure(errorCode);
      if (!isAborted) {
        serverLogs.push({
          level: "error", source: "server", message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined, meta: { jobId, operation: "acquisition" },
        });
      }

      this.updateJobInDb(jobId, {
        status,
        stage: status,
        errorCode,
        errorMessage,
      });

      if (isAborted) {
        this.emitEvent("acquisition.cancelled", { jobId, userId: job.userId, status: "cancelled", stage: "cancelled", autoPlay: job.autoPlay });
      } else {
        this.emitEvent("acquisition.failed", { jobId, userId: job.userId, status: "failed", stage: "failed", errorCode, errorMessage, autoPlay: job.autoPlay });
      }
    } finally {
      task?.signal.removeEventListener("abort", abort);
      this.activeControllers.delete(jobId);
      if (candidate?.container?.id) {
        this.inFlightContainers.delete(candidate.container.id);
      }
      if (job.containerId) {
        this.inFlightContainers.delete(job.containerId);
      }

      // Clean up temporary files
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (error) {
          console.warn("Could not remove acquisition staging files", error);
        }
      }
    }
  }

  async getAdminSummary(): Promise<AcquisitionAdminSummary> {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'downloading' OR status = 'processing' OR status = 'importing' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'queued' OR status = 'discovering' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM acquisition_jobs
    `).get() as any;

    let storageUsedBytes = 0;
    const downloadDir = this.getDownloadDirectory();
    if (fs.existsSync(downloadDir)) {
      try {
        const calculateDirSize = (dir: string): number => {
          let size = 0;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              size += calculateDirSize(fullPath);
            } else if (entry.isFile()) {
              size += fs.statSync(fullPath).size;
            }
          }
          return size;
        };
        storageUsedBytes = calculateDirSize(downloadDir);
      } catch {}
    }

    let tempStorageUsedBytes = 0;
    if (fs.existsSync(this.tmpRoot)) {
      try {
        const calculateDirSize = (dir: string): number => {
          let size = 0;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              size += calculateDirSize(fullPath);
            } else if (entry.isFile()) {
              size += fs.statSync(fullPath).size;
            }
          }
          return size;
        };
        tempStorageUsedBytes = calculateDirSize(this.tmpRoot);
      } catch {}
    }

    const recentRows = this.db.prepare("SELECT * FROM acquisition_jobs ORDER BY created_at DESC LIMIT 20").all() as any[];
    const recentJobs = recentRows.map((r) => this.mapRowToJob(r));

    return {
      activeJobs: counts?.active || 0,
      queuedJobs: counts?.queued || 0,
      completedJobs: counts?.completed || 0,
      failedJobs: counts?.failed || 0,
      totalJobs: counts?.total || 0,
      storageUsedBytes,
      tempStorageUsedBytes,
      musicRoot: this.baseMusicDir,
      downloadDirectory: downloadDir,
      maxConcurrentDownloads: this.getMaxConcurrent(),
      autoScanLibrary: this.isAutoScanEnabled(),
      cleanupPolicy: "on_completion",
      recentJobs,
    };
  }

  async cleanupTempStorage(): Promise<{ filesRemoved: number; bytesFreed: number }> {
    let filesRemoved = 0;
    let bytesFreed = 0;

    if (fs.existsSync(this.tmpRoot)) {
      const entries = fs.readdirSync(this.tmpRoot, { withFileTypes: true });
      for (const entry of entries) {
        // Do not remove active job temp folders
        if (this.activeControllers.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(this.tmpRoot, entry.name);
        try {
          if (entry.isDirectory()) {
            const getDirStats = (dir: string) => {
              for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, sub.name);
                if (sub.isDirectory()) getDirStats(p);
                else if (sub.isFile()) {
                  bytesFreed += fs.statSync(p).size;
                  filesRemoved++;
                }
              }
            };
            getDirStats(fullPath);
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            bytesFreed += fs.statSync(fullPath).size;
            filesRemoved++;
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    }

    return { filesRemoved, bytesFreed };
  }

  async triggerLibraryScan(): Promise<{ scanned: boolean }> {
    try {
      const scan = await this.catalog.scanLibrary();
      if (scan.failures.length) console.warn("Some library providers could not be scanned", scan.failures);
      return { scanned: scan.attempted > 0 && scan.failures.length === 0 };
    } catch (error) {
      console.warn("Library scan failed", error);
      return { scanned: false };
    }
  }

  async getDownloaderDiagnostics(): Promise<Array<{
    id: string;
    name: string;
    available: boolean;
    version?: string;
    capabilities: DownloaderCapabilities;
    diagnostics?: Record<string, unknown>;
    error?: string;
  }>> {
    const results = [];
    for (const adapter of this.downloaderRegistry.getAll()) {
      if (typeof (adapter as any).getDiagnostics === "function") {
        try {
          const diag = await (adapter as any).getDiagnostics();
          results.push({
            id: adapter.id,
            name: adapter.name,
            available: diag.spotdlInstalled ?? true,
            version: diag.spotdlVersion,
            capabilities: adapter.capabilities,
            diagnostics: diag,
          });
          continue;
        } catch {}
      }
      if (typeof adapter.test === "function") {
        try {
          const testRes = await adapter.test();
          results.push({
            id: adapter.id,
            name: adapter.name,
            available: testRes.ok,
            version: (testRes as any).version,
            capabilities: adapter.capabilities,
            error: testRes.message,
          });
        } catch (err: any) {
          results.push({
            id: adapter.id,
            name: adapter.name,
            available: false,
            capabilities: adapter.capabilities,
            error: err?.message || String(err),
          });
        }
      } else {
        results.push({
          id: adapter.id,
          name: adapter.name,
          available: true,
          capabilities: adapter.capabilities,
        });
      }
    }
    return results;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const taskId of this.managedTasks.values()) {
      const task = this.taskManager?.get(taskId);
      if (task && ["QUEUED", "PROCESSING", "PAUSED"].includes(task.state)) {
        await this.taskManager!.cancel(taskId);
      }
    }
    for (const controller of this.activeControllers.values()) {
      try {
        controller.abort();
      } catch {}
    }
    this.activeControllers.clear();
    this.queue.length = 0;
    this.jobInputs.clear();
    this.inFlightContainers.clear();
    this.submissionBuckets.clear();
    this.eventListeners.clear();
    await Promise.allSettled([...this.workers]);
  }
}
