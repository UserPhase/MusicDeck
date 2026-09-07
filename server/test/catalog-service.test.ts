import { describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";

import { CatalogService } from "../src/domain/catalog.js";
import { LibraryService } from "../src/domain/library.js";
import { runMigrations } from "../src/db/migrations.js";
import { ProviderRegistry, type RegisteredProvider } from "../src/backends/registry.js";
import type { CatalogProvider } from "../src/backends/catalog-provider.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import type { Album, Artist, Track } from "../src/types.js";
import { createFakeBackend } from "./helpers.js";

function entry(connectionId: string, provider: MusicBackend, name = "Navidrome"): RegisteredProvider {
  return { connectionId, type: "navidrome", name, enabled: true, provider };
}

function makeRegistry(...providers: MusicBackend[]) {
  return new ProviderRegistry(
    providers.map((provider, index) => entry(`conn-${index + 1}`, provider, `Navidrome ${index + 1}`))
  );
}

function makeService(...providers: MusicBackend[]) {
  const db = new Database(":memory:");
  runMigrations(db);
  return new CatalogService(makeRegistry(...providers), new LibraryService(db));
}

function album(id: string, name: string): Album {
  return {
    id, providerId: id, name, artistId: null, artistName: "A",
    year: null, artworkId: null, artworkUrl: null, songCount: 0,
  };
}

function track(id: string, title: string): Track {
  return {
    id, providerId: id, title, artistId: null, artistName: "A",
    albumId: null, albumName: "AL", durationSeconds: null, trackNumber: null,
    artworkId: null, artworkUrl: null, streamUrl: `/api/tracks/${id}/stream`,
  };
}

function artist(id: string, name: string): Artist {
  return {
    id, providerId: id, name, artworkId: null, artworkUrl: null, albumCount: 0,
  };
}

describe("CatalogService single-provider behavior", () => {
  test("list/search/random reads come from the primary provider without a degraded flag", async () => {
    const backend = createFakeBackend();
    const service = makeService(backend);

    const albums = await service.listAlbums();
    const artists = await service.listArtists();
    const tracks = await service.listTracks();
    const search = await service.search("love");
    const randomAlbums = await service.getRandomAlbums(5);
    const randomTracks = await service.getRandomTracks(3);

    expect(albums).toEqual({ items: expect.any(Array), degraded: false });
    expect(albums.items).toHaveLength(1);
    expect(albums.items[0].id).toMatch(/^md_/);
    expect(artists.degraded).toBe(false);
    expect(tracks.degraded).toBe(false);
    expect(search).toMatchObject({ degraded: false });
    expect(search.tracks[0].id).toMatch(/^md_/);
    expect(randomAlbums.degraded).toBe(false);
    expect(randomTracks.degraded).toBe(false);
    expect(backend.search).toHaveBeenCalledWith("love", undefined);
  });

  test("exposes friendly source options for a track mapped to multiple connections", async () => {
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [track("prov-1", "Song")]),
    });
    const service = makeService(backend, createFakeBackend());

    // Map the resulting stable track ID to a second enabled connection.
    const first = await service.listTracks();
    const mdId = first.items[0].id;
    (service as any).library.addSource(mdId, { connectionId: "conn-2", providerItemId: "prov-1-b" });

    const result = await service.listTracks();
    const item = result.items[0];

    expect(item.sources).toEqual([
      { id: "conn-1", name: "Navidrome 1" },
      { id: "conn-2", name: "Navidrome 2" },
    ]);
  });

  test("omits the sources list for a single-source track", async () => {
    const service = makeService(createFakeBackend());

    const result = await service.listTracks();

    expect(result.items[0].sources).toBeUndefined();
  });

  test("detail lookups resolve stable IDs through the primary provider", async () => {
    const backend = createFakeBackend();
    const service = makeService(backend);

    // Establish the mapping via a catalog read, then use the stable ID.
    const albums = await service.listAlbums();
    const mdAlbumId = albums.items[0].id;
    const tracks = await service.listTracks();
    const mdTrackId = tracks.items[0].id;

    const albumDetail = await service.getAlbum(mdAlbumId);
    const trackDetail = await service.getTrack(mdTrackId);

    expect(albumDetail).toMatchObject({ id: mdAlbumId, name: "Album One" });
    expect(trackDetail).toMatchObject({ id: mdTrackId, title: "Track One" });
    expect(backend.getAlbum).toHaveBeenCalledWith("album-1");
    expect(backend.getTrack).toHaveBeenCalledWith("track-1");
  });

  test("propagates a primary detail failure", async () => {
    const backend = createFakeBackend({
      getTrack: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    });
    const service = makeService(backend);

    const tracks = await service.listTracks();
    const mdTrackId = tracks.items[0].id;

    await expect(service.getTrack(mdTrackId)).rejects.toThrow("provider unreachable");
  });

  test("depends on CatalogProvider, not a concrete backend", () => {
    const provider: CatalogProvider = createFakeBackend();
    const service = makeService(provider as MusicBackend);

    expect(service).toBeInstanceOf(CatalogService);
  });
});

describe("CatalogService multi-provider fan-out", () => {
  test("aggregates results from two successful providers in deterministic registry order", async () => {
    const a = createFakeBackend({ listAlbums: vi.fn(async () => [album("a1", "From A")]) });
    const b = createFakeBackend({ listAlbums: vi.fn(async () => [album("b1", "From B")]) });
    const service = makeService(a, b);

    const result = await service.listAlbums();

    expect(result.degraded).toBe(false);
    // Two providers with distinct provider IDs map to two distinct stable IDs.
    expect(result.items.map((item) => item.id)).toHaveLength(2);
    expect(result.items.every((item) => item.id.startsWith("md_"))).toBe(true);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
    expect(result.items.map((item) => item.name)).toEqual(["From A", "From B"]);
    expect(a.listAlbums).toHaveBeenCalled();
    expect(b.listAlbums).toHaveBeenCalled();
  });

  test("preserves duplicate items across providers without deduplication", async () => {
    const shared = track("same-id", "Digital Love");
    const a = createFakeBackend({ listTracks: vi.fn(async () => [shared]) });
    const b = createFakeBackend({ listTracks: vi.fn(async () => [{ ...shared }]) });
    const service = makeService(a, b);

    const result = await service.listTracks();

    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(2);
    // Same provider ID from two connections still yields two distinct stable IDs.
    expect(result.items.every((item) => item.id.startsWith("md_"))).toBe(true);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
  });

  test("returns partial results with degraded flag when one provider fails", async () => {
    const a = createFakeBackend({ listArtists: vi.fn(async () => [artist("ar-1", "Artist One")]) });
    const failing = createFakeBackend({
      listArtists: vi.fn(async () => {
        throw new Error("provider B down");
      }),
    });
    const service = makeService(a, failing);

    const result = await service.listArtists();

    expect(result.degraded).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Artist One");
    expect(result.items[0].id).toMatch(/^md_/);
  });

  test("aggregates search results across providers and flags degradation on partial failure", async () => {
    const a = createFakeBackend({
      search: vi.fn(async () => ({ artists: [artist("a", "A")], albums: [album("a", "A")], tracks: [] })),
    });
    const b = createFakeBackend({
      search: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const service = makeService(a, b);

    const result = await service.search("q");

    expect(result.degraded).toBe(true);
    expect(result.artists).toHaveLength(1);
    expect(result.albums).toHaveLength(1);
    expect(result.tracks).toHaveLength(0);
  });

  test("throws a MusicDeck error when every provider fails", async () => {
    const a = createFakeBackend({
      listTracks: vi.fn(async () => {
        throw new Error("A down");
      }),
    });
    const b = createFakeBackend({
      listTracks: vi.fn(async () => {
        throw new Error("B down");
      }),
    });
    const service = makeService(a, b);

    await expect(service.listTracks()).rejects.toThrow("All catalog providers are unavailable");
  });

  test("does not guess identities for detail lookups across providers", async () => {
    const a = createFakeBackend({ getAlbum: vi.fn(async () => null) });
    const b = createFakeBackend({ getAlbum: vi.fn(async () => album("b1", "From B")) });
    const service = makeService(a, b);

    // A raw provider ID is not a known MusicDeck ID, so it resolves to null
    // without consulting any provider.
    const result = await service.getAlbum("album-1");

    expect(result).toBeNull();
    expect(a.getAlbum).not.toHaveBeenCalled();
    expect(b.getAlbum).not.toHaveBeenCalled();
  });
});

describe("CatalogService availability summary", () => {
  test("single available provider yields available state with full source counts", async () => {
    const service = makeService(createFakeBackend());

    const result = await service.listAlbums();

    expect(result.degraded).toBe(false);
    expect(result.items[0].availability).toEqual({
      state: "available",
      connectionId: "conn-1",
      sourceCount: 1,
      availableSourceCount: 1,
      libraryAvailable: true,
    });
  });

  test("multiple providers each stamp their own connection and report full availability", async () => {
    const a = createFakeBackend({ listAlbums: vi.fn(async () => [album("a1", "From A")]) });
    const b = createFakeBackend({ listAlbums: vi.fn(async () => [album("b1", "From B")]) });
    const service = makeService(a, b);

    const result = await service.listAlbums();

    expect(result.degraded).toBe(false);
    expect(result.items[0].availability).toMatchObject({
      state: "available", connectionId: "conn-1", sourceCount: 2, availableSourceCount: 2, libraryAvailable: true,
    });
    expect(result.items[1].availability).toMatchObject({
      state: "available", connectionId: "conn-2", sourceCount: 2, availableSourceCount: 2, libraryAvailable: true,
    });
  });

  test("a failed provider does not mark successful content unavailable, but reflects degradation", async () => {
    const a = createFakeBackend({ listTracks: vi.fn(async () => [track("t1", "Song")]) });
    const failing = createFakeBackend({
      listTracks: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const service = makeService(a, failing);

    const result = await service.listTracks();

    expect(result.degraded).toBe(true);
    expect(result.items[0].availability).toMatchObject({
      state: "degraded",
      connectionId: "conn-1",
      sourceCount: 2,
      availableSourceCount: 1,
      libraryAvailable: true,
    });
  });

  test("search results carry availability additively without removing fields", async () => {
    const service = makeService(createFakeBackend());

    const result = await service.search("q");

    expect(result.artists[0]).toMatchObject({ name: "Artist One" });
    expect(result.artists[0].id).toMatch(/^md_/);
    expect(result.artists[0].availability.state).toBe("available");
    expect(result.tracks[0]).toMatchObject({ title: "Track One" });
    expect(result.tracks[0].id).toMatch(/^md_/);
    expect(result.tracks[0].availability.connectionId).toBe("conn-1");
  });

  test("availability is provider-agnostic and carries no provider internals", async () => {
    const service = makeService(createFakeBackend());

    const result = await service.listTracks();
    const availability = result.items[0].availability;

    expect(Object.keys(availability).sort()).toEqual(
      ["availableSourceCount", "connectionId", "libraryAvailable", "sourceCount", "state"].sort()
    );
    expect(JSON.stringify(availability)).not.toContain("password");
    expect(JSON.stringify(availability)).not.toContain("navidrome");
  });

  test("no extra provider calls are introduced by availability stamping", async () => {
    const backend = createFakeBackend();
    const service = makeService(backend);

    await service.listTracks();

    expect(backend.listTracks).toHaveBeenCalledTimes(1);
    expect(backend.fetchStream).not.toHaveBeenCalled();
    expect(backend.fetchArtwork).not.toHaveBeenCalled();
  });
});

function trackWithRelations(id: string, albumId: string | null, artistId: string | null): Track {
  return {
    id, providerId: id, title: `Track ${id}`, artistId, artistName: "A",
    albumId, albumName: "AL", durationSeconds: null, trackNumber: null,
    artworkId: null, artworkUrl: null, streamUrl: `/api/tracks/${id}/stream`,
  };
}

describe("CatalogService nested ID normalization", () => {
  test("tracks expose stable MusicDeck albumId and artistId, not provider IDs", async () => {
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [trackWithRelations("prov-track-1", "prov-album-9", "prov-artist-7")]),
    });
    const service = makeService(backend);

    const result = await service.listTracks();
    const item = result.items[0];

    expect(item.id).toMatch(/^md_/);
    expect(item.albumId).toMatch(/^md_/);
    expect(item.artistId).toMatch(/^md_/);
    expect(item.albumId).not.toBe("prov-album-9");
    expect(item.artistId).not.toBe("prov-artist-7");
  });

  test("missing album/artist relationships are preserved as null", async () => {
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [trackWithRelations("prov-track-1", null, null)]),
    });
    const service = makeService(backend);

    const result = await service.listTracks();
    const item = result.items[0];

    expect(item.id).toMatch(/^md_/);
    expect(item.albumId).toBeNull();
    expect(item.artistId).toBeNull();
  });

  test("repeated reads return the same stable nested IDs without duplicate library items", async () => {
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [trackWithRelations("prov-track-1", "prov-album-9", "prov-artist-7")]),
    });
    const service = makeService(backend);

    const first = await service.listTracks();
    const second = await service.listTracks();

    expect(second.items[0].id).toBe(first.items[0].id);
    expect(second.items[0].albumId).toBe(first.items[0].albumId);
    expect(second.items[0].artistId).toBe(first.items[0].artistId);
  });

  test("the same provider album ID on two connections maps to distinct MusicDeck IDs", async () => {
    const a = createFakeBackend({
      listTracks: vi.fn(async () => [trackWithRelations("t-1", "shared-album", "shared-artist")]),
    });
    const b = createFakeBackend({
      listTracks: vi.fn(async () => [trackWithRelations("t-1", "shared-album", "shared-artist")]),
    });
    const service = makeService(a, b);

    const result = await service.listTracks();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].albumId).not.toBe(result.items[1].albumId);
    expect(result.items[0].artistId).not.toBe(result.items[1].artistId);
    expect(result.items[0].id).not.toBe(result.items[1].id);
  });

  test("search tracks normalize nested relationships", async () => {
    const backend = createFakeBackend({
      search: vi.fn(async () => ({
        artists: [], albums: [],
        tracks: [trackWithRelations("prov-track-1", "prov-album-9", "prov-artist-7")],
      })),
    });
    const service = makeService(backend);

    const result = await service.search("q");
    const item = result.tracks[0];

    expect(item.id).toMatch(/^md_/);
    expect(item.albumId).toMatch(/^md_/);
    expect(item.artistId).toMatch(/^md_/);
  });

  test("random tracks normalize nested relationships", async () => {
    const backend = createFakeBackend({
      getRandomTracks: vi.fn(async () => [trackWithRelations("prov-track-1", "prov-album-9", "prov-artist-7")]),
    });
    const service = makeService(backend);

    const result = await service.getRandomTracks(1);
    const item = result.items[0];

    expect(item.albumId).toMatch(/^md_/);
    expect(item.artistId).toMatch(/^md_/);
  });

  test("detail track lookups normalize nested relationships", async () => {
    const consistent = trackWithRelations("prov-track-1", "prov-album-9", "prov-artist-7");
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [consistent]),
      getTrack: vi.fn(async () => consistent),
    });
    const service = makeService(backend);

    // Establish the mapping, then fetch the detail by its stable ID.
    const listed = await service.listTracks();
    const mdTrackId = listed.items[0].id;

    const detail = await service.getTrack(mdTrackId);

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(mdTrackId);
    expect(detail!.albumId).toMatch(/^md_/);
    expect(detail!.artistId).toMatch(/^md_/);
  });
});

describe("CatalogService artwork identity", () => {
  function albumWithArt(id: string, artId: string | null): Album {
    return {
      id, providerId: id, name: `Album ${id}`, artistId: null, artistName: "A",
      year: null, artworkId: artId, artworkUrl: artId ? `/api/artwork/${artId}` : null, songCount: 0,
    };
  }

  test("catalog items expose stable MusicDeck artwork IDs, not provider IDs", async () => {
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [albumWithArt("alb-1", "prov-art-1")]),
    });
    const service = makeService(backend);

    const result = await service.listAlbums();
    const item = result.items[0];

    expect(item.artworkId).toMatch(/^mdart_/);
    expect(item.artworkId).not.toBe("prov-art-1");
    expect(item.artworkUrl).toBe(`/api/artwork/${encodeURIComponent(item.artworkId!)}`);
  });

  test("repeated reads reuse the same artwork identity", async () => {
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [albumWithArt("alb-1", "prov-art-1")]),
    });
    const service = makeService(backend);

    const first = await service.listAlbums();
    const second = await service.listAlbums();

    expect(second.items[0].artworkId).toBe(first.items[0].artworkId);
  });

  test("missing artwork stays null without fabricating an identity", async () => {
    const backend = createFakeBackend({
      listAlbums: vi.fn(async () => [albumWithArt("alb-1", null)]),
    });
    const service = makeService(backend);

    const result = await service.listAlbums();

    expect(result.items[0].artworkId).toBeNull();
    expect(result.items[0].artworkUrl).toBeNull();
  });

  test("identical provider artwork IDs on two connections map to distinct MusicDeck artwork IDs", async () => {
    const a = createFakeBackend({ listAlbums: vi.fn(async () => [albumWithArt("alb-1", "shared-art")]) });
    const b = createFakeBackend({ listAlbums: vi.fn(async () => [albumWithArt("alb-1", "shared-art")]) });
    const service = makeService(a, b);

    const result = await service.listAlbums();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].artworkId).toMatch(/^mdart_/);
    expect(result.items[1].artworkId).toMatch(/^mdart_/);
    expect(result.items[0].artworkId).not.toBe(result.items[1].artworkId);
  });

  test("tracks and artists also expose stable artwork IDs", async () => {
    const backend = createFakeBackend({
      listTracks: vi.fn(async () => [{ ...track("t-1", "T"), artworkId: "prov-art-t", artworkUrl: "/api/artwork/prov-art-t" }]),
      listArtists: vi.fn(async () => [{ ...artist("ar-1", "A"), artworkId: "prov-art-a", artworkUrl: "/api/artwork/prov-art-a" }]),
    });
    const service = makeService(backend);

    const tracks = await service.listTracks();
    const artists = await service.listArtists();

    expect(tracks.items[0].artworkId).toMatch(/^mdart_/);
    expect(artists.items[0].artworkId).toMatch(/^mdart_/);
  });
});
