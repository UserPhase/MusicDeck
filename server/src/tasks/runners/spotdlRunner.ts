import type { AcquisitionService } from "../../domain/acquisition.js";
import type { SpotifyPlaylistImportService } from "../../domain/spotify-playlist-import.js";
import type { TaskDefinition } from "../../services/TaskManager.js";

export interface SpotdlImportPayload {
  kind: "acquisition" | "playlist";
  jobId: string;
}

/**
 * Runs the existing import pipeline inside a scheduler slot. Its downloader
 * keeps the existing stdout/stderr parsing and receives the task's abort
 * signal and checkpoints through the service's DownloadContext.
 */
export function createSpotdlRunner(
  acquisition?: AcquisitionService,
  playlists?: SpotifyPlaylistImportService,
): TaskDefinition<SpotdlImportPayload> {
  return {
    validate(payload): payload is SpotdlImportPayload {
      if (!payload || typeof payload !== "object") return false;
      const value = payload as Record<string, unknown>;
      return Object.keys(value).every((key) => key === "kind" || key === "jobId") &&
        (value.kind === "acquisition" || value.kind === "playlist") &&
        typeof value.jobId === "string" && value.jobId.length > 0 && value.jobId.length <= 256;
    },
    async run(payload, task) {
      await task.checkpoint();
      task.report({ message: "Starting import" });
      if (payload.kind === "acquisition") {
        if (!acquisition) throw new Error("Acquisition service is unavailable");
        await acquisition.runManagedJob(payload.jobId, task);
      } else {
        if (!playlists) throw new Error("Playlist import service is unavailable");
        await playlists.runManagedJob(payload.jobId, task);
      }
      task.throwIfCancelled();
    },
  };
}
