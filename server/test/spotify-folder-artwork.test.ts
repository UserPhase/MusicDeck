import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { createFakeBackend } from "./helpers.js";
import { runMigrations } from "../src/db/migrations.js";
import { SqliteImportedArtworkRepository } from "../src/infrastructure/persistence/sqliteImportedArtworkRepository.js";
import { SpotifyPlaylistImportService } from "../src/domain/spotify-playlist-import.js";
import type { DownloaderAdapter } from "../src/domain/downloader-adapter.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import type { SessionUser } from "../src/types.js";

test.each([false, true])("matched imports save metadata and publish folder art before scanning (network failure: %s)", async (failImage) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-import-cover-"));
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    const repo = new SqliteImportedArtworkRepository(db);
    const coverUrl = "https://i.scdn.co/image/albumcover";
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
    const albumDir = path.join(root, "Dominic Fike", "Demos");
    const source = [1, 2].map((position) => ({
      position, url: `https://open.spotify.com/track/song${position}`, title: `Song ${position}`,
      artist: "Dominic Fike", album: "Demos", duration: 180, artworkUrl: coverUrl, albumId: "spotifyalbum",
    }));
    let scanned = false;
    const base = createFakeBackend();
    const sample = await base.getTrack("track-1");
    if (!sample) throw new Error("Missing fixture");
    const backend = createFakeBackend({
      search: vi.fn(async (query) => ({ albums: [], artists: [], tracks: scanned ? [{
        ...sample, id: `nav-${query}`, title: query, artistName: "Dominic Fike", albumName: "Demos",
      }] : [] })),
      scanLibrary: vi.fn(async () => {
        expect(fs.existsSync(path.join(albumDir, "Song 1.mp3"))).toBe(true);
        expect(fs.existsSync(path.join(albumDir, "Song 2.mp3"))).toBe(true);
        expect(repo.find("DOMINIC FIKE", "demos")).toBe(coverUrl);
        for (const name of ["cover.jpg", "folder.jpg"]) {
          if (failImage) expect(fs.existsSync(path.join(albumDir, name))).toBe(false);
          else expect(fs.readFileSync(path.join(albumDir, name))).toEqual(Buffer.from(jpeg));
        }
        scanned = true;
        return { scanning: false };
      }),
    });
    const downloader = {
      fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistLength: 2, playlistTracks: source })),
      download: vi.fn(async (request) => {
        const file = path.join(albumDir, `${request.canonicalMetadata?.title}.mp3`);
        fs.mkdirSync(albumDir, { recursive: true });
        fs.writeFileSync(file, "audio");
        return { status: "completed", files: [{ path: file }] };
      }),
    } satisfies Partial<DownloaderAdapter>;
    const playlists = {
      create: vi.fn(async () => ({ id: "mdpl_test", name: "Playlist" })),
      addProviderTrack: vi.fn(async () => ({ added: true })),
    } as unknown as PlaylistService;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("https://i.scdn.co/")) {
        if (failImage) throw new Error("CDN offline");
        return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
      }
      return new Response("{}");
    });
    const warning = vi.fn();
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader as unknown as DownloaderAdapter,
      root, fetchImpl, undefined, undefined, undefined, repo, warning);
    const user = { id: "user-1" } as SessionUser;
    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    let job = service.get(started.id, user.id);
    for (let attempt = 0; attempt < 200 && (job?.status === "queued" || job?.status === "running"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = service.get(started.id, user.id);
    }
    expect(job).toMatchObject({ status: "completed", importedCount: 2 });
    expect(backend.scanLibrary).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === coverUrl)).toHaveLength(1);
    if (failImage) {
      expect(warning).toHaveBeenCalled();
      expect(job?.manifest?.[0].artworkWarnings?.[0]).toContain("CDN offline");
    } else expect(warning).not.toHaveBeenCalled();
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy M3U imports also write album artwork before their scan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-legacy-cover-"));
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    const repo = new SqliteImportedArtworkRepository(db);
    const albumDir = path.join(root, "Artist", "Album");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
    let scanned = false;
    let playlistName = "";
    const backend = createFakeBackend({
      listPlaylists: vi.fn(async () => scanned ? [{ id: "legacy", name: playlistName,
        description: null, artworkId: null, artworkUrl: null, songCount: 1 }] : []),
      scanLibrary: vi.fn(async () => {
        expect(fs.readFileSync(path.join(albumDir, "cover.jpg"))).toEqual(Buffer.from(jpeg));
        expect(fs.readFileSync(path.join(albumDir, "folder.jpg"))).toEqual(Buffer.from(jpeg));
        expect(repo.find("artist", "album")).toBe("https://i.scdn.co/image/legacy");
        scanned = true;
        return { scanning: false };
      }),
    });
    const downloader = {
      download: vi.fn(async (request) => {
        const m3uName = request.playlistM3uName;
        if (!m3uName) throw new Error("Expected M3U import");
        playlistName = path.parse(m3uName).name;
        fs.mkdirSync(albumDir, { recursive: true });
        const file = path.join(albumDir, "Track.mp3");
        fs.writeFileSync(file, "audio");
        fs.writeFileSync(path.join(request.outputDirectory, m3uName), "#EXTM3U\n");
        return { status: "completed", files: [{ path: file, playlistPosition: 1 }], playlistLength: 1,
          playlistTracks: [{ position: 1, title: "Track", artist: "Artist", album: "Album", duration: 180,
            url: "https://open.spotify.com/track/one", artworkUrl: "https://i.scdn.co/image/legacy" }] };
      }),
    } satisfies Partial<DownloaderAdapter>;
    const playlists = {
      adoptProviderPlaylist: vi.fn(async () => ({ id: "mdpl_legacy", name: "Playlist", tracks: [{}] })),
      update: vi.fn(async () => null),
    } as unknown as PlaylistService;
    const fetchImpl: typeof fetch = async (input) => String(input).startsWith("https://i.scdn.co/")
      ? new Response(jpeg, { headers: { "content-type": "image/jpeg" } }) : new Response("{}");
    const service = new SpotifyPlaylistImportService(backend, playlists, downloader as unknown as DownloaderAdapter,
      root, fetchImpl, undefined, undefined, undefined, repo, vi.fn());
    const user = { id: "user-1" } as SessionUser;
    const started = service.start("https://open.spotify.com/playlist/abc123", user);
    let job = service.get(started.id, user.id);
    for (let attempt = 0; attempt < 200 && (job?.status === "queued" || job?.status === "running"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = service.get(started.id, user.id);
    }
    expect(job?.status).toBe("completed");
    expect(backend.scanLibrary).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
