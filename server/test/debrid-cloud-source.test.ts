import { afterEach, describe, expect, test } from "vitest";

import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const result = {
  id: "external_itunes_42",
  type: "track",
  title: "Digital Love",
  subtitle: "Daft Punk",
  artist: "Daft Punk",
  album: "Discovery",
  provider: "external",
  source: { kind: "external", count: 0 },
  availability: null,
  metadata: { durationSeconds: 301 },
};

function debridFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.pathname === "/v1/account") {
    return Promise.resolve(new Response("{}", { status: 200 }));
  }

  if (url.pathname === "/v1/resolve" && url.hostname === "debrid.example") {
    return Promise.resolve(new Response(JSON.stringify({
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
        { name: "Digital Love video.mp4", url: "https://cdn.example.com/video.mp4" },
        { name: "Daft Punk - Discovery - 04 - Digital Love (Live).flac", url: "https://cdn.example.com/live.flac", durationSeconds: 410 },
        { name: "archive.zip", url: "https://cdn.example.com/archive.zip" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
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

async function setup(fetchImpl: typeof fetch = debridFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, undefined, fetchImpl);
  return current;
}

async function enable(app: Awaited<ReturnType<typeof createTestServer>>["app"]) {
  const { cookie } = await login(app);
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
  return cookie;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("debrid test endpoint never returns a bare 500", () => {
  test("Real-Debrid baseUrl with a failing network returns a normalized status, not 500", async () => {
    // Network throws (realistic when Real-Debrid is unreachable from the host).
    const failingFetch = (async () => { throw new Error("getaddrinfo ENOTFOUND api.real-debrid.com"); }) as unknown as typeof fetch;
    current = await createTestServer(undefined, {}, undefined, undefined, failingFetch);
    const { cookie } = await login(current.app);
    await current.app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://api.real-debrid.com/rest/1.0", accessToken: "rd-token" },
        permissions: ["network.request", "external-source.play", "playback.start"],
      },
    });

    const tested = await current.app.inject({
      method: "POST",
      url: "/api/admin/plugins/debrid-cloud-source/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBeLessThan(500);
    expect(tested.json().test?.ok).toBe(false);
    expect(["provider_unavailable", "plugin_error", "timeout", "authentication_failed"]).toContain(tested.json().test?.status);
  });

  test("Real-Debrid 401/403 maps to authentication_failed, not 500", async () => {
    const authFailFetch = (async () => new Response(JSON.stringify({ error: "bad_token" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    current = await createTestServer(undefined, {}, undefined, undefined, authFailFetch);
    const { cookie } = await login(current.app);
    await current.app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://api.real-debrid.com/rest/1.0", accessToken: "rd-token" },
        permissions: ["network.request", "external-source.play", "playback.start"],
      },
    });

    const tested = await current.app.inject({
      method: "POST",
      url: "/api/admin/plugins/debrid-cloud-source/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBeLessThan(500);
    expect(tested.json().test?.status).toBe("authentication_failed");
  });

  test("missing network.request permission yields permission_denied, never a 500 crash", async () => {
    current = await createTestServer(undefined, {}, undefined, undefined, debridFetch as typeof fetch);
    const { cookie } = await login(current.app);
    // Configure but approve NO network.request permission.
    await current.app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://api.real-debrid.com/rest/1.0", accessToken: "rd-token" },
        permissions: ["external-source.play", "playback.start"],
      },
    });

    const tested = await current.app.inject({
      method: "POST",
      url: "/api/admin/plugins/debrid-cloud-source/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBeLessThan(500);
    expect(tested.json().test?.ok).toBe(false);
    expect(tested.json().test?.status).toBe("permission_denied");
  });
});

describe("debrid-style source plugin", () => {
  test("registers through the plugin SDK and enables its source provider", async () => {
    const { app, plugins, sourceProviders } = await setup();
    const cookie = await enable(app);

    expect(plugins.get("debrid-cloud-source", true)).toMatchObject({
      status: "enabled",
      capabilities: ["source"],
      approvedPermissions: ["network.request", "external-source.play", "playback.start"],
    });
    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "debrid-cloud", enabled: true }),
    ]));
    expect(sourceProviders.list().find((provider) => provider.id === "debrid-cloud")).toMatchObject({ enabled: true });
    // The plugin registers as both a direct SourceProvider and a pipeline
    // resolver under the same id; the admin-facing list must not duplicate it
    // (duplicate React keys/rows in the Admin UI otherwise).
    expect(sourceProviders.list().filter((provider) => provider.id === "debrid-cloud")).toHaveLength(1);
    expect(cookie).toBeTruthy();
  });

  test("resolves ready sources after provider processing without leaking URLs", async () => {
    const { app } = await setup();
    const cookie = await enable(app);

    const direct = await current!.sourceProviders.resolve(result as any, { allowExternal: true });
    expect(direct).toMatchObject({ degraded: false });
    expect(direct.sources).toHaveLength(2);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toHaveLength(2);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "External cloud source", quality: expect.objectContaining({ codec: "FLAC", lossless: true }) }),
      expect.objectContaining({ quality: expect.objectContaining({ codec: "MP3", bitrate: 320, lossless: false }) }),
    ]));
    expect(JSON.stringify(resolved.json())).not.toContain("cdn.example.com");
    expect(JSON.stringify(resolved.json())).not.toContain("debrid-token");
  });

  test("streams a selected source through the existing opaque token and playback proxy", async () => {
    const { app } = await setup();
    const cookie = await enable(app);
    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });
    const source = resolved.json().sources[0];

    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${result.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });

  test("rejects ambiguous/wrong recordings and non-audio files", async () => {
    const wrongFetch = ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/resolve" || url.pathname === "/v1/resolve/job-1") {
        return Promise.resolve(new Response(JSON.stringify({
          id: "job-1",
          status: "ready",
          files: [
            { name: "Digital Love (Live).flac", url: "https://cdn.example.com/live.flac" },
            { name: "Digital Love.mp4", url: "https://cdn.example.com/video.mp4" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return debridFetch(url);
    }) as typeof fetch;
    const { app } = await setup(wrongFetch);
    const cookie = await enable(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
  });

  test("does not resolve when plugin permissions are not approved", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://debrid.example", accessToken: "debrid-token" },
        permissions: [],
      },
    });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
  });

  test("tests connection and redacts secrets from admin responses", async () => {
    const { app } = await setup();
    const cookie = await enable(app);

    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/debrid-cloud-source/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json().test).toMatchObject({ ok: true, message: "External cloud source is reachable" });
    expect(JSON.stringify(tested.json())).not.toContain("debrid-token");
  });

  test("can be disabled and re-enabled without duplicate registration errors", async () => {
    const { app, plugins, sourceProviders } = await setup();
    const cookie = await enable(app);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(plugins.get("debrid-cloud-source", true)).toMatchObject({ status: "disabled" });
    expect(sourceProviders.list().find((provider) => provider.id === "debrid-cloud")).toMatchObject({ enabled: false });

    const off = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });
    expect(off.json().sources).toEqual([]);

    const reEnabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/debrid-cloud-source",
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(reEnabled.statusCode).toBe(200);
    expect(plugins.get("debrid-cloud-source", true)).toMatchObject({ status: "enabled" });

    const on = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result },
    });
    expect(on.json().sources).toHaveLength(2);
  });
});
