import type { Db } from "../db/database.js";

/**
 * Connection-scoped user data (favorites, recently_played, playlist
 * ownership) stores provider item IDs alongside the backend connection they
 * belong to. In the current single-provider deployment every operation
 * targets the primary enabled connection — the same one the ProviderRegistry
 * selects as primary.
 *
 * Returns the primary connection ID, or null when no enabled connection
 * exists (the registry then runs on the synthetic environment provider and
 * connection-scoped reads simply match nothing instead of crashing).
 */
export function getPrimaryConnectionId(db: Db): string | null {
  const row = db.prepare(
    "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string } | undefined;

  return row?.id ?? null;
}
