import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeezerImportMatcher } from "../src/services/discovery/deezerImportMatcher.js";
import { SpotDLDownloaderAdapter, redactSpotDLDiagnostics, classifySpotDLError } from "../src/domain/spotdl-downloader-adapter.js";
import { SpotifyPlaylistImportService } from "../src/domain/spotify-playlist-import.js";
import type { SpotifyImportTrackMetadata } from "../src/domain/downloader-adapter.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import type { AudioTaggerService } from "../src/services/media/audioTaggerService.js";
import type { SessionUser } from "../src/types.js";
import { createFakeBackend } from "./helpers.js";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrations.js";
import { SqliteImportJobRepository } from "../src/infrastructure/persistence/sqliteImportJobRepository.js";

const dirs: string[] = [];
const databases: Database.Database[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-deezer-fallback-")); dirs.push(dir); return dir; };
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const source: SpotifyImportTrackMetadata = { position: 1, url: "https://open.spotify.com/track/2qGvgsRsmrB0Y7Y4MmuP1M",
  title: "We Do What We Want - Edit", artist: "Alan Fitzpatrick", artists: ["Alan Fitzpatrick"], duration: 188,
  album: "We Do What We Want (Edit)", albumArtist: "Alan Fitzpatrick", year: "2024", artworkUrl: "https://i.scdn.co/image/cover" };
const deezer = (overrides: Record<string, unknown> = {}) => ({ id: 123, title: "We Do What We Want (Edit)", artist: { name: source.artist },
  album: { title: source.album, cover_xl: "https://cdn-images.dzcdn.net/cover.jpg" }, duration: 188,
  release_date: "2024-01-01", isrc: "GBABC2400001", contributors: [{ name: source.artist }], ...overrides });
const response = (data: unknown) => new Response(JSON.stringify(data));
const context = (dir: string) => ({ jobId: "test", tmpDir: dir, signal: new AbortController().signal });

describe("Deezer import metadata matching", () => {
  test("uses ISRC first and caches the validated match without leaking playlist positions", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL) => response(deezer()));
    const matcher = new DeezerImportMatcher(fetchImpl as typeof fetch);
    const first = await matcher.match({ ...source, isrc: "GBABC2400001" }, new AbortController().signal);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/track/isrc:GBABC2400001");
    expect(first).toMatchObject({ detail: "Matched Deezer by ISRC", track: { title: "We Do What We Want (Edit)" } });
    const second = await matcher.match({ ...source, isrc: "GBABC2400001", position: 7, url: "other" }, new AbortController().signal);
    expect(second.track).toMatchObject({ position: 7, url: "other" }); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  test.each([
    { title: "We Do What We Want" }, { title: "We Do What We Want (Live)" },
    { artist: { name: "Other artist" } }, { duration: 240 }, { duration: 0 }, { isrc: "GBABC2400002" },
  ])("rejects a different recording: %j", async (wrong) => {
    const fetchImpl = vi.fn(async (input: string | URL) => String(input).includes("/search")
      ? response({ data: [deezer(wrong)] }) : response(deezer(wrong)));
    const match = await new DeezerImportMatcher(fetchImpl as typeof fetch).match({ ...source, isrc: "GBABC2400001" }, new AbortController().signal);
    expect(match.track).toBeNull();
  });
  test("falls back to artist/title when an ISRC lookup is unavailable and validates full track metadata", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => String(input).includes("/isrc:") ? new Response("", { status: 404 })
      : String(input).includes("/search") ? response({ data: [deezer()] }) : response(deezer()));
    const match = await new DeezerImportMatcher(fetchImpl as typeof fetch).match({ ...source, isrc: "GBABC2400001" }, new AbortController().signal);
    expect(match.detail).toBe("Matched Deezer by artist, title and duration");
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("q")).toBe(`${source.artist} ${source.title}`);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  test("provider errors and no matches retain the original identity", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const match = await new DeezerImportMatcher(fetchImpl as typeof fetch).match(source, new AbortController().signal);
    expect(match).toEqual({ track: null, detail: "Deezer returned HTTP 503" });
    const empty = await new DeezerImportMatcher(async () => response({ data: [] })).match(source, new AbortController().signal);
    expect(empty.track).toBeNull();
  });
});

describe("spotDL cached metadata and audio fallback", () => {
  test.each([true, false])("fallback downloads from cached metadata with or without a Deezer match: %s", async (matched) => {
    const dir = temp();
    const runner = { run: vi.fn((_command, args, options) => {
      const song = JSON.parse(fs.readFileSync(args.at(-1), "utf8"))[0];
      expect(song).toMatchObject({ name: source.title, album_name: source.album, artists: source.artists,
        album_id: "", genres: [], disc_count: 1, tracks_count: 0, track_number: 0, cover_url: source.artworkUrl });
      expect(song.album_artist).toBe(source.artist); expect(song.year).toBe(2024);
      fs.writeFileSync(path.join(options.cwd, "audio.mp3"), "audio");
      return { promise: Promise.resolve({ exitCode: 0, stdout: "Downloaded audio", stderr: "" }) };
    }) };
    const fetchImpl = vi.fn(async (input: string | URL) => String(input).includes("/search")
      ? response({ data: matched ? [deezer()] : [] }) : response(deezer()));
    const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.download({ spotifyTrackUrl: source.url, canonicalMetadata: source, broadenAudioSearch: true, outputDirectory: dir }, context(dir));
    expect(result.status).toBe("completed");
    expect(result.diagnostics?.strategy).toBe(matched ? "deezer-assisted" : "cached-metadata");
    const args = runner.run.mock.calls[0][1] as string[];
    const queryTemplate = args[args.indexOf("--search-query") + 1];
    expect(queryTemplate).toBe(`{artist} - ${matched ? "We Do What We Want (Edit)" : source.title}`);
    // spotDL/formatter.py adds a default prefix when the template has no variables.
    const effectiveTemplate = /\{(?:artist|artists|title)\}/.test(queryTemplate) ? queryTemplate : `{artist} - {title}${queryTemplate}`;
    const actualQuery = effectiveTemplate.replaceAll("{artist}", source.artist).replaceAll("{title}", source.title);
    expect(actualQuery).toBe(`${source.artist} - ${matched ? "We Do What We Want (Edit)" : source.title}`);
    expect(args.at(-1)).toBe(path.join(dir, "musicdeck-track.spotdl")); expect(args).not.toContain(source.url);
    expect(args).toContain("soundcloud");
    expect(args.slice(args.indexOf("--audio") + 1, args.indexOf("--id3-separator"))).toEqual(["soundcloud", "youtube", "youtube-music"]);
  });
  test("normal playlist downloads use cached metadata without adding a Deezer network lookup", async () => {
    const dir = temp(); const fetchImpl = vi.fn();
    const runner = { run: vi.fn((_command, args) => {
      expect(args.at(-1)).toBe(path.join(dir, "musicdeck-track.spotdl"));
      return { promise: Promise.resolve({ exitCode: 0, stdout: "AudioProviderError: No usable results", stderr: "" }) };
    }) };
    const result = await new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl }).download(
      { spotifyTrackUrl: source.url, canonicalMetadata: { ...source, trackNumber: 3, tracksCount: 10, discNumber: 2, discCount: 2 }, outputDirectory: dir }, context(dir));
    expect(result.status).toBe("failed"); expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "musicdeck-track.spotdl"), "utf8"))[0]).toMatchObject({ track_number: 3, tracks_count: 10, disc_number: 2, disc_count: 2, isrc: "" });
  });
  test("retains wrapped error context and redacts secrets before returning diagnostics", async () => {
    const dir = temp(); const stdout = "ERROR No results found for                 base.py:408\n                  Alan Fitzpatrick - We Do What We Want (Edit)\n";
    const runner = { run: vi.fn(() => ({ promise: Promise.resolve({ exitCode: 0, stdout,
      stderr: "{'client_secret': 'private-secret', 'auth_token': 'private-token', 'cookie_file': 'private-cookie'}\nAuthorization: Bearer private-bearer" }) })) };
    const result = await new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, clientSecret: "private-secret" }).download(
      { spotifyTrackUrl: source.url, outputDirectory: dir }, context(dir));
    expect(result.error?.message).toContain("Alan Fitzpatrick - We Do What We Want (Edit)");
    expect(result.diagnostics?.output).toContain("No results found for");
    expect(result.diagnostics?.output).not.toMatch(/private-/);
    expect(redactSpotDLDiagnostics("a".repeat(60_000))).toHaveLength(24_020);
    expect(redactSpotDLDiagnostics("{'auth_token': 'wrapped\n                secret'} access_token=unquoted")).not.toMatch(/wrapped|secret|unquoted/);
  });
  test("retains partial process output when the downloader times out", async () => {
    const dir = temp();
    const runner = { run: vi.fn((_command, _args, options) => {
      options.onStdoutChunk("Searching YouTube for Alan Fitzpatrick\n");
      options.onStderrChunk("auth_token=private-token\n");
      return { promise: Promise.reject(new Error("Process timed out after 300000ms")) };
    }) };
    const result = await new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner }).download(
      { spotifyTrackUrl: source.url, outputDirectory: dir }, context(dir));
    expect(result.diagnostics?.output).toContain("Searching YouTube for Alan Fitzpatrick");
    expect(result.diagnostics?.output).toContain("timed out"); expect(result.diagnostics?.output).not.toContain("private-token");
  });
});

const lyricsNoise = "[23:02:33] DEBUG asyncio_0 - Genius: Failed to get results: Received HTTP 429 from https://api.genius.com/search\n"
  + "[23:02:33] DEBUG asyncio_0 - MusixMatch: Failed to get results: Received HTTP 403\n"
  + "[23:02:33] DEBUG asyncio_0 - Genius failed to find lyrics for track\n";
describe("actual audio failures and optional lyric-provider errors", () => {
  test.each([
    ["AudioProviderError: ERROR: unable to download video data: HTTP Error 403: Forbidden", "retryable"],
    ["AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=OHdWOgdootw", "retryable"],
    ["AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=zaM5rkSvdZQ", "retryable"],
    ["LookupError: No results found for song: Enmity - Hot & Cold - Sped Up", "not-found"],
    ["ERROR: [youtube] abc: HTTP Error 429: Too Many Requests", "rate-limited"],
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", "authentication-failed"],
  ])("classifies the terminal audio error despite lyrics noise: %s", (error, expected) => {
    expect(classifySpotDLError(lyricsNoise + error)).toBe(expected);
  });
  test("does not mistake an artist name for a lyrics provider or a song ID for a rate-limit code", () => {
    expect(classifySpotDLError(lyricsNoise + "LookupError: No results found for song: Perfume Genius - Lyrics 429")).toBe("not-found");
  });
  test("keeps the root cause in the middle of a large Rich traceback and removes generic debug tokens", () => {
    const frame = "                    |    88 self.future.set_exception(exc)                              |\n";
    const output = redactSpotDLDiagnostics("{'genius_token':\n                    'private-genius'}\n"
      + frame.repeat(500) + "AudioProviderError: ERROR: unable to download video data: HTTP Error 403: Forbidden\n" + frame.repeat(500));
    expect(output).toContain("HTTP Error 403: Forbidden"); expect(output).not.toContain("private-genius");
    expect(output.length).toBeLessThan(500);
  });
});

test("recovers the four skipped retries in a 15-track import while reusing the other 11 tracks", async () => {
  const root = temp(); let scanned = false;
  const failures = new Map<number, string>([
    [2, "AudioProviderError: ERROR: unable to download video data: HTTP Error 403: Forbidden"],
    [9, "AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=OHdWOgdootw"],
    [13, "AudioProviderError: YT-DLP download error - https://www.youtube.com/watch?v=zaM5rkSvdZQ"],
    [15, "LookupError: No results found for song: Enmity - Hot & Cold - Sped Up"],
  ]);
  const sources = Array.from({ length: 15 }, (_, index) => ({ ...source, position: index + 1, title: `Song ${index + 1}`,
    url: `https://open.spotify.com/track/track${index + 1}` }));
  Object.assign(sources[1], { title: "Babydoll", artist: "Dominic Fike", artists: ["Dominic Fike"] });
  Object.assign(sources[8], { title: "Earrings", artist: "Malcolm Todd", artists: ["Malcolm Todd"] });
  Object.assign(sources[12], { title: "Let Go", artist: "Ark Patrol", artists: ["Ark Patrol", "Veronika Redd"] });
  Object.assign(sources[14], { title: "Hot & Cold - Sped Up", artist: "Enmity", artists: ["Enmity", "Lxminal"] });
  const runner = { run: vi.fn((_command, args, options) => {
    if (args.includes("save")) {
      fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify(sources.map((s) => ({ name: s.title,
        artist: s.artist, artists: s.artists, url: s.url, list_position: s.position, list_length: 15, duration: s.duration,
        album_name: s.album, album_artist: s.albumArtist, year: s.year, cover_url: s.artworkUrl }))));
    } else {
      const metadata = JSON.parse(fs.readFileSync(args.at(-1), "utf8"))[0];
      const s = sources.find((s) => s.url === metadata.url)!;
      if (!args.includes("--search-query")) return { promise: Promise.resolve({ exitCode: 0, stdout: lyricsNoise + failures.get(s.position), stderr: "" }) };
      expect(args[args.indexOf("--audio") + 1]).toBe("soundcloud");
      expect(args[args.indexOf("--max-retries") + 1]).toBe("5"); expect(args).toContain("--print-errors");
      const file = path.join(options.cwd, metadata.artists.join(", "), metadata.album_name, `${metadata.artists.join(", ")} - ${metadata.name}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "audio");
    }
    return { promise: Promise.resolve({ exitCode: 0, stdout: "Finished", stderr: "" }) };
  }) };
  const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl: async () => response({ data: [] }) });
  const backend = createFakeBackend({ search: vi.fn(async (query) => {
    const s = sources.find((s) => s.title === query)!;
    return { artists: [], albums: [], tracks: failures.has(s.position) && !scanned ? [] : [{ id: `local-${s.position}`,
      title: s.title, artistName: s.artist, albumName: s.album, durationSeconds: s.duration }] };
  }) as any, scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
  const playlists = { create: vi.fn(async () => ({ id: "playlist", name: "Imported" })), addProviderTrack: vi.fn(async () => ({ added: true })) };
  const tagger = { verifyAndTag: vi.fn(async () => ({ repaired: false })) };
  const service = new SpotifyPlaylistImportService(backend, playlists as unknown as PlaylistService, adapter, root,
    async () => response({}), "Spotify Imports", tagger as unknown as AudioTaggerService);
  const user = { id: "owner", disabled: false } as SessionUser;
  const initial = service.start("https://open.spotify.com/playlist/test", user);
  for (let n = 0; n < 400 && ["queued", "running"].includes(service.get(initial.id, user.id)!.status); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  const job = service.get(initial.id, user.id)!;
  expect(job).toMatchObject({ status: "completed", expectedCount: 15, completedCount: 15, failedCount: 0 });
  for (const entry of job.manifest!) {
    if (failures.has(entry.position)) expect(entry.downloadAttempts).toMatchObject([
      { status: "failed", errorCode: entry.position === 15 ? "not-found" : "retryable" }, { status: "completed" },
    ]);
    else expect(entry.downloadAttempts).toBeUndefined();
  }
  expect(runner.run.mock.calls.filter((call) => call[1].includes("download"))).toHaveLength(8);
  expect(tagger.verifyAndTag).toHaveBeenCalledTimes(4); expect(playlists.addProviderTrack).toHaveBeenCalledTimes(15);
});

test.each([true, false])("continues past a protected SoundCloud match with isolated staging; YouTube recovery=%s", async (recover) => {
  const root = temp(); let scanned = false; const contexts: string[] = [];
  const runner = { run: vi.fn((_command, args, options) => {
    if (args.includes("save")) {
      fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([{ name: source.title,
        artist: source.artist, artists: source.artists, url: source.url, duration: source.duration, album_name: source.album,
        year: source.year, cover_url: source.artworkUrl }]));
    } else {
      contexts.push(options.cwd);
      const providers = args.slice(args.indexOf("--audio") + 1, args.indexOf("--id3-separator"));
      if (!args.includes("--search-query")) return { promise: Promise.resolve({ exitCode: 0, stdout: "LookupError: No results found for song", stderr: "" }) };
      expect(providers).toHaveLength(1);
      if (providers[0] === "soundcloud") {
        fs.writeFileSync(path.join(options.cwd, "partial.mp3"), "incomplete audio");
        return { promise: Promise.resolve({ exitCode: 1, stdout: "AudioProviderError: ERROR: This video is DRM protected", stderr: "" }) };
      }
      expect(fs.existsSync(path.join(contexts[1], "partial.mp3"))).toBe(false);
      if (!recover) return { promise: Promise.resolve({ exitCode: 0, stdout: "LookupError: No results found for song", stderr: "" }) };
      expect(providers).toEqual(["youtube"]);
      const file = path.join(options.cwd, source.artist, source.album!, `${source.artist} - ${source.title}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "audio");
    }
    return { promise: Promise.resolve({ exitCode: 0, stdout: "Finished", stderr: "" }) };
  }) };
  const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner, fetchImpl: async () => response({ data: [] }) });
  const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: scanned
    ? [{ id: "local", title: source.title, artistName: source.artist, albumName: source.album, durationSeconds: source.duration }] : [] })) as any,
    scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
  const playlists = { create: vi.fn(async () => ({ id: "playlist", name: "Imported" })), addProviderTrack: vi.fn(async () => ({ added: true })) };
  const tagger = { verifyAndTag: vi.fn(async () => ({ repaired: false })) };
  const service = new SpotifyPlaylistImportService(backend, playlists as unknown as PlaylistService, adapter, root,
    async () => response({}), "Spotify Imports", tagger as unknown as AudioTaggerService);
  const user = { id: "owner", disabled: false } as SessionUser;
  const initial = service.start("https://open.spotify.com/playlist/test", user);
  for (let n = 0; n < 400 && ["queued", "running"].includes(service.get(initial.id, user.id)!.status); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  const job = service.get(initial.id, user.id)!;
  expect(job).toMatchObject({ status: recover ? "completed" : "failed", completedCount: recover ? 1 : 0, failedCount: recover ? 0 : 1 });
  const attempts = job.manifest![0].downloadAttempts!;
  expect(attempts.map((attempt) => attempt.diagnostics?.audioProvider)).toEqual(recover
    ? [undefined, "soundcloud", "youtube"] : [undefined, "soundcloud", "youtube", "youtube-music"]);
  expect(attempts[1].error).toContain("DRM protected"); expect(contexts.every((dir) => !fs.existsSync(dir))).toBe(true);
  expect(tagger.verifyAndTag).toHaveBeenCalledTimes(recover ? 1 : 0);
  expect(playlists.addProviderTrack).toHaveBeenCalledTimes(recover ? 1 : 0);
});

test("the previously failing one-song import uses the fallback, verifies tags, links and persists both attempts", async () => {
  const root = temp(); let scanned = false;
  const runner = { run: vi.fn((_command, args, options) => {
    if (args.includes("save")) {
      fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([{ name: source.title, artist: source.artist,
        artists: source.artists, url: source.url, duration: source.duration, album_name: source.album, year: source.year, cover_url: source.artworkUrl }]));
    } else if (!args.includes("--search-query")) {
      return { promise: Promise.resolve({ exitCode: 0, stdout: "AudioProviderError: No usable results", stderr: "" }) };
    } else {
      const file = path.join(options.cwd, source.artist, source.album!, `${source.artist} - ${source.title}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "audio");
    }
    return { promise: Promise.resolve({ exitCode: 0, stdout: "Finished", stderr: "" }) };
  }) };
  const adapter = new SpotDLDownloaderAdapter({ runner: runner as unknown as ProcessRunner,
    fetchImpl: (async (input) => String(input).includes("/search") ? response({ data: [deezer()] }) : response(deezer())) as typeof fetch });
  const backend = createFakeBackend({ search: vi.fn(async () => ({ artists: [], albums: [], tracks: scanned
    ? [{ id: "local", title: source.title, artistName: source.artist, albumName: source.album, durationSeconds: 188 }] : [] })) as any,
    scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) });
  const playlists = { create: vi.fn(async () => ({ id: "playlist", name: "Imported" })), addProviderTrack: vi.fn(async () => ({ added: true })) };
  const tagger = { verifyAndTag: vi.fn(async (_file, metadata) => {
    expect(metadata).toMatchObject({ title: source.title, artists: source.artists, album: source.album }); return { repaired: false };
  }) };
  const databaseFile = path.join(temp(), "jobs.sqlite");
  const db = new Database(databaseFile); databases.push(db); runMigrations(db);
  const repository = new SqliteImportJobRepository(db);
  const service = new SpotifyPlaylistImportService(backend, playlists as unknown as PlaylistService, adapter, root,
    async () => response({}), "Spotify Imports", tagger as unknown as AudioTaggerService, repository);
  const user = { id: "owner", disabled: false } as SessionUser;
  const initial = service.start("https://open.spotify.com/playlist/test", user);
  for (let n = 0; n < 400 && ["queued", "running"].includes(service.get(initial.id, user.id)!.status); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  const job = service.get(initial.id, user.id)!;
  expect(job).toMatchObject({ status: "completed", expectedCount: 1, completedCount: 1, failedCount: 0 });
  expect(job.manifest![0].downloadAttempts).toMatchObject([
    { status: "failed", diagnostics: { strategy: "cached-metadata", output: expect.stringContaining("No usable results") } },
    { status: "completed", diagnostics: { strategy: "deezer-assisted" } },
  ]);
  db.close();
  const reopened = new Database(databaseFile); databases.push(reopened);
  const durable = new SqliteImportJobRepository(reopened).get(initial.id, user.id)!;
  expect(durable.job.manifest![0].downloadAttempts).toEqual(job.manifest![0].downloadAttempts);
  expect(runner.run.mock.calls.filter((call) => call[1].includes("download")).every((call) => !fs.existsSync(call[2].cwd))).toBe(true);
  expect(tagger.verifyAndTag).toHaveBeenCalledOnce(); expect(playlists.addProviderTrack).toHaveBeenCalledWith(expect.any(String), "local");
});
