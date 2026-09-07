import type { Db } from "../db/database.js";
import type { AppConfig } from "../config.js";
import type { MusicProvider } from "./music-backend.js";
import { ProviderRegistry, type RegisteredProvider } from "./registry.js";
import { NavidromeBackend } from "./navidrome/navidrome-backend.js";
import { JellyfinBackend } from "./jellyfin/jellyfin-backend.js";

type BackendConnectionRow = {
  id: string;
  type: string;
  name: string;
  config_json: string;
  enabled: number;
};

/**
 * Stored connection config. Credentials are deliberately not persisted
 * (see seedInitialData); they come from the environment-backed config.
 */
type StoredProviderConfig = {
  url?: string;
  username?: string;
  password?: string;
  apiKey?: string;
};

function parseStoredConfig(configJson: string): StoredProviderConfig {
  try {
    const parsed = JSON.parse(configJson) as StoredProviderConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Create one provider instance from a connection type. Provider creation is
 * kept separate from registry loading so tests can exercise either side
 * independently. Unknown types fail loudly instead of being skipped, so a
 * misconfigured connection cannot silently degrade the catalog.
 */
export function createProvider(
  type: string,
  storedConfig: StoredProviderConfig,
  config: AppConfig
): MusicProvider {
  if (type === "navidrome") {
    return new NavidromeBackend({
      url: config.navidrome.url || storedConfig.url || "",
      username: config.navidrome.username || storedConfig.username || "",
      password: config.navidrome.password || storedConfig.password || "",
    });
  }

  if (type === "jellyfin") {
    return new JellyfinBackend({
      url: process.env.JELLYFIN_URL || storedConfig.url || "",
      apiKey: process.env.JELLYFIN_API_KEY || storedConfig.apiKey || "",
    });
  }

  throw new Error(`Unknown backend provider type: ${type}`);
}

/**
 * Load every enabled backend_connections row into a ProviderRegistry.
 *
 * Preserves the previous single-connection behavior: providers are ordered
 * by created_at ASC so `getPrimary()` returns the same connection the old
 * factory selected. If the table has no enabled rows, a synthetic
 * environment-configured Navidrome entry keeps startup working, matching
 * the old factory's `stored = {}` fallback.
 */
export function createProviderRegistry(db: Db, config: AppConfig): ProviderRegistry {
  const rows = db.prepare(
    "SELECT id, type, name, config_json, enabled FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC"
  ).all() as BackendConnectionRow[];

  const providers: RegisteredProvider[] = rows.map((row) => ({
    connectionId: row.id,
    type: row.type,
    name: row.name,
    enabled: true,
    provider: createProvider(row.type, parseStoredConfig(row.config_json), config),
  }));

  if (providers.length === 0) {
    providers.push({
      connectionId: "env-navidrome",
      type: "navidrome",
      name: "Navidrome",
      enabled: true,
      provider: createProvider("navidrome", {}, config),
    });
  }

  return new ProviderRegistry(providers);
}
