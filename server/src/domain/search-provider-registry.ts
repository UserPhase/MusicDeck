import type { Db } from "../db/database.js";
import type { CatalogService } from "./catalog.js";
import type { PlaylistService } from "./playlist-service.js";
import { SpotifyAuthClient, SpotifyAuthError, describeSpotifyErrorBody, hasSpotifyCredentials, resolveSpotifyCredentials } from "./spotify-auth.js";
import { ExternalArtworkTokenStore } from "./external-catalog.js";
import { classifyPluginError } from "../plugins/plugin-errors.js";
import { SubsonicAdapter } from "../services/adapters/SubsonicAdapter.js";
import { DeezerAdapter } from "../services/adapters/DeezerAdapter.js";
import { iTunesAdapter } from "../services/adapters/iTunesAdapter.js";
import {
  groupSearchResults,
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
  statusMessage?: string;
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

export function searchIdentity(value: string | null) {
  const fallback = String(value || "").trim().toLocaleLowerCase();
  const identity = fallback
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ")
    .trim();

  return identity || fallback || "unknown";
}

/** Deezer results are passed first, so an exact normalized title/artist
 * collision keeps Deezer and drops the supplementary iTunes copy. */
export function dedupeKeylessSearchResults(items: UnifiedSearchResult[]) {
  const result: UnifiedSearchResult[] = [];
  const trackIndexes = new Map<string, number>();

  for (const item of items) {
    if (item.type !== "track") {
      result.push(item);
      continue;
    }

    const key = `${searchIdentity(item.title)}::${searchIdentity(item.artist)}`;
    const existingIndex = trackIndexes.get(key);
    if (existingIndex === undefined) {
      trackIndexes.set(key, result.length);
      result.push(item);
      continue;
    }

    // Deezer is inserted first and remains the canonical result. iTunes can
    // still enrich it when Deezer did not publish a preview for the track.
    if (!result[existingIndex].previewUrl && item.previewUrl) {
      result[existingIndex] = { ...result[existingIndex], previewUrl: item.previewUrl };
    }
  }

  return result;
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
    const groups = await new SubsonicAdapter(this.catalog).searchAll(query, types);

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
 * Built-in keyless external catalog backed by Deezer and iTunes Search.
 * Deezer remains primary; iTunes supplements track results and is discarded
 * when its normalized title/artist identity duplicates a Deezer track.
 */
class DeezerSearchProvider implements SearchProvider {
  readonly id = "deezer";
  readonly name = "Deezer";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: ExternalArtworkTokenStore
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<UnifiedSearchResult[]> {
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const types = (options.types && options.types.length ? options.types : ["track", "album", "artist"])
      .filter((type) => type !== "playlist");
    if (types.length === 0) return [];

    const deezer = new DeezerAdapter(this.fetchImpl, this.artworkTokens, limit);
    const itunes = new iTunesAdapter(this.fetchImpl, this.artworkTokens, 15);
    const deezerJobs: Promise<UnifiedSearchResult[]>[] = [];
    if (types.includes("track")) deezerJobs.push(deezer.searchTracks(query));
    if (types.includes("album")) deezerJobs.push(deezer.searchAlbums(query));
    if (types.includes("artist")) deezerJobs.push(deezer.searchArtists(query));

    const [deezerOutcome, itunesOutcome] = await Promise.allSettled([
      Promise.all(deezerJobs).then((results) => results.flat()),
      types.includes("track") ? itunes.searchTracks(query) : Promise.resolve([]),
    ]);
    if (deezerOutcome.status === "rejected" && itunesOutcome.status === "rejected") {
      throw new Error("Keyless catalog search failed");
    }
    return dedupeKeylessSearchResults([
      ...(deezerOutcome.status === "fulfilled" ? deezerOutcome.value : []),
      ...(itunesOutcome.status === "fulfilled" ? itunesOutcome.value : []),
    ]);
  }

  async test(): Promise<{ ok: boolean; message?: string; status?: string }> {
    try {
      await new DeezerAdapter(this.fetchImpl, this.artworkTokens, 1).searchTracks("test");
      return { ok: true, message: "Deezer is reachable" };
    } catch (error) {
      return {
        ok: false,
        status: "provider_unavailable",
        message: `Deezer is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
/**
 * Built-in external catalog search provider backed by Spotify's official
 * Web API (https://api.spotify.com/v1/search) using the client-credentials
 * flow. Credentials are configured server-side via this provider's admin
 * settings and never sent to clients. When credentials are absent the
 * provider reports itself unavailable rather than failing the whole search.
 */
class SpotifySearchProvider implements SearchProvider {
  readonly id = "spotify";
  readonly name = "Spotify";

  private readonly auth: SpotifyAuthClient;

  constructor(
    private readonly config: Record<string, unknown>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly db?: Db
  ) {
    this.auth = new SpotifyAuthClient(fetchImpl);
  }

  async search(query: string, options: SearchOptions = {}): Promise<UnifiedSearchResult[]> {
    const credentials = resolveSpotifyCredentials({
      clientId: typeof this.config.clientId === "string" ? this.config.clientId : undefined,
      clientSecret: typeof this.config.clientSecret === "string" ? this.config.clientSecret : undefined,
    }, this.db);

    if (!hasSpotifyCredentials(credentials)) {
      // No credentials configured: Spotify search is simply unavailable,
      // not an error. The registry treats an empty result set from an
      // enabled provider as a normal (non-degraded) outcome.
      return [];
    }

    let token: string | null;
    try {
      token = await this.auth.getAccessToken(credentials);
    } catch (error) {
      if (error instanceof SpotifyAuthError) {
        throw new Error(`Spotify token request failed: ${error.message}`);
      }
      throw new Error(`Spotify is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!token) {
      throw new Error("Spotify is unavailable: no credentials configured");
    }

    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 25);
    const types = (options.types && options.types.length ? options.types : ["track", "album", "artist"])
      .filter((type) => type !== "playlist");
    if (types.length === 0) {
      return [];
    }

    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", query);
    url.searchParams.set("type", types.join(","));
    url.searchParams.set("limit", String(limit));

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new Error(`Spotify catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = describeSpotifyErrorBody(bodyText);
      throw new Error(
        `Spotify catalog request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
      );
    }

    let payload: {
      tracks?: { items?: any[] };
      albums?: { items?: any[] };
      artists?: { items?: any[] };
    };
    try {
      payload = await response.json();
    } catch {
      throw new Error("External catalog returned invalid data");
    }

    const tracks = (payload.tracks?.items || []).flatMap((item) => {
      if (!item?.id) return [];
      const artistName = Array.isArray(item.artists) && item.artists[0]?.name ? item.artists[0].name : null;
      return [{
        type: "track" as const,
        id: `external_spotify_track_${item.id}`,
        title: item.name || "Unknown title",
        subtitle: artistName,
        artist: artistName,
        album: item.album?.name || null,
        // Artwork is resolved via the external catalog registry's artwork
        // proxy, not exposed here to keep raw provider URLs server-side.
        artwork: null,
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        metadata: {
          durationSeconds: typeof item.duration_ms === "number" ? Math.round(item.duration_ms / 1000) : null,
        },
      }];
    });

    const albums = (payload.albums?.items || []).flatMap((item) => {
      if (!item?.id || !isIncluded({ type: "album" } as UnifiedSearchResult, options.types)) return [];
      const artistName = Array.isArray(item.artists) && item.artists[0]?.name ? item.artists[0].name : null;
      return [{
        type: "album" as const,
        id: `external_spotify_album_${item.id}`,
        title: item.name || "Unknown album",
        subtitle: artistName,
        artist: artistName,
        album: null,
        artwork: null,
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        metadata: {},
      }];
    });

    const artists = (payload.artists?.items || []).flatMap((item) => {
      if (!item?.id || !isIncluded({ type: "artist" } as UnifiedSearchResult, options.types)) return [];
      return [{
        type: "artist" as const,
        id: `external_spotify_artist_${item.id}`,
        title: item.name || "Unknown artist",
        subtitle: "Artist",
        artist: item.name || null,
        album: null,
        artwork: null,
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        metadata: {},
      }];
    });

    return [
      ...tracks.filter((item) => isIncluded(item, options.types)),
      ...albums,
      ...artists,
    ];
  }

  async test(): Promise<{ ok: boolean; message?: string; status?: string }> {
    const credentials = resolveSpotifyCredentials({
      clientId: typeof this.config.clientId === "string" ? this.config.clientId : undefined,
      clientSecret: typeof this.config.clientSecret === "string" ? this.config.clientSecret : undefined,
    }, this.db);

    if (!hasSpotifyCredentials(credentials)) {
      return {
        ok: false,
        status: "not_configured",
        message: "Spotify search is not configured — add a Client ID/Secret here or on the spotDL Downloader plugin.",
      };
    }

    // Stage 1: token acquisition. A failure here almost always means a bad
    // Client ID/Secret or an app that has been reset/deleted in the Spotify
    // developer dashboard.
    let token: string | null;
    try {
      token = await this.auth.getAccessToken(credentials);
    } catch (error) {
      if (error instanceof SpotifyAuthError) {
        return {
          ok: false,
          status: error.status === 400 ? "authentication_failed" : "provider_unavailable",
          message: `Spotify authentication failed during token acquisition: ${error.message}`,
        };
      }
      return {
        ok: false,
        status: "authentication_failed",
        message: `Spotify authentication failed during token acquisition: ${error instanceof Error ? error.message : "invalid credentials"}`,
      };
    }

    if (!token) {
      return { ok: false, status: "authentication_failed", message: "Spotify authentication failed during token acquisition — check the Client ID/Secret." };
    }

    // Stage 2: the actual catalog request. A 403 here (with a valid token)
    // typically means the Spotify app is missing required authorization —
    // e.g. it was created after the Nov 2024 Web API changes and never had
    // the "Web API" scope granted, or it's in Development Mode with
    // restricted access — rather than a credentials problem.
    try {
      const response = await this.fetchImpl(new URL("https://api.spotify.com/v1/search?q=test&type=track&limit=1"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const detail = describeSpotifyErrorBody(bodyText);
        return {
          ok: false,
          status: response.status === 401 || response.status === 403 ? "authentication_failed" : "provider_unavailable",
          message: `Spotify catalog request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
            + (response.status === 403
              ? " — the app's Client ID/Secret are valid, but Spotify rejected the catalog request itself. Check the app's status in the Spotify developer dashboard (e.g. Development Mode restrictions or a revoked app)."
              : ""),
        };
      }
      return { ok: true, message: "Spotify is reachable" };
    } catch (error) {
      return {
        ok: false,
        status: "provider_unavailable",
        message: `Spotify catalog request failed — could not reach api.spotify.com: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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

  constructor(
    db: Db,
    catalog: CatalogService,
    playlists: PlaylistService,
    fetchImpl?: typeof fetch,
    artworkTokens?: ExternalArtworkTokenStore
  ) {
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
        id: "deezer",
        name: "Deezer",
        kind: "external",
        defaultEnabled: true,
        create: () => new DeezerSearchProvider(fetchImpl, artworkTokens),
      },
      {
        id: "spotify",
        name: "Spotify",
        kind: "external",
        defaultEnabled: false,
        create: (config) => new SpotifySearchProvider(config, fetchImpl, db),
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
        ...(lastError ? { statusMessage: lastError } : {}),
        config: publicConfig(config),
      };
    });
  }

  /**
   * Returns the enablement state and raw (non-redacted) config for a
   * provider. Intended for server-side wiring (e.g. the external catalog
   * registry) that legitimately needs credentials -- unlike `list()`, which
   * redacts secret-shaped keys for admin API responses.
   */
  rawConfig(providerId: string): { enabled: boolean; config: Record<string, unknown> } | null {
    const definition = this.definitions.find((item) => item.id === providerId);
    if (!definition) return null;

    const row = this.configs().get(providerId);
    const config = row ? readConfig(row.config_json) : {};
    const enabled = row ? Boolean(row.enabled) : definition.defaultEnabled;
    return { enabled, config };
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
      } catch (error) {
        const classified = classifyPluginError(error);
        this.lastErrors.set(definition.id, `${definition.name} is unavailable: ${classified.message}`);
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

  /** Runs a provider's connectivity/configuration check without performing a real search. */
  async test(providerId: string) {
    const definition = this.definitions.find((item) => item.id === providerId);
    if (!definition) {
      throw new Error("Unknown search provider");
    }

    const row = this.configs().get(providerId);
    const config = row ? readConfig(row.config_json) : {};
    const provider = definition.create(config);

    if (!provider.test) {
      return { id: providerId, ok: true, status: "success" as const, message: `${definition.name} is configured` };
    }

    try {
      const result = await provider.test();
      const status = result.ok ? "success" : (result.status || classifyPluginError(new Error(result.message)).status);
      return {
        id: providerId,
        ok: result.ok,
        status,
        message: result.message
          || (result.ok ? `${definition.name} is reachable` : `${definition.name} is unavailable`),
      };
    } catch (error) {
      const classified = classifyPluginError(error);
      return { id: providerId, ok: false, status: classified.status, message: `${definition.name}: ${classified.message}` };
    }
  }
}
