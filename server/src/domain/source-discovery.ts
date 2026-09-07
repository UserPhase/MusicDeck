import type { Db } from "../db/database.js";
import type { CanonicalIdentity, UnifiedSearchResult } from "./search.js";
import type { PlayableSource, SourceProvider, SourceResolutionOptions } from "./playable-sources.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";
import { classifyPluginError } from "../plugins/plugin-errors.js";

export type SourceCandidateKind =
  | "track"
  | "album-container"
  | "release-container"
  | "item"
  | "file"
  | "detail-link";

export type AcquisitionInputs = {
  spotifyTrackUrl?: string;
  spotifyTrackId?: string;
  inputMode?: "text" | "spotify-url" | "either";
};

export type SourceCandidateMetadata = {
  acquisitionInputs?: AcquisitionInputs;
  acquisitionUrl?: string;
  fileUrl?: string;
  downloadUrl?: string;
  preview?: boolean;
  [key: string]: unknown;
};

/**
 * A discovered, not-yet-playable authorized source candidate. Kept strictly
 * separate from PlayableSource: discovery providers answer "what candidates
 * exist for this recording"; resolvers answer "can this candidate be made
 * playable through an authorized provider".
 */
export type SourceCandidate = {
  id: string;
  provider: string;
  kind?: SourceCandidateKind;
  title?: string;
  artist?: string;
  album?: string;
  container?: {
    id: string;
    title?: string;
    artist?: string;
    album?: string;
  };
  detailUrl?: string;
  metadata?: SourceCandidateMetadata;
  durationSeconds?: number;
  fileSize?: number;
  quality?: PlayableSource["quality"];
  identity?: CanonicalIdentity;
};

export type SourceDiscoveryOptions = {
  limit?: number;
  spotifyTrackUrl?: string;
  spotifyTrackId?: string;
};

export interface SourceDiscoveryProvider {
  id: string;
  name: string;
  search(result: UnifiedSearchResult, options?: SourceDiscoveryOptions): Promise<SourceCandidate[]>;
}

export type CandidateResolveOptions = {
  limit?: number;
  target?: UnifiedSearchResult;
};

export interface SourceDetailProvider {
  id: string;
  name: string;
  canResolve?(candidate: SourceCandidate): boolean | Promise<boolean>;
  resolveDetails(candidate: SourceCandidate, options?: CandidateResolveOptions): Promise<SourceCandidate[]>;
}

export interface SourceContainerProvider {
  id: string;
  name: string;
  canEnumerate?(candidate: SourceCandidate): boolean | Promise<boolean>;
  enumerate(candidate: SourceCandidate, options?: CandidateResolveOptions): Promise<SourceCandidate[]>;
}

export interface CandidateResolver {
  id: string;
  name: string;
  canResolve?(candidate: SourceCandidate): boolean | Promise<boolean>;
  resolve(candidate: SourceCandidate, options?: CandidateResolveOptions): Promise<PlayableSource[]>;
  test?(): Promise<{ ok: boolean; message?: string }>;
}

type ConfigRow = {
  provider_id: string;
  enabled: number;
};

function isPrivateHostname(hostname: string) {
  return hostname === "localhost"
    || hostname === "::1"
    || hostname.endsWith(".local")
    || hostname.startsWith("127.")
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || hostname.startsWith("169.254.");
}

/** Server-side validation for resolver-produced source URLs. */
export function validatedPlayableUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || isPrivateHostname(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** True when the candidate looks like an album-level container (artist+album
 * present and matching, but the title is the album name, not the track).
 * Resolvers (such as Debrid or Archive.org) inspect contained files and select
 * the matching track. */
export function isAlbumContainer(result: UnifiedSearchResult, candidate: SourceCandidate): boolean {
  const isContainerCandidate = candidate.kind === "album-container"
    || candidate.kind === "release-container"
    || candidate.kind === "item"
    || candidate.kind === "detail-link"
    || (candidate.metadata as any)?.kind === "album-container"
    || (candidate.id.startsWith("archiveorg:") && !candidate.id.slice("archiveorg:".length).includes(":"))
    || candidate.id.slice(candidate.id.indexOf(":") + 1).startsWith("magnet:")
    || candidate.id.startsWith("archive-org:");

  if (!isContainerCandidate) {
    return false;
  }
  const artist = normalizeMusicText(result.artist);
  const album = normalizeMusicText(result.album);
  if (!artist || !album) {
    return false;
  }
  const candidateTitle = normalizeMusicText(candidate.title);
  const candidateAlbum = normalizeMusicText(candidate.album);
  const title = normalizeMusicText(result.title);
  const matchesArtist = normalizeMusicText(candidate.artist) === artist;
  const matchesAlbum = candidateTitle === album || candidateAlbum === album;
  return matchesArtist && matchesAlbum && candidateTitle !== title;
}

/**
 * Deterministic candidate scoring. Returns a numeric score ranking candidate
 * suitability for the requested recording.
 * Factors:
 *   canonical identity match: +100
 *   exact track title:         +40 (or +25 for album container, +20 for partial)
 *   exact artist:              +30
 *   exact album:               +25
 *   duration close (<=3s):     +20 (<=8s: +10)
 *   lossless:                  +10
 *   quality metadata:          +5
 *   penalties for version mismatches (live, remix, acoustic, etc.): -50
 */
export function scoreCandidate(result: UnifiedSearchResult, candidate: SourceCandidate): number {
  let score = 0;

  if (result.identity && candidate.identity && result.identity.id === candidate.identity.id) {
    score += 100;
  }

  const resultTitle = normalizeMusicText(result.title);
  const resultArtist = normalizeMusicText(result.artist);
  const resultAlbum = normalizeMusicText(result.album);

  const candidateTitle = normalizeMusicText(candidate.title);
  const candidateArtist = normalizeMusicText(candidate.artist);
  const candidateAlbum = normalizeMusicText(candidate.album);

  const container = isAlbumContainer(result, candidate);
  if (resultTitle && candidateTitle === resultTitle) {
    score += 40;
  } else if (container) {
    score += 25;
  } else if (resultTitle && candidateTitle && (candidateTitle.includes(resultTitle) || resultTitle.includes(candidateTitle))) {
    score += 20;
  }

  if (resultArtist && candidateArtist === resultArtist) {
    score += 30;
  } else if (resultArtist && candidateArtist && (candidateArtist.includes(resultArtist) || resultArtist.includes(candidateArtist))) {
    score += 15;
  } else if (!candidateArtist) {
    score -= 15;
  }

  if (resultAlbum && candidateAlbum === resultAlbum) {
    score += 25;
  } else if (!candidateAlbum && !container) {
    score -= 5;
  }

  const requestedDuration = Number(result.metadata?.durationSeconds || 0);
  if (requestedDuration > 0 && candidate.durationSeconds && candidate.durationSeconds > 0) {
    const diff = Math.abs(candidate.durationSeconds - requestedDuration);
    if (diff <= 3) {
      score += 20;
    } else if (diff <= 8) {
      score += 10;
    } else if (diff > 20) {
      score -= 30;
    }
  }

  if (candidate.quality?.lossless) {
    score += 10;
  }

  if (candidate.quality?.bitrate || candidate.quality?.sampleRate) {
    score += 5;
  }

  if (!container) {
    const requestedVersion = versionSignature(result.title);
    const candidateVersion = versionSignature(candidate.title || "");
    if (requestedVersion !== candidateVersion) {
      score -= 50;
    }
  }

  return score;
}

/**
 * Conservative candidate matching. Strong canonical identity wins; otherwise
 * exact normalized metadata plus duration tolerance and version protection.
 * No candidate is accepted on filename similarity alone.
 */
export function matchesCandidate(result: UnifiedSearchResult, candidate: SourceCandidate): boolean {
  if (result.identity && candidate.identity && result.identity.id === candidate.identity.id) {
    return true;
  }

  // Album-level container (e.g. a magnet or archive.org item whose display name is the album).
  // These are allowed through when artist AND album both match — the
  // strictest identity we can assert for a container — because the debrid/archive
  // resolver enumerates the contained files and selects only the matching
  // track by fileMatches. Never matches on title alone.
  if (isAlbumContainer(result, candidate)) {
    return true;
  }

  // Version protection: live, remix, acoustic, instrumental, etc. must match
  const requestedVersion = versionSignature(result.title);
  const candidateVersion = versionSignature(candidate.title || "");
  if (requestedVersion !== candidateVersion) {
    return false;
  }

  const title = normalizeMusicText(result.title);
  const candidateTitle = normalizeMusicText(candidate.title);
  const candidateText = normalizeMusicText(
    [candidate.artist, candidate.album, candidate.title].filter(Boolean).join(" ")
  );
  const artist = normalizeMusicText(result.artist);

  // Exact title equality, or a single filename-style field carrying
  // "artist title" (common for direct media links on open sites).
  const titleMatches = Boolean(title)
    && (candidateTitle === title
      || Boolean(artist && candidate.title && candidateTitle === `${artist} ${title}`));
  if (!titleMatches) {
    return false;
  }

  const candidateArtist = normalizeMusicText(candidate.artist);
  if (artist && candidateArtist && artist !== candidateArtist) {
    return false;
  }

  const album = normalizeMusicText(result.album);
  const candidateAlbum = normalizeMusicText(candidate.album);
  if (album && candidateAlbum && album !== candidateAlbum) {
    return false;
  }

  const hasMetadataContext = Boolean(
    candidate.artist ||
    candidate.album ||
    candidate.durationSeconds ||
    candidate.identity ||
    (artist && candidateText.includes(artist)) ||
    (candidate.container && (candidate.container.artist || candidate.container.album))
  );
  if (!hasMetadataContext) {
    return false;
  }

  const requestedDuration = Number(result.metadata?.durationSeconds || 0);
  if (requestedDuration && candidate.durationSeconds
    && Math.abs(candidate.durationSeconds - requestedDuration) > 8) {
    return false;
  }

  return true;
}

/** Deterministic quality comparison: lossless, bitrate, bit depth, sample
 * rate, file size, then label for stability. Correct-recording identity is
 * always enforced before this comparison is applied. Full sources always
 * prioritize over preview-only sources. */
export function compareSourceQuality(a: PlayableSource, b: PlayableSource): number {
  if (a.type !== b.type) {
    if (a.type === "preview" && b.type !== "preview") return 1;
    if (b.type === "preview" && a.type !== "preview") return -1;
  }

  const quality = (source: PlayableSource) => source.quality || {};
  const lossless = (source: PlayableSource) => quality(source).lossless ? 1 : 0;
  if (lossless(a) !== lossless(b)) return lossless(b) - lossless(a);

  const numeric = (key: "bitrate" | "bitDepth" | "sampleRate" | "fileSize") => {
    const left = Number(quality(a)[key] || 0);
    const right = Number(quality(b)[key] || 0);
    return right - left;
  };

  for (const key of ["bitrate", "bitDepth", "sampleRate", "fileSize"] as const) {
    const diff = numeric(key);
    if (diff !== 0) return diff;
  }

  return a.label.localeCompare(b.label);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Discovery → matching → resolver orchestration. Registered into the existing
 * SourceProviderRegistry as one SourceProvider facade so the playback proxy,
 * preferences, and client remain unchanged.
 */
export class SourcePipelineRegistry {
  private readonly discoveryProviders: SourceDiscoveryProvider[] = [];
  private readonly detailProviders: SourceDetailProvider[] = [];
  private readonly containerProviders: SourceContainerProvider[] = [];
  private readonly resolverProviders: CandidateResolver[] = [];

  constructor(private readonly db: Db) {}

  private enabledIds() {
    const rows = this.db.prepare(
      "SELECT provider_id, enabled FROM source_provider_configs"
    ).all() as ConfigRow[];
    return new Map(rows.map((row) => [row.provider_id, Boolean(row.enabled)]));
  }

  registerDiscovery(provider: SourceDiscoveryProvider) {
    if (this.resolverProviders.some((item) => item.id === provider.id)) {
      throw new Error("Source pipeline provider is already registered");
    }
    // Re-registration (e.g. plugin re-enabled) replaces the stale instance so
    // updated configuration takes effect.
    const existing = this.discoveryProviders.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.discoveryProviders[existing] = provider;
      return;
    }
    this.discoveryProviders.push(provider);
  }

  registerDetail(provider: SourceDetailProvider) {
    const existing = this.detailProviders.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.detailProviders[existing] = provider;
      return;
    }
    this.detailProviders.push(provider);
  }

  registerContainer(provider: SourceContainerProvider) {
    const existing = this.containerProviders.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.containerProviders[existing] = provider;
      return;
    }
    this.containerProviders.push(provider);
  }

  registerResolver(provider: CandidateResolver) {
    if (this.discoveryProviders.some((item) => item.id === provider.id)) {
      throw new Error("Source pipeline provider is already registered");
    }
    const existing = this.resolverProviders.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.resolverProviders[existing] = provider;
      return;
    }
    this.resolverProviders.push(provider);
  }

  list() {
    const enabled = this.enabledIds();
    return [
      ...this.discoveryProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        role: "discovery" as const,
        enabled: enabled.get(provider.id) || false,
      })),
      ...this.resolverProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        role: "resolver" as const,
        enabled: enabled.get(provider.id) || false,
      })),
    ];
  }

  configure(providerId: string, enabled: boolean) {
    if (!this.discoveryProviders.some((item) => item.id === providerId)
      && !this.resolverProviders.some((item) => item.id === providerId)
      && !this.detailProviders.some((item) => item.id === providerId)
      && !this.containerProviders.some((item) => item.id === providerId)) {
      throw new Error("Unknown source pipeline provider");
    }

    this.db.prepare(`
      INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES (?, ?, '{}', ?)
      ON CONFLICT(provider_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(providerId, enabled ? 1 : 0, new Date().toISOString());

    // The pipeline facade exists only to serve its registered providers, so
    // enabling any provider enables the facade in the source registry.
    if (enabled) {
      this.db.prepare(`
        INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
        VALUES ('source-pipeline', 1, '{}', ?)
        ON CONFLICT(provider_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
      `).run(new Date().toISOString());
    }
  }

  async test(providerId: string) {
    const resolver = this.resolverProviders.find((item) => item.id === providerId);
    if (!resolver) {
      if (this.discoveryProviders.some((item) => item.id === providerId)) {
        return { id: providerId, ok: true, status: "success" as const, message: "Provider is configured" };
      }
      throw new Error("Unknown source pipeline provider");
    }

    try {
      const result = await resolver.test?.() || { ok: true };
      return {
        id: providerId,
        ok: result.ok,
        status: result.ok ? "success" : "plugin_error",
        message: result.message || (result.ok ? "Provider is reachable" : "Provider is unavailable"),
      };
    } catch (error) {
      const classified = classifyPluginError(error);
      return { id: providerId, ok: false, status: classified.status, message: classified.message };
    }
  }

  async discover(result: UnifiedSearchResult, options: SourceDiscoveryOptions = {}): Promise<SourceCandidate[]> {
    const enabled = this.enabledIds();
    const seenDiscoveryIds = new Set<string>();
    const discovery = this.discoveryProviders.filter((provider) => {
      if (!enabled.get(provider.id) || seenDiscoveryIds.has(provider.id)) return false;
      seenDiscoveryIds.add(provider.id);
      return true;
    });

    const candidates: SourceCandidate[] = [];
    await Promise.allSettled(
      discovery.map(async (provider) => {
        try {
          const list = await withTimeout(
            provider.search(result, options),
            5000,
            []
          );
          candidates.push(...list.filter((c) => matchesCandidate(result, c)));
        } catch {}
      })
    );

    return candidates.sort((a, b) => scoreCandidate(result, b) - scoreCandidate(result, a));
  }

  async resolve(result: UnifiedSearchResult, options: SourceResolutionOptions = {}): Promise<PlayableSource[]> {
    if (result.type !== "track") {
      return [];
    }

    const enabled = this.enabledIds();
    // Deduplicate discovery and resolver providers by id
    const seenDiscoveryIds = new Set<string>();
    const discovery = this.discoveryProviders.filter((provider) => {
      if (!enabled.get(provider.id) || seenDiscoveryIds.has(provider.id)) return false;
      seenDiscoveryIds.add(provider.id);
      return true;
    });
    const seenResolverIds = new Set<string>();
    const resolvers = this.resolverProviders.filter((provider) => {
      if (!enabled.get(provider.id) || seenResolverIds.has(provider.id)) return false;
      seenResolverIds.add(provider.id);
      return true;
    });

    if (discovery.length === 0 || resolvers.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const discoveryFailures: Array<{ name: string; failure: string }> = [];
    let successfulDiscoveries = 0;
    let failedDiscoveries = 0;

    const discoverySettled = await Promise.allSettled(
      discovery.map(async (provider) => {
        const provStart = Date.now();
        try {
          const candidates = await withTimeout(
            provider.search(result, { limit: options.limit }),
            5000,
            []
          );
          console.log(`[SourcePipeline] discovery "${provider.name}" (${provider.id}) returned ${candidates.length} candidates in ${Date.now() - provStart}ms`);
          successfulDiscoveries += 1;
          return candidates;
        } catch (err: any) {
          failedDiscoveries += 1;
          const statusPart = err?.httpStatus ? ` (${err.httpStatus})` : "";
          const failureType = err?.failure || "error";
          discoveryFailures.push({
            name: provider.name,
            failure: `${failureType}${statusPart}`,
          });
          console.log(`[SourcePipeline] discovery "${provider.name}" (${provider.id}) failed in ${Date.now() - provStart}ms: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      })
    );

    const allCandidates: SourceCandidate[] = [];
    for (const settled of discoverySettled) {
      if (settled.status === "fulfilled" && Array.isArray(settled.value)) {
        allCandidates.push(...settled.value);
      }
    }

    // Candidate expansion stage (Detail resolution & Container/Item enumeration)
    let detailResolutions = 0;
    let containersExpanded = 0;
    let filesEnumerated = 0;
    let matchingFiles = 0;

    const expandedCandidates: SourceCandidate[] = [];
    for (const candidate of allCandidates) {
      // Check if candidate is a detail link
      if (candidate.kind === "detail-link" || (candidate.detailUrl && !candidate.id.includes("magnet:") && !candidate.id.includes(".mp3") && !candidate.id.includes(".flac"))) {
        let resolvedDetails: SourceCandidate[] | null = null;
        for (const detailProvider of this.detailProviders) {
          if (detailProvider.canResolve && !(await detailProvider.canResolve(candidate))) {
            continue;
          }
          try {
            resolvedDetails = await withTimeout(
              detailProvider.resolveDetails(candidate, { target: result, limit: options.limit }),
              5000,
              []
            );
            detailResolutions++;
            break;
          } catch {
            // Error isolation per detail provider
          }
        }
        if (resolvedDetails && resolvedDetails.length > 0) {
          expandedCandidates.push(...resolvedDetails);
          continue;
        }
      }

      // Check if candidate is an album / release / item container
      const isContainer = candidate.kind === "album-container"
        || candidate.kind === "release-container"
        || candidate.kind === "item"
        || isAlbumContainer(result, candidate);

      if (isContainer) {
        let enumerated: SourceCandidate[] | null = null;
        for (const containerProvider of this.containerProviders) {
          if (containerProvider.canEnumerate && !(await containerProvider.canEnumerate(candidate))) {
            continue;
          }
          try {
            enumerated = await withTimeout(
              containerProvider.enumerate(candidate, { target: result, limit: options.limit }),
              6000,
              []
            );
            containersExpanded++;
            filesEnumerated += enumerated.length;
            break;
          } catch {
            // Error isolation per container provider
          }
        }

        if (enumerated && enumerated.length > 0) {
          for (const item of enumerated) {
            if (matchesCandidate(result, item)) {
              matchingFiles++;
            }
            expandedCandidates.push(item);
          }
          // Also keep the container candidate in case downstream resolvers handle containers
          expandedCandidates.push(candidate);
          continue;
        }
      }

      expandedCandidates.push(candidate);
    }

    const matching = expandedCandidates.filter((candidate) => matchesCandidate(result, candidate));

    const seenCandidates = new Set<string>();
    const uniqueCandidates: SourceCandidate[] = [];
    for (const candidate of matching) {
      const target = candidate.id.includes(":") ? candidate.id.slice(candidate.id.indexOf(":") + 1) : candidate.id;
      if (!seenCandidates.has(target)) {
        seenCandidates.add(target);
        uniqueCandidates.push(candidate);
      }
    }

    // Rank candidates deterministically by score descending
    const rankedCandidates = uniqueCandidates
      .map((candidate) => ({ candidate, score: scoreCandidate(result, candidate) }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.candidate);

    const maxSources = Math.max(1, Math.min(options.limit || 10, 25));
    const sources: PlayableSource[] = [];
    const seenSources = new Set<string>();
    let resolversAttempted = 0;
    let failedCandidates = 0;

    for (const candidate of rankedCandidates) {
      if (sources.length >= maxSources) {
        break;
      }
      let candidateResolved = false;
      for (const resolver of resolvers) {
        const resStart = Date.now();
        try {
          if (resolver.canResolve && !(await resolver.canResolve(candidate))) {
            continue;
          }

          resolversAttempted += 1;
          const resolved = await withTimeout(
            resolver.resolve(candidate, { target: result, limit: options.limit }),
            8000,
            []
          );

          for (const source of resolved) {
            const safeId = validatedPlayableUrl(source.id);
            if (!safeId || seenSources.has(safeId)) continue;
            seenSources.add(safeId);
            sources.push({
              ...source,
              id: safeId,
              type: "external",
              label: source.label || resolver.name,
            });
            candidateResolved = true;
            if (sources.length >= maxSources) {
              break;
            }
          }
          console.log(`[SourcePipeline] resolver "${resolver.name}" resolved candidate in ${Date.now() - resStart}ms (sources: ${resolved.length})`);
        } catch (err) {
          console.log(`[SourcePipeline] resolver "${resolver.name}" failed for candidate in ${Date.now() - resStart}ms: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!candidateResolved) {
        failedCandidates += 1;
      }
    }

    let summaryLog =
      `[SourcePipeline] summary for "${result.title}" - "${result.artist || ""}":\n` +
      `discovery providers = ${discovery.length}\n` +
      `search results = ${allCandidates.length}\n` +
      `detail resolutions = ${detailResolutions}\n` +
      `containers expanded = ${containersExpanded}\n` +
      `files enumerated = ${filesEnumerated}\n` +
      `matching files = ${matchingFiles}\n` +
      `matching candidates = ${uniqueCandidates.length}\n` +
      `resolvers attempted = ${resolversAttempted}\n` +
      `playable sources = ${sources.length}\n` +
      `failed candidates = ${failedCandidates}\n` +
      `totalDuration = ${Date.now() - startTime}ms`;

    if (discoveryFailures.length > 0) {
      summaryLog += "\n\nfailures:\n" + discoveryFailures.map((f) => `  ${f.name} = ${f.failure}`).join("\n");
    }

    console.log(summaryLog);

    return sources.sort(compareSourceQuality);
  }
}

/** SourceProvider facade exposing the pipeline to the existing registry. */
export class SourcePipelineProvider implements SourceProvider {
  readonly id = "source-pipeline";
  readonly name = "Source pipeline";
  readonly capabilities = {
    tracks: true,
    albums: false,
    quality: true,
    multipleSources: true,
    caching: true,
  };

  constructor(
    private readonly pipeline: SourcePipelineRegistry,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  canResolve(result: UnifiedSearchResult) {
    return result.type === "track";
  }

  getSources(result: UnifiedSearchResult, options?: SourceResolutionOptions) {
    return this.pipeline.resolve(result, options);
  }

  async fetchStream(source: PlayableSource, range?: string) {
    const url = validatedPlayableUrl(source.id);
    if (!url) {
      throw new Error("Playable source is unavailable");
    }

    const response = await this.fetchImpl(url, {
      headers: range ? { Range: range } : undefined,
    });
    if (!response.ok) {
      throw new Error("Playable source is unavailable");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!/^(audio\/|application\/octet-stream)/i.test(contentType)) {
      throw new Error("Playable source is unavailable");
    }

    return { body: response.body, status: response.status, headers: response.headers };
  }
}
