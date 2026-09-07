import type { Db } from "../db/database.js";
import type { CatalogService } from "../domain/catalog.js";
import type { LibraryInsightsService } from "../domain/library-insights.js";
import type { RecommendationProvider, RecommendationRegistry } from "../domain/recommendations.js";
import type { SearchProvider } from "../domain/search.js";
import type { SourceProvider } from "../domain/playable-sources.js";
import type { SourceProviderRegistry } from "../domain/source-provider-registry.js";
import type { CandidateResolver, SourceContainerProvider, SourceDetailProvider, SourceDiscoveryProvider, SourcePipelineRegistry } from "../domain/source-discovery.js";
import type { AcquisitionProvider, AcquisitionProviderRegistry } from "../domain/acquisition.js";
import { classifyPluginError, ClassifiedPluginError, withPluginTimeout, type PluginErrorStatus } from "./plugin-errors.js";

export const PLUGIN_CAPABILITIES = new Set([
  "search",
  "catalog",
  "source",
  "acquisition",
  "recommendation",
  "metadata",
  "artwork",
  "lyrics",
  "scrobble",
  "import",
  "library-insight",
  "automation",
  "ui",
  "theme",
]);

export const PLUGIN_PERMISSIONS = new Set([
  "library.acquire",
  "library.read",
  "library.write",
  "history.read",
  "playlist.read",
  "playlist.write",
  "playback.start",
  "network.request",
  "external-source.play",
  "user.read",
  "settings.read",
  "settings.write",
  "ui.register",
]);

export const PLUGIN_EVENTS = new Set([
  "track.started",
  "track.completed",
  "track.skipped",
  "playback.paused",
  "playback.stopped",
  "queue.changed",
  "playlist.created",
  "playlist.updated",
  "favorite.changed",
  "rating.changed",
  "library.updated",
  "search.performed",
  "acquisition.created",
  "acquisition.started",
  "acquisition.progress",
  "acquisition.completed",
  "acquisition.failed",
  "acquisition.cancelled",
  "library.imported",
]);

export type PluginCapability = string;
export type PluginPermission = string;

export type PluginConfigField = {
  key: string;
  label?: string;
  type?: "string" | "number" | "boolean" | "select" | string;
  options?: Array<{ label: string; value: string | number | boolean }>;
  description?: string;
  secret?: boolean;
  required?: boolean;
  default?: unknown;
};

export type MusicDeckPluginManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  capabilities: PluginCapability[];
  permissions?: PluginPermission[];
  config?: {
    fields?: PluginConfigField[];
  };
};

export type UIExtension = {
  location: "home" | "explore" | "artist" | "album" | "track" | "now-playing" | "settings";
  id: string;
  title: string;
};

export type MusicDeckPlugin = {
  manifest: MusicDeckPluginManifest;
  register?(context: MusicDeckPluginContext): void | Promise<void>;
  test?(context: MusicDeckPluginContext): Promise<{ ok: boolean; message?: string }>;
};

export type PluginLog = {
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
};

export type MusicDeckPluginContext = {
  search?: {
    register(provider: SearchProvider): void;
  };
  sources?: {
    register(provider: SourceProvider): void;
  };
  sourceDiscovery?: {
    register(provider: SourceDiscoveryProvider): void;
    configure(providerId: string, enabled: boolean): void;
  };
  sourceDetail?: {
    register(provider: SourceDetailProvider): void;
  };
  sourceContainers?: {
    register(provider: SourceContainerProvider): void;
  };
  sourceResolvers?: {
    register(provider: CandidateResolver): void;
    configure(providerId: string, enabled: boolean): void;
  };
  recommendations?: {
    register(provider: RecommendationProvider): void;
  };
  library?: {
    insights: LibraryInsightsService;
  };
  acquisition?: {
    register(provider: AcquisitionProvider): void;
  };
  catalog?: CatalogService;
  playlists?: {
    create(name: string, userId: string): Promise<{ id: string }>;
    addTrack(playlistId: string, trackId: string): Promise<{ added: boolean }>;
  };
  settings: {
    get<T = unknown>(key: string): T | undefined;
  };
  network?: {
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  };
  events: {
    subscribe(event: string, handler: (payload: Record<string, unknown>) => void): void;
  };
  logging: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  ui?: {
    register(extension: UIExtension): void;
  };
};

type PluginRow = {
  plugin_id: string;
  enabled: number;
  config_json: string;
  permissions_json: string;
  updated_at: string;
};

type PluginState = {
  plugin: MusicDeckPlugin;
  origin: "first-party" | "third-party";
  status: "installed" | "enabled" | "disabled" | "error";
  error: string | null;
  logs: PluginLog[];
  uiExtensions: UIExtension[];
  /** Provider ids this plugin registered while enabled, tracked so disable()
   * can actually switch them off and enable() can switch them back on. */
  registrations: { sources: Set<string>; pipeline: Set<string> };
};

function validateManifest(manifest: MusicDeckPluginManifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid plugin manifest");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id || "")) {
    throw new Error("Invalid plugin ID");
  }
  if (!manifest.name || !manifest.version) {
    throw new Error("Plugin name and version are required");
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error("Plugin must declare at least one capability");
  }
  for (const capability of manifest.capabilities) {
    if (!PLUGIN_CAPABILITIES.has(capability)) {
      throw new Error(`Unsupported plugin capability: ${capability}`);
    }
  }
  for (const permission of manifest.permissions || []) {
    if (!PLUGIN_PERMISSIONS.has(permission)) {
      throw new Error(`Unsupported plugin permission: ${permission}`);
    }
  }
}

function readJson(value: string, fallback: unknown) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function redactConfig(manifest: MusicDeckPluginManifest, config: Record<string, unknown>) {
  const fields = new Map((manifest.config?.fields || []).map((field) => [field.key, field]));
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    fields.get(key)?.secret || /(key|token|secret|password)/i.test(key) ? Boolean(value) : value,
  ]));
}

function requiredConfigMissing(manifest: MusicDeckPluginManifest, config: Record<string, unknown>) {
  return (manifest.config?.fields || [])
    .filter((field) => field.required)
    .filter((field) => config[field.key] === undefined || config[field.key] === null || config[field.key] === "");
}

/**
 * Central plugin registry for first-party, in-process plugin modules. It
 * deliberately does not execute arbitrary third-party JavaScript; a safe
 * sandbox/package system can later install modules that satisfy this API.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, PluginState>();
  private readonly subscribers = new Map<string, Array<{ pluginId: string; handler: (payload: Record<string, unknown>) => void }>>();

  constructor(
    private readonly db: Db,
    private readonly bridges: {
      catalog: CatalogService;
      libraryInsights: LibraryInsightsService;
      search?: { register(provider: SearchProvider): void };
      sources?: SourceProviderRegistry;
      sourcePipeline?: SourcePipelineRegistry;
      acquisition?: AcquisitionProviderRegistry;
      recommendations?: RecommendationRegistry;
      playlists?: {
        create(name: string, userId: string): Promise<{ id: string }>;
        addTrack(playlistId: string, trackId: string): Promise<{ added: boolean }>;
      };
      fetchImpl?: typeof fetch;
    }
  ) {}

  private rows() {
    return new Map((this.db.prepare(
      "SELECT plugin_id, enabled, config_json, permissions_json, updated_at FROM plugin_configs"
    ).all() as PluginRow[]).map((row) => [row.plugin_id, row]));
  }

  private approvedPermissions(pluginId: string, manifest: MusicDeckPluginManifest) {
    const row = this.rows().get(pluginId);
    const approved = new Set(readJson(row?.permissions_json || "[]", []) as string[]);
    return new Set((manifest.permissions || []).filter((permission) => approved.has(permission)));
  }

  private log(pluginId: string, level: PluginLog["level"], message: string) {
    const state = this.plugins.get(pluginId);
    if (!state) return;
    state.logs.push({ level, message: message.slice(0, 300), createdAt: new Date().toISOString() });
    state.logs = state.logs.slice(-50);
  }

  private context(pluginId: string, manifest: MusicDeckPluginManifest): MusicDeckPluginContext {
    const permissions = this.approvedPermissions(pluginId, manifest);
    const has = (permission: PluginPermission) => permissions.has(permission);
    const row = this.rows().get(pluginId);
    const config = readJson(row?.config_json || "{}", {}) as Record<string, unknown>;
    const context: MusicDeckPluginContext = {
      settings: {
        get: <T,>(key: string) => config[key] as T | undefined,
      },
      events: {
        subscribe: (event, handler) => {
          if (!PLUGIN_EVENTS.has(event) || !has("history.read")) {
            throw new Error("Plugin event permission denied");
          }
          const subscribers = this.subscribers.get(event) || [];
          subscribers.push({ pluginId, handler });
          this.subscribers.set(event, subscribers);
        },
      },
      logging: {
        info: (message) => this.log(pluginId, "info", message),
        warn: (message) => this.log(pluginId, "warn", message),
        error: (message) => this.log(pluginId, "error", message),
      },
    };

    if (manifest.capabilities.includes("search") && this.bridges.search) {
      context.search = { register: (provider) => this.bridges.search!.register(provider) };
    }
    if (manifest.capabilities.includes("source") && this.bridges.sources) {
      context.sources = {
        register: (provider) => {
          this.bridges.sources!.register(provider);
          this.plugins.get(pluginId)?.registrations.sources.add(provider.id);
        },
      };
    }
    if (manifest.capabilities.includes("source") && this.bridges.sourcePipeline && has("external-source.play")) {
      context.sourceDiscovery = {
        register: (provider) => {
          this.bridges.sourcePipeline!.registerDiscovery(provider);
          this.plugins.get(pluginId)?.registrations.pipeline.add(provider.id);
        },
        configure: (providerId, enabled) => this.bridges.sourcePipeline!.configure(providerId, enabled),
      };
      context.sourceDetail = {
        register: (provider) => {
          this.bridges.sourcePipeline!.registerDetail(provider);
          this.plugins.get(pluginId)?.registrations.pipeline.add(provider.id);
        },
      };
      context.sourceContainers = {
        register: (provider) => {
          this.bridges.sourcePipeline!.registerContainer(provider);
          this.plugins.get(pluginId)?.registrations.pipeline.add(provider.id);
        },
      };
      context.sourceResolvers = {
        register: (provider) => {
          this.bridges.sourcePipeline!.registerResolver(provider);
          this.plugins.get(pluginId)?.registrations.pipeline.add(provider.id);
        },
        configure: (providerId, enabled) => this.bridges.sourcePipeline!.configure(providerId, enabled),
      };
    }
    if (manifest.capabilities.includes("recommendation") && this.bridges.recommendations) {
      context.recommendations = { register: (provider) => this.bridges.recommendations!.register(provider) };
    }
    if (manifest.capabilities.includes("acquisition") && this.bridges.acquisition && has("library.acquire")) {
      context.acquisition = {
        register: (provider) => {
          this.bridges.acquisition!.register(provider);
        },
      };
    }
    if (has("library.read")) {
      context.catalog = this.bridges.catalog;
      context.library = { insights: this.bridges.libraryInsights };
    }
    if (has("playlist.write") && this.bridges.playlists) {
      context.playlists = this.bridges.playlists;
    }
    // Always expose a network bridge. When the plugin lacks the
    // network.request permission, fetch throws a classified permission error
    // instead of crashing on an undefined bridge (which would surface as an
    // opaque plugin_error/500).
    const networkFetch = withPluginTimeout(this.bridges.fetchImpl || fetch);
    context.network = has("network.request")
      ? { fetch: networkFetch }
      : {
          fetch: (() => {
            throw new ClassifiedPluginError("permission_denied");
          }) as unknown as typeof fetch,
        };
    if (manifest.capabilities.includes("ui") && has("ui.register")) {
      context.ui = {
        register: (extension) => {
          const state = this.plugins.get(pluginId);
          if (state) state.uiExtensions.push(extension);
        },
      };
    }

    return context;
  }

  async register(plugin: MusicDeckPlugin, origin: "first-party" | "third-party" = "first-party") {
    validateManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error("Plugin is already registered");
    }

    const state: PluginState = {
      plugin,
      origin,
      status: "installed",
      error: null,
      logs: [],
      uiExtensions: [],
      registrations: { sources: new Set(), pipeline: new Set() },
    };
    this.plugins.set(plugin.manifest.id, state);

    const row = this.rows().get(plugin.manifest.id);
    // Custom (third-party) plugins are never auto-enabled on registration,
    // even if a stale enabled row exists from a previous install: an admin
    // must explicitly re-approve permissions and enable them.
    if (row?.enabled && origin === "first-party") {
      await this.enable(plugin.manifest.id);
    } else {
      state.status = "disabled";
    }
  }

  /**
   * Installs a custom (third-party) plugin from a validated manifest. The
   * plugin is registered with structured, SDK-mediated capabilities only
   * (no arbitrary code execution) and is always left disabled with no
   * approved permissions until an administrator explicitly reviews and
   * enables it.
   */
  async installCustomPlugin(manifest: MusicDeckPluginManifest) {
    if (this.plugins.has(manifest.id)) {
      throw new Error("Plugin is already registered");
    }

    validateManifest(manifest);

    const plugin: MusicDeckPlugin = { manifest };
    await this.register(plugin, "third-party");

    // Ensure installation never grants permissions or enables the plugin,
    // even if a config row happened to exist already.
    this.db.prepare(`
      INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
      VALUES (?, 0, '{}', '[]', ?)
      ON CONFLICT(plugin_id) DO UPDATE SET enabled = 0, permissions_json = '[]', updated_at = excluded.updated_at
    `).run(manifest.id, new Date().toISOString());

    this.db.prepare(`
      INSERT INTO custom_plugins (plugin_id, manifest_json, installed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET manifest_json = excluded.manifest_json
    `).run(manifest.id, JSON.stringify(manifest), new Date().toISOString());

    return this.get(manifest.id, true);
  }

  /** Removes a custom plugin's registration and stored configuration. */
  uninstallPlugin(pluginId: string) {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error("Unknown plugin");
    if (state.origin !== "third-party") {
      throw new Error("Only custom plugins can be uninstalled");
    }

    if (state.status === "enabled") {
      this.disable(pluginId);
    }

    this.plugins.delete(pluginId);
    this.db.prepare("DELETE FROM plugin_configs WHERE plugin_id = ?").run(pluginId);
    this.db.prepare("DELETE FROM custom_plugins WHERE plugin_id = ?").run(pluginId);
  }

  /** Restores any previously installed custom plugins on server startup. */
  loadInstalledCustomPlugins() {
    const rows = this.db.prepare("SELECT plugin_id, manifest_json FROM custom_plugins").all() as Array<{ plugin_id: string; manifest_json: string }>;
    return rows.map((row) => readJson(row.manifest_json, null) as MusicDeckPluginManifest | null).filter((manifest): manifest is MusicDeckPluginManifest => Boolean(manifest));
  }

  async enable(pluginId: string) {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error("Unknown plugin");

    const row = this.rows().get(pluginId);
    const config = readJson(row?.config_json || "{}", {}) as Record<string, unknown>;
    const missing = requiredConfigMissing(state.plugin.manifest, config);
    if (missing.length > 0) {
      state.status = "error";
      state.error = "not_configured";
      throw new ClassifiedPluginError("not_configured", "Plugin is misconfigured");
    }

    try {
      await state.plugin.register?.(this.context(pluginId, state.plugin.manifest));
      state.status = "enabled";
      state.error = null;
      if (this.rows().has(pluginId)) {
        this.db.prepare(
          "UPDATE plugin_configs SET enabled = 1, updated_at = ? WHERE plugin_id = ?"
        ).run(new Date().toISOString(), pluginId);
      } else {
        this.db.prepare(`
          INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
          VALUES (?, 1, '{}', '[]', ?)
        `).run(pluginId, new Date().toISOString());
      }
      if (state.plugin.manifest.capabilities.includes("source")) {
        // Switch on every provider this plugin registered (tracked in the
        // context wrappers above), whatever ids the plugin chose.
        for (const providerId of state.registrations.sources) {
          try {
            this.bridges.sources?.configure(providerId, true);
          } catch {
            // Provider may only participate in the discovery pipeline.
          }
        }
        for (const providerId of state.registrations.pipeline) {
          try {
            this.bridges.sourcePipeline?.configure(providerId, true);
          } catch {
            // Provider may only participate in the source registry.
          }
        }
      }
    } catch (error) {
      const classified = classifyPluginError(error);
      state.status = "error";
      state.error = classified.status;
      // The real error (which may include upstream details) is logged
      // server-side only; clients only ever see the normalized status.
      this.log(pluginId, "error", `enable failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new ClassifiedPluginError(classified.status, classified.message);
    }
  }

  disable(pluginId: string) {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error("Unknown plugin");

    // Switch off everything the plugin registered so a disabled plugin truly
    // stops serving sources, resolving candidates, or reacting to events.
    for (const providerId of state.registrations.sources) {
      try {
        this.bridges.sources?.configure(providerId, false);
      } catch {
        // Provider may only participate in the discovery pipeline.
      }
    }
    for (const providerId of state.registrations.pipeline) {
      try {
        this.bridges.sourcePipeline?.configure(providerId, false);
      } catch {
        // Provider may only participate in the source registry.
      }
    }
    for (const [event, subscribers] of this.subscribers) {
      this.subscribers.set(event, subscribers.filter((subscriber) => subscriber.pluginId !== pluginId));
    }
    state.uiExtensions = [];

    state.status = "disabled";
    this.db.prepare(`
      INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
      VALUES (?, 0, '{}', '[]', ?)
      ON CONFLICT(plugin_id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at
    `).run(pluginId, new Date().toISOString());
  }

  configure(pluginId: string, input: { enabled?: boolean; config?: Record<string, unknown>; permissions?: string[] }) {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error("Unknown plugin");

    for (const permission of input.permissions || []) {
      if (!(state.plugin.manifest.permissions || []).includes(permission)) {
        throw new Error("Plugin did not request permission");
      }
    }

    const row = this.rows().get(pluginId);
    const config = input.config ?? readJson(row?.config_json || "{}", {});
    const permissions = input.permissions ?? readJson(row?.permissions_json || "[]", []);
    const enabled = input.enabled ?? Boolean(row?.enabled);

    this.db.prepare(`
      INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        permissions_json = excluded.permissions_json,
        updated_at = excluded.updated_at
    `).run(pluginId, enabled ? 1 : 0, JSON.stringify(config), JSON.stringify(permissions), new Date().toISOString());
  }

  list(admin = false) {
    const rows = this.rows();
    return [...this.plugins.values()].map((state) => {
      const row = rows.get(state.plugin.manifest.id);
      const config = readJson(row?.config_json || "{}", {}) as Record<string, unknown>;
      return {
        id: state.plugin.manifest.id,
        name: state.plugin.manifest.name,
        version: state.plugin.manifest.version,
        description: state.plugin.manifest.description || null,
        author: state.plugin.manifest.author || null,
        origin: state.origin,
        capabilities: state.plugin.manifest.capabilities,
        permissions: state.plugin.manifest.permissions || [],
        approvedPermissions: readJson(row?.permissions_json || "[]", []),
        enabled: Boolean(row?.enabled),
        status: state.status,
        health: state.status === "error"
          ? "error"
          : state.status === "enabled"
            ? "healthy"
            : requiredConfigMissing(state.plugin.manifest, config).length > 0
              ? "unconfigured"
              : "disabled",
        config: admin ? redactConfig(state.plugin.manifest, config) : {},
        configFields: (state.plugin.manifest.config?.fields || []).map((field) => ({
          key: field.key,
          label: field.label || field.key,
          secret: Boolean(field.secret),
          required: Boolean(field.required),
          configured: config[field.key] !== undefined && config[field.key] !== null && config[field.key] !== "",
        })),
        configRequired: requiredConfigMissing(state.plugin.manifest, config).map((field) => field.key),
        uiExtensions: state.uiExtensions,
        ...(admin ? { logs: state.logs.slice(-10), error: state.error } : {}),
      };
    });
  }

  get(pluginId: string, admin = false) {
    const plugin = this.list(admin).find((item) => item.id === pluginId);
    if (!plugin) throw new Error("Unknown plugin");
    return plugin;
  }

  async test(pluginId: string) {
    const state = this.plugins.get(pluginId);
    if (!state) throw new Error("Unknown plugin");

    const row = this.rows().get(pluginId);
    const config = readJson(row?.config_json || "{}", {}) as Record<string, unknown>;
    const missing = requiredConfigMissing(state.plugin.manifest, config);
    if (missing.length > 0) {
      const fields = missing.map((field) => field.label || field.key).join(", ");
      return { ok: false, status: "not_configured" as PluginErrorStatus, message: `Plugin is not fully configured — missing: ${fields}` };
    }

    try {
      const result = await state.plugin.test?.(this.context(pluginId, state.plugin.manifest));
      if (!result) {
        return { ok: true, status: "success" as PluginErrorStatus, message: "Plugin is registered" };
      }
      const status: PluginErrorStatus = result.ok
        ? "success"
        : ((result as { status?: PluginErrorStatus }).status || classifyPluginError(new Error(result.message)).status);
      return {
        ok: result.ok,
        status,
        message: result.message,
        details: (result as { details?: Record<string, unknown> }).details,
      };
    } catch (error) {
      const classified = classifyPluginError(error);
      // Preserve the real underlying failure in server logs only; the
      // client only ever receives the normalized status/message.
      this.log(pluginId, "error", `test failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, status: classified.status, message: classified.message };
    }
  }

  emit(event: string, payload: Record<string, unknown>) {
    for (const subscriber of this.subscribers.get(event) || []) {
      try {
        subscriber.handler(payload);
      } catch {
        this.log(subscriber.pluginId, "error", "plugin event handler failed");
      }
    }
  }
}
