import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

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

describe("MusicDeck media API", () => {
  test("requires authentication for library endpoints", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/albums" });

    expect(response.statusCode).toBe(401);
  });

  test("serves album, artist, track, search, and random APIs", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    // Establish stable IDs via list reads, then resolve details through them.
    const albums = await app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
    const albumId = albums.json().albums[0].id;
    const artists = await app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
    const artistId = artists.json().artists[0].id;
    const tracks = await app.inject({ method: "GET", url: "/api/tracks", headers: { cookie } });
    const trackId = tracks.json().tracks[0].id;

    for (const url of [
      "/api/albums",
      `/api/albums/${albumId}`,
      `/api/albums/${albumId}/tracks`,
      "/api/artists",
      `/api/artists/${artistId}`,
      `/api/artists/${artistId}/albums`,
      `/api/artists/${artistId}/tracks`,
      "/api/tracks",
      `/api/tracks/${trackId}`,
      "/api/search?q=track&types=artists,albums,tracks",
      "/api/library/random-albums?limit=1",
      "/api/library/random-tracks?limit=1",
      "/api/favorites/tracks",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
    }
  });

  test("playlist endpoints preserve single-track add semantics", async () => {
    const backend = createFakeBackend();
    current = await createTestServer(backend);
    const { cookie } = await login(current.app);

    const created = await current.app.inject({
      method: "POST",
      url: "/api/playlists",
      headers: { cookie },
      payload: { name: "My Playlist" },
    });
    const playlistId = created.json().playlist.id;

    const add = await current.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie },
      payload: { trackId: "track-2" },
    });

    expect(add.statusCode).toBe(200);
    expect(add.json()).toEqual({ added: true });

    // Duplicate add is rejected without duplicating the item.
    const duplicate = await current.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie },
      payload: { trackId: "track-2" },
    });
    expect(duplicate.json()).toEqual({ added: false });

    const remove = await current.app.inject({
      method: "DELETE",
      url: `/api/playlists/${playlistId}/tracks/track-2`,
      headers: { cookie },
    });

    expect(remove.statusCode).toBe(204);

    const detail = await current.app.inject({
      method: "GET",
      url: `/api/playlists/${playlistId}`,
      headers: { cookie },
    });
    expect(detail.json().playlist.tracks.map((t: any) => t.id)).not.toContain("track-2");
  });

  test("search includes bounded MusicDeck-owned playlist results additively", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    await app.inject({
      method: "POST",
      url: "/api/playlists",
      headers: { cookie },
      payload: { name: "Road Trip Mix" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=road&types=playlists",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().playlists).toEqual([
      expect.objectContaining({ name: "Road Trip Mix" }),
    ]);
    expect(response.json().results.playlist).toEqual([
      expect.objectContaining({
        type: "playlist",
        title: "Road Trip Mix",
        provider: "musicdeck",
        source: { kind: "musicdeck", count: 1 },
      }),
    ]);
  });

  test("admins can inspect and configure search providers without private settings", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/search-providers",
      headers: { cookie },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().searchProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "library", enabled: true }),
      expect.objectContaining({ id: "spotify", enabled: false, config: {} }),
    ]));

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/search-providers/spotify",
      headers: { cookie },
      payload: { enabled: true, config: { clientId: "abc", apiKey: "redact-me" } },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().searchProvider).toMatchObject({
      id: "spotify",
      enabled: true,
      config: { clientId: "abc" },
    });
    expect(JSON.stringify(updated.json())).not.toContain("redact-me");
  });

  test("admins can inspect and configure source providers", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/source-providers",
      headers: { cookie },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().sourceProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "library", enabled: true }),
      expect.objectContaining({ id: "itunes-preview", enabled: false }),
    ]));

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/source-providers/itunes-preview",
      headers: { cookie },
      payload: { enabled: true },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().sourceProvider).toMatchObject({
      id: "itunes-preview",
      enabled: true,
      capabilities: expect.objectContaining({ tracks: true, quality: true }),
    });

    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/source-providers/itunes-preview/test",
      headers: { cookie },
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json().test).toMatchObject({ id: "itunes-preview", ok: expect.any(Boolean) });
  });

  test("stream and artwork endpoints are authorized and proxy media headers", async () => {
    const { app, backend } = await setup();
    const denied = await app.inject({ method: "GET", url: "/api/tracks/track-1/stream" });

    expect(denied.statusCode).toBe(401);

    const { cookie } = await login(app);

    // Establish the stable MusicDeck ID via a catalog read, then stream it.
    const tracks = await app.inject({ method: "GET", url: "/api/tracks", headers: { cookie } });
    const mdTrackId = tracks.json().tracks[0].id as string;

    const stream = await app.inject({
      method: "GET",
      url: `/api/tracks/${mdTrackId}/stream`,
      headers: { cookie, range: "bytes=0-2" },
    });

    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-type"]).toContain("audio/mpeg");
    expect(backend.fetchStream).toHaveBeenCalledWith("track-1", "bytes=0-2");

    const artwork = await app.inject({
      method: "GET",
      url: "/api/artwork/art-1",
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toContain("image/jpeg");
  });

  test("artwork route resolves a stable MusicDeck artwork ID", async () => {
    const { app, backend } = await setup();
    const { cookie } = await login(app);

    // Establish a stable artwork identity via a catalog read.
    const albums = await app.inject({ method: "GET", url: "/api/albums", headers: { cookie } });
    const artworkId = albums.json().albums[0].artworkId as string;

    expect(artworkId).toMatch(/^mdart_/);

    const artwork = await app.inject({
      method: "GET",
      url: `/api/artwork/${artworkId}`,
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(200);
    // The provider receives its native artwork ID, not the MusicDeck ID.
    expect(backend.fetchArtwork).toHaveBeenCalledWith("art-1");
  });

  test("unknown MusicDeck artwork ID returns a clean 404", async () => {
    const { app } = await setup();
    const { cookie } = await login(app);

    const artwork = await app.inject({
      method: "GET",
      url: "/api/artwork/mdart_does-not-exist",
      headers: { cookie },
    });

    expect(artwork.statusCode).toBe(404);
  });
});
