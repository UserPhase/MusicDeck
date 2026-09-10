import { afterEach, describe, expect, test, vi } from "vitest";

import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";
import { PlaylistArtworkService } from "../src/domain/playlist-artwork.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import type { Track } from "../src/types.js";

/**
 * Playlist cover art has exactly two modes: the automatic 2x2 collage built
 * from the first four tracks, and user-supplied custom artwork that always
 * overrides it. These tests exercise the whole resolved path — playlist
 * payload, opaque artwork token, and the shared artwork proxy — rather than
 * the renderer in isolation.
 */

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

/** 1x1 PNG used as the custom upload payload. */
const CUSTOM_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function track(id: string, artworkId: string | null): Track {
  return {
    id,
    providerId: id,
    title: `Track ${id}`,
    artistId: null,
    artistName: "Artist",
    albumId: null,
    albumName: "Album",
    durationSeconds: 180,
    trackNumber: null,
    artworkId,
    artworkUrl: artworkId ? `/api/artwork/${artworkId}` : null,
    streamUrl: `/api/tracks/${id}/stream`,
  };
}

/**
 * Backend whose per-track artwork is decided by the test, and whose artwork
 * bytes are unique per provider artwork ID so collage tiles are individually
 * identifiable in the rendered document.
 */
function artworkBackend(artworkByTrack: Map<string, string | null>): MusicBackend {
  return createFakeBackend({
    getTrack: vi.fn(async (id: string) => track(id, artworkByTrack.get(id) ?? null)),
    fetchArtwork: vi.fn(async (providerArtworkId: string) => ({
      body: stream(new Uint8Array(Buffer.from(providerArtworkId))),
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })),
  });
}

function tileFor(providerArtworkId: string) {
  return `data:image/jpeg;base64,${Buffer.from(providerArtworkId).toString("base64")}`;
}

async function setup(artworkByTrack: Map<string, string | null>) {
  current = await createTestServer(artworkBackend(artworkByTrack));
  const { cookie } = await login(current.app);
  return { cookie: cookie as string };
}

/** Register a provider artwork reference and return its stable MusicDeck ID. */
function stableArtworkId(providerArtworkId: string) {
  return current!.library.ensureArtworkId({
    connectionId: "test-connection",
    providerItemId: providerArtworkId,
  });
}

async function createPlaylist(cookie: string, name = "Collage Mix") {
  const response = await current!.app.inject({
    method: "POST",
    url: "/api/playlists",
    headers: { cookie },
    payload: { name },
  });

  return response.json().playlist.id as string;
}

async function addTracks(cookie: string, playlistId: string, trackIds: string[]) {
  for (const trackId of trackIds) {
    await current!.app.inject({
      method: "POST",
      url: `/api/playlists/${playlistId}/tracks`,
      headers: { cookie },
      payload: { trackId },
    });
  }
}

async function readPlaylist(cookie: string, playlistId: string) {
  const response = await current!.app.inject({
    method: "GET",
    url: `/api/playlists/${playlistId}`,
    headers: { cookie },
  });

  return response.json().playlist;
}

async function readArtwork(cookie: string, artworkUrl: string) {
  return current!.app.inject({ method: "GET", url: artworkUrl, headers: { cookie } });
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("Playlist cover art", () => {
  test("builds an automatic 2x2 collage from the first four tracks", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) {
      artworkByTrack.set(id, stableArtworkId(`art-${id}`));
    }

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1", "t-2", "t-3", "t-4", "t-5"]);

    const playlist = await readPlaylist(cookie, playlistId);
    expect(playlist.artworkMode).toBe("collage");
    expect(playlist.artworkId).toMatch(/^mdplart_/);
    expect(playlist.artworkUrl).toBe(`/api/artwork/${playlist.artworkId}`);

    const artwork = await readArtwork(cookie, playlist.artworkUrl);
    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toBe("image/svg+xml");

    const svg = artwork.rawPayload.toString("utf8");
    expect(svg.match(/<image /g)).toHaveLength(4);
    for (const id of ["t-1", "t-2", "t-3", "t-4"]) {
      expect(svg).toContain(tileFor(`art-${id}`));
    }

    // Only the first four tracks contribute; a fifth never appears.
    expect(svg).not.toContain(tileFor("art-t-5"));
  });

  test("falls back gracefully when fewer than four tracks have artwork", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    artworkByTrack.set("t-1", stableArtworkId("art-t-1"));
    artworkByTrack.set("t-2", stableArtworkId("art-t-2"));
    // Third track is known but has no cover art at all.
    artworkByTrack.set("t-3", null);

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1", "t-2", "t-3"]);

    const playlist = await readPlaylist(cookie, playlistId);
    expect(playlist.artworkMode).toBe("collage");

    const artwork = await readArtwork(cookie, playlist.artworkUrl);
    expect(artwork.statusCode).toBe(200);

    const svg = artwork.rawPayload.toString("utf8");
    // The grid stays complete by cycling the artwork that does exist.
    expect(svg.match(/<image /g)).toHaveLength(4);
    expect(svg).toContain(tileFor("art-t-1"));
    expect(svg).toContain(tileFor("art-t-2"));
  });

  test("renders a placeholder instead of failing when no track has artwork", async () => {
    const artworkByTrack = new Map<string, string | null>([["t-1", null]]);
    const { cookie } = await setup(artworkByTrack);

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1"]);

    const playlist = await readPlaylist(cookie, playlistId);
    const artwork = await readArtwork(cookie, playlist.artworkUrl);

    expect(artwork.statusCode).toBe(200);
    expect(artwork.rawPayload.toString("utf8")).not.toContain("<image ");
  });

  test("an empty playlist resolves to no artwork", async () => {
    const { cookie } = await setup(new Map());
    const playlistId = await createPlaylist(cookie, "Empty");

    const playlist = await readPlaylist(cookie, playlistId);
    expect(playlist.artworkId).toBeNull();
    expect(playlist.artworkUrl).toBeNull();
    expect(playlist.artworkMode).toBeNull();
  });

  test("reordering the first four tracks changes the automatic artwork", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    for (const id of ["t-1", "t-2", "t-3", "t-4"]) {
      artworkByTrack.set(id, stableArtworkId(`art-${id}`));
    }

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1", "t-2", "t-3", "t-4"]);

    const before = await readPlaylist(cookie, playlistId);

    const reorder = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/tracks/reorder`,
      headers: { cookie },
      payload: { trackIds: ["t-4", "t-3", "t-2", "t-1"] },
    });
    expect(reorder.statusCode).toBe(200);

    const after = await readPlaylist(cookie, playlistId);
    expect(after.artworkMode).toBe("collage");
    expect(after.artworkId).not.toBe(before.artworkId);

    // The collage still resolves, now led by the newly promoted track.
    const svg = (await readArtwork(cookie, after.artworkUrl)).rawPayload.toString("utf8");
    expect(svg.indexOf(tileFor("art-t-4"))).toBeLessThan(svg.indexOf(tileFor("art-t-1")));
  });

  test("custom artwork overrides the collage and removing it restores the collage", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    artworkByTrack.set("t-1", stableArtworkId("art-t-1"));

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1"]);

    const automatic = await readPlaylist(cookie, playlistId);
    expect(automatic.artworkMode).toBe("collage");

    const upload = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
      payload: { image: `data:image/png;base64,${CUSTOM_PNG}` },
    });

    expect(upload.statusCode).toBe(200);
    const custom = upload.json().playlist;
    expect(custom.artworkMode).toBe("custom");
    expect(custom.artworkId).not.toBe(automatic.artworkId);

    const artwork = await readArtwork(cookie, custom.artworkUrl);
    expect(artwork.statusCode).toBe(200);
    expect(artwork.headers["content-type"]).toBe("image/png");
    expect(artwork.rawPayload.equals(Buffer.from(CUSTOM_PNG, "base64"))).toBe(true);

    const removed = await current!.app.inject({
      method: "DELETE",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
    });

    expect(removed.statusCode).toBe(200);
    expect(removed.json().playlist.artworkMode).toBe("collage");
    expect(removed.json().playlist.artworkId).toBe(automatic.artworkId);
  });

  test("rejects an artwork upload that is not a supported image", async () => {
    const { cookie } = await setup(new Map());
    const playlistId = await createPlaylist(cookie);

    const response = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
      payload: { image: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" },
    });

    expect(response.statusCode).toBe(400);
    expect((await readPlaylist(cookie, playlistId)).artworkMode).toBeNull();
  });

  test("search results expose the same resolved playlist artwork", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    artworkByTrack.set("t-1", stableArtworkId("art-t-1"));

    const playlistId = await createPlaylist(cookie, "Road Trip Mix");
    await addTracks(cookie, playlistId, ["t-1"]);

    const playlist = await readPlaylist(cookie, playlistId);
    const search = await current!.app.inject({
      method: "GET",
      url: "/api/search?q=road&types=playlists",
      headers: { cookie },
    });

    expect(search.json().results.playlist[0].artwork).toEqual({
      id: playlist.artworkId,
      url: playlist.artworkUrl,
    });
  });

  test("artwork requests require authentication", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    artworkByTrack.set("t-1", stableArtworkId("art-t-1"));

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1"]);
    const playlist = await readPlaylist(cookie, playlistId);

    const response = await current!.app.inject({ method: "GET", url: playlist.artworkUrl });
    expect(response.statusCode).toBe(401);
  });

  test("thumbnail requests render at the requested size and fetch smaller tiles", async () => {
    const artworkByTrack = new Map<string, string | null>();
    const { cookie } = await setup(artworkByTrack);

    for (const id of ["t-1", "t-2", "t-3", "t-4"]) {
      artworkByTrack.set(id, stableArtworkId(`art-${id}`));
    }

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1", "t-2", "t-3", "t-4"]);
    const playlist = await readPlaylist(cookie, playlistId);

    const thumbnail = await readArtwork(cookie, `${playlist.artworkUrl}?size=64`);
    expect(thumbnail.statusCode).toBe(200);

    const svg = thumbnail.rawPayload.toString("utf8");
    expect(svg).toContain('width="64" height="64"');
    expect(svg.match(/<image /g)).toHaveLength(4);

    // Tiles are requested from the provider at the quadrant size, so a
    // sidebar thumbnail never pulls full-resolution covers.
    const fetchArtwork = current!.backend.fetchArtwork as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(fetchArtwork.mock.calls.some(([, size]) => size === 32)).toBe(true);

    // An unsupported size is snapped to a supported one rather than honored.
    const odd = await readArtwork(cookie, `${playlist.artworkUrl}?size=99999`);
    expect(odd.rawPayload.toString("utf8")).toContain('width="600" height="600"');

    const full = await readArtwork(cookie, playlist.artworkUrl);
    expect(full.rawPayload.toString("utf8")).toContain('width="600" height="600"');
  });

  test("accepts a multi-megabyte upload and rejects one past the cap", async () => {
    const { cookie } = await setup(new Map([["t-1", null]]));
    const playlistId = await createPlaylist(cookie);

    // Base64 inflates the request by ~33%, so an image well inside the 5 MB
    // cap must not be refused by a transport-level body limit.
    const large = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64");

    const accepted = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
      payload: { image: `data:image/jpeg;base64,${large}` },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().playlist.artworkMode).toBe("custom");

    const oversized = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");

    const rejected = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
      payload: { image: `data:image/jpeg;base64,${oversized}` },
    });

    // Too large is a client error, never a misleading server/plugin failure.
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect(rejected.statusCode).toBeLessThan(500);

    // The previously stored artwork is untouched by the rejected upload.
    expect((await readPlaylist(cookie, playlistId)).artworkMode).toBe("custom");
  });

  test("custom artwork survives a restart and is served unchanged", async () => {
    const artworkByTrack = new Map<string, string | null>([["t-1", null]]);
    const { cookie } = await setup(artworkByTrack);

    const playlistId = await createPlaylist(cookie);
    await addTracks(cookie, playlistId, ["t-1"]);

    const upload = await current!.app.inject({
      method: "PUT",
      url: `/api/playlists/${playlistId}/artwork`,
      headers: { cookie },
      payload: { image: `data:image/webp;base64,${CUSTOM_PNG}` },
    });
    expect(upload.statusCode).toBe(200);

    // Custom artwork lives in MusicDeck's own database, so a new service
    // instance over the same database still resolves it.
    const restarted = new PlaylistArtworkService(current!.db);
    const stored = restarted.getCustom(playlistId);

    expect(stored?.contentType).toBe("image/webp");
    expect(stored?.data.equals(Buffer.from(CUSTOM_PNG, "base64"))).toBe(true);
    expect(restarted.describe(playlistId, ["t-1"])?.artworkMode).toBe("custom");
  });
});
