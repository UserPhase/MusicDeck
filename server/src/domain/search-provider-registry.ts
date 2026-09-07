import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import type { PlaylistService } from "./playlist-service.js";
import {
  groupSearchResults,
  toSearchGroups,
  toPlaylistSearchResult,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderKind,
  type SearchProviderResult,
  type UnifiedSearchResult,
} from "./search.js";

export type SearchProviderStatus = "enabled" | "disabled" | "error";

type SearchProviderDefinition = {
  id: string;
  name: string;
  kind: SearchProviderKind;
  defaultEnabled: boolean;
  create: (config: Record<string, unknown>) => SearchProvider;
};

type ConfigRow = {
  provider_id: string;
  enabled: number;
  config_json: string;
};

export type AdminSearchProvider = {
  id: string;
  name: string;
  kind: SearchProviderKind;
  enabled: boolean;
  status: SearchProviderStatus;
  config: Record<string, unknown>;
};

function readConfig(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function publicConfig(config: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !/(key|token|secret|password)/i.test(key))
  );
}

function isIncluded(item: UnifiedSearchResult, types?: SearchOptions["types"]) {
  return !types || types.includes(item.type);
}

class LibrarySearchProvider implements SearchProvider {
  readonly id = "library";
  readonly name = "Your Library";

  constructor(private readonly catalog: CatalogService) {}

  async search(query: string, options: SearchOptions = {}): Promise<UnifiedSearchResult[]> {
    const types = options.types?.map((type) => {
      if (type === "track") return "tracks";
      if (type === "album") return "albums";
      if (type === "artist") return "artists";
      return "playlists";
    });
    const catalog = await this.catalog.search(query, types);
    const groups = toSearchGroups(catalog, []);

    return Object.values(groups).flat().filter((item) => isIncluded(item, options.types));
  }
}

class PlaylistSearchProvider implements SearchProvider {
  readonly id = "musicdeck-playlists";
  readonly name = "Your Playlists";

  constructor(private readonly playlists: PlaylistService) {}

  async search(query: string, options: SearchOptions = {}): Promise<UnifiedSearchResult[]> {
    if (options.types && !options.types.includes("playlist")) {
      return [];
    }

    const playlists = await this.playlists.search(query, options.limit || 20);
    return playlists.map(toPlaylistSearchResult);
  }
}

/**
 * Safe example external search provider. It uses iTunes Search's public
 * catalog endpoint with no credentials and returns metadata-only results.
 * Tracks deliberately have no playable source yet: media resolution remains
 * a future provider capability rather than a client-side URL leak.
 */
class ItunesSearchProvider implements SearchProvider {
  readonly id = "itunes";
  readonly name = "External Catalog";

  constructor(
    private readonly config: Record<string, unknown>,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<UnifiedSearchResult[]> {
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", query);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", String(limit));

    const country = typeof this.config.country === "string" ? this.config.country : "US";
    url.searchParams.set("country", country);

    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      throw new Error("External catalog is unavailable");
    }

    if (!response.ok) {
      throw new Error("External catalog is unavailable");
    }

    let payload: { results?: any[] };
    try {
      payload = await response.json();
    } catch {
      throw new Error("External catalog returned invalid data");
    }

    return (payload.results || []).flatMap((item) => {
      const id = item.trackId ? `external_itunes_${item.trackId}` : null;
      if (!id || !isIncluded({ type: "track" } as UnifiedSearchResult, options.types)) {
        return [];
      }

      return [{
        type: "track" as const,
        id,
        title: item.trackName || "Unknown title",
        subtitle: item.artistName || null,
        artist: item.artistName || null,
        album: item.collectionName || null,
        // The external artwork URL remains private to the provider until an
        // artwork proxy/source resolver is implemented for external catalogs.
        artwork: null,
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        metadata: {
          durationSeconds: typeof item.trackTimeMillis === "number"
            ? Math.round(item.trackTimeMillis / 1000)
            : null,
        },
      }];
    });
  }
}

/**
 * Server-owned registry for built-in and future plugin/external search
 * providers. Configuration is persisted independently of catalog backends so
 * a failed/disabled search provider never affects library playback.
 */
export class SearchProviderRegistry {
  private readonly lastErrors = new Map<string, string>();
  private readonly definitions: SearchProviderDefinition[];

  constructor(db: Db, catalog: CatalogService, playlists: PlaylistService, fetchImpl?: typeof fetch) {
    this.db = db;
    this.definitions = [
      {
        id: "library",
        name: "Your Library",
        kind: "library",
        defaultEnabled: true,
        create: () => new LibrarySearchProvider(catalog),
      },
      {
        id: "musicdeck-playlists",
        name: "Your Playlists",
        kind: "musicdeck",
        defaultEnabled: true,
        create: () => new PlaylistSearchProvider(playlists),
      },
      {
        id: "itunes",
        name: "External Catalog",
        kind: "external",
        defaultEnabled: false,
        create: (config) => new ItunesSearchProvider(config, fetchImpl),
      },
    ];
  }

  private readonly db: Db;

  private configs() {
    const rows = this.db.prepare(
      "SELECT provider_id, enabled, config_json FROM search_provider_configs"
    ).all() as ConfigRow[];
    return new Map(rows.map((row) => [row.provider_id, row]));
  }

  list(): AdminSearchProvider[] {
    const configs = this.configs();

    return this.definitions.map((definition) => {
      const row = configs.get(definition.id);
      const config = row ? readConfig(row.config_json) : {};
      const enabled = row ? Boolean(row.enabled) : definition.defaultEnabled;
      const lastError = this.lastErrors.get(definition.id);

      return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        enabled,
        status: lastError ? "error" : enabled ? "enabled" : "disabled",
        config: publicConfig(config),
      };
    });
  }

  configure(providerId: string, input: { enabled?: boolean; config?: Record<string, unknown> }) {
    const definition = this.definitions.find((item) => item.id === providerId);
    if (!definition) {
      throw new Error("Unknown search provider");
    }

    const existing = this.configs().get(providerId);
    const config = input.config ?? (existing ? readConfig(existing.config_json) : {});
    const enabled = input.enabled ?? (existing ? Boolean(existing.enabled) : definition.defaultEnabled);

    this.db.prepare(`
      INSERT INTO search_provider_configs (provider_id, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(providerId, enabled ? 1 : 0, JSON.stringify(config), new Date().toISOString());

    this.lastErrors.delete(providerId);
  }

  async search(query: string, options: SearchOptions = {}) {
    const configs = this.configs();
    const enabled = this.definitions.filter((definition) => {
      const row = configs.get(definition.id);
      const isEnabled = row ? Boolean(row.enabled) : definition.defaultEnabled;
      const mode = options.mode || "hybrid";
      const isExternal = definition.kind === "external" || definition.kind === "plugin";

      const included = mode === "hybrid"
        ? true
        : mode === "external"
          ? isExternal
          : !isExternal;

      return isEnabled && included;
    });

    const outcomes = await Promise.all(enabled.map(async (definition) => {
      const row = configs.get(definition.id);
      const config = row ? readConfig(row.config_json) : {};

      try {
        const items = await definition.create(config).search(query, options);
        this.lastErrors.delete(definition.id);
        return { ok: true as const, providerId: definition.id, items };
      } catch {
        this.lastErrors.set(definition.id, "Search unavailable");
        return { ok: false as const, providerId: definition.id, items: [] as UnifiedSearchResult[] };
      }
    }));

    const successful = outcomes.filter((outcome) => outcome.ok);
    if (enabled.length > 0 && successful.length === 0) {
      throw new Error("All search providers are unavailable");
    }

    const results: SearchProviderResult[] = successful.map((outcome) => ({
      providerId: outcome.providerId,
      items: outcome.items,
    }));

    return {
      groups: groupSearchResults(results.flatMap((result) => result.items)),
      degraded: successful.length < enabled.length,
    };
  }
}
