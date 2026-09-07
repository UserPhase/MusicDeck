import { afterEach, describe, expect, test, vi } from "vitest";

import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const externalResult = {
  id: "external_itunes_99",
  type: "track",
  title: "External Song",
  subtitle: "External Artist",
  artist: "External Artist",
  album: "External Album",
  provider: "external",
  source: { kind: "external", count: 0 },
  availability: null,
  metadata: {},
};

function sourceFetch(input: URL | string, init?: RequestInit) {
  const url = new URL(String(input));

  if (url.pathname === "/v1/health") {
    return Promise.resolve(new Response("{}", { status: 200 }));
  }

  if (url.pathname === "/v1/sources") {
    return Promise.resolve(new Response(JSON.stringify({
      sources: [
        {
          url: "https://media.example.com/external-song.flac",
          title: "External Song",
          artist: "External Artist",
          album: "External Album",
          codec: "FLAC",
          bitrate: 900,
          sampleRate: 48000,
          bitDepth: 24,
          durationSeconds: 180,
          fileSize: 25_000_000,
          lossless: true,
        },
        {
          url: "https://media.example.com/external-song.mp3",
          title: "External Song",
          artist: "External Artist",
          album: "External Album",
          codec: "MP3",
          bitrate: 320,
          lossless: false,
        },
        {
          url: "https://media.example.com/live.mp3",
          title: "External Song (Live)",
          artist: "External Artist",
          album: "External Album",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.hostname === "media.example.com") {
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

async function setup(fetchImpl: typeof fetch = sourceFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, undefined, fetchImpl);
  return current;
}

async function enablePlugin(app: Awaited<ReturnType<typeof createTestServer>>["app"], playbackEnabled = true) {
  const { cookie } = await login(app);
  await app.inject({
    method: "PATCH",
    url: "/api/admin/plugins/authorized-external-source",
    headers: { cookie },
    payload: {
      enabled: true,
      config: { baseUrl: "https://provider.example", accessToken: "provider-token" },
      permissions: ["network.request", "external-source.play"],
    },
  });

  if (!playbackEnabled) {
    await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie },
      payload: { externalPlaybackEnabled: false },
    });
  }

  return cookie;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("authorized external source plugin", () => {
  test("requires configuration and redacts credentials", async () => {
    const { app, plugins } = await setup();
    const { cookie } = await login(app);

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/authorized-external-source",
      headers: { cookie },
      payload: { enabled: true, permissions: ["network.request", "external-source.play"] },
    });

    expect(missing.statusCode).toBe(400);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/authorized-external-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://provider.example", accessToken: "secret-token" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    expect(enabled.statusCode).toBe(200);
    expect(JSON.stringify(enabled.json())).not.toContain("secret-token");
    expect(plugins.get("authorized-external-source", true).config).toMatchObject({
      baseUrl: "https://provider.example",
      accessToken: true,
    });
  });

  test("resolves multiple normalized sources without exposing provider URLs", async () => {
    const { app, sourceProviders } = await setup();
    const cookie = await enablePlugin(app);

    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "authorized-http-source", enabled: true }),
    ]));

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: externalResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "plugin", type: "external", label: "External source", quality: expect.objectContaining({ codec: "FLAC", bitDepth: 24 }) }),
      expect.objectContaining({ provider: "plugin", type: "external", quality: expect.objectContaining({ codec: "MP3", lossless: false }) }),
    ]));
    expect(JSON.stringify(resolved.json())).not.toContain("media.example.com");
    expect(JSON.stringify(resolved.json())).not.toContain("provider-token");
  });

  test("streams an external-only track through the opaque playback token", async () => {
    const { app } = await setup();
    const cookie = await enablePlugin(app);
    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: externalResult },
    });
    const source = resolved.json().sources[0];

    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${externalResult.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });

  test("rejects wrong recordings and unsafe source URLs conservatively", async () => {
    const unsafeFetch = ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sources") {
        return Promise.resolve(new Response(JSON.stringify({
          sources: [
            { url: "http://169.254.169.254/internal.mp3", title: "External Song", artist: "External Artist", album: "External Album" },
            { url: "https://media.example.com/live.mp3", title: "External Song (Live)", artist: "External Artist", album: "External Album" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return sourceFetch(url);
    }) as typeof fetch;
    const { app } = await setup(unsafeFetch);
    const cookie = await enablePlugin(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: externalResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
    expect(JSON.stringify(resolved.json())).not.toContain("169.254.169.254");
  });

  test("does not resolve when the plugin is disabled", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: externalResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
  });

  test("does not resolve external sources for users without external playback permission", async () => {
    const { app, db } = await setup();
    const { cookie, response } = await login(app);
    void response;
    db.prepare("UPDATE users SET role = 'user', external_playback_enabled = 0 WHERE username = 'admin'").run();

    await enablePlugin(app);
    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: externalResult },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([]);
  });

  test("provider health test succeeds without exposing configuration", async () => {
    const { app } = await setup();
    const cookie = await enablePlugin(app);

    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/authorized-external-source/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json().test).toMatchObject({ ok: true, message: "External source is reachable" });
    expect(JSON.stringify(tested.json())).not.toContain("provider-token");
  });
});
