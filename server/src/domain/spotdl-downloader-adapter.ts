import fs from "node:fs";
import { largestSpotifyArtwork } from "../utils/spotifyArtworkUrl.js";
import os from "node:os";
import path from "node:path";
import type {
  DownloaderAdapter,
  DownloaderCapabilities,
  DownloadRequest,
  DownloadContext,
  DownloadResult,
  DownloadProgress,
  DownloadStage,
  DownloadErrorCode,
  DownloadDiagnostics,
  SpotifyImportTrackMetadata,
} from "./downloader-adapter.js";
import { DefaultProcessRunner, type ProcessHandle, type ProcessRunner } from "./process-runner.js";
import type { AcquiredFile } from "./acquisition.js";
import { DeezerImportMatcher } from "../services/discovery/deezerImportMatcher.js";

const isWindows = process.platform === "win32";

/**
 * Best-effort auto-detection of the spotDL executable.
 *
 * spotDL is typically installed via `pip install spotdl`, which places a
 * console-script binary in the active Python's user/Scripts directory. That
 * directory is frequently not on PATH (especially on Windows with per-user
 * pip installs), so a bare "spotdl" spawn can fail even when spotDL is
 * installed and working. This checks a handful of standard install
 * locations before falling back to the bare command name (which still
 * works if the caller's PATH already includes it, e.g. inside the project's
 * Docker image).
 */
export function autoDetectSpotDLPath(): string {
  const home = os.homedir();
  const candidates: string[] = [];

  if (isWindows) {
    const appData = process.env.APPDATA;
    if (appData) {
      // Versioned per-user pip installs: %APPDATA%\Python\Python3XX\Scripts\spotdl.exe
      const pythonRoot = path.join(appData, "Python");
      if (fs.existsSync(pythonRoot)) {
        try {
          for (const entry of fs.readdirSync(pythonRoot)) {
            candidates.push(path.join(pythonRoot, entry, "Scripts", "spotdl.exe"));
          }
        } catch {}
      }
    }
    candidates.push(path.join(home, "AppData", "Roaming", "Python", "Scripts", "spotdl.exe"));
    candidates.push("C:\\Python314\\Scripts\\spotdl.exe");
    candidates.push("C:\\Python313\\Scripts\\spotdl.exe");
    candidates.push("C:\\Python312\\Scripts\\spotdl.exe");
  } else {
    // Container images install spotDL into a dedicated virtualenv; prefer
    // it so detection does not depend on PATH being inherited by the
    // spawning process.
    const venvHome = process.env.SPOTDL_HOME;
    if (venvHome) {
      candidates.push(path.join(venvHome, "bin", "spotdl"));
    }
    candidates.push("/opt/spotdl/bin/spotdl");
    candidates.push(path.join(home, ".local", "bin", "spotdl"));
    candidates.push("/usr/local/bin/spotdl");
    candidates.push("/usr/bin/spotdl");
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return "spotdl";
}

/**
 * Best-effort auto-detection of an FFmpeg binary.
 *
 * spotDL can download and manage its own FFmpeg copy (`spotdl --download-ffmpeg`),
 * which it stores under `~/.spotdl/ffmpeg[.exe]`. When a system-wide FFmpeg
 * isn't on PATH, prefer that spotDL-managed copy before falling back to the
 * bare command name.
 */
export function autoDetectFFmpegPath(): string {
  const home = os.homedir();
  const ext = isWindows ? ".exe" : "";
  const candidates = [
    path.join(home, ".spotdl", `ffmpeg${ext}`),
  ];

  if (isWindows) {
    candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
  } else {
    candidates.push("/usr/local/bin/ffmpeg");
    candidates.push("/usr/bin/ffmpeg");
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return "ffmpeg";
}

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".opus",
  ".wav",
  ".aac",
  ".alac",
  ".aiff",
]);

/** Shared on-disk layout for direct spotDL acquisitions and Spotify playlists. */
export const SPOTDL_LIBRARY_TEMPLATE = "{artists}/{album}/{artists} - {title}.{output-ext}";

export type SpotDLAdapterOptions = {
  spotdlPath?: string;
  ffmpegPath?: string;
  processRunner?: ProcessRunner;
  runner?: ProcessRunner;
  timeoutMs?: number;
  clientId?: string;
  clientSecret?: string;
  cookieFile?: string;
  fetchImpl?: typeof fetch;
};

export type SpotDLDiagnosticResult = {
  spotdlInstalled: boolean;
  spotdlVersion?: string;
  ffmpegAvailable: boolean;
  ffmpegVersion?: string;
  spotdlPath: string;
  ffmpegPath: string;
};

/**
 * Hosts spotDL's underlying audio-provider backends actually understand for
 * a "manual audio URL" input (YouTube / YouTube Music, SoundCloud, Bandcamp).
 * Generic direct-file links (e.g. a `.flac`/`.mp3` URL from an unrelated
 * HTTP-hosting site) are NOT valid spotDL inputs — those belong to a plain
 * HTTP downloader adapter instead. Restricting this prevents spotDL from
 * greedily claiming candidates it cannot actually handle, which otherwise
 * wastes a full download attempt (and can hang) before falling back.
 */
const SPOTDL_SUPPORTED_MANUAL_HOSTS = [
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "soundcloud.com",
  "bandcamp.com",
];

export function isSpotDLCompatibleManualUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return SPOTDL_SUPPORTED_MANUAL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/**
 * Resolves the path spotDL/yt-dlp's --cookie-file should point at, alongside
 * spotDL's own config directory (mirroring Reverb's cookiesFilePath model).
 * Returns "" if the user config dir can't be resolved.
 */
export function cookiesFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || (isWindows ? process.env.APPDATA : path.join(os.homedir(), ".config"));
  if (!configDir) return "";
  return path.join(configDir, "spotdl", "cookies.txt");
}

/**
 * Persists admin-pasted cookies.txt (Netscape format) content to disk so it
 * can be handed to yt-dlp as a real file path. Mode 0600: this is
 * authenticated session data and must not be world-readable.
 */
export function writeCookiesFile(content: string): string {
  const filePath = cookiesFilePath();
  if (!filePath) {
    throw new Error("Could not resolve a config directory to store cookies.txt");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

export function normalizeManualUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    } else if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

export class SpotDLDownloaderAdapter implements DownloaderAdapter {
  readonly id = "spotdl";
  readonly name = "spotDL Downloader";
  readonly capabilities: DownloaderCapabilities = {
    spotifyTrack: true,
    textSearch: true,
    directUrl: true,
    album: true,
    playlist: true,
    metadata: true,
  };

  private spotdlPath: string;
  private ffmpegPath: string;
  private readonly processRunner: ProcessRunner;
  private readonly timeoutMs: number;
  private clientId?: string;
  private clientSecret?: string;
  private cookieFile?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly deezerImportMatcher: DeezerImportMatcher;
  private readonly activeHandles = new Map<string, ProcessHandle>();

  constructor(options: SpotDLAdapterOptions = {}) {
    this.spotdlPath = options.spotdlPath || process.env.SPOTDL_PATH || autoDetectSpotDLPath();
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || autoDetectFFmpegPath();
    this.processRunner = options.processRunner || options.runner || new DefaultProcessRunner();
    this.timeoutMs = options.timeoutMs || 300_000; // 5 minutes timeout per download
    this.clientId = options.clientId || process.env.SPOTIFY_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.SPOTIFY_CLIENT_SECRET;
    this.cookieFile = options.cookieFile || process.env.SPOTDL_COOKIE_FILE;
    this.fetchImpl = options.fetchImpl || fetch;
    this.deezerImportMatcher = new DeezerImportMatcher(this.fetchImpl);
  }

  /**
   * Applies admin-configured settings (Spotify app credentials, optional
   * YouTube cookies file, and binary path overrides) at runtime, so the
   * plugin settings UI can update behavior without restarting the server.
   * Any option left undefined keeps its previously configured value.
   */
  configure(options: SpotDLAdapterOptions): void {
    if (options.spotdlPath !== undefined) this.spotdlPath = options.spotdlPath || autoDetectSpotDLPath();
    if (options.ffmpegPath !== undefined) this.ffmpegPath = options.ffmpegPath || autoDetectFFmpegPath();
    if (options.clientId !== undefined) this.clientId = options.clientId || undefined;
    if (options.clientSecret !== undefined) this.clientSecret = options.clientSecret || undefined;
    if (options.cookieFile !== undefined) this.cookieFile = options.cookieFile || undefined;
  }

  getMediaToolPaths(): { ffmpegPath: string; ffprobePath: string; pythonPath: string } {
    const ext = process.platform === "win32" ? ".exe" : "";
    const directory = path.dirname(this.ffmpegPath);
    const siblingProbe = path.join(directory, `ffprobe${ext}`);
    const spotdlDirectory = path.dirname(this.spotdlPath);
    const pythonCandidates = [
      path.join(spotdlDirectory, `python${ext}`),
      ...(process.platform === "win32" && path.basename(spotdlDirectory).toLowerCase() === "scripts"
        ? [path.join(path.dirname(spotdlDirectory), "python.exe")] : []),
      ...(process.env.SPOTDL_HOME ? [path.join(process.env.SPOTDL_HOME, process.platform === "win32" ? "Scripts" : "bin", `python${ext}`)] : []),
    ];
    return {
      ffmpegPath: this.ffmpegPath,
      ffprobePath: process.env.FFPROBE_PATH || (directory !== "." && fs.existsSync(siblingProbe) ? siblingProbe : "ffprobe"),
      pythonPath: process.env.MUSICDECK_TAGGER_PYTHON || pythonCandidates.find((candidate) => fs.existsSync(candidate)) || (process.platform === "win32" ? "python" : "python3"),
    };
  }

  canHandle(request: DownloadRequest): boolean {
    if (request.spotifyTrackUrl && request.spotifyTrackUrl.trim().length > 0) {
      return true;
    }
    if (request.spotifyTrackId && request.spotifyTrackId.trim().length > 0) {
      return true;
    }
    if (this.capabilities.directUrl && request.sourceUrl && isSpotDLCompatibleManualUrl(request.sourceUrl)) {
      return true;
    }
    if (request.candidate?.provider === this.id) {
      return true;
    }
    if (this.capabilities.textSearch && request.query && request.query.trim().length > 0) {
      return true;
    }
    return false;
  }

  async fetchPlaylistDetails(playlistId: string): Promise<{ title?: string; description?: string | null; artworkUrl?: string | null } | null> {
    if (!this.clientId || !this.clientSecret || !/^[a-zA-Z0-9]+$/.test(playlistId)) return null;
    try {
      const tokenResponse = await this.fetchImpl("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(4000),
      });
      if (!tokenResponse.ok) return null;
      const token = (await tokenResponse.json() as { access_token?: unknown }).access_token;
      if (typeof token !== "string" || !token) return null;
      const endpoint = new URL(`https://api.spotify.com/v1/playlists/${playlistId}`);
      endpoint.searchParams.set("fields", "name,description,images");
      const response = await this.fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const data = await response.json() as { name?: unknown; description?: unknown; images?: Array<{ url?: unknown }> };
      return {
        ...(typeof data.name === "string" ? { title: data.name.trim().slice(0, 200) } : {}),
        ...(typeof data.description === "string" ? { description: data.description.trim().slice(0, 2000) } : {}),
        ...(typeof data.images?.[0]?.url === "string" ? { artworkUrl: data.images[0].url } : {}),
      };
    } catch {
      return null;
    }
  }

  async fetchPlaylistTracks(playlistUrl: string, context: DownloadContext): Promise<DownloadResult> {
    const outputDir = context.tmpDir;
    fs.mkdirSync(outputDir, { recursive: true });
    const saveFile = "musicdeck-source.spotdl";
    const args = ["--log-level", "DEBUG", "--format", "mp3", "--bitrate", "320k", "--save-file", saveFile];
    if (this.clientId && this.clientSecret) {
      args.push("--client-id", this.clientId, "--client-secret", this.clientSecret);
    }
    args.push("save", playlistUrl);

    try {
      const handle = this.processRunner.run(this.spotdlPath, args, {
        cwd: outputDir,
        signal: context.signal,
        timeoutMs: 120_000,
      });
      this.activeHandles.set(context.jobId, handle);
      const result = await (handle.promise || handle.completion);
      if (context.signal.aborted) {
        return { status: "cancelled", files: [], error: { code: "cancelled", message: "Playlist lookup cancelled" } };
      }
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`;
        return { status: "failed", files: [], error: {
          code: classifySpotDLError(output),
          message: `spotDL could not read the playlist: ${extractErrorMessage(output)}`,
        } };
      }
      const metadata = readPlaylistMetadata(path.join(outputDir, saveFile));
      if (!metadata.playlistTracks?.length) {
        return { status: "failed", files: [], error: { code: "not-found", message: "Spotify playlist has no readable tracks" } };
      }
      return { status: "completed", files: [], ...metadata };
    } catch (error) {
      return { status: "failed", files: [], error: {
        code: "general", message: error instanceof Error ? error.message : "Could not read Spotify playlist",
      } };
    } finally {
      this.activeHandles.delete(context.jobId);
    }
  }

  async resolveTrackMetadata(source: NonNullable<DownloadResult["playlistTracks"]>[number], context: DownloadContext): Promise<NonNullable<DownloadResult["playlistTracks"]>[number] | null> {
    type Metadata = NonNullable<DownloadResult["playlistTracks"]>[number];
    const merge = (candidate: Metadata): Metadata => ({ ...candidate, ...source,
      title: source.title?.trim() || candidate.title,
      artist: source.artist?.trim() && !/unknown/i.test(source.artist) ? source.artist : candidate.artist,
      artists: [...new Set([...(source.artists || []), ...(candidate.artists || [])].map((name) => name.trim()).filter((name) => name && !/unknown/i.test(name)))],
      album: source.album?.trim() || candidate.album,
      albumArtist: source.albumArtist?.trim() && !/unknown/i.test(source.albumArtist) ? source.albumArtist : candidate.albumArtist,
      year: source.year || candidate.year, artworkUrl: source.artworkUrl || candidate.artworkUrl,
      isrc: source.isrc || candidate.isrc, duration: source.duration || candidate.duration,
      url: source.url, position: source.position,
    });
    const complete = (track: Metadata) => Boolean(track.title && track.artist && track.album && track.year && track.artworkUrl);
    let recovered = source;
    // Re-fetch this Spotify identity independently rather than discarding a malformed playlist item.
    if (/^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+$/.test(source.url)) {
      const directory = fs.mkdtempSync(path.join(context.tmpDir, "metadata-recovery-"));
      try {
        const result = await this.fetchPlaylistTracks(source.url, { ...context, tmpDir: directory });
        const candidate = result.playlistTracks?.find((track) => track.url === source.url) || result.playlistTracks?.[0];
        if (candidate) recovered = merge(candidate);
        if (complete(recovered)) return recovered;
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    const text = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const acceptable = (candidate: Metadata) => (!recovered.title || text(candidate.title) === text(recovered.title))
      && (!recovered.artist || /unknown/i.test(recovered.artist) || text(candidate.artist) === text(recovered.artist))
      && (!recovered.album || text(candidate.album || "") === text(recovered.album))
      && (!recovered.duration || Math.abs(candidate.duration - recovered.duration) <= 4);
    // Without a usable identity, a broad search must not guess at an unrelated song.
    if (!recovered.isrc && (!recovered.title || !recovered.artist || /unknown/i.test(recovered.artist))) return null;
    const read = async (endpoint: URL): Promise<any> => {
      const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) throw new Error("Metadata provider unavailable");
      return response.json();
    };
    try {
      const endpoint = new URL("https://api.deezer.com/search");
      endpoint.searchParams.set("q", recovered.isrc ? `isrc:${recovered.isrc}` : `${recovered.artist} ${recovered.title}`);
      endpoint.searchParams.set("limit", "25");
      const result = await read(endpoint);
      for (const item of Array.isArray(result.data) ? result.data : []) {
        const candidate: Metadata = { position: source.position, url: source.url, title: String(item.title || ""),
          artist: String(item.artist?.name || ""), artists: [String(item.artist?.name || "")], duration: Number(item.duration) || 0,
          album: item.album?.title, artworkUrl: item.album?.cover_xl, isrc: item.isrc };
        if (!acceptable(candidate)) continue;
        const full = await read(new URL(`https://api.deezer.com/track/${encodeURIComponent(String(item.id))}`));
        candidate.artists = [candidate.artist, ...(Array.isArray(full.contributors) ? full.contributors.map((artist: any) => String(artist.name || "")) : [])];
        candidate.albumArtist = full.artist?.name; candidate.year = full.release_date; candidate.isrc = full.isrc;
        if (recovered.isrc && candidate.isrc?.toUpperCase() !== recovered.isrc.toUpperCase()) continue;
        const merged = merge(candidate); if (complete(merged)) return merged;
      }
    } catch { /* Try the independent keyless provider below. */ }
    if (recovered.title && recovered.artist && !/unknown/i.test(recovered.artist)) {
      try {
        const endpoint = new URL("https://itunes.apple.com/search");
        endpoint.searchParams.set("term", `${recovered.artist} ${recovered.title}`);
        endpoint.searchParams.set("entity", "song"); endpoint.searchParams.set("limit", "25");
        const result = await read(endpoint);
        for (const item of Array.isArray(result.results) ? result.results : []) {
          const candidate: Metadata = { position: source.position, url: source.url, title: String(item.trackName || ""),
            artist: String(item.artistName || ""), artists: [String(item.artistName || "")],
            duration: (Number(item.trackTimeMillis) || 0) / 1000, album: item.collectionName,
            year: item.releaseDate, artworkUrl: item.artworkUrl100 };
          if (acceptable(candidate)) { const merged = merge(candidate); if (complete(merged)) return merged; }
        }
      } catch { /* Caller records FAILED_METADATA_MISSING with the original position. */ }
    }
    return null;
  }

  async download(request: DownloadRequest, context: DownloadContext): Promise<DownloadResult> {
    const outputDir = context.tmpDir;
    fs.mkdirSync(outputDir, { recursive: true });

    // Handle Manual Audio URL + Spotify Metadata URL pipe syntax (Reverb model: "<audio-url>|<spotify-url>")
    const manualUrl = request.sourceUrl ? normalizeManualUrl(request.sourceUrl.replace(/\|/g, "")) : undefined;
    const spotifyUrl = request.spotifyTrackUrl;

    let target: string | undefined;
    const diagnostics: DownloadDiagnostics = { strategy: "spotify", audioProvider: request.audioProvider, output: "" };
    if (manualUrl && spotifyUrl) {
      target = `${manualUrl}|${spotifyUrl}`;
    } else if (spotifyUrl) {
      target = spotifyUrl;
    } else if (manualUrl) {
      target = manualUrl;
    } else if (request.query) {
      target = request.query;
    } else if (request.requestedTrack) {
      target = [request.requestedTrack.artist, request.requestedTrack.title].filter(Boolean).join(" - ");
    }

    if (!target) {
      return {
        status: "failed",
        files: [],
        error: {
          code: "invalid-input",
          message: "No valid download target or query provided",
        },
      };
    }

    const outputTemplate = request.playlistM3uName
      ? (request.filenameTemplate || path.join(outputDir, SPOTDL_LIBRARY_TEMPLATE))
      : request.filenameTemplate
        ? (path.isAbsolute(request.filenameTemplate) ? request.filenameTemplate : path.join(outputDir, request.filenameTemplate))
        : path.join(outputDir, SPOTDL_LIBRARY_TEMPLATE);

    const args: string[] = [
      "--simple-tui",
      "--audio", ...(request.audioProvider ? [request.audioProvider]
        : request.broadenAudioSearch ? ["soundcloud", "youtube", "youtube-music"] : ["youtube-music", "youtube"]),
      "--id3-separator", "; ",
      "--log-level", "DEBUG",
      "--output", outputTemplate,
      "--format", "mp3",
      "--bitrate", "320k",
      // spotDL's download operation embeds metadata itself. --embed-metadata
      // is a yt-dlp option and makes spotDL reject the entire command.
      "--generate-lrc",
      "--overwrite", "skip",
      // Restore the earlier importer's downloader retries and terminal error summary.
      "--max-retries", "5", "--print-errors",
    ];

    if (request.playlistM3uName) {
      // The caller supplies a fixed basename, never a user-controlled path.
      if (path.basename(request.playlistM3uName) !== request.playlistM3uName ||
          !/^[a-zA-Z0-9_-]+\.m3u8?$/.test(request.playlistM3uName)) {
        return { status: "failed", files: [], error: { code: "invalid-input", message: "Invalid playlist filename" } };
      }
      args.push("--m3u", request.playlistM3uName);
      // Keep a source-order entry for failed tracks so the generated M3U can
      // map every playlist position to its canonical path after the run.
      args.push("--add-unavailable");
      // Unlike the M3U, spotDL's save-file includes failed downloads too.
      args.push("--save-file", "musicdeck-source.spotdl", "--save-errors", "musicdeck-errors.txt");
    }

    if (this.ffmpegPath && this.ffmpegPath !== "ffmpeg") {
      args.push("--ffmpeg", this.ffmpegPath);
    }
    if (this.clientId && this.clientSecret) {
      args.push("--client-id", this.clientId, "--client-secret", this.clientSecret);
    }
    if (this.cookieFile) {
      args.push("--cookie-file", this.cookieFile);
    }

    args.push("download", target);

    let currentStage: DownloadStage = "downloading";
    let lastPercent: number | undefined;

    const onProgressLine = (line: string) => {
      const safeLine = redactSpotDLDiagnostics(line, [this.clientId, this.clientSecret, this.cookieFile]);
      const parsed = parseSpotDLProgress(safeLine);
      if (parsed) {
        if (parsed.stage) currentStage = parsed.stage;
        if (parsed.percent !== undefined) lastPercent = parsed.percent;

        context.onProgress?.({
          jobId: context.jobId,
          bytesDownloaded: parsed.bytesDownloaded,
          totalBytes: parsed.totalBytes,
          percent: parsed.percent ?? lastPercent,
          speedBytesPerSecond: parsed.speedBytesPerSecond,
          stage: currentStage,
          message: safeLine.trim(),
        });
      }
    };

    let handle: ProcessHandle | undefined;
    let liveOutput = "";
    const captureOutput = (chunk: string) => { liveOutput = (liveOutput + chunk).slice(-48_000); };

    try {
      if (request.canonicalMetadata && !manualUrl) {
        const source = request.canonicalMetadata;
        if (!source.title.trim() || !source.artist.trim() || !source.album?.trim() || !/\b\d{4}\b/.test(source.year || "")) {
          return { status: "failed", files: [], error: { code: "invalid-input", message: "Cached track metadata is incomplete" } };
        }
        let metadata = source;
        diagnostics.strategy = "cached-metadata";
        if (request.broadenAudioSearch) {
          const match = await this.deezerImportMatcher.match(source, context.signal);
          diagnostics.metadataLookup = match.detail;
          if (match.track) {
            diagnostics.strategy = "deezer-assisted";
            // Keep Spotify album identity/output paths. Deezer enriches only missing tags.
            metadata = { ...source, isrc: source.isrc || match.track.isrc,
              artworkUrl: source.artworkUrl || match.track.artworkUrl,
              albumArtist: source.albumArtist || match.track.albumArtist };
          }
          const search = match.track || source;
          const searchTitle = search.title.replace(/[{}\r\n]/g, " ").trim();
          diagnostics.searchQuery = `${source.artist} - ${searchTitle}`;
          // This controls the AUDIO-provider query, rather than another Spotify text lookup.
          // spotDL prepends artist/title to literal queries without placeholders.
          args.splice(args.indexOf("download"), 0, "--search-query", `{artist} - ${searchTitle}`);
        }
        const manifest = path.join(outputDir, "musicdeck-track.spotdl");
        fs.writeFileSync(manifest, JSON.stringify([spotDLSong(metadata)]), { mode: 0o600 });
        args[args.length - 1] = manifest;
      }
      handle = this.processRunner.run(this.spotdlPath, args, {
        cwd: outputDir,
        signal: context.signal,
        timeoutMs: request.timeoutMs || this.timeoutMs,
        onStdoutLine: onProgressLine,
        onStderrLine: onProgressLine,
        onStdoutChunk: captureOutput,
        onStderrChunk: captureOutput,
        // Prevent narrow Rich console wrapping from truncating track names in errors.
        env: { COLUMNS: "240", NO_COLOR: "1" },
      });

      this.activeHandles.set(context.jobId, handle);

      const result = await (handle.promise || handle.completion);
      diagnostics.output = redactSpotDLDiagnostics(`${result.stdout}\n${result.stderr}`,
        [this.clientId, this.clientSecret, this.cookieFile]);

      if (context.signal.aborted) {
        return {
          status: "cancelled",
          files: [],
          error: {
            code: "cancelled",
            message: "Download cancelled by user",
          },
        };
      }

      if (result.exitCode !== 0) {
        const fullOutput = `${result.stdout}\n${result.stderr}`;
        const classifiedCode = classifySpotDLError(fullOutput);
        return {
          status: "failed",
          files: [],
          diagnostics,
          error: {
            code: classifiedCode,
            message: `spotDL process exited with code ${result.exitCode}: ${extractSpotDLFailureReason(diagnostics.output) || extractErrorMessage(diagnostics.output)}`,
          },
        };
      }

      // Collect downloaded audio files
      const playlistMetadata = request.playlistM3uName
        ? readPlaylistMetadata(path.join(outputDir, "musicdeck-source.spotdl"))
        : {};
      const files = request.playlistM3uName && request.libraryRoot
        ? readPlaylistFiles(path.join(outputDir, request.playlistM3uName), request.libraryRoot, playlistMetadata.playlistTracks || [])
        : scanAudioFiles(outputDir, request);
      if (files.length === 0) {
        if (playlistMetadata.playlistTracks?.length) {
          return { status: "completed", files, ...playlistMetadata };
        }
        // Exit 0 does not guarantee audio was acquired. Keep the underlying
        // error and diagnostic output so matching and invocation failures are distinguishable.
        const fullOutput = `${result.stdout}\n${result.stderr}`;
        const reason = extractSpotDLFailureReason(diagnostics.output);
        return {
          status: "failed",
          files: [],
          diagnostics,
          error: {
            code: classifySpotDLError(fullOutput),
            message: reason
              ? `spotDL could not obtain audio for this track: ${reason}`
              : "spotDL completed but produced no valid audio files in output directory",
          },
        };
      }

      return {
        status: "completed",
        files,
        diagnostics,
        ...playlistMetadata,
      };
    } catch (err: any) {
      if (context.signal.aborted || /abort/i.test(err?.message || "")) {
        return {
          status: "cancelled",
          files: [],
          error: {
            code: "cancelled",
            message: "Download was aborted",
          },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      diagnostics.output = redactSpotDLDiagnostics(`${liveOutput || diagnostics.output}\n${message}`, [this.clientId, this.clientSecret, this.cookieFile]);
      const isNotFound = /enoent/i.test(message) || /not found/i.test(message);
      return {
        status: "failed",
        files: [],
        diagnostics,
        error: {
          code: isNotFound ? "executable-missing" : "general",
          message: redactSpotDLDiagnostics(message, [this.clientId, this.clientSecret, this.cookieFile]),
        },
      };
    } finally {
      this.activeHandles.delete(context.jobId);
    }
  }

  cancel(jobId: string): void {
    const handle = this.activeHandles.get(jobId);
    if (handle) {
      handle.kill("SIGTERM");
      this.activeHandles.delete(jobId);
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    const diagnostics = await this.detectBinaries();
    if (!diagnostics.spotdlInstalled) {
      return {
        ok: false,
        message: `spotDL is not installed or not accessible at '${this.spotdlPath}'`,
      };
    }
    if (!diagnostics.ffmpegAvailable) {
      return {
        ok: false,
        message: `spotDL found (${diagnostics.spotdlVersion || "unknown version"}), but FFmpeg is missing at '${this.ffmpegPath}'`,
      };
    }
    return {
      ok: true,
      message: `spotDL (${diagnostics.spotdlVersion || "installed"}) and FFmpeg (${diagnostics.ffmpegVersion || "available"}) are ready`,
    };
  }

  /** Alias used by admin diagnostics reporting; delegates to detectBinaries(). */
  async getDiagnostics(): Promise<SpotDLDiagnosticResult> {
    return this.detectBinaries();
  }

  async detectBinaries(): Promise<SpotDLDiagnosticResult> {
    let spotdlInstalled = false;
    let spotdlVersion: string | undefined;
    let ffmpegAvailable = false;
    let ffmpegVersion: string | undefined;

    try {
      const spotdlHandle = this.processRunner.run(this.spotdlPath, ["--version"], { timeoutMs: 5000 });
      const spotdlRes = await spotdlHandle.promise;
      if (spotdlRes.exitCode === 0 && spotdlRes.stdout.trim()) {
        spotdlInstalled = true;
        spotdlVersion = spotdlRes.stdout.trim().split("\n")[0];
      }
    } catch {}

    try {
      const ffmpegHandle = this.processRunner.run(this.ffmpegPath, ["-version"], { timeoutMs: 5000 });
      const ffmpegRes = await ffmpegHandle.promise;
      if (ffmpegRes.exitCode === 0 && ffmpegRes.stdout.trim()) {
        ffmpegAvailable = true;
        const firstLine = ffmpegRes.stdout.trim().split("\n")[0];
        const match = firstLine.match(/ffmpeg version ([^\s]+)/i);
        ffmpegVersion = match ? match[1] : firstLine;
      }
    } catch {}

    return {
      spotdlInstalled,
      spotdlVersion,
      ffmpegAvailable,
      ffmpegVersion,
      spotdlPath: this.spotdlPath,
      ffmpegPath: this.ffmpegPath,
    };
  }
}

/** Complete values prevent spotDL reinitializing the song through Spotify text search. */
function spotDLSong(source: SpotifyImportTrackMetadata): Record<string, unknown> {
  const artists = [...new Set([source.artist, ...(source.artists || [])].map((name) => name.trim()).filter(Boolean))];
  const year = Number(/\b\d{4}\b/.exec(source.year || "")?.[0]);
  return {
    name: source.title, artist: source.artist, artists, genres: source.genres || [],
    album_name: source.album, album_artist: source.albumArtist || source.artist,
    // Empty album_id is intentional: null triggers another Spotify lookup.
    album_id: source.albumId || "", duration: source.duration, year,
    date: source.releaseDate || String(year), track_number: source.trackNumber || 0,
    tracks_count: source.tracksCount || 0, disc_number: source.discNumber || 1, disc_count: source.discCount || 1,
    song_id: /\/track\/([a-zA-Z0-9]+)/.exec(source.url)?.[1] || "",
    url: source.url, explicit: source.explicit || false, publisher: source.publisher || "",
    // spotDL's MP3 writer passes ISRC directly to Mutagen; None raises an ID3 error.
    isrc: source.isrc || "", cover_url: source.artworkUrl || null, copyright_text: null,
    download_url: null,
  };
}

export function redactSpotDLDiagnostics(output: string, secrets: Array<string | undefined> = []): string {
  let clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, "[REDACTED]");
  clean = clean.replace(/(["']?\b(?:client_secret|client_id|\w{0,40}token|\w{0,40}api_key|password|cookie_file|cookiefile)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, "$1'[REDACTED]'")
    .replace(/(\b(?:client_secret|\w{0,40}token|\w{0,40}api_key|password)\s*=\s*)(?!["'])[\w+/=.-]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9+/=_-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|access_token|key|signature|sig)=)[^\s&"']+/gi, "$1[REDACTED]");
  // Rich repeats entire Python source frames. Remove those before bounding output
  // so the actual exception in the middle of a long traceback is retained.
  clean = compactSpotDLOutput(clean);
  const max = 24_000;
  return clean.length > max ? `${clean.slice(0, 8_000)}\n[output truncated]\n${clean.slice(-16_000)}` : clean;
}

function readPlaylistFiles(
  manifestPath: string,
  libraryRoot: string,
  tracks: NonNullable<DownloadResult["playlistTracks"]>
): AcquiredFile[] {
  try {
    const lexicalRoot = path.resolve(libraryRoot);
    const root = fs.realpathSync(lexicalRoot);
    const paths = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (paths.length !== tracks.length) return [];
    return paths.flatMap((entry, index) => {
      const filePath = path.resolve(path.dirname(manifestPath), entry);
      const relative = path.relative(lexicalRoot, filePath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
      if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return [];
      try {
        const realFile = fs.realpathSync(filePath);
        const realRelative = path.relative(root, realFile);
        if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return [];
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return [];
        const track = tracks[index];
        return [{ path: filePath, name: path.basename(filePath), title: track.title, artist: track.artist,
          album: path.basename(path.dirname(filePath)), size: stat.size, playlistPosition: track.position }];
      } catch { return []; }
    });
  } catch { return []; }
}

function readPlaylistMetadata(filePath: string): Pick<DownloadResult, "playlistTracks" | "playlistLength"> {
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(payload)) return {};
    const tracks = payload.map((item: unknown, index) => {
      const song = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const position = typeof song.list_position === "number" ? song.list_position : index + 1;
      const nestedAlbum = song.album && typeof song.album === "object" ? song.album as Record<string, unknown> : {};
      const artistNames = Array.isArray(song.artists)
        ? song.artists.map((artist) => typeof artist === "string" ? artist
          : artist && typeof artist === "object" && typeof (artist as Record<string, unknown>).name === "string"
            ? (artist as Record<string, unknown>).name as string : "").filter(Boolean)
        : [];
      const primary = typeof song.artist === "string" ? song.artist.trim() : "";
      const names = new Map<string, string>();
      for (const name of [primary, ...artistNames]) {
        const key = name.trim().normalize("NFKC").toLowerCase();
        if (key && !names.has(key) && !/unknown/i.test(key)) names.set(key, name.trim());
      }
      const artists = [...names.values()];
      const artist = primary && !/unknown/i.test(primary) ? primary : artists[0] || "";
      const date = [song.year, song.release_date, song.date, nestedAlbum.release_date, nestedAlbum.date]
        .find((value): value is string | number => typeof value === "string" || typeof value === "number");
      const image = Array.isArray(nestedAlbum.images) ? nestedAlbum.images.find((image: unknown) => image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") as { url: string } | undefined : undefined;
      const albumArtists = Array.isArray(nestedAlbum.artists) ? nestedAlbum.artists : [];
      const albumArtist = typeof song.album_artist === "string" ? song.album_artist
        : albumArtists[0] && typeof albumArtists[0] === "object" && typeof albumArtists[0].name === "string" ? albumArtists[0].name : undefined;
      const artwork = [largestSpotifyArtwork(nestedAlbum.images), song.cover_url, song.album_cover_url, nestedAlbum.cover_url, nestedAlbum.image_url, image?.url]
        .find((value): value is string => typeof value === "string" && /^https:\/\//.test(value));
      return {
        position: Number.isSafeInteger(position) && position > 0 ? position : index + 1,
        url: typeof song.url === "string" ? song.url : "",
        title: typeof song.name === "string" ? song.name : "",
        artist,
        artists,
        duration: typeof song.duration === "number" ? song.duration : 0,
        ...(typeof song.album_name === "string" ? { album: song.album_name }
          : typeof song.album === "string" ? { album: song.album }
            : typeof nestedAlbum.name === "string" ? { album: nestedAlbum.name } : {}),
        ...(albumArtist ? { albumArtist } : {}),
        ...(date !== undefined ? { year: String(date) } : {}),
        ...(artwork ? { artworkUrl: artwork } : {}),
        ...(typeof song.album_id === "string" ? { albumId: song.album_id }
          : typeof nestedAlbum.id === "string" ? { albumId: nestedAlbum.id } : {}),
        ...(typeof song.track_number === "number" ? { trackNumber: song.track_number } : {}),
        ...(typeof song.tracks_count === "number" ? { tracksCount: song.tracks_count } : {}),
        ...(typeof song.disc_number === "number" ? { discNumber: song.disc_number } : {}),
        ...(typeof song.disc_count === "number" ? { discCount: song.disc_count } : {}),
        ...(Array.isArray(song.genres) ? { genres: song.genres.filter((genre): genre is string => typeof genre === "string") } : {}),
        ...(typeof song.explicit === "boolean" ? { explicit: song.explicit } : {}),
        ...(typeof song.publisher === "string" ? { publisher: song.publisher } : {}),
        ...(typeof song.date === "string" ? { releaseDate: song.date } : {}),
        ...(typeof song.isrc === "string" && song.isrc ? { isrc: song.isrc }
          : song.external_ids && typeof song.external_ids === "object" && typeof (song.external_ids as Record<string, unknown>).isrc === "string"
            ? { isrc: (song.external_ids as Record<string, unknown>).isrc as string } : {}),
      };
    });
    const declared = payload.reduce<number>((max, item: unknown) => {
      if (!item || typeof item !== "object") return max;
      const length = (item as Record<string, unknown>).list_length;
      return typeof length === "number" && Number.isSafeInteger(length) ? Math.max(max, length) : max;
    }, tracks.length);
    return { playlistTracks: tracks, playlistLength: declared };
  } catch {
    return {};
  }
}

/**
 * Parses live stdout / stderr progress output from spotDL.
 */
export function parseSpotDLProgress(line: string): Partial<DownloadProgress> | null {
  const result: Partial<DownloadProgress> = {};
  const trimmed = line.trim();

  // Stage identification
  if (/converting/i.test(trimmed)) {
    result.stage = "converting";
  } else if (/\bskipping\s+.*\(file already exists\)/i.test(trimmed)) {
    result.stage = "processing";
  } else if (/metadata|tagging|applying tags/i.test(trimmed)) {
    result.stage = "tagging";
  } else if (/downloading/i.test(trimmed)) {
    result.stage = "downloading";
  } else if (/processing/i.test(trimmed)) {
    result.stage = "processing";
  }

  // 1. Progress percentage: e.g. "45%" or "45.2%"
  const percentMatch = trimmed.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    const p = parseFloat(percentMatch[1]);
    if (!isNaN(p) && p >= 0 && p <= 100) {
      result.percent = Math.round(p);
    }
  }

  // 2. Download speed: e.g. "2.8MB/s", "500KB/s", "1.2 MiB/s"
  const speedMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])\/s/i);
  if (speedMatch) {
    const val = parseFloat(speedMatch[1]);
    const unit = speedMatch[2].toUpperCase();
    if (!isNaN(val)) {
      if (unit.startsWith("K")) result.speedBytesPerSecond = Math.round(val * 1024);
      else if (unit.startsWith("M")) result.speedBytesPerSecond = Math.round(val * 1024 * 1024);
      else if (unit.startsWith("G")) result.speedBytesPerSecond = Math.round(val * 1024 * 1024 * 1024);
      else result.speedBytesPerSecond = Math.round(val);
    }
  }

  // 3. Bytes downloaded / total bytes: e.g. "4.5M/10.0M" or "4500K/10000K"
  const bytesMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])\s*\/\s*(\d+(?:\.\d+)?)\s*([kKmMgGtT]i?[bB])/i);
  if (bytesMatch) {
    const parseSize = (valStr: string, unitStr: string) => {
      const v = parseFloat(valStr);
      const u = unitStr.toUpperCase();
      if (isNaN(v)) return undefined;
      if (u.startsWith("K")) return Math.round(v * 1024);
      if (u.startsWith("M")) return Math.round(v * 1024 * 1024);
      if (u.startsWith("G")) return Math.round(v * 1024 * 1024 * 1024);
      return Math.round(v);
    };

    result.bytesDownloaded = parseSize(bytesMatch[1], bytesMatch[2]);
    result.totalBytes = parseSize(bytesMatch[3], bytesMatch[4]);
  }

  // 4. "Downloaded <song>" string indicates 100%
  if (/^downloaded\s+/i.test(trimmed)) {
    result.percent = 100;
    result.stage = "processing";
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function classifySpotDLError(output: string): DownloadErrorCode {
  // Optional lyric-provider failures must not decide whether AUDIO is retried.
  const lower = spotDLAudioErrors(output).toLowerCase();

  if (lower.includes("cancel") || lower.includes("aborted")) {
    return "cancelled";
  }
  if (/rate[ -]?limit|too many requests|\b(?:http(?: error)?|status|code)\s*:?\s*429\b/.test(lower)) {
    return "rate-limited";
  }
  if (/sign in to confirm|login_required|not a bot|captcha/.test(lower)) {
    return "authentication-failed";
  }
  if (lower.includes("not found") || lower.includes("no results") || lower.includes("could not find") || lower.includes("lookuperror")) {
    return "not-found";
  }
  if (lower.includes("video unavailable") || lower.includes("this video is not available") || lower.includes("private video") || lower.includes("not available in your country")) {
    return "retryable";
  }
  // A matched video/CDN 403 or yt-dlp acquisition failure can recover through another source.
  if (/unable to download video data|yt-dlp download error|http(?: error)?\s*:?\s*403/.test(lower)) {
    return "retryable";
  }
  if (lower.includes("invalid_client") || lower.includes("spotifyexception") || lower.includes("authentication") || lower.includes("403 forbidden")) {
    return "authentication-failed";
  }
  if (lower.includes("invalid") || lower.includes("usage:") || lower.includes("unrecognized argument") || lower.includes("queryerror")) {
    return "invalid-input";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("connection reset")) {
    return "retryable";
  }

  return "general";
}

function compactSpotDLOutput(output: string): string {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)
    .filter((line) => !/^\s*[|│+╭╰┌└]/.test(line)).join("\n");
}

function spotDLAudioErrors(output: string): string {
  const lines = compactSpotDLOutput(output)
    .replace(/\s+[a-zA-Z_]+\.py:\d+\s*$/gm, "")
    .replace(/\r?\n[ \t]{10,}(?!\[\d{2}:\d{2}:\d{2}\])(?=\S)/g, " ")
    .split("\n").map((line) => line.trim())
    .filter((line) => line && !/\b(?:genius|azlyrics|musixmatch|synced)\s*(?::|failed to find lyrics)|\b(?:no lyrics found|could not search for lyrics|lyrics[_ -]?providers?|search[_ -]?lyrics)\b/i.test(line)
      && !/^(?:raise\s|["'](?:audio_providers|restrict|id3_separator|max_filename_length))/.test(line));
  const errors = lines.filter((line) => /\b(?:\w*Error|\w*Exception):|\bERROR:|spotdl:\s*error:|sign in to confirm|login_required|not a bot|captcha/i.test(line));
  return (errors.length ? errors : lines).join("\n");
}

/**
 * spotDL can exit with code 0 even when it failed to actually acquire audio
 * for a specific track — e.g. its matched YouTube video was removed,
 * region-locked, private, or otherwise unavailable. Pull the most useful,
 * human-readable reason out of spotDL's own debug/error output so failures
 * are diagnosable per-track instead of showing a generic message.
 */
function extractSpotDLFailureReason(output: string): string | undefined {
  output = spotDLAudioErrors(output);
  const patterns: RegExp[] = [
    /ERROR:\s*(?:\[[^\]]+\]\s*[^:]+:\s*)?(.+)/i,
    /AudioProviderError:\s*(.+)/i,
    /LookupError:\s*(.+)/i,
    /(no results found.*)/i,
    /(no usable results.*)/i,
    /(video is not available)/i,
    /(private video)/i,
    /(video unavailable)/i,
    /(not available in your country)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1].trim().replace(/\s+/g, " ").slice(0, 300);
    }
  }
  return undefined;
}

function extractErrorMessage(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("Downloading") && !l.startsWith("Processing"));

  const errorLine = lines.find((l) => /error|exception|failed|fatal/i.test(l));
  return errorLine || lines.slice(-2).join(" ") || "Unknown error";
}

function scanAudioFiles(dir: string, request: DownloadRequest): AcquiredFile[] {
  const files: AcquiredFile[] = [];

  const walk = (currentDir: string) => {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            const rawName = path.basename(entry.name, ext);
            // Canonical spotDL basename: "{artist} - {title}"
            let artist = request.requestedTrack?.artist || request.candidate?.artist;
            let title = request.requestedTrack?.title || request.candidate?.title || rawName;
            let album = request.requestedTrack?.album || request.candidate?.album;

            if (rawName.includes(" - ")) {
              const parts = rawName.split(" - ");
              if (parts.length >= 2) {
                if (!artist) artist = parts[0].trim();
                if (!title || title === rawName) title = parts.slice(1).join(" - ").trim();
              }
            }

            files.push({
              path: fullPath,
              name: entry.name,
              title,
              artist,
              album,
              size: stat.size,
            });
          }
        }
      }
    }
  };

  walk(dir);
  return files;
}
