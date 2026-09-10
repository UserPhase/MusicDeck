import type { Db } from "../db/database.js";
import { createId } from "../utils/ids.js";
import type { ProviderRegistry } from "../backends/registry.js";
import type { LibraryService } from "./library.js";
import type { SourceResolver } from "./source-resolver.js";
import type { UnifiedSearchResult } from "./search.js";
import type { PlayableSource, SourceProvider, SourceResolutionOptions } from "./playable-sources.js";
import { normalizeMusicText } from "./music-identity.js";
import { compareSourceQuality, SourcePipelineProvider, type SourcePipelineRegistry } from "./source-discovery.js";
import { classifyPluginError } from "../plugins/plugin-errors.js";

type ConfigRow = {
  provider_id: string;
  enabled: number;
  config_json: string;
};

function readConfig(json: string) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function publicConfig(config: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    /(key|token|secret|password)/i.test(key) ? Boolean(value) : value,
  ]));
}

type StoredSource = {
  source: PlayableSource;
  providerId: string;
  providerSourceId: string;
  resultId: string;
  expiresAt: number;
};

class LibrarySourceProvider implements SourceProvider {
  readonly id = "library";
  readonly name = "Library";
  readonly capabilities = {
    tracks: true,
    albums: false,
    quality: false,
    multipleSources: true,
    caching: true,
  };

  constructor(
    private readonly library: LibraryService,
    private readonly providers: ProviderRegistry
  ) {}

  async getSources(result: UnifiedSearchResult): Promise<PlayableSource[]> {
    if (result.type !== "track" || !this.library.exists(result.id)) {
      return [];
    }

    return this.library.getSources(result.id).flatMap((source) => {
      const provider = this.providers.getByConnectionId(source.connectionId);
      if (!provider || !provider.enabled) {
        return [];
      }

      return [{
        // Replaced with an opaque token by SourceProviderRegistry.
        id: source.connectionId,
        provider: "library" as const,
        type: "library" as const,
        mediaType: "audio" as const,
        label: provider.name,
        availability: "available" as const,
      }];
    });
  }
}

/**
 * iTunes offers legitimate, publicly documented short audio previews. The
 * lookup URL is never returned to the browser; it is retained only in the
 * registry's short-lived opaque-source cache after validation.
 */
class ItunesPreviewSourceProvider implements SourceProvider {
  readonly id = "itunes-preview";
  readonly name = "External preview";
  readonly capabilities = {
    tracks: true,
    albums: false,
    quality: true,
    multipleSources: false,
    caching: true,
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  canResolve(result: UnifiedSearchResult) {
    return result.type === "track" && (
      /^external_itunes_\d+$/.test(result.id)
      || Boolean(result.source.externalAvailable)
    );
  }

  async getSources(result: UnifiedSearchResult): Promise<PlayableSource[]> {
    if (!(await this.canResolve(result))) {
      return [];
    }

    let previewUrl: string | undefined;

    if (result.id.startsWith("external_itunes_")) {
      const trackId = result.id.slice("external_itunes_".length);
      if (!/^\d+$/.test(trackId)) {
        return [];
      }

      const lookup = new URL("https://itunes.apple.com/lookup");
      lookup.searchParams.set("id", trackId);

      const response = await this.fetchImpl(lookup);
      if (!response.ok) {
        throw new Error("External preview is unavailable");
      }

      const payload = await response.json() as { results?: Array<{ previewUrl?: string }> };
      previewUrl = payload.results?.[0]?.previewUrl;
    } else if (result.source.externalAvailable) {
      const lookup = new URL("https://itunes.apple.com/search");
      lookup.searchParams.set("term", `${result.artist || ""} ${result.title}`.trim());
      lookup.searchParams.set("media", "music");
      lookup.searchParams.set("entity", "song");
      lookup.searchParams.set("limit", "5");

      const response = await this.fetchImpl(lookup);
      if (!response.ok) {
        throw new Error("External preview is unavailable");
      }

      const payload = await response.json() as {
        results?: Array<{ trackName?: string; artistName?: string; collectionName?: string; previewUrl?: string }>;
      };
      const title = normalizeMusicText(result.title);
      const artist = normalizeMusicText(result.artist);
      const album = normalizeMusicText(result.album);
      previewUrl = payload.results?.find((item) =>
        normalizeMusicText(item.trackName) === title
        && normalizeMusicText(item.artistName) === artist
        && (!album || normalizeMusicText(item.collectionName) === album)
      )?.previewUrl;
    }
    if (!previewUrl) {
      return [];
    }

    const preview = new URL(previewUrl);
    if (preview.protocol !== "https:" || !preview.hostname.endsWith("itunes.apple.com")) {
      throw new Error("External preview is unavailable");
    }

    return [{
      // Replaced with an opaque MusicDeck token before returning to the UI.
      id: preview.toString(),
      provider: "external",
      type: "preview",
      mediaType: "audio",
      label: "External preview",
      availability: "available",
      quality: { codec: "AAC", lossless: false },
    }];
  }

  async test() {
    const response = await this.fetchImpl(new URL("https://itunes.apple.com/search?term=test&media=music&entity=song&limit=1"));
    return {
      ok: response.ok,
      message: response.ok
        ? "External preview is reachable"
        : `External preview is unavailable (iTunes responded with ${response.status})`,
    };
  }

  async fetchStream(source: PlayableSource, range?: string) {
    const response = await this.fetchImpl(source.id, {
      headers: range ? { Range: range } : undefined,
    });

    return { body: response.body, status: response.status, headers: response.headers };
  }
}

/**
 * Provider-neutral source resolution registry. It returns only opaque source
 * tokens to the client; provider connection IDs, provider URLs, and source
 * implementation details remain server-side in a short-lived in-memory map.
 */
export class SourceProviderRegistry {
  private providers: SourceProvider[];
  private readonly sourceCache = new Map<string, StoredSource>();

  constructor(
    private readonly db: Db,
    library: LibraryService,
    providers: ProviderRegistry,
    private readonly sourceResolver: SourceResolver,
    fetchImpl?: typeof fetch,
    private readonly pipeline?: SourcePipelineRegistry
  ) {
    this.providers = [
      new LibrarySourceProvider(library, providers),
      new ItunesPreviewSourceProvider(fetchImpl),
      ...(pipeline ? [new SourcePipelineProvider(pipeline, fetchImpl)] : []),
    ];
  }

  private providerConfigs() {
    const rows = this.db.prepare(
      "SELECT provider_id, enabled, config_json FROM source_provider_configs"
    ).all() as ConfigRow[];
    return new Map(rows.map((row) => [row.provider_id, row]));
  }

  register(provider: SourceProvider) {
    // Re-registration (e.g. plugin re-enabled) replaces the stale instance so
    // updated configuration takes effect.
    const existing = this.providers.findIndex((item) => item.id === provider.id);
    if (existing >= 0) {
      this.providers[existing] = provider;
      return;
    }

    this.providers.push(provider);
  }

  list() {
    const configs = this.providerConfigs();
    const own = this.providers.map((provider) => {
      const row = configs.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        enabled: row ? Boolean(row.enabled) : false,
        capabilities: provider.capabilities || {
          tracks: true,
          albums: false,
          quality: false,
          multipleSources: false,
          caching: true,
        },
        config: publicConfig(readConfig(row?.config_json || "{}")),
      };
    });

    const pipelineProviders = this.pipeline?.list()
      // A provider may register in both the direct source registry and the
      // discovery/resolver pipeline (e.g. the debrid plugin, which is a
      // SourceProvider and also a CandidateResolver under the same id). The
      // direct registration already reflects real capabilities/config, so
      // avoid listing the same id twice.
      .filter((provider) => !this.providers.some((own) => own.id === provider.id))
      .map((provider) => ({
        ...provider,
        capabilities: {
          tracks: true,
          albums: false,
          quality: provider.role === "resolver",
          multipleSources: true,
          caching: true,
        },
        config: {},
      })) || [];

    return [...own, ...pipelineProviders];
  }

  configure(providerId: string, enabled: boolean, config?: Record<string, unknown>) {
    if (!this.providers.some((provider) => provider.id === providerId)) {
      if (this.pipeline) {
        this.pipeline.configure(providerId, enabled);
        return;
      }
      throw new Error("Unknown source provider");
    }

    const existing = this.providerConfigs().get(providerId);
    const nextConfig = config ?? readConfig(existing?.config_json || "{}");

    this.db.prepare(`
      INSERT INTO source_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(providerId, enabled ? 1 : 0, JSON.stringify(nextConfig), new Date().toISOString());
  }

  async test(providerId: string) {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) {
      if (this.pipeline) {
        return this.pipeline.test(providerId);
      }
      throw new Error("Unknown source provider");
    }

    if (!provider.test) {
      return { id: provider.id, ok: true, status: "success" as const, message: "Provider is configured" };
    }

    try {
      const result = await provider.test();
      return {
        id: provider.id,
        ok: result.ok,
        status: result.ok ? "success" : "plugin_error",
        message: result.message
          || (result.ok ? `${provider.name} is reachable` : `${provider.name} is unavailable`),
      };
    } catch (error) {
      const classified = classifyPluginError(error);
      return {
        id: provider.id,
        ok: false,
        status: classified.status,
        message: `${provider.name}: ${classified.message}`,
      };
    }
  }

  async resolve(result: UnifiedSearchResult, options: SourceResolutionOptions = {}) {
    const configs = this.providerConfigs();
    const providers = this.providers.filter((provider) =>
      (provider.id === "library" || options.allowExternal)
      && (provider.id === "library" || Boolean(configs.get(provider.id)?.enabled))
    );
    const outcomes = await Promise.all(providers.map(async (provider) => {
      try {
        if (provider.canResolve && !(await provider.canResolve(result))) {
          return { provider, ok: true as const, sources: [] as PlayableSource[] };
        }
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<PlayableSource[]>((resolve) => {
          timer = setTimeout(() => resolve([]), 10_000);
        });
        const sourcesPromise = provider.getSources(result, options);
        let sources: PlayableSource[];
        try {
          sources = await Promise.race([sourcesPromise, timeoutPromise]);
        } finally {
          clearTimeout(timer!);
        }
        return { provider, ok: true as const, sources };
      } catch {
        return { provider, ok: false as const, sources: [] as PlayableSource[] };
      }
    }));

    const sources: PlayableSource[] = [];
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        continue;
      }

      for (const source of outcome.sources) {
        const id = createId("playable");
        const expiresAt = Date.now() + 5 * 60_000;
        this.sourceCache.set(id, {
          source: { ...source, id },
          providerId: outcome.provider.id,
          providerSourceId: source.id,
          resultId: result.id,
          expiresAt,
        });
        sources.push({ ...source, id, expiresAt: new Date(expiresAt).toISOString() });
      }
    }

    const available = sources.filter((source) => source.availability === "available");
    const library = available.find((source) => source.type === "library");
    const external = available.find((source) => source.type === "external");
    const preview = available.find((source) => source.type === "preview");
    const nonPreview = available.filter((source) => source.type !== "preview");
    const bestNonPreview = [...nonPreview].sort(compareSourceQuality)[0];
    const best = bestNonPreview || [...available].sort(compareSourceQuality)[0];

    const selectedSource = options.preference === "library"
      ? library || external || preview
      : options.preference === "external"
        ? external || preview || library
        : options.preference === "best"
          ? best
          : options.preference === "lossless"
            ? available.find((source) => source.quality?.lossless) || best
            : options.preference === "highest-bitrate"
              ? [...available].sort((left, right) => Number(right.quality?.bitrate || 0) - Number(left.quality?.bitrate || 0))[0]
              : options.preference === "preferred" && options.preferredProvider
                ? available.find((source) =>
                    source.label === options.preferredProvider ||
                    (source.label || "").toLowerCase().includes(options.preferredProvider!.toLowerCase()) ||
                    source.provider === options.preferredProvider
                  ) || best
                : options.preference === "manual"
                  ? (available.length === 1 ? available[0] : undefined)
                  : (best || (available.length === 1 ? available[0] : undefined));

    console.log(
      `[SourceProviderRegistry] resolve summary for "${result.title}" - "${result.artist || ""}": ` +
      `providers = ${providers.length}, playable sources = ${sources.filter((s) => s.type !== "preview").length}, ` +
      `preview sources = ${sources.filter((s) => s.type === "preview").length}, degraded = ${outcomes.some((o) => !o.ok)}`
    );

    return {
      sources,
      selectedSource,
      degraded: outcomes.some((outcome) => !outcome.ok),
    };
  }

  async fetchStream(resultId: string, sourceId: string, range?: string) {
    const stored = this.sourceCache.get(sourceId);

    if (!stored || stored.resultId !== resultId || stored.expiresAt < Date.now()) {
      this.sourceCache.delete(sourceId);
      throw new Error("Playable source is unavailable");
    }

    const provider = this.providers.find((item) => item.id === stored.providerId);
    if (!provider) {
      throw new Error("Playable source is unavailable");
    }

    if (stored.source.type === "library") {
      return this.sourceResolver.fetchStream(resultId, range, stored.providerSourceId);
    }

    if (!provider.fetchStream) {
      throw new Error("Playable source is unavailable");
    }

    return provider.fetchStream({ ...stored.source, id: stored.providerSourceId }, range);
  }

  isExternalSource(resultId: string, sourceId: string) {
    const stored = this.sourceCache.get(sourceId);
    return Boolean(stored && stored.resultId === resultId && stored.source.type === "external");
  }
}
