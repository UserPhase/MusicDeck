import { afterEach, describe, expect, test, vi } from "vitest";

import { SearchProviderRegistry } from "../src/domain/search-provider-registry.js";
import { closeTestServer, createTestServer } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

async function setup(fetchImpl?: typeof fetch) {
  current = await createTestServer();
  return {
    ...current,
    registry: new SearchProviderRegistry(
      current.db,
      current.catalog,
      current.playlists,
      fetchImpl
    ),
  };
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

const TOKEN_RESPONSE = () => new Response(
  JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
  { status: 200, headers: { "content-type": "application/json" } }
);

/** Builds a fetch mock that answers the Spotify token endpoint and search endpoint. */
function spotifyFetchImpl(searchPayload: unknown, searchStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("accounts.spotify.com/api/token")) {
      return TOKEN_RESPONSE();
    }
    return new Response(JSON.stringify(searchPayload), {
      status: searchStatus,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("SearchProviderRegistry", () => {
  test("registers deterministic built-in and external provider definitions", async () => {
    const { registry } = await setup();

    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "library", kind: "library", enabled: true, status: "enabled" }),
      expect.objectContaining({ id: "musicdeck-playlists", kind: "musicdeck", enabled: true, status: "enabled" }),
      expect.objectContaining({ id: "deezer", kind: "external", enabled: true, status: "enabled" }),
      expect.objectContaining({ id: "spotify", kind: "external", enabled: false, status: "disabled" }),
    ]);
  });

  test("enables/configures providers and redacts private configuration", async () => {
    const { registry } = await setup();

    registry.configure("spotify", {
      enabled: true,
      config: { clientId: "abc", clientSecret: "must-not-leak" },
    });

    const provider = registry.list().find((item) => item.id === "spotify");
    expect(provider).toMatchObject({ enabled: true, status: "enabled", config: { clientId: "abc" } });
    expect(JSON.stringify(provider)).not.toContain("must-not-leak");
  });

  test("merges library, MusicDeck playlists, and enabled Spotify track results", async () => {
    const fetchImpl = spotifyFetchImpl({
      tracks: {
        items: [{
          id: "0Spotify0Track0Id0000",
          name: "External Song",
          artists: [{ name: "External Artist" }],
          album: { name: "External Album" },
          duration_ms: 180000,
        }],
      },
    });
    const { db, registry, playlists } = await setup(fetchImpl as unknown as typeof fetch);

    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });
    const user = db.prepare("SELECT id, role FROM users LIMIT 1").get() as { id: string; role: "admin" };
    await playlists.create("Road Trip", user as any);

    const result = await registry.search("road");

    expect(result.degraded).toBe(false);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library" }),
      expect.objectContaining({ provider: "external", title: "External Song", source: { kind: "external", count: 0 } }),
    ]));
    expect(result.groups.playlist).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "musicdeck", title: "Road Trip" }),
    ]));
  });

  test("searches Spotify albums", async () => {
    const fetchImpl = spotifyFetchImpl({
      albums: {
        items: [{
          id: "0Spotify0Album0Id0000",
          name: "External Album",
          artists: [{ name: "External Artist" }],
        }],
      },
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.search("album", { mode: "external", types: ["album"] });

    expect(result.groups.album).toEqual([
      expect.objectContaining({ provider: "external", title: "External Album", type: "album" }),
    ]);
  });

  test("searches Spotify artists", async () => {
    const fetchImpl = spotifyFetchImpl({
      artists: {
        items: [{ id: "0Spotify0Artist0Id000", name: "External Artist" }],
      },
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.search("artist", { mode: "external", types: ["artist"] });

    expect(result.groups.artist).toEqual([
      expect.objectContaining({ provider: "external", title: "External Artist", type: "artist" }),
    ]);
  });

  test("falls back to spotdl-downloader plugin credentials when the provider has none configured", async () => {
    const fetchImpl = spotifyFetchImpl({
      tracks: {
        items: [{
          id: "0Spotify0Track0Id0002",
          name: "External Song",
          artists: [{ name: "External Artist" }],
          album: { name: "External Album" },
        }],
      },
    });
    const { db, registry } = await setup(fetchImpl as unknown as typeof fetch);

    // No credentials configured directly on the Spotify search provider...
    registry.configure("spotify", { enabled: true, config: {} });
    // ...but the spotdl-downloader plugin already has Spotify app credentials.
    db.prepare(`
      INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
      VALUES ('spotdl-downloader', 1, ?, '[]', CURRENT_TIMESTAMP)
      ON CONFLICT(plugin_id) DO UPDATE SET config_json = excluded.config_json
    `).run(JSON.stringify({ clientId: "shared-id", clientSecret: "shared-secret" }));

    const result = await registry.search("track");

    expect(result.degraded).toBe(false);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external", title: "External Song" }),
    ]));
  });

  test("returns no results (not an error) when Spotify credentials are unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    // Isolate Spotify's own credential-check behavior from Deezer, which is
    // enabled by default and would otherwise also call fetchImpl.
    registry.configure("deezer", { enabled: false });
    // Enabled with no clientId/clientSecret configured.
    registry.configure("spotify", { enabled: true, config: {} });
    const result = await registry.search("track");

    expect(result.degraded).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.groups.track).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external" }),
    ]));
  });

  test("filters enabled providers by library, hybrid, and external modes", async () => {
    const fetchImpl = spotifyFetchImpl({
      tracks: {
        items: [{
          id: "0Spotify0Track0Id0001",
          name: "External Song",
          artists: [{ name: "External Artist" }],
          album: { name: "External Album" },
        }],
      },
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const library = await registry.search("track", { mode: "library" });
    const hybrid = await registry.search("track", { mode: "hybrid" });
    const external = await registry.search("track", { mode: "external" });

    expect(library.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library" }),
    ]));
    expect(library.groups.track).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external" }),
    ]));
    expect(hybrid.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library" }),
      expect.objectContaining({ provider: "external" }),
    ]));
    expect(external.groups.track).toEqual([
      expect.objectContaining({ provider: "external" }),
    ]);
  });

  test("isolates a failed external provider and marks partial search degraded", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("external provider token failed");
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });
    const result = await registry.search("track");

    expect(result.degraded).toBe(true);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library" }),
    ]));
    expect(JSON.stringify(registry.list())).not.toContain("token failed");
  });

  test("throws a clean error only when every enabled provider fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    registry.configure("library", { enabled: false });
    registry.configure("musicdeck-playlists", { enabled: false });
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    await expect(registry.search("track")).rejects.toThrow("All search providers are unavailable");
  });

  test("list() surfaces the specific last-search failure instead of a generic message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });
    await registry.search("track");

    const provider = registry.list().find((item) => item.id === "spotify");
    expect(provider?.status).toBe("error");
    expect(provider?.statusMessage).toContain("Spotify is unavailable");
  });

  test("test() reports a specific not_configured message when Spotify credentials are missing", async () => {
    const { registry } = await setup();
    registry.configure("spotify", { enabled: true, config: {} });

    const result = await registry.test("spotify");

    expect(result).toMatchObject({ id: "spotify", ok: false, status: "not_configured" });
    expect(result.message).toContain("Spotify search is not configured");
  });

  test("test() reports Spotify is reachable when credentials and the API respond successfully", async () => {
    const fetchImpl = spotifyFetchImpl({ tracks: { items: [] } });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.test("spotify");

    expect(result).toMatchObject({ id: "spotify", ok: true, status: "success" });
    expect(result.message).toContain("Spotify is reachable");
  });

  test("test() classifies an unreachable Spotify API distinctly from missing credentials", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 502 });
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.test("spotify");

    expect(result).toMatchObject({ id: "spotify", ok: false, status: "provider_unavailable" });
    expect(result.message).toContain("Spotify catalog request failed");
    expect(result.message).toContain("502");
  });

  test("test() distinguishes a token-stage failure from a catalog-stage failure", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({ error: "invalid_client", error_description: "Invalid client secret" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("should not reach the catalog request when the token request failed");
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "wrong-secret" } });

    const result = await registry.test("spotify");

    expect(result).toMatchObject({ id: "spotify", ok: false, status: "authentication_failed" });
    expect(result.message).toContain("token acquisition");
    expect(result.message).toContain("invalid_client");
    expect(result.message).toContain("Invalid client secret");
  });

  test("test() reports a 403 catalog-stage failure with a specific reason distinct from bad credentials", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { status: 403, message: "Insufficient client scope" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.test("spotify");

    expect(result).toMatchObject({ id: "spotify", ok: false, status: "authentication_failed" });
    expect(result.message).toContain("HTTP 403");
    expect(result.message).toContain("Insufficient client scope");
    expect(result.message).toContain("developer dashboard");
  });

  test("test() throws for an unknown provider id", async () => {
    const { registry } = await setup();
    await expect(registry.test("does-not-exist")).rejects.toThrow("Unknown search provider");
  });

  test("searches Deezer tracks, albums, and artists without requiring credentials", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/search/track")) {
        return new Response(JSON.stringify({
          data: [{
            id: 111,
            title: "Deezer Song",
            artist: { name: "Deezer Artist" },
            album: { title: "Deezer Album" },
            duration: 210,
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/search/album")) {
        return new Response(JSON.stringify({
          data: [{ id: 222, title: "Deezer Album", artist: { name: "Deezer Artist" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/search/artist")) {
        return new Response(JSON.stringify({
          data: [{ id: 333, name: "Deezer Artist" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    const result = await registry.search("deezer");

    expect(result.degraded).toBe(false);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "external",
        id: "external_deezer_track_111",
        title: "Deezer Song",
        artist: "Deezer Artist",
        album: "Deezer Album",
        metadata: expect.objectContaining({ durationSeconds: 210 }),
      }),
    ]));
    expect(result.groups.album).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external", id: "external_deezer_album_222", title: "Deezer Album" }),
    ]));
    expect(result.groups.artist).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external", id: "external_deezer_artist_333", title: "Deezer Artist" }),
    ]));
  });

  test("treats Deezer's in-band error payload (HTTP 200) as a provider failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { type: "QuotaException", message: "Quota limit exceeded", code: 4 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    const result = await registry.search("deezer");

    expect(result.degraded).toBe(true);
    const provider = registry.list().find((item) => item.id === "deezer");
    expect(provider?.status).toBe("error");
    expect(provider?.statusMessage).toContain("Deezer is unavailable");
  });

  test("treats a Deezer HTTP error status as a provider failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    const result = await registry.search("deezer");

    expect(result.degraded).toBe(true);
    const provider = registry.list().find((item) => item.id === "deezer");
    expect(provider?.status).toBe("error");
    expect(provider?.statusMessage).toContain("Deezer is unavailable");
  });

  test("Deezer failure does not break Spotify results, and vice versa", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.deezer.com")) {
        throw new Error("deezer network failure");
      }
      if (url.includes("accounts.spotify.com/api/token")) {
        return TOKEN_RESPONSE();
      }
      if (url.includes("api.spotify.com")) {
        return new Response(JSON.stringify({
          tracks: {
            items: [{
              id: "0Spotify0Track0Id0002",
              name: "Spotify Song",
              artists: [{ name: "Spotify Artist" }],
              album: { name: "Spotify Album" },
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);
    registry.configure("spotify", { enabled: true, config: { clientId: "id", clientSecret: "secret" } });

    const result = await registry.search("track");

    expect(result.degraded).toBe(true);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "external", title: "Spotify Song" }),
    ]));
    expect(registry.list().find((item) => item.id === "deezer")?.status).toBe("error");
    expect(registry.list().find((item) => item.id === "spotify")?.status).toBe("enabled");
  });

  test("test() reports Deezer is reachable when the API responds successfully", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 1, title: "x", artist: { name: "y" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    const result = await registry.test("deezer");

    expect(result).toMatchObject({ id: "deezer", ok: true });
  });

  test("test() classifies an unreachable Deezer API distinctly", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { registry } = await setup(fetchImpl as unknown as typeof fetch);

    const result = await registry.test("deezer");

    expect(result).toMatchObject({ id: "deezer", ok: false, status: "provider_unavailable" });
    expect(result.message).toContain("HTTP 500");
  });
});
