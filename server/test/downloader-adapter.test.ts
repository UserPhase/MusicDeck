import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrations.js";
import {
  type ProcessRunner,
  type ProcessOptions,
  type ProcessHandle,
  DefaultProcessRunner,
} from "../src/domain/process-runner.js";
import {
  type DownloaderAdapter,
  type DownloadRequest,
  type DownloadContext,
  DownloaderAdapterRegistry,
} from "../src/domain/downloader-adapter.js";
import {
  SpotDLDownloaderAdapter,
  parseSpotDLProgress,
  classifySpotDLError,
  normalizeManualUrl,
} from "../src/domain/spotdl-downloader-adapter.js";
import {
  AcquisitionService,
  AcquisitionProviderRegistry,
  DownloaderAcquisitionProvider,
} from "../src/domain/acquisition.js";
import { LibraryService } from "../src/domain/library.js";
import { CatalogService } from "../src/domain/catalog.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import type { UnifiedSearchResult } from "../src/domain/search.js";
import { SourcePipelineRegistry, type SourceCandidate } from "../src/domain/source-discovery.js";

function createValidFlacBuffer(): Buffer {
  const buf = Buffer.alloc(128);
  buf.write("fLaC", 0, "ascii");
  return buf;
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', 'Admin'), ('user', 'User')").run();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
    VALUES ('test-user', 'testuser', 'hash', 'Test User', 'admin', 0, datetime('now'), datetime('now'))
  `).run();
  return db;
}

function createTestTrack(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id: "test-track-123",
    type: "track",
    title: "We Will Rock You",
    subtitle: null,
    artist: "Queen",
    album: "News of the World",
    artwork: null,
    provider: "library",
    source: { kind: "library", count: 1 },
    availability: null,
    metadata: { durationSeconds: 122 },
    ...overrides,
  };
}

describe("Reverb-Style Downloader Architecture", () => {
  describe("ProcessRunner Abstraction", () => {
    it("runs command with argument array safely", async () => {
      const runner = new DefaultProcessRunner();
      const cmd = process.execPath;
      const args = ["-e", "console.log('hello world')"];

      const handle = runner.run(cmd, args);
      const result = await (handle.promise || handle.completion);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
    });

    it("handles timeouts properly", async () => {
      const runner = new DefaultProcessRunner();
      const isWin = process.platform === "win32";
      const cmd = isWin ? "powershell.exe" : "sleep";
      const args = isWin ? ["-Command", "Start-Sleep -Seconds 5"] : ["5"];

      const handle = runner.run(cmd, args, { timeoutMs: 150 });
      await expect(handle.completion).rejects.toThrow(/timed out/i);
    });

    it("supports cancellation via AbortSignal", async () => {
      const runner = new DefaultProcessRunner();
      const controller = new AbortController();
      const isWin = process.platform === "win32";
      const cmd = isWin ? "powershell.exe" : "sleep";
      const args = isWin ? ["-Command", "Start-Sleep -Seconds 5"] : ["5"];

      const handle = runner.run(cmd, args, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);

      await expect(handle.completion).rejects.toThrow(/cancelled|aborted/i);
    });
  });

  describe("spotDL Progress Parsing & Error Classification", () => {
    it("parses spotDL percentage and speed progress correctly", () => {
      const line1 = "Downloading Bohemian Rhapsody: 45%|████▌     | 4.5M/10.0M [00:02<00:02, 2.8MB/s]";
      const progress1 = parseSpotDLProgress(line1);
      expect(progress1).not.toBeNull();
      expect(progress1?.percent).toBe(45);
      expect(progress1?.speedBytesPerSecond).toBe(Math.round(2.8 * 1024 * 1024));
      expect(progress1?.stage).toBe("downloading");

      const line2 = "Converting Bohemian Rhapsody to flac";
      const progress2 = parseSpotDLProgress(line2);
      expect(progress2).not.toBeNull();
      expect(progress2?.stage).toBe("converting");

      const line3 = "Applying metadata / tags to Bohemian Rhapsody";
      const progress3 = parseSpotDLProgress(line3);
      expect(progress3).not.toBeNull();
      expect(progress3?.stage).toBe("tagging");
    });

    it("classifies spotDL error output correctly", () => {
      expect(classifySpotDLError("RateLimitError: 429 Too Many Requests")).toBe("rate-limited");
      expect(classifySpotDLError("AudioNotFoundError: Could not find song")).toBe("not-found");
      expect(classifySpotDLError("LookupError: track not found")).toBe("not-found");
      expect(classifySpotDLError("Sign in to confirm you're not a bot")).toBe("authentication-failed");
      expect(classifySpotDLError("spotdl: error: unrecognized arguments")).toBe("invalid-input");
      expect(classifySpotDLError("Job was cancelled by user")).toBe("cancelled");
      expect(classifySpotDLError("Some random ffmpeg exception")).toBe("general");
    });

    it("normalizes manual YouTube URLs by stripping playlist and radio query parameters", () => {
      expect(
        normalizeManualUrl("https://www.youtube.com/watch?v=fJ9rUzIMcZQ&list=RDfJ9rUzIMcZQ&start_radio=1")
      ).toBe("https://www.youtube.com/watch?v=fJ9rUzIMcZQ");
      expect(
        normalizeManualUrl("https://music.youtube.com/watch?v=fJ9rUzIMcZQ&feature=share")
      ).toBe("https://www.youtube.com/watch?v=fJ9rUzIMcZQ");
      expect(
        normalizeManualUrl("https://youtu.be/fJ9rUzIMcZQ?si=12345")
      ).toBe("https://www.youtube.com/watch?v=fJ9rUzIMcZQ");
      expect(
        normalizeManualUrl("https://archive.org/details/test")
      ).toBe("https://archive.org/details/test");
    });
  });

  describe("SpotDLDownloaderAdapter", () => {
    it("registers with DownloaderAdapterRegistry and declares capabilities", () => {
      const registry = new DownloaderAdapterRegistry();
      const adapter = new SpotDLDownloaderAdapter();
      registry.register(adapter);

      expect(registry.get("spotdl")).toBe(adapter);
      expect(adapter.capabilities.spotifyTrack).toBe(true);
      expect(adapter.capabilities.textSearch).toBe(true);
      expect(adapter.capabilities.directUrl).toBe(true);
      expect(adapter.capabilities.metadata).toBe(true);
    });

    it("canHandle returns true for valid Spotify track URL", () => {
      const adapter = new SpotDLDownloaderAdapter();
      expect(adapter.canHandle({
        spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
        outputDirectory: "./tmp",
      })).toBe(true);

      expect(adapter.canHandle({
        query: "Queen - Bohemian Rhapsody",
        outputDirectory: "./tmp",
      })).toBe(true);
    });

    it("executes spotDL via ProcessRunner and returns DownloadResult on success", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotdl-test-"));
      try {
        const mockRunner: ProcessRunner = {
          run: vi.fn().mockImplementation((command, args, options) => {
            // Write a dummy flac file into the output directory
            const outFlac = path.join(tmpDir, "Queen - We Will Rock You.flac");
            fs.writeFileSync(outFlac, createValidFlacBuffer());

            return {
              pid: 1234,
              kill: () => {},
              promise: Promise.resolve({
                exitCode: 0,
                stdout: 'Downloaded "Queen - We Will Rock You": 100%\nApplied metadata',
                stderr: "",
              }),
            };
          }),
        };

        const adapter = new SpotDLDownloaderAdapter({ runner: mockRunner, spotdlPath: "spotdl" });
        const progressUpdates: any[] = [];
        const result = await adapter.download(
          {
            spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
            outputDirectory: tmpDir,
            requestedTrack: createTestTrack(),
          },
          {
            jobId: "test-job-1",
            tmpDir,
            signal: new AbortController().signal,
            onProgress: (p) => progressUpdates.push(p),
          }
        );

        expect(mockRunner.run).toHaveBeenCalledTimes(1);
        const [cmd, args] = (mockRunner.run as any).mock.calls[0];
        expect(cmd).toBe("spotdl");
        expect(args).toContain("download");
        expect(args).toContain("https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv");
        expect(args).toContain("--output");

        expect(result.status).toBe("completed");
        expect(result.files.length).toBe(1);
        expect(result.files[0].path).toBe(path.join(tmpDir, "Queen - We Will Rock You.flac"));
        expect(result.files[0].title).toBe("We Will Rock You");
        expect(result.files[0].artist).toBe("Queen");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("constructs Reverb-style pipe query '<audio-url>|<spotify-url>' when manual URL and Spotify URL are both present", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotdl-pipe-"));
      try {
        const mockRunner: ProcessRunner = {
          run: vi.fn().mockImplementation((command, args, options) => {
            const outFlac = path.join(tmpDir, "Queen - We Will Rock You.flac");
            fs.writeFileSync(outFlac, createValidFlacBuffer());
            return {
              pid: 1234,
              kill: () => {},
              promise: Promise.resolve({ exitCode: 0, stdout: "Done", stderr: "" }),
            };
          }),
        };

        const adapter = new SpotDLDownloaderAdapter({ runner: mockRunner, spotdlPath: "spotdl" });
        await adapter.download(
          {
            sourceUrl: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ&list=RD123",
            spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
            outputDirectory: tmpDir,
          },
          {
            jobId: "test-job-pipe",
            tmpDir,
            signal: new AbortController().signal,
          }
        );

        expect(mockRunner.run).toHaveBeenCalledTimes(1);
        const [cmd, args] = (mockRunner.run as any).mock.calls[0];
        expect(cmd).toBe("spotdl");
        expect(args).toContain("download");
        expect(args).toContain(
          "https://www.youtube.com/watch?v=fJ9rUzIMcZQ|https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv"
        );
        expect(args).toContain("--simple-tui");
        expect(args).toContain("--id3-separator");
        expect(args).toContain("--log-level");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles nonzero exit code as failure", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotdl-fail-"));
      try {
        const mockRunner: ProcessRunner = {
          run: vi.fn().mockReturnValue({
            pid: 1234,
            kill: () => {},
            promise: Promise.resolve({
              exitCode: 1,
              stdout: "",
              stderr: "Error: Song not found on any provider",
            }),
          }),
        };

        const adapter = new SpotDLDownloaderAdapter({ runner: mockRunner });
        const result = await adapter.download(
          {
            spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
            outputDirectory: tmpDir,
          },
          {
            jobId: "test-job-fail",
            tmpDir,
            signal: new AbortController().signal,
          }
        );

        expect(result.status).toBe("failed");
        expect(result.error?.message).toContain("Song not found");
        expect(result.error?.code).toBe("not-found");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles cancellation via AbortSignal", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotdl-cancel-"));
      try {
        const controller = new AbortController();
        const p = new Promise<any>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error("Command was aborted"));
          });
        });
        p.catch(() => {});
        const mockRunner: ProcessRunner = {
          run: vi.fn().mockReturnValue({
            pid: 1234,
            kill: () => {},
            promise: p,
          }),
        };

        const adapter = new SpotDLDownloaderAdapter({ runner: mockRunner });
        const downloadPromise = adapter.download(
          {
            spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
            outputDirectory: tmpDir,
          },
          {
            jobId: "test-job-cancel",
            tmpDir,
            signal: controller.signal,
          }
        );

        controller.abort();
        const result = await downloadPromise;

        expect(result.status).toBe("cancelled");
        expect(result.error?.code).toBe("cancelled");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("DownloaderAcquisitionProvider Seam", () => {
    it("adapts DownloaderAdapter to AcquisitionProvider interface", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-test-"));
      try {
        const fakeAdapter: DownloaderAdapter = {
          id: "fake-downloader",
          name: "Fake Downloader",
          capabilities: {
            spotifyTrack: true,
            textSearch: true,
            directUrl: true,
            album: true,
            playlist: false,
            metadata: true,
          },
          canHandle: () => true,
          download: async (req, ctx) => {
            const out = path.join(ctx.tmpDir, "fake-song.flac");
            fs.writeFileSync(out, createValidFlacBuffer());
            ctx.onProgress?.({ percent: 100, stage: "processing" });
            return {
              status: "completed",
              files: [{
                path: out,
                title: "Fake Song",
                artist: "Fake Artist",
                album: "Fake Album",
                size: 128,
              }],
            };
          },
          cancel: async () => {},
          test: async () => ({ ok: true }),
        };

        const provider = new DownloaderAcquisitionProvider(fakeAdapter);
        expect(provider.id).toBe("fake-downloader");
        expect(provider.canAcquire({ id: "spotify:track:123", provider: "spotify", kind: "track" })).toBe(true);

        const progressUpdates: any[] = [];
        const res = await provider.acquire(
          {
            id: "spotify:track:123",
            provider: "spotify",
            kind: "track",
            title: "Fake Song",
            artist: "Fake Artist",
            metadata: { spotifyTrackUrl: "https://open.spotify.com/track/123" },
          },
          {
            jobId: "job-1",
            tmpDir,
            signal: new AbortController().signal,
            onProgress: (bytes, total, details) => {
              if (typeof details === "object" && details !== null) {
                progressUpdates.push({ percent: details.percent, stage: details.stage });
              }
            },
          }
        );

        expect(res.files.length).toBe(1);
        expect(res.files[0].title).toBe("Fake Song");
        expect(progressUpdates.some((p) => p.percent === 100)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("AcquisitionService End-to-End with SpotDLDownloaderAdapter", () => {
    it("runs full pipeline: createJob -> SpotDL adapter -> validation -> music library import -> events", async () => {
      const db = createTestDb();
      const library = new LibraryService(db);
      const fakeBackend = {
        fetchArtwork: vi.fn(),
        search: vi.fn().mockResolvedValue({ tracks: [], albums: [], artists: [] }),
        getTrack: vi.fn(),
        getAlbum: vi.fn(),
        getArtist: vi.fn(),
        scanLibrary: vi.fn().mockResolvedValue(undefined),
      };
      const backendRegistry = new ProviderRegistry([
        { connectionId: "navidrome", name: "Navidrome", type: "navidrome", enabled: true, provider: fakeBackend as any },
      ]);
      const catalog = new CatalogService(backendRegistry, library);

      const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acq-srv-tmp-"));
      const testMusicDir = fs.mkdtempSync(path.join(os.tmpdir(), "acq-srv-music-"));

      const eventsEmitted: Array<{ event: string; payload: any }> = [];
      const eventBus = {
        emit: (event: string, payload: any) => eventsEmitted.push({ event, payload }),
      };

      const mockRunner: ProcessRunner = {
        run: vi.fn().mockImplementation((command, args, options) => {
          // Identify the output directory from args or options.cwd
          const outDirIdx = args.indexOf("--output");
          const outTemplate = outDirIdx >= 0 ? args[outDirIdx + 1] : testTmpDir;
          const outDir = options?.cwd || (outTemplate.includes("{") ? path.dirname(outTemplate) : outTemplate);
          const outFlac = path.join(outDir, "Queen - We Will Rock You.flac");
          fs.writeFileSync(outFlac, createValidFlacBuffer());

          if (options?.onStdoutLine) {
            options.onStdoutLine("Downloading We Will Rock You: 50% [2.5MB/s]");
            options.onStdoutLine("Downloading We Will Rock You: 100%");
            options.onStdoutLine("Converting We Will Rock You to flac");
          }

          return {
            pid: 1234,
            kill: () => {},
            promise: Promise.resolve({
              exitCode: 0,
              stdout: "Downloaded 100%",
              stderr: "",
            }),
          };
        }),
      };

      const downloaderRegistry = new DownloaderAdapterRegistry();
      const spotdlAdapter = new SpotDLDownloaderAdapter({ runner: mockRunner });
      downloaderRegistry.register(spotdlAdapter);

      const acquisitionProviders = new AcquisitionProviderRegistry();
      acquisitionProviders.register(new DownloaderAcquisitionProvider(spotdlAdapter));

      const acquisitionService = new AcquisitionService(
        db,
        acquisitionProviders,
        library,
        catalog,
        eventBus,
        {
          musicRoot: testMusicDir,
          tmpDir: testTmpDir,
          maxConcurrentDownloads: 1,
          autoScan: true,
          downloaderRegistry,
        }
      );

      const track = createTestTrack({
        id: "rec-we-will-rock-you",
        title: "We Will Rock You",
        artist: "Queen",
        album: "News of the World",
      });

      const candidate: SourceCandidate = {
        id: "spotify:track:4u7EnebtmKWzUH433cf5Qv",
        provider: "spotdl",
        kind: "track",
        title: "We Will Rock You",
        artist: "Queen",
        album: "News of the World",
        metadata: {
          spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
        },
      };

      const job = await acquisitionService.createJob({
        userId: "test-user",
        candidate,
        result: track,
        autoPlay: true,
      });

      expect(job.status).toBe("queued");
      expect(job.autoPlay).toBe(true);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 200));

      const updatedJob = acquisitionService.getJob(job.id);
      expect(updatedJob?.status).toBe("completed");
      expect(updatedJob?.files?.length).toBe(1);

      // Verify the final file was imported into the music root
      const importedPath = updatedJob?.files?.[0].path;
      expect(importedPath).toBeDefined();
      expect(fs.existsSync(importedPath!)).toBe(true);
      expect(importedPath).toContain(path.join("Queen", "News of the World"));

      // Verify live progress & completion events were emitted
      const eventNames = eventsEmitted.map((e) => e.event);
      expect(eventNames).toContain("acquisition.created");
      expect(eventNames).toContain("acquisition.started");
      expect(eventNames).toContain("acquisition.progress");
      expect(eventNames).toContain("acquisition.processing");
      expect(eventNames).toContain("acquisition.importing");
      expect(eventNames).toContain("acquisition.completed");

      const completedEvent = eventsEmitted.find((e) => e.event === "acquisition.completed");
      expect(completedEvent?.payload.autoPlay).toBe(true);

      // Clean up
      acquisitionService.shutdown();
      fs.rmSync(testTmpDir, { recursive: true, force: true });
      fs.rmSync(testMusicDir, { recursive: true, force: true });
    });

    it("exposes downloader diagnostics without requiring credentials", async () => {
      const db = createTestDb();
      const library = new LibraryService(db);
      const catalog = new CatalogService(new ProviderRegistry([]), library);
      const downloaderRegistry = new DownloaderAdapterRegistry();
      const adapter = new SpotDLDownloaderAdapter();
      downloaderRegistry.register(adapter);

      const acquisitionProviders = new AcquisitionProviderRegistry();
      const acquisitionService = new AcquisitionService(
        db,
        acquisitionProviders,
        library,
        catalog,
        { emit: () => {} },
        { downloaderRegistry }
      );

      const diagnostics = await acquisitionService.getDownloaderDiagnostics();
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].id).toBe("spotdl");
      expect(diagnostics[0].capabilities.spotifyTrack).toBe(true);
    });
  });
});
