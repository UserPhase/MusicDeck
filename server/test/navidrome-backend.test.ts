import { describe, expect, test, vi } from "vitest";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("NavidromeBackend", () => {
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
});
