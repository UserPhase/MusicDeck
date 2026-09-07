import { describe, expect, test } from "vitest";

import { DebridCloudSourceProvider, debridFileMatchesForTest } from "../src/plugins/first-party.js";
import type { MusicDeckPluginContext } from "../src/plugins/plugin-registry.js";
import type { UnifiedSearchResult } from "../src/domain/search.js";

const result: UnifiedSearchResult = {
  id: "external_itunes_42",
  type: "track",
  title: "Digital Love",
  subtitle: "Daft Punk",
  artist: "Daft Punk",
  album: "Discovery",
  artwork: null,
  provider: "external",
  source: { kind: "external", count: 0 },
  availability: null,
  metadata: { durationSeconds: 301 },
};

function context(config: Record<string, unknown>): MusicDeckPluginContext {
  return {
    settings: {
      get: <T,>(key: string) => config[key] as T | undefined,
    },
    events: { subscribe: () => undefined },
    logging: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

function fetchFor(job: unknown): typeof fetch {
  return (async (input: URL | RequestInfo | string) => {
    const url = new URL(String(input));

    if (url.pathname === "/v1/resolve") {
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const readyJob = {
  id: "job-1",
  status: "ready",
  files: [
    {
      name: "Daft Punk - Discovery - 04 - Digital Love.flac",
      url: "https://cdn.example.com/digital-love.flac",
      durationSeconds: 301,
      codec: "FLAC",
      bitrate: 950,
      sampleRate: 44100,
      bitDepth: 16,
      size: 28_000_000,
    },
    {
      name: "Daft Punk - Discovery - 04 - Digital Love.mp3",
      url: "https://cdn.example.com/digital-love.mp3",
      durationSeconds: 301,
      codec: "MP3",
      bitrate: 320,
      size: 8_000_000,
    },
  ],
};

describe("DebridCloudSourceProvider stage contract", () => {
  test("matches exact audio filenames conservatively", () => {
    expect(debridFileMatchesForTest(result, { name: "Digital Love.flac", durationSeconds: 301 })).toBe(true);
    expect(debridFileMatchesForTest(result, readyJob.files[0])).toBe(true);
    expect(debridFileMatchesForTest(result, readyJob.files[1])).toBe(true);
    expect(debridFileMatchesForTest(result, { name: "Digital Love (Live).flac" })).toBe(false);
  });

  test("normalizes an immediate ready job into playable sources", async () => {
    const provider = new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchFor(readyJob)
    );

    const sources = await provider.getSources(result);

    expect(sources).toHaveLength(2);
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "external", provider: "plugin", quality: expect.objectContaining({ codec: "FLAC", lossless: true }) }),
      expect.objectContaining({ quality: expect.objectContaining({ codec: "MP3", bitrate: 320, lossless: false }) }),
    ]));
  });

  test("returns no sources when the ready job has no matching files", async () => {
    const provider = new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchFor({ ...readyJob, files: [{ name: "Digital Love (Live).flac", url: "https://cdn.example.com/live.flac" }] })
    );

    await expect(provider.getSources(result)).resolves.toEqual([]);
  });

  test("polls a pending job with backoff until it becomes ready", async () => {
    let pollCount = 0;
    const fetchImpl = (async (input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/resolve") {
        return new Response(JSON.stringify({ id: "job-1", status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/resolve/job-1") {
        pollCount += 1;
        const status = pollCount >= 2 ? "ready" : "pending";
        return new Response(JSON.stringify({ ...readyJob, status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const provider = new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchImpl,
      () => 0
    );

    const sources = await provider.getSources(result);
    expect(pollCount).toBe(2);
    expect(sources).toHaveLength(2);
  });

  test("stops polling a job that never becomes ready without hanging", async () => {
    const fetchImpl = (async (input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/resolve") {
        return new Response(JSON.stringify({ id: "job-1", status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "job-1", status: "pending" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchImpl,
      () => 0
    );

    await expect(provider.getSources(result)).resolves.toEqual([]);
  });

  test("requires an explicit base URL instead of defaulting to a placeholder", async () => {
    const provider = new DebridCloudSourceProvider(
      context({ accessToken: "token" }),
      fetchFor(readyJob)
    );

    await expect(provider.getSources(result)).rejects.toThrow("External source is unavailable");
  });

  test("returns no sources for malformed or failed provider jobs", async () => {
    await expect(new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchFor({ id: "job-1", status: "failed" })
    ).getSources(result)).resolves.toEqual([]);

    await expect(new DebridCloudSourceProvider(
      context({ baseUrl: "https://debrid.example", accessToken: "token" }),
      fetchFor({ id: "job-1", status: "ready", files: [] })
    ).getSources(result)).resolves.toEqual([]);
  });
});

describe("Real-Debrid adapter", () => {
  const RD = "https://api.real-debrid.com/rest/1.0";
  const magnetCandidate = { id: "thepiratebay-org:magnet:?xt=urn:btih:ABC123&dn=Daft+Punk+-+Digital+Love" };

  function realDebridFetch(state: { torrentStatus?: string } = {}) {
    const status = state.torrentStatus ?? "downloaded";
    return (async (input: URL | RequestInfo | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;

      if (path === "/rest/1.0/user") {
        return new Response(JSON.stringify({ id: 1, username: "user" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/addMagnet") {
        expect(String(init?.body)).toContain("magnet");
        return new Response(JSON.stringify({ id: "T1" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/info/T1") {
        return new Response(JSON.stringify({
          id: "T1",
          status,
          files: [
            { id: 1, path: "/Daft Punk - Digital Love.flac", bytes: 28_000_000, selected: 0 },
            { id: 2, path: "/Digital Love video.mp4", bytes: 50_000_000, selected: 0 },
          ],
          links: ["https://real-debrid.com/d/lnk1", "https://real-debrid.com/d/lnk2"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/selectFiles/T1") {
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/1.0/unrestrict/link") {
        const link = new URLSearchParams(String(init?.body)).get("link");
        return new Response(JSON.stringify({ download: `https://cdn.real-debrid.example/${link?.split("/").pop()}.flac` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  function rdProvider(fetchImpl: typeof fetch) {
    return new DebridCloudSourceProvider(
      context({ baseUrl: RD, accessToken: "rd-token" }),
      fetchImpl,
      () => 0
    );
  }

  test("uses the Real-Debrid API for test() when base URL is Real-Debrid", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: any, init?: any) => {
      calls.push(new URL(String(input)).pathname);
      return realDebridFetch()(input, init);
    }) as typeof fetch;

    const outcome = await rdProvider(fetchImpl).test();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/Real-Debrid/);
    expect(calls).toEqual(["/rest/1.0/user"]);
  });

  test("maps Real-Debrid auth failures to authentication_failed", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "bad_token" }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(rdProvider(fetchImpl).test()).rejects.toThrow(/authentication failed/i);
  });

  test("resolves a magnet candidate through addMagnet/selectFiles/unrestrict into audio sources", async () => {
    const provider = rdProvider(realDebridFetch());
    const sources = await (provider as any).resolveCandidate(magnetCandidate);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      type: "external",
      provider: "plugin",
      mediaType: "audio",
      label: "External cloud source",
      quality: expect.objectContaining({ codec: "FLAC", lossless: true }),
    });
    expect(sources[0].id).toMatch(/^https:\/\/cdn\.real-debrid\.example\//);
    expect(JSON.stringify(sources)).not.toContain("rd-token");
  });

  test("returns no sources when the torrent has no audio files", async () => {
    const fetchImpl = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/1.0/torrents/info/T1") {
        return new Response(JSON.stringify({
          id: "T1",
          status: "downloaded",
          files: [{ id: 9, path: "/movie.mp4", bytes: 1, selected: 0 }],
          links: ["https://real-debrid.com/d/lnk9"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realDebridFetch()(input, init);
    }) as typeof fetch;

    const sources = await (rdProvider(fetchImpl) as any).resolveCandidate(magnetCandidate);
    expect(sources).toEqual([]);
  });

  test("returns no sources when the torrent is never cached", async () => {
    const sources = await (rdProvider(realDebridFetch({ torrentStatus: "downloading" })) as any).resolveCandidate(magnetCandidate);
    expect(sources).toEqual([]);
  });

  test("unrestricts a direct hoster https link without addMagnet", async () => {
    const provider = rdProvider(realDebridFetch());
    const sources = await (provider as any).resolveCandidate({ id: "site:https://hoster.example/file.flac" });
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toMatch(/^https:\/\/cdn\.real-debrid\.example\//);
  });

  test("explicitly maps selected audio files to sequential provider links", async () => {
    const fetchImpl = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === "/rest/1.0/torrents/addMagnet") {
        return new Response(JSON.stringify({ id: "T2" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/info/T2") {
        return new Response(JSON.stringify({
          id: "T2",
          status: "downloaded",
          files: [
            { id: 1, path: "/cover.jpg", bytes: 500_000, selected: 0 },
            { id: 2, path: "/01 - Digital Love.flac", bytes: 30_000_000, selected: 1 },
            { id: 3, path: "/02 - Harder Better.flac", bytes: 35_000_000, selected: 1 },
            { id: 4, path: "/sample.mp4", bytes: 50_000_000, selected: 0 },
          ],
          links: ["https://real-debrid.com/d/track1", "https://real-debrid.com/d/track2"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/selectFiles/T2") {
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/1.0/unrestrict/link") {
        const link = new URLSearchParams(String(init?.body)).get("link");
        return new Response(JSON.stringify({
          download: `https://cdn.real-debrid.example/${link?.includes("track1") ? "digital-love" : "other"}.flac`,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realDebridFetch()(input, init);
    }) as typeof fetch;

    const provider = rdProvider(fetchImpl);
    const sources = await (provider as any).resolveCandidate(
      { id: "test:magnet:?xt=urn:btih:ABC2&dn=Daft+Punk+-+Discovery" },
      { target: result }
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toContain("digital-love.flac");
  });

  test("Real-Debrid getSources returns empty array without calling resolveTrack", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const provider = rdProvider(fetchImpl);
    const sources = await provider.getSources(result);
    expect(sources).toEqual([]);
    expect(called).toBe(false);
  });

  test("rejects candidate when target track version does not match files", async () => {
    const fetchImpl = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === "/rest/1.0/torrents/addMagnet") {
        return new Response(JSON.stringify({ id: "T3" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/info/T3") {
        return new Response(JSON.stringify({
          id: "T3",
          status: "downloaded",
          files: [
            { id: 1, path: "/01 - Digital Love (Live in Paris).flac", bytes: 30_000_000, selected: 1 },
          ],
          links: ["https://real-debrid.com/d/trackLive"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/rest/1.0/torrents/selectFiles/T3") {
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/1.0/unrestrict/link") {
        return new Response(JSON.stringify({
          download: "https://cdn.real-debrid.example/digital-love-live.flac",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realDebridFetch()(input, init);
    }) as typeof fetch;

    const provider = rdProvider(fetchImpl);
    const sources = await (provider as any).resolveCandidate(
      { id: "test:magnet:?xt=urn:btih:ABC3&dn=Daft+Punk+-+Digital+Love+Live" },
      { target: result } // Target is studio "Digital Love", not live version
    );

    expect(sources).toEqual([]);
  });
});

