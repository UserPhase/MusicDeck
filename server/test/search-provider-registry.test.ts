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

describe("SearchProviderRegistry", () => {
  test("registers deterministic built-in and external provider definitions", async () => {
    const { registry } = await setup();

    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "library", kind: "library", enabled: true, status: "enabled" }),
      expect.objectContaining({ id: "musicdeck-playlists", kind: "musicdeck", enabled: true, status: "enabled" }),
      expect.objectContaining({ id: "itunes", kind: "external", enabled: false, status: "disabled" }),
    ]);
  });

  test("enables/configures providers and redacts private configuration", async () => {
    const { registry } = await setup();

    registry.configure("itunes", {
      enabled: true,
      config: { country: "GB", apiKey: "must-not-leak" },
    });

    const provider = registry.list().find((item) => item.id === "itunes");
    expect(provider).toMatchObject({ enabled: true, status: "enabled", config: { country: "GB" } });
    expect(JSON.stringify(provider)).not.toContain("must-not-leak");
  });

  test("merges library, MusicDeck playlists, and enabled external results", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        trackId: 99,
        trackName: "External Song",
        artistName: "External Artist",
        collectionName: "External Album",
        trackTimeMillis: 180000,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { db, registry, playlists } = await setup(fetchImpl as typeof fetch);

    registry.configure("itunes", { enabled: true, config: { country: "US" } });
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("filters enabled providers by library, hybrid, and external modes", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        trackId: 99,
        trackName: "External Song",
        artistName: "External Artist",
        collectionName: "External Album",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { registry } = await setup(fetchImpl as typeof fetch);
    registry.configure("itunes", { enabled: true });

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
    const { registry } = await setup(fetchImpl as typeof fetch);

    registry.configure("itunes", { enabled: true });
    const result = await registry.search("track");

    expect(result.degraded).toBe(true);
    expect(result.groups.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "library" }),
    ]));
    expect(JSON.stringify(registry.list())).not.toContain("token failed");
  });

  test("throws a clean error only when every enabled provider fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const { registry } = await setup(fetchImpl as typeof fetch);

    registry.configure("library", { enabled: false });
    registry.configure("musicdeck-playlists", { enabled: false });
    registry.configure("itunes", { enabled: true });

    await expect(registry.search("track")).rejects.toThrow("All search providers are unavailable");
  });
});
