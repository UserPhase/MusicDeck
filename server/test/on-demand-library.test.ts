import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createFakeBackend, createTestServer, closeTestServer, login } from "./helpers.js";
import {
  extractZipSafely,
  validateAudioFile,
  sanitizePathSegment,
  resolveSafeDestination,
  AcquisitionService,
  AcquisitionProviderRegistry,
  type AcquisitionProvider,
  type AcquisitionResult,
} from "../src/domain/acquisition.js";
import { updateServerSettings } from "../src/domain/settings.js";
import { AuthorizedHttpAcquisitionProvider } from "../src/plugins/in-progress/on-demand-library.js";

// Helper to construct a minimal valid ZIP in memory
function createMockZipBuffer(files: Array<{ name: string; content: Buffer | string }>): Buffer {
  const localFileHeaders: Buffer[] = [];
  const centralDirHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const data = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
    const nameBuffer = Buffer.from(file.name, "utf8");

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression (store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);

    localFileHeaders.push(localHeader, data);

    // Central directory header
    const cdHeader = Buffer.alloc(46 + nameBuffer.length);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8); // flags
    cdHeader.writeUInt16LE(0, 10); // compression
    cdHeader.writeUInt16LE(0, 12); // mod time
    cdHeader.writeUInt16LE(0, 14); // mod date
    cdHeader.writeUInt32LE(0, 16); // crc32
    cdHeader.writeUInt32LE(data.length, 20); // compressed size
    cdHeader.writeUInt32LE(data.length, 24); // uncompressed size
    cdHeader.writeUInt16LE(nameBuffer.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42); // relative offset
    nameBuffer.copy(cdHeader, 46);

    centralDirHeaders.push(cdHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const cdh of centralDirHeaders) {
    centralDirSize += cdh.length;
  }

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localFileHeaders, ...centralDirHeaders, eocd]);
}

// Minimal FLAC header (fLaC + 34 bytes metadata block)
function createMockFlacBuffer(durationSeconds = 180): Buffer {
  const buf = Buffer.alloc(100);
  buf.write("fLaC", 0);
  buf[4] = 0x80; // last metadata block, STREAMINFO (0)
  buf[5] = 0; buf[6] = 0; buf[7] = 34; // length 34
  // Write some dummy audio bytes
  for (let i = 42; i < 100; i++) {
    buf[i] = 0x55;
  }
  return buf;
}

// Minimal MP3 frame (ID3 header or sync word 0xFFFB)
function createMockMp3Buffer(): Buffer {
  const buf = Buffer.alloc(100);
  buf.write("ID3", 0);
  buf[3] = 0x03; // version 2.3
  buf[4] = 0x00;
  buf[5] = 0x00; // flags
  buf[6] = 0; buf[7] = 0; buf[8] = 0; buf[9] = 10; // size 10
  for (let i = 10; i < 100; i++) {
    buf[i] = 0xaa;
  }
  return buf;
}

describe("On-Demand Library Acquisition", () => {
  describe("Security & Path Traversal & Audio Validation", () => {
    it("sanitizes path segments and rejects path traversal", () => {
      expect(sanitizePathSegment("../../../etc/passwd")).toBe("passwd");
      expect(sanitizePathSegment("..\\..\\windows\\system32")).toBe("system32");
      expect(sanitizePathSegment("CON.mp3")).toBe("_CON.mp3");
      expect(sanitizePathSegment("Valid Artist Name")).toBe("Valid Artist Name");
    });

    it("prevents destination path escaping root directory", () => {
      const root = path.resolve("./data/music");
      expect(() => {
        resolveSafeDestination(root, "../../../outside/secret.flac");
      }).toThrow(/traversal/i);
    });

    it("validates legitimate audio and rejects HTML / error pages", () => {
      const tmpFile = path.join(process.cwd(), "data", `test-valid-${Date.now()}.flac`);
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });

      try {
        // Legitimate FLAC
        fs.writeFileSync(tmpFile, createMockFlacBuffer());
        const valid = validateAudioFile(tmpFile);
        expect(valid.valid).toBe(true);
        expect(valid.format).toBe("flac");

        // HTML error page renamed to .flac
        fs.writeFileSync(tmpFile, "<html><body>404 Not Found</body></html>");
        const invalidHtml = validateAudioFile(tmpFile);
        expect(invalidHtml.valid).toBe(false);
        expect(invalidHtml.error).toMatch(/HTML error/i);

        // Empty file
        fs.writeFileSync(tmpFile, Buffer.alloc(0));
        const empty = validateAudioFile(tmpFile);
        expect(empty.valid).toBe(false);

        // Unknown garbage
        fs.writeFileSync(tmpFile, Buffer.from("SOMERANDOMSTRINGTHATISNOTAUDIOHEADER1234567890"));
        const garbage = validateAudioFile(tmpFile);
        expect(garbage.valid).toBe(false);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it("extracts ZIP archives safely and ignores path traversal attempts", () => {
      const outDir = path.join(process.cwd(), "data", `zip-test-${Date.now()}`);
      fs.mkdirSync(outDir, { recursive: true });
      const zipPath = path.join(outDir, "test.zip");

      try {
        const zipBuf = createMockZipBuffer([
          { name: "01-track.flac", content: createMockFlacBuffer() },
          { name: "../../../evil.exe", content: "not-safe" },
          { name: "notes.txt", content: "some notes" },
        ]);
        fs.writeFileSync(zipPath, zipBuf);

        const extracted = extractZipSafely(zipPath, outDir);
        expect(extracted.length).toBe(1);
        expect(extracted[0]).toContain("01-track.flac");
        expect(fs.existsSync(path.join(outDir, "evil.exe"))).toBe(false);
      } finally {
        if (fs.existsSync(outDir)) {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe("AuthorizedHttpAcquisitionProvider", () => {
    it("canAcquire correctly identifies candidates", () => {
      const mockContext: any = {
        settings: { get: () => "" },
      };
      const provider = new AuthorizedHttpAcquisitionProvider(mockContext);

      expect(provider.canAcquire({ id: "https://example.com/audio.flac", provider: "http" })).toBe(true);
      expect(provider.canAcquire({ id: "archiveorg:identifier:track.flac", provider: "archiveorg" })).toBe(true);
      expect(provider.canAcquire({ id: "custom:https://remote.test/song.mp3", provider: "custom" })).toBe(true);
      expect(provider.canAcquire({ id: "magnet:?xt=urn:btih:123", provider: "torrent" })).toBe(false);
    });

    it("supports no-auth provider with empty accessToken and fails when bearer auth is missing token", async () => {
      const mockFlac = createMockFlacBuffer();
      let attachedHeaders: any = null;
      const fetchMock = vi.fn(async (_url: any, init: any) => {
        attachedHeaders = init?.headers;
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": String(mockFlac.length),
            "content-type": "audio/flac",
          }),
          arrayBuffer: async () => mockFlac.buffer.slice(mockFlac.byteOffset, mockFlac.byteOffset + mockFlac.byteLength),
        };
      }) as any;

      // 1. authType = "none" with empty token -> succeeds and does not attach Authorization header
      const noAuthContext: any = {
        settings: {
          get: (key: string) => {
            if (key === "authType") return "none";
            if (key === "accessToken") return "";
            return "";
          },
        },
      };
      const noAuthProvider = new AuthorizedHttpAcquisitionProvider(noAuthContext, fetchMock);
      const tmpDir = path.join(process.cwd(), "data", `test-noauth-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        const res = await noAuthProvider.acquire(
          { id: "https://authorized.example.com/song.flac", provider: "http", title: "Free Song", artist: "Artist" },
          { jobId: "job-noauth", tmpDir, signal: new AbortController().signal, onProgress: () => {} }
        );
        expect(res.files.length).toBe(1);
        expect(attachedHeaders?.Authorization).toBeUndefined();
      } finally {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // 2. authType = "bearer" without accessToken -> fails validation
      const bearerNoTokenContext: any = {
        settings: {
          get: (key: string) => {
            if (key === "authType") return "bearer";
            if (key === "accessToken") return "";
            return "";
          },
        },
      };
      const bearerProvider = new AuthorizedHttpAcquisitionProvider(bearerNoTokenContext, fetchMock);
      const tmpDir2 = path.join(process.cwd(), "data", `test-bearer-${Date.now()}`);
      fs.mkdirSync(tmpDir2, { recursive: true });

      try {
        await expect(
          bearerProvider.acquire(
            { id: "https://authorized.example.com/song.flac", provider: "http", title: "Protected Song" },
            { jobId: "job-bearer", tmpDir: tmpDir2, signal: new AbortController().signal, onProgress: () => {} }
          )
        ).rejects.toThrow(/Access token is required/);
      } finally {
        if (fs.existsSync(tmpDir2)) {
          fs.rmSync(tmpDir2, { recursive: true, force: true });
        }
      }
    });

    it("downloads and reports byte progress when content-length exists", async () => {
      const mockAudio = createMockFlacBuffer();
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-length": String(mockAudio.length),
          "content-type": "audio/flac",
        }),
        arrayBuffer: async () => mockAudio.buffer.slice(mockAudio.byteOffset, mockAudio.byteOffset + mockAudio.byteLength),
      })) as any;

      const mockContext: any = {
        settings: { get: () => "" },
      };
      const provider = new AuthorizedHttpAcquisitionProvider(mockContext, fetchMock);

      const tmpDir = path.join(process.cwd(), "data", `test-acq-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      const progressCalls: Array<{ downloaded: number; total?: number }> = [];
      const abortController = new AbortController();

      try {
        const result = await provider.acquire(
          { id: "https://authorized.example.com/song.flac", provider: "http", title: "Test Song", artist: "Test Artist" },
          {
            jobId: "test-job-1",
            tmpDir,
            signal: abortController.signal,
            onProgress: (bytes, total) => progressCalls.push({ downloaded: bytes, total }),
          }
        );

        expect(result.files.length).toBe(1);
        expect(result.files[0].title).toBe("Test Song");
        expect(progressCalls.length).toBeGreaterThan(0);
        expect(progressCalls[0].total).toBe(mockAudio.length);
      } finally {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe("End-to-End Acquisition Pipeline & Server Integration", () => {
    it("handles Direct File acquisition, deduplication, container reuse, cancellation, and library refresh", async () => {
      const mockFlac = createMockFlacBuffer();
      const fakeBackend = createFakeBackend({
        scanLibrary: vi.fn(async () => ({ count: 1, scanning: false })),
      });

      const fetchImpl = vi.fn(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("fail-download")) {
          return { ok: false, status: 500, statusText: "Internal Error" };
        }
        if (urlStr.includes("html-error")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": "40", "content-type": "text/html" }),
            arrayBuffer: async () => Buffer.from("<html>Error 404</html>"),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": String(mockFlac.length),
            "content-type": "audio/flac",
          }),
          arrayBuffer: async () => mockFlac.buffer.slice(mockFlac.byteOffset, mockFlac.byteOffset + mockFlac.byteLength),
        };
      }) as any;

      const { app, db, acquisition, catalog, plugins } = await createTestServer(fakeBackend, {}, fetchImpl, fetchImpl, fetchImpl);

      // Enable the on-demand-library plugin
      await plugins.enable("on-demand-library");

      // Register an acquisition provider directly into the registry to test provider isolation
      const mockAcquisitionProvider: AcquisitionProvider = {
        id: "mock-http-acquisition",
        name: "Mock HTTP Acquisition",
        canAcquire: (c) => c.id.includes("test-track") || c.id.includes("test-album") || c.id.includes("slow-candidate"),
        acquire: async (candidate, ctx) => {
          if (candidate.id.includes("slow-candidate")) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000);
              ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("Acquisition cancelled"));
              });
            });
          }
          if (candidate.id.includes("fail-download")) {
            throw new Error("Provider download failed");
          }
          if (candidate.id.includes("test-album")) {
            // Unpack 3 tracks
            const zipBuf = createMockZipBuffer([
              { name: "01 Track One.flac", content: createMockFlacBuffer() },
              { name: "02 Track Two.flac", content: createMockFlacBuffer() },
              { name: "03 Track Three.flac", content: createMockFlacBuffer() },
            ]);
            const zipFile = path.join(ctx.tmpDir, "album.zip");
            fs.writeFileSync(zipFile, zipBuf);
            const extracted = extractZipSafely(zipFile, ctx.tmpDir);
            fs.unlinkSync(zipFile);
            return {
              files: extracted.map((p, idx) => ({
                path: p,
                name: path.basename(p),
                title: `Track ${idx + 1}`,
                artist: candidate.artist || "Test Artist",
                album: candidate.album || "Test Album",
                trackNumber: idx + 1,
                size: fs.statSync(p).size,
              })),
            };
          }

          const singleFile = path.join(ctx.tmpDir, "01 Track.flac");
          fs.writeFileSync(singleFile, mockFlac);
          return {
            files: [
              {
                path: singleFile,
                name: "01 Track.flac",
                title: candidate.title || "Track One",
                artist: candidate.artist || "Artist One",
                album: candidate.album || "Album One",
                trackNumber: 1,
                size: fs.statSync(singleFile).size,
              },
            ],
          };
        },
      };

      (acquisition as any).registry.register(mockAcquisitionProvider);

      const { cookie, response: loginResponse } = await login(app);
      const loginUser = loginResponse.json().user;

      // 1. Direct file acquisition
      const acq1Res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          candidate: {
            id: "test-track-1",
            provider: "mock-http-acquisition",
            title: "Direct Song",
            artist: "Direct Artist",
            album: "Direct Album",
          },
        },
      });

      expect(acq1Res.statusCode).toBe(202);
      const acq1Data = acq1Res.json();
      expect(acq1Data.jobId).toBeDefined();

      // Wait for job to process
      let job1 = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const checkRes = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${acq1Data.jobId}`,
          headers: { cookie },
        });
        job1 = checkRes.json().job;
        if (job1.status === "completed" || job1.status === "failed") break;
      }

      expect(job1.status).toBe("completed");
      expect(job1.files.length).toBe(1);
      expect(fakeBackend.scanLibrary).toHaveBeenCalled();

      // 2. Deduplication: requesting the exact same track resolves immediately without new download
      (fakeBackend.search as any).mockImplementation(async () => ({
        tracks: [
          {
            id: "local-direct-song-1",
            title: "Direct Song",
            artistName: "Direct Artist",
            albumName: "Direct Album",
            duration: 180,
          },
        ],
        albums: [],
        artists: [],
        playlists: [],
      }));

      const dedupRes = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "unified-1",
            type: "track",
            title: "Direct Song",
            artist: "Direct Artist",
            album: "Direct Album",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(dedupRes.statusCode).toBe(200);
      expect(dedupRes.json().status).toBe("completed");

      // 3. Album Container Acquisition (Download once, 3 tracks imported)
      const albumRes = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          containerId: "album-container-123",
          candidate: {
            id: "test-album-package",
            provider: "mock-http-acquisition",
            kind: "album-container",
            title: "Test Album",
            artist: "Test Artist",
            album: "Test Album",
            container: { id: "album-container-123", name: "Test Album" },
          },
        },
      });

      expect(albumRes.statusCode).toBe(202);
      const albumData = albumRes.json();

      let albumJob = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const checkRes = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${albumData.jobId}`,
          headers: { cookie },
        });
        albumJob = checkRes.json().job;
        if (albumJob.status === "completed" || albumJob.status === "failed") break;
      }

      expect(albumJob.status).toBe("completed");
      expect(albumJob.files.length).toBe(3);

      // 4. Container Reuse (Requesting another track from the same container hits container cache)
      const containerReuseRes = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          containerId: "album-container-123",
          candidate: {
            id: "test-album-package",
            provider: "mock-http-acquisition",
            container: { id: "album-container-123" },
          },
        },
      });

      expect(containerReuseRes.statusCode).toBe(200);
      expect(containerReuseRes.json().status).toBe("completed");

      // 5. Cancellation
      const slowJob = await acquisition.createJob({
        userId: loginUser.id,
        candidate: { id: "slow-candidate", provider: "mock-http-acquisition" },
      });
      const cancelRes = await app.inject({
        method: "POST",
        url: `/api/acquisitions/${slowJob.id}/cancel`,
        headers: { cookie },
      });
      expect(cancelRes.statusCode).toBe(200);
      const cancelledJob = acquisition.getJob(slowJob.id);
      expect(cancelledJob?.status).toBe("cancelled");

      // 6. Admin summary & cleanup
      const adminSummaryRes = await app.inject({
        method: "GET",
        url: "/api/admin/acquisitions",
        headers: { cookie },
      });
      expect(adminSummaryRes.statusCode).toBe(200);
      const summary = adminSummaryRes.json();
      expect(summary.completedJobs).toBeGreaterThan(0);

      const cleanupRes = await app.inject({
        method: "POST",
        url: "/api/admin/acquisitions/cleanup",
        headers: { cookie },
      });
      expect(cleanupRes.statusCode).toBe(200);

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/admin/acquisitions/scan",
        headers: { cookie },
      });
      expect(scanRes.statusCode).toBe(200);
      expect(scanRes.json().scanned).toBe(true);

      // Clean up test server
      await closeTestServer(app, db);
    }, 15000);

    it("enforces user permissions for acquisition", async () => {
      const { app, db } = await createTestServer();

      // Create a restricted user without external permissions
      db.prepare(`
        INSERT INTO users (id, username, password_hash, display_name, role, external_playback_enabled, disabled, created_at, updated_at)
        VALUES ('restricted-user', 'restricted', 'hash', 'Restricted User', 'user', 0, 0, datetime('now'), datetime('now'))
      `).run();

      // Directly create session for restricted user
      const sessionId = "restricted-session";
      db.prepare(`
        INSERT INTO sessions (id, user_id, created_at, expires_at)
        VALUES (?, 'restricted-user', datetime('now'), datetime('now', '+1 day'))
      `).run(sessionId);

      const cookieHeader = `musicdeck_session=${sessionId}`;

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie: cookieHeader },
        payload: {
          candidate: { id: "test", provider: "mock" },
        },
      });

      expect(res.statusCode).toBe(403);

      await closeTestServer(app, db);
    });

    it("respects auto-scan disabled setting during import and places media under musicRoot", async () => {
      const scanFn = vi.fn(async () => ({ count: 1, scanning: false }));
      const fakeBackend = createFakeBackend({
        scanLibrary: scanFn,
      });

      const customMusicRoot = path.join(process.cwd(), "data", `test-music-root-${Date.now()}`);
      fs.mkdirSync(customMusicRoot, { recursive: true });

      const { app, db, acquisition } = await createTestServer(
        fakeBackend,
        {},
        undefined,
        undefined,
        undefined
      );

      // Explicitly override baseMusicDir on the acquisition service to our customMusicRoot
      (acquisition as any).baseMusicDir = customMusicRoot;
      (acquisition as any).options.autoScan = false;
      updateServerSettings(db, { "acquisition.autoScanLibrary": false });

      const mockFlac = createMockFlacBuffer();
      const mockProvider: AcquisitionProvider = {
        id: "mock-provider-no-scan",
        name: "Mock Provider",
        canAcquire: () => true,
        acquire: async (_cand, ctx) => {
          const file = path.join(ctx.tmpDir, "01 Track.flac");
          fs.writeFileSync(file, mockFlac);
          return {
            files: [
              {
                path: file,
                name: "01 Track.flac",
                title: "Custom Root Song",
                artist: "Custom Root Artist",
                album: "Custom Root Album",
                trackNumber: 1,
                size: fs.statSync(file).size,
              },
            ],
          };
        },
      };

      (acquisition as any).registry.register(mockProvider);
      const { cookie } = await login(app);

      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/acquisitions",
          headers: { cookie },
          payload: {
            candidate: {
              id: "https://example.com/custom-root-song.flac",
              provider: "mock-provider-no-scan",
              title: "Custom Root Song",
              artist: "Custom Root Artist",
              album: "Custom Root Album",
            },
          },
        });

        expect(createRes.statusCode).toBe(202);
        const { jobId } = createRes.json();

        // Wait for completion
        let job = await acquisition.getJob(jobId);
        let retries = 0;
        while (job && job.status !== "completed" && job.status !== "failed" && retries < 20) {
          await new Promise((r) => setTimeout(r, 100));
          job = await acquisition.getJob(jobId);
          retries++;
        }

        expect(job?.status).toBe("completed");
        // Verify media file is stored under customMusicRoot
        expect(job?.files?.[0]?.path.startsWith(customMusicRoot)).toBe(true);
        expect(fs.existsSync(job!.files![0].path)).toBe(true);

        // Auto-scan was disabled, scanFn must NOT have been called
        expect(scanFn).not.toHaveBeenCalled();
      } finally {
        await closeTestServer(app, db);
        if (fs.existsSync(customMusicRoot)) {
          fs.rmSync(customMusicRoot, { recursive: true, force: true });
        }
      }
    });
  });

  describe("Discovery-First Acquisition Workflow & Candidate Resolution", () => {
    it("Case A: Track-only acquisition request performs server-side discovery and downloads candidate", async () => {
      const mockFlac = createMockFlacBuffer();
      const fakeBackend = createFakeBackend({
        search: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })),
      });
      const { app, db, acquisition, library, sourcePipeline, plugins } = await createTestServer(fakeBackend);
      await plugins.enable("on-demand-library");

      // Ensure track exists in library ID registry
      const stableTrackId = library.ensureId("track", {
        connectionId: "test-connection",
        providerItemId: "track-1",
      });

      // Register discovery provider in sourcePipeline and enable it
      sourcePipeline.registerDiscovery({
        id: "mock-discovery",
        name: "Mock Discovery",
        search: async (result) => [
          {
            id: `discovered-${result.title}`,
            provider: "mock-discovery-provider",
            title: result.title,
            artist: result.artist ?? undefined,
            album: result.album ?? undefined,
          },
        ],
      });
      sourcePipeline.configure("mock-discovery", true);

      // Register matching acquisition provider
      const mockAcqProvider: AcquisitionProvider = {
        id: "mock-discovery-provider",
        name: "Mock Discovery Acq",
        canAcquire: (c) => c.provider === "mock-discovery-provider",
        acquire: async (candidate, ctx) => {
          const file = path.join(ctx.tmpDir, "discovered.flac");
          fs.writeFileSync(file, mockFlac);
          return {
            files: [
              {
                path: file,
                name: "discovered.flac",
                title: candidate.title || "Discovered Track",
                artist: candidate.artist || "Discovered Artist",
                album: candidate.album || "Discovered Album",
                size: fs.statSync(file).size,
              },
            ],
          };
        },
      };
      (acquisition as any).registry.register(mockAcqProvider);

      const { cookie } = await login(app);

      // Request acquisition passing only trackId
      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          trackId: stableTrackId,
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("completed");
      expect(job.files.length).toBe(1);
      expect(job.files[0].title).toBe("Track One");

      await closeTestServer(app, db);
    });

    it("Case B: Candidate-specific acquisition targets explicit candidate directly", async () => {
      const mockFlac = createMockFlacBuffer();
      const fakeBackend = createFakeBackend();
      const { app, db, acquisition } = await createTestServer(fakeBackend);

      const mockAcqProvider: AcquisitionProvider = {
        id: "explicit-acq-provider",
        name: "Explicit Acq",
        canAcquire: (c) => c.id === "explicit-candidate-999",
        acquire: async (candidate, ctx) => {
          const file = path.join(ctx.tmpDir, "explicit.flac");
          fs.writeFileSync(file, mockFlac);
          return {
            files: [
              {
                path: file,
                name: "explicit.flac",
                title: "Explicit Track",
                artist: "Explicit Artist",
                album: "Explicit Album",
                size: fs.statSync(file).size,
              },
            ],
          };
        },
      };
      (acquisition as any).registry.register(mockAcqProvider);

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          candidateId: "explicit-candidate-999",
          candidate: {
            id: "explicit-candidate-999",
            provider: "explicit-acq-provider",
            title: "Explicit Track",
            artist: "Explicit Artist",
            album: "Explicit Album",
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("completed");
      expect(job.files[0].title).toBe("Explicit Track");

      await closeTestServer(app, db);
    });

    it("Case C: Fails with NO_CANDIDATES when discovery finds no candidates", async () => {
      const fakeBackend = createFakeBackend();
      const { app, db, sourcePipeline } = await createTestServer(fakeBackend);

      // Discovery returns empty list
      sourcePipeline.registerDiscovery({
        id: "empty-discovery",
        name: "Empty Discovery",
        search: async () => [],
      });
      sourcePipeline.configure("empty-discovery", true);

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "unknown-track",
            type: "track",
            title: "Nonexistent Song 12345",
            artist: "Ghost Artist",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("failed");
      expect(job.errorCode).toBe("NO_CANDIDATES");
      expect(job.errorMessage).toMatch(/No candidates found/i);

      await closeTestServer(app, db);
    });

    it("Case D: Preview sources are filtered out and not treated as acquisition candidates", async () => {
      const fakeBackend = createFakeBackend();
      const { app, db, sourcePipeline, acquisition } = await createTestServer(fakeBackend);

      // Discovery returns preview-only candidates
      sourcePipeline.registerDiscovery({
        id: "preview-discovery",
        name: "Preview Discovery",
        search: async (result) => [
          {
            id: `itunes-preview-${result.title}`,
            provider: "itunes-preview",
            title: result.title,
            artist: result.artist ?? undefined,
            metadata: { preview: true },
          },
        ],
      });
      sourcePipeline.configure("preview-discovery", true);

      const acquireSpy = vi.fn();
      const mockProvider: AcquisitionProvider = {
        id: "generic-provider",
        name: "Generic Provider",
        canAcquire: () => true,
        acquire: acquireSpy,
      };
      (acquisition as any).registry.register(mockProvider);

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "preview-track",
            type: "track",
            title: "Preview Only Song",
            artist: "Sample Artist",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("failed");
      expect(job.errorCode).toBe("NO_ACQUIREABLE_SOURCE");
      expect(acquireSpy).not.toHaveBeenCalled();

      await closeTestServer(app, db);
    });

    it("Case H: Provider failure isolation falls back to next valid acquireable candidate", async () => {
      const mockFlac = createMockFlacBuffer();
      const fakeBackend = createFakeBackend();
      const { app, db, sourcePipeline, acquisition } = await createTestServer(fakeBackend);

      // Discovery returns 2 candidates: first one will fail, second will succeed
      sourcePipeline.registerDiscovery({
        id: "multi-discovery",
        name: "Multi Discovery",
        search: async (result) => [
          {
            id: "broken-candidate-1",
            provider: "failing-provider",
            title: result.title,
            artist: result.artist ?? undefined,
          },
          {
            id: "working-candidate-2",
            provider: "working-provider",
            title: result.title,
            artist: result.artist ?? undefined,
          },
        ],
      });
      sourcePipeline.configure("multi-discovery", true);

      const failingProvider: AcquisitionProvider = {
        id: "failing-provider",
        name: "Failing Provider",
        canAcquire: (c) => c.provider === "failing-provider",
        acquire: async () => {
          throw new Error("Simulated upstream network timeout");
        },
      };

      const workingProvider: AcquisitionProvider = {
        id: "working-provider",
        name: "Working Provider",
        canAcquire: (c) => c.provider === "working-provider",
        acquire: async (candidate, ctx) => {
          const file = path.join(ctx.tmpDir, "fallback.flac");
          fs.writeFileSync(file, mockFlac);
          return {
            files: [
              {
                path: file,
                name: "fallback.flac",
                title: candidate.title || "Fallback Track",
                artist: candidate.artist || "Fallback Artist",
                size: fs.statSync(file).size,
              },
            ],
          };
        },
      };

      (acquisition as any).registry.register(failingProvider);
      (acquisition as any).registry.register(workingProvider);

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "fallback-test-track",
            type: "track",
            title: "Fallback Song",
            artist: "Fallback Artist",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("completed");
      expect(job.files[0].title).toBe("Fallback Song");

      await closeTestServer(app, db);
    });

    it("Direct candidate acquisition test with deterministic fixture candidate", async () => {
      const mockFlac = createMockFlacBuffer();
      const fakeFetch = vi.fn(async (url: any) => {
        if (String(url).includes("test.flac")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              "content-length": String(mockFlac.length),
              "content-type": "audio/flac",
            }),
            arrayBuffer: async () => mockFlac.buffer.slice(mockFlac.byteOffset, mockFlac.byteOffset + mockFlac.byteLength),
          };
        }
        return { ok: false, status: 404 };
      }) as any;

      const fakeBackend = createFakeBackend();
      const { app, db, plugins, acquisition } = await createTestServer(fakeBackend, {}, fakeFetch, fakeFetch, fakeFetch);
      plugins.configure("on-demand-library", {
        permissions: ["library.acquire", "library.write", "library.read", "network.request"],
      });
      await plugins.enable("on-demand-library");

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          candidate: {
            id: "public-test:https://example.test/audio/test.flac",
            provider: "public-test",
            kind: "file",
            title: "Test Track",
            artist: "Test Artist",
            album: "Test Album",
            metadata: {
              acquisitionUrl: "https://example.test/audio/test.flac",
            },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("completed");
      expect(job.files.length).toBe(1);
      expect(job.files[0].title).toBe("Test Track");

      await closeTestServer(app, db);
    });

    it("End-to-End: Public website scraper discovery + no-auth HTTP acquisition with deterministic mock", async () => {
      const mockFlac = createMockFlacBuffer();
      const searchHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <div class="search-results">
              <a href="https://melodyinbox.com/media/Blackway_Black_Caviar_Whats_Up_Danger.flac" title="Blackway & Black Caviar - What's Up Danger">
                Blackway &amp; Black Caviar - What&#39;s Up Danger (FLAC)
              </a>
            </div>
          </body>
        </html>
      `;

      const fakeFetch = vi.fn(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("melodyinbox.com") && !urlStr.includes(".flac")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "text/html" }),
            text: async () => searchHtml,
          };
        }
        if (urlStr.includes(".flac")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              "content-length": String(mockFlac.length),
              "content-type": "audio/flac",
            }),
            arrayBuffer: async () => mockFlac.buffer.slice(mockFlac.byteOffset, mockFlac.byteOffset + mockFlac.byteLength),
          };
        }
        return { ok: false, status: 404 };
      }) as any;

      const fakeBackend = createFakeBackend({
        scanLibrary: vi.fn(async () => ({ count: 1, scanning: false })),
      });
      const { app, db, plugins, library } = await createTestServer(fakeBackend, {}, fakeFetch, fakeFetch, fakeFetch);

      // Enable site-sources plugin configured with https://melodyinbox.com
      plugins.configure("site-sources", {
        config: {
          siteUrls: "https://melodyinbox.com",
        },
        permissions: ["network.request", "external-source.play"],
      });
      await plugins.enable("site-sources");

      // Enable on-demand-library plugin with authType = "none"
      plugins.configure("on-demand-library", {
        config: {
          authType: "none",
          autoScanLibraryAfterImport: true,
        },
        permissions: ["library.acquire", "library.write", "library.read", "network.request"],
      });
      await plugins.enable("on-demand-library");

      const { cookie } = await login(app);

      // Trigger acquisition via track result
      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "track-danger",
            type: "track",
            title: "What's Up Danger",
            artist: "Blackway & Black Caviar",
            album: "Spider-Man: Into the Spider-Verse",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("completed");
      expect(job.files.length).toBe(1);
      expect(job.files[0].title).toBe("What's Up Danger");
      expect(job.files[0].artist).toBe("Blackway & Black Caviar");

      await closeTestServer(app, db);
    });

    it("Split Test B: Discovery finds candidate but no acquisition provider supports it -> fails with NO_ACQUIREABLE_SOURCE", async () => {
      const fakeBackend = createFakeBackend();
      const { app, db, sourcePipeline } = await createTestServer(fakeBackend);

      sourcePipeline.registerDiscovery({
        id: "unsupported-discovery",
        name: "Unsupported Discovery",
        search: async (result) => [
          {
            id: "unsupported-scheme://item123",
            provider: "unsupported-discovery",
            kind: "item",
            title: result.title,
            artist: result.artist ?? undefined,
          },
        ],
      });
      sourcePipeline.configure("unsupported-discovery", true);

      const { cookie } = await login(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/acquisitions",
        headers: { cookie },
        payload: {
          result: {
            id: "test-track-split-b",
            type: "track",
            title: "Split Song B",
            artist: "Split Artist B",
            provider: "external",
            source: { kind: "external", count: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();

      let job = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const check = await app.inject({
          method: "GET",
          url: `/api/acquisitions/${jobId}`,
          headers: { cookie },
        });
        job = check.json().job;
        if (job.status === "completed" || job.status === "failed") break;
      }

      expect(job.status).toBe("failed");
      expect(job.errorCode).toBe("NO_ACQUIREABLE_SOURCE");

      await closeTestServer(app, db);
    });
  });
});
