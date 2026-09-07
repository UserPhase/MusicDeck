import { afterEach, describe, expect, test } from "vitest";

import {
  compareSourceQuality,
  matchesCandidate,
  scoreCandidate,
  validatedPlayableUrl,
  type CandidateResolver,
  type SourceCandidate,
  type SourceDiscoveryProvider,
} from "../src/domain/source-discovery.js";
import type { PlayableSource } from "../src/domain/playable-sources.js";
import type { UnifiedSearchResult } from "../src/domain/search.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const track: UnifiedSearchResult = {
  id: "external_itunes_7",
  type: "track",
  title: "Digital Love",
  subtitle: "Daft Punk",
  artist: "Daft Punk",
  album: "Discovery",
  artwork: null,
  provider: "external",
  source: { kind: "external", count: 0 },
  availability: null,
  identity: { id: "canonical_test_identity", strength: "normalized" },
  metadata: { durationSeconds: 301 },
};

function candidate(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    id: "candidate-1",
    provider: "discovery-a",
    title: "Digital Love",
    artist: "Daft Punk",
    album: "Discovery",
    durationSeconds: 301,
    ...overrides,
  };
}

function playable(overrides: Partial<PlayableSource> = {}): PlayableSource {
  return {
    id: "https://cdn.example.com/source.flac",
    provider: "plugin",
    type: "external",
    mediaType: "audio",
    label: "Resolver A",
    availability: "available",
    quality: { codec: "FLAC", bitrate: 900, bitDepth: 24, sampleRate: 96000, fileSize: 30_000_000, lossless: true },
    ...overrides,
  };
}

async function setup() {
  current = await createTestServer();
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("SourceCandidate matching", () => {
  test("accepts exact metadata, strong identity, and duration tolerance", () => {
    expect(matchesCandidate(track, candidate())).toBe(true);
    expect(matchesCandidate(track, candidate({ identity: { id: "canonical_test_identity", strength: "normalized" }, title: "Different" }))).toBe(true);
    expect(matchesCandidate(track, candidate({ durationSeconds: 305 }))).toBe(true);
  });

  test("rejects wrong title, artist, album, duration, and version mismatches", () => {
    expect(matchesCandidate(track, candidate({ title: "Something Else" }))).toBe(false);
    expect(matchesCandidate(track, candidate({ artist: "Other Artist" }))).toBe(false);
    expect(matchesCandidate(track, candidate({ album: "Other Album" }))).toBe(false);
    expect(matchesCandidate(track, candidate({ durationSeconds: 500 }))).toBe(false);
    expect(matchesCandidate(track, candidate({ title: "Digital Love (Live)" }))).toBe(false);
    expect(matchesCandidate(track, candidate({ title: "Digital Love (Remix)" }))).toBe(false);
    expect(matchesCandidate(track, candidate({ title: "Digital Love (Radio Edit)" }))).toBe(false);
  });

  test("rejects candidates without enough metadata to identify the recording", () => {
    expect(matchesCandidate(track, candidate({ title: "Digital Love", artist: undefined, album: undefined, durationSeconds: undefined }))).toBe(false);
  });

  test("accepts an album-level magnet only when artist AND album match, never on title alone", () => {
    const albumMagnet = candidate({
      id: "albums-example:magnet:?xt=urn:btih:ALBUM1&dn=Daft+Punk+-+Discovery",
      title: "Discovery",
      artist: "Daft Punk",
      album: undefined,
      durationSeconds: undefined,
    });
    expect(matchesCandidate(track, albumMagnet)).toBe(true);

    // Title-only match (no artist/album context) must not pass.
    expect(matchesCandidate(track, candidate({
      id: "x:magnet:?xt=urn:btih:Z&dn=Something",
      title: "Discovery",
      artist: undefined,
      album: undefined,
      durationSeconds: undefined,
    }))).toBe(false);

    // Wrong artist or wrong album must not pass.
    expect(matchesCandidate(track, candidate({ ...albumMagnet, artist: "Other Artist" }))).toBe(false);
    expect(matchesCandidate({ ...track, album: "Homework" }, albumMagnet)).toBe(false);

    // A non-magnet container id must not use the album path.
    expect(matchesCandidate(track, candidate({ id: "x:https://cdn.example.com/discovery.zip", title: "Discovery", artist: "Daft Punk", album: undefined }))).toBe(false);
  });
});

describe("SourceCandidate scoring", () => {
  test("computes deterministic score with positive weights and version penalties", () => {
    const baseScore = scoreCandidate(track, candidate());
    expect(baseScore).toBeGreaterThan(100); // exact title +40, artist +30, album +25, duration +20

    // Identity match adds +100
    const identityCandidate = candidate({ identity: { id: "canonical_test_identity", strength: "normalized" } });
    expect(scoreCandidate(track, identityCandidate)).toBe(baseScore + 100);

    // Lossless bonus +10
    const losslessCandidate = candidate({ quality: { codec: "FLAC", lossless: true } });
    expect(scoreCandidate(track, losslessCandidate)).toBe(baseScore + 10);

    // Version mismatch penalty -50
    const liveCandidate = candidate({ title: "Digital Love (Live)" });
    expect(scoreCandidate(track, liveCandidate)).toBeLessThan(baseScore);
  });
});

describe("source URL validation", () => {
  test("accepts HTTPS public URLs and rejects unsafe destinations", () => {
    expect(validatedPlayableUrl("https://cdn.example.com/song.flac")).toBe("https://cdn.example.com/song.flac");
    expect(validatedPlayableUrl("http://cdn.example.com/song.flac")).toBeNull();
    expect(validatedPlayableUrl("not-a-url")).toBeNull();
    expect(validatedPlayableUrl("https://localhost/song.flac")).toBeNull();
    expect(validatedPlayableUrl("https://127.0.0.1/song.flac")).toBeNull();
    expect(validatedPlayableUrl("https://192.168.1.5/song.flac")).toBeNull();
    expect(validatedPlayableUrl("https://169.254.169.254/latest/meta-data")).toBeNull();
    expect(validatedPlayableUrl("https://nas.local/song.flac")).toBeNull();
  });
});

describe("quality comparison", () => {
  test("orders lossless, bitrate, bit depth, sample rate, and size deterministically", () => {
    const lossless = playable();
    const mp3 = playable({ id: "https://cdn.example.com/song.mp3", quality: { codec: "MP3", bitrate: 320, lossless: false } });

    expect(compareSourceQuality(lossless, mp3)).toBeLessThan(0);
    expect(compareSourceQuality(mp3, lossless)).toBeGreaterThan(0);
    expect(compareSourceQuality(
      playable({ id: "a", quality: { lossless: true, bitrate: 1000 } }),
      playable({ id: "b", quality: { lossless: true, bitrate: 800 } })
    )).toBeLessThan(0);
  });
});

describe("SourcePipelineRegistry", () => {
  test("registers discovery and resolver providers with independent enablement", async () => {
    const { sourcePipeline } = await setup();
    const discovery: SourceDiscoveryProvider = {
      id: "discovery-a",
      name: "Authorized Catalog A",
      search: async () => [candidate()],
    };
    const resolver: CandidateResolver = {
      id: "resolver-a",
      name: "Resolver A",
      resolve: async () => [playable()],
      test: async () => ({ ok: true }),
    };

    sourcePipeline.registerDiscovery(discovery);
    sourcePipeline.registerResolver(resolver);

    expect(sourcePipeline.list()).toEqual([
      expect.objectContaining({ id: "discovery-a", role: "discovery", enabled: false }),
      expect.objectContaining({ id: "resolver-a", role: "resolver", enabled: false }),
    ]);

    sourcePipeline.configure("discovery-a", true);
    sourcePipeline.configure("resolver-a", true);
    expect(sourcePipeline.list().every((provider) => provider.enabled)).toBe(true);
    await expect(sourcePipeline.test("resolver-a")).resolves.toMatchObject({ ok: true });
  });

  test("merges multiple providers and isolates failures", async () => {
    const { sourcePipeline } = await setup();
    sourcePipeline.registerDiscovery({
      id: "discovery-a",
      name: "Catalog A",
      search: async () => [candidate()],
    });
    sourcePipeline.registerDiscovery({
      id: "discovery-failing",
      name: "Failing Catalog",
      search: async () => { throw new Error("private discovery failure"); },
    });
    sourcePipeline.registerResolver({
      id: "resolver-a",
      name: "Resolver A",
      resolve: async () => [playable()],
    });
    sourcePipeline.registerResolver({
      id: "resolver-failing",
      name: "Failing Resolver",
      resolve: async () => { throw new Error("private resolver failure"); },
    });
    for (const id of ["discovery-a", "discovery-failing", "resolver-a", "resolver-failing"]) {
      sourcePipeline.configure(id, true);
    }

    const sources = await sourcePipeline.resolve(track);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ label: "Resolver A", quality: expect.objectContaining({ codec: "FLAC" }) });
    expect(JSON.stringify(sources)).not.toContain("private");
  });

  test("rejects resolver-produced unsafe URLs", async () => {
    const { sourcePipeline } = await setup();
    sourcePipeline.registerDiscovery({
      id: "discovery-a",
      name: "Catalog A",
      search: async () => [candidate()],
    });
    sourcePipeline.registerResolver({
      id: "resolver-a",
      name: "Resolver A",
      resolve: async () => [
        playable({ id: "http://169.254.169.254/internal.flac" }),
        playable({ id: "https://cdn.example.com/safe.flac" }),
      ],
    });
    sourcePipeline.configure("discovery-a", true);
    sourcePipeline.configure("resolver-a", true);

    const sources = await sourcePipeline.resolve(track);

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("https://cdn.example.com/safe.flac");
  });

  test("falls back to the next ranked candidate when the highest candidate fails to resolve", async () => {
    const { sourcePipeline } = await setup();
    const deadCandidate = candidate({
      id: "candidate-dead",
      title: "Digital Love",
      quality: { codec: "FLAC", lossless: true, bitrate: 1000 },
    });
    const fallbackCandidate = candidate({
      id: "candidate-fallback",
      title: "Digital Love",
      quality: { codec: "MP3", lossless: false, bitrate: 320 },
    });

    sourcePipeline.registerDiscovery({
      id: "discovery-a",
      name: "Catalog A",
      search: async () => [deadCandidate, fallbackCandidate],
    });
    sourcePipeline.registerResolver({
      id: "resolver-a",
      name: "Resolver A",
      resolve: async (c) => {
        if (c.id === "candidate-dead") {
          throw new Error("Candidate is dead or uncached");
        }
        return [playable({
          id: "https://cdn.example.com/fallback.mp3",
          quality: { codec: "MP3", lossless: false, bitrate: 320 },
        })];
      },
    });
    sourcePipeline.configure("discovery-a", true);
    sourcePipeline.configure("resolver-a", true);

    const sources = await sourcePipeline.resolve(track);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "https://cdn.example.com/fallback.mp3",
      quality: expect.objectContaining({ codec: "MP3" }),
    });
  });
});

describe("pipeline through SourceProviderRegistry", () => {
  async function setupPipeline() {
    const server = await setup();
    server.sourcePipeline.registerDiscovery({
      id: "discovery-a",
      name: "Catalog A",
      search: async () => [candidate()],
    });
    server.sourcePipeline.registerResolver({
      id: "resolver-a",
      name: "Resolver A",
      resolve: async () => [playable()],
    });
    server.sourcePipeline.configure("discovery-a", true);
    server.sourcePipeline.configure("resolver-a", true);
    server.sourceProviders.configure("source-pipeline", true);
    return server;
  }

  test("resolves pipeline sources as opaque playable tokens for external-only tracks", async () => {
    const { app, sourceProviders } = await setupPipeline();
    const { cookie } = await login(app);

    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source-pipeline", enabled: true }),
      expect.objectContaining({ id: "discovery-a", role: "discovery", enabled: true }),
      expect.objectContaining({ id: "resolver-a", role: "resolver", enabled: true }),
    ]));

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: track },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().sources).toEqual([
      expect.objectContaining({ label: "Resolver A", type: "external", quality: expect.objectContaining({ codec: "FLAC", lossless: true }) }),
    ]);
    expect(resolved.json().sources[0].id).toMatch(/^playable_/);
    expect(resolved.json().sources[0].expiresAt).toBeTruthy();
    expect(JSON.stringify(resolved.json())).not.toContain("cdn.example.com");
  });

  test("pipeline sources flow through preference selection", async () => {
    const { sourceProviders } = await setupPipeline();

    const best = await sourceProviders.resolve(track, { allowExternal: true, preference: "best" });
    const lossless = await sourceProviders.resolve(track, { allowExternal: true, preference: "lossless" });
    const highestBitrate = await sourceProviders.resolve(track, { allowExternal: true, preference: "highest-bitrate" });
    const preferred = await sourceProviders.resolve(track, { allowExternal: true, preference: "preferred", preferredProvider: "Resolver A" });
    const manual = await sourceProviders.resolve(track, { allowExternal: true, preference: "manual" });

    expect(best.selectedSource?.label).toBe("Resolver A");
    expect(lossless.selectedSource?.quality?.lossless).toBe(true);
    expect(highestBitrate.selectedSource?.quality?.bitrate).toBe(900);
    expect(preferred.selectedSource?.label).toBe("Resolver A");
    expect(manual.selectedSource).toMatchObject({ label: "Resolver A" });
  });

  test("existing library playback remains the default single-source selection", async () => {
    const { app, sourceProviders, catalog } = await setupPipeline();
    const { cookie } = await login(app);
    const libraryTrack = (await catalog.listTracks()).items[0];

    const resolved = await sourceProviders.resolve({
      ...track,
      id: libraryTrack.id,
      title: libraryTrack.title,
      artist: libraryTrack.artistName,
      album: libraryTrack.albumName,
      provider: "library",
      source: { kind: "library", count: 1 },
    }, { allowExternal: true, preference: "library" });

    expect(resolved.selectedSource?.type).toBe("library");

    const search = await app.inject({
      method: "GET",
      url: "/api/tracks",
      headers: { cookie },
    });
    expect(search.statusCode).toBe(200);
  });
});
