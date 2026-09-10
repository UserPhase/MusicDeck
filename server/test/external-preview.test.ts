import { afterEach, describe, expect, test } from "vitest";

import type { SourceProvider } from "../src/domain/playable-sources.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";

/**
 * Automatic external preview playback.
 *
 * A track that is not in the local library must still be auditionable when an
 * external catalog publishes a preview. Resolution stays inside the
 * provider-neutral PlayableSource model: the client receives an opaque token
 * plus a `preview` type, never a provider URL or provider name.
 */

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const PREVIEW_URL = "https://cdns-preview-a.dzcdn.net/stream/preview.mp3";

function audio() {
  return new Response(new Uint8Array([73, 68, 51]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Keyless preview catalog that publishes a preview for the requested track. */
function previewFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.hostname === "api.deezer.com" && url.pathname.startsWith("/track/")) {
    return Promise.resolve(json({ preview: PREVIEW_URL }));
  }

  if (url.hostname === "api.deezer.com" && url.pathname === "/search") {
    return Promise.resolve(json({
      data: [{
        title: "External Song",
        artist: { name: "Artist" },
        album: { title: "Album" },
        preview: PREVIEW_URL,
      }],
    }));
  }

  return Promise.resolve(audio());
}

/** Same catalog, but the track exists with no preview available. */
function noPreviewFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.hostname === "api.deezer.com") {
    return Promise.resolve(json({ preview: "", data: [] }));
  }

  return Promise.resolve(audio());
}

const externalTrack = {
  id: "external_deezer_1234",
  type: "track",
  title: "External Song",
  subtitle: "Artist",
  artist: "Artist",
  album: "Album",
  provider: "external",
  source: { kind: "external", count: 0 },
  metadata: {},
};

async function setup(sourceFetchImpl?: typeof fetch) {
  current = await createTestServer(undefined, {}, sourceFetchImpl);
  const { cookie } = await login(current.app);
  return { ...current, cookie };
}

async function libraryTrack(cookie: string | undefined): Promise<any> {
  const search = await current!.app.inject({
    method: "GET",
    url: "/api/search?q=track",
    headers: { cookie },
  });

  return search.json().results.track[0];
}

async function resolveSources(cookie: string | undefined, result: unknown) {
  const response = await current!.app.inject({
    method: "POST",
    url: "/api/sources",
    headers: { cookie },
    payload: { result },
  });

  expect(response.statusCode).toBe(200);
  return response.json();
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("Automatic external preview playback", () => {
  test("the keyless preview source is available on a default install", async () => {
    const { sourceProviders } = await setup();

    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deezer-preview", enabled: true }),
    ]));
  });

  test("a track in the local library plays from the library, never a preview", async () => {
    const { cookie } = await setup(previewFetch as typeof fetch);
    const track = await libraryTrack(cookie);

    const resolved = await resolveSources(cookie, track);

    expect(resolved.sources).toEqual([
      expect.objectContaining({ type: "library", availability: "available" }),
    ]);
    expect(resolved.selectedSource).toMatchObject({ type: "library" });

    const stream = await current!.app.inject({
      method: "GET",
      url: `/api/tracks/${track.id}/stream?playableSource=${resolved.selectedSource.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
  });

  test("a track missing from the library resolves and streams an external preview", async () => {
    const { cookie } = await setup(previewFetch as typeof fetch);

    const resolved = await resolveSources(cookie, externalTrack);

    expect(resolved.sources).toEqual([
      expect.objectContaining({
        provider: "external",
        type: "preview",
        label: "External preview",
        availability: "available",
      }),
    ]);
    expect(resolved.selectedSource).toMatchObject({ type: "preview" });

    // The preview URL and provider identity never reach the client.
    const payload = JSON.stringify(resolved.sources);
    expect(payload).not.toContain("dzcdn.net");
    expect(payload).not.toContain("deezer");

    const stream = await current!.app.inject({
      method: "GET",
      url: `/api/tracks/${externalTrack.id}/stream?playableSource=${resolved.selectedSource.id}`,
      headers: { cookie },
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("audio/mpeg");
  });

  test("a preview advertises its own duration so playback stops at the preview end", async () => {
    const { cookie } = await setup(previewFetch as typeof fetch);

    const resolved = await resolveSources(cookie, externalTrack);

    expect(resolved.selectedSource.quality).toMatchObject({
      durationSeconds: 30,
      lossless: false,
    });
  });

  test("a track with no preview stays unavailable instead of failing the request", async () => {
    const { cookie } = await setup(noPreviewFetch as typeof fetch);

    const resolved = await resolveSources(cookie, externalTrack);

    expect(resolved.sources).toEqual([]);
    expect(resolved.selectedSource).toBeUndefined();
    expect(resolved.degraded).toBe(false);
  });

  test("a preview provider failure never breaks local playback", async () => {
    const { cookie, sourceProviders } = await setup(previewFetch as typeof fetch);
    const track = await libraryTrack(cookie);

    const failingProvider: SourceProvider = {
      id: "failing-preview",
      name: "Failing preview",
      async getSources() {
        throw new Error("private preview failure");
      },
    };
    sourceProviders.register(failingProvider);
    sourceProviders.configure("failing-preview", true);

    const resolved = await resolveSources(cookie, {
      ...track,
      source: { ...track.source, externalAvailable: true },
    });

    expect(resolved.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "library" }),
    ]));
    expect(resolved.degraded).toBe(true);
    expect(JSON.stringify(resolved)).not.toContain("private preview failure");
  });

  test("preview streaming honors the external playback permission", async () => {
    const { app, db, cookie } = await setup(previewFetch as typeof fetch);
    const resolved = await resolveSources(cookie, externalTrack);

    await createUser(db, {
      username: "listener",
      password: "listener-password",
      role: "user",
      displayName: "Listener",
    });
    db.prepare("UPDATE users SET external_playback_enabled = 0 WHERE username = ?").run("listener");

    const listener = await login(app, "listener", "listener-password");
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${externalTrack.id}/stream?playableSource=${resolved.selectedSource.id}`,
      headers: { cookie: listener.cookie },
    });

    expect(stream.statusCode).toBe(403);
  });
});
