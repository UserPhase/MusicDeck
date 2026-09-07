import { describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";

import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";
import { JellyfinBackend } from "../src/backends/jellyfin/jellyfin-backend.js";
import { ProviderRegistry, type RegisteredProvider } from "../src/backends/registry.js";
import { CatalogService } from "../src/domain/catalog.js";
import { SourceResolver, SourceUnavailableError } from "../src/domain/source-resolver.js";
import { LibraryService } from "../src/domain/library.js";
import { runMigrations } from "../src/db/migrations.js";

// --- HTTP fixtures -------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NAVIDROME_ALBUMS = {
  "subsonic-response": {
    status: "ok",
    albumList2: {
      album: [{ id: "nav-album-1", name: "Nav Album", artist: "Nav Artist", coverArt: "nav-art-1", songCount: 2 }],
    },
  },
};

const NAVIDROME_TRACK = {
  "subsonic-response": {
    status: "ok",
    song: {
      id: "nav-track-1", title: "Nav Track", artistId: "nav-artist-1", artist: "Nav Artist",
      albumId: "nav-album-1", album: "Nav Album", duration: 100, track: 1, coverArt: "nav-art-1",
    },
  },
};

// listTracks() in NavidromeBackend fetches albums then getAlbum per album.
const NAVIDROME_ALBUM_WITH_TRACKS = {
  "subsonic-response": {
    status: "ok",
    album: {
      id: "nav-album-1", name: "Nav Album", artistId: "nav-artist-1", artist: "Nav Artist",
      coverArt: "nav-art-1",
      song: [NAVIDROME_TRACK["subsonic-response"].song],
    },
  },
};

const JELLYFIN_ITEMS = {
  Items: [
    { Id: "jf-album-1", Name: "JF Album", AlbumArtists: [{ Id: "jf-artist-1", Name: "JF Artist" }], ProductionYear: 2001, ChildCount: 3, ImageTags: { Primary: "t" }, Type: "MusicAlbum" },
  ],
};

const JELLYFIN_TRACK = {
  Items: [{
    Id: "jf-track-1", Name: "JF Track", Artists: [{ Name: "JF Artist" }], ArtistItems: [{ Id: "jf-artist-1", Name: "JF Artist" }],
    Album: "JF Album", AlbumId: "jf-album-1", RunTimeTicks: 2000000000, IndexNumber: 2, ImageTags: { Primary: "t" }, Type: "Audio",
  }],
};

function streamResponse(marker: string, status = 200) {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(marker)); c.close(); } }), {
    status,
    headers: { "content-type": "audio/mpeg" },
  });
}

/** Route a mocked fetch to the right provider fixture by URL. */
function makeFetch(handlers: { navidrome?: (url: URL) => Response; jellyfin?: (url: URL) => Response }) {
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const host = url.host;

    if (host.includes("navidrome")) {
      return handlers.navidrome ? handlers.navidrome(url) : jsonResponse({ "subsonic-response": { status: "ok" } });
    }
    return handlers.jellyfin ? handlers.jellyfin(url) : jsonResponse({ Items: [] });
  });
}

function makeStack(options: {
  navidromeFetch?: (url: URL) => Response;
  jellyfinFetch?: (url: URL) => Response;
}) {
  const db = new Database(":memory:");
  runMigrations(db);
  const library = new LibraryService(db);

  const navidrome = new NavidromeBackend(
    { url: "http://navidrome.test", username: "svc", password: "nav-pass" },
    makeFetch({ navidrome: options.navidromeFetch }) as any
  );
  const jellyfin = new JellyfinBackend(
    { url: "http://jellyfin.test", apiKey: "jf-key" },
    makeFetch({ jellyfin: options.jellyfinFetch }) as any
  );

  const providers: RegisteredProvider[] = [
    { connectionId: "conn-nav", type: "navidrome", name: "Navidrome", enabled: true, provider: navidrome },
    { connectionId: "conn-jf", type: "jellyfin", name: "Jellyfin", enabled: true, provider: jellyfin },
  ];
  const registry = new ProviderRegistry(providers);
  const catalog = new CatalogService(registry, library);
  const resolver = new SourceResolver(registry, library);

  return { db, library, registry, catalog, resolver, navidrome, jellyfin };
}

describe("multi-provider registry", () => {
  test("Navidrome and Jellyfin load as independent catalog+stream providers in deterministic order", () => {
    const { registry } = makeStack({});

    const providers = registry.list();
    expect(providers.map((p) => p.type)).toEqual(["navidrome", "jellyfin"]);
    expect(providers.map((p) => p.connectionId)).toEqual(["conn-nav", "conn-jf"]);
    expect(registry.getPrimary().type).toBe("navidrome");
    expect(registry.getByConnectionId("conn-jf")?.type).toBe("jellyfin");

    // Both satisfy the catalog + stream capabilities.
    for (const { provider } of providers) {
      expect(typeof provider.listAlbums).toBe("function");
      expect(typeof provider.fetchStream).toBe("function");
      expect(typeof provider.fetchArtwork).toBe("function");
    }
  });
});

describe("multi-provider catalog fan-out", () => {
  test("returns results from both providers in deterministic order with distinct stable IDs", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: () => jsonResponse(JELLYFIN_ITEMS),
    });

    const result = await catalog.listAlbums();

    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.name)).toEqual(["Nav Album", "JF Album"]);
    expect(result.items.every((item) => item.id.startsWith("md_"))).toBe(true);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
    expect(result.items[0].availability.connectionId).toBe("conn-nav");
    expect(result.items[1].availability.connectionId).toBe("conn-jf");
  });

  test("partial failure keeps successful provider results and flags degraded", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: () => jsonResponse({}, 500),
    });

    const result = await catalog.listAlbums();

    expect(result.degraded).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Nav Album");
    expect(result.items[0].availability).toMatchObject({ state: "degraded", availableSourceCount: 1 });
  });

  test("Jellyfin auth failure does not remove Navidrome results", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: () => jsonResponse({}, 401),
    });

    const result = await catalog.listAlbums();

    expect(result.items).toHaveLength(1);
    expect(result.degraded).toBe(true);
  });

  test("Navidrome failure does not remove Jellyfin results", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => { throw new Error("nav down"); },
      jellyfinFetch: () => jsonResponse(JELLYFIN_ITEMS),
    });

    const result = await catalog.listAlbums();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("JF Album");
  });

  test("both providers failing throws a MusicDeck error without provider internals", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => jsonResponse({}, 500),
      jellyfinFetch: () => jsonResponse({}, 500),
    });

    const failure = await catalog.listAlbums().catch((e) => e);
    expect(failure.message).toBe("All catalog providers are unavailable");
    expect(failure.message).not.toContain("jf-key");
    expect(failure.message).not.toContain("nav-pass");
  });
});

describe("stable MusicDeck IDs across providers", () => {
  test("identical provider ID on two connections maps to distinct MusicDeck IDs", async () => {
    const { catalog } = makeStack({
      navidromeFetch: (url) =>
        url.pathname.includes("getAlbumList")
          ? jsonResponse({ "subsonic-response": { status: "ok", albumList2: { album: [{ id: "shared-123", name: "A" }] } } })
          : jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: () => jsonResponse({ Items: [{ Id: "shared-123", Name: "B", Type: "MusicAlbum" }] }),
    });

    const result = await catalog.listAlbums();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).not.toBe(result.items[1].id);
    expect(result.items.every((item) => item.id.startsWith("md_"))).toBe(true);
  });

  test("repeated reads reuse the same stable mapping", async () => {
    const { catalog } = makeStack({
      navidromeFetch: () => jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: () => jsonResponse(JELLYFIN_ITEMS),
    });

    const first = await catalog.listAlbums();
    const second = await catalog.listAlbums();

    expect(second.items[0].id).toBe(first.items[0].id);
    expect(second.items[1].id).toBe(first.items[1].id);
  });
});

describe("SourceResolver across providers", () => {
  test("resolves a Navidrome-backed track through the Navidrome stream provider", async () => {
    const navFetch = vi.fn(async () => streamResponse("nav"));
    const { catalog, resolver, navidrome } = makeStack({
      navidromeFetch: (url) => {
        if (url.pathname.includes("stream")) {
          return navFetch() as unknown as Response;
        }
        if (url.pathname.includes("getAlbumList")) {
          return jsonResponse(NAVIDROME_ALBUMS);
        }
        return jsonResponse(NAVIDROME_ALBUM_WITH_TRACKS);
      },
      jellyfinFetch: () => jsonResponse({ Items: [] }),
    });

    const tracks = await catalog.listTracks();
    const mdId = tracks.items[0].id;

    const result = await resolver.fetchStream(mdId);

    expect(result.status).toBe(200);
    expect(navidrome).toBeInstanceOf(NavidromeBackend);
  });

  test("falls back from a failing Navidrome source to a Jellyfin source on one MusicDeck item", async () => {
    const { db, library, resolver, navidrome, jellyfin } = makeStack({
      navidromeFetch: () => { throw new Error("nav stream down (svc:nav-pass)"); },
      jellyfinFetch: (url) => url.pathname.includes("/stream") ? streamResponse("jf") : jsonResponse({ Items: [] }),
    });

    // One MusicDeck track with both a Navidrome and a Jellyfin source.
    const mdId = library.ensureId("track", { connectionId: "conn-nav", providerItemId: "nav-track-1" });
    library.addSource(mdId, { connectionId: "conn-jf", providerItemId: "jf-track-1" });

    const result = await resolver.fetchStream(mdId);

    expect(result.status).toBe(200);
    expect(navidrome).toBeInstanceOf(NavidromeBackend);
    expect(jellyfin).toBeInstanceOf(JellyfinBackend);
  });

  test("all sources failing throws a clean MusicDeck error with no credentials", async () => {
    const { library, resolver } = makeStack({
      navidromeFetch: () => { throw new Error("401 u=svc t=secret"); },
      jellyfinFetch: () => { throw new Error("X-Emby-Token jf-key rejected"); },
    });

    const mdId = library.ensureId("track", { connectionId: "conn-nav", providerItemId: "nav-track-1" });
    library.addSource(mdId, { connectionId: "conn-jf", providerItemId: "jf-track-1" });

    const failure = await resolver.fetchStream(mdId).catch((e) => e);

    expect(failure).toBeInstanceOf(SourceUnavailableError);
    expect(String(failure.message)).not.toContain("secret");
    expect(String(failure.message)).not.toContain("jf-key");
  });

  test("unknown MusicDeck ID fails cleanly", async () => {
    const { resolver } = makeStack({});

    await expect(resolver.fetchStream("md_nope")).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});

describe("artwork across providers", () => {
  test("stable artwork identities are connection-scoped and resolve with fallback", async () => {
    const { catalog, resolver, library } = makeStack({
      navidromeFetch: () => jsonResponse(NAVIDROME_ALBUMS),
      jellyfinFetch: (url) => url.pathname.includes("Images") ? streamResponse("img") : jsonResponse(JELLYFIN_ITEMS),
    });

    const albums = await catalog.listAlbums();

    const navArt = albums.items[0].artworkId;
    const jfArt = albums.items[1].artworkId;

    expect(navArt).toMatch(/^mdart_/);
    expect(jfArt).toMatch(/^mdart_/);
    expect(navArt).not.toBe(jfArt);
    expect(library.getSources(navArt!)[0].connectionId).toBe("conn-nav");
    expect(library.getSources(jfArt!)[0].connectionId).toBe("conn-jf");

    const artwork = await resolver.fetchArtwork(jfArt!);
    expect(artwork.status).toBe(200);
  });

  test("artwork falls back to a second source when the first fails", async () => {
    const { library, resolver } = makeStack({
      navidromeFetch: () => { throw new Error("nav art down"); },
      jellyfinFetch: (url) => url.pathname.includes("Images") ? streamResponse("img") : jsonResponse({ Items: [] }),
    });

    const mdArt = library.ensureArtworkId({ connectionId: "conn-nav", providerItemId: "nav-art-1" });
    library.addSource(mdArt, { connectionId: "conn-jf", providerItemId: "jf-art-1" });

    const artwork = await resolver.fetchArtwork(mdArt);
    expect(artwork.status).toBe(200);
  });
});
