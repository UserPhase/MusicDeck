import { afterEach, describe, expect, test, vi } from "vitest";

import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

function artworkResponse(contentType = "image/jpeg") {
  return new Response(new Uint8Array([255, 216, 255]), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function catalogFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.hostname === "is1-ssl.mzstatic.com") {
    return Promise.resolve(artworkResponse());
  }

  if (url.pathname === "/search") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [
        {
          wrapperType: "collection",
          collectionId: 10,
          collectionName: "External Album",
          artistId: 20,
          artistName: "External Artist",
          releaseDate: "2025-01-01T00:00:00Z",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/album.jpg",
        },
        {
          wrapperType: "artist",
          artistId: 20,
          artistName: "External Artist",
        },
        {
          wrapperType: "track",
          trackId: 30,
          trackName: "External Song",
          artistId: 20,
          artistName: "External Artist",
          collectionId: 10,
          collectionName: "External Album",
          trackTimeMillis: 180000,
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/track.jpg",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/lookup" && url.searchParams.get("entity") === "song" && url.searchParams.get("id") === "10") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [
        {
          wrapperType: "collection",
          collectionId: 10,
          collectionName: "External Album",
          artistId: 20,
          artistName: "External Artist",
          releaseDate: "2025-01-01T00:00:00Z",
          primaryGenreName: "Alternative",
          copyright: "Example Label",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/album.jpg",
        },
        {
          wrapperType: "track",
          trackId: 30,
          trackName: "External Song",
          artistId: 20,
          artistName: "External Artist",
          collectionId: 10,
          collectionName: "External Album",
          trackTimeMillis: 180000,
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/track.jpg",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/lookup" && url.searchParams.get("id") === "20" && url.searchParams.get("entity") === "album") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [{
        collectionId: 10,
        collectionName: "External Album",
        releaseDate: "2025-01-01T00:00:00Z",
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/album.jpg",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/lookup" && url.searchParams.get("id") === "20" && url.searchParams.get("entity") === "song") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [{
        trackId: 30,
        trackName: "External Song",
        artistId: 20,
        artistName: "External Artist",
        collectionId: 10,
        collectionName: "External Album",
        trackTimeMillis: 180000,
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/track.jpg",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/lookup" && url.searchParams.get("id") === "20") {
    return Promise.resolve(new Response(JSON.stringify({
      results: [{ artistId: 20, artistName: "External Artist" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  return Promise.resolve(new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

async function setup(enabled = true, fetchImpl: typeof fetch = catalogFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, fetchImpl);
  current.externalCatalog.configure(enabled);
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("External catalog", () => {
  test("returns neutral external album and artist search results without provider URLs", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=external&mode=external",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results.album).toEqual([
      expect.objectContaining({ id: "external_itunes_album_10", title: "External Album", provider: "external" }),
    ]);
    expect(response.json().results.artist).toEqual([
      expect.objectContaining({ id: "external_itunes_artist_20", title: "External Artist", provider: "external" }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain("mzstatic.com");
  });

  test("serves external album detail and tracks through the same album contract", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const album = await app.inject({
      method: "GET",
      url: "/api/albums/external_itunes_album_10",
      headers: { cookie },
    });
    const tracks = await app.inject({
      method: "GET",
      url: "/api/albums/external_itunes_album_10/tracks",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(200);
    expect(album.json().album).toMatchObject({
      title: "External Album",
      artist: "External Artist",
      genre: "Alternative",
      label: "Example Label",
    });
    expect(tracks.json().tracks).toEqual([
      expect.objectContaining({
        id: "external_itunes_30",
        title: "External Song",
        provider: "external",
        source: { kind: "external", count: 0 },
      }),
    ]);
  });

  test("uses the playable local track ID after a downloaded external album is refreshed", async () => {
    const localAlbum = {
      id: "local-album-10",
      providerId: "local-album-10",
      name: "External Album",
      artistId: "local-artist-20",
      artistName: "External Artist",
      year: 2025,
      artworkId: null,
      artworkUrl: null,
      songCount: 1,
    };
    const localTrack = {
      id: "local-track-30",
      providerId: "local-track-30",
      title: "External Song",
      artistId: "local-artist-20",
      artistName: "External Artist",
      albumId: "local-album-10",
      albumName: "External Album",
      durationSeconds: 180,
      trackNumber: 1,
      artworkId: null,
      artworkUrl: null,
      streamUrl: "/api/tracks/local-track-30/stream",
    };
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [localAlbum]),
      getAlbumTracks: vi.fn(async () => [localTrack]),
    });
    current = await createTestServer(backend, {}, undefined, catalogFetch as typeof fetch);
    current.externalCatalog.configure(true);
    const { cookie } = await login(current.app);

    const tracks = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_itunes_album_10/tracks",
      headers: { cookie },
    });

    expect(tracks.statusCode).toBe(200);
    expect(tracks.json().tracks).toEqual([
      expect.objectContaining({
        title: "External Song",
        provider: "library",
        source: { kind: "library", count: 1 },
        availability: expect.objectContaining({ libraryAvailable: true }),
      }),
    ]);
    const playableTrackId = tracks.json().tracks[0].id;
    expect(playableTrackId).not.toBe("external_itunes_30");

    const stream = await current.app.inject({
      method: "GET",
      url: `/api/tracks/${encodeURIComponent(playableTrackId)}/stream`,
      headers: { cookie },
    });

    expect(stream.statusCode).toBe(206);
    expect(backend.fetchStream).toHaveBeenCalledWith("local-track-30", undefined);
  });

  test("serves external artist detail, albums, and popular tracks", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const artist = await app.inject({
      method: "GET",
      url: "/api/artists/external_itunes_artist_20",
      headers: { cookie },
    });
    const albums = await app.inject({
      method: "GET",
      url: "/api/artists/external_itunes_artist_20/albums",
      headers: { cookie },
    });

    expect(artist.statusCode).toBe(200);
    expect(artist.json().artist.name).toBe("External Artist");
    expect(artist.json().artist.tracks[0]).toMatchObject({ title: "External Song" });
    expect(albums.json().albums).toEqual([
      expect.objectContaining({ id: "external_itunes_album_10", title: "External Album" }),
    ]);
  });

  test("proxies validated external artwork with controlled caching", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);
    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=external&mode=external",
      headers: { cookie },
    });
    const artworkId = search.json().results.album[0].artwork.id;

    const artwork = await app.inject({
      method: "GET",
      url: `/api/artwork/external/${encodeURIComponent(artworkId)}`,
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toBe("image/jpeg");
    expect(artwork.headers["cache-control"]).toContain("max-age=300");
  });

  test("rejects external artwork with unsafe content types", async () => {
    const { app } = await setup(true, ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.hostname === "is1-ssl.mzstatic.com") {
        return Promise.resolve(artworkResponse("text/html"));
      }
      return catalogFetch(url);
    }) as typeof fetch);
    const { cookie } = await login(app);
    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=external&mode=external",
      headers: { cookie },
    });
    const artworkId = search.json().results.album[0].artwork.id;

    const artwork = await app.inject({
      method: "GET",
      url: `/api/artwork/external/${encodeURIComponent(artworkId)}`,
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(502);
  });

  test("hides external catalog details and artwork when the provider is disabled", async () => {
    const { app } = await setup(false);
    const { cookie } = await login(app);

    const album = await app.inject({
      method: "GET",
      url: "/api/albums/external_itunes_album_10",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(404);
  });

  test("admin search provider enablement synchronizes external catalog state", async () => {
    const { app, externalCatalog } = await setup(false);
    const { cookie } = await login(app);

    expect(externalCatalog.isEnabled()).toBe(false);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/search-providers/itunes",
      headers: { cookie },
      payload: { enabled: true },
    });

    expect(enabled.statusCode).toBe(200);
    expect(externalCatalog.isEnabled()).toBe(true);
  });
});
