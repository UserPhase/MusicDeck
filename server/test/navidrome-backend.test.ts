import { describe, expect, test, vi } from "vitest";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("NavidromeBackend", () => {
  test("loads artist metadata, albums, and ten ID-scoped top songs without album fan-out", async () => {
    const fetchImpl = vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      const endpoint = url.pathname;
      if (endpoint.endsWith("/getArtist.view")) return jsonResponse({ "subsonic-response": { status: "ok", artist: {
        id: "queen-id", name: "Queen", songCount: 42,
        album: [{ id: "album-1", artistId: "queen-id", songCount: 42 }],
      } } });
      if (endpoint.endsWith("/getArtistInfo2.view")) return jsonResponse({ "subsonic-response": { status: "ok", artistInfo2: {} } });
      if (endpoint.endsWith("/getTopSongs.view")) return jsonResponse({ "subsonic-response": { status: "ok", topSongs: {
        song: [
          { id: "queen-song", title: "Queen Song", artistId: "queen-id" },
          { id: "collision", title: "Not Queen", artistId: "queen-naija-id" },
        ],
      } } });
      throw new Error(`Unexpected artist-page request: ${endpoint}`);
    });
    const backend = new NavidromeBackend({ url: "http://navidrome.test", username: "listener", password: "secret" }, fetchImpl as any);
    const [artist, albums, tracks] = await Promise.all([
      backend.getArtist("queen-id"), backend.getArtistAlbums("queen-id"), backend.getArtistTopTracks("queen-id", 10),
    ]);
    expect(artist?.songCount).toBe(42);
    expect(albums).toHaveLength(1);
    expect(tracks.map((track) => track.id)).toEqual(["queen-song"]);
    const urls = (fetchImpl.mock.calls as unknown[][]).map(([input]) => new URL(String(input)));
    expect(urls.filter((url) => url.pathname.endsWith("/getArtist.view"))).toHaveLength(1);
    expect(urls.filter((url) => url.pathname.endsWith("/getAlbum.view"))).toHaveLength(0);
    expect(urls.find((url) => url.pathname.endsWith("/getTopSongs.view"))?.searchParams.get("count")).toBe("10");
    expect(urls.find((url) => url.pathname.endsWith("/getTopSongs.view"))?.searchParams.get("id")).toBe("queen-id");
  });

  test("uses a bounded, ID-filtered search when optional top songs are unavailable", async () => {
    const fetchImpl = vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/getTopSongs.view")) return jsonResponse({ "subsonic-response": { status: "ok", topSongs: { song: [] } } });
      if (url.pathname.endsWith("/getArtist.view")) return jsonResponse({ "subsonic-response": { status: "ok", artist: { id: "gems-id", name: "GEMS" } } });
      if (url.pathname.endsWith("/search3.view")) return jsonResponse({ "subsonic-response": { status: "ok", searchResult3: {
        song: [
          { id: "correct", title: "Medusa", artistId: "gems-id" },
          { id: "collision", title: "GLOW With GEMS", artistId: "another-id" },
        ],
      } } });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const backend = new NavidromeBackend({ url: "http://navidrome.test", username: "listener", password: "secret" }, fetchImpl as any);
    expect((await backend.getArtistTopTracks("gems-id", 10)).map((track) => track.id)).toEqual(["correct"]);
    const urls = (fetchImpl.mock.calls as unknown[][]).map(([input]) => new URL(String(input)));
    expect(urls.find((url) => url.pathname.endsWith("/search3.view"))?.searchParams.get("songCount")).toBe("10");
    expect(urls.some((url) => url.pathname.endsWith("/getAlbum.view"))).toBe(false);
  });

  test("uses the artist profile image and excludes tracks credited to another artist", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("/getArtist.view")) {
        return jsonResponse({ "subsonic-response": { status: "ok", artist: {
          id: "queen-id", name: "Queen", coverArt: "album-cover",
          album: [{ id: "queen-album", name: "Queen Album", artistId: "queen-id" }],
        } } });
      }
      if (endpoint.endsWith("/getArtistInfo2.view")) {
        return jsonResponse({ "subsonic-response": { status: "ok", artistInfo2: {
          largeImageUrl: "https://images.example.test/queen-artist.jpg",
        } } });
      }
      return jsonResponse({ "subsonic-response": { status: "ok", album: {
        id: "queen-album",
        song: [
          { id: "queen-song", title: "Queen Song", artistId: "queen-id", artist: "Queen", playCount: 12 },
          { id: "other-song", title: "Other Song", artistId: "queen-naija-id", artist: "Queen Naija", playCount: 99 },
        ],
      } } });
    });
    const backend = new NavidromeBackend({
      url: "http://navidrome.test", username: "listener", password: "secret",
    }, fetchImpl as any);

    await expect(backend.getArtist("queen-id")).resolves.toMatchObject({
      id: "queen-id", imageUrl: "https://images.example.test/queen-artist.jpg",
    });
    await expect(backend.getArtistTracks("queen-id")).resolves.toEqual([
      expect.objectContaining({ id: "queen-song", artistId: "queen-id", playCount: 12 }),
    ]);
  });

  test("submits a qualified play to the Subsonic scrobble endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ "subsonic-response": { status: "ok" } }));
    const backend = new NavidromeBackend({
      url: "http://navidrome.test", username: "listener", password: "secret",
    }, fetchImpl as any);

    await backend.scrobbleTrack("native-track", 1_700_000_000_000);
    const url = new URL(String((fetchImpl.mock.calls as unknown[][])[0]?.[0]));
    expect(url.pathname).toBe("/rest/scrobble.view");
    expect(url.searchParams.get("id")).toBe("native-track");
    expect(url.searchParams.get("time")).toBe("1700000000000");
    expect(url.searchParams.get("submission")).toBe("true");
  });
  test("maps albums and tracks into MusicDeck models without exposing credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      "subsonic-response": {
        status: "ok",
        album: {
          id: "album-1",
          name: "Album One",
          artistId: "artist-1",
          artist: "Artist One",
          coverArt: "art-1",
          song: [
            {
              id: "track-1",
              title: "Track One",
              artistId: "artist-1",
              artist: "Artist One",
              albumId: "album-1",
              album: "Album One",
              duration: 120,
              playCount: 8,
              played: "2026-09-22T10:00:00Z",
              track: 1,
              coverArt: "art-1",
            },
          ],
        },
      },
    }));

    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    const album = await backend.getAlbum("album-1");
    const tracks = await backend.getAlbumTracks("album-1");

    expect(album).toMatchObject({
      id: "album-1",
      name: "Album One",
      artistName: "Artist One",
      artworkUrl: "/api/artwork/art-1",
    });
    expect(tracks[0]).toMatchObject({
      id: "track-1",
      streamUrl: "/api/tracks/track-1/stream",
      playCount: 8,
      lastPlayedAt: "2026-09-22T10:00:00Z",
    });

    const requestUrl = String((fetchImpl.mock.calls as unknown[][])[0]?.[0]);
    expect(requestUrl).toContain("/rest/getAlbum.view");
    expect(requestUrl).toContain("u=navidrome-user");
    expect(requestUrl).not.toContain("navidrome-password");
  });

  test("does not duplicate existing playlist songs when adding a track", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (String(url).includes("getPlaylist")) {
        return jsonResponse({
          "subsonic-response": {
            status: "ok",
            playlist: {
              id: "playlist-1",
              name: "Playlist",
              entry: [{ id: "track-1", title: "Track One" }],
            },
          },
        });
      }

      return jsonResponse({
        "subsonic-response": { status: "ok" },
      });
    });

    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    await expect(
      backend.addTrackToPlaylist("playlist-1", "track-1")
    ).resolves.toEqual({ added: false });

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      backend.addTrackToPlaylist("playlist-1", "track-2")
    ).resolves.toEqual({ added: true });

    const updateUrl = String((fetchImpl.mock.calls as unknown[][])[2]?.[0]);
    expect(updateUrl).toContain("updatePlaylist.view");
    expect(updateUrl).toContain("songIdToAdd=track-2");
    expect(updateUrl).not.toContain("songIdToAdd=track-1");
  });

  test("reads structured lyrics and artist biography from Subsonic metadata endpoints", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      const requestUrl = String(url);
      if (requestUrl.includes("getLyricsBySongId.view")) {
        return jsonResponse({
          "subsonic-response": {
            status: "ok",
            lyricsList: { structuredLyrics: [{ line: [{ value: "First line" }, { value: "Second line" }] }] },
          },
        });
      }
      if (requestUrl.includes("getSong.view")) {
        return jsonResponse({
          "subsonic-response": { status: "ok", song: { id: "track-1", artistId: "artist-1" } },
        });
      }
      return jsonResponse({
        "subsonic-response": { status: "ok", artistInfo2: { biography: "An artist story." } },
      });
    });

    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    await expect(backend.getLyrics("track-1")).resolves.toBe("First line\nSecond line");
    await expect(backend.getArtistBiographyForTrack("track-1")).resolves.toBe("An artist story.");
  });

  test("scanLibrary waits for Navidrome's async scan to finish before resolving", async () => {
    let scanStatusCalls = 0;
    const fetchImpl = vi.fn(async (url: URL) => {
      const s = String(url);
      if (s.includes("startScan.view")) {
        return jsonResponse({
          "subsonic-response": { status: "ok", scanStatus: { scanning: true, count: 0 } },
        });
      }
      if (s.includes("getScanStatus.view")) {
        scanStatusCalls += 1;
        // Report "still scanning" for the first couple of polls, then done.
        const scanning = scanStatusCalls < 3;
        return jsonResponse({
          "subsonic-response": { status: "ok", scanStatus: { scanning, count: 5 } },
        });
      }
      return jsonResponse({ "subsonic-response": { status: "ok" } });
    });

    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    const result = await backend.scanLibrary();

    expect(result).toEqual({ scanning: false, count: 5 });
    expect(scanStatusCalls).toBeGreaterThanOrEqual(3);
  });

  test("scanLibrary reports not-scanning if triggering the scan itself fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }));

    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    await expect(backend.scanLibrary()).resolves.toEqual({ scanning: false });
  });

  test("forwards the selected bitrate cap to the Subsonic stream endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: URL) => new Response("audio", { status: 200 }));
    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    }, fetchImpl as any);

    await backend.fetchStream("track-1", undefined, 128);

    expect(String(fetchImpl.mock.calls[0][0])).toContain("stream.view");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("maxBitRate=128");
  });
});
