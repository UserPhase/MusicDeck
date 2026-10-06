import { expect, test, vi } from "vitest";
import { withAlbumArtwork } from "../src/services/media/albumArtwork.js";
import { mapAlbum } from "../src/backends/navidrome/mappers.js";
import { createFakeBackend, createTestServer, closeTestServer, login } from "./helpers.js";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";
import { SqliteImportedArtworkRepository } from "../src/infrastructure/persistence/sqliteImportedArtworkRepository.js";

test("Subsonic album mapper reuses an embedded track cover when root coverArt is absent", () => {
  expect(mapAlbum({ id: "album", name: "Demos", song: [{ id: "no-art" }, { coverArt: "al-track" }] }))
    .toMatchObject({ artworkId: "al-track", artworkUrl: "/api/artwork/al-track" });
  expect(mapAlbum({ id: "album", coverArt: "root", song: [{ coverArt: "child" }] }).artworkId).toBe("root");
});

test("album artwork normalization preserves root art and formats missing child URLs", () => {
  expect(withAlbumArtwork({ artworkId: "root", artworkUrl: null }, [{ artworkId: "child" }]).coverUrl)
    .toBe("/api/artwork/root");
  expect(withAlbumArtwork({ artworkId: null }, [{}, { artwork: { id: "mdart_child", url: "/api/artwork/mdart_child" } }]))
    .toMatchObject({ artworkId: "mdart_child", artworkUrl: "/api/artwork/mdart_child", coverUrl: "/api/artwork/mdart_child" });
  expect(withAlbumArtwork({}, [{ artworkId: "extart_child" }]).coverUrl).toBe("/api/artwork/external/extart_child");
  expect(withAlbumArtwork({}, []).coverUrl).toBeNull();
});

test("root album endpoint returns child artwork as an authenticated MusicDeck URL", async () => {
  const backend = createFakeBackend();
  const sampleAlbum = await backend.getAlbum("album-1");
  const sampleTrack = await backend.getTrack("track-1");
  if (!sampleAlbum || !sampleTrack) throw new Error("Missing fixture");
  backend.getAlbum = vi.fn(async () => ({ ...sampleAlbum, artworkId: null, artworkUrl: null }));
  backend.getAlbumTracks = vi.fn(async () => [{ ...sampleTrack, artworkId: "child-cover", artworkUrl: null }]);
  const { app, db } = await createTestServer(backend);
  try {
    const { cookie } = await login(app);
    const listing = await app.inject({ url: "/api/albums", headers: { cookie } });
    expect(listing.statusCode).toBe(200);
    const albumId = listing.json().albums[0].id;
    const response = await app.inject({ url: `/api/albums/${albumId}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const album = response.json().album;
    expect(album.artworkId).toMatch(/^mdart_/);
    expect(album.coverUrl).toBe(`/api/artwork/${album.artworkId}`);
    expect(album.artworkUrl).toBe(album.coverUrl);
    expect(album.coverUrl).not.toContain("salt");
  } finally { await closeTestServer(app, db); }
});

test("album JSON rejects opaque HTTP 200 placeholder bytes before returning a genuine child cover", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const id = new URL(String(input)).searchParams.get("id");
    return new Response(id === "genuine-child" ? "real-cover" : "blue-vinyl",
      { headers: { "content-type": "image/png" } });
  });

  const navidrome = new NavidromeBackend({ url: "http://navidrome.test", username: "test", password: "test" }, fetchImpl);
  const backend = createFakeBackend();
  const sampleAlbum = await backend.getAlbum("album-1");
  const sampleTrack = await backend.getTrack("track-1");
  if (!sampleAlbum || !sampleTrack) throw new Error("Missing fixture");
  backend.getAlbum = vi.fn(async () => ({ ...sampleAlbum, artworkId: "opaque-root", artworkUrl: "/api/artwork/opaque-root" }));
  backend.getAlbumTracks = vi.fn(async () => [{ ...sampleTrack, artworkId: "genuine-child", artworkUrl: "/api/artwork/genuine-child" }]);
  backend.fetchArtwork = (id, size) => navidrome.fetchArtwork(id, size);
  const { app, db } = await createTestServer(backend);
  try {
    const { cookie } = await login(app);
    const listing = await app.inject({ url: "/api/albums", headers: { cookie } });
    const id = listing.json().albums[0].id;
    const response = await app.inject({ url: `/api/albums/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const album = response.json().album;
    expect(album.unavailableArtworkIds).toHaveLength(1);
    expect(album.artworkId).not.toBe(album.unavailableArtworkIds[0]);
    const rejected = await app.inject({ url: `/api/artwork/${album.unavailableArtworkIds[0]}`, headers: { cookie } });
    expect(rejected.statusCode).toBe(404);
    const image = await app.inject({ url: album.coverUrl, headers: { cookie } });
    expect(image.statusCode).toBe(200);
    expect(image.body).toBe("real-cover");
  } finally { await closeTestServer(app, db); }
});

test("album API returns the stored Spotify cover when root and every child are missing", async () => {
  const backend = createFakeBackend({
    fetchArtwork: vi.fn(async () => ({ status: 404, headers: new Headers(), body: null })),
  });
  const { app, db } = await createTestServer(backend);
  try {
    const repo = new SqliteImportedArtworkRepository(db);
    repo.save("ARTIST ONE", "Album One", "https://i.scdn.co/image/importcover", "spotifyalbum");
    const { cookie } = await login(app);
    const listing = await app.inject({ url: "/api/albums", headers: { cookie } });
    const id = listing.json().albums[0].id;
    const response = await app.inject({ url: `/api/albums/${id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().album).toMatchObject({
      artworkId: null, artworkUrl: "https://i.scdn.co/image/importcover", coverUrl: "https://i.scdn.co/image/importcover",
    });
  } finally { await closeTestServer(app, db); }
});
