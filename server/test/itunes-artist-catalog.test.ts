import { describe, expect, test, vi } from "vitest";
import { ExternalArtworkTokenStore } from "../src/domain/external-catalog.js";
import { ItunesArtistCatalog, itunesReleaseKey, upscaleItunesArtwork } from "../src/domain/itunes-artist-catalog.js";
import type { Album, Artist, Track } from "../src/types.js";

const artist: Artist = {
  id: "local-gems", providerId: "gems", name: "GEMS", artworkId: null,
  artworkUrl: null, albumCount: 1,
};
const localAlbums: Album[] = [{
  id: "local-kill", providerId: "kill", name: "Kill the One You Love",
  artistId: artist.id, artistName: artist.name, year: 2015,
  artworkId: null, artworkUrl: null, songCount: 1,
}];
const localTracks: Track[] = [{
  id: "local-x", providerId: "x", title: "X Valentine", artistId: artist.id,
  artistName: artist.name, albumId: "local-kill", albumName: "Kill the One You Love",
  durationSeconds: 180, trackNumber: 1, artworkId: null, artworkUrl: null,
  streamUrl: "/api/tracks/local-x/stream",
}];
const art = "https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg";
const item = (id: number, artistId: number, name: string, title: string) => ({
  wrapperType: "collection", collectionId: id, artistId, artistName: name,
  collectionName: title, artworkUrl100: art, releaseDate: "2020-01-01T00:00:00Z",
  primaryGenreName: "Alternative",
});

function fixture() {
  const fetchImpl = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const results = url.pathname === "/search" ? [
      item(1, 10, "GEMS", "Kill the One You Love"),
      item(9, 99, "GEMS", "GLOW With GEMS"),
    ] : url.searchParams.get("entity") === "album" ? [
      { wrapperType: "artist", artistId: 10 },
      item(1, 10, "GEMS", "Kill the One You Love"),
      item(2, 10, "GEMS", "Medusa"),
      item(3, 10, "GEMS", "Medusa (Deluxe)"),
      item(4, 10, "GEMS", "medusa deluxe"),
      item(5, 10, "GLOW With GEMS", "GLOW With GEMS"),
      item(6, 99, "GEMS", "Wrong artist ID"),
    ] : [{
      wrapperType: "track", kind: "song", artistId: 10, artistName: "GEMS",
      trackId: 7, trackName: "X Valentine", trackTimeMillis: 180000,
      collectionId: 1, collectionName: "Kill the One You Love", artworkUrl100: art,
    }];
    return new Response(JSON.stringify({ results }), { status: 200 });
  });
  return { fetchImpl, catalog: new ItunesArtistCatalog(fetchImpl as typeof fetch, new ExternalArtworkTokenStore()) };
}

describe("ItunesArtistCatalog", () => {
  test("upscales only trusted Apple artwork and keeps editions distinct", () => {
    expect(upscaleItunesArtwork(art)).toContain("1000x1000bb.jpg");
    expect(upscaleItunesArtwork("https://untrusted.example/100x100bb.jpg")).toBeNull();
    expect(itunesReleaseKey("Medusa")).not.toBe(itunesReleaseKey("Medusa (Deluxe)"));
  });

  test("uses a local release anchor and iTunes artist ID to reject collisions", async () => {
    const { catalog, fetchImpl } = fixture();
    const [first, second] = await Promise.all([
      catalog.resolve(artist, localAlbums, localTracks),
      catalog.resolve(artist, localAlbums, localTracks),
    ]);
    expect(first?.albums.map((album) => album.id)).toEqual(second?.albums.map((album) => album.id));
    expect(first?.albums.map((album) => album.title)).toEqual([
      "Kill the One You Love", "Medusa", "Medusa (Deluxe)",
    ]);
    expect(first?.tracks.map((track) => track.title)).toEqual(["X Valentine"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("rejects a same-name catalog without a matching local release", async () => {
    const { catalog, fetchImpl } = fixture();
    await expect(catalog.resolve(artist, [{ ...localAlbums[0], name: "Different release" }], localTracks))
      .resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("opens an iTunes album with upscaled artwork and only its own tracks", async () => {
    const tokens = new ExternalArtworkTokenStore();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [
      item(2, 10, "GEMS", "Medusa"),
      { wrapperType: "track", kind: "song", collectionId: 2, artistId: 10,
        artistName: "GEMS", trackId: 21, trackName: "Medusa", trackTimeMillis: 180000 },
      { wrapperType: "track", kind: "song", collectionId: 3, artistId: 10,
        artistName: "GEMS", trackId: 22, trackName: "Another album" },
    ] }), { status: 200 }));
    const catalog = new ItunesArtistCatalog(fetchImpl as typeof fetch, tokens);
    const detail = await catalog.getAlbum("external_itunes_album_2");
    expect(detail?.tracks.map((track) => track.title)).toEqual(["Medusa"]);
    expect(tokens.get(detail!.artworkId!)).toContain("1000x1000bb.jpg");
    await catalog.getAlbum("external_itunes_album_2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
