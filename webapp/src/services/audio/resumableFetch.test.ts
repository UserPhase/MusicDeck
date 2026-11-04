import { NonRetryableFetchError, fetchWithRangeResume } from "./resumableFetch";
import type { FetchLike } from "./resumableFetch";

type Init = { headers?: Record<string, string>; signal?: AbortSignal };

function response(
  status: number,
  headers: Record<string, string>,
  chunks: number[],
  { failAfterChunks = false }: { failAfterChunks?: boolean } = {}
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const queue = chunks.map((size) => new Uint8Array(size).fill(7));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: () => {
          const value = queue.shift();
          if (value) return Promise.resolve({ done: false, value });
          if (failAfterChunks) return Promise.reject(new TypeError("network error"));
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response;
}

function options(fetchImpl: FetchLike, overrides: Partial<Parameters<typeof fetchWithRangeResume>[1]> = {}) {
  return {
    fetchImpl,
    signal: new AbortController().signal,
    maxBytes: 10_000,
    maxRetries: 3,
    backoffMs: () => 0,
    ...overrides,
  };
}

describe("fetchWithRangeResume", () => {
  test("resumes a dropped download from the received byte offset", async () => {
    const calls: Init[] = [];
    const fetchImpl = jest.fn((_url: string, init?: RequestInit) => {
      calls.push(init as Init);
      return Promise.resolve(calls.length === 1
        ? response(200, { "Content-Length": "1000", ETag: '"v1"' }, [400], { failAfterChunks: true })
        : response(206, { "Content-Range": "bytes 400-999/1000" }, [600]));
    });

    const bytes = await fetchWithRangeResume("/stream/a", options(fetchImpl));

    expect(bytes.byteLength).toBe(1000);
    expect(calls[0].headers?.Range).toBeUndefined();
    expect(calls[1].headers).toEqual(expect.objectContaining({
      Range: "bytes=400-",
      "If-Range": '"v1"',
    }));
  });

  test("starts over when the server ignores the Range header", async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call += 1;
      return Promise.resolve(call === 1
        ? response(200, { "Content-Length": "500" }, [200], { failAfterChunks: true })
        : response(200, { "Content-Length": "500" }, [500]));
    });

    const bytes = await fetchWithRangeResume("/stream/a", options(fetchImpl));

    expect(bytes.byteLength).toBe(500);
  });

  test("rejects a mismatched byte range instead of corrupting the file", async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call += 1;
      return Promise.resolve(call === 1
        ? response(200, { "Content-Length": "1000" }, [400], { failAfterChunks: true })
        : response(206, { "Content-Range": "bytes 0-999/1000" }, [1000]));
    });

    await expect(fetchWithRangeResume("/stream/a", options(fetchImpl)))
      .rejects.toBeInstanceOf(NonRetryableFetchError);
  });

  test("does not retry client errors or oversized files", async () => {
    const notFound = jest.fn(() => Promise.resolve(response(404, {}, [])));
    await expect(fetchWithRangeResume("/x", options(notFound))).rejects.toBeInstanceOf(NonRetryableFetchError);
    expect(notFound).toHaveBeenCalledTimes(1);

    const huge = jest.fn(() => Promise.resolve(response(200, { "Content-Length": "99999" }, [])));
    await expect(fetchWithRangeResume("/x", options(huge))).rejects.toThrow(/too large/);
    expect(huge).toHaveBeenCalledTimes(1);
  });

  test("gives up after the retry budget is spent", async () => {
    const unavailable = jest.fn(() => Promise.resolve(response(503, {}, [])));
    await expect(fetchWithRangeResume("/x", options(unavailable, { maxRetries: 2 })))
      .rejects.toThrow(/503/);
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  test("stops immediately when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn(() => Promise.resolve(response(200, {}, [10])));
    await expect(fetchWithRangeResume("/x", options(fetchImpl, { signal: controller.signal })))
      .rejects.toThrow(/aborted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
