import { describe, expect, test, vi } from "vitest";
import type { CatalogService } from "../src/domain/catalog.js";
import { CompositeMetadataService } from "../src/services/CompositeMetadataService.js";
import { DeezerAdapter } from "../src/services/adapters/DeezerAdapter.js";
import { iTunesAdapter } from "../src/services/adapters/iTunesAdapter.js";
import type { MetadataAdapter } from "../src/services/adapters/MetadataAdapter.js";

const empty = { track: [], album: [], artist: [], playlist: [] };

describe("metadata adapters", () => {
  test("normalizes keyless Deezer tracks and iTunes albums", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      const payload = url.hostname === "api.deezer.com"
        ? { data: [{ id: 7, title: "Lost", isrc: "USWB123001", artist: { name: "Linkin Park" }, album: { title: "Meteora", cover_xl: "https://e-cdns-images.dzcdn.net/images/cover/x" } }] }
        : { results: [{ collectionId: 9, collectionName: "Meteora", artistName: "Linkin Park", artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg" }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const track = (await new DeezerAdapter(fetchImpl).searchTracks("Lost"))[0];
    const album = (await new iTunesAdapter(fetchImpl).searchAlbums("Meteora"))[0];
    expect(track.identityHints?.isrc).toBe("USWB123001");
    expect(track.title).toBe("Lost");
    expect(album.id).toBe("external_itunes_album_9");
    expect(album.artist).toBe("Linkin Park");
  });

  test("local search completes without awaiting external adapters", async () => {
    let releaseExternal!: (value: never[]) => void;
    const blocked = new Promise<never[]>((resolve) => { releaseExternal = resolve; });
    const local: MetadataAdapter = {
      name: "local",
      searchTracks: async () => [], searchAlbums: async () => [], getArtistDetails: async () => null,
    };
    const external: MetadataAdapter = {
      name: "external",
      searchTracks: () => blocked, searchAlbums: async () => [], getArtistDetails: async () => null,
    };
    const catalog = {
      listTracks: async () => ({ items: [{ id: "local-1", title: "Lost", artistName: "Linkin Park", identityHints: { isrc: "USWB123001" } }] }),
      listAlbums: async () => ({ items: [{ id: "album-1", name: "Meteora", artistName: "Linkin Park" }] }),
    } as unknown as CatalogService;
    const service = new CompositeMetadataService(local, [external], catalog);
    const externalPromise = service.searchExternal("Lost", ["track"]);
    expect(await service.searchLocal("Lost", ["track"])).toEqual(empty);
    releaseExternal([]);
    expect((await externalPromise).groups.track).toEqual([]);
  });
});
