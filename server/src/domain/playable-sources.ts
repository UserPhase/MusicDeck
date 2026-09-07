import type { UnifiedSearchResult } from "./search.js";

export type PlayableSourceType = "library" | "external" | "preview";
export type PlayableSourceAvailability = "unknown" | "resolving" | "available" | "unavailable" | "failed" | "expired";

export type SourceProviderCapabilities = {
  tracks: boolean;
  albums: boolean;
  quality: boolean;
  multipleSources: boolean;
  caching: boolean;
};

export type PlayableSource = {
  /** Opaque, short-lived MusicDeck source token. */
  id: string;
  provider: "library" | "external" | "plugin";
  type: PlayableSourceType;
  mediaType: "audio";
  label: string;
  availability: PlayableSourceAvailability;
  expiresAt?: string;
  quality?: {
    codec?: string;
    bitrate?: number;
    sampleRate?: number;
    bitDepth?: number;
    durationSeconds?: number;
    fileSize?: number;
    lossless?: boolean;
  };
};

export type SourcePreference =
  | "library"
  | "external"
  | "manual"
  | "best"
  | "lossless"
  | "highest-bitrate"
  | "preferred";

export type SourceResolutionOptions = {
  limit?: number;
  allowExternal?: boolean;
  preference?: SourcePreference;
  /** Friendly source label to prefer when preference is "preferred". */
  preferredProvider?: string;
};

export type SourceResolution = {
  sources: PlayableSource[];
  selectedSource?: PlayableSource;
  degraded: boolean;
};

export interface SourceProvider {
  id: string;
  name: string;
  capabilities?: SourceProviderCapabilities;
  canResolve?(result: UnifiedSearchResult): Promise<boolean> | boolean;
  getSources(result: UnifiedSearchResult, options?: SourceResolutionOptions): Promise<PlayableSource[]>;
  test?(): Promise<{ ok: boolean; message?: string }>;
  fetchStream?(source: PlayableSource, range?: string): Promise<{ body: ReadableStream<Uint8Array> | null; status: number; headers: Headers }>;
}
