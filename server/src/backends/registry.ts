import type { MusicProvider } from "./music-backend.js";

/**
 * A configured provider connection with its live provider instance.
 * `connectionId` is the stable backend_connections row ID; multiple
 * connections of the same `type` (e.g. two Navidrome servers) must not
 * collide. The provider implements catalog + stream; user-data sync is
 * optional.
 */
export type RegisteredProvider = {
  connectionId: string;
  type: string;
  name: string;
  enabled: boolean;
  provider: MusicProvider;
};

/**
 * Holds the currently configured provider connections.
 *
 * Phase 8A-1 scope: providers are loaded once at startup from the enabled
 * backend_connections rows; routes keep using `getPrimary()` so behavior is
 * identical to the previous single-connection factory. Multi-provider
 * catalog merging and source resolution are intentionally not implemented
 * here.
 */
export class ProviderRegistry {
  private readonly providers: RegisteredProvider[];

  constructor(providers: RegisteredProvider[]) {
    this.providers = [...providers];
  }

  list(): RegisteredProvider[] {
    return [...this.providers];
  }

  getByConnectionId(connectionId: string): RegisteredProvider | undefined {
    return this.providers.find((entry) => entry.connectionId === connectionId);
  }

  /**
   * The primary provider preserves the pre-registry behavior: the oldest
   * enabled connection, as the previous factory selected with
   * `ORDER BY created_at ASC LIMIT 1`.
   */
  getPrimary(): RegisteredProvider {
    const primary = this.providers[0];

    if (!primary) {
      throw new Error("No enabled backend connections are configured");
    }

    return primary;
  }
}
