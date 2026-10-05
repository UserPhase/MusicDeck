import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AudioTaggerService, isInvalidArtist, needsMetadataRepair, type AudioTagInspection, type CanonicalAudioMetadata } from "../src/services/media/audioTaggerService.js";
import { DefaultProcessRunner, type ProcessRunner } from "../src/domain/process-runner.js";
import { SpotifyPlaylistImportService } from "../src/domain/spotify-playlist-import.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";
import type { DownloaderAdapter } from "../src/domain/downloader-adapter.js";
import type { SessionUser } from "../src/types.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-tag-test-")); directories.push(directory); return directory; }
const expected: CanonicalAudioMetadata = { title: "Crush", artists: ["2hollis", "Guest"], album: "Boy", albumArtist: "2hollis", year: "2024-01-01", isrc: "USABC2400001" };
const good: AudioTagInspection = { artist: "2hollis; Guest", albumArtist: "2hollis", title: "Crush", album: "Boy", year: "2024", isrc: "USABC2400001", hasArtwork: true };
function probe(tags: AudioTagInspection) {
  return JSON.stringify({ format: { tags: { artist: tags.artist, album_artist: tags.albumArtist, title: tags.title, album: tags.album, date: tags.year, isrc: tags.isrc } },
    streams: tags.hasArtwork ? [{ disposition: { attached_pic: 1 } }] : [] });
}

describe("AudioTaggerService", () => {
  test.each([true, false])("a cleanup lock preserves the committed repair or original tagging error: success=%s", async (successful) => {
    const directory = temporary(); const file = path.join(directory, "track.mp3"); fs.writeFileSync(file, "original");
    let probes = 0;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === "ffprobe") return { promise: Promise.resolve({ exitCode: 0, stderr: "", stdout: probe(++probes === 1 || !successful ? { ...good, artist: "Unknown Artist" } : good) }) };
      fs.writeFileSync(args[2], "repaired"); return { promise: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }) };
    });
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("EPERM: temporary scanner lock"), { code: "EPERM" }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new AudioTaggerService({ pythonPath: "python", ffprobePath: "ffprobe", processRunner: { run } as unknown as ProcessRunner });
    if (successful) await expect(service.verifyAndTag(file, expected)).resolves.toMatchObject({ repaired: true, inspection: good });
    else await expect(service.verifyAndTag(file, expected)).rejects.toThrow("post-write metadata verification");
    expect(fs.readFileSync(file, "utf8")).toBe(successful ? "repaired" : "original");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
  });
  test("detects empty and generic artists", () => {
    for (const artist of [null, "", " Unknown Artist ", "Various Artists", "Unknown Performer"]) expect(isInvalidArtist(artist)).toBe(true);
    expect(isInvalidArtist("2hollis")).toBe(false);
  });
  test.each(["artist", "albumArtist", "title", "album", "year", "isrc", "hasArtwork"] as const)("repairs missing %s", (key) => {
    expect(needsMetadataRepair({ ...good, [key]: key === "hasArtwork" ? false : null }, expected)).toBe(true);
  });
  test("validates canonical values and every featured artist", () => {
    expect(needsMetadataRepair(good, expected)).toBe(false);
    expect(needsMetadataRepair({ ...good, artist: "2hollis" }, expected)).toBe(true);
    expect(needsMetadataRepair({ ...good, albumArtist: "Unknown Artist" }, expected)).toBe(true);
    expect(needsMetadataRepair({ ...good, title: "Different song" }, expected)).toBe(true);
    expect(needsMetadataRepair({ ...good, year: "2020" }, expected)).toBe(true);
  });
  test.each([true, false])("only replaces original after successful post-write verification: %s", async (successful) => {
    const directory = temporary(); const file = path.join(directory, "track.mp3"); fs.writeFileSync(file, "original");
    let probes = 0;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === "ffprobe") return { promise: Promise.resolve({ exitCode: 0, stderr: "", stdout: probe(++probes === 1 || !successful ? { ...good, artist: "Unknown Artist" } : good) }) };
      expect(command).toBe("python"); expect(JSON.parse(args[3])).toMatchObject({ artists: "2hollis; Guest", year: "2024" });
      fs.writeFileSync(args[2], "repaired"); return { promise: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }) };
    });
    const service = new AudioTaggerService({ pythonPath: "python", ffprobePath: "ffprobe", processRunner: { run } as unknown as ProcessRunner });
    if (successful) await expect(service.verifyAndTag(file, expected)).resolves.toMatchObject({ repaired: true, inspection: good });
    else await expect(service.verifyAndTag(file, expected)).rejects.toThrow("post-write");
    expect(fs.readFileSync(file, "utf8")).toBe(successful ? "repaired" : "original");
    expect(fs.readdirSync(directory)).toEqual(["track.mp3"]); expect(probes).toBe(2);
  });
  test("honors the configured FFmpeg directory and runtime settings", async () => {
    let configured = "C:/custom/ffmpeg.exe";
    const run = vi.fn(() => ({ promise: Promise.resolve({ exitCode: 0, stderr: "", stdout: probe(good) }) }));
    const service = new AudioTaggerService({ getTools: () => ({ ffmpegPath: configured }), processRunner: { run } as unknown as ProcessRunner });
    await service.inspect("unused.mp3"); configured = "D:/new-tools/ffmpeg.exe"; await service.inspect("unused.mp3");
    expect(run.mock.calls).toHaveLength(2);
    expect((run.mock.calls as unknown as Array<[string]>).map(([command]) => command)).toEqual([path.join("C:/custom", "ffprobe.exe"), path.join("D:/new-tools", "ffprobe.exe")]);
  });
  test("never replaces original when the native merge fails", async () => {
    const directory = temporary(); const file = path.join(directory, "track.mp3"); fs.writeFileSync(file, "original");
    const run = vi.fn((command: string) => ({ promise: Promise.resolve(command === "ffprobe"
      ? { exitCode: 0, stderr: "", stdout: probe({ ...good, title: null }) }
      : { exitCode: 1, stderr: "Unrelated frame changed", stdout: "" }) }));
    const service = new AudioTaggerService({ ffprobePath: "ffprobe", processRunner: { run } as unknown as ProcessRunner });
    await expect(service.verifyAndTag(file, expected)).rejects.toThrow("Unrelated frame changed");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
  test("falls back to native metadata inspection only when ffprobe is missing", async () => {
    const run = vi.fn((command: string) => {
      if (command === "missing-ffprobe") return { promise: Promise.reject(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" })) };
      expect(command).toBe("spotdl-python");
      return { promise: Promise.resolve({ exitCode: 0, stdout: JSON.stringify(good), stderr: "" }) };
    });
    const service = new AudioTaggerService({ ffprobePath: "missing-ffprobe", pythonPath: "spotdl-python", processRunner: { run } as unknown as ProcessRunner });
    await expect(service.inspect("track.mp3")).resolves.toEqual(good); expect(run).toHaveBeenCalledTimes(2);
  });
  test("does not hide corrupt audio reported by ffprobe", async () => {
    const run = vi.fn(() => ({ promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "Invalid audio" }) }));
    const service = new AudioTaggerService({ processRunner: { run } as unknown as ProcessRunner });
    await expect(service.inspect("track.mp3")).rejects.toThrow("Invalid audio"); expect(run).toHaveBeenCalledOnce();
  });
});

// Opt-in media tests also auto-detect the isolated dependencies used in this workspace.
// CI may supply MUSICDECK_MEDIA_TEST_PYTHON / FFMPEG / FFPROBE and its usual Python environment.
const deps = path.resolve("node_modules/.musicdeck-media-tests");
const python = process.env.MUSICDECK_MEDIA_TEST_PYTHON || "python";
const environment = { ...process.env, ...(fs.existsSync(deps) ? { PYTHONPATH: [deps, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}) };
const detected = spawnSync(python, ["-c", "import mutagen, imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], { env: environment, encoding: "utf8", windowsHide: true });
const ffmpeg = process.env.MUSICDECK_MEDIA_TEST_FFMPEG || (detected.status === 0 ? detected.stdout.trim() : "");
const ffprobe = process.env.MUSICDECK_MEDIA_TEST_FFPROBE || path.join(deps, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
function execute(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { env: environment, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error)); return result.stdout.trim();
}
const fixture = String.raw`
import sys
from mutagen import File
from mutagen.id3 import ID3, TPE1, TRCK, TPOS, TCON, TXXX, APIC
from mutagen.flac import Picture
from mutagen.mp4 import MP4Cover
f, cover = sys.argv[1:]; data = open(cover, 'rb').read()
if f.endswith('.mp3'):
    t = ID3(f); t.add(TPE1(encoding=3, text=['Unknown Artist']))
    t.add(TRCK(encoding=3, text=['7/12'])); t.add(TPOS(encoding=3, text=['2/2']))
    t.add(TCON(encoding=3, text=['Alternative'])); t.add(TXXX(encoding=3, desc='REPLAYGAIN_TRACK_GAIN', text=['-7.25 dB']))
    t.add(TXXX(encoding=3, desc='MusicDeck private frame', text=['must survive']))
    t.add(APIC(encoding=3, type=3, mime='image/png', desc='Original cover', data=data)); t.save(f)
else:
    a = File(f)
    if a.tags is None: a.add_tags()
    if f.endswith('.m4a'):
        a.tags['\xa9ART'] = ['Unknown Artist']; a.tags['trkn'] = [(7,12)]; a.tags['disk'] = [(2,2)]
        a.tags['\xa9gen'] = ['Alternative']; a.tags['----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN'] = [b'-7.25 dB']
        a.tags['----:com.apple.iTunes:PRIVATE'] = [b'must survive']; a.tags['covr'] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_PNG)]
    else:
        a.tags['artist'] = ['Unknown Artist']; a.tags['tracknumber'] = ['7/12']; a.tags['discnumber'] = ['2/2']
        a.tags['genre'] = ['Alternative']; a.tags['REPLAYGAIN_TRACK_GAIN'] = ['-7.25 dB']; a.tags['PRIVATE'] = ['must survive']
        p = Picture(); p.type=3; p.mime='image/png'; p.data=data; a.add_picture(p)
    a.save()
`;
const secondaryTags = String.raw`
import sys, json, hashlib
from mutagen import File
from mutagen.id3 import ID3
f=sys.argv[1]
if f.endswith('.mp3'):
    t=ID3(f); result={k:v.pprint() for k,v in t.items() if k.startswith(('TRCK','TPOS','TCON','TXXX'))}
    result['cover']=[hashlib.sha256(p.data).hexdigest() for p in t.getall('APIC')]
else:
    a=File(f); keys=['trkn','disk','\xa9gen','----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN','----:com.apple.iTunes:PRIVATE','covr'] if f.endswith('.m4a') else ['tracknumber','discnumber','genre','replaygain_track_gain','PRIVATE']
    result={k:repr(a.tags[k]) for k in keys}
    result['cover']=[hashlib.sha256(p.data).hexdigest() for p in getattr(a,'pictures',[])]
print(json.dumps(result,sort_keys=True))
`;
describe.skipIf(!ffmpeg || !fs.existsSync(ffprobe))("native container integration", () => {
  test("imports all 14 existing MP3s using native tag repair when ffprobe is absent", async () => {
    const root = temporary(); const fixtureAudio = path.join(root, "fixture.mp3"); const cover = path.join(root, "cover.png");
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-y", fixtureAudio]);
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=32x32", "-frames:v", "1", "-y", cover]);
    execute(python, ["-c", fixture, fixtureAudio, cover]);
    const sources = Array.from({ length: 14 }, (_, index) => ({ position: index + 1, url: `https://open.spotify.com/track/song${index + 1}`,
      title: `Song ${index + 1}`, artist: "2hollis", artists: ["2hollis", "Guest"], album: "Boy", albumArtist: "2hollis", duration: 0.2, year: "2024",
      isrc: `USABC${String(index + 1).padStart(7, "0")}`, artworkUrl: "https://i.scdn.co/image/cover" }));
    for (const source of sources) {
      const file = path.join(root, "2hollis, Guest", "Boy", `2hollis, Guest - ${source.title}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(fixtureAudio, file);
    }
    const runner = new DefaultProcessRunner(); let scanned = false;
    const tagger = new AudioTaggerService({ ffprobePath: path.join(root, "missing-ffprobe.exe"), pythonPath: python,
      processRunner: { run: (command, args, options) => runner.run(command, args, { ...options, env: { PYTHONPATH: environment.PYTHONPATH || "" } }) } });
    const backend = { search: vi.fn(async (query: string) => ({ artists: [], albums: [], tracks: scanned ? sources.filter((source) => source.title === query).map((source) => ({
      id: `local-${source.position}`, title: source.title, artistName: source.artist, albumName: source.album, durationSeconds: source.duration, identityHints: { isrc: source.isrc },
    })) : [] })), scanLibrary: vi.fn(async () => { scanned = true; return { scanning: false }; }) };
    const downloader = { fetchPlaylistTracks: vi.fn(async () => ({ status: "completed", files: [], playlistTracks: sources, playlistLength: 14 })), download: vi.fn() };
    const playlists = { create: vi.fn(async () => ({ id: "playlist", name: "14 songs" })), addProviderTrack: vi.fn(async () => ({ added: true })) };
    const user = { id: "user" } as SessionUser;
    const service = new SpotifyPlaylistImportService(backend as unknown as MusicBackend, playlists as unknown as PlaylistService,
      downloader as unknown as DownloaderAdapter, root, vi.fn(async () => new Response("{}")) as typeof fetch, "Spotify Imports", tagger);
    const started = service.start("https://open.spotify.com/playlist/playlist14", user);
    const deadline = Date.now() + 15000;
    while (["queued", "running"].includes(service.get(started.id, user.id)!.status) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.get(started.id, user.id)).toMatchObject({ status: "completed", expectedCount: 14, completedCount: 14, importedCount: 14, failedCount: 0 });
    expect(downloader.download).not.toHaveBeenCalled(); expect(playlists.addProviderTrack).toHaveBeenCalledTimes(14); expect(backend.scanLibrary).toHaveBeenCalledOnce();
  }, 20000);
  test.each(["mp3", "flac", "m4a"])("repairs and verifies %s without ffprobe installed", async (extension) => {
    const directory = temporary(); const audio = path.join(directory, "track." + extension); const cover = path.join(directory, "cover.png");
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-y", audio]);
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=32x32", "-frames:v", "1", "-y", cover]);
    execute(python, ["-c", fixture, audio, cover]);
    const before = execute(python, ["-c", secondaryTags, audio]); const runner = new DefaultProcessRunner();
    const service = new AudioTaggerService({ ffprobePath: path.join(directory, "uninstalled-ffprobe.exe"), pythonPath: python,
      processRunner: { run: (command, args, options) => runner.run(command, args, { ...options, env: { PYTHONPATH: environment.PYTHONPATH || "" } }) } });
    expect((await service.inspect(audio)).hasArtwork).toBe(true);
    await expect(service.verifyAndTag(audio, expected)).resolves.toMatchObject({ repaired: true, inspection: good });
    expect(execute(python, ["-c", secondaryTags, audio])).toBe(before);
    await expect(service.verifyAndTag(audio, expected)).resolves.toMatchObject({ repaired: false });
  });
  test("repairs spotDL-style ID3v2.3 files without losing their release year", async () => {
    const directory = temporary(); const audio = path.join(directory, "track.mp3"); const cover = path.join(directory, "cover.png");
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-y", audio]);
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=32x32", "-frames:v", "1", "-y", cover]);
    execute(python, ["-c", fixture, audio, cover]);
    execute(python, ["-c", "from mutagen.id3 import ID3; import sys; tags=ID3(sys.argv[1]); tags.update_to_v23(); tags.save(sys.argv[1], v2_version=3)", audio]);
    const runner = new DefaultProcessRunner();
    const service = new AudioTaggerService({ ffprobePath: ffprobe, pythonPath: python,
      processRunner: { run: (command, args, options) => runner.run(command, args, { ...options, env: { PYTHONPATH: environment.PYTHONPATH || "" } }) } });
    await expect(service.verifyAndTag(audio, expected)).resolves.toMatchObject({ repaired: true, inspection: { year: "2024" } });
  });
  test.each(["mp3", "flac", "m4a"])("adds cached cover art to %s when no embedded picture exists", async (extension) => {
    const directory = temporary(); const audio = path.join(directory, "track." + extension); const cover = path.join(directory, "cover.png");
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-y", audio]);
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=32x32", "-frames:v", "1", "-y", cover]);
    const runner = new DefaultProcessRunner(); const fetchImpl = vi.fn(async () => new Response(fs.readFileSync(cover), { headers: { "content-type": "image/png" } }));
    const service = new AudioTaggerService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, pythonPath: python, fetchImpl: fetchImpl as typeof fetch,
      processRunner: { run: (command, args, options) => runner.run(command, args, { ...options, env: { PYTHONPATH: environment.PYTHONPATH || "" } }) } });
    expect((await service.inspect(audio)).hasArtwork).toBe(false);
    await expect(service.verifyAndTag(audio, { ...expected, artworkUrl: "https://i.scdn.co/image/cover" })).resolves.toMatchObject({ repaired: true, inspection: { hasArtwork: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await service.verifyAndTag(audio, expected)).repaired).toBe(false);
  });
  test.each(["mp3", "flac", "m4a"])("preserves %s audio, artwork, track/disc numbers, genre, ReplayGain and custom tags", async (extension) => {
    const directory = temporary(); const audio = path.join(directory, "track." + extension); const cover = path.join(directory, "cover.png");
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-y", audio]);
    execute(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=32x32", "-frames:v", "1", "-y", cover]);
    execute(python, ["-c", fixture, audio, cover]);
    const before = execute(python, ["-c", secondaryTags, audio]);
    const hash = () => execute(ffmpeg, ["-v", "error", "-i", audio, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"]);
    const beforeAudio = hash(); const fetchImpl = vi.fn(); const runner = new DefaultProcessRunner();
    const service = new AudioTaggerService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, pythonPath: python, fetchImpl,
      processRunner: { run: (command, args, options) => runner.run(command, args, { ...options, env: { PYTHONPATH: environment.PYTHONPATH || "" } }) } });
    await expect(service.verifyAndTag(audio, { ...expected, artworkUrl: "https://i.scdn.co/image/unused" })).resolves.toMatchObject({ repaired: true });
    expect(execute(python, ["-c", secondaryTags, audio])).toBe(before); expect(hash()).toBe(beforeAudio);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.verifyAndTag(audio, expected)).resolves.toMatchObject({ repaired: false });
  });
});
