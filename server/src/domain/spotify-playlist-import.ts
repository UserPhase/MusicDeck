import fs from "node:fs";
import path from "node:path";

import type { MusicBackend } from "../backends/music-backend.js";
import type { SessionUser } from "../types.js";
import { createId } from "../utils/ids.js";
import type { DownloaderAdapter } from "./downloader-adapter.js";
import type { AcquiredFile } from "./acquisition.js";
import type { PlaylistService } from "./playlist-service.js";

export type SpotifyImportJob = {
  id: string;
  userId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  stage: "queued" | "fetching" | "downloading" | "scanning" | "completed";
  playlistId?: string;
  playlistName?: string;
  expectedCount?: number;
  downloadedCount?: number;
  importedCount?: number;
  error?: string;
};

/** Accept only a Spotify playlist identity, then rebuild the URL ourselves. */
export function parseSpotifyPlaylistUrl(value: string): { id: string; url: string } | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.hostname !== "open.spotify.com" || parsed.port || parsed.username || parsed.password) return null;
    const match = /^\/playlist\/([a-zA-Z0-9]+)\/?$/.exec(parsed.pathname);
    return match ? { id: match[1], url: `https://open.spotify.com/playlist/${match[1]}` } : null;
  } catch {
    return null;
  }
}

export class SpotifyPlaylistImportService {
  private readonly jobs = new Map<string, SpotifyImportJob>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: MusicBackend,
    private readonly playlists: PlaylistService,
    private readonly downloader: DownloaderAdapter,
    private readonly musicRoot: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly importSubdir = "Spotify Imports"
  ) {}

  start(playlistUrl: string, user: SessionUser): SpotifyImportJob {
    const spotify = parseSpotifyPlaylistUrl(playlistUrl);
    if (!spotify) throw new Error("Please enter a valid open.spotify.com/playlist URL");
    if ([...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length >= 5) {
      throw new Error("The import queue is full. Please try again shortly.");
    }

    const job: SpotifyImportJob = {
      id: createId("spimp"), userId: user.id, status: "queued", stage: "queued",
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 100) {
      const completed = [...this.jobs].find(([, value]) => ["completed", "partial", "failed"].includes(value.status));
      if (completed) this.jobs.delete(completed[0]);
    }
    this.tail = this.tail.then(async () => {
      job.status = "running";
      job.stage = "fetching";
      await this.run(job, spotify, user);
    }).catch((error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Spotify playlist import failed";
    });
    return { ...job };
  }

  get(jobId: string, userId: string): SpotifyImportJob | null {
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? { ...job } : null;
  }

  private async spotifyTitle(playlistUrl: string): Promise<string | null> {
    try {
      const endpoint = new URL("https://open.spotify.com/oembed");
      endpoint.searchParams.set("url", playlistUrl);
      const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const data = await response.json() as { title?: unknown };
      return typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  private async run(job: SpotifyImportJob, spotify: { id: string; url: string }, user: SessionUser): Promise<void> {
    if (!this.backend.scanLibrary) {
      throw new Error("Playlist import requires a Navidrome library with scanning enabled");
    }

    const previousIds = new Set((await this.backend.listPlaylists()).map((playlist) => playlist.id));
    const titlePromise = this.spotifyTitle(spotify.url);
    const root = path.resolve(this.musicRoot);
    const outputDir = path.resolve(root, this.importSubdir, job.id);
    const relativeOutput = path.relative(root, outputDir);
    if (relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) {
      throw new Error("Spotify import folder must be inside the music library");
    }
    const m3uName = `musicdeck-${job.id}.m3u8`;
    fs.mkdirSync(outputDir, { recursive: true });
    job.stage = "downloading";

    const result = await this.downloader.download({
      query: spotify.url,
      outputDirectory: outputDir,
      filenameTemplate: "{list-position} - {artists} - {title}.{output-ext}",
      playlistM3uName: m3uName,
      timeoutMs: 30 * 60 * 1000,
    }, {
      jobId: job.id,
      tmpDir: outputDir,
      signal: new AbortController().signal,
    });

    if (result.status !== "completed") {
      throw new Error(result.error?.message || "spotDL did not download any playlist tracks");
    }
    const m3uPath = path.join(outputDir, m3uName);
    if (!fs.existsSync(m3uPath)) {
      throw new Error("spotDL finished without writing the playlist M3U file");
    }

    const sourceTracks = result.playlistTracks;
    if (!sourceTracks?.length || !result.playlistLength) {
      throw new Error("spotDL did not provide a verifiable source track list. The partial download was not marked successful.");
    }
    job.expectedCount = result.playlistLength;
    const filesByPosition = new Map<number, AcquiredFile>();
    for (const file of result.files) {
      const position = Number(/^([0-9]+) - /.exec(path.basename(file.path))?.[1]);
      if (Number.isSafeInteger(position) && position > 0 && fs.existsSync(file.path)) filesByPosition.set(position, file);
    }

    // spotDL can exit 0 after individual songs fail. Retry those Spotify IDs
    // independently, preserving their original positions in the playlist.
    for (const track of sourceTracks) {
      if (filesByPosition.has(track.position) || !/^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+/.test(track.url)) continue;
      const retry = await this.downloader.download({
        spotifyTrackUrl: track.url,
        outputDirectory: outputDir,
        filenameTemplate: `${track.position} - {artists} - {title}.{output-ext}`,
        broadenAudioSearch: true,
        timeoutMs: 120_000,
      }, {
        jobId: `${job.id}-retry-${track.position}`,
        tmpDir: outputDir,
        signal: new AbortController().signal,
      });
      const recovered = retry.files.find((file) =>
        path.basename(file.path).startsWith(`${track.position} - `) && fs.existsSync(file.path)
      );
      if (retry.status === "completed" && recovered) filesByPosition.set(track.position, recovered);
    }

    const available = sourceTracks.filter((track) => filesByPosition.has(track.position));
    if (!available.length) throw new Error("spotDL could not obtain audio for any playlist tracks");
    job.downloadedCount = available.length;
    const m3uLines = ["#EXTM3U"];
    for (const track of available) {
      const file = filesByPosition.get(track.position)!;
      const relative = path.relative(outputDir, file.path);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("A downloaded track was placed outside the playlist folder");
      }
      m3uLines.push(`#EXTINF:${Math.round(track.duration)},${track.artist} - ${track.title}`);
      m3uLines.push(relative.replaceAll(path.sep, "/"));
    }
    fs.writeFileSync(m3uPath, `${m3uLines.join("\n")}\n`, "utf8");

    job.stage = "scanning";
    await this.backend.scanLibrary();

    // Navidrome's scanner can finish before M3U auto-import becomes visible.
    let importedId: string | null = null;
    let providerCount = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const candidates = (await this.backend.listPlaylists()).filter((playlist) => !previousIds.has(playlist.id));
      const expectedName = path.parse(m3uName).name.toLowerCase();
      const matching = candidates.find((playlist) => playlist.name.toLowerCase() === expectedName);
      if (matching) {
        importedId = matching.id;
        const providerPlaylist = await this.backend.getPlaylist(matching.id);
        providerCount = providerPlaylist?.tracks?.length || 0;
        if (providerCount >= available.length) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!importedId) {
      throw new Error("Navidrome did not import the M3U playlist. Check AutoImportPlaylists and the shared music folder.");
    }
    if (providerCount === 0) {
      throw new Error(`Navidrome found the playlist but imported 0 of ${available.length} downloaded tracks. Check M3U paths and library scanning.`);
    }

    const title = await titlePromise;
    const playlist = await this.playlists.adoptProviderPlaylist(importedId, user, title || `Spotify Playlist ${spotify.id.slice(0, 8)}`);
    job.playlistId = playlist.id;
    job.playlistName = playlist.name;
    job.importedCount = playlist.tracks?.length ?? providerCount;
    job.stage = "completed";
    const missing = Math.max(0, job.expectedCount - job.importedCount);
    job.status = missing ? "partial" : "completed";
    if (missing) {
      job.error = `Imported ${job.importedCount} of ${job.expectedCount} songs. ${missing} could not be downloaded or indexed; see musicdeck-errors.txt in the import folder for spotDL failures.`;
    }
  }
}
