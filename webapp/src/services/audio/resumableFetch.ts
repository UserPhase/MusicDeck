export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RangeResumeOptions {
  fetchImpl?: FetchLike;
  init?: Omit<RequestInit, "headers" | "signal">;
  headers?: Record<string, string>;
  signal: AbortSignal;
  /** Hard cap on downloaded bytes; protects memory before decodeAudioData runs. */
  maxBytes: number;
  maxRetries: number;
  backoffMs: (attempt: number) => number;
}

export class FetchAbortedError extends Error {
  constructor() {
    super("Fetch aborted");
    this.name = "AbortError";
  }
}

export class NonRetryableFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NonRetryableFetchError";
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseContentRange(header: string | null): { start: number; total: number | null } | null {
  const match = header ? /^bytes\s+(\d+)-\d+\/(\d+|\*)$/i.exec(header.trim()) : null;
  if (!match) return null;
  return { start: Number(match[1]), total: match[2] === "*" ? null : Number(match[2]) };
}

function parseLength(header: string | null): number | null {
  if (!header) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new FetchAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function concat(chunks: Uint8Array[], length: number): ArrayBuffer {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

/**
 * Downloads a whole media file and, after a network drop, resumes from the last
 * received byte with `Range: bytes=<received>-` instead of starting over.
 * `If-Range` guarantees the server sends the full file again if it changed.
 */
export async function fetchWithRangeResume(
  url: string,
  options: RangeResumeOptions
): Promise<ArrayBuffer> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const { signal, maxBytes } = options;
  let chunks: Uint8Array[] = [];
  let received = 0;
  let total: number | null = null;
  let validator: string | null = null;
  let failures = 0;

  const restart = () => {
    chunks = [];
    received = 0;
  };

  for (;;) {
    if (signal.aborted) throw new FetchAbortedError();
    const headers: Record<string, string> = { ...options.headers };
    if (received > 0) {
      headers.Range = `bytes=${received}-`;
      if (validator) headers["If-Range"] = validator;
    }

    try {
      const response = await fetchImpl(url, { ...options.init, headers, signal });

      if (received > 0 && response.status === 206) {
        const range = parseContentRange(response.headers.get("Content-Range"));
        if (!range || range.start !== received) {
          throw new NonRetryableFetchError("Server returned an unexpected byte range");
        }
        total = range.total ?? total;
      } else if (received > 0 && response.status === 416 && total !== null && received >= total) {
        break;
      } else if (response.status === 200) {
        // Either the first request or the server ignored Range/If-Range: start over.
        restart();
        total = parseLength(response.headers.get("Content-Length"));
        validator = response.headers.get("ETag") ?? response.headers.get("Last-Modified");
      } else if (response.status === 206) {
        const range = parseContentRange(response.headers.get("Content-Range"));
        if (!range || range.start !== 0) {
          throw new NonRetryableFetchError("Server returned an unexpected byte range");
        }
        total = range.total;
        validator = response.headers.get("ETag") ?? response.headers.get("Last-Modified");
      } else if (RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(`Media request failed with status ${response.status}`);
      } else {
        throw new NonRetryableFetchError(
          `Media request failed with status ${response.status}`,
          response.status
        );
      }

      if (total !== null && total > maxBytes) {
        throw new NonRetryableFetchError("Track is too large to decode for gapless playback");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        chunks.push(bytes);
        received += bytes.byteLength;
      } else {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
          }
          if (received > maxBytes) {
            reader.cancel().catch(() => undefined);
            throw new NonRetryableFetchError("Track is too large to decode for gapless playback");
          }
        }
      }

      if (total !== null && received < total) {
        throw new Error("Media stream ended before the full file was received");
      }
      break;
    } catch (error) {
      if (signal.aborted) throw new FetchAbortedError();
      if (error instanceof NonRetryableFetchError) throw error;
      failures += 1;
      if (failures > options.maxRetries) throw error;
      await sleep(options.backoffMs(failures), signal);
    }
  }

  return concat(chunks, received);
}
