import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { MusicBackend } from "../src/backends/music-backend.js";
import type { DownloaderAdapter } from "../src/domain/downloader-adapter.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import { parseSpotifyPlaylistUrl, SpotifyPlaylistImportService, type SpotifyImportJob } from "../src/domain/spotify-playlist-import.js";
import type { SessionUser } from "../src/types.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const user = { id: "user-1" } as SessionUser;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function completedJob(service: SpotifyPlaylistImportService, id: string) {
  for (let index = 0; index < 200; index += 1) {
    const job = service.get(id, user.id);
    if (job?.status !== "running" && job?.status !== "queued") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Import job did not finish in the test window");
}

describe("Spotify playlist import", () => {
  test("accepts only canonical Spotify playlist URLs", () => {
    expect(parseSpotifyPlaylistUrl("https://open.spotify.com/playlist/abc123?si=shared")).toEqual({
      id: "abc123", url: "https://open.spotify.com/playlist/abc123",
    });
    expect(parseSpotifyPlaylistUrl("https://open.spotify.com.evil.test/playlist/abc123")).toBeNull();
    expect(parseSpotifyPlaylistUrl("https://open.spotify.com/track/abc123")).toBeNull();
    expect(parseSpotifyPlaylistUrl("http://open.spotify.com/playlist/abc123")).toBeNull();
  });

  test("downloads an M3U, scans the library, and returns a navigable owned playlist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-import-"));
    directories.push(root);
    let scanned = false;
    let importedName = "";
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => scanned ? [{ id: "nav-2", name: importedName }] as any : []),
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }),
    });
    const downloader = {
      download: vi.fn(async (request) => {
        importedName = path.parse(request.playlistM3uName!).name;
        fs.mkdirSync(request.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName!), "#EXTM3U\n1 - track.mp3\n");
        const trackPath = path.join(request.outputDirectory, "1 - track.mp3");
        fs.writeFileSync(trackPath, "audio");
        return { status: "completed" as const, files: [{ path: trackPath }],
          playlistLength: 1, playlistTracks: [{ position: 1, url: "https://open.spotify.com/track/one", title: "Track", artist: "Artist", duration: 180 }] };
      }),
    } as unknown as DownloaderAdapter;
    const playlists = {
      adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_1", name: "Road Trip", tracks: [{}] })),
    } as unknown as PlaylistService;
    const spotifyFetch = vi.fn(async () => new Response(JSON.stringify({ title: "Road Trip" }), { status: 200 }));
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, spotifyFetch as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123?si=shared", user);
    expect(started.status).toBe("queued");
    const job = await completedJob(service, started.id);

    expect(job).toMatchObject({ status: "completed", playlistId: "mdpl_1", playlistName: "Road Trip" });
    expect(backend.scanLibrary).toHaveBeenCalledOnce();
    expect(playlists.adoptProviderPlaylist).toHaveBeenCalledWith("nav-2", user, "Road Trip");
    expect(downloader.download).toHaveBeenCalledWith(expect.objectContaining({
      query: "https://open.spotify.com/playlist/abc123",
      playlistM3uName: expect.stringMatching(/^musicdeck-spimp_.*\.m3u8$/),
    }), expect.anything());
    expect(service.get(started.id, "another-user")).toBeNull();
  });

  test("reports a downloader failure without pretending a playlist was imported", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-import-"));
    directories.push(root);
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => []),
      scanLibrary: vi.fn(async () => ({ scanning: false })),
    });
    const downloader = {
      download: vi.fn(async () => ({ status: "failed" as const, files: [], error: { code: "general", message: "spotDL unavailable" } })),
    } as unknown as DownloaderAdapter;
    const playlists = { adoptProviderPlaylist: vi.fn() } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    expect(await completedJob(service, started.id)).toMatchObject({ status: "failed", error: "spotDL unavailable" });
    expect(backend.scanLibrary).not.toHaveBeenCalled();
    expect(playlists.adoptProviderPlaylist).not.toHaveBeenCalled();
  });

  test("recovers missing playlist positions before scanning and waits for all Navidrome tracks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-retry-"));
    directories.push(root);
    const source = Array.from({ length: 15 }, (_, index) => ({
      position: index + 1,
      url: `https://open.spotify.com/track/track${index + 1}`,
      title: `Song ${index + 1}`,
      artist: "Artist",
      duration: 180,
    }));
    let scanned = false;
    let providerReads = 0;
    let importedName = "";
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => scanned ? [{ id: "nav-15", name: importedName }] as any : []),
      getPlaylist: vi.fn(async () => {
        providerReads += 1;
        return { tracks: Array.from({ length: providerReads === 1 ? 7 : 15 }, () => ({})) } as any;
      }),
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }),
    });
    const downloader = {
      download: vi.fn(async (request) => {
        fs.mkdirSync(request.outputDirectory, { recursive: true });
        if (request.playlistM3uName) {
          importedName = path.parse(request.playlistM3uName).name;
          fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName), "#EXTM3U\n");
          const files = source.slice(0, 7).map((track) => {
            const filePath = path.join(request.outputDirectory, `${track.position} - Artist - ${track.title}.mp3`);
            fs.writeFileSync(filePath, "audio");
            return { path: filePath };
          });
          return { status: "completed" as const, files, playlistLength: 15, playlistTracks: source };
        }
        const position = Number(/^([0-9]+) - /.exec(request.filenameTemplate)?.[1]);
        const filePath = path.join(request.outputDirectory, `${position} - Artist - Song ${position}.mp3`);
        fs.writeFileSync(filePath, "audio");
        return { status: "completed" as const, files: [{ path: filePath }] };
      }),
    } as unknown as DownloaderAdapter;
    const playlists = {
      adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_15", name: "Full Playlist", tracks: Array.from({ length: 15 }, () => ({})) })),
    } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    const job = await completedJob(service, started.id);
    expect(job).toMatchObject({ status: "completed", expectedCount: 15, downloadedCount: 15, importedCount: 15 });
    expect(downloader.download).toHaveBeenCalledTimes(9);
    expect(providerReads).toBeGreaterThanOrEqual(2);
    const manifest = fs.readFileSync(path.join(root, "Spotify Imports", started.id, `musicdeck-${started.id}.m3u8`), "utf8");
    expect(manifest.split("\n").filter((line) => line.endsWith(".mp3"))).toHaveLength(15);
  });

  test("reports a partial import instead of claiming that all songs downloaded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-partial-"));
    directories.push(root);
    let scanned = false;
    let importedName = "";
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => scanned ? [{ id: "nav-partial", name: importedName }] as any : []),
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }),
    });
    const downloader = {
      download: vi.fn(async (request) => {
        if (!request.playlistM3uName) return { status: "completed", files: [{ path: path.join(request.outputDirectory, "1 - Artist - One.mp3") }] };
        importedName = path.parse(request.playlistM3uName).name;
        fs.mkdirSync(request.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName), "#EXTM3U\n");
        const filePath = path.join(request.outputDirectory, "1 - Artist - One.mp3");
        fs.writeFileSync(filePath, "audio");
        return { status: "completed", files: [{ path: filePath }], playlistLength: 2, playlistTracks: [
          { position: 1, url: "https://open.spotify.com/track/one", title: "One", artist: "Artist", duration: 180 },
          { position: 2, url: "https://open.spotify.com/track/two", title: "Two", artist: "Artist", duration: 180 },
        ] };
      }),
    } as unknown as DownloaderAdapter;
    const playlists = { adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_partial", name: "Partial", tracks: [{}] })) } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    expect(await completedJob(service, started.id)).toMatchObject({
      status: "partial", expectedCount: 2, downloadedCount: 1, importedCount: 1,
      error: expect.stringContaining("Imported 1 of 2 songs"),
    });
  });

  test("rejects an import directory that escapes the music root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-path-"));
    directories.push(root);
    const backend = createFakeBackend({ listPlaylists: vi.fn(async () => []), scanLibrary: vi.fn(async () => ({ scanning: false })) });
    const downloader = { download: vi.fn() } as unknown as DownloaderAdapter;
    const playlists = { adoptProviderPlaylist: vi.fn() } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(
      backend, playlists, downloader, root,
      vi.fn(async () => new Response("{}")) as typeof fetch,
      "../../outside"
    );
    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    expect(await completedJob(service, started.id)).toMatchObject({
      status: "failed", error: "Spotify import folder must be inside the music library",
    });
    expect(downloader.download).not.toHaveBeenCalled();
  });

  test("authenticated import routes return a job and then its MusicDeck playlist ID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-route-"));
    directories.push(root);
    let scanned = false;
    let importedName = "";
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => scanned ? [{ id: "nav-import", name: importedName }] as any : []),
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }),
    });
    const downloader = {
      download: vi.fn(async (request) => {
        importedName = path.parse(request.playlistM3uName!).name;
        fs.mkdirSync(request.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName!), "#EXTM3U\n1 - Artist - Song.mp3\n");
        const trackPath = path.join(request.outputDirectory, "1 - Artist - Song.mp3");
        fs.writeFileSync(trackPath, "audio");
        return { status: "completed" as const, files: [{ path: trackPath }],
          playlistLength: 1, playlistTracks: [{ position: 1, url: "https://open.spotify.com/track/one", title: "Song", artist: "Artist", duration: 180 }] };
      }),
    } as unknown as DownloaderAdapter;
    const context = await createTestServer(
      backend, { musicRoot: root }, undefined, undefined, undefined,
      (resolvedBackend, playlists, musicRoot) => new SpotifyPlaylistImportService(
        resolvedBackend, playlists, downloader, musicRoot,
        vi.fn(async () => new Response(JSON.stringify({ title: "Road Trip" }), { status: 200 })) as typeof fetch
      )
    );

    try {
      const { cookie } = await login(context.app);
      const invalid = await context.app.inject({
        method: "POST", url: "/api/v1/playlists/import-spotify", headers: { cookie },
        payload: { playlistUrl: "https://open.spotify.com/track/abc123" },
      });
      expect(invalid.statusCode).toBe(400);

      const response = await context.app.inject({
        method: "POST", url: "/api/v1/playlists/import-spotify", headers: { cookie },
        payload: { playlistUrl: "https://open.spotify.com/playlist/abc123" },
      });
      expect(response.statusCode).toBe(202);
      const jobId = response.json().job.id as string;

      let job: SpotifyImportJob | undefined;
      for (let index = 0; index < 30; index += 1) {
        const status = await context.app.inject({
          method: "GET", url: `/api/v1/playlists/import-spotify/${jobId}`, headers: { cookie },
        });
        job = status.json().job;
        if (job?.status === "completed" || job?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({ status: "completed", playlistName: "Road Trip" });
      expect(job?.playlistId).toMatch(/^mdpl_/);

      const playlist = await context.app.inject({
        method: "GET", url: `/api/playlists/${job!.playlistId}`, headers: { cookie },
      });
      expect(playlist.statusCode).toBe(200);
      expect(playlist.json().playlist).toMatchObject({ name: "Road Trip", songCount: 1 });
    } finally {
      await closeTestServer(context.app, context.db);
    }
  });
});
