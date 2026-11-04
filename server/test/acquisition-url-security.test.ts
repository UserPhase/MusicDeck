import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { canonicalManualAcquisitionUrl } from "../src/domain/acquisition-url-policy.js";
import { SpotDLDownloaderAdapter } from "../src/domain/spotdl-downloader-adapter.js";
import type { DownloadRequest } from "../src/domain/downloader-adapter.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

const unsafe = [
  "http://www.youtube.com/watch?v=abc", "https://127.0.0.1/audio", "https://youtube.com.evil.test/watch?v=abc",
  "https://evil.youtube.com/watch?v=abc", "https://youtube.com@127.0.0.1/a",
  "https://user:pass@www.youtube.com/watch?v=abc", "https://www.youtube.com:8443/watch?v=abc",
  "file:///etc/passwd", "--config=/etc/passwd", "not a url", "https://www.youtube.com/redirect?q=https://127.0.0.1",
  "https://www.youtube.com\\@127.0.0.1/watch?v=abc", "https://www.youtube.com./watch?v=abc",
  "https://www.youtube.com/watch?v=abc|https://127.0.0.1",
  "https://evil.test/track/song", "data:text/plain,test", "gopher://127.0.0.1",
];

describe("SpotDL trust boundary", () => {
  test.each(unsafe)("rejects %s in every alternate field without spawning", async (url) => {
    const run = vi.fn();
    const adapter = new SpotDLDownloaderAdapter({ runner: { run }, spotdlPath: "spotdl" });
    const context = { jobId: "rejected", tmpDir: os.tmpdir(), signal: new AbortController().signal };
    const base = { outputDirectory: os.tmpdir(), query: "Artist - Song" };
    const inputs: DownloadRequest[] = [
      { ...base, sourceUrl: url }, { ...base, spotifyTrackUrl: url }, { ...base, query: url },
      ...["acquisitionUrl", "downloadUrl", "fileUrl"].map((field) => ({
        ...base, candidate: { id: "spoofed", provider: "spotdl", metadata: { [field]: url } },
      })),
      { ...base, candidate: { id: "spoofed", provider: "not-spotdl", detailUrl: url } },
    ];
    for (const input of inputs) {
      // A plain text query is allowed; it is not interpreted as a URL.
      if (input.query === "not a url") continue;
      const result = await adapter.download(input, context);
      expect(result.error?.code).toBe("invalid-input");
    }
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    "https://youtu.be/fJ9rUzIMcZQ", "https://music.youtube.com/watch?v=fJ9rUzIMcZQ&list=RD123",
    "https://soundcloud.com/artist/song", "https://artist.bandcamp.com/track/song",
    "https://artist.bandcamp.com/album/release",
  ])("approved source reaches the runner: %s", async (sourceUrl) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acquisition-url-"));
    try {
      const run = vi.fn(() => ({ pid: 1, kill: vi.fn(), promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "fixture failure" }) }));
      const adapter = new SpotDLDownloaderAdapter({ runner: { run }, spotdlPath: "spotdl" });
      await adapter.download({ sourceUrl, outputDirectory: directory }, {
        jobId: "allowed", tmpDir: directory, signal: new AbortController().signal,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]).toBeDefined();
      expect(canonicalManualAcquisitionUrl(sourceUrl)).toMatch(/^https:\/\//);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("API rejects spoofed URLs and unknown input before retaining jobs", async () => {
    const { app, db, acquisition } = await createTestServer(createFakeBackend());
    try {
      const { cookie } = await login(app);
      for (const provider of ["spotdl", "spoofed-provider"]) {
        for (const field of ["acquisitionUrl", "downloadUrl", "fileUrl"]) {
          const response = await app.inject({ method: "POST", url: "/api/acquisitions", headers: { cookie },
            payload: { candidate: { id: "bad", provider, metadata: { acquisitionUrl: "https://youtu.be/good", [field]: "https://127.0.0.1/a" } } } });
          expect(response.statusCode).toBe(400);
        }
      }
      for (const payload of [
        { candidate: { id: "bad", provider: "spotdl", acquisitionUrl: "https://127.0.0.1" } },
        { trackId: "x", autoPlay: "true" }, { trackId: "x", unexpected: true },
        { trackId: "x", spotifyTrackUrl: "https://open.spotify.com/track/good", spotifyUrl: "https://127.0.0.1" },
      ]) {
        const response = await app.inject({ method: "POST", url: "/api/acquisitions", headers: { cookie }, payload });
        expect(response.statusCode).toBe(400);
      }
      expect(acquisition.listJobs()).toHaveLength(0);
    } finally { await closeTestServer(app, db); }
  });
});
