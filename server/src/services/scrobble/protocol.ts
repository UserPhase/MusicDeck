export type ScrobbleProvider = "lastfm" | "listenbrainz";
export type ScrobbleFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface ScrobbleListen {
  artist: string;
  track: string;
  album?: string;
  listenedAt: number;
  duration?: number;
}
export type FailureKind = "transient" | "auth" | "configuration" | "permanent" | "ignored" | "paused";
export class ScrobbleError extends Error {
  constructor(readonly code: string, message: string, readonly kind: FailureKind,
    readonly httpStatus?: number, readonly retryAfterMs = 0) { super(message); this.name = "ScrobbleError"; }
}
export function validateListen(listen: ScrobbleListen): void {
  if (![listen.artist, listen.track].every((value) => typeof value === "string" && value.trim() && value.length <= 500 && !value.includes("\0")) ||
    (listen.album !== undefined && (typeof listen.album !== "string" || listen.album.length > 500 || listen.album.includes("\0"))) ||
    !Number.isSafeInteger(listen.listenedAt) || listen.listenedAt <= 0 ||
    (listen.duration !== undefined && (!Number.isFinite(listen.duration) || listen.duration <= 0 || listen.duration > 86400))) {
    throw new ScrobbleError("INVALID_LISTEN", "The listen needs a valid artist, title, original timestamp, and duration.", "permanent");
  }
}
export function retryDelay(response: Response, now = Date.now()): number {
  const retry = response.headers.get("retry-after");
  const value = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now) : 0;
  const reset = Number(response.headers.get("x-ratelimit-reset-in")) * 1000;
  return Math.min(7 * 86_400_000, Math.max(0, Number.isFinite(value) ? value : 0, Number.isFinite(reset) ? reset : 0));
}
export function httpFailure(response: Response): ScrobbleError {
  const status = response.status;
  return new ScrobbleError(`HTTP_${status}`, `The scrobbling service returned HTTP ${status}.`,
    status === 429 || status === 408 || status >= 500 ? "transient" : status === 401 || status === 403 ? "auth" : "permanent",
    status, retryDelay(response));
}
/** Bound both request time and response size. Never include URLs, bodies, or credentials in errors. */
export async function protocolRequest(fetchImpl: ScrobbleFetch, url: string | URL, init: RequestInit, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: combined });
    let size = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    try {
      if (reader) for (;;) {
        combined.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new ScrobbleError("INVALID_RESPONSE", "The scrobbling service returned an oversized response.", "transient", response.status);
        }
        chunks.push(result.value);
      }
    } finally { reader?.releaseLock(); }
    combined.throwIfAborted();
    const text = Buffer.concat(chunks).toString("utf8");
    let body: any;
    try { body = JSON.parse(text); } catch { body = null; }
    return { response, body, text };
  } catch (error) {
    if (error instanceof ScrobbleError) throw error;
    if (signal?.aborted) throw new ScrobbleError("PAUSED", "Submission stopped; the listen remains queued.", "paused");
    throw new ScrobbleError("NETWORK_ERROR", "Could not reach the scrobbling service. Check connectivity; MusicDeck will retry.", "transient");
  }
}
