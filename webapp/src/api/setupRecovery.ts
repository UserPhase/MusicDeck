export interface SystemConfigurationInput {
  version: 1; backend: "navidrome" | "jellyfin";
  navidrome: { url: string; username: string; password?: string };
  jellyfin: { url: string; apiKey?: string };
  musicRoot: string; acquisitionTmpDir: string;
}
export interface DiagnosticCheck { id: string; category: "connection" | "storage" | "dependencies" | "database"; title: string; status: "pass" | "warning" | "fail"; message: string; fix: string; durationMs: number }
export interface DiagnosticReport { checkedAt: string; status: "pass" | "warning" | "fail"; ready: boolean; checks: DiagnosticCheck[] }
export interface SystemBackup { id: string; filename: string; bytes: number; createdAt: string; kind: "system" | "safety" }
export interface SystemRecoveryStatus {
  configuration: Omit<SystemConfigurationInput, "navidrome" | "jellyfin"> & { navidrome: { url: string; username: string; passwordSet: boolean }; jellyfin: { url: string; apiKeySet: boolean } };
  firstRun: boolean; restartSupported: boolean; backupDaily: boolean;
  operation: { state: string; message: string; updatedAt: string; safetyBackupId?: string };
  backups: SystemBackup[]; limits: { uploadBytes: number; expandedBytes: number }; mediaIncluded: false;
}
export class SystemRecoveryRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function call<T>(suffix: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/admin/system/${suffix}`, { credentials: "include", cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new SystemRecoveryRequestError(body?.error?.message || `System operation failed (HTTP ${response.status}).`, response.status);
  if (body === null) throw new Error("The server returned an unreadable recovery response. Check its status before retrying.");
  return body;
}
const json = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
export const getSystemRecoveryStatus = (signal?: AbortSignal) => call<SystemRecoveryStatus>("status", { signal });
export const runSystemDiagnostics = (configuration?: SystemConfigurationInput) => call<{ report: DiagnosticReport }>("diagnostics", json(configuration));
export const saveSystemConfiguration = (configuration: SystemConfigurationInput) => call<{ accepted: boolean }>("configuration", json(configuration));
export const completeSystemSetup = () => call<{ completed: boolean; report: DiagnosticReport }>("setup/complete", json());
export const createSystemBackup = () => call<{ backup: SystemBackup }>("backups", json());
export const updateDailyBackupPolicy = (daily: boolean) => call<{ daily: boolean }>("backup-policy", { ...json({ daily }), method: "PATCH" });
export const restoreSystemBackup = (file: File) => call<{ accepted: boolean }>("restore", { method: "POST", headers: { "Content-Type": "application/gzip", "X-MusicDeck-Confirm-Restore": "replace-system-data" }, body: file });
export const systemBackupUrl = (id: string) => `/api/v1/admin/system/backups/${encodeURIComponent(id)}`;
