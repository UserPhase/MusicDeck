import type { ArtistFollowService } from "../../services/ArtistFollowService.js";
import type { TaskDefinition, TaskManager } from "../../services/TaskManager.js";

export function createNewReleaseScannerRunner(service: ArtistFollowService): TaskDefinition<Record<string, never>> {
  return {
    validate(payload): payload is Record<string, never> {
      return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload!).length === 0;
    },
    async run(_payload, context) { await service.scan(context); },
  };
}

/** The same durable job handles hourly polling, startup catch-up, and explicit follows. */
export function enqueueReleaseScan(tasks: TaskManager): string {
  return (tasks.findPending("NEW_RELEASES_SCAN", {}) ?? tasks.enqueue("NEW_RELEASES_SCAN", {}, "system:new-releases")).id;
}
export function scheduleReleaseScans(tasks: TaskManager, catchUp = true): void {
  const existing = tasks.listSchedules().find(schedule => schedule.type === "NEW_RELEASES_SCAN");
  if (existing && !existing.enabled) return;
  if (!existing)
    tasks.setSchedule("NEW_RELEASES_SCAN", {}, "17 * * * *", "system:new-releases");
  if (catchUp) enqueueReleaseScan(tasks);
}
