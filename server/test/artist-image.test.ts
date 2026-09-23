import { describe, expect, test, vi } from "vitest";
import {
  ArtistImageResolver, verifyArtistImageCandidate, isDedicatedArtistPicture, isNativeArtistPicture,
  type ExternalArtistImageCandidate, type LocalArtistCatalog,
} from "../src/domain/artist-image.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const local: LocalArtistCatalog = {
  artist: { id: "queen-local", name: "Queen" },
  albums: [{ artistId: "queen-local", name: "Sheer Heart Attack" },
    { artistId: "queen-naija-local", name: "Ghetto Fairytales 2" }],
  tracks: [{ artistId: "queen-local", title: "Killer Queen" }],
};
const picture = "https://cdn-images.dzcdn.net/images/artist/queen.jpg";
const candidate: ExternalArtistImageCandidate = {
  providerId: "deezer:100", artistName: "Queen", pictureUrl: picture,
  albumTitles: ["Sheer Heart Attack"], trackTitles: [],
};

describe("artist image verification", () => {
  test("requires an ID-scoped album or track overlap, not just an artist name", () => {
    expect(verifyArtistImageCandidate(local, candidate)).toBe(true);
    expect(verifyArtistImageCandidate(local, { ...candidate, albumTitles: ["Ghetto Fairytales 2"] })).toBe(false);
    expect(verifyArtistImageCandidate(local, { ...candidate, albumTitles: [], trackTitles: ["Killer Queen"] })).toBe(true);
    expect(verifyArtistImageCandidate(local, { ...candidate, artistName: "Queen Naija" })).toBe(false);
  });

  test("rejects album artwork even when titles overlap", () => {
    const cover = "https://cdn-images.dzcdn.net/images/cover/queen.jpg";
    expect(isDedicatedArtistPicture(cover)).toBe(false);
    expect(verifyArtistImageCandidate(local, { ...candidate, pictureUrl: cover })).toBe(false);
    expect(isDedicatedArtistPicture("https://attacker.example/images/artist/queen.jpg")).toBe(false);
    expect(isNativeArtistPicture("https://images.example.test/artists/queen.jpg")).toBe(true);
    expect(isNativeArtistPicture("https://music.example.test/rest/getCoverArt.view?id=album-1")).toBe(false);
    expect(isNativeArtistPicture("https://music.example.test/images/album/queen.jpg")).toBe(false);
  });

  test("accepts a lone exact-name Deezer portrait when release checks are unavailable", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/search/artist") return new Response(JSON.stringify({ data: [
        { id: 100, name: "Queen", picture_big: picture },
      ] }), { status: 200 });
      return new Response("", { status: 404 });
    });
    const result = await new ArtistImageResolver(fetchImpl as typeof fetch).resolve(local);
    expect(result).toMatchObject({ providerId: "deezer:100", kind: "artist", pictureUrl: picture,
      overlapCount: 0 });
    expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).hostname === "itunes.apple.com")).toBe(false);
  });

  test("falls back to a marked iTunes tile only for an ID-scoped matching local album", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.hostname === "api.deezer.com") return new Response("", { status: 404 });
      if (url.pathname === "/search") {
        expect(url.searchParams.get("entity")).toBe("musicArtist");
        return new Response(JSON.stringify({ results: [{ artistId: 100, artistName: "Queen" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [
        { artistId: 100, artistName: "Queen", collectionName: "Ghetto Fairytales 2",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/wrong/100x100bb.jpg" },
        { artistId: 100, artistName: "Queen", collectionName: "Sheer Heart Attack",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/correct/100x100bb.jpg" },
      ] }), { status: 200 });
    });
    const result = await new ArtistImageResolver(fetchImpl as typeof fetch).resolve(local);
    expect(result).toMatchObject({ providerId: "itunes:100", kind: "artist-tile-fallback",
      pictureUrl: "https://is1-ssl.mzstatic.com/image/thumb/correct/1000x1000bb.jpg" });
  });

  test("rejects ambiguous same-name candidates and re-fetches after purge", async () => {
    let ambiguous = true;
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      const data = url.pathname === "/search/artist"
        ? [{ id: 100, name: "Queen", picture_xl: picture },
          ...(ambiguous ? [{ id: 200, name: "Queen", picture_xl: picture }] : [])]
        : url.pathname.endsWith("/albums")
          ? [{ title: "Sheer Heart Attack" }]
          : [{ title: "Killer Queen" }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const resolver = new ArtistImageResolver(fetchImpl as typeof fetch);
    expect(await resolver.resolve(local)).toBeNull();
    const before = fetchImpl.mock.calls.length;
    await resolver.resolve(local);
    expect(fetchImpl).toHaveBeenCalledTimes(before);
    resolver.purgeArtistImageCache(local.artist.id);
    ambiguous = false;
    expect((await resolver.resolve(local))?.providerId).toBe("deezer:100");
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });

  test("serves a native artist-info portrait before contacting external providers", async () => {
    const getArtist = vi.fn(async (_id: string, options?: { includeArtistInfo?: boolean }) => ({
      id: "artist-1", providerId: "artist-1", name: "Artist One",
      artworkId: "art-1", artworkUrl: "/api/artwork/art-1", albumCount: 1,
      imageUrl: options?.includeArtistInfo === false ? null : "https://images.example.test/artists/artist-one.jpg",
    }));
    const externalFetch = vi.fn(async () => { throw new Error("External APIs should not run"); });
    const current = await createTestServer(createFakeBackend({ getArtist }), {}, undefined,
      externalFetch as typeof fetch);
    try {
      const { cookie } = await login(current.app);
      const artists = await current.app.inject({ method: "GET", url: "/api/artists", headers: { cookie } });
      const artistId = artists.json().artists[0].id;
      const portrait = await current.app.inject({ method: "GET",
        url: `/api/artists/${artistId}/portrait`, headers: { cookie } });
      expect(portrait.json()).toMatchObject({
        imageUrl: "https://images.example.test/artists/artist-one.jpg",
        imageSource: "native", imageKind: "artist",
      });
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      await closeTestServer(current.app, current.db);
    }
  });
});
