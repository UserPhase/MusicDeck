import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { LoudnessService, parseLoudness, measuredPlaybackGain } from "../src/services/media/loudnessService.js";
import { registerLoudnessRoutes, isAllowedPreview } from "../src/routes/loudness-routes.js";
import { DefaultProcessRunner, type ProcessRunner } from "../src/domain/process-runner.js";
import { autoDetectFFmpegPath } from "../src/domain/spotdl-downloader-adapter.js";
import { createSession } from "../src/auth/sessions.js";
import type { StreamResult } from "../src/backends/stream-provider.js";
import { LibraryService } from "../src/domain/library.js";
import type { SourceResolver } from "../src/domain/source-resolver.js";
import type { SourceProviderRegistry } from "../src/domain/source-provider-registry.js";

const measurement = JSON.stringify({ input_i: "-25", input_tp: "-12", input_lra: "2", input_thresh: "-35", target_offset: "0", output_i: "-16", output_tp: "-3" });
function source(bytes = Buffer.from("original")): StreamResult {
  return { body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), status: 200, headers: new Headers() };
}
function stubRunner(): ProcessRunner {
  return { run: vi.fn((_binary: string, args: string[]) => {
    const promise = (async () => {
      if (args.at(-1) !== "-") await fs.promises.writeFile(args.at(-1)!, "prepared audio");
      const verifying = args.some(arg => path.basename(arg).startsWith("output.")) && args.at(-1) === "-";
      return { exitCode: 0, stdout: "", stderr: verifying ? measurement.replace('"-25"', '"-16"') : measurement };
    })();
    return { promise, kill() {} };
  }) };
}

describe("automatic playback loudness", () => {
  let db: Database.Database;
  let directory: string;
  let service: LoudnessService;
  let runner: ProcessRunner;
  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db);
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musicdeck-loudness-test-"));
    runner = stubRunner();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "configured-ffmpeg", processRunner: runner });
  });
  afterEach(async () => {
    await service.close();
    db.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  it("measures first, renders with measured values, and deduplicates simultaneous first plays", async () => {
    const load = vi.fn(async () => source());
    const [a, b] = await Promise.all([service.prepare("song", false, load), service.prepare("song", false, load)]);
    expect(a).toEqual(b);
    expect(a.status).toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(runner.run).mock.calls;
    expect(calls[0][0]).toBe("configured-ffmpeg");
    expect(calls[1][1].join(" ")).toContain("measured_I=-25");
    expect(calls[1][1].join(" ")).toContain("linear=true");
    expect((await fs.promises.readdir(directory)).filter(f => f.startsWith(".preparing"))).toEqual([]);
  });

  it("returns immediately and exposes measured gain while rendering is still pending", async () => {
    const normal = stubRunner();
    let finishRender: (() => void) | undefined;
    vi.mocked(runner.run).mockImplementation((binary, args, options) => {
      const handle = normal.run(binary, args, options);
      if (args.at(-1) === "-") return handle;
      return { ...handle, promise: new Promise<void>(resolve => { finishRender = resolve; }).then(() => handle.promise) };
    });
    const load = vi.fn(async () => source());
    try {
      expect(await service.prepareInBackground("live", false, load)).toEqual({ status: "processing" });
      await vi.waitFor(() => expect(finishRender).toBeDefined());
      expect(await service.prepareInBackground("live", false, load)).toMatchObject({ status: "processing", gainDb: 9, loudness: { integratedLufs: -25, truePeakDb: -12 } });
      expect(load).toHaveBeenCalledTimes(1);
      const completed = service.prepare("live", false, load);
      finishRender!();
      await completed;
      expect(await service.prepareInBackground("live", false, load)).toMatchObject({ status: "ready", gainDb: 9 });
      expect(load).toHaveBeenCalledTimes(1);
    } finally { finishRender?.(); }
  });

  it("retains measured gain after restart and prioritizes peak headroom over boosting", async () => {
    await service.prepare("persisted", false, async () => source());
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "ffmpeg", processRunner: runner });
    expect(await service.prepareInBackground("persisted", false, async () => source())).toMatchObject({ status: "ready", gainDb: 9 });
    const peaky = parseLoudness(measurement.replace('"-12"', '"-2"'));
    expect(measuredPlaybackGain(peaky)).toBe(1);
    expect(measuredPlaybackGain(parseLoudness(measurement.replace('"-25"', '"-8"')))).toBe(-8);
  });

  it("analyzes imports once, persists initial playback gain, and invalidates changed files", async () => {
    const file = path.join(directory, "download.mp3");
    await fs.promises.writeFile(file, "original audio and tags");
    const metadata = { title: "Song", artist: "Artist", album: "Album", durationSeconds: 180 };
    const track = { title: "Song", artistName: "Artist", albumName: "Album", durationSeconds: 180 };
    await Promise.all([service.analyzeImportedFile(file, directory, metadata), service.analyzeImportedFile(file, directory, metadata)]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(file, "utf8")).toBe("original audio and tags");
    expect(service.gainForImportedTrack(track)).toBe(9);
    expect(service.gainForImportedTrack({ ...track, durationSeconds: 185 })).toBeUndefined();
    expect(service.gainForImportedTrack({ ...track, albumName: "Different master" })).toBeUndefined();
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "ffmpeg", processRunner: runner });
    expect(service.gainForImportedTrack(track)).toBe(9);
    await service.analyzeImportedFile(file, directory, metadata);
    expect(runner.run).toHaveBeenCalledTimes(1);
    await fs.promises.appendFile(file, "changed");
    expect(service.gainForImportedTrack(track)).toBeUndefined();
  });

  it("uses the audio file duration and refuses ambiguous masters with different loudness", async () => {
    const metadata = { title: "Song", artist: "Artist", album: "Album", durationSeconds: 999 };
    const track = { title: "Song", artistName: "Artist", albumName: "Album", durationSeconds: 180 };
    vi.mocked(runner.run).mockImplementationOnce(() => ({
      promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: `Duration: 00:03:00.00\n${measurement}` }), kill() {},
    })).mockImplementationOnce(() => ({
      promise: Promise.resolve({ exitCode: 0, stdout: "", stderr: `Duration: 00:03:00.00\n${measurement.replace('"-25"', '"-8"')}` }), kill() {},
    }));
    for (const name of ["first.mp3", "second.mp3"]) await fs.promises.writeFile(path.join(directory, name), "audio");
    await service.analyzeImportedFile(path.join(directory, "first.mp3"), directory, metadata);
    expect(service.gainForImportedTrack(track)).toBe(9);
    await service.analyzeImportedFile(path.join(directory, "second.mp3"), directory, metadata);
    expect(service.gainForImportedTrack(track)).toBeUndefined();
  });

  it("rejects imports outside the music root and does not retain failed measurements", async () => {
    await expect(service.analyzeImportedFile(path.join(directory, "..", "outside.mp3"), directory,
      { title: "Song", artist: "Artist", album: "Album", durationSeconds: 180 })).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
    const file = path.join(directory, "failed.mp3");
    await fs.promises.writeFile(file, "audio");
    vi.mocked(runner.run).mockImplementationOnce(() => ({ promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "fixture failure" }), kill() {} }));
    await expect(service.analyzeImportedFile(file, directory,
      { title: "Song", artist: "Artist", album: "Album", durationSeconds: 180 })).rejects.toThrow();
    expect(db.prepare("SELECT * FROM imported_audio_loudness").all()).toHaveLength(0);
    expect(await fs.promises.readFile(file, "utf8")).toBe("audio");
  });

  it("reuses persisted audio and measurements after a service restart", async () => {
    const load = vi.fn(async () => source());
    const prepared = await service.prepare("song", false, load);
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "missing-ffmpeg", processRunner: runner });
    expect(await service.prepare("song", false, load)).toEqual(prepared);
    expect(load).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("rebuilds a missing cache file and keeps an expired record out of playback", async () => {
    const result = await service.prepare("song", false, async () => source());
    if (result.status !== "ready") throw new Error("Expected ready audio");
    const key = result.streamUrl.split("/").at(-1)!;
    const file = (await service.getFile(key))!;
    await fs.promises.unlink(file.file);
    expect(await service.getFile(key)).toBeNull();
    expect((await service.prepare("song", false, async () => source())).status).toBe("ready");
    db.prepare("UPDATE playback_loudness_cache SET expires_at = 0").run();
    expect(await service.getFile(key)).toBeNull();
    expect(await service.getFile("../../outside")).toBeNull();
  });

  it("falls back without retaining partial output on process failure, with retry backoff", async () => {
    vi.mocked(runner.run).mockImplementation(() => ({ promise: Promise.resolve({ exitCode: 1, stderr: "unavailable", stdout: "" }), kill() {} }));
    const load = vi.fn(async () => source());
    expect(await service.prepare("song", false, load)).toEqual({ status: "unavailable" });
    expect(await service.prepare("song", false, load)).toEqual({ status: "unavailable" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readdir(directory)).toEqual([]);
    expect(db.prepare("SELECT * FROM playback_loudness_cache").all()).toEqual([]);
  });

  it("rejects silent/unmeasurable data and unsafe output peaks", async () => {
    expect(() => parseLoudness(measurement.replace('"-25"', '"-inf"'))).toThrow();
    const normal = stubRunner();
    vi.mocked(runner.run).mockImplementation((binary, args, options) => {
      const handle = normal.run(binary, args, options);
      const verifying = args.some(arg => path.basename(arg).startsWith("output.")) && args.at(-1) === "-";
      return { ...handle, promise: handle.promise.then(result => ({ ...result, stderr: verifying ? result.stderr.replace('"-12"', '"0"') : result.stderr })) };
    });
    expect((await service.prepare("song", false, async () => source())).status).toBe("unavailable");
    expect(runner.run).toHaveBeenCalledTimes(3); // Rejected after decoding the finished file.
  });

  it("evicts older prepared audio to keep disk usage bounded", async () => {
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "ffmpeg", processRunner: runner, maxCacheBytes: 20 });
    const first = await service.prepare("song-1", false, async () => source());
    await service.prepare("song-2", false, async () => source());
    if (first.status !== "ready") throw new Error("Expected ready");
    expect(await service.getFile(first.streamUrl.split("/").at(-1)!)).toBeNull();
    expect(db.prepare("SELECT * FROM playback_loudness_cache").all()).toHaveLength(1);
  });

  it("keeps concurrent cache publication within its budget", async () => {
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "ffmpeg", processRunner: runner, maxCacheBytes: 20 });
    const results = await Promise.all([service.prepare("song-1", false, async () => source()), service.prepare("song-2", false, async () => source())]);
    expect(results.every(result => result.status === "ready")).toBe(true);
    const rows = db.prepare("SELECT SUM(bytes) AS bytes FROM playback_loudness_cache").get() as { bytes: number };
    expect(rows.bytes).toBeLessThanOrEqual(20);
  });

  it("limits active preparations and releases capacity after a timeout", async () => {
    await service.close();
    service = new LoudnessService(db, { cacheDir: directory, getFFmpegPath: () => "ffmpeg", processRunner: runner, timeoutMs: 30 });
    let loads = 0;
    let firstReturned = false;
    const first = service.prepare("hung-1", false, () => { loads++; return new Promise(() => {}); }).then(result => { firstReturned = true; return result; });
    const second = service.prepare("hung-2", false, () => { loads++; return new Promise(() => {}); });
    const third = service.prepare("third", false, async () => {
      expect(firstReturned).toBe(true);
      loads++; return source();
    });
    const results = await Promise.all([first, second, third]);
    expect(results.map(result => result.status)).toEqual(["unavailable", "unavailable", "ready"]);
    expect(loads).toBe(3);
  });

  it("shutdown aborts in-flight source retrieval and prevents new work", async () => {
    const pending = service.prepare("hung", false, () => new Promise(() => {}));
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.close();
    expect((await pending).status).toBe("unavailable");
    const load = vi.fn(async () => source());
    expect((await service.prepare("new", false, load)).status).toBe("unavailable");
    expect(load).not.toHaveBeenCalled();
  });

  it("authenticates preparation/streaming and serves valid seek ranges", async () => {
    db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('user', 'User')").run();
    db.prepare("INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at) VALUES ('user', 'user', 'unused', 'User', 'user', '', '')").run();
    const session = createSession(db, "user");
    const headers = { cookie: `musicdeck_session=${session.id}` };
    const app = Fastify();
    await app.register(cookie);
    const resolver = { fetchStream: vi.fn(async () => source()) } as unknown as SourceResolver;
    await registerLoudnessRoutes(app, db, Object.assign(new LibraryService(db), { exists: () => true }), resolver, { isExternalSource: () => true } as unknown as SourceProviderRegistry, service);
    try {
      expect((await app.inject({ method: "POST", url: "/api/playback/normalize", payload: { trackId: "song" } })).statusCode).toBe(401);
      const ready = await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "song" } });
      const url = ready.json().streamUrl;
      expect(ready.statusCode).toBe(200);
      expect((await app.inject({ url })).statusCode).toBe(401);
      const range = await app.inject({ url, headers: { ...headers, range: "bytes=2-5" } });
      expect(range.statusCode).toBe(206);
      expect(range.headers["content-range"]).toBe("bytes 2-5/14");
      expect(range.body).toBe("epar");
      expect((await app.inject({ url, headers: { ...headers, range: "bytes=999-" } })).statusCode).toBe(416);
      expect((await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "song", previewUrl: "http://localhost/audio" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "song", playableSource: "full-external" } })).statusCode).toBe(403);
      expect(resolver.fetchStream).toHaveBeenCalledTimes(1);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("original"));
      try {
        expect((await app.inject({ url: "/api/playback/preview?url=https://cdns-preview-a.dzcdn.net/audio.mp3" })).statusCode).toBe(401);
        expect((await app.inject({ url: "/api/playback/preview?url=http://localhost/audio", headers })).statusCode).toBe(400);
        fetchMock.mockResolvedValueOnce(new Response("preview", { status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-6/14", "accept-ranges": "bytes" } }));
        const streamed = await app.inject({ url: "/api/playback/preview?url=https://cdns-preview-a.dzcdn.net/audio.mp3", headers: { ...headers, range: "bytes=0-6" } });
        expect(streamed.statusCode).toBe(206);
        expect(streamed.body).toBe("preview");
        expect(streamed.headers["content-range"]).toBe("bytes 0-6/14");
        expect(fetchMock).toHaveBeenLastCalledWith("https://cdns-preview-a.dzcdn.net/audio.mp3", expect.objectContaining({ headers: { Range: "bytes=0-6" } }));
        fetchMock.mockClear();
        const preview = await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "preview", previewUrl: "https://cdns-preview-a.dzcdn.net/audio.mp3" } });
        expect(preview.json().status).toBe("ready");
        expect((await app.inject({ url: preview.json().streamUrl, headers })).statusCode).toBe(200);
        expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes("-t") && args.includes("30"))).toBe(true);
        fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://localhost/secret" } }));
        const redirect = await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "redirect", previewUrl: "https://cdns-preview-a.dzcdn.net/redirect.mp3" } });
        expect(redirect.json().status).toBe("unavailable");
        expect(fetchMock).toHaveBeenCalledTimes(2); // Never follow the untrusted redirect.
        const background = await app.inject({ method: "POST", url: "/api/playback/normalize", headers, payload: { trackId: "new-song", background: true } });
        expect(background.json().status).toBe("processing");
      } finally { fetchMock.mockRestore(); }
    } finally { await app.close(); }
  });

  it("limits previews to the provider CDNs, excluding deceptive hosts, ports and credentials", () => {
    expect(isAllowedPreview("https://cdns-preview-a.dzcdn.net/audio.mp3")).toBe(true);
    expect(isAllowedPreview("https://audio-ssl.itunes.apple.com/audio.m4a")).toBe(true);
    for (const url of ["http://dzcdn.net/a", "https://dzcdn.net.evil.test/a", "https://evil.test/dzcdn.net", "https://user@dzcdn.net/a", "https://dzcdn.net:123/a", "file:///music/audio.mp3"]) expect(isAllowedPreview(url)).toBe(false);
  });
});

// Two intentionally different input levels must converge after actual FFmpeg decoding.
const realFFmpeg = autoDetectFFmpegPath();
const ffmpegAvailable = spawnSync(realFFmpeg, ["-version"], { windowsHide: true, timeout: 5000, stdio: "ignore" }).status === 0;
it.skipIf(!ffmpegAvailable)("normalizes quiet and loud audio, including data-saver MP3, without changing originals", async () => {
  const binary = realFFmpeg;
  const runner = new DefaultProcessRunner();
  const probe = await runner.run(binary, ["-version"]).promise;
  expect(probe.exitCode).toBe(0);
  const db = new Database(":memory:");
  runMigrations(db);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musicdeck-loudness-real-"));
  const service = new LoudnessService(db, { cacheDir: path.join(directory, "cache"), getFFmpegPath: () => binary });
  try {
    const results: number[] = [];
    for (const [gain, bitRate, target] of [[0.1, undefined, -16], [4, undefined, -16], [0.1, 128, -16], [0.1, undefined, -18], [0.1, undefined, -14]] as const) {
      const original = path.join(directory, `${gain}.wav`);
      const generated = await runner.run(binary, ["-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-af", `volume=${gain}`, original]).promise;
      expect(generated.exitCode).toBe(0);
      const bytes = await fs.promises.readFile(original);
      await service.analyzeImportedFile(original, directory, { title: `Song ${gain}`, artist: "Artist", album: "Album", durationSeconds: 999 });
      expect((db.prepare("SELECT duration_seconds FROM imported_audio_loudness WHERE file_path = ?").get(fs.realpathSync(original)) as { duration_seconds: number }).duration_seconds).toBeCloseTo(5, 1);
      const importedGain = service.gainForImportedTrack({ title: `Song ${gain}`, artistName: "Artist", albumName: "Album", durationSeconds: 5 });
      expect(Number.isFinite(importedGain)).toBe(true);
      expect(await fs.promises.readFile(original)).toEqual(bytes);
      const result = await service.prepare(`input-${gain}`, false, async () => source(bytes), bitRate, target);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Normalization failed");
      const normalized = (await service.getFile(result.streamUrl.split("/").at(-1)!))!;
      expect(normalized.format).toBe(bitRate ? "mp3" : "flac");
      const measured = await runner.run(binary, ["-nostdin", "-i", normalized.file, "-af", "loudnorm=I=-16:TP=-1:LRA=20:print_format=json", "-f", "null", "-"]).promise;
      const stats = parseLoudness(measured.stderr);
      results.push(Number(stats.input_i));
      // Lossy MP3 encoding may shift integrated loudness by a fraction of a dB.
      expect(Math.abs(Number(stats.input_i) - target)).toBeLessThan(bitRate ? 0.6 : 0.3);
      expect(Number(stats.input_tp)).toBeLessThanOrEqual(-0.9);
      expect(await fs.promises.readFile(original)).toEqual(bytes);
    }
    expect(Math.abs(results[0] - results[1])).toBeLessThan(0.3);
  } finally {
    await service.close(); db.close();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
