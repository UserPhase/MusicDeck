import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ArchiveOrgContainerProvider,
  ArchiveOrgDiscoveryProvider,
  ArchiveOrgResolver,
  archiveFileMatches,
  buildArchiveDownloadUrl,
  detectCodec,
  extractArchiveRepresentations,
  isAudioFile,
  parseDurationSeconds,
} from "../src/plugins/in-progress/archive-org-source.js";
import { DebridCloudSourceProvider } from "../src/plugins/in-progress/external-source-plugins.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const trackQueen = {
  id: "external_itunes_queen_1",
  type: "track" as const,
  title: "Bohemian Rhapsody",
  subtitle: "Queen",
  artist: "Queen",
  album: "A Night at the Opera",
  provider: "external" as const,
  source: { kind: "external" as const, count: 0 },
  availability: null,
  artwork: null,
  metadata: { durationSeconds: 354 },
};

const trackScarTissue = {
  id: "external_itunes_rhcp_scar_tissue",
  type: "track" as const,
  title: "Scar Tissue",
  subtitle: "Red Hot Chili Peppers",
  artist: "Red Hot Chili Peppers",
  album: "Californication",
  provider: "external" as const,
  source: { kind: "external" as const, count: 0 },
  availability: null,
  artwork: null,
  metadata: { durationSeconds: 217 },
};

const SEARCH_RESPONSE_QUEEN = {
  responseHeader: { status: 0, QTime: 12 },
  response: {
    numFound: 1,
    start: 0,
    docs: [
      {
        identifier: "bohemian-rhapsody-queen",
        title: "Bohemian Rhapsody",
        creator: "Queen",
        album: "A Night at the Opera",
        mediatype: "audio",
        year: 1975,
      },
    ],
  },
};

const SEARCH_RESPONSE_CALIFORNICATION = {
  responseHeader: { status: 0, QTime: 10 },
  response: {
    numFound: 1,
    start: 0,
    docs: [
      {
        identifier: "californication_202408",
        title: "Californication",
        creator: "Red Hot Chili Peppers",
        album: "Californication",
        mediatype: "audio",
        year: 1999,
      },
    ],
  },
};

const METADATA_RESPONSE_QUEEN = {
  server: "ia800100.us.archive.org",
  dir: "/12/items/bohemian-rhapsody-queen",
  metadata: {
    identifier: "bohemian-rhapsody-queen",
    title: "Bohemian Rhapsody",
    creator: "Queen",
    album: "A Night at the Opera",
    mediatype: "audio",
  },
  files: [
    {
      name: "Queen - Bohemian Rhapsody.flac",
      format: "Flac",
      size: "45123456",
      length: "354.2",
      bitrate: "900",
      title: "Bohemian Rhapsody",
      creator: "Queen",
      album: "A Night at the Opera",
      track: "11",
    },
    {
      name: "Queen - Bohemian Rhapsody.mp3",
      format: "VBR MP3",
      size: "8512345",
      length: "354.2",
      bitrate: "320",
      title: "Bohemian Rhapsody",
      creator: "Queen",
      album: "A Night at the Opera",
    },
    {
      name: "cover.jpg",
      format: "JPEG",
      size: "102400",
    },
    {
      name: "bohemian-rhapsody-queen_files.xml",
      format: "Metadata",
      size: "4096",
    },
    {
      name: "video.mp4",
      format: "MPEG4",
      size: "105123456",
    },
    {
      name: "archive.zip",
      format: "ZIP",
      size: "55123456",
    },
    {
      name: "item.torrent",
      format: "Archive BitTorrent",
      size: "12345",
    },
  ],
};

const METADATA_RESPONSE_ALBUM = {
  server: "ia800100.us.archive.org",
  dir: "/12/items/queen-a-night-at-the-opera",
  metadata: {
    identifier: "queen-a-night-at-the-opera",
    title: "A Night at the Opera",
    creator: "Queen",
    album: "A Night at the Opera",
    mediatype: "audio",
  },
  files: [
    {
      name: "01 - Death on Two Legs.flac",
      format: "Flac",
      size: "25000000",
      length: "223",
      title: "Death on Two Legs",
      creator: "Queen",
      album: "A Night at the Opera",
      track: "1",
    },
    {
      name: "02 - Lazing on a Sunday Afternoon.flac",
      format: "Flac",
      size: "12000000",
      length: "67",
      title: "Lazing on a Sunday Afternoon",
      creator: "Queen",
      album: "A Night at the Opera",
      track: "2",
    },
    {
      name: "11 - Bohemian Rhapsody.flac",
      format: "Flac",
      size: "45000000",
      length: "354",
      title: "Bohemian Rhapsody",
      creator: "Queen",
      album: "A Night at the Opera",
      track: "11",
    },
    {
      name: "album_cover.png",
      format: "PNG",
    },
  ],
};

const METADATA_RESPONSE_CALIFORNICATION = {
  server: "ia800100.us.archive.org",
  dir: "/12/items/californication_202408",
  metadata: {
    identifier: "californication_202408",
    title: "Californication",
    creator: "Red Hot Chili Peppers",
    album: "Californication",
    mediatype: "audio",
  },
  files: [
    {
      name: "californication/01-Around the World.flac",
      format: "Flac",
      size: "30000000",
      length: "238",
      title: "Around the World",
      creator: "Red Hot Chili Peppers",
    },
    {
      name: "californication/02-Parallel Universe.flac",
      format: "Flac",
      size: "32000000",
      length: "270",
      title: "Parallel Universe",
      creator: "Red Hot Chili Peppers",
    },
    {
      name: "californication/03-Scar Tissue.flac",
      format: "Flac",
      size: "28000000",
      length: "217",
      title: "Scar Tissue",
      creator: "Red Hot Chili Peppers",
    },
    {
      name: "californication/04-Otherside.flac",
      format: "Flac",
      size: "29000000",
      length: "255",
      title: "Otherside",
      creator: "Red Hot Chili Peppers",
    },
    {
      name: "californication/californication_cover.jpg",
      format: "JPEG",
      size: "102400",
    },
    {
      name: "californication_202408_archive.torrent",
      format: "Archive BitTorrent",
      size: "45000",
    },
  ],
};

let debridFetchCount = 0;

function archiveMockFetch(input: URL | RequestInfo | string, init?: RequestInit) {
  const url = new URL(String(input));

  if (url.hostname === "debrid.example") {
    if (url.pathname === "/v1/account") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.pathname === "/v1/fetch") {
      debridFetchCount++;
      return Promise.resolve(new Response(JSON.stringify({
        id: "debrid-job-californication",
        status: "ready",
        files: [
          {
            name: "01 - Around the World.flac",
            url: "https://cdn.example.com/californication/01-Around-the-World.flac",
            durationSeconds: 238,
            codec: "FLAC",
            bitrate: 950,
            sampleRate: 44100,
            bitDepth: 16,
            size: 30000000,
          },
          {
            name: "02 - Parallel Universe.flac",
            url: "https://cdn.example.com/californication/02-Parallel-Universe.flac",
            durationSeconds: 270,
            codec: "FLAC",
            bitrate: 950,
            sampleRate: 44100,
            bitDepth: 16,
            size: 32000000,
          },
          {
            name: "03 - Scar Tissue.flac",
            url: "https://cdn.example.com/californication/03-Scar-Tissue.flac",
            durationSeconds: 217,
            codec: "FLAC",
            bitrate: 950,
            sampleRate: 44100,
            bitDepth: 16,
            size: 28000000,
          },
          {
            name: "04 - Otherside.flac",
            url: "https://cdn.example.com/californication/04-Otherside.flac",
            durationSeconds: 255,
            codec: "FLAC",
            bitrate: 950,
            sampleRate: 44100,
            bitDepth: 16,
            size: 29000000,
          },
          {
            name: "03 - Scar Tissue (Live in Poland).flac",
            url: "https://cdn.example.com/californication/03-Scar-Tissue-Live.flac",
            durationSeconds: 245,
            codec: "FLAC",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.pathname === "/v1/resolve") {
      return Promise.resolve(new Response(JSON.stringify({
        id: "debrid-job-direct",
        status: "ready",
        files: [{ name: "track.flac", url: "https://cdn.example.com/track.flac" }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
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

  if (url.hostname === "archive.org" && url.pathname === "/advancedsearch.php") {
    const q = url.searchParams.get("q") || "";
    if (q.includes("Bohemian") || q.includes("Queen")) {
      return Promise.resolve(new Response(JSON.stringify(SEARCH_RESPONSE_QUEEN), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (q.includes("Scar Tissue") || q.includes("Californication") || q.includes("Red Hot Chili Peppers")) {
      return Promise.resolve(new Response(JSON.stringify(SEARCH_RESPONSE_CALIFORNICATION), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({ response: { docs: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  if (url.hostname === "archive.org" && url.pathname.startsWith("/metadata/")) {
    const id = decodeURIComponent(url.pathname.replace("/metadata/", ""));
    if (id === "bohemian-rhapsody-queen") {
      return Promise.resolve(new Response(JSON.stringify(METADATA_RESPONSE_QUEEN), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (id === "queen-a-night-at-the-opera") {
      return Promise.resolve(new Response(JSON.stringify(METADATA_RESPONSE_ALBUM), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (id === "californication_202408") {
      return Promise.resolve(new Response(JSON.stringify(METADATA_RESPONSE_CALIFORNICATION), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }

  if (url.hostname === "archive.org" && url.pathname.startsWith("/download/")) {
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

async function setup(fetchImpl: typeof fetch = archiveMockFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, undefined, fetchImpl);
  return current;
}

async function enableArchiveOrg(app: Awaited<ReturnType<typeof createTestServer>>["app"]) {
  const { cookie } = await login(app);
  const enabled = await app.inject({
    method: "PATCH",
    url: "/api/admin/plugins/archive-org-source",
    headers: { cookie },
    payload: {
      enabled: true,
      config: {},
      permissions: ["network.request", "external-source.play"],
    },
  });
  return { cookie, enabled };
}

async function enableDebrid(app: Awaited<ReturnType<typeof createTestServer>>["app"]) {
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

describe("Archive.org file parsing and matching unit tests", () => {
  test("filters audio files and blocks non-audio extensions", () => {
    expect(isAudioFile("track.flac")).toBe(true);
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("track.ogg")).toBe(true);
    expect(isAudioFile("track.opus")).toBe(true);
    expect(isAudioFile("track.m4a")).toBe(true);
    expect(isAudioFile("track.wav")).toBe(true);
    expect(isAudioFile("track.alac")).toBe(true);
    expect(isAudioFile("song.unknown", "VBR MP3")).toBe(true);
    expect(isAudioFile("song.unknown", "Flac")).toBe(true);

    expect(isAudioFile("cover.jpg")).toBe(false);
    expect(isAudioFile("image.png")).toBe(false);
    expect(isAudioFile("video.mp4")).toBe(false);
    expect(isAudioFile("movie.mkv")).toBe(false);
    expect(isAudioFile("archive.zip")).toBe(false);
    expect(isAudioFile("files.rar")).toBe(false);
    expect(isAudioFile("torrent.torrent")).toBe(false);
    expect(isAudioFile("meta.xml")).toBe(false);
    expect(isAudioFile("doc.pdf")).toBe(false);
  });

  test("detects codecs and lossless characteristics", () => {
    expect(detectCodec("song.flac")).toBe("FLAC");
    expect(detectCodec("song.mp3")).toBe("MP3");
    expect(detectCodec("song.ogg")).toBe("OGG");
    expect(detectCodec("song.opus")).toBe("OPUS");
    expect(detectCodec("song.wav")).toBe("WAV");
    expect(detectCodec("file", "24bit Flac")).toBe("FLAC");
    expect(detectCodec("file", "VBR MP3")).toBe("MP3");
  });

  test("parses duration in seconds from various formats", () => {
    expect(parseDurationSeconds(354.2)).toBe(354);
    expect(parseDurationSeconds("354.2")).toBe(354);
    expect(parseDurationSeconds("05:54")).toBe(354);
    expect(parseDurationSeconds("01:05:54")).toBe(3954);
    expect(parseDurationSeconds("invalid")).toBeUndefined();
  });

  test("builds valid Archive.org download URL", () => {
    const url = buildArchiveDownloadUrl("bohemian-rhapsody-queen", "Queen - Bohemian Rhapsody.flac");
    expect(url).toBe("https://archive.org/download/bohemian-rhapsody-queen/Queen%20-%20Bohemian%20Rhapsody.flac");
  });

  test("archiveFileMatches matches correct track and rejects wrong track", () => {
    const matchingFile = {
      name: "Queen - Bohemian Rhapsody.flac",
      title: "Bohemian Rhapsody",
      creator: "Queen",
      length: "354",
    };
    expect(archiveFileMatches(trackQueen, matchingFile)).toBe(true);

    const wrongFile = {
      name: "Queen - Another One Bites the Dust.flac",
      title: "Another One Bites the Dust",
      creator: "Queen",
      length: "215",
    };
    expect(archiveFileMatches(trackQueen, wrongFile)).toBe(false);

    const wrongVersion = {
      name: "Queen - Bohemian Rhapsody (Live at Wembley).flac",
      title: "Bohemian Rhapsody (Live at Wembley)",
      creator: "Queen",
      length: "354",
    };
    expect(archiveFileMatches(trackQueen, wrongVersion)).toBe(false);
  });

  test("Test B, C, D, E: album container file matching with track-number prefixes and nested paths", () => {
    // Test C: track-number prefix
    expect(archiveFileMatches(trackScarTissue, {
      name: "03-Scar Tissue.flac",
      length: "217",
    })).toBe(true);

    // Test D: nested path with track-number prefix
    expect(archiveFileMatches(trackScarTissue, {
      name: "californication/03-Scar Tissue.flac",
      length: "217",
    })).toBe(true);

    // Test E: wrong track inside the container must NOT match Scar Tissue
    expect(archiveFileMatches(trackScarTissue, {
      name: "californication/02-Parallel Universe.flac",
      length: "270",
    })).toBe(false);

    // Another track in container
    expect(archiveFileMatches(trackScarTissue, {
      name: "californication/01-Around the World.flac",
      length: "238",
    })).toBe(false);
  });
});

describe("ArchiveOrgDiscoveryProvider and ArchiveOrgResolver unit tests", () => {
  test("searches Archive.org and extracts SourceCandidates with metadata", async () => {
    const provider = new ArchiveOrgDiscoveryProvider(archiveMockFetch as typeof fetch);
    const candidates = await provider.search(trackQueen);

    expect(candidates.length).toBeGreaterThan(0);
    const flacCandidate = candidates.find((c) => c.quality?.codec === "FLAC");
    expect(flacCandidate).toBeDefined();
    expect(flacCandidate?.id).toContain("archiveorg:bohemian-rhapsody-queen:Queen - Bohemian Rhapsody.flac");
    expect(flacCandidate?.title).toBe("Bohemian Rhapsody");
    expect(flacCandidate?.artist).toBe("Queen");
    expect(flacCandidate?.quality?.lossless).toBe(true);
  });

  test("resolves a direct file candidate to PlayableSource without Debrid", async () => {
    const resolver = new ArchiveOrgResolver(archiveMockFetch as typeof fetch);
    expect(resolver.canResolve({ id: "archiveorg:bohemian-rhapsody-queen:Queen - Bohemian Rhapsody.flac", provider: "archive-org-source" })).toBe(true);

    const sources = await resolver.resolve({
      id: "archiveorg:bohemian-rhapsody-queen:Queen - Bohemian Rhapsody.flac",
      provider: "archive-org-source",
      quality: { codec: "FLAC", lossless: true },
    });

    expect(sources.length).toBe(1);
    expect(sources[0]).toMatchObject({
      provider: "plugin",
      type: "external",
      mediaType: "audio",
      label: "Archive.org",
      availability: "available",
      quality: expect.objectContaining({ codec: "FLAC", lossless: true }),
    });
    expect(sources[0].id).toBe("https://archive.org/download/bohemian-rhapsody-queen/Queen%20-%20Bohemian%20Rhapsody.flac");
  });

  test("resolves an album container candidate to only the requested track", async () => {
    const resolver = new ArchiveOrgResolver(archiveMockFetch as typeof fetch);
    const sources = await resolver.resolve(
      {
        id: "archiveorg:queen-a-night-at-the-opera",
        provider: "archive-org-source",
      },
      { target: trackQueen }
    );

    expect(sources.length).toBe(1);
    expect(sources[0].id).toContain("11%20-%20Bohemian%20Rhapsody.flac");
    expect(sources[0].id).not.toContain("01%20-%20Death");
    expect(sources[0].id).not.toContain("02%20-%20Lazing");
  });

  test("Test F: resolves multiple tracks from the same album container individually", async () => {
    const resolver = new ArchiveOrgResolver(archiveMockFetch as typeof fetch);

    // Track 1: Around the World
    const sourcesAroundTheWorld = await resolver.resolve(
      { id: "archiveorg:californication_202408", provider: "archive-org-source" },
      { target: { ...trackScarTissue, title: "Around the World", metadata: { durationSeconds: 238 } } }
    );
    expect(sourcesAroundTheWorld.length).toBe(1);
    expect(sourcesAroundTheWorld[0].id).toContain("01-Around%20the%20World.flac");

    // Track 2: Parallel Universe
    const sourcesParallelUniverse = await resolver.resolve(
      { id: "archiveorg:californication_202408", provider: "archive-org-source" },
      { target: { ...trackScarTissue, title: "Parallel Universe", metadata: { durationSeconds: 270 } } }
    );
    expect(sourcesParallelUniverse.length).toBe(1);
    expect(sourcesParallelUniverse[0].id).toContain("02-Parallel%20Universe.flac");

    // Track 3: Scar Tissue
    const sourcesScarTissue = await resolver.resolve(
      { id: "archiveorg:californication_202408", provider: "archive-org-source" },
      { target: trackScarTissue }
    );
    expect(sourcesScarTissue.length).toBe(1);
    expect(sourcesScarTissue[0].id).toContain("03-Scar%20Tissue.flac");

    // Track 4: Otherside
    const sourcesOtherside = await resolver.resolve(
      { id: "archiveorg:californication_202408", provider: "archive-org-source" },
      { target: { ...trackScarTissue, title: "Otherside", metadata: { durationSeconds: 255 } } }
    );
    expect(sourcesOtherside.length).toBe(1);
    expect(sourcesOtherside[0].id).toContain("04-Otherside.flac");
  });

  test("ArchiveOrgContainerProvider enumerates item files into track candidates", async () => {
    const containerProvider = new ArchiveOrgContainerProvider(archiveMockFetch as typeof fetch);
    const containerCandidate = {
      id: "archiveorg:californication_202408",
      provider: "archive-org-source",
      kind: "album-container" as const,
      metadata: { archiveIdentifier: "californication_202408" },
    };

    expect(containerProvider.canEnumerate(containerCandidate)).toBe(true);

    const candidates = await containerProvider.enumerate(containerCandidate);
    expect(candidates.length).toBe(4);
    expect(candidates.map((c) => c.title)).toEqual([
      "Around the World",
      "Parallel Universe",
      "Scar Tissue",
      "Otherside",
    ]);
    expect(candidates.every((c) => c.kind === "file")).toBe(true);
    expect(candidates.every((c) => c.container?.id === "californication_202408")).toBe(true);
  });

  test("Archive.org API failure is gracefully isolated and does not crash", async () => {
    const failFetch = vi.fn(() => Promise.reject(new Error("Network disconnect"))) as unknown as typeof fetch;
    const provider = new ArchiveOrgDiscoveryProvider(failFetch);
    const candidates = await provider.search(trackQueen);
    expect(candidates).toEqual([]);

    const resolver = new ArchiveOrgResolver(failFetch);
    const sources = await resolver.resolve({ id: "archiveorg:missing-item", provider: "archive-org-source" });
    expect(sources).toEqual([]);
  });
});

describe("Archive.org end-to-end integration tests", () => {
  test("enables Archive.org plugin and registers discovery and resolver in pipeline", async () => {
    const { app, plugins, sourceProviders } = await setup();
    const { cookie, enabled } = await enableArchiveOrg(app);

    expect(enabled.statusCode).toBe(200);
    expect(plugins.get("archive-org-source", true)).toMatchObject({
      status: "enabled",
      capabilities: ["source"],
    });
    expect(sourceProviders.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "archive-org-source", role: "discovery", enabled: true }),
      expect.objectContaining({ id: "archive-org-resolver", role: "resolver", enabled: true }),
      expect.objectContaining({ id: "source-pipeline", enabled: true }),
    ]));
    expect(cookie).toBeTruthy();
  });

  test("discovers Archive.org sources and streams via opaque token", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackQueen },
    });

    expect(resolved.statusCode).toBe(200);
    const payload = resolved.json();
    expect(payload.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Archive.org",
        quality: expect.objectContaining({ codec: "FLAC", lossless: true }),
      }),
    ]));

    // Check that raw internal URLs / credentials are NOT exposed in client response
    expect(JSON.stringify(payload)).not.toContain("archive.org/download");
    expect(JSON.stringify(payload)).not.toContain("advancedsearch.php");

    const source = payload.sources.find((s: any) => s.label === "Archive.org");
    expect(source).toBeDefined();

    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackQueen.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });

  test("discovers and resolves album container track (RHCP - Scar Tissue) end-to-end", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });

    expect(resolved.statusCode).toBe(200);
    const payload = resolved.json();
    expect(payload.sources.length).toBeGreaterThan(0);

    const source = payload.sources.find((s: any) => s.label === "Archive.org");
    expect(source).toBeDefined();
    expect(source.quality).toMatchObject({ codec: "FLAC", lossless: true });

    // Stream the resolved source
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackScarTissue.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });

  test("admin plugin test endpoint returns structured status and candidate details", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);

    const testRes = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/archive-org-source/test",
      headers: { cookie },
    });

    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().test).toMatchObject({
      ok: true,
      status: "success",
      message: expect.stringContaining("Archive.org is reachable"),
      details: expect.objectContaining({
        itemsFound: 1,
        audioFilesFound: 2,
      }),
    });
  });

  test("Archive.org failure does not break other working source providers", async () => {
    // Multi-fetch where Archive.org fails (500) but authorized external source succeeds
    const multiFetch = vi.fn((input: URL | RequestInfo | string) => {
      const url = new URL(String(input));
      if (url.hostname === "archive.org") {
        return Promise.resolve(new Response("Internal error", { status: 500 }));
      }
      if (url.hostname === "authorized.example" && url.pathname === "/v1/sources") {
        return Promise.resolve(new Response(JSON.stringify({
          sources: [
            {
              url: "https://authorized.example/files/queen-bohemian-rhapsody.flac",
              title: "Bohemian Rhapsody",
              artist: "Queen",
              album: "A Night at the Opera",
              codec: "FLAC",
              lossless: true,
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.hostname === "authorized.example" && url.pathname.startsWith("/files/")) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { "content-type": "audio/flac", "content-range": "bytes 0-2/3" },
        }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const { app } = await setup(multiFetch);
    const { cookie } = await enableArchiveOrg(app);

    await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/authorized-external-source",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { baseUrl: "https://authorized.example", accessToken: "valid-token" },
        permissions: ["network.request", "external-source.play"],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackQueen },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "External source", quality: expect.objectContaining({ codec: "FLAC" }) }),
    ]));
  });
});

describe("Archive.org representations and Debrid container resolution (Tests A - I)", () => {
  beforeEach(() => {
    debridFetchCount = 0;
  });

  test("1. Models Archive.org representations correctly", () => {
    // Californication item has both torrent and audio files
    const repCalifornication = extractArchiveRepresentations("californication_202408", METADATA_RESPONSE_CALIFORNICATION);
    expect(repCalifornication.hasTorrent).toBe(true);
    expect(repCalifornication.torrentFile?.name).toBe("californication_202408_archive.torrent");
    expect(repCalifornication.torrentUrl).toBe("https://archive.org/download/californication_202408/californication_202408_archive.torrent");
    expect(repCalifornication.directAudioFiles.length).toBe(4);
    expect(repCalifornication.representations).toEqual(expect.arrayContaining(["direct-file", "torrent", "archive-container", "metadata"]));

    // Queen album item has direct files only (no torrent)
    const repQueen = extractArchiveRepresentations("queen-a-night-at-the-opera", METADATA_RESPONSE_ALBUM);
    expect(repQueen.hasTorrent).toBe(false);
    expect(repQueen.torrentFile).toBeUndefined();
    expect(repQueen.torrentUrl).toBeUndefined();
    expect(repQueen.directAudioFiles.length).toBe(3);
    expect(repQueen.representations).toEqual(expect.arrayContaining(["direct-file", "archive-container", "metadata"]));
    expect(repQueen.representations).not.toContain("torrent");
  });

  test("Test A: Archive item with torrent + direct files prefers Debrid when configured", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: {
        result: trackScarTissue,
        preference: "preferred",
        preferredProvider: "External cloud source",
      },
    });

    expect(resolved.statusCode).toBe(200);
    const body = resolved.json();
    expect(body.sources.length).toBeGreaterThan(0);

    // Both Debrid container resolved source and direct Archive.org source are present
    const debridSource = body.sources.find((s: any) => s.label === "External cloud source");
    const archiveSource = body.sources.find((s: any) => s.label === "Archive.org");
    expect(debridSource).toBeDefined();
    expect(archiveSource).toBeDefined();

    // Selected source is Debrid per preference
    expect(body.selectedSource).toBeDefined();
    expect(body.selectedSource.label).toBe("External cloud source");
  });

  test("Test B: Archive item with direct files only uses direct source fallback", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    // Track from album with direct files only (Queen - Death on Two Legs)
    const trackDeath = {
      ...trackQueen,
      id: "external_itunes_queen_death",
      title: "Death on Two Legs",
    };

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackDeath },
    });

    expect(resolved.statusCode).toBe(200);
    const body = resolved.json();
    expect(body.sources.length).toBeGreaterThan(0);

    // Direct Archive.org FLAC is available and selected
    const archiveSource = body.sources.find((s: any) => s.label === "Archive.org");
    expect(archiveSource).toBeDefined();
    expect(archiveSource.quality.codec).toBe("FLAC");

    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackDeath.id}/stream?playableSource=${archiveSource.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });
    expect(stream.statusCode).toBe(206);
  });

  test("Test C: Torrent/container with multiple tracks selects requested track (Scar Tissue)", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });

    expect(resolved.statusCode).toBe(200);
    const body = resolved.json();
    const debridSource = body.sources.find((s: any) => s.label === "External cloud source");
    expect(debridSource).toBeDefined();

    // Verify the stream URL points to 03-Scar Tissue and not Around the World
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackScarTissue.id}/stream?playableSource=${debridSource.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });
    expect(stream.statusCode).toBe(206);
  });

  test("Test D: Multiple tracks from same album reuse the cached Debrid container job", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const initialFetchCount = debridFetchCount;

    // Track 1: Scar Tissue
    const res1 = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });
    expect(res1.statusCode).toBe(200);
    const fetchCountAfterTrack1 = debridFetchCount;
    expect(fetchCountAfterTrack1).toBe(initialFetchCount + 1);

    // Track 2: Around the World from same Californication album
    const trackAroundTheWorld = {
      ...trackScarTissue,
      id: "external_itunes_rhcp_around_the_world",
      title: "Around the World",
      metadata: { durationSeconds: 238 },
    };
    const res2 = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackAroundTheWorld },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().sources.length).toBeGreaterThan(0);

    // Job was reused: debridFetchCount did NOT increment for Track 2!
    expect(debridFetchCount).toBe(fetchCountAfterTrack1);
  });

  test("Test E: Concurrent requests share the same in-flight container job", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const trackAroundTheWorld = {
      ...trackScarTissue,
      id: "external_itunes_rhcp_around_the_world",
      title: "Around the World",
      metadata: { durationSeconds: 238 },
    };

    const initialFetchCount = debridFetchCount;

    // Resolve Track 1 and Track 2 concurrently
    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/sources",
        headers: { cookie },
        payload: { result: trackScarTissue },
      }),
      app.inject({
        method: "POST",
        url: "/api/sources",
        headers: { cookie },
        payload: { result: trackAroundTheWorld },
      }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.json().sources.length).toBeGreaterThan(0);
    expect(res2.json().sources.length).toBeGreaterThan(0);

    // Exactly one /v1/fetch call was made for both concurrent requests
    expect(debridFetchCount - initialFetchCount).toBe(1);
  });

  test("Test F: Expired playable token is safely rejected after cache expiration", async () => {
    const { app, sourceProviders } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });
    const source = resolved.json().sources[0];
    expect(source).toBeDefined();

    // Stream before expiry works
    const streamValid = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackScarTissue.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });
    expect(streamValid.statusCode).toBe(206);

    // If sourceCache entry is expired
    (sourceProviders as any).sourceCache?.set(source.id, {
      ...((sourceProviders as any).sourceCache?.get(source.id)),
      expiresAt: Date.now() - 1000,
    });

    const streamExpired = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackScarTissue.id}/stream?playableSource=${source.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });
    expect([404, 502]).toContain(streamExpired.statusCode);
  });

  test("Test G: Version distinction prevents selecting live track for studio request", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    // Studio track request
    const resolvedStudio = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });

    const sources = resolvedStudio.json().sources;
    // Internal URL of live version should NOT be selected
    const debridSource = sources.find((s: any) => s.label === "External cloud source");
    expect(debridSource).toBeDefined();

    // Now test a Live version request: RHCP - Scar Tissue (Live in Poland)
    const trackLive = {
      ...trackScarTissue,
      id: "external_itunes_rhcp_scar_tissue_live",
      title: "Scar Tissue (Live in Poland)",
      metadata: { durationSeconds: 245 },
    };

    const resolvedLive = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackLive },
    });

    expect(resolvedLive.statusCode).toBe(200);
    const liveSources = resolvedLive.json().sources;
    expect(liveSources.length).toBeGreaterThan(0);
  });

  test("Test H: Missing container / Debrid failure exposes direct Archive.org fallback", async () => {
    // Custom fetch where Archive.org works but Debrid fails
    const failingDebridFetch = vi.fn((input: URL | RequestInfo | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "debrid.example" && url.pathname === "/v1/fetch") {
        return Promise.resolve(new Response(JSON.stringify({ error: "Debrid service unavailable" }), { status: 503 }));
      }
      return archiveMockFetch(input, init);
    }) as unknown as typeof fetch;

    const { app } = await setup(failingDebridFetch);
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });

    expect(resolved.statusCode).toBe(200);
    const body = resolved.json();
    // Direct Archive.org FLAC is returned despite Debrid container resolution failure
    expect(body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Archive.org", quality: expect.objectContaining({ codec: "FLAC" }) }),
    ]));
  });

  test("Test I: End-to-end /api/sources RHCP - Scar Tissue Californication resolution", async () => {
    const { app } = await setup();
    const { cookie } = await enableArchiveOrg(app);
    await enableDebrid(app);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { cookie },
      payload: { result: trackScarTissue },
    });

    expect(resolved.statusCode).toBe(200);
    const payload = resolved.json();

    // Must not leak internal tokens or magnet/archive URLs to client
    const jsonStr = JSON.stringify(payload);
    expect(jsonStr).not.toContain("debrid-token");
    expect(jsonStr).not.toContain("californication_202408_archive.torrent");
    expect(jsonStr).not.toContain("cdn.example.com");

    const debridSource = payload.sources.find((s: any) => s.label === "External cloud source");
    expect(debridSource).toBeDefined();
    expect(debridSource.quality).toMatchObject({
      codec: "FLAC",
      lossless: true,
      durationSeconds: 217,
    });

    // Stream through opaque token
    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${trackScarTissue.id}/stream?playableSource=${debridSource.id}`,
      headers: { cookie, range: "bytes=0-2" },
    });
    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/flac");
  });
});
