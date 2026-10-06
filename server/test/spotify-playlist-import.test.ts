import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { MusicBackend } from "../src/backends/music-backend.js";
import type { DownloaderAdapter } from "../src/domain/downloader-adapter.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import { parseSpotifyPlaylistUrl, SpotifyPlaylistImportService, type SpotifyImportJob } from "../src/domain/spotify-playlist-import.js";
import { SPOTDL_LIBRARY_TEMPLATE, SpotDLDownloaderAdapter } from "../src/domain/spotdl-downloader-adapter.js";
import type { AudioTaggerService } from "../src/services/media/audioTaggerService.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
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
      update: vi.fn(async () => ({ id: "mdpl_1", name: "Road Trip" })),
    } as unknown as PlaylistService;
    const spotifyFetch = vi.fn(async () => new Response(JSON.stringify({ title: "Road Trip" }), { status: 200 }));
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, spotifyFetch as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123?si=shared", user);
    expect(started.status).toBe("queued");
    const job = await completedJob(service, started.id);

    expect(job).toMatchObject({ status: "completed", playlistId: "mdpl_1", playlistName: "Road Trip" });
    expect(backend.scanLibrary).toHaveBeenCalledOnce();
    expect(playlists.adoptProviderPlaylist).toHaveBeenCalledWith("nav-2", user, "Road Trip");
    expect(playlists.update).toHaveBeenCalledWith("mdpl_1", {
      description: "Imported from Spotify: https://open.spotify.com/playlist/abc123",
    });
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

  test("exposes track progress while spotDL is still running", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-progress-"));
    directories.push(root);
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => []),
      scanLibrary: vi.fn(async () => ({ scanning: false })),
    });
    let snapshot: SpotifyImportJob | null = null;
    let service: SpotifyPlaylistImportService;
    const downloader = {
      download: vi.fn(async (request, context) => {
        fs.writeFileSync(path.join(request.outputDirectory, "musicdeck-source.spotdl"), JSON.stringify([
          { list_length: 3, list_position: 1, url: "https://open.spotify.com/track/one" },
        ]));
        context.onProgress?.({ message: 'Downloaded "First song"', stage: "processing" });
        context.onProgress?.({ message: 'Downloading "2hollis - crush"', stage: "downloading" });
        snapshot = service.get(context.jobId, user.id);
        return { status: "failed" as const, files: [], error: { code: "general", message: "Stopped for test" } };
      }),
    } as unknown as DownloaderAdapter;
    service = new SpotifyPlaylistImportService(backend, {} as PlaylistService, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);
    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    await completedJob(service, started.id);
    expect(snapshot).toMatchObject({ status: "running", expectedCount: 3, downloadedCount: 1, currentTrack: 2, currentTrackName: "2hollis - crush" });
  });

  test("imports a playlist using an existing library file without replacing it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-existing-"));
    directories.push(root);
    const existing = path.join(root, "Artist", "Album", "Artist - Song.mp3");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "original audio");
    const backend = createFakeBackend({
      search: vi.fn(async () => ({ artists: [], albums: [], tracks: [
        { id: "nav-track-1", title: "Song", artistName: "Artist", durationSeconds: 180 },
      ] })) as any,
      scanLibrary: vi.fn(async () => ({ scanning: false })),
    });
    const runner: ProcessRunner = {
      run: vi.fn().mockImplementation((_command, args, options) => {
        expect(args).toContain("save");
        fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([
          { list_position: 1, list_length: 1, url: "https://open.spotify.com/track/one", name: "Song", artist: "Artist", duration: 180 },
        ]));
        return { pid: 1, kill: () => {}, promise: Promise.resolve({ exitCode: 0, stdout: "Saved 1 song", stderr: "" }) };
      }),
    };
    const downloader = new SpotDLDownloaderAdapter({ runner, spotdlPath: "spotdl" });
    downloader.configure({ clientId: "", clientSecret: "" });
    const playlists = {
      create: vi.fn(async () => ({ id: "mdpl_existing", name: "Existing songs" })),
      addProviderTrack: vi.fn(async () => ({ added: true })),
    } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    expect(await completedJob(service, started.id)).toMatchObject({ status: "completed", downloadedCount: 1, importedCount: 1 });
    expect(fs.readFileSync(existing, "utf8")).toBe("original audio");
    expect((runner.run as any).mock.calls).toHaveLength(1);
    expect(backend.scanLibrary).not.toHaveBeenCalled();
    expect(playlists.addProviderTrack).toHaveBeenCalledWith("mdpl_existing", "nav-track-1");
  });

  test("links existing and newly indexed tracks once, in Spotify order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-matched-"));
    directories.push(root);
    let indexedNewTrack = false;
    const backend = createFakeBackend({
      search: vi.fn(async (query: string) => ({ artists: [], albums: [], tracks: query === "Old Song"
        ? [{ id: "nav-old", title: "Old Song", artistName: "Artist", durationSeconds: 180 }]
        : indexedNewTrack ? [{ id: "nav-new", title: "New Song", artistName: "Artist", durationSeconds: 190 }] : [] })) as any,
      scanLibrary: vi.fn(async () => { indexedNewTrack = true; return { scanning: false }; }),
    });
    const downloaded = path.join(root, "Artist", "Album", "Artist - New Song.mp3");
    const downloader = {
      fetchPlaylistDetails: vi.fn(async () => ({ title: "Mixed Songs", description: "The original Spotify description", artworkUrl: "https://i.scdn.co/image/example" })),
      fetchPlaylistTracks: vi.fn(async () => ({ status: "completed" as const, files: [], playlistLength: 3, playlistTracks: [
        { position: 1, url: "https://open.spotify.com/track/old", title: "Old Song", artist: "Artist", duration: 180 },
        { position: 2, url: "https://open.spotify.com/track/new", title: "New Song", artist: "Artist", duration: 190 },
        { position: 3, url: "https://open.spotify.com/track/old", title: "Old Song", artist: "Artist", duration: 180 },
      ] })),
      download: vi.fn(async () => {
        fs.mkdirSync(path.dirname(downloaded), { recursive: true });
        fs.writeFileSync(downloaded, "new audio");
        return { status: "completed" as const, files: [{ path: downloaded }] };
      }),
    } as unknown as DownloaderAdapter;
    const linked: string[] = [];
    const playlists = {
      create: vi.fn(async () => ({ id: "mdpl_mixed", name: "Mixed Songs" })),
      setCustomArtwork: vi.fn(() => true),
      addProviderTrack: vi.fn(async (_playlistId: string, trackId: string) => {
        linked.push(trackId);
        return { added: true };
      }),
    } as unknown as PlaylistService;
    const spotifyFetch = vi.fn(async (url: URL | string) => String(url).includes("/oembed")
      ? new Response(JSON.stringify({ title: "Mixed Songs", thumbnail_url: "https://i.scdn.co/image/example" }), { status: 200 })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, spotifyFetch as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    expect(await completedJob(service, started.id)).toMatchObject({
      status: "completed", expectedCount: 3, completedCount: 3, importedCount: 2, playlistId: "mdpl_mixed",
    });
    expect(linked).toEqual(["nav-old", "nav-new"]);
    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(backend.scanLibrary).toHaveBeenCalledTimes(1);
    expect(playlists.create).toHaveBeenCalledWith(
      "Mixed Songs",
      user,
      "The original Spotify description\n\nImported from Spotify: https://open.spotify.com/playlist/abc123"
    );
    expect(playlists.setCustomArtwork).toHaveBeenCalledWith("mdpl_mixed", Buffer.from([1, 2, 3]), "image/jpeg");
  });

  test.each(["none", "download", "tagging", "linking"])("processes all 14 staged songs despite a %s failure", async (failure) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-full-tagged-playlist-"));
    directories.push(root);
    const source = Array.from({ length: 14 }, (_, index) => ({
      position: index + 1,
      url: `https://open.spotify.com/track/track${index + 1}`,
      title: `Song ${index + 1}`, artist: "Artist", album: "Album", duration: 180,
      year: "2024", artworkUrl: "https://i.scdn.co/image/test",
    }));
    const tagged = new Set<string>();
    let scanned = false;
    let attempted = 0;
    const backend = createFakeBackend({
      search: vi.fn(async (query: string) => ({ artists: [], albums: [], tracks: scanned && tagged.has(query)
        ? [{ id: `nav-${query}`, title: query, artistName: "Artist", albumName: "Album", durationSeconds: 180 }] : [] })) as any,
      scanLibrary: vi.fn(async () => {
        // All download attempts must complete before the first scan waits.
        expect(attempted).toBe(14);
        for (const title of tagged) {
          expect(fs.readFileSync(path.join(root, "Artist", "Album", `Artist - ${title}.mp3`), "utf8")).toBe("tagged audio");
        }
        scanned = true;
        return { scanning: false };
      }),
    });
    const download = vi.fn(async (request: any) => {
      attempted += 1;
      expect(scanned).toBe(false);
      expect(request.playlistM3uName).toBeUndefined();
      if (failure === "download" && attempted === 2) throw new Error("audio provider failed");
      const song = source[attempted - 1];
      const filePath = path.join(request.outputDirectory, "Artist", "Album", `Artist - ${song.title}.mp3`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "untagged audio");
      return { status: "completed" as const, files: [{ path: filePath, album: "Album" }] };
    });
    const downloader = {
      fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistLength: 14, playlistTracks: source })),
      download,
    } as unknown as DownloaderAdapter;
    const tagger = {
      verifyAndTag: vi.fn(async (filePath: string, metadata: { title: string }) => {
        if (failure === "tagging" && metadata.title === "Song 2") throw new Error("tagging failed");
        expect(fs.existsSync(path.join(root, "Artist", "Album", `Artist - ${metadata.title}.mp3`))).toBe(false);
        fs.writeFileSync(filePath, "tagged audio");
        tagged.add(metadata.title);
      }),
    } as unknown as AudioTaggerService;
    const linked: string[] = [];
    const playlists = {
      create: vi.fn(async () => ({ id: "mdpl_14", name: "14 songs" })),
      addProviderTrack: vi.fn(async (_id: string, trackId: string) => {
        if (failure === "linking" && trackId === "nav-Song 2") throw new Error("playlist sync failed");
        linked.push(trackId);
        return { added: true };
      }),
    } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root,
      vi.fn(async () => new Response("{}")) as typeof fetch, "Spotify Imports", tagger);
    const job = await completedJob(service, service.start("https://open.spotify.com/playlist/abc123", user).id);

    expect(job).toMatchObject({
      status: failure === "none" ? "completed" : "partial",
      expectedCount: 14, currentTrack: 14,
      downloadedCount: ["download", "tagging"].includes(failure) ? 13 : 14,
      importedCount: failure === "none" ? 14 : 13,
    });
    expect(download).toHaveBeenCalledTimes(14);
    expect(backend.scanLibrary).toHaveBeenCalledOnce();
    expect(linked).toEqual(source.filter((song) => failure === "none" || song.position !== 2).map((song) => `nav-${song.title}`));
    expect(download.mock.calls.every(([request]) => !fs.existsSync(request.outputDirectory))).toBe(true);
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
    const retryDirectories: string[] = [];
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
        if (request.query) {
          importedName = path.parse(request.playlistM3uName).name;
          fs.writeFileSync(path.join(request.outputDirectory, "musicdeck-source.spotdl"), "playlist metadata");
          fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName), "#EXTM3U\n");
          const files = source.slice(0, 7).map((track) => {
            const filePath = path.join(root, "Artist", "Album", `Artist - ${track.title}.mp3`);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, "audio");
            return { path: filePath, playlistPosition: track.position };
          });
          return { status: "completed" as const, files, playlistLength: 15, playlistTracks: source };
        }
        retryDirectories.push(request.outputDirectory);
        const position = Number(/track([0-9]+)$/.exec(request.spotifyTrackUrl)?.[1]);
        const filePath = path.join(root, "Artist", "Album", `Artist - Song ${position}.mp3`);
        fs.writeFileSync(filePath, "audio");
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName), `#EXTM3U\n${filePath}\n`);
        return { status: "completed" as const, files: [{ path: filePath, playlistPosition: 1 }] };
      }),
    } as unknown as DownloaderAdapter;
    const playlists = {
      adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_15", name: "Full Playlist", tracks: Array.from({ length: 15 }, () => ({})) })),
      update: vi.fn(async () => null),
    } as unknown as PlaylistService;
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader, root, vi.fn(async () => new Response("{}")) as typeof fetch);

    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    const job = await completedJob(service, started.id);
    expect(job).toMatchObject({ status: "completed", expectedCount: 15, downloadedCount: 15, importedCount: 15 });
    expect(downloader.download).toHaveBeenCalledTimes(9);
    expect((downloader.download as any).mock.calls[0][0].filenameTemplate).toBe(path.join(root, SPOTDL_LIBRARY_TEMPLATE));
    expect(providerReads).toBeGreaterThanOrEqual(2);
    const manifest = fs.readFileSync(path.join(root, "Spotify Imports", started.id, `musicdeck-${started.id}.m3u8`), "utf8");
    expect(manifest.split("\n").filter((line) => line.endsWith(".mp3"))).toHaveLength(15);
    expect(manifest).toContain("Artist/Album/Artist - Song 1.mp3");
    expect(fs.readFileSync(path.join(root, "Spotify Imports", started.id, "musicdeck-source.spotdl"), "utf8")).toBe("playlist metadata");
    expect(retryDirectories).toHaveLength(8);
    expect(retryDirectories.every((directory) => !fs.existsSync(directory))).toBe(true);
    expect(fs.readdirSync(path.join(root, "Spotify Imports", started.id)).filter((name) => name.startsWith("musicdeck-retry-"))).toEqual([]);
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
        if (request.spotifyTrackUrl) return { status: "completed", files: [] };
        importedName = path.parse(request.playlistM3uName).name;
        fs.mkdirSync(request.outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName), "#EXTM3U\n");
        const filePath = path.join(root, "Artist", "Album", "Artist - One.mp3");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "audio");
        return { status: "completed", files: [{ path: filePath, playlistPosition: 1 }], playlistLength: 2, playlistTracks: [
          { position: 1, url: "https://open.spotify.com/track/one", title: "One", artist: "Artist", duration: 180 },
          { position: 2, url: "https://open.spotify.com/track/two", title: "Two", artist: "Artist", duration: 180 },
        ] };
      }),
    } as unknown as DownloaderAdapter;
    const playlists = {
      adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_partial", name: "Partial", tracks: [{}] })),
      update: vi.fn(async () => null),
    } as unknown as PlaylistService;
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
        fs.writeFileSync(path.join(request.outputDirectory, request.playlistM3uName!), "#EXTM3U\n");
        const trackPath = path.join(root, "Artist", "Album", "Artist - Song.mp3");
        fs.mkdirSync(path.dirname(trackPath), { recursive: true });
        fs.writeFileSync(trackPath, "audio");
        return { status: "completed" as const, files: [{ path: trackPath, playlistPosition: 1 }],
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
