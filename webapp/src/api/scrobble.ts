export type ScrobbleProvider = "lastfm" | "listenbrainz";
export interface ScrobbleConnection {
  provider: ScrobbleProvider; available: boolean; unavailableReason: string | null; enabled: boolean;
  username: string | null; status: string; lastSuccessfulScrobble: string | null; lastListenedAt: string | null;
  lastCheckedAt: string | null; nextRetryAt: string | null; pending: number; failed: number;
  error: { code: string; message: string; httpStatus: number | null } | null;
  diagnostics: Array<{ id: string; track: string; artist: string; listenedAt: string; state: string; attempts: number;
    code: string | null; message: string | null; httpStatus: number | null; nextRetryAt: string | null }>;
}
async function call<T>(suffix = "", init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 20_000);
  try {
    const response = await fetch(`/api/v1/scrobble${suffix}`, { ...init, signal: controller.signal, credentials: "include", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || `Scrobble operation failed (HTTP ${response.status}).`);
    if (!body) throw new Error("The server returned an unreadable scrobble status. Refresh before trying again.");
    return body;
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new Error("The connection check timed out. Refresh its status before retrying.");
    throw error;
  } finally { window.clearTimeout(timeout); init.signal?.removeEventListener("abort", abort); }
}
export const getScrobbleConnections = (signal?: AbortSignal) => call<{ connections: ScrobbleConnection[] }>("", { signal });
export const beginLastFmAuthorization = (signal?: AbortSignal) => call<{ authorizationUrl: string }>("/lastfm/authorize", { method: "POST", signal });
export const connectScrobble = (provider: ScrobbleProvider, credential: string, signal?: AbortSignal) => call<{ connections: ScrobbleConnection[] }>(`/${provider}`, {
  method: "PUT", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(provider === "lastfm" ? { sessionKey: credential } : { token: credential }),
});
export const scrobbleAction = (provider: ScrobbleProvider, action: "test" | "retry" | "disconnect", signal?: AbortSignal) => call<{ connections: ScrobbleConnection[] }>(
  `/${provider}${action === "disconnect" ? "" : `/${action}`}`, { method: action === "disconnect" ? "DELETE" : "POST", signal });
