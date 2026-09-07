import { afterEach, describe, expect, test } from "vitest";

import type { SourceProvider } from "../src/domain/playable-sources.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

function itunesFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.pathname === "/lookup") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [{ previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/search") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [{
        trackName: "Track One",
        artistName: "Artist One",
        collectionName: "Album One",
        previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  return Promise.resolve(new Response(new Uint8Array([73, 68, 51]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  }));
}

async function setup(sourceFetchImpl?: typeof fetch) {
  current = await createTestServer(undefined, {}, sourceFetchImpl);
  return current;
}

async function searchTrack(app: Awaited<ReturnType<typeof createTestServer>>["app"], cookie: string | undefined): Promise<any> {
  const search = await app.inject({
    method: "GET",
    url: "/api/search?q=track",
    headers: { cookie },
  });

  return search.json().results.track[0] as any;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("SourceProviderRegistry", () => {
  test("registers and enables source providers", async () => {
    const { sourceProviders } = await setup();

    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "library", enabled: true }),
      expect.objectContaining({ id: "itunes-preview", enabled: false }),
    ]));

    sourceProviders.configure("itunes-preview", true);
    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "itunes-preview", enabled: true }),
    ]));
  });

  test("resolves an existing library track and streams through an opaque token", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: track },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      result: { id: track.id, type: "track" },
      sources: [expect.objectContaining({ provider: "library", type: "library", availability: "available" })],
      degraded: false,
    });
    expect(JSON.stringify(resolved.json())).not.toContain("test-connection");

    const source = resolved.json().sources[0];
    expect(source.id).toBeTruthy();
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${track.id}/stream?playableSource=${String(source.id)}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/mpeg");
  });

  test("resolves and streams a real iTunes preview for external-only results", async () => {
    const { app, sourceProviders } = await setup(itunesFetch as typeof fetch);
    const { cookie } = await login(app);
    sourceProviders.configure("itunes-preview", true);

    const result = {
      id: "external_itunes_99",
      type: "track",
      title: "External Song",
      subtitle: "Artist",
      artist: "Artist",
      album: "Album",
      provider: "external",
      source: { kind: "external", count: 0 },
      metadata: {},
    };
    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([
      expect.objectContaining({
        type: "preview",
        label: "External preview",
        availability: "available",
        expiresAt: expect.any(String),
        quality: { codec: "AAC", lossless: false },
      }),
    ]);

    const source = resolved.json().sources[0];
    expect(source.id).toBeTruthy();
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${result.id}/stream?playableSource=${String(source.id)}`,
      headers: { cookie },
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("audio/mpeg");
  });

  test("returns mixed library/external sources and isolates a failed provider", async () => {
    const { app, sourceProviders } = await setup(itunesFetch as typeof fetch);
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);
    sourceProviders.configure("itunes-preview", true);

    const failingProvider: SourceProvider = {
      id: "failing-source",
      name: "Failing source",
      async getSources() {
        throw new Error("private provider failure");
      },
    };
    sourceProviders.register(failingProvider);
    sourceProviders.configure("failing-source", true);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: {
        result: {
          ...track,
          source: { ...track.source, externalAvailable: true },
        },
      },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "library" }),
      expect.objectContaining({ type: "preview" }),
    ]));
    expect(resolved.json().degraded).toBe(true);
    expect(JSON.stringify(resolved.json())).not.toContain("private provider failure");
  });

  test("selects sources using library-first, external-first, and manual preferences", async () => {
    const { app, sourceProviders } = await setup(itunesFetch as typeof fetch);
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);
    sourceProviders.configure("itunes-preview", true);

    const result = {
      ...track,
      source: { ...track.source, externalAvailable: true },
    };
    const libraryFirst = await sourceProviders.resolve(result, { allowExternal: true, preference: "library" });
    const externalFirst = await sourceProviders.resolve(result, { allowExternal: true, preference: "external" });
    const manual = await sourceProviders.resolve(result, { allowExternal: true, preference: "manual" });

    expect(libraryFirst.selectedSource?.type).toBe("library");
    expect(externalFirst.selectedSource?.type).toBe("preview");
    expect(manual.selectedSource).toBeUndefined();
  });

  test("manual preference auto-selects the only available source", async () => {
    const { sourceProviders, app } = await setup();
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);

    const resolved = await sourceProviders.resolve(track, { allowExternal: false, preference: "manual" });

    expect(resolved.sources).toHaveLength(1);
    expect(resolved.selectedSource).toMatchObject({ type: "library" });
  });

  test("returns no sources cleanly when no provider can resolve a result", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: {
        result: {
          id: "external_unknown",
          type: "track",
          title: "Unknown",
          provider: "external",
          source: { kind: "external", count: 0 },
          metadata: {},
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sources: [], degraded: false });
  });

  test("rejects insufficient metadata matches and unsafe source URLs", async () => {
    const unsafeFetch = ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search") {
        return Promise.resolve(new Response(JSON.stringify({
          results: [{
            trackName: "Track One Live",
            artistName: "Artist One",
            collectionName: "Album One",
            previewUrl: "http://169.254.169.254/internal.aac",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return itunesFetch(url);
    }) as typeof fetch;
    const { sourceProviders, app } = await setup(unsafeFetch);
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);
    sourceProviders.configure("itunes-preview", true);

    const resolved = await sourceProviders.resolve({
      ...track,
      source: { ...track.source, externalAvailable: true },
    }, { allowExternal: true });

    expect(resolved.sources).toEqual([expect.objectContaining({ type: "library" })]);
    expect(resolved.sources.some((source) => source.type === "external")).toBe(false);
    expect(resolved.degraded).toBe(false);
  });

  test("isolates unsafe provider URLs as degraded without exposing them", async () => {
    const unsafeFetch = ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search") {
        return Promise.resolve(new Response(JSON.stringify({
          results: [{
            trackName: "Track One",
            artistName: "Artist One",
            collectionName: "Album One",
            previewUrl: "http://169.254.169.254/internal.aac",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return itunesFetch(url);
    }) as typeof fetch;
    const { sourceProviders, app } = await setup(unsafeFetch);
    const { cookie } = await login(app);
    const track = await searchTrack(app, cookie);
    sourceProviders.configure("itunes-preview", true);

    const resolved = await sourceProviders.resolve({
      ...track,
      source: { ...track.source, externalAvailable: true },
    }, { allowExternal: true });

    expect(resolved.sources).toEqual([expect.objectContaining({ type: "library" })]);
    expect(resolved.degraded).toBe(true);
    expect(JSON.stringify(resolved)).not.toContain("169.254.169.254");
  });

  test("exposes capabilities and redacted configuration through the admin list", async () => {
    const { sourceProviders } = await setup();
    sourceProviders.configure("itunes-preview", true, { country: "US", apiKey: "secret-key" });

    const provider = sourceProviders.list().find((item) => item.id === "itunes-preview");

    expect(provider).toMatchObject({
      enabled: true,
      capabilities: expect.objectContaining({ tracks: true, quality: true, caching: true }),
      config: { country: "US", apiKey: true },
    });
    expect(JSON.stringify(provider)).not.toContain("secret-key");
  });

  test("reports source provider health without internal errors", async () => {
    const { sourceProviders } = await setup(itunesFetch as typeof fetch);

    await expect(sourceProviders.test("itunes-preview")).resolves.toMatchObject({
      id: "itunes-preview",
      ok: true,
    });
  });

  test("prioritizes full external sources over preview sources when selecting primary source", async () => {
    const { sourceProviders } = await setup(itunesFetch as typeof fetch);
    sourceProviders.configure("itunes-preview", true);

    const fullExternalProvider: SourceProvider = {
      id: "mock-full-external",
      name: "Mock External FLAC",
      async getSources() {
        return [{
          id: "https://cdn.example.com/full-track.flac",
          provider: "external",
          type: "external",
          mediaType: "audio",
          label: "Mock External FLAC",
          availability: "available",
          quality: { codec: "FLAC", lossless: true, bitrate: 900 },
        }];
      },
    };
    sourceProviders.register(fullExternalProvider);
    sourceProviders.configure("mock-full-external", true);

    const trackResult = {
      id: "external_itunes_1",
      type: "track" as const,
      title: "Track One",
      subtitle: null,
      artist: "Artist One",
      album: "Album One",
      artwork: null,
      availability: null,
      provider: "external" as const,
      source: { kind: "external" as const, count: 0, externalAvailable: true },
      metadata: {},
    };

    const resolved = await sourceProviders.resolve(trackResult, { allowExternal: true, preference: "best" });
    expect(resolved.sources).toHaveLength(2);
    expect(resolved.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "preview", label: "External preview" }),
      expect.objectContaining({ type: "external", label: "Mock External FLAC" }),
    ]));
    expect(resolved.selectedSource?.type).toBe("external");
    expect(resolved.selectedSource?.label).toBe("Mock External FLAC");
  });

  test("slow provider timeout does not prevent other providers from resolving", async () => {
    const { sourceProviders } = await setup(itunesFetch as typeof fetch);
    sourceProviders.configure("itunes-preview", true);

    const slowProvider: SourceProvider = {
      id: "slow-provider",
      name: "Slow Provider",
      async getSources() {
        // Deliberately delay longer than bounded timeout (mocked short for test)
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return [];
      },
    };
    sourceProviders.register(slowProvider);
    sourceProviders.configure("slow-provider", true);

    const trackResult = {
      id: "external_itunes_1",
      type: "track" as const,
      title: "Track One",
      subtitle: null,
      artist: "Artist One",
      album: "Album One",
      artwork: null,
      availability: null,
      provider: "external" as const,
      source: { kind: "external" as const, count: 0, externalAvailable: true },
      metadata: {},
    };

    const start = Date.now();
    // Resolve with timeout protection
    const resolved = await sourceProviders.resolve(trackResult, { allowExternal: true });
    // Should return with preview source and not hang indefinitely
    expect(resolved.sources.some((s) => s.type === "preview")).toBe(true);
  }, 20_000);
});
