import type { CatalogService } from "../../domain/catalog.js";
import type { TaskDefinition } from "../../services/TaskManager.js";

export interface LibraryScanPayload {
  refreshIndex?: boolean;
}

export const LIBRARY_SCAN_BATCH_SIZE = 50;

/**
 * Navidrome/Jellyfin own directory traversal. MusicDeck triggers their scans
 * sequentially, then refreshes its stable-ID index in bounded batches.
 */
export function createLibraryScanRunner(catalog: CatalogService): TaskDefinition<LibraryScanPayload> {
  return {
    validate(payload): payload is LibraryScanPayload {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const value = payload as Record<string, unknown>;
      return Object.keys(value).every((key) => key === "refreshIndex") &&
        (value.refreshIndex === undefined || typeof value.refreshIndex === "boolean");
    },
    async run(payload, task) {
      await task.checkpoint();
      const result = await catalog.scanLibrary(task);
      if (result.failures.length) {
        throw new AggregateError(result.failures, "One or more library providers could not be scanned");
      }
      if (payload.refreshIndex !== false) {
        await catalog.refreshIndex(task, LIBRARY_SCAN_BATCH_SIZE);
      }
      task.throwIfCancelled();
    },
  };
}
