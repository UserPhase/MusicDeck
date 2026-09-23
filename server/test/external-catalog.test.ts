import { afterEach, describe, expect, test, vi } from "vitest";

import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { DeezerExternalCatalogProvider } from "../src/domain/external-catalog.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

const CREDENTIALS = { clientId: "test-client", clientSecret: "test-secret" };

function artworkResponse(contentType = "image/jpeg") {
  return new Response(new Uint8Array([255, 216, 255]), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function tokenResponse() {
  return Promise.resolve(new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function catalogFetch(input: URL | string) {
  const url = new URL(String(input));

  if (url.hostname === "accounts.spotify.com") {
    return tokenResponse();
  }

  if (url.hostname === "i.scdn.co") {
    return Promise.resolve(artworkResponse());
  }

  if (url.pathname === "/v1/search") {
    return Promise.resolve(new Response(JSON.stringify({
      albums: {
        items: [{
          id: "album0000000000000010",
          name: "External Album",
          artists: [{ name: "External Artist", id: "artist000000000000020" }],
          release_date: "2025-01-01",
          images: [{ url: "https://i.scdn.co/image/album.jpg", width: 640 }],
        }],
      },
      artists: {
        items: [{
          id: "artist000000000000020",
          name: "External Artist",
          images: [{ url: "https://i.scdn.co/image/artist.jpg", width: 640 }],
        }],
      },
      tracks: {
        items: [{
          id: "track0000000000000030",
          name: "External Song",
          artists: [{ name: "External Artist", id: "artist000000000000020" }],
          album: { id: "album0000000000000010", name: "External Album", images: [{ url: "https://i.scdn.co/image/track.jpg", width: 640 }] },
          duration_ms: 180000,
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/v1/albums/album0000000000000010") {
    return Promise.resolve(new Response(JSON.stringify({
      id: "album0000000000000010",
      name: "External Album",
      artists: [{ name: "External Artist", id: "artist000000000000020" }],
      release_date: "2025-01-01",
      genres: ["Alternative"],
      label: "Example Label",
      images: [{ url: "https://i.scdn.co/image/album.jpg", width: 640 }],
      tracks: {
        items: [{
          id: "track0000000000000030",
          name: "External Song",
          artists: [{ name: "External Artist", id: "artist000000000000020" }],
          duration_ms: 180000,
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/v1/artists/artist000000000000020") {
    return Promise.resolve(new Response(JSON.stringify({
      id: "artist000000000000020",
      name: "External Artist",
      images: [{ url: "https://i.scdn.co/image/artist.jpg", width: 640 }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/v1/artists/artist000000000000020/albums") {
    return Promise.resolve(new Response(JSON.stringify({
      items: [{
        id: "album0000000000000010",
        name: "External Album",
        release_date: "2025-01-01",
        images: [{ url: "https://i.scdn.co/image/album.jpg", width: 640 }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  if (url.pathname === "/v1/artists/artist000000000000020/top-tracks") {
    return Promise.resolve(new Response(JSON.stringify({
      tracks: [{
        id: "track0000000000000030",
        name: "External Song",
        artists: [{ name: "External Artist", id: "artist000000000000020" }],
        album: { id: "album0000000000000010", name: "External Album" },
        duration_ms: 180000,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }

  return Promise.resolve(new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

async function setup(enabled = true, fetchImpl: typeof fetch = catalogFetch as typeof fetch) {
  current = await createTestServer(undefined, {}, undefined, fetchImpl);
  current.externalCatalog.configure(enabled, CREDENTIALS);
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
      expect.objectContaining({ id: "external_spotify_album_album0000000000000010", title: "External Album", provider: "external" }),
    ]);
    expect(response.json().results.artist).toEqual([
      expect.objectContaining({ id: "external_spotify_artist_artist000000000000020", title: "External Artist", provider: "external" }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain("scdn.co");
  });

  test("searches Spotify tracks through the same search endpoint", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=external&mode=external",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results.track).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "external_spotify_track_track0000000000000030", title: "External Song", provider: "external" }),
    ]));
  });

  test("serves external album detail and tracks through the same album contract", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const album = await app.inject({
      method: "GET",
      url: "/api/albums/external_spotify_album_album0000000000000010",
      headers: { cookie },
    });
    const tracks = await app.inject({
      method: "GET",
      url: "/api/albums/external_spotify_album_album0000000000000010/tracks",
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
        id: "external_spotify_track_track0000000000000030",
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
      name: "Greatest Hits",
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
      albumName: "Greatest Hits",
      durationSeconds: 180,
      trackNumber: 1,
      artworkId: null,
      artworkUrl: null,
      streamUrl: "/api/tracks/local-track-30/stream",
    };
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [localAlbum]),
      listArtists: vi.fn(async () => [{
        id: "local-artist-20",
        providerId: "local-artist-20",
        name: "External Artist",
        artworkId: null,
        artworkUrl: null,
        albumCount: 1,
      }]),
      getArtistTracks: vi.fn(async () => [localTrack]),
    });
    current = await createTestServer(backend, {}, undefined, catalogFetch as typeof fetch);
    current.externalCatalog.configure(true, CREDENTIALS);
    const { cookie } = await login(current.app);

    const tracks = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_spotify_album_album0000000000000010/tracks",
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
    expect(playableTrackId).not.toBe("external_spotify_track_track0000000000000030");

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
      url: "/api/artists/external_spotify_artist_artist000000000000020",
      headers: { cookie },
    });
    const albums = await app.inject({
      method: "GET",
      url: "/api/artists/external_spotify_artist_artist000000000000020/albums",
      headers: { cookie },
    });

    expect(artist.statusCode).toBe(200);
    expect(artist.json().artist.name).toBe("External Artist");
    expect(artist.json().artist.tracks[0]).toMatchObject({ title: "External Song" });
    expect(albums.json().albums).toEqual([
      expect.objectContaining({ id: "external_spotify_album_album0000000000000010", title: "External Album" }),
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
      if (url.hostname === "i.scdn.co") {
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
      url: "/api/albums/external_spotify_album_album0000000000000010",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(404);
  });

  test("returns 404 gracefully when Spotify credentials are unavailable", async () => {
    current = await createTestServer(undefined, {}, undefined, catalogFetch as typeof fetch);
    current.externalCatalog.configure(true); // enabled but no credentials configured
    const { cookie } = await login(current.app);

    const album = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_spotify_album_album0000000000000010",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(404);
  });

  test("admin search provider enablement synchronizes external catalog state", async () => {
    const { app, externalCatalog } = await setup(false);
    const { cookie } = await login(app);

    // Deezer requires no credentials and is always enabled, so the overall
    // registry is enabled even while Spotify itself is disabled; the
    // Spotify-specific provider state is what the admin toggle controls.
    expect(externalCatalog.isEnabled()).toBe(true);
    expect(externalCatalog.provider.enabled).toBe(false);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/search-providers/spotify",
      headers: { cookie },
      payload: { enabled: true, config: CREDENTIALS },
    });

    expect(enabled.statusCode).toBe(200);
    expect(externalCatalog.provider.enabled).toBe(true);
  });
});

describe("Deezer external artwork", () => {
  function deezerCatalogFetch(input: URL | string) {
    const url = new URL(String(input));

    if (url.hostname === "e-cdns-images.dzcdn.net") {
      return Promise.resolve(artworkResponse());
    }

    if (url.pathname === "/search/track") {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 111,
          title: "Deezer Song",
          artist: { name: "Deezer Artist" },
          album: {
            id: 222,
            title: "Deezer Album",
            cover_medium: "https://e-cdns-images.dzcdn.net/images/cover/track/250x250.jpg",
            cover_big: "https://e-cdns-images.dzcdn.net/images/cover/track/500x500.jpg",
          },
          duration: 210,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === "/search/album") {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 222,
          title: "Deezer Album",
          artist: { name: "Deezer Artist" },
          cover_medium: "https://e-cdns-images.dzcdn.net/images/cover/album/250x250.jpg",
          cover_big: "https://e-cdns-images.dzcdn.net/images/cover/album/500x500.jpg",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === "/search/artist") {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 333,
          name: "Deezer Artist",
          picture_medium: "https://e-cdns-images.dzcdn.net/images/artist/250x250.jpg",
          picture_big: "https://e-cdns-images.dzcdn.net/images/artist/500x500.jpg",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    return Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  test("exposes Deezer track, album, and artist artwork as opaque proxy tokens", async () => {
    current = await createTestServer(undefined, {}, undefined, deezerCatalogFetch as typeof fetch);
    const { cookie } = await login(current.app);

    const search = await current.app.inject({
      method: "GET",
      url: "/api/search?q=deezer",
      headers: { cookie },
    });

    expect(search.statusCode).toBe(200);
    const body = search.json();
    const track = body.results.track.find((item: any) => item.id === "external_deezer_track_111");
    const album = body.results.album.find((item: any) => item.id === "external_deezer_album_222");
    const artist = body.results.artist.find((item: any) => item.id === "external_deezer_artist_333");

    expect(track.artwork).toEqual(expect.objectContaining({ id: expect.any(String), url: expect.stringContaining("/api/artwork/external/") }));
    expect(album.artwork).toEqual(expect.objectContaining({ id: expect.any(String), url: expect.stringContaining("/api/artwork/external/") }));
    expect(artist.artwork).toEqual(expect.objectContaining({ id: expect.any(String), url: expect.stringContaining("/api/artwork/external/") }));
    expect(JSON.stringify(body)).not.toContain("dzcdn.net");
  });

  test("proxies Deezer artwork through the shared external artwork route", async () => {
    current = await createTestServer(undefined, {}, undefined, deezerCatalogFetch as typeof fetch);
    const { cookie } = await login(current.app);

    const search = await current.app.inject({
      method: "GET",
      url: "/api/search?q=deezer",
      headers: { cookie },
    });
    const albumArtworkId = search.json().results.album.find((item: any) => item.id === "external_deezer_album_222").artwork.id;

    const artwork = await current.app.inject({
      method: "GET",
      url: `/api/artwork/external/${encodeURIComponent(albumArtworkId)}`,
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toBe("image/jpeg");
    expect(artwork.headers["cache-control"]).toContain("max-age=300");
  });

  test("rejects Deezer artwork with unsafe content types without affecting Spotify", async () => {
    current = await createTestServer(undefined, {}, undefined, ((input: URL | string) => {
      const url = new URL(String(input));
      if (url.hostname === "e-cdns-images.dzcdn.net") {
        return Promise.resolve(artworkResponse("text/html"));
      }
      return deezerCatalogFetch(url);
    }) as typeof fetch);
    const { cookie } = await login(current.app);

    const search = await current.app.inject({
      method: "GET",
      url: "/api/search?q=deezer",
      headers: { cookie },
    });
    const artworkId = search.json().results.track.find((item: any) => item.id === "external_deezer_track_111").artwork.id;

    const artwork = await current.app.inject({
      method: "GET",
      url: `/api/artwork/external/${encodeURIComponent(artworkId)}`,
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(502);
  });
});

describe("External catalog detail navigation", () => {
  test("paginates a prolific Deezer artist's albums past the initial response", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      let body: unknown = {};
      if (url.pathname === "/artist/7743172") body = { id: 7743172, name: "Besomorph" };
      if (url.pathname === "/artist/7743172/top") body = { data: [] };
      if (url.pathname === "/artist/7743172/albums") body = url.searchParams.get("index") === "100"
        ? { total: 101, data: [{ id: 999, title: "Apologize" }] }
        : { total: 101, data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1, title: index === 37 ? "LSD" : `Release ${index}`,
        })) };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const detail = await new DeezerExternalCatalogProvider(fetchImpl).getArtist("external_deezer_artist_7743172");
    expect(detail?.albums).toHaveLength(101);
    expect(detail?.albums.map((album) => album.title)).toContain("Apologize");
  });

  function deezerDetailFetch(input: URL | string) {
    const url = new URL(String(input));

    if (url.hostname === "e-cdns-images.dzcdn.net") {
      return Promise.resolve(artworkResponse());
    }

    if (url.pathname === "/album/222") {
      return Promise.resolve(new Response(JSON.stringify({
        id: 222,
        title: "Deezer Album",
        artist: { id: 333, name: "Deezer Artist" },
        release_date: "2024-05-01",
        cover_medium: "https://e-cdns-images.dzcdn.net/images/cover/album/250x250.jpg",
        cover_big: "https://e-cdns-images.dzcdn.net/images/cover/album/500x500.jpg",
        genres: { data: [{ name: "Pop" }] },
        label: "Deezer Records",
        tracks: {
          data: [{
            id: 111,
            title: "Deezer Song",
            artist: { id: 333, name: "Deezer Artist" },
            duration: 210,
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === "/artist/333") {
      return Promise.resolve(new Response(JSON.stringify({
        id: 333,
        name: "Deezer Artist",
        picture_medium: "https://e-cdns-images.dzcdn.net/images/artist/250x250.jpg",
        picture_big: "https://e-cdns-images.dzcdn.net/images/artist/500x500.jpg",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === "/artist/333/albums") {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 222,
          title: "Deezer Album",
          release_date: "2024-05-01",
          cover_medium: "https://e-cdns-images.dzcdn.net/images/cover/album/250x250.jpg",
          cover_big: "https://e-cdns-images.dzcdn.net/images/cover/album/500x500.jpg",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === "/artist/333/top") {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 111,
          title: "Deezer Song",
          artist: { id: 333, name: "Deezer Artist" },
          duration: 210,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    return Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  test("serves Deezer album detail with track listing, artwork, and metadata", async () => {
    current = await createTestServer(undefined, {}, undefined, deezerDetailFetch as typeof fetch);
    const { cookie } = await login(current.app);

    const album = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_deezer_album_222",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(200);
    expect(album.json().album).toMatchObject({
      title: "Deezer Album",
      artist: "Deezer Artist",
      genre: "Pop",
      label: "Deezer Records",
    });
    expect(album.json().album.artworkId).toEqual(expect.any(String));
    expect(album.json().album.tracks).toEqual([
      expect.objectContaining({ id: "external_deezer_track_111", title: "Deezer Song", provider: "external" }),
    ]);
  });

  test("serves Deezer artist detail with known albums and tracks even without local downloads", async () => {
    current = await createTestServer(undefined, {}, undefined, deezerDetailFetch as typeof fetch);
    const { cookie } = await login(current.app);

    const artist = await current.app.inject({
      method: "GET",
      url: "/api/artists/external_deezer_artist_333",
      headers: { cookie },
    });
    const albums = await current.app.inject({
      method: "GET",
      url: "/api/artists/external_deezer_artist_333/albums",
      headers: { cookie },
    });

    expect(artist.statusCode).toBe(200);
    expect(artist.json().artist.name).toBe("Deezer Artist");
    expect(artist.json().artist.tracks[0]).toMatchObject({ title: "Deezer Song" });
    expect(albums.json().albums).toEqual([
      expect.objectContaining({ id: "external_deezer_album_222", title: "Deezer Album" }),
    ]);
  });

  test("serves Spotify album/artist detail navigation as a regression baseline alongside Deezer", async () => {
    const { app } = await setup(true);
    const { cookie } = await login(app);

    const album = await app.inject({
      method: "GET",
      url: "/api/albums/external_spotify_album_album0000000000000010",
      headers: { cookie },
    });
    const artist = await app.inject({
      method: "GET",
      url: "/api/artists/external_spotify_artist_artist000000000000020",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(200);
    expect(album.json().album.title).toBe("External Album");
    expect(artist.statusCode).toBe(200);
    expect(artist.json().artist.name).toBe("External Artist");
  });

  test("returns 404 for an unknown Deezer album/artist ID rather than a generic failure", async () => {
    current = await createTestServer(undefined, {}, undefined, deezerDetailFetch as typeof fetch);
    const { cookie } = await login(current.app);

    const album = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_deezer_album_999999",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(404);
  });

  test("does not resolve an external-shaped ID as a local library album/artist ID", async () => {
    current = await createTestServer(undefined, {}, undefined, catalogFetch as typeof fetch);
    const { cookie } = await login(current.app);

    // With no matching local library rows, an external-prefixed ID must not
    // be looked up via the local CatalogService path -- it must always be
    // routed to the external catalog registry, and 404 there since the
    // external providers are disabled/unconfigured in this scenario.
    const album = await current.app.inject({
      method: "GET",
      url: "/api/albums/external_deezer_album_222",
      headers: { cookie },
    });
    const artist = await current.app.inject({
      method: "GET",
      url: "/api/artists/external_spotify_artist_artist000000000000020",
      headers: { cookie },
    });

    expect(album.statusCode).toBe(404);
    expect(artist.statusCode).toBe(404);
    await expect(current.catalog.getAlbum("external_deezer_album_222")).resolves.toBeNull();
  });
});

// Route-level regression coverage for "album/artist pages show the complete
// known catalog, not only locally downloaded tracks" (see catalog-merge.ts
// for the underlying pure-function tests). These exercise the real
// /api/albums and /api/artists routes end-to-end with a mocked local backend
// and a mocked external catalog search/detail response.
describe("Catalog completeness through the album/artist API", () => {
  const CATALOG_ALBUM_ID = "album0000000000000010";
  const CATALOG_ARTIST_ID = "artist000000000000020";
  const CATALOG_ARTIST_NAME = "Queen";
  const CATALOG_ALBUM_NAME = "Greatest Hits I, II & III: The Platinum Collection";

  function catalogTrackItem(id: string, title: string, durationMs = 180000) {
    return {
      id,
      name: title,
      artists: [{ name: CATALOG_ARTIST_NAME, id: CATALOG_ARTIST_ID }],
      album: { id: CATALOG_ALBUM_ID, name: CATALOG_ALBUM_NAME, images: [] },
      duration_ms: durationMs,
    };
  }

  // 12-track catalog album: 3 titles match the local library, 8 are
  // catalog-only (never downloaded), and 1 is a "Live" version of a locally
  // downloaded track's title (must NOT collide with the studio recording).
  const CATALOG_TRACKS = [
    catalogTrackItem("track-local-1", "Bohemian Rhapsody"),
    catalogTrackItem("track-local-2", "We Will Rock You"),
    catalogTrackItem("track-local-3", "We Are the Champions"),
    catalogTrackItem("track-live-1", "Bohemian Rhapsody - Live"),
    catalogTrackItem("track-cat-1", "Somebody to Love"),
    catalogTrackItem("track-cat-2", "Killer Queen"),
    catalogTrackItem("track-cat-3", "Don't Stop Me Now"),
    catalogTrackItem("track-cat-4", "Crazy Little Thing Called Love"),
    catalogTrackItem("track-cat-5", "Under Pressure"),
    catalogTrackItem("track-cat-6", "Radio Ga Ga"),
    catalogTrackItem("track-cat-7", "I Want to Break Free"),
    catalogTrackItem("track-cat-8", "Innuendo"),
  ];

  function completenessFetch(input: URL | string) {
    const url = new URL(String(input));

    if (url.hostname === "accounts.spotify.com") {
      return tokenResponse();
    }

    if (url.pathname === "/v1/search") {
      const query = url.searchParams.get("q") || "";
      const albumMatch = query.includes(CATALOG_ALBUM_NAME);
      const artistMatch = query.includes(CATALOG_ARTIST_NAME);
      return Promise.resolve(new Response(JSON.stringify({
        albums: {
          items: albumMatch
            ? [{
              id: CATALOG_ALBUM_ID,
              name: CATALOG_ALBUM_NAME,
              artists: [{ name: CATALOG_ARTIST_NAME, id: CATALOG_ARTIST_ID }],
              release_date: "1995-01-01",
              images: [],
            }]
            : [],
        },
        artists: {
          items: artistMatch
            ? [{ id: CATALOG_ARTIST_ID, name: CATALOG_ARTIST_NAME, images: [] }]
            : [],
        },
        tracks: { items: [] },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === `/v1/albums/${CATALOG_ALBUM_ID}`) {
      return Promise.resolve(new Response(JSON.stringify({
        id: CATALOG_ALBUM_ID,
        name: CATALOG_ALBUM_NAME,
        artists: [{ name: CATALOG_ARTIST_NAME, id: CATALOG_ARTIST_ID }],
        release_date: "1995-01-01",
        images: [],
        tracks: { items: CATALOG_TRACKS },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === `/v1/artists/${CATALOG_ARTIST_ID}`) {
      return Promise.resolve(new Response(JSON.stringify({
        id: CATALOG_ARTIST_ID,
        name: CATALOG_ARTIST_NAME,
        images: [],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    if (url.pathname === `/v1/artists/${CATALOG_ARTIST_ID}/top-tracks`) {
      return Promise.resolve(new Response(JSON.stringify({ tracks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }

    if (url.pathname === `/v1/artists/${CATALOG_ARTIST_ID}/albums`) {
      return Promise.resolve(new Response(JSON.stringify({
        items: [
          {
            id: CATALOG_ALBUM_ID,
            name: CATALOG_ALBUM_NAME,
            release_date: "1995-01-01",
            images: [],
          },
          {
            // Catalog-only album: no locally downloaded track at all. Must
            // still appear on the artist's album list (zero-local-track
            // album requirement).
            id: "album0000000000000099",
            name: "Innuendo (Deluxe)",
            release_date: "1991-01-01",
            images: [],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }

    return Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  function localTrack(id: string, title: string) {
    return {
      id,
      providerId: id,
      title,
      artistId: "local-artist-queen",
      artistName: CATALOG_ARTIST_NAME,
      albumId: "local-album-greatest-hits",
      albumName: CATALOG_ALBUM_NAME,
      durationSeconds: 180,
      trackNumber: 1,
      artworkId: null,
      artworkUrl: null,
      streamUrl: `/api/tracks/${id}/stream`,
    };
  }

  const LOCAL_TRACKS = [
    localTrack("local-track-1", "Bohemian Rhapsody"),
    localTrack("local-track-2", "We Will Rock You"),
    localTrack("local-track-3", "We Are the Champions"),
  ];

  const LOCAL_ALBUM = {
    id: "local-album-greatest-hits",
    providerId: "local-album-greatest-hits",
    name: CATALOG_ALBUM_NAME,
    artistId: "local-artist-queen",
    artistName: CATALOG_ARTIST_NAME,
    year: 1995,
    artworkId: null,
    artworkUrl: null,
    songCount: 3,
  };

  const LOCAL_ARTIST = {
    id: "local-artist-queen",
    providerId: "local-artist-queen",
    name: CATALOG_ARTIST_NAME,
    artworkId: null,
    artworkUrl: null,
    albumCount: 1,
  };

  function setupCompleteness() {
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [LOCAL_ALBUM]),
      getAlbum: vi.fn(async () => LOCAL_ALBUM),
      getAlbumTracks: vi.fn(async () => LOCAL_TRACKS),
      listArtists: vi.fn(async () => [LOCAL_ARTIST]),
      getArtist: vi.fn(async () => LOCAL_ARTIST),
      getArtistAlbums: vi.fn(async () => [LOCAL_ALBUM]),
      getArtistTracks: vi.fn(async () => LOCAL_TRACKS),
    });
    return backend;
  }

  test("partial album: shows all 12 catalog tracks with only 3 marked locally available", async () => {
    current = await createTestServer(setupCompleteness(), {}, undefined, completenessFetch as typeof fetch);
    current.externalCatalog.configure(true, CREDENTIALS);
    const { cookie } = await login(current.app);

    // Establish the artist's stable MusicDeck ID first (mirrors how the
    // real app always lists artists before viewing an album), since the
    // album's raw artistId only becomes a resolvable stable ID once it has
    // been stamped through a prior read.
    await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });

    const albums = await current.app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
    const albumId = albums.json().albums[0].id;

    const album = await current.app.inject({
      method: "GET",
      url: `/api/albums/${albumId}`,
      headers: { cookie },
    });
    const tracksResponse = await current.app.inject({
      method: "GET",
      url: `/api/albums/${albumId}/tracks`,
      headers: { cookie },
    });

    expect(album.statusCode).toBe(200);
    expect(album.json().album.trackCount).toBe(12); // full catalog tracklist
    expect(album.json().album.localTrackCount).toBe(3);

    const tracks = tracksResponse.json().tracks;
    const localOnly = tracks.filter((t: any) => t.availability?.libraryAvailable);
    const undownloaded = tracks.filter((t: any) => !t.availability?.libraryAvailable);
    expect(localOnly).toHaveLength(3);
    expect(undownloaded.length).toBeGreaterThanOrEqual(9);

    // Live version must remain a distinct, separately undownloaded entry —
    // never collapsed onto the studio recording.
    const liveTrack = tracks.find((t: any) => t.title === "Bohemian Rhapsody - Live");
    expect(liveTrack).toBeTruthy();
    expect(liveTrack.availability?.libraryAvailable).toBeFalsy();
  });

  test("album with zero local tracks still shows the full catalog tracklist", async () => {
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [LOCAL_ALBUM]),
      getAlbum: vi.fn(async () => LOCAL_ALBUM),
      getAlbumTracks: vi.fn(async () => []), // nothing downloaded locally
      listArtists: vi.fn(async () => [LOCAL_ARTIST]),
      getArtist: vi.fn(async () => LOCAL_ARTIST),
      getArtistAlbums: vi.fn(async () => [LOCAL_ALBUM]),
      getArtistTracks: vi.fn(async () => []),
    });
    current = await createTestServer(backend, {}, undefined, completenessFetch as typeof fetch);
    current.externalCatalog.configure(true, CREDENTIALS);
    const { cookie } = await login(current.app);

    const albums = await current.app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
    const albumId = albums.json().albums[0].id;

    const tracksResponse = await current.app.inject({
      method: "GET",
      url: `/api/albums/${albumId}/tracks`,
      headers: { cookie },
    });

    expect(tracksResponse.statusCode).toBe(200);
    expect(tracksResponse.json().tracks.length).toBe(12);
    expect(tracksResponse.json().tracks.every((t: any) => !t.availability?.libraryAvailable)).toBe(true);
  });

  test("local artist albums remain bound to the exact artist ID instead of a name-matched external catalog", async () => {
    current = await createTestServer(setupCompleteness(), {}, undefined, completenessFetch as typeof fetch);
    current.externalCatalog.configure(true, CREDENTIALS);
    const { cookie } = await login(current.app);

    const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;

    const albumsResponse = await current.app.inject({
      method: "GET",
      url: `/api/artists/${artistId}/albums`,
      headers: { cookie },
    });

    expect(albumsResponse.statusCode).toBe(200);
    const albums = albumsResponse.json().albums;
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ name: CATALOG_ALBUM_NAME, artistId });
    expect(albums.some((album: any) => album.name === "Innuendo (Deluxe)")).toBe(false);
  });

  test("artist routes discard same-name-prefix albums and tracks with another artist ID", async () => {
    const backend = createFakeBackend({
      listArtists: vi.fn(async () => [LOCAL_ARTIST]),
      getArtist: vi.fn(async () => LOCAL_ARTIST),
      getArtistAlbums: vi.fn(async () => [
        LOCAL_ALBUM,
        { ...LOCAL_ALBUM, id: "queen-naija-album", name: "Ghetto Fairytales 2", artistId: "queen-naija-id" },
      ]),
      getArtistTracks: vi.fn(async () => [
        ...LOCAL_TRACKS,
        { ...LOCAL_TRACKS[0], id: "queen-naija-song", title: "Roarrr", artistId: "queen-naija-id" },
      ]),
    });
    current = await createTestServer(backend);
    const { cookie } = await login(current.app);
    const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;
    const [albumsResponse, tracksResponse] = await Promise.all([
      current.app.inject({ method: "GET", url: `/api/artists/${artistId}/albums`, headers: { cookie } }),
      current.app.inject({ method: "GET", url: `/api/artists/${artistId}/tracks`, headers: { cookie } }),
    ]);

    expect(albumsResponse.statusCode).toBe(200);
    expect(albumsResponse.json().albums).toEqual([expect.objectContaining({ name: CATALOG_ALBUM_NAME, artistId })]);
    expect(tracksResponse.statusCode).toBe(200);
    expect(tracksResponse.json().tracks).toHaveLength(3);
    expect(tracksResponse.json().tracks.every((track: any) => track.artistId === artistId)).toBe(true);
  });

  test("iTunes artist overview rejects same-name collisions while Deezer supplies portrait separately", async () => {
    const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const deezerFetch = vi.fn((input: URL | string) => {
      const url = new URL(String(input));
      if (url.hostname === "itunes.apple.com" && url.pathname === "/search") return reply({ results: [
        { wrapperType: "collection", collectionId: 101, artistId: 100, artistName: "Queen", collectionName: CATALOG_ALBUM_NAME },
        { wrapperType: "collection", collectionId: 202, artistId: 200, artistName: "Queen", collectionName: "Ghetto Fairytales 2" },
      ] });
      if (url.hostname === "itunes.apple.com" && url.pathname === "/lookup") return reply({ results:
        url.searchParams.get("entity") === "album" ? [
          { wrapperType: "artist", artistId: 100, artistName: "Queen" },
          { wrapperType: "collection", collectionId: 101, artistId: 100, artistName: "Queen", collectionName: CATALOG_ALBUM_NAME },
          { wrapperType: "collection", collectionId: 102, artistId: 100, artistName: "Queen", collectionName: "A Night at the Opera", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/correct/100x100bb.jpg" },
          { wrapperType: "collection", collectionId: 105, artistId: 100, artistName: "GEMS", collectionName: "GLOW With GEMS" },
        ] : [
          { wrapperType: "track", kind: "song", trackId: 103, artistId: 100, artistName: "Queen", trackName: "Bohemian Rhapsody", trackTimeMillis: 180000, collectionName: CATALOG_ALBUM_NAME },
          { wrapperType: "track", kind: "song", trackId: 104, artistId: 100, artistName: "Queen", trackName: "Don't Stop Me Now", trackTimeMillis: 210000, collectionName: "A Night at the Opera" },
          { wrapperType: "track", kind: "song", trackId: 105, artistId: 100, artistName: "GEMS", trackName: "Unrelated Song", trackTimeMillis: 210000, collectionName: "GLOW With GEMS" },
          { wrapperType: "track", kind: "song", trackId: 203, artistId: 200, artistName: "Queen", trackName: "Roarrr", trackTimeMillis: 180000 },
        ] });
      if (url.pathname === "/search/artist") return reply({ data: [
        { id: 200, name: "Queen", picture_xl: "https://cdn-images.dzcdn.net/images/artist/wrong.jpg" },
        { id: 100, name: "Queen", picture_xl: "https://cdn-images.dzcdn.net/images/artist/correct.jpg" },
        { id: 300, name: "Queen Naija", picture_xl: "https://cdn-images.dzcdn.net/images/artist/other.jpg" },
      ] });
      if (url.pathname === "/artist/200") return reply({ id: 200, name: "Queen", picture_xl: "https://cdn-images.dzcdn.net/images/artist/wrong.jpg" });
      if (url.pathname === "/artist/100") return reply({ id: 100, name: "Queen", picture_xl: "https://cdn-images.dzcdn.net/images/artist/correct.jpg" });
      if (url.pathname === "/artist/200/albums") return reply({ data: [
        { id: 202, title: "Ghetto Fairytales 2", artist: { id: 200 }, cover_xl: "https://cdn-images.dzcdn.net/images/cover/wrong.jpg" },
      ] });
      if (url.pathname === "/artist/100/albums") return reply({ data: [
        { id: 101, title: CATALOG_ALBUM_NAME, artist: { id: 100 } },
        { id: 102, title: "A Night at the Opera", artist: { id: 100 }, cover_xl: "https://cdn-images.dzcdn.net/images/cover/correct.jpg" },
        { id: 105, title: "GLOW With GEMS" },
        { id: 202, title: "Ghetto Fairytales 2", artist: { id: 200 } },
      ] });
      if (url.pathname === "/artist/200/top") return reply({ data: [
        { id: 203, title: "Roarrr", duration: 180, artist: { id: 200, name: "Queen" } },
      ] });
      if (url.pathname === "/artist/100/top") return reply({ data: [
        { id: 103, title: "Bohemian Rhapsody", duration: 180, artist: { id: 100, name: "Queen" }, album: { id: 101, title: CATALOG_ALBUM_NAME } },
        { id: 104, title: "Don't Stop Me Now", duration: 210, artist: { id: 100, name: "Queen" }, album: { id: 102, title: "A Night at the Opera" } },
        { id: 105, title: "Unrelated Song", duration: 210, artist: { id: 100, name: "Queen" }, album: { id: 105, title: "GLOW With GEMS" } },
        { id: 203, title: "Roarrr", duration: 180, artist: { id: 200, name: "Queen" } },
      ] });
      return reply({ data: [] });
    });
    current = await createTestServer(setupCompleteness(), {}, undefined, deezerFetch as typeof fetch);
    const { cookie } = await login(current.app);
    const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;
    const overview = await current.app.inject({
      method: "GET", url: `/api/artists/${artistId}/overview`, headers: { cookie },
    });

    expect(overview.statusCode).toBe(200);
    const data = overview.json();
    expect(data.localAlbumCount).toBe(1);
    expect(data.localSongCount).toBe(3);
    expect(data.albums.map((album: any) => album.name || album.title)).toEqual([
      CATALOG_ALBUM_NAME, "A Night at the Opera",
    ]);
    expect(data.albums[1].artistId).toBe(artistId);
    expect(data.topTracks[0].id).toBe(data.tracks[0].id);
    expect(data.topTracks.some((track: any) => track.title === "Don't Stop Me Now")).toBe(true);
    expect(data.topTracks.some((track: any) => track.title === "Roarrr")).toBe(false);
    expect(data.topTracks.some((track: any) => track.title === "Unrelated Song")).toBe(false);
    expect(data.artist.imageUrl).toBeNull();
    const portrait = await current.app.inject({
      method: "GET", url: `/api/artists/${artistId}/portrait`, headers: { cookie },
    });
    const artworkId = portrait.json().imageUrl.split("/").pop();
    expect(current.externalCatalog.getArtwork(artworkId)).toBe("https://cdn-images.dzcdn.net/images/artist/correct.jpg");
    expect(portrait.headers["cache-control"]).toBe("no-store");
    const beforePurge = deezerFetch.mock.calls.length;
    const purge = await current.app.inject({
      method: "POST", url: `/api/artists/${artistId}/portrait/purge`, headers: { cookie },
    });
    expect(purge.statusCode).toBe(200);
    await current.app.inject({ method: "GET", url: `/api/artists/${artistId}/portrait`, headers: { cookie } });
    expect(deezerFetch.mock.calls.length).toBeGreaterThan(beforePurge);
    expect(deezerFetch.mock.calls.filter(([input]) => new URL(String(input)).hostname === "musicbrainz.org")).toHaveLength(0);
  });

  test("local artist overview skips external lookups and shares its snapshot with enrichment", async () => {
    const backend = setupCompleteness();
    const externalFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    current = await createTestServer(backend, {}, undefined, externalFetch as typeof fetch);
    const { cookie } = await login(current.app);
    const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;

    const local = await current.app.inject({
      method: "GET", url: `/api/artists/${artistId}/overview?scope=local`, headers: { cookie },
    });
    expect(local.statusCode).toBe(200);
    expect(local.headers["server-timing"]).toContain("artist-snapshot;dur=");
    expect(local.json()).toMatchObject({
      localAlbumCount: 1, localSongCount: 3, externalEnrichmentAvailable: true,
    });
    expect(local.json().albums).toHaveLength(1);
    expect(externalFetch).not.toHaveBeenCalled();

    const complete = await current.app.inject({
      method: "GET", url: `/api/artists/${artistId}/overview`, headers: { cookie },
    });
    expect(complete.statusCode).toBe(200);
    expect(backend.getArtistTracks).toHaveBeenCalledTimes(1);
    expect(externalFetch).toHaveBeenCalled();
  });

  test("artist overview never sends the full discography to a ten-row page", async () => {
    const fortyTracks = Array.from({ length: 40 }, (_, index) => localTrack(`track-${index}`, `Song ${index}`));
    const artist = { ...LOCAL_ARTIST, songCount: 40 };
    const album = { ...LOCAL_ALBUM, songCount: 40 };
    const backend = createFakeBackend({
      listArtists: vi.fn(async () => [artist]),
      getArtist: vi.fn(async () => artist),
      getArtistAlbums: vi.fn(async () => [album]),
      getArtistTracks: vi.fn(async () => fortyTracks),
    });
    current = await createTestServer(backend);
    const { cookie } = await login(current.app);
    const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;
    const response = await current.app.inject({
      method: "GET", url: `/api/artists/${artistId}/overview?scope=local`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().localSongCount).toBe(40);
    expect(response.json().tracks).toHaveLength(10);
    expect(response.json().topTracks).toHaveLength(10);
  });

  // Regression test for the exact reported bug: with no Spotify credentials
  // configured, only the keyless Deezer provider is enabled. Deezer's
  // `/search` endpoint (unlike Spotify's combined search) only ever returns
  // tracks, so without also querying `/search/album` and `/search/artist`,
  // `findMatchingExternalAlbum`/`findMatchingExternalArtist` never found a
  // match and the album/artist merge silently fell back to local-only data
  // -- i.e. a downloaded track from a 12-track album showed only itself.
  function deezerOnlyFetch(input: URL | string) {
    const url = new URL(String(input));

    if (url.hostname === "api.deezer.com") {
      if (url.pathname === "/search") {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (url.pathname === "/search/album") {
        const query = url.searchParams.get("q") || "";
        return Promise.resolve(new Response(JSON.stringify({
          data: query.includes(CATALOG_ALBUM_NAME)
            ? [{ id: 555, title: CATALOG_ALBUM_NAME, artist: { name: CATALOG_ARTIST_NAME }, release_date: "1995-01-01" }]
            : [],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/search/artist") {
        const query = url.searchParams.get("q") || "";
        return Promise.resolve(new Response(JSON.stringify({
          data: query.includes(CATALOG_ARTIST_NAME) ? [{ id: 666, name: CATALOG_ARTIST_NAME }] : [],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/album/555") {
        return Promise.resolve(new Response(JSON.stringify({
          id: 555,
          title: CATALOG_ALBUM_NAME,
          artist: { id: 666, name: CATALOG_ARTIST_NAME },
          release_date: "1995-01-01",
          tracks: { data: CATALOG_TRACKS.map((t) => ({ id: t.id, title: t.name, artist: { id: 666, name: CATALOG_ARTIST_NAME }, duration: 180 })) },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/artist/666/albums") {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 555, title: CATALOG_ALBUM_NAME, release_date: "1995-01-01" }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
    }

    return Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }

  test("shows the complete catalog for a partial album even with no Spotify credentials configured (Deezer-only)", async () => {
    current = await createTestServer(setupCompleteness(), {}, undefined, deezerOnlyFetch as typeof fetch);
    // Spotify left disabled/unconfigured -- only the always-on Deezer
    // provider is available, matching a fresh install with no credentials.
    const { cookie } = await login(current.app);

    await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const albums = await current.app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
    const albumId = albums.json().albums[0].id;

    const tracksResponse = await current.app.inject({
      method: "GET",
      url: `/api/albums/${albumId}/tracks`,
      headers: { cookie },
    });

    expect(tracksResponse.statusCode).toBe(200);
    const tracks = tracksResponse.json().tracks;
    expect(tracks.length).toBe(12);
    const localOnly = tracks.filter((t: any) => t.availability?.libraryAvailable);
    expect(localOnly).toHaveLength(3);
  });
});
