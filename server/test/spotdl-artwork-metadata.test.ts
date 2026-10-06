import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { SpotDLDownloaderAdapter } from "../src/domain/spotdl-downloader-adapter.js";
import type { ProcessRunner } from "../src/domain/process-runner.js";
import { largestSpotifyArtwork } from "../src/utils/spotifyArtworkUrl.js";

test("playlist metadata uses the highest-resolution Spotify album image and retains nested album ID", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotdl-cover-"));
  try {
    const images = [
      { url: "https://i.scdn.co/image/small", width: 64, height: 64 },
      { url: "https://i.scdn.co/image/large", width: 640, height: 640 },
      { url: "http://localhost/private", width: 10000, height: 10000 },
    ];
    expect(largestSpotifyArtwork(images)).toBe("https://i.scdn.co/image/large");
    const runner: ProcessRunner = {
      run: vi.fn((_command, _args, options) => {
        if (!options?.cwd) throw new Error("Expected metadata output directory");
        fs.writeFileSync(path.join(options.cwd, "musicdeck-source.spotdl"), JSON.stringify([{
          name: "Babydoll", artist: "Dominic Fike", duration: 180, url: "https://open.spotify.com/track/abc",
          cover_url: "https://i.scdn.co/image/small",
          album: { name: "Demos", id: "spotifyalbum", images },
        }]));
        return { kill: () => {}, promise: Promise.resolve({ exitCode: 0, stdout: "Saved", stderr: "" }) };
      }),
    };
    const result = await new SpotDLDownloaderAdapter({ runner }).fetchPlaylistTracks(
      "https://open.spotify.com/playlist/abc", { jobId: "artwork", tmpDir: directory, signal: new AbortController().signal });
    expect(result.playlistTracks?.[0]).toMatchObject({
      artworkUrl: "https://i.scdn.co/image/large", albumId: "spotifyalbum", album: "Demos",
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
