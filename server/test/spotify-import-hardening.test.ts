import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { SpotifyPlaylistImportService, type SpotifyImportJob, type ImportEntry } from "../src/domain/spotify-playlist-import.js";
import { SqliteImportJobRepository } from "../src/infrastructure/persistence/sqliteImportJobRepository.js";
import { SpotDLDownloaderAdapter } from "../src/domain/spotdl-downloader-adapter.js";
import { safeMusicPath } from "../src/services/media/safeMusicPath.js";
import type { AudioTaggerService } from "../src/services/media/audioTaggerService.js";
import type { DownloaderAdapter, DownloadResult, DownloadRequest } from "../src/domain/downloader-adapter.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
import type { SessionUser } from "../src/types.js";
import { createFakeBackend } from "./helpers.js";

const directories: string[] = []; const databases: Database.Database[] = [];
const user = { id: "owner", disabled: false } as SessionUser;
const url = "https://open.spotify.com/playlist/test14";
type Source = NonNullable<DownloadResult["playlistTracks"]>[number];
const song = (position: number): Source => ({ position, url: `https://open.spotify.com/track/song${position}`,
  title: `Song ${position}`, artist: "Primary", artists: ["Primary", "Guest"], album: "Album", albumArtist: "Primary",
  duration: 180, year: "2024", artworkUrl: "https://i.scdn.co/image/cover", isrc: `ISRC${position}` });
const local = (source: Source) => ({ id: `local-${source.position}`, title: source.title, artistName: source.artist,
  albumName: source.album, durationSeconds: source.duration, identityHints: { isrc: source.isrc } });
function temporary() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-import-regression-")); directories.push(directory); return directory; }
function repository(file = ":memory:") { const db = new Database(file); databases.push(db); runMigrations(db); return { db, repo: new SqliteImportJobRepository(db) }; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const oembed = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
async function finish(service: SpotifyPlaylistImportService, id: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = service.get(id, user.id)!;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Import did not finish");
}
function playlists() {
  return { create: vi.fn(async (_name: string, _user: SessionUser, _description?: string, id?: string) => ({ id: id || "playlist", name: "Imported" })),
    hasProviderTrack: vi.fn(() => false), addProviderTrack: vi.fn(async () => ({ added: true })) };
}

describe("Spotify import failure accounting", () => {
  test.each([true, false])("retries missing audio once in fresh staging and continues the playlist: recovery=%s", async (recover) => {
    const root = temporary(); const sources = [song(1), song(2)]; let scanned = false; let firstAttempts = 0;
    const downloader = {
      fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: sources, playlistLength: 2 })),
      download: vi.fn(async (request: DownloadRequest): Promise<DownloadResult> => {
        const source = sources.find((source) => source.url === request.spotifyTrackUrl)!;
        if (source.position === 1 && (++firstAttempts === 1 || !recover)) {
          fs.writeFileSync(path.join(request.outputDirectory, "partial.mp3"), "incomplete audio");
          return { status: "failed", files: [], error: { code: "not-found", message: "No results found for song" } };
        }
        const file = path.join(root, `track-${source.position}.mp3`); fs.writeFileSync(file, "audio");
        return { status: "completed", files: [{ path: file } as any] };
      }),
    };
    const backend = createFakeBackend({ search: vi.fn(async (query) => ({ artists: [], albums: [], tracks: scanned ? [local(sources.find((source) => source.title === query)!)] : [] })) as any,
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
    const service = new SpotifyPlaylistImportService(backend, playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, root, oembed);
    const job = await finish(service, service.start(url, user).id);
    expect(job).toMatchObject({ status: recover ? "completed" : "partial", expectedCount: 2, completedCount: recover ? 2 : 1, failedCount: recover ? 0 : 1 });
    const calls = downloader.download.mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(recover ? 3 : 5); expect(calls[0].broadenAudioSearch).toBe(false); expect(calls[1].broadenAudioSearch).toBe(true);
    expect(calls[1].outputDirectory).not.toBe(calls[0].outputDirectory);
    expect(calls.at(-1)!.spotifyTrackUrl).toBe(sources[1].url);
    expect(calls.filter((call) => call.broadenAudioSearch).map((call) => call.audioProvider)).toEqual(recover ? ["soundcloud"] : ["soundcloud", "youtube", "youtube-music"]);
    expect(calls.every((request) => !fs.existsSync(request.outputDirectory))).toBe(true);
    if (!recover) expect(job.manifest![0]).toMatchObject({ status: "FAILED_DOWNLOAD", error: "No results found for song" });
  });
  test("does not retry authentication failures as if they were missing audio matches", async () => {
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [song(1)] })),
      download: vi.fn(async () => ({ status: "failed", files: [], error: { code: "authentication-failed", message: "Login required" } })) };
    const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })), scanLibrary: vi.fn() });
    const service = new SpotifyPlaylistImportService(backend, playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, temporary(), oembed);
    expect((await finish(service, service.start(url, user).id)).manifest![0]).toMatchObject({ status: "FAILED_DOWNLOAD", error: "Login required" });
    expect(downloader.download).toHaveBeenCalledOnce();
  });
  test.each([true, false])("accounts for all 14 entries with incomplete metadata; recovery=%s", async (recover) => {
    const source = Array.from({ length: 14 }, (_, index) => song(index + 1));
    const damaged = source.map((track, index) => index ? { ...track, artist: "", artists: [] } : track);
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: damaged, playlistLength: 14 })),
      resolveTrackMetadata: vi.fn(async (track: Source) => recover ? source[track.position - 1] : null), download: vi.fn() };
    const backend = createFakeBackend({ search: vi.fn(async (query) => ({ artists: [], albums: [], tracks: [local(source.find((track) => track.title === query)!)] })) as any });
    const { db, repo } = repository(); const lists = playlists();
    const service = new SpotifyPlaylistImportService(backend, lists as unknown as PlaylistService, downloader as unknown as DownloaderAdapter,
      temporary(), oembed, "Spotify Imports", undefined, repo);
    const job = await finish(service, service.start(url, user).id);
    expect(job).toMatchObject({ expectedCount: 14, completedCount: recover ? 14 : 1, failedCount: recover ? 0 : 13, status: recover ? "completed" : "partial" });
    expect(job.manifest).toHaveLength(14);
    expect(downloader.resolveTrackMetadata).toHaveBeenCalledTimes(13); expect(downloader.download).not.toHaveBeenCalled();
    expect(job.manifest!.filter((entry) => entry.status === "FAILED_METADATA_MISSING")).toHaveLength(recover ? 0 : 13);
    expect(db.prepare("SELECT total_tracks, completed_tracks, failed_tracks, status FROM import_jobs").get()).toEqual({
      total_tracks: 14, completed_tracks: recover ? 14 : 1, failed_tracks: recover ? 0 : 13, status: recover ? "COMPLETED" : "FAILED" });
  });
  test("preserves missing positions instead of shifting a sparse source list", async () => {
    const source = song(7);
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [source], playlistLength: 14 })), download: vi.fn() };
    const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: [local(source)] })) as any });
    const service = new SpotifyPlaylistImportService(backend, playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, temporary(), oembed);
    const job = await finish(service, service.start(url, user).id);
    expect(job).toMatchObject({ expectedCount: 14, failedCount: 13, completedCount: 1 });
    expect(job.manifest![6]).toMatchObject({ position: 7, status: "COMPLETED" });
    expect(job.manifest![0]).toMatchObject({ position: 1, status: "FAILED_METADATA_MISSING" });
  });
  test("a library lookup failure cannot cause a duplicate download", async () => {
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [song(1)] })), download: vi.fn() };
    const backend = createFakeBackend({ search: vi.fn(async () => { throw new Error("Library offline"); }) });
    const service = new SpotifyPlaylistImportService(backend, playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, temporary(), oembed);
    const job = await finish(service, service.start(url, user).id);
    expect(job.manifest![0]).toMatchObject({ status: "FAILED_INDEXING", error: "Library offline" });
    expect(downloader.download).not.toHaveBeenCalled();
  });
  test("looks beyond 50 candidates and rejects wrong albums and durations", async () => {
    const source = song(1); const lists = playlists();
    const wrong = Array.from({ length: 50 }, (_, index) => ({ ...local(source), id: `wrong-${index}`, albumName: "Live Album" }));
    const search = vi.fn(async (_query, _types, page) => ({ artists: [], albums: [], tracks: page.offset === 0 ? wrong
      : [{ ...local(source), id: "too-long", durationSeconds: 184.1 }, { ...local(source), id: "right", durationSeconds: 184 }] }));
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [source] })), download: vi.fn() };
    const service = new SpotifyPlaylistImportService(createFakeBackend({ search } as any), lists as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, temporary(), oembed);
    expect((await finish(service, service.start(url, user).id)).status).toBe("completed");
    expect(search.mock.calls.map((call) => call[2].offset)).toEqual([0, 50]);
    expect(lists.addProviderTrack).toHaveBeenCalledWith("playlist", "right"); expect(downloader.download).not.toHaveBeenCalled();
  });
});

describe("physical file safety and existing repair", () => {
  test.each(["publish", "staging", "work"])("a locked %s cleanup directory cannot turn published tracks into failures", async (locked) => {
    const root = temporary(); const sources = [song(1), song(2)]; let scanned = false;
    const remove = fs.promises.rm.bind(fs.promises);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs.promises, "rm").mockImplementation(async (directory, options) => {
      const name = path.basename(String(directory));
      const blocked = locked === "publish" ? name.startsWith(".musicdeck-publish-")
        : locked === "staging" ? name.startsWith("track-") : name.startsWith("musicdeck-playlist-");
      if (blocked) {
        expect(options).toMatchObject({ maxRetries: 3, retryDelay: 100 });
        if (locked === "publish") expect(fs.readdirSync(String(directory))).toEqual([expect.stringMatching(/\.mp3\.partial$/)]);
        if (locked === "work") directories.push(String(directory));
        throw Object.assign(new Error("EPERM: temporary scanner lock"), { code: "EPERM" });
      }
      return remove(directory, options);
    });
    const downloader = {
      fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: sources, playlistLength: 2 })),
      download: vi.fn(async (request: DownloadRequest): Promise<DownloadResult> => {
        const source = request.canonicalMetadata!;
        const file = path.join(request.outputDirectory, "Primary, Guest", "Album", `Primary, Guest - ${source.title}.mp3`);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `audio ${source.position}`);
        return { status: "completed", files: [{ path: file } as any] };
      }),
    };
    const backend = createFakeBackend({ search: vi.fn(async (query) => ({ artists: [], albums: [], tracks: scanned ? [local(sources.find((source) => source.title === query)!)] : [] })) as any,
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
    const tagger = { verifyAndTag: vi.fn(async () => ({ repaired: false })) }; const lists = playlists(); const { repo } = repository();
    const service = new SpotifyPlaylistImportService(backend, lists as unknown as PlaylistService, downloader as unknown as DownloaderAdapter,
      root, oembed, "Spotify Imports", tagger as unknown as AudioTaggerService, repo);
    const job = await finish(service, service.start(url, user).id);
    expect(job).toMatchObject({ status: "completed", completedCount: 2, failedCount: 0 });
    expect(lists.addProviderTrack).toHaveBeenCalledTimes(2); expect(backend.scanLibrary).toHaveBeenCalledOnce();
    expect(downloader.download).toHaveBeenCalledTimes(2);
    for (const entry of job.manifest!) {
      expect(fs.readFileSync(entry.filePath!, "utf8")).toBe(`audio ${entry.position}`);
      if (locked !== "work") expect(entry.cleanupWarnings?.[0]).toContain("EPERM");
    }
    if (locked === "work") expect(job.cleanupWarnings?.[0]).toContain("EPERM");
    expect(repo.get(job.id, user.id)?.job).toEqual(job);
    expect(warning).toHaveBeenCalled();
  });
  test("rejects a root prefix collision and a junction that escapes the music root", () => {
    const workspace = temporary(); const root = path.join(workspace, "music"); const outside = path.join(workspace, "music-other");
    fs.mkdirSync(root); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    expect(() => safeMusicPath(root, path.join(outside, "track.mp3"))).toThrow("outside");
    expect(() => safeMusicPath(root, path.join(root, "linked", "new", "track.mp3"), true)).toThrow("Symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  test("repairs an existing unindexed file without downloading or replacing its audio", async () => {
    const root = temporary(); const source = song(1);
    const destination = path.join(root, "Primary, Guest", "Album", "Primary, Guest - Song 1.mp3");
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, "existing audio");
    let scanned = false;
    const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: scanned ? [local(source)] : [] })) as any,
      scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
    const tagger = { verifyAndTag: vi.fn(async (file, metadata) => {
      expect(file).toBe(destination); expect(metadata.artists).toEqual(["Primary", "Guest"]);
      expect(fs.readFileSync(file, "utf8")).toBe("existing audio"); return { repaired: true };
    }) };
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [source] })), download: vi.fn() };
    const service = new SpotifyPlaylistImportService(backend, playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter,
      root, oembed, "Spotify Imports", tagger as unknown as AudioTaggerService);
    expect((await finish(service, service.start(url, user).id)).status).toBe("completed");
    expect(tagger.verifyAndTag).toHaveBeenCalledOnce(); expect(downloader.download).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination, "utf8")).toBe("existing audio"); expect(backend.scanLibrary).toHaveBeenCalledOnce();
  });
  test("an escaping destination junction is rejected before tagging or downloading", async () => {
    const root = temporary(); const outside = temporary(); fs.symlinkSync(outside, path.join(root, "Primary, Guest"), "junction");
    const tagger = { verifyAndTag: vi.fn() }; const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: [song(1)] })), download: vi.fn() };
    const service = new SpotifyPlaylistImportService(createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })),
      scanLibrary: vi.fn(async () => ({ scanning: false })) }),
      playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, root, oembed, "Spotify Imports", tagger as unknown as AudioTaggerService);
    const job = await finish(service, service.start(url, user).id);
    expect(job.status).toBe("failed"); expect(job.manifest![0].error).toContain("Symlink");
    expect(tagger.verifyAndTag).not.toHaveBeenCalled(); expect(downloader.download).not.toHaveBeenCalled(); expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("SQLite restart recovery", () => {
  test("quarantines a corrupt checkpoint without losing its manifest or blocking other jobs", () => {
    const { db, repo } = repository();
    repo.save({ job: { id: "corrupt", userId: user.id, status: "running", stage: "fetching" }, playlistUrl: url, user });
    repo.save({ job: { id: "valid", userId: user.id, status: "queued", stage: "queued" }, playlistUrl: url, user });
    db.prepare("UPDATE import_jobs SET manifest_json = ? WHERE id = ?").run("unreadable original", "corrupt");
    expect(repo.unfinished().map((record) => record.job.id)).toEqual(["valid"]);
    expect(repo.get("corrupt", user.id)).toMatchObject({ job: { status: "failed" }, unreadableManifest: "unreadable original" });
  });
  test("cannot overwrite another owner's durable checkpoint", () => {
    const { repo } = repository(); repo.save({ job: { id: "owned", userId: user.id, status: "queued", stage: "queued" }, playlistUrl: url, user });
    expect(() => repo.save({ job: { id: "owned", userId: "other", status: "failed", stage: "completed" }, playlistUrl: url, user: { ...user, id: "other" } })).toThrow("another user");
    expect(repo.get("owned", user.id)?.job.status).toBe("queued");
  });
  test("retains counters and complete error manifests after close/reopen and isolates owners", () => {
    const file = path.join(temporary(), "jobs.sqlite"); const { db, repo } = repository(file);
    const job: SpotifyImportJob = { id: "job", userId: user.id, stage: "completed", status: "partial", expectedCount: 14, completedCount: 1, failedCount: 13,
      manifest: Array.from({ length: 14 }, (_, index) => ({ position: index + 1, source: song(index + 1), status: index ? "FAILED_METADATA_MISSING" : "COMPLETED", error: index ? `Missing metadata ${index}` : undefined })) };
    repo.save({ job, playlistUrl: url, user }); db.close(); const reopened = repository(file);
    expect(reopened.repo.get("job", user.id)?.job).toEqual(job);
    expect(reopened.repo.get("job", "another-owner")).toBeNull(); expect(reopened.repo.unfinished()).toEqual([]);
    const service = new SpotifyPlaylistImportService(createFakeBackend(), playlists() as unknown as PlaylistService, {} as DownloaderAdapter, temporary(), oembed, "Spotify Imports", undefined, reopened.repo);
    expect(service.get("job", user.id)?.failedCount).toBe(13);
  });
  test.each(["DOWNLOADED", "READY", "PENDING"] as const)("resumes %s checkpoint without duplicate downloads or playlist entries", async (status) => {
    const file = path.join(temporary(), "jobs.sqlite"); const root = temporary(); const source = song(1);
    const destination = path.join(root, "Primary", "Album", "Primary - Song 1.mp3"); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, "published audio");
    const entry: ImportEntry = { position: 1, source, status, filePath: destination, ...(status === "READY" ? { providerTrackId: "local-1" } : {}) };
    const { db, repo } = repository(file);
    repo.save({ job: { id: "interrupted", userId: user.id, status: "running", stage: "scanning", expectedCount: 1, playlistId: "playlist", manifest: [entry] }, playlistUrl: url, user }); db.close();
    const reopened = repository(file); const lists = playlists(); lists.hasProviderTrack.mockReturnValue(true);
    const downloader = { fetchPlaylistTracks: vi.fn(), download: vi.fn() };
    const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: [local(source)] })) as any, scanLibrary: vi.fn(async () => ({ scanning: false })) });
    const tagger = { verifyAndTag: vi.fn(async () => ({ repaired: false })) };
    const service = new SpotifyPlaylistImportService(backend, lists as unknown as PlaylistService, downloader as unknown as DownloaderAdapter, root,
      oembed, "Spotify Imports", tagger as unknown as AudioTaggerService, reopened.repo);
    service.resumeInterrupted(); service.resumeInterrupted();
    expect(await finish(service, "interrupted")).toMatchObject({ status: "completed", completedCount: 1, failedCount: 0 });
    expect(lists.create).not.toHaveBeenCalled(); expect(lists.addProviderTrack).not.toHaveBeenCalled();
    expect(downloader.download).not.toHaveBeenCalled(); expect(downloader.fetchPlaylistTracks).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination, "utf8")).toBe("published audio"); expect(reopened.repo.unfinished()).toEqual([]);
  });
  test("a disabled owner is revalidated on restart before any work", async () => {
    const { repo } = repository(); repo.save({ job: { id: "disabled", userId: user.id, stage: "queued", status: "queued" }, playlistUrl: url, user });
    const downloader = { fetchPlaylistTracks: vi.fn(), download: vi.fn() };
    const service = new SpotifyPlaylistImportService(createFakeBackend(), playlists() as unknown as PlaylistService, downloader as unknown as DownloaderAdapter,
      temporary(), oembed, "Spotify Imports", undefined, repo);
    service.resumeInterrupted(() => ({ ...user, disabled: true }));
    expect(await finish(service, "disabled")).toMatchObject({ status: "failed", error: "Import owner is disabled" }); expect(downloader.fetchPlaylistTracks).not.toHaveBeenCalled();
  });
});

describe("spotDL source metadata", () => {
  test("recovers incomplete metadata from an independent Spotify track fetch", async () => {
    const directory = temporary();
    const runner = { run: vi.fn((_command, _args, options) => {
      fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([{
        url: song(1).url, name: "Song 1", artists: [{ name: "Primary" }, { name: "Guest" }],
        album: { name: "Album", artists: [{ name: "Album Artist" }], release_date: "2024-01-01", images: [{ url: "https://i.scdn.co/image/cover" }] },
        external_ids: { isrc: "ISRC1" }, duration: 180,
      }]));
      return { promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };
    }) };
    const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner });
    const recovered = await adapter.resolveTrackMetadata({ ...song(1), title: "", artist: "", artists: [], album: "", year: undefined, artworkUrl: undefined },
      { jobId: "recovery", tmpDir: directory, signal: new AbortController().signal });
    expect(recovered).toMatchObject({ title: "Song 1", artist: "Primary", artists: ["Primary", "Guest"], album: "Album", year: "2024-01-01", artworkUrl: "https://i.scdn.co/image/cover" });
    expect(runner.run).toHaveBeenCalledOnce(); expect(fs.readdirSync(directory)).toEqual([]);
  });
  test.each(["deezer", "itunes"])("recovers missing album metadata using %s after a Spotify failure", async (provider) => {
    const directory = temporary();
    const runner = { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "Spotify unavailable" }) })) };
    const fetchImpl = vi.fn(async (input: URL) => {
      const endpoint = new URL(String(input));
      if (endpoint.hostname === "api.deezer.com") {
        if (provider === "itunes") throw new Error("Deezer unavailable");
        if (endpoint.pathname === "/search") return new Response(JSON.stringify({ data: [{ id: 1, title: "Song 1", artist: { name: "Primary" }, album: { title: "Album", cover_xl: "https://cdn-images.dzcdn.net/images/cover/example" }, duration: 180 }] }));
        return new Response(JSON.stringify({ artist: { name: "Primary" }, contributors: [{ name: "Primary" }, { name: "Guest" }], release_date: "2024-01-01", isrc: "ISRC1" }));
      }
      return new Response(JSON.stringify({ results: [{ trackName: "Song 1", artistName: "Primary", collectionName: "Album", trackTimeMillis: 180000,
        releaseDate: "2024-01-01", artworkUrl100: "https://is1-ssl.mzstatic.com/image/cover.jpg" }] }));
    });
    const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl: fetchImpl as typeof fetch });
    const recovered = await adapter.resolveTrackMetadata({ ...song(1), album: "", year: undefined, artworkUrl: undefined },
      { jobId: "fallback", tmpDir: directory, signal: new AbortController().signal });
    expect(recovered).toMatchObject({ url: song(1).url, artist: "Primary", album: "Album", year: "2024-01-01", isrc: "ISRC1" });
    expect(recovered!.artists).toContain("Guest"); expect(runner.run).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });
  test("a different album from metadata search cannot be substituted", async () => {
    const runner = { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "Unavailable" }) })) };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1, title: "Song 1", artist: { name: "Primary" }, album: { title: "Wrong Album" }, duration: 180 }],
      results: [{ trackName: "Song 1", artistName: "Primary", collectionName: "Wrong Album", trackTimeMillis: 180000, releaseDate: "2024" }] })));
    const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl: fetchImpl as typeof fetch });
    expect(await adapter.resolveTrackMetadata({ ...song(1), year: undefined }, { jobId: "wrong-album", tmpDir: temporary(), signal: new AbortController().signal })).toBeNull();
  });
  test("retains malformed entries and combines primary and featured artist arrays", async () => {
    const directory = temporary();
    const runner = { run: vi.fn((_command, _args, options) => {
      fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([null,
        { url: song(2).url, name: "Song 2", artist: "Primary", artists: ["Primary", { name: "Guest" }, " guest "], list_length: 14 }]));
      return { promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };
    }) };
    const result = await new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner }).fetchPlaylistTracks(url, { jobId: "parser", tmpDir: directory, signal: new AbortController().signal });
    expect(result.playlistLength).toBe(14); expect(result.playlistTracks).toHaveLength(2);
    expect(result.playlistTracks![0]).toMatchObject({ position: 1, title: "", artist: "" });
    expect(result.playlistTracks![1].artists!.map((artist) => artist.toLowerCase())).toEqual(["primary", "guest"]);
  });
});
