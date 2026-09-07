import type { CatalogProvider } from "./catalog-provider.js";
import type { StreamProvider } from "./stream-provider.js";
import type { UserDataSync } from "./user-data-sync.js";

export type { CatalogProvider, SearchResult } from "./catalog-provider.js";
export type { StreamProvider, StreamResult } from "./stream-provider.js";
export type { UserDataSync } from "./user-data-sync.js";
export { hasUserDataSync } from "./user-data-sync.js";

/**
 * Compatibility type for the current single-provider shape.
 *
 * Routes and domain services still consume one backend that happens to
 * provide every capability (Navidrome). New code should depend on the
 * focused interfaces (CatalogProvider / StreamProvider / UserDataSync)
 * instead of this union.
 */
export type MusicBackend = CatalogProvider & StreamProvider & UserDataSync;

/**
 * The general provider shape the registry can hold: catalog + stream are
 * required; provider-side user-data sync is optional (detected at runtime
 * with `hasUserDataSync`). Jellyfin implements catalog + stream only.
 */
export type MusicProvider = CatalogProvider & StreamProvider & Partial<UserDataSync>;
