import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrations.js";
import {
  extractSpotifyTrackId,
  buildCanonicalSpotifyTrackUrl,
  validateSpotifyTrackUrl,
  evaluateSpotifyTrackMatch,
  parsePublicSpotifySearchResults,
  parseDurationFromIso,
  SpotifyTrackResolver,
} from "../src/domain/spotify-track-resolver.js";
import {
  AcquisitionService,
  AcquisitionProviderRegistry,
  type AcquisitionProvider,
  type AcquisitionResult,
} from "../src/domain/acquisition.js";
import {
  SourcePipelineRegistry,
  type SourceCandidate,
  type SourceDiscoveryProvider,
  type SourceDiscoveryOptions,
} from "../src/domain/source-discovery.js";
import { LibraryService } from "../src/domain/library.js";
import { CatalogService } from "../src/domain/catalog.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import type { UnifiedSearchResult } from "../src/domain/search.js";
import { SiteDiscoveryProvider, type SiteSourceDefinition } from "../src/plugins/site-sources.js";

function createValidFlacBuffer(): Buffer {
  const buf = Buffer.alloc(128);
  buf.write("fLaC", 0, "ascii");
  return buf;
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', 'Admin'), ('user', 'User')").run();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
    VALUES ('test-user', 'testuser', 'hash', 'Test User', 'admin', 0, datetime('now'), datetime('now'))
  `).run();
  return db;
}

function createTestTrack(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id: "test-track-id",
    type: "track",
    title: "Test Track",
    subtitle: null,
    artist: "Test Artist",
    album: "Test Album",
    artwork: null,
    provider: "library",
    source: { kind: "library", count: 1 },
    availability: null,
    metadata: {},
    ...overrides,
  };
}

describe("SpotifyTrackResolver and Matching", () => {
  describe("URL extraction and canonicalization", () => {
    it("extracts track ID and canonicalizes Spotify URLs with query parameters", () => {
      const url1 = "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf?si=abcdef123456&context=spotify%3Aalbum%3A123";
      expect(extractSpotifyTrackId(url1)).toBe("4E6cwWJWZw2zWf7VFbH7wf");
      expect(buildCanonicalSpotifyTrackUrl("4E6cwWJWZw2zWf7VFbH7wf")).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");

      const uri = "spotify:track:4E6cwWJWZw2zWf7VFbH7wf";
      expect(extractSpotifyTrackId(uri)).toBe("4E6cwWJWZw2zWf7VFbH7wf");
    });

    it("validates valid and invalid Spotify URLs", () => {
      expect(validateSpotifyTrackUrl("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf")).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
      expect(validateSpotifyTrackUrl("https://open.spotify.com/album/4E6cwWJWZw2zWf7VFbH7wf")).toBeNull();
      expect(validateSpotifyTrackUrl("https://not-spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf")).toBeNull();
      expect(validateSpotifyTrackUrl("invalid-url")).toBeNull();
    });
  });

  describe("evaluateSpotifyTrackMatch", () => {
    const target = createTestTrack({
      id: "track-1",
      type: "track",
      title: "We Will Rock You",
      artist: "Queen",
      album: "News of the World",
      metadata: {
        durationSeconds: 122,
      },
    });

    it("accepts exact title, artist, album, and duration match with high score", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-1",
        name: "We Will Rock You",
        artists: [{ name: "Queen" }],
        album: { name: "News of the World" },
        duration_ms: 122000,
      });

      expect(evalResult.matches).toBe(true);
      expect(evalResult.confidence).toBe("high");
      expect(evalResult.score).toBeGreaterThanOrEqual(80);
    });

    it("rejects artist mismatch", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-2",
        name: "We Will Rock You",
        artists: [{ name: "Tribute Band" }],
        album: { name: "News of the World" },
        duration_ms: 122000,
      });

      expect(evalResult.matches).toBe(false);
      expect(evalResult.reason).toBeDefined();
      expect(evalResult.reason?.toLowerCase()).toContain("artist");
    });

    it("rejects wrong track from same artist (e.g. Another One Bites the Dust when searching Bohemian Rhapsody)", () => {
      const bohemiantarget = createTestTrack({
        id: "track-br",
        type: "track",
        title: "Bohemian Rhapsody",
        artist: "Queen",
        album: "A Night at the Opera",
      });

      const evalResult = evaluateSpotifyTrackMatch(bohemiantarget, {
        id: "spotify-wrong-song",
        name: "Another One Bites the Dust",
        artists: [{ name: "Queen" }],
        album: { name: "The Game" },
        duration_ms: 215000,
      });

      expect(evalResult.matches).toBe(false);
      expect(evalResult.reason?.toLowerCase()).toContain("title");
    });

    it("tolerates duration within 3 seconds and within 8 seconds", () => {
      const resWithin3 = evaluateSpotifyTrackMatch(target, {
        id: "spotify-3",
        name: "We Will Rock You",
        artists: [{ name: "Queen" }],
        album: { name: "News of the World" },
        duration_ms: 124000, // +2s
      });
      expect(resWithin3.matches).toBe(true);

      const resWithin8 = evaluateSpotifyTrackMatch(target, {
        id: "spotify-4",
        name: "We Will Rock You",
        artists: [{ name: "Queen" }],
        album: { name: "News of the World" },
        duration_ms: 129000, // +7s
      });
      expect(resWithin8.matches).toBe(true);
    });

    it("rejects duration differences greater than 20 seconds", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-5",
        name: "We Will Rock You",
        artists: [{ name: "Queen" }],
        album: { name: "News of the World" },
        duration_ms: 180000, // 58s difference
      });

      expect(evalResult.matches).toBe(false);
      expect(evalResult.reason).toBeDefined();
      expect(evalResult.reason?.toLowerCase()).toContain("duration");
    });

    it("rejects live version mismatch when target is studio version", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-6",
        name: "We Will Rock You - Live at Wembley",
        artists: [{ name: "Queen" }],
        album: { name: "Live at Wembley" },
        duration_ms: 122000,
      });

      expect(evalResult.matches).toBe(false);
      expect(evalResult.reason).toBeDefined();
      expect(evalResult.reason?.toLowerCase()).toContain("live");
    });

    it("accepts live version when target is also live", () => {
      const liveTarget = createTestTrack({
        id: "track-live",
        type: "track",
        title: "We Will Rock You (Live)",
        artist: "Queen",
        album: "Live Killers",
      });

      const evalResult = evaluateSpotifyTrackMatch(liveTarget, {
        id: "spotify-7",
        name: "We Will Rock You - Live",
        artists: [{ name: "Queen" }],
        album: { name: "Live Killers" },
      });

      expect(evalResult.matches).toBe(true);
    });

    it("rejects remix mismatch when target is studio version", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-8",
        name: "We Will Rock You (Club Remix)",
        artists: [{ name: "Queen" }],
        album: { name: "Dance Mixes" },
        duration_ms: 122000,
      });

      expect(evalResult.matches).toBe(false);
      expect(evalResult.reason).toBeDefined();
      expect(evalResult.reason?.toLowerCase()).toContain("remix");
    });

    it("handles remaster distinctions without rejecting", () => {
      const evalResult = evaluateSpotifyTrackMatch(target, {
        id: "spotify-9",
        name: "We Will Rock You - 2011 Remaster",
        artists: [{ name: "Queen" }],
        album: { name: "News of the World (Deluxe Edition)" },
        duration_ms: 122000,
      });

      expect(evalResult.matches).toBe(true);
      expect(evalResult.confidence).toBe("high");
    });
  });

  describe("Public HTML and JSON-LD parsing", () => {
    it("parses ISO 8601 duration format", () => {
      expect(parseDurationFromIso("PT5M55S")).toBe(355000);
      expect(parseDurationFromIso("PT2M2S")).toBe(122000);
      expect(parseDurationFromIso("PT1H0M0S")).toBe(3600000);
    });

    it("extracts tracks from JSON-LD scripts in public web pages", () => {
      const html = `
        <html>
          <head>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "MusicRecording",
              "name": "Bohemian Rhapsody",
              "byArtist": { "@type": "MusicGroup", "name": "Queen" },
              "inAlbum": { "@type": "MusicAlbum", "name": "A Night at the Opera" },
              "duration": "PT5M55S",
              "url": "https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J"
            }
            </script>
          </head>
        </html>
      `;

      const tracks = parsePublicSpotifySearchResults(html);
      expect(tracks.length).toBe(1);
      expect(tracks[0].id).toBe("7tFiyTwD0nx5a1eklYtX2J");
      expect(tracks[0].name).toBe("Bohemian Rhapsody");
      expect(tracks[0].artists[0].name).toBe("Queen");
      expect(tracks[0].album?.name).toBe("A Night at the Opera");
      expect(tracks[0].duration_ms).toBe(355000);
    });

    it("extracts tracks from embedded state scripts and HTML links", () => {
      const html = `
        <html>
          <body>
            <div data-testid="search-results">
              <a href="/track/4E6cwWJWZw2zWf7VFbH7wf" aria-label="We Will Rock You by Queen">We Will Rock You</a>
            </div>
            <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "state": {
                    "data": {
                      "search": {
                        "tracks": {
                          "items": [
                            {
                              "id": "7tFiyTwD0nx5a1eklYtX2J",
                              "name": "Bohemian Rhapsody",
                              "artists": [{ "name": "Queen" }],
                              "album": { "name": "A Night at the Opera" },
                              "duration_ms": 354000
                            }
                          ]
                        }
                      }
                    }
                  }
                }
              }
            }
            </script>
          </body>
        </html>
      `;

      const tracks = parsePublicSpotifySearchResults(html);
      expect(tracks.length).toBe(2);
      expect(tracks.map((t) => t.id)).toContain("4E6cwWJWZw2zWf7VFbH7wf");
      expect(tracks.map((t) => t.id)).toContain("7tFiyTwD0nx5a1eklYtX2J");
    });
  });

  describe("SpotifyTrackResolver public-web and web-api modes", () => {
    it("uses fast path when Spotify URL or ID is already in metadata without network request", async () => {
      const mockFetch = vi.fn();
      const resolver = new SpotifyTrackResolver({ fetchImpl: mockFetch });
      const result = createTestTrack({
        id: "track-fast",
        type: "track",
        title: "We Will Rock You",
        artist: "Queen",
        metadata: {
          spotifyTrackUrl: "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf?si=12345",
        },
      });

      const resolution = await resolver.resolveTrack(result);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(resolution).toEqual({
        url: "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf",
        trackId: "4E6cwWJWZw2zWf7VFbH7wf",
        confidence: "high",
        matchedTrack: {
          id: "4E6cwWJWZw2zWf7VFbH7wf",
          title: "We Will Rock You",
          artist: "Queen",
          album: "Test Album",
          durationSeconds: undefined,
        },
      });
    });

    it("resolves Bohemian Rhapsody via public-web search with NO credentials", async () => {
      const mockHtml = `
        <html>
          <head>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "MusicRecording",
              "name": "Bohemian Rhapsody",
              "byArtist": { "@type": "MusicGroup", "name": "Queen" },
              "inAlbum": { "@type": "MusicAlbum", "name": "A Night at the Opera" },
              "duration": "PT5M55S",
              "url": "https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J"
            }
            </script>
          </head>
        </html>
      `;

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/search/")) {
          return new Response(mockHtml, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      // NO credentials provided at all
      const resolver = new SpotifyTrackResolver({
        mode: "public-web",
        fetchImpl: mockFetch,
      });

      const target = createTestTrack({
        id: "target-br",
        type: "track",
        title: "Bohemian Rhapsody",
        artist: "Queen",
        album: "A Night at the Opera",
        metadata: { durationSeconds: 355 },
      });

      const resolution = await resolver.resolveTrack(target);
      expect(resolution).not.toBeNull();
      expect(resolution?.url).toBe("https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J");
      expect(resolution?.trackId).toBe("7tFiyTwD0nx5a1eklYtX2J");
      expect(resolution?.confidence).toBe("high");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("searches Spotify Web API in web-api mode when credentials exist", async () => {
      const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ access_token: "mock-token", token_type: "Bearer" }), { status: 200 });
        }
        if (url.includes("/v1/search")) {
          return new Response(JSON.stringify({
            tracks: {
              items: [
                {
                  id: "4E6cwWJWZw2zWf7VFbH7wf",
                  name: "We Will Rock You",
                  artists: [{ name: "Queen" }],
                  album: { name: "News of the World" },
                  duration_ms: 122000,
                },
              ],
            },
          }), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const resolver = new SpotifyTrackResolver({
        mode: "web-api",
        clientId: "client-id",
        clientSecret: "client-secret",
        fetchImpl: fakeFetch,
      });

      const result = createTestTrack({
        id: "track-search",
        type: "track",
        title: "We Will Rock You",
        artist: "Queen",
        album: "News of the World",
        metadata: { durationSeconds: 122 },
      });

      const resolution = await resolver.resolveTrack(result);
      expect(resolution).not.toBeNull();
      expect(resolution?.url).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
      expect(resolution?.trackId).toBe("4E6cwWJWZw2zWf7VFbH7wf");
      expect(resolution?.confidence).toBe("high");
    });

    it("in auto mode, public-web works without Web API credentials", async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="/track/4E6cwWJWZw2zWf7VFbH7wf" aria-label="We Will Rock You by Queen">We Will Rock You</a>
          </body>
        </html>
      `;

      const mockFetch = vi.fn().mockImplementation(async () => {
        return new Response(mockHtml, { status: 200, headers: { "Content-Type": "text/html" } });
      });

      const resolver = new SpotifyTrackResolver({
        mode: "auto",
        fetchImpl: mockFetch,
      });

      const result = createTestTrack({
        id: "track-auto-public",
        type: "track",
        title: "We Will Rock You",
        artist: "Queen",
      });

      const resolution = await resolver.resolveTrack(result);
      expect(resolution).not.toBeNull();
      expect(resolution?.url).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
    });

    it("fails gracefully without throwing when public web and Web API return no matches", async () => {
      const fakeFetch = vi.fn().mockImplementation(async () => {
        return new Response("<html><body>No results found</body></html>", { status: 200 });
      });

      const resolver = new SpotifyTrackResolver({
        mode: "auto",
        fetchImpl: fakeFetch,
      });

      const result = createTestTrack({
        id: "track-missing",
        type: "track",
        title: "Nonexistent Track Title",
        artist: "Unknown Artist",
      });

      const resolution = await resolver.resolveTrack(result);
      expect(resolution).toBeNull();
    });

    it("handles manual Spotify URL pass-through directly", async () => {
      const resolver = new SpotifyTrackResolver({});
      const result = createTestTrack({
        id: "track-manual",
        type: "track",
        title: "Some Track",
        artist: "Some Artist",
      });

      const resolution = await resolver.resolve(result, {
        manualUrl: "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf?param=test",
      });

      expect(resolution).not.toBeNull();
      expect(resolution?.url).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
      expect(resolution?.trackId).toBe("4E6cwWJWZw2zWf7VFbH7wf");
    });
  });
});

describe("Public site discovery with Spotify input and text fallback", () => {
  it("uses Spotify URL search when site inputMode is spotify-url", async () => {
    let capturedUrl = "";
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url.toString();
      return new Response(
        `<html><body><a href="/downloads/queen-we-will-rock-you.flac">Download Audio</a></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    });

    const siteDef: SiteSourceDefinition = {
      id: "public-spotify-downloader",
      name: "Public Spotify Downloader",
      baseUrl: "https://downloader.test",
      searchPath: "/search?spotify={spotifyUrl}",
      inputMode: "spotify-url",
      responseType: "html",
    };

    const provider = new SiteDiscoveryProvider(siteDef, mockFetch as any);

    const candidates = await provider.search(
      createTestTrack({
        id: "track-queen",
        type: "track",
        title: "We Will Rock You",
        artist: "Queen",
      }),
      {
        spotifyTrackUrl: "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf",
        spotifyTrackId: "4E6cwWJWZw2zWf7VFbH7wf",
      }
    );

    expect(capturedUrl).toContain("https%3A%2F%2Fopen.spotify.com%2Ftrack%2F4E6cwWJWZw2zWf7VFbH7wf");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].metadata?.acquisitionInputs?.spotifyTrackUrl).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
  });

  it("skips site requiring Spotify URL if no Spotify URL was provided", async () => {
    const mockFetch = vi.fn();
    const siteDef: SiteSourceDefinition = {
      id: "public-spotify-downloader",
      name: "Public Spotify Downloader",
      baseUrl: "https://downloader.test",
      searchPath: "/search?spotify={spotifyUrl}",
      inputMode: "spotify-url",
      responseType: "html",
    };

    const provider = new SiteDiscoveryProvider(siteDef, mockFetch as any);

    const candidates = await provider.search(
      createTestTrack({
        id: "track-queen",
        type: "track",
        title: "We Will Rock You",
        artist: "Queen",
      })
    );

    expect(candidates).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("End-to-end Queen - We Will Rock You fixture acquisition with Public Web Lookup (No credentials)", () => {
  it("resolves Spotify link via public web lookup with NO credentials, passes to Spotify-enabled acquisition provider, downloads, validates, and imports", async () => {
    const testDir = path.join(os.tmpdir(), `musicdeck-test-queen-${Date.now()}`);
    const musicRoot = path.join(testDir, "music");
    fs.mkdirSync(musicRoot, { recursive: true });

    const db = createTestDb();

    const mockPublicSpotifyHtml = `
      <html>
        <head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "MusicRecording",
            "name": "We Will Rock You",
            "byArtist": { "@type": "MusicGroup", "name": "Queen" },
            "inAlbum": { "@type": "MusicAlbum", "name": "News of the World" },
            "duration": "PT2M2S",
            "url": "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf"
          }
          </script>
        </head>
      </html>
    `;

    // Mock Spotify resolver with public web lookup - strictly NO credentials
    const spotifyResolver = new SpotifyTrackResolver({
      mode: "public-web",
      fetchImpl: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/search/")) {
          return new Response(mockPublicSpotifyHtml, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    });

    // Mock discovery provider accepting spotify URL
    const discoveryProvider: SourceDiscoveryProvider = {
      id: "spotify-downloader-discovery",
      name: "Spotify Downloader Discovery",
      async search(result: UnifiedSearchResult, options?: SourceDiscoveryOptions) {
        if (!options?.spotifyTrackUrl) {
          return [];
        }
        const candidate: SourceCandidate = {
          id: `spotify-dl:queen-we-will-rock-you`,
          provider: "spotify-dl-provider",
          kind: "file",
          title: "We Will Rock You",
          artist: "Queen",
          album: "News of the World",
          quality: { codec: "FLAC", lossless: true },
          metadata: {
            acquisitionUrl: "https://spotify-dl.test/audio/queen-we-will-rock-you.flac",
            acquisitionInputs: {
              spotifyTrackUrl: options.spotifyTrackUrl,
              spotifyTrackId: options.spotifyTrackId,
            },
          },
        };
        return [candidate];
      },
    };

    const pipelineRegistry = new SourcePipelineRegistry(db);
    pipelineRegistry.registerDiscovery(discoveryProvider);
    pipelineRegistry.configure("spotify-downloader-discovery", true);

    // Mock AcquisitionProvider supporting spotify-track-url
    const acquisitionProvider: AcquisitionProvider = {
      id: "spotify-dl-provider",
      name: "Spotify Downloader Acquisition",
      supportedInputs: ["spotify-track-url", "direct-file"],
      canAcquire(candidate: SourceCandidate) {
        return candidate.provider === "spotify-dl-provider" && Boolean(candidate.metadata?.acquisitionUrl);
      },
      async acquire(candidate: SourceCandidate, options): Promise<AcquisitionResult> {
        const destDir = path.join(options.tmpDir, "download");
        fs.mkdirSync(destDir, { recursive: true });
        const filePath = path.join(destDir, "We Will Rock You.flac");
        fs.writeFileSync(filePath, createValidFlacBuffer());
        return {
          files: [
            {
              path: filePath,
              name: "We Will Rock You.flac",
              title: "We Will Rock You",
              artist: "Queen",
              album: "News of the World",
              size: 128,
            },
          ],
        };
      },
    };

    const providerRegistry = new AcquisitionProviderRegistry();
    providerRegistry.register(acquisitionProvider);

    const library = new LibraryService(db);
    const catalog = new CatalogService(new ProviderRegistry([]), library);

    const acquisitionService = new AcquisitionService(
      db,
      providerRegistry,
      library,
      catalog,
      { emit: () => {} },
      {
        downloadDir: musicRoot,
        tmpDir: path.join(testDir, "temp"),
        sourcePipeline: pipelineRegistry,
        spotifyResolver,
      }
    );

    const queenTrack = createTestTrack({
      id: "track-queen-1",
      type: "track",
      title: "We Will Rock You",
      artist: "Queen",
      album: "News of the World",
      metadata: { durationSeconds: 122 },
    });

    const job = await acquisitionService.createJob({
      userId: "test-user",
      result: queenTrack,
    });

    expect(job).toBeDefined();

    let finishedJob = job;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      finishedJob = acquisitionService.getJob(job.id)!;
      if (finishedJob.status === "completed" || finishedJob.status === "failed") break;
    }

    expect(finishedJob.status).toBe("completed");
    expect(finishedJob.files?.length).toBeGreaterThan(0);

    const importedFile = finishedJob.files![0].path;
    expect(fs.existsSync(importedFile)).toBe(true);
    expect(importedFile).toContain("Queen");
    expect(importedFile).toContain("We Will Rock You.flac");

    // Clean up
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("falls back to text discovery when Spotify resolution fails", async () => {
    const testDir = path.join(os.tmpdir(), `musicdeck-test-fallback-${Date.now()}`);
    const musicRoot = path.join(testDir, "music");
    fs.mkdirSync(musicRoot, { recursive: true });

    const db = createTestDb();

    // Spotify resolver fails / returns null
    const spotifyResolver = new SpotifyTrackResolver({
      fetchImpl: vi.fn().mockImplementation(async () => new Response("<html></html>", { status: 200 })),
    });

    // Text discovery provider
    const textDiscoveryProvider: SourceDiscoveryProvider = {
      id: "text-discovery",
      name: "Text Discovery",
      async search(result: UnifiedSearchResult) {
        const candidate: SourceCandidate = {
          id: `text-source:song-1`,
          provider: "text-acq-provider",
          kind: "file",
          title: result.title,
          artist: result.artist ?? undefined,
          quality: { codec: "FLAC", lossless: true },
          metadata: {
            acquisitionUrl: "https://example.test/song.flac",
          },
        };
        return [candidate];
      },
    };

    const pipelineRegistry = new SourcePipelineRegistry(db);
    pipelineRegistry.registerDiscovery(textDiscoveryProvider);
    pipelineRegistry.configure("text-discovery", true);

    const textAcqProvider: AcquisitionProvider = {
      id: "text-acq-provider",
      name: "Text Acquisition",
      supportedInputs: ["direct-file"],
      canAcquire(candidate: SourceCandidate) {
        return candidate.provider === "text-acq-provider";
      },
      async acquire(candidate: SourceCandidate, options): Promise<AcquisitionResult> {
        const destDir = path.join(options.tmpDir, "download");
        fs.mkdirSync(destDir, { recursive: true });
        const filePath = path.join(destDir, "Track.flac");
        fs.writeFileSync(filePath, createValidFlacBuffer());
        return {
          files: [
            {
              path: filePath,
              name: "Track.flac",
              title: candidate.title || "Track",
              artist: candidate.artist || "Artist",
              size: 128,
            },
          ],
        };
      },
    };

    const providerRegistry = new AcquisitionProviderRegistry();
    providerRegistry.register(textAcqProvider);

    const library = new LibraryService(db);
    const catalog = new CatalogService(new ProviderRegistry([]), library);

    const acquisitionService = new AcquisitionService(
      db,
      providerRegistry,
      library,
      catalog,
      { emit: () => {} },
      {
        downloadDir: musicRoot,
        tmpDir: path.join(testDir, "temp"),
        sourcePipeline: pipelineRegistry,
        spotifyResolver,
      }
    );

    const job = await acquisitionService.createJob({
      userId: "test-user",
      result: createTestTrack({
        id: "track-fallback-1",
        type: "track",
        title: "Fallback Track",
        artist: "Fallback Artist",
      }),
    });

    let finishedJob = job;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      finishedJob = acquisitionService.getJob(job.id)!;
      if (finishedJob.status === "completed" || finishedJob.status === "failed") break;
    }

    expect(finishedJob.status).toBe("completed");
    expect(finishedJob.files?.length).toBeGreaterThan(0);

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("G. tries another valid acquisition route if provider does not support Spotify URL", async () => {
    const testDir = path.join(__dirname, "tmp-test-spotify-g-" + Date.now());
    const musicRoot = path.join(testDir, "music");
    fs.mkdirSync(musicRoot, { recursive: true });

    const db = createTestDb();

    const spotifyResolver = new SpotifyTrackResolver({
      mode: "public-web",
      fetchImpl: vi.fn().mockImplementation(async () => {
        return new Response(
          `
            <html>
              <head>
                <script type="application/ld+json">
                {
                  "@context": "https://schema.org",
                  "@type": "MusicRecording",
                  "name": "Supported Song",
                  "byArtist": [{ "@type": "MusicGroup", "name": "Supported Artist" }],
                  "url": "https://open.spotify.com/track/spotify-sup-123"
                }
                </script>
              </head>
              <body></body>
            </html>
          `,
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }),
    });

    // Discovery pipeline produces 2 candidates:
    // 1st candidate is from a provider that doesn't support spotify-track-url
    // 2nd candidate is from a provider that does support spotify-track-url
    const discoveryProvider: SourceDiscoveryProvider = {
      id: "multi-candidate-pipeline",
      name: "Multi Candidate Pipeline",
      async search(result: UnifiedSearchResult, options?: SourceDiscoveryOptions): Promise<SourceCandidate[]> {
        return [
          {
            id: "cand-no-spotify",
            provider: "no-spotify-provider",
            kind: "file",
            title: result.title,
            artist: result.artist ?? undefined,
            quality: { codec: "FLAC", lossless: true },
            metadata: {
              acquisitionUrl: "https://example.com/no-spotify",
            },
          },
          {
            id: "cand-with-spotify",
            provider: "spotify-enabled-provider",
            kind: "file",
            title: result.title,
            artist: result.artist ?? undefined,
            quality: { codec: "FLAC", lossless: true },
            metadata: {
              acquisitionUrl: "https://example.com/with-spotify",
              acquisitionInputs: {
                spotifyTrackUrl: options?.spotifyTrackUrl,
                spotifyTrackId: options?.spotifyTrackId,
              },
            },
          },
        ];
      },
    };

    const pipelineRegistry = new SourcePipelineRegistry(db);
    pipelineRegistry.registerDiscovery(discoveryProvider);
    pipelineRegistry.configure("multi-candidate-pipeline", true);

    const noSpotifyAcqProvider: AcquisitionProvider = {
      id: "no-spotify-provider",
      name: "No Spotify Provider",
      supportedInputs: ["direct-file"],
      canAcquire(candidate: SourceCandidate) {
        return candidate.provider === "no-spotify-provider" && Boolean(candidate.metadata?.acquisitionUrl);
      },
      async acquire(candidate: SourceCandidate, options): Promise<AcquisitionResult> {
        const destDir = path.join(options.tmpDir, "download");
        fs.mkdirSync(destDir, { recursive: true });
        const filePath = path.join(destDir, "Track.flac");
        fs.writeFileSync(filePath, createValidFlacBuffer());
        return {
          files: [
            {
              path: filePath,
              name: "Track.flac",
              title: candidate.title || "Track",
              artist: candidate.artist || "Artist",
              size: 128,
            },
          ],
        };
      },
    };

    const spotifyAcqProvider: AcquisitionProvider = {
      id: "spotify-enabled-provider",
      name: "Spotify Enabled Provider",
      supportedInputs: ["spotify-track-url", "direct-file"],
      canAcquire(candidate: SourceCandidate) {
        return candidate.provider === "spotify-enabled-provider" && Boolean(candidate.metadata?.acquisitionUrl);
      },
      async acquire(candidate: SourceCandidate, options): Promise<AcquisitionResult> {
        const destDir = path.join(options.tmpDir, "download");
        fs.mkdirSync(destDir, { recursive: true });
        const filePath = path.join(destDir, "Track.flac");
        fs.writeFileSync(filePath, createValidFlacBuffer());
        return {
          files: [
            {
              path: filePath,
              name: "Track.flac",
              title: candidate.title || "Track",
              artist: candidate.artist || "Artist",
              size: 128,
            },
          ],
        };
      },
    };

    const providerRegistry = new AcquisitionProviderRegistry();
    providerRegistry.register(noSpotifyAcqProvider);
    providerRegistry.register(spotifyAcqProvider);

    const library = new LibraryService(db);
    const catalog = new CatalogService(new ProviderRegistry([]), library);

    const acquisitionService = new AcquisitionService(
      db,
      providerRegistry,
      library,
      catalog,
      { emit: () => {} },
      {
        downloadDir: musicRoot,
        tmpDir: path.join(testDir, "temp"),
        sourcePipeline: pipelineRegistry,
        spotifyResolver,
      }
    );

    const job = await acquisitionService.createJob({
      userId: "test-user",
      result: createTestTrack({
        id: "track-sup-1",
        type: "track",
        title: "Supported Song",
        artist: "Supported Artist",
      }),
    });

    let finishedJob = job;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      finishedJob = acquisitionService.getJob(job.id)!;
      if (finishedJob.status === "completed" || finishedJob.status === "failed") break;
    }

    expect(finishedJob.status).toBe("completed");
    expect(finishedJob.files?.length).toBeGreaterThan(0);

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("H. manual Spotify URL reaches acquisition provider directly without network search", async () => {
    const testDir = path.join(__dirname, "tmp-test-spotify-h-" + Date.now());
    const musicRoot = path.join(testDir, "music");
    fs.mkdirSync(musicRoot, { recursive: true });

    const db = createTestDb();

    let networkFetchCalled = false;
    const spotifyResolver = new SpotifyTrackResolver({
      mode: "public-web",
      fetchImpl: vi.fn().mockImplementation(async () => {
        networkFetchCalled = true;
        throw new Error("Network fetch should not be called when manual Spotify URL is provided");
      }),
    });

    let acquiredInputs: any = null;
    const directSpotifyProvider: AcquisitionProvider = {
      id: "direct-spotify-provider",
      name: "Direct Spotify Provider",
      supportedInputs: ["spotify-track-url"],
      canAcquire(candidate: SourceCandidate) {
        return candidate.provider === "direct-spotify-provider" && Boolean(candidate.metadata?.acquisitionUrl);
      },
      async acquire(candidate: SourceCandidate, options): Promise<AcquisitionResult> {
        acquiredInputs = candidate.metadata?.acquisitionInputs;
        const destDir = path.join(options.tmpDir, "download");
        fs.mkdirSync(destDir, { recursive: true });
        const filePath = path.join(destDir, "Track.flac");
        fs.writeFileSync(filePath, createValidFlacBuffer());
        return {
          files: [
            {
              path: filePath,
              name: "Track.flac",
              title: candidate.title || "Track",
              artist: candidate.artist || "Artist",
              size: 128,
            },
          ],
        };
      },
    };

    const discoveryProvider: SourceDiscoveryProvider = {
      id: "manual-spotify-pipeline",
      name: "Manual Spotify Pipeline",
      async search(result: UnifiedSearchResult, options?: SourceDiscoveryOptions): Promise<SourceCandidate[]> {
        return [
          {
            id: "cand-manual",
            provider: "direct-spotify-provider",
            kind: "file",
            title: result.title,
            artist: result.artist ?? undefined,
            quality: { codec: "FLAC", lossless: true },
            metadata: {
              acquisitionUrl: "https://downloader.test/download?spotifyUrl=" + encodeURIComponent(options?.spotifyTrackUrl || ""),
              acquisitionInputs: {
                spotifyTrackUrl: options?.spotifyTrackUrl,
                spotifyTrackId: options?.spotifyTrackId,
              },
            },
          },
        ];
      },
    };

    const pipelineRegistry = new SourcePipelineRegistry(db);
    pipelineRegistry.registerDiscovery(discoveryProvider);
    pipelineRegistry.configure("manual-spotify-pipeline", true);

    const providerRegistry = new AcquisitionProviderRegistry();
    providerRegistry.register(directSpotifyProvider);

    const library = new LibraryService(db);
    const catalog = new CatalogService(new ProviderRegistry([]), library);

    const acquisitionService = new AcquisitionService(
      db,
      providerRegistry,
      library,
      catalog,
      { emit: () => {} },
      {
        downloadDir: musicRoot,
        tmpDir: path.join(testDir, "temp"),
        sourcePipeline: pipelineRegistry,
        spotifyResolver,
      }
    );

    const job = await acquisitionService.createJob({
      userId: "test-user",
      result: createTestTrack({
        id: "track-manual-1",
        type: "track",
        title: "Manual Song",
        artist: "Manual Artist",
        metadata: {
          spotifyTrackUrl: "https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf",
        },
      }),
    });

    let finishedJob = job;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      finishedJob = acquisitionService.getJob(job.id)!;
      if (finishedJob.status === "completed" || finishedJob.status === "failed") break;
    }

    expect(finishedJob.status).toBe("completed");
    expect(networkFetchCalled).toBe(false);
    expect(acquiredInputs?.spotifyTrackUrl).toBe("https://open.spotify.com/track/4E6cwWJWZw2zWf7VFbH7wf");
    expect(acquiredInputs?.spotifyTrackId).toBe("4E6cwWJWZw2zWf7VFbH7wf");

    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

