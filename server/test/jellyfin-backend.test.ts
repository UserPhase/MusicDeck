import { describe, expect, test, vi } from "vitest";

import { JellyfinBackend, JellyfinNotFoundError } from "../src/backends/jellyfin/jellyfin-backend.js";
import { mapJellyfinAlbum, mapJellyfinArtist, mapJellyfinTrack } from "../src/backends/jellyfin/jellyfin-mapper.js";
import { createProvider } from "../src/backends/factory.js";
import { loadConfig } from "../src/config.js";

const CONFIG = { url: "http://jellyfin.test", apiKey: "test-api-key" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeBackend(fetchImpl: (url: any, init?: any) => Promise<Response>) {
  return new JellyfinBackend(CONFIG, fetchImpl as any);
}

const trackFixture = {
  Id: "jf-track-1",
  Name: "Digital Love",
  Artists: [{ Name: "Daft Punk" }],
  ArtistItems: [{ Id: "jf-artist-1", Name: "Daft Punk" }],
  Album: "Discovery",
  AlbumId: "jf-album-1",
  AlbumArtists: [{ Id: "jf-artist-1", Name: "Daft Punk" }],
  RunTimeTicks: 3010000000,
  IndexNumber: 3,
  ImageTags: { Primary: "tag" },
  Type: "Audio",
};

describe("Jellyfin mapper", () => {
  test("maps a track with duration conversion and artwork-by-item-id", () => {
    const track = mapJellyfinTrack(trackFixture);

    expect(track).toMatchObject({
      id: "jf-track-1",
      providerId: "jf-track-1",
      title: "Digital Love",
      artistId: "jf-artist-1",
      artistName: "Daft Punk",
      albumId: "jf-album-1",
      albumName: "Discovery",
      durationSeconds: 301,
      trackNumber: 3,
      artworkId: "jf-track-1",
    });
    expect(track.artworkUrl).toBe(`/api/artwork/${encodeURIComponent("jf-track-1")}`);
  });

  test("collapses multiple artists into a single display name", () => {
    const track = mapJellyfinTrack({
      ...trackFixture,
      Artists: [{ Name: "A" }, { Name: "B" }],
    });

    expect(track.artistName).toBe("A, B");
  });

  test("missing artwork yields null artworkId/artworkUrl", () => {
    const track = mapJellyfinTrack({ ...trackFixture, ImageTags: undefined });

    expect(track.artworkId).toBeNull();
    expect(track.artworkUrl).toBeNull();
  });

  test("missing duration and track number become null", () => {
    const track = mapJellyfinTrack({ ...trackFixture, RunTimeTicks: undefined, IndexNumber: undefined });

    expect(track.durationSeconds).toBeNull();
    expect(track.trackNumber).toBeNull();
  });

  test("maps an album with year and child count", () => {
    const album = mapJellyfinAlbum({
      Id: "jf-album-1",
      Name: "Discovery",
      AlbumArtists: [{ Id: "jf-artist-1", Name: "Daft Punk" }],
      ProductionYear: 2001,
      ChildCount: 14,
      ImageTags: { Primary: "tag" },
    });

    expect(album).toMatchObject({
      id: "jf-album-1",
      name: "Discovery",
      artistName: "Daft Punk",
      year: 2001,
      songCount: 14,
      artworkId: "jf-album-1",
    });
  });

  test("maps an artist", () => {
    const artist = mapJellyfinArtist({ Id: "jf-artist-1", Name: "Daft Punk", ImageTags: { Primary: "tag" } });

    expect(artist).toMatchObject({ id: "jf-artist-1", name: "Daft Punk", artworkId: "jf-artist-1" });
  });
});

describe("JellyfinBackend requests", () => {
  test("sends X-Emby-Token header and never places the key in the URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await backend.listAlbums();

    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(String(url)).not.toContain("test-api-key");
    expect(init.headers["X-Emby-Token"]).toBe("test-api-key");
  });

  test("constructs catalog list requests with type filters", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await backend.listAlbums(50);

    const url = String((fetchImpl.mock.calls[0] as any[])[0]);
    expect(url).toContain("IncludeItemTypes=MusicAlbum");
    expect(url).toContain("Limit=50");
  });

  test("constructs album-track requests scoped by ParentId", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await backend.getAlbumTracks("jf-album-1");

    const url = String((fetchImpl.mock.calls[0] as any[])[0]);
    expect(url).toContain("ParentId=jf-album-1");
    expect(url).toContain("IncludeItemTypes=Audio");
  });

  test("constructs search requests honoring the types filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await backend.search("love", ["tracks"]);

    const url = String((fetchImpl.mock.calls[0] as any[])[0]);
    expect(url).toContain("searchTerm=love");
    expect(url).toContain("IncludeItemTypes=Audio");
    expect(url).not.toContain("MusicAlbum");
  });

  test("constructs random requests with server-side random sort", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await backend.getRandomAlbums(8);

    const url = String((fetchImpl.mock.calls[0] as any[])[0]);
    expect(url).toContain("SortBy=Random");
    expect(url).toContain("Limit=8");
  });

  test("maps a search result into typed buckets", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      Items: [
        { ...trackFixture, Type: "Audio" },
        { Id: "jf-album-1", Name: "Discovery", Type: "MusicAlbum" },
        { Id: "jf-artist-1", Name: "Daft Punk", Type: "MusicArtist" },
      ],
    }));
    const backend = makeBackend(fetchImpl);

    const result = await backend.search("love");

    expect(result.tracks[0]).toMatchObject({ id: "jf-track-1", title: "Digital Love" });
    expect(result.albums[0]).toMatchObject({ id: "jf-album-1", name: "Discovery" });
    expect(result.artists[0]).toMatchObject({ id: "jf-artist-1", name: "Daft Punk" });
  });

  test("returns null for a missing track", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const backend = makeBackend(fetchImpl);

    await expect(backend.getTrack("missing")).resolves.toBeNull();
  });

  test("streams with direct play and forwards the Range header", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 206,
      headers: { "content-type": "audio/flac", "content-range": "bytes 0-0/1" },
    }));
    const backend = makeBackend(fetchImpl);

    const result = await backend.fetchStream("jf-track-1", "bytes=0-0");

    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(String(url)).toContain("/Audio/jf-track-1/stream");
    expect(String(url)).toContain("static=true");
    expect(String(url)).not.toContain("test-api-key");
    expect(init.headers.Range).toBe("bytes=0-0");
    expect(init.headers["X-Emby-Token"]).toBe("test-api-key");
    expect(result.status).toBe(206);
    expect(result.headers.get("content-type")).toContain("audio/flac");
  });

  test("fetches artwork by item ID with auth header", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const backend = makeBackend(fetchImpl);

    await backend.fetchArtwork("jf-track-1");

    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(String(url)).toContain("/Items/jf-track-1/Images/Primary");
    expect(String(url)).not.toContain("test-api-key");
    expect(init.headers["X-Emby-Token"]).toBe("test-api-key");
  });

  test("maps 401 to a MusicDeck auth error without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const backend = makeBackend(fetchImpl);

    const failure = await backend.listAlbums().catch((e) => e);
    expect(failure.message).toBe("Jellyfin authentication failed");
    expect(failure.message).not.toContain("test-api-key");
  });

  test("maps 404 to a not-found error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const backend = makeBackend(fetchImpl);

    await expect(backend.getTrack("x")).rejects.toBeInstanceOf(JellyfinNotFoundError);
  });

  test("maps non-2xx to a status error and malformed JSON to a parse error", async () => {
    const failing = makeBackend(vi.fn(async () => jsonResponse({}, 500)));
    await expect(failing.listAlbums()).rejects.toThrow("Jellyfin returned 500");

    const malformed = makeBackend(vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(malformed.listAlbums()).rejects.toThrow("Jellyfin returned invalid JSON");
  });
});

describe("factory", () => {
  test("creates a JellyfinBackend for type jellyfin", () => {
    const config = loadConfig({
      sessionSecret: "test-secret",
      firstAdmin: { username: "admin", password: "admin-password" },
    });

    const provider = createProvider("jellyfin", { url: "http://jellyfin.test", apiKey: "k" }, config);

    expect(provider).toBeInstanceOf(JellyfinBackend);
  });

  test("Navidrome creation remains unchanged", () => {
    const config = loadConfig({
      sessionSecret: "test-secret",
      firstAdmin: { username: "admin", password: "admin-password" },
      navidrome: { url: "http://navidrome.test", username: "u", password: "p" },
    });

    const provider = createProvider("navidrome", {}, config);

    expect(provider.constructor.name).toBe("NavidromeBackend");
  });
});
