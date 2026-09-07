import type { UnifiedSearchResult } from "./search.js";
import type { SourceCandidate } from "./source-discovery.js";
import type { AcquiredFile, AcquisitionResult } from "./acquisition.js";

export type DownloadRequest = {
  spotifyTrackUrl?: string;
  spotifyTrackId?: string;
  query?: string;
  sourceUrl?: string;
  outputDirectory: string;
  filenameTemplate?: string;
  requestedTrack?: UnifiedSearchResult;
  candidate?: SourceCandidate;
};

export type DownloaderCapabilities = {
  spotifyTrack: boolean;
  textSearch: boolean;
  directUrl: boolean;
  album: boolean;
  playlist: boolean;
  metadata: boolean;
};

export type DownloadStage =
  | "downloading"
  | "converting"
  | "processing"
  | "tagging"
  | "importing";

export type DownloadProgress = {
  jobId?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
  stage?: DownloadStage;
  message?: string;
};

export type DownloadContext = {
  jobId: string;
  tmpDir: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
};

export type DownloadErrorCode =
  | "retryable"
  | "non-retryable"
  | "rate-limited"
  | "authentication-failed"
  | "not-found"
  | "invalid-input"
  | "cancelled"
  | "executable-missing"
  | "general";

export type DownloadResult = {
  status: "completed" | "failed" | "cancelled";
  files: AcquiredFile[];
  error?: {
    code: DownloadErrorCode;
    message: string;
  };
};

/**
 * DownloaderAdapter represents a standalone media download backend
 * (such as spotDL, authorized HTTP, or archive-org downloaders).
 * It abstracts executable invocation, progress events, cancellation, and metadata tagging.
 */
export interface DownloaderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: DownloaderCapabilities;

  canHandle(request: DownloadRequest): boolean | Promise<boolean>;

  download(
    request: DownloadRequest,
    context: DownloadContext
  ): Promise<DownloadResult>;

  cancel?(jobId: string): Promise<void> | void;

  test?(): Promise<{ ok: boolean; message?: string }>;

  /** Applies runtime configuration (e.g. credentials, binary paths) without recreating the adapter. */
  configure?(options: Record<string, unknown>): void;
}

export class DownloaderAdapterRegistry {
  private readonly adapters = new Map<string, DownloaderAdapter>();

  register(adapter: DownloaderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  unregister(adapterId: string): void {
    this.adapters.delete(adapterId);
  }

  get(adapterId: string): DownloaderAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  list(): DownloaderAdapter[] {
    return [...this.adapters.values()];
  }

  getAll(): DownloaderAdapter[] {
    return this.list();
  }

  async findAdapters(request: DownloadRequest): Promise<DownloaderAdapter[]> {
    const matching: DownloaderAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        if (await adapter.canHandle(request)) {
          matching.push(adapter);
        }
      } catch {}
    }
    return matching;
  }
}
