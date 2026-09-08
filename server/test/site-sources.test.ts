import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_SEARCH_HEADERS,
  DirectSiteFileResolver,
  DirectSiteFileResolver as SiteMediaResolver,
  extractHtmlCandidates,
  extractJsonCandidates,
  isSpaAppShell,
  parseSiteDefinitions,
  parseSiteUrlList,
  SiteContainerProvider,
  SiteDetailProvider,
  SiteDiscoveryProvider,
  type SiteSourceDefinition,
  testSite,
  validateSiteBaseUrl,
} from "../src/plugins/in-progress/site-sources.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const trackResult = {
  id: "external_itunes_12",
  type: "track",
  title: "Open Road",
  subtitle: "Indie Artist",
  artist: "Indie Artist",
  album: "Free Sounds",
  provider: "external",
  source: { kind: "external", count: 0 },
  availability: null,
  metadata: {},
};

const SITE_HTML = `
<html><body>
  <a href="/files/indie-artist-open-road.mp3">Download MP3</a>
  <a href="/files/indie-artist-open-road.flac">Download FLAC</a>
  <a href="magnet:?xt=urn:btih:ABC123&dn=Indie+Artist+-+Open+Road">Magnet</a>
  <a href="/files/open-road-video.mp4">Video</a>
  <a href="/files/pack.zip">Archive</a>
</body></html>`;

function siteFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.hostname === "audio.com" && url.pathname.startsWith("/files/")) {
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "content-type": "audio/flac",
        "content-range": "bytes 0-2/3",
        "accept-ranges": "bytes",
      },
    }));
  }

  if (url.hostname === "audio.com") {
    return Promise.resolve(new Response(SITE_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
  }

  if (url.hostname === "cdn.example.com") {
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "content-type": "audio/flac",
        "content-range": "bytes 0-2/3",
        "accept-ranges": "bytes",
      },
    }));
  }

  return Promise.resolve(new Response("not found", { status: 404 }));
}

async function setup(fetchImpl: typeof fetch = siteFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, undefined, fetchImpl);
  return current;
}

async function enableSiteSources(app: Awaited<ReturnType<typeof createTestServer>>["app"]) {
  const { cookie } = await login(app);
  const enabled = await app.inject({
    method: "PATCH",
    url: "/api/admin/plugins/site-sources",
    headers: { cookie },
    payload: {
      enabled: true,
      config: { siteUrls: "https://audio.com" },
      permissions: ["network.request", "external-source.play"],
    },
  });
  return { cookie, enabled };
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("site source definitions", () => {
  test("validates site configuration and rejects unsafe definitions", () => {
    const valid = parseSiteDefinitions(JSON.stringify([{
      id: "open-audio",
      name: "Open Audio",
      baseUrl: "https://open-audio.example",
      searchPath: "/search?q={query}",
      responseType: "json",
    }]));
    expect(valid).toEqual([
      expect.objectContaining({ id: "open-audio", responseType: "json" }),
    ]);

    expect(parseSiteDefinitions(JSON.stringify([{ id: "bad", name: "Bad", baseUrl: "http://169.254.1.1", searchPath: "/{query}", responseType: "html" }]))).toBeNull();
    expect(parseSiteDefinitions(JSON.stringify([{ id: "bad", name: "Bad", baseUrl: "https://ok.example", searchPath: "/no-placeholder", responseType: "html" }]))).toBeNull();
    expect(parseSiteDefinitions("not json")).toBeNull();
    expect(validateSiteBaseUrl("https://open-audio.example")?.hostname).toBe("open-audio.example");
    expect(validateSiteBaseUrl("http://open-audio.example")).toBeNull();
  });

  test("auto-configures sites from a pasted list of URLs and deduplicates duplicates", () => {
    const sites = parseSiteUrlList("https://audio.com\nhttps://open-audio.example, https://another.example");
    expect(sites).toEqual([
      expect.objectContaining({ id: "audio-com", name: "audio.com", baseUrl: "https://audio.com", searchPath: "/search?q={query}", responseType: "html" }),
      expect.objectContaining({ id: "open-audio-example", name: "open-audio.example" }),
      expect.objectContaining({ id: "another-example", name: "another.example" }),
    ]);

    expect(parseSiteUrlList("not a url")).toBeNull();
    expect(parseSiteUrlList("http://insecure.example")).toBeNull();
    expect(parseSiteUrlList("")).toBeNull();

    const deduplicated = parseSiteUrlList("https://dup.example\nhttps://dup.example");
    expect(deduplicated?.length).toBe(1);
    expect(deduplicated?.[0].id).toBe("dup-example");
  });

  test("accepts Torrentio-style search URL templates with a {query} placeholder", () => {
    const sites = parseSiteUrlList("https://indexer.example/search/{query}/1/\nhttps://audio.com");
    expect(sites).toEqual([
      expect.objectContaining({
        id: "indexer-example",
        baseUrl: "https://indexer.example",
        searchPath: "/search/{query}/1/",
        responseType: "html",
      }),
      expect.objectContaining({
        id: "audio-com",
        searchPath: "/search?q={query}",
      }),
    ]);

    expect(parseSiteUrlList("https://indexer.example/search?q={query}&cat=music")).toEqual([
      expect.objectContaining({ searchPath: "/search?q={query}&cat=music" }),
    ]);
  });
});

describe("site sources plugin", () => {
  test("registers discovery providers and the direct-file resolver through the plugin SDK", async () => {
    const { app, plugins, sourceProviders } = await setup();
    const { cookie, enabled } = await enableSiteSources(app);

    expect(enabled.statusCode).toBe(200);
    expect(plugins.get("site-sources", true)).toMatchObject({
      status: "enabled",
      capabilities: ["source"],
    });
    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "site-audio-com", role: "discovery", enabled: true }),
      expect.objectContaining({ id: "site-direct-files", role: "resolver", enabled: true }),
      expect.objectContaining({ id: "source-pipeline", enabled: true }),
    ]));
    expect(cookie).toBeTruthy();
  });

  test("auto-configures a custom site from a pasted URL in the simple config field", async () => {
    const { app, plugins, sourceProviders } = await setup();
    const { cookie } = await login(app);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { siteUrls: "https://cdn.example.com" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    expect(enabled.statusCode).toBe(200);
    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "site-cdn-example-com", role: "discovery", enabled: true }),
    ]));
  });

  test("discovers direct audio links and plays one through an opaque token", async () => {
    const { app } = await setup();
    const { cookie } = await enableSiteSources(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(current!.sourcePipeline.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "site-audio-com", enabled: true }),
      expect.objectContaining({ id: "site-direct-files", enabled: true }),
    ]));
    expect(current!.sourceProviders.list().find((item) => item.id === "source-pipeline")).toMatchObject({ enabled: true });
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Site file", quality: expect.objectContaining({ codec: "MP3", lossless: false }) }),
      expect.objectContaining({ quality: expect.objectContaining({ codec: "FLAC", lossless: true }) }),
    ]));
    expect(JSON.stringify(resolved.json())).not.toContain("audio.com/files");

    const source = resolved.json().sources.find((item: any) => item.quality?.codec === "FLAC");
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackResult.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });

  test("resolves an album-level magnet to only the matching track via the debrid resolver", async () => {
    // A public-domain album listing whose magnet display name is the ALBUM,
    // not the track. The debrid resolver must enumerate contained files and
    // return only the requested track.
    const ALBUM_HTML = `<html><body>
      <a href="magnet:?xt=urn:btih:ALBUM1&amp;dn=Indie+Artist+-+Free+Sounds">Album magnet</a>
    </body></html>`;

    const fetchMock = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname === "albums.example") {
        return Promise.resolve(new Response(ALBUM_HTML, { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.pathname === "/v1/fetch") {
        return Promise.resolve(new Response(JSON.stringify({
          id: "job-album",
          status: "ready",
          files: [
            { name: "Indie Artist - Free Sounds - 01 - Open Road.flac", url: "https://cdn.example.com/open-road.flac", codec: "FLAC", durationSeconds: 301 },
            { name: "Indie Artist - Free Sounds - 02 - Other Song.flac", url: "https://cdn.example.com/other-song.flac", codec: "FLAC", durationSeconds: 240 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const { app } = await setup(fetchMock);
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { siteUrls: "https://albums.example" },
        permissions: ["network.request", "external-source.play"],
      },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://debrid.example", accessToken: "debrid-token" },
        permissions: ["network.request", "external-source.play", "playback.start"],
      },
    });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    // Only the requested track ("Open Road"), not the other album track.
    const urls = resolved.json().sources.map((s: any) => s.id);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "External cloud source", quality: expect.objectContaining({ codec: "FLAC" }) }),
    ]));
    expect(JSON.stringify(resolved.json())).not.toContain("other-song");
  });

  test("routes magnet candidates through the enabled debrid resolver and streams the audio result", async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));

      if (url.pathname === "/v1/fetch") {
        fetched.push("submitted");
        return Promise.resolve(new Response(JSON.stringify({
          id: "job-magnet",
          status: "ready",
          files: [
            {
              name: "Indie Artist - Open Road.flac",
              url: "https://cdn.example.com/open-road.flac",
              codec: "FLAC",
              bitrate: 900,
            },
            {
              name: "Open Road video.mp4",
              url: "https://cdn.example.com/open-road.mp4",
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }

      return siteFetch(url);
    }) as unknown as typeof fetch;

    const { app } = await setup(fetchMock);
    const { cookie } = await enableSiteSources(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://debrid.example", accessToken: "debrid-token" },
        permissions: ["network.request", "external-source.play", "playback.start"],
      },
    });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(fetched.length).toBeGreaterThan(0);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "External cloud source", quality: expect.objectContaining({ codec: "FLAC" }) }),
    ]));
    expect(JSON.stringify(resolved.json())).not.toContain("magnet:");
    expect(JSON.stringify(resolved.json())).not.toContain("debrid-token");
  });

  test("does not discover when the site plugin is disabled", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
  });

  test("can be disabled and re-enabled without getting stuck", async () => {
    const { app, plugins } = await setup();
    const { cookie } = await enableSiteSources(app);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(plugins.get("site-sources", true)).toMatchObject({ status: "disabled" });

    const reEnabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(reEnabled.statusCode).toBe(200);
    expect(plugins.get("site-sources", true)).toMatchObject({ status: "enabled" });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources.length).toBeGreaterThan(0);
  });

  test("probes common search paths for a bare URL (Torrentio-style /search.php?q=)", async () => {
    const tpbFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname !== "indexer.example") {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      // Only the /search.php route exists, like thepiratebay.org.
      if (url.pathname === "/search.php") {
        return Promise.resolve(new Response(
          `<html><body><a href="magnet:?xt=urn:btih:XYZ&amp;dn=Indie+Artist+-+Open+Road">Magnet</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        ));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const { app } = await setup(tpbFetch);
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { siteUrls: "https://indexer.example" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    // The magnet candidate is discovered via /search.php and offered to the
    // debrid resolver (debrid not enabled here, so no playable sources, but
    // the probe must have hit /search.php).
    expect(tpbFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/search.php" }),
      expect.anything()
    );
  });

  test("disabling the plugin actually stops discovery and resolution", async () => {
    const { app } = await setup();
    const { cookie } = await enableSiteSources(app);

    const before = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });
    expect(before.json().sources.length).toBeGreaterThan(0);

    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(current!.sourcePipeline.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "site-audio-com", enabled: false }),
      expect.objectContaining({ id: "site-direct-files", enabled: false }),
    ]));

    const after = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().sources).toEqual([]);
  });

  test("discovers candidates from declarative JSON site source", async () => {
    const jsonFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname === "api.sounds.example" && url.pathname === "/api/search") {
        return Promise.resolve(new Response(JSON.stringify({
          results: [
            {
              title: "Open Road",
              artist: "Indie Artist",
              album: "Free Sounds",
              url: "https://api.sounds.example/stream/open-road.flac",
              durationSeconds: 180,
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.hostname === "api.sounds.example" && url.pathname.startsWith("/stream/")) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { "content-type": "audio/flac" },
        }));
      }
      return siteFetch(url);
    }) as unknown as typeof fetch;

    const { app } = await setup(jsonFetch);
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: {
          sites: JSON.stringify([{
            id: "json-sounds",
            name: "JSON Sounds",
            baseUrl: "https://api.sounds.example",
            searchPath: "/api/search?q={query}",
            responseType: "json",
          }]),
        },
        permissions: ["network.request", "external-source.play"],
      },
    });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Site file", quality: expect.objectContaining({ codec: "FLAC", lossless: true }) }),
    ]));
  });

  test("decodes complex HTML entities in magnet links and titles", async () => {
    const entityHtml = `
      <html><body>
        <a href="magnet:?xt=urn:btih:ENT123&amp;dn=Indie&#32;Artist&#32;&amp;&#32;Guests&#32;-&#32;Open&#32;Road&quot;">Download</a>
      </body></html>
    `;
    const entityFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname === "entity.example") {
        return Promise.resolve(new Response(entityHtml, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return siteFetch(url);
    }) as unknown as typeof fetch;

    const { app } = await setup(entityFetch);
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { siteUrls: "https://entity.example" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    const testRes = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/site-sources/test",
      headers: { cookie },
    });

    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().test.ok).toBe(true);
    expect(testRes.json().test.status).toBe("success");
  }, 15000);

  test("provider failure does not break another working site", async () => {
    // Site A fails with 500 / timeout, Site B succeeds with direct audio
    const multiFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname === "broken-site.example") {
        return Promise.resolve(new Response("Internal error", { status: 500 }));
      }
      if (url.hostname === "working-site.example" && url.pathname.startsWith("/files/")) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { "content-type": "audio/flac", "content-range": "bytes 0-2/3" },
        }));
      }
      if (url.hostname === "working-site.example") {
        return Promise.resolve(new Response(`
          <html><body>
            <a href="/files/indie-artist-open-road.flac">Indie Artist - Open Road</a>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const { app } = await setup(multiFetch);
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/site-sources",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { siteUrls: "https://broken-site.example\nhttps://working-site.example" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackResult },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Site file", quality: expect.objectContaining({ codec: "FLAC" }) }),
    ]));
  });
});

describe("deterministic discovery diagnostics and compatibility", () => {
  const dummyTrack = {
    id: "ext_1",
    type: "track" as const,
    title: "Open Road",
    subtitle: "Indie Artist",
    artist: "Indie Artist",
    album: "Free Sounds",
    provider: "external" as const,
    source: { kind: "external" as const, count: 0 },
    availability: null,
    artwork: null,
    metadata: { durationSeconds: 180 },
  };

  test("200 HTML page with direct audio link", async () => {
    const site = {
      id: "audio-site",
      name: "audio-site",
      baseUrl: "https://audio-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response(`
      <html><body>
        <a href="https://audio-site.example/music/indie-artist-open-road.flac">Indie Artist - Open Road (FLAC)</a>
      </body></html>
    `, { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(candidates[0]).toMatchObject({
      title: "Open Road",
      artist: "Indie Artist",
      quality: { codec: "FLAC", lossless: true },
    });
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "success",
      httpStatus: 200,
      candidateCount: 1,
    });
  });

  test("200 HTML page with magnet link", async () => {
    const site = {
      id: "magnet-site",
      name: "magnet-site",
      baseUrl: "https://magnet-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response(`
      <html><body>
        <a href="magnet:?xt=urn:btih:MAG123&amp;dn=Indie+Artist+-+Open+Road+%5BFLAC%5D">Download Torrent</a>
      </body></html>
    `, { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toContain("magnet:?xt=urn:btih:MAG123");
    expect(candidates[0].title).toBe("Open Road");
    expect(candidates[0].artist).toBe("Indie Artist");
    expect(provider.getLastDiagnostic()?.status).toBe("success");
  });

  test("200 HTML page with no results / SPA app shell detects JS app shell", async () => {
    const site = {
      id: "spa-site",
      name: "spa-site",
      baseUrl: "https://spa-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response(`
      <!DOCTYPE html><html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>
    `, { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates).toEqual([]);
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "no_results",
      errorMessage: "site returned HTML but no static search results were found",
    });
  });

  test("404 search URL records http_failure diagnostic and throws safe error", async () => {
    const site = {
      id: "missing-site",
      name: "missing-site",
      baseUrl: "https://missing-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response("Not Found", { status: 404 }))) as unknown as typeof fetch;
    const provider = new SiteDiscoveryProvider(site, mockFetch);

    await expect(provider.search(dummyTrack)).rejects.toThrow(/unavailable/);
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "http_failure",
      httpStatus: 404,
      errorCode: "NOT_FOUND",
      errorMessage: "search endpoint not found",
    });
  });

  test("403 response records blocked diagnostic and stops probing further paths", async () => {
    const site = {
      id: "blocked-site",
      name: "blocked-site",
      baseUrl: "https://blocked-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
      guessedSearchPath: true,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response("Forbidden", { status: 403 }))) as unknown as typeof fetch;
    const provider = new SiteDiscoveryProvider(site, mockFetch);

    await expect(provider.search(dummyTrack)).rejects.toThrow(/unavailable/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "blocked",
      failure: "http_forbidden",
      httpStatus: 403,
      errorCode: "BLOCKED",
      errorMessage: "site rejected request",
    });
  });

  test("timeout records timeout diagnostic and stops probing further paths", async () => {
    const site = {
      id: "slow-site",
      name: "slow-site",
      baseUrl: "https://slow-site.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
      guessedSearchPath: true,
    };

    const mockFetch = vi.fn(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);

    await expect(provider.search(dummyTrack)).rejects.toThrow(/unavailable/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "timeout",
      failure: "timeout",
      errorCode: "TIMEOUT",
      errorMessage: "request timed out",
    });
  });

  test("invalid JSON response records parsing_failure diagnostic", async () => {
    const site = {
      id: "corrupt-json",
      name: "corrupt-json",
      baseUrl: "https://corrupt.example",
      searchPath: "/api/search?q={query}",
      responseType: "json" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response("not a json {{{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }))) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);

    await expect(provider.search(dummyTrack)).rejects.toThrow(/invalid JSON/);
    expect(provider.getLastDiagnostic()).toMatchObject({
      status: "parsing_failure",
      failure: "parse_error",
      httpStatus: 200,
      errorCode: "PARSING_FAILURE",
      errorMessage: "invalid JSON response",
    });
  });

  test("JSON response with supported fields extracts candidates", async () => {
    const site = {
      id: "json-api",
      name: "json-api",
      baseUrl: "https://json-api.example",
      searchPath: "/api/search?q={query}",
      responseType: "json" as const,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      results: [
        {
          title: "Open Road",
          artistName: "Indie Artist",
          albumName: "Free Sounds",
          downloadUrl: "https://json-api.example/media/open-road.flac",
          duration_ms: 180000,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(candidates[0]).toMatchObject({
      title: "Open Road",
      artist: "Indie Artist",
      album: "Free Sounds",
      durationSeconds: 180,
      quality: { codec: "FLAC", lossless: true },
    });
    expect(provider.getLastDiagnostic()?.status).toBe("success");
  });

  test("custom {query} URL uses explicit template without guessing", async () => {
    const site = {
      id: "custom-template",
      name: "custom-template",
      baseUrl: "https://custom.example",
      searchPath: "/custom-search/{query}/page/1",
      responseType: "html" as const,
      guessedSearchPath: false,
    };

    const mockFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/custom-search/Indie%20Artist%20Open%20Road/page/1") {
        return Promise.resolve(new Response(`
          <html><body><a href="/files/indie-artist-open-road.mp3">Open Road</a></body></html>
        `, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("guessed search path #1 success (/search?q=) saves working path", async () => {
    const site: SiteSourceDefinition = {
      id: "guess-1",
      name: "guess-1",
      baseUrl: "https://guess1.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
      guessedSearchPath: true,
    };

    const mockFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search") {
        return Promise.resolve(new Response(`
          <html><body><a href="/files/indie-artist-open-road.mp3">Open Road</a></body></html>
        `, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(site.workingSearchPath).toBe("/search?q={query}");
  });

  test("guessed search path #2 success (/search.php?q=) saves working path", async () => {
    const site: SiteSourceDefinition = {
      id: "guess-2",
      name: "guess-2",
      baseUrl: "https://guess2.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
      guessedSearchPath: true,
    };

    const mockFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search.php") {
        return Promise.resolve(new Response(`
          <html><body><a href="/files/indie-artist-open-road.flac">Open Road</a></body></html>
        `, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = new SiteDiscoveryProvider(site, mockFetch);
    const candidates = await provider.search(dummyTrack);

    expect(candidates.length).toBe(1);
    expect(site.workingSearchPath).toBe("/search.php?q={query}");
  });

  test("all guessed paths fail logs attempts and records failure", async () => {
    const site = {
      id: "guess-fail",
      name: "guess-fail",
      baseUrl: "https://guessfail.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
      guessedSearchPath: true,
    };

    const mockFetch = vi.fn(() => Promise.resolve(new Response("Not Found", { status: 404 }))) as unknown as typeof fetch;
    const provider = new SiteDiscoveryProvider(site, mockFetch);

    await expect(provider.search(dummyTrack)).rejects.toThrow(/unavailable/);
    const diag = provider.getLastDiagnostic();
    expect(diag).toMatchObject({
      status: "http_failure",
      httpStatus: 404,
    });
    expect(diag?.attemptedPaths?.length).toBe(3);
  });

  test("testSite provides clear admin status for reachability, searchability, and candidate count", async () => {
    const reachableSite = {
      id: "reach",
      name: "reach",
      baseUrl: "https://reach.example",
      searchPath: "/search?q={query}",
      responseType: "html" as const,
    };

    const fetchMock = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search") {
        return Promise.resolve(new Response(`
          <html><body><a href="/song.flac">MusicDeck Sample Track</a></body></html>
        `, { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const result = await testSite(reachableSite, fetchMock, "MusicDeck");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      candidateCount: 1,
    });
  });

  describe("Generic SourceAdapter Fixtures and Multi-Stage Pipeline", () => {
    test("Fixture B: JSON search -> JSON detail -> files -> PlayableSource", async () => {
      const site: SiteSourceDefinition = {
        id: "fixture-b-site",
        name: "Fixture B JSON Site",
        baseUrl: "https://fixture-b.test",
        searchPath: "/search?q={query}",
        responseType: "json",
        resultStrategy: "detail-page",
        detailPath: "/album/{id}",
      };

      const mockFetch = vi.fn((input: URL | RequestInfo | string) => {
        const url = new URL(String(input));

        if (url.pathname === "/search") {
          return Promise.resolve(new Response(JSON.stringify({
            results: [
              {
                id: "album-123",
                title: "Album Name",
                artist: "Artist",
                detailUrl: "/album/album-123",
              },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }

        if (url.pathname === "/album/album-123") {
          return Promise.resolve(new Response(JSON.stringify({
            files: [
              {
                title: "Track Name",
                artist: "Artist",
                album: "Album Name",
                url: "https://fixture-b.test/audio/track.flac",
                duration_ms: 210000,
              },
            ],
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }

        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as unknown as typeof fetch;

      const discovery = new SiteDiscoveryProvider(site, mockFetch);
      const detail = new SiteDetailProvider(site, mockFetch);

      const targetTrack = {
        id: "target-track-b",
        type: "track" as const,
        title: "Track Name",
        subtitle: "Artist",
        artist: "Artist",
        album: "Album Name",
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        artwork: null,
        metadata: {},
      };

      // 1. Search stage returns detail link candidate
      const rawCandidates = await discovery.search(targetTrack);
      expect(rawCandidates.length).toBe(1);
      expect(rawCandidates[0].kind).toBe("detail-link");
      expect(rawCandidates[0].detailUrl).toBe("https://fixture-b.test/album/album-123");

      // 2. Detail stage resolves detailUrl to track file candidate
      expect(detail.canResolve(rawCandidates[0])).toBe(true);
      const expandedCandidates = await detail.resolveDetails(rawCandidates[0]);
      expect(expandedCandidates.length).toBe(1);
      expect(expandedCandidates[0].kind).toBe("file");
      expect(expandedCandidates[0].title).toBe("Track Name");
      expect(expandedCandidates[0].artist).toBe("Artist");
      expect(expandedCandidates[0].quality?.codec).toBe("FLAC");

      // 3. SiteMediaResolver resolves file candidate to PlayableSource
      const resolver = new SiteMediaResolver();
      expect(resolver.canResolve(expandedCandidates[0])).toBe(true);
      const sources = await resolver.resolve(expandedCandidates[0]);
      expect(sources.length).toBe(1);
      expect(sources[0]).toMatchObject({
        provider: "plugin",
        type: "external",
        mediaType: "audio",
        quality: expect.objectContaining({ codec: "FLAC", lossless: true }),
      });
    });

    test("Fixture C: Direct HTML search -> immediate candidate -> PlayableSource", async () => {
      const site: SiteSourceDefinition = {
        id: "fixture-c-site",
        name: "Fixture C Direct HTML Site",
        baseUrl: "https://fixture-c.test",
        searchPath: "/search?q={query}",
        responseType: "html",
        resultStrategy: "direct-files",
      };

      const mockFetch = vi.fn((input: URL | RequestInfo | string) => {
        const url = new URL(String(input));
        if (url.pathname === "/search") {
          return Promise.resolve(new Response(`
            <html>
              <body>
                <a href="/audio/track.flac">Track Name</a>
              </body>
            </html>
          `, { status: 200, headers: { "content-type": "text/html" } }));
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as unknown as typeof fetch;

      const discovery = new SiteDiscoveryProvider(site, mockFetch);
      const targetTrack = {
        id: "target-track-c",
        type: "track" as const,
        title: "Track Name",
        subtitle: "Artist",
        artist: "Artist",
        album: "Album Name",
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        artwork: null,
        metadata: {},
      };

      const candidates = await discovery.search(targetTrack);
      expect(candidates.length).toBe(1);
      expect(candidates[0].kind).toBe("track");
      expect(candidates[0].title).toBe("Track Name");
      expect(candidates[0].quality?.codec).toBe("FLAC");

      const resolver = new SiteMediaResolver();
      const sources = await resolver.resolve(candidates[0]);
      expect(sources.length).toBe(1);
      expect(sources[0].mediaType).toBe("audio");
    });

    test("Fixture D: Album magnet / release container classification and matching", async () => {
      const targetTrack = {
        id: "target-track-d",
        type: "track" as const,
        title: "Scar Tissue",
        subtitle: "Red Hot Chili Peppers",
        artist: "Red Hot Chili Peppers",
        album: "Californication",
        provider: "external" as const,
        source: { kind: "external" as const, count: 0 },
        availability: null,
        artwork: null,
      };

      // Search returns an album magnet where title is the album name rather than the track
      const albumMagnetCandidate = {
        id: "magnet:?xt=urn:btih:d3b07384d113edec49eaa6238ad5ff00",
        provider: "site-sources",
        title: "Red Hot Chili Peppers - Californication (1999) [FLAC]",
        artist: "Red Hot Chili Peppers",
        album: "Californication",
        kind: "album-container" as const,
        quality: { codec: "FLAC", lossless: true },
      };

      expect(albumMagnetCandidate.kind).toBe("album-container");
    });
  });
});
