import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MusicBackend } from "../backends/music-backend.js";
import type { SessionUser, Track } from "../types.js";
import { createId } from "../utils/ids.js";
import type { DownloadResult, DownloaderAdapter, DownloadDiagnostics, DownloadErrorCode, DownloadRequest } from "./downloader-adapter.js";
import { SPOTDL_LIBRARY_TEMPLATE } from "./spotdl-downloader-adapter.js";
import type { AcquiredFile } from "./acquisition.js";
import type { PlaylistService } from "./playlist-service.js";
import { AudioTaggerService, type CanonicalAudioMetadata } from "../services/media/audioTaggerService.js";
import { safeMusicPath, flushFile, flushDirectory } from "../services/media/safeMusicPath.js";
import { cleanupTemporaryDirectory } from "../services/media/temporaryDirectory.js";
import type { SqliteImportJobRepository, StoredImportJob } from "../infrastructure/persistence/sqliteImportJobRepository.js";

export type ImportEntryStatus = "PENDING" | "DOWNLOADED" | "READY" | "COMPLETED"
  | "FAILED_METADATA_MISSING" | "FAILED_DOWNLOAD" | "FAILED_TAGGING" | "FAILED_INDEXING" | "FAILED_LINKING";
export type ImportEntry = {
  position: number; source: SpotifyTrackMetadata; status: ImportEntryStatus;
  error?: string; filePath?: string; providerTrackId?: string; duplicateOf?: number; requiresScan?: boolean;
  cleanupWarnings?: string[];
  downloadAttempts?: Array<{ status: DownloadResult["status"]; error?: string; errorCode?: DownloadErrorCode; diagnostics?: DownloadDiagnostics }>;
};
export type SpotifyImportJob = {
  id: string;
  userId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  stage: "queued" | "fetching" | "downloading" | "scanning" | "completed";
  playlistId?: string;
  playlistName?: string;
  playlistDescription?: string;
  playlistArtworkUrl?: string | null;
  expectedCount?: number;
  downloadedCount?: number;
  currentTrack?: number;
  currentTrackName?: string;
  importedCount?: number;
  error?: string;
  completedCount?: number;
  failedCount?: number;
  manifest?: ImportEntry[];
  cleanupWarnings?: string[];
};

type SpotifyTrackMetadata = NonNullable<DownloadResult["playlistTracks"]>[number];

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
    private readonly importSubdir = "Spotify Imports",
    private readonly audioTagger?: AudioTaggerService,
    private readonly repository?: SqliteImportJobRepository
  ) {}
  private readonly records = new Map<string, StoredImportJob>();
  private checkpoint(job: SpotifyImportJob): void {
    if (job.manifest) {
      job.completedCount = job.manifest.filter((entry) => entry.status === "COMPLETED").length;
      job.importedCount = new Set(job.manifest.filter((entry) => entry.status === "COMPLETED").map((entry) => entry.providerTrackId)).size;
      job.failedCount = job.manifest.filter((entry) => entry.status.startsWith("FAILED_")).length;
      job.downloadedCount = job.manifest.filter((entry) => ["DOWNLOADED", "READY", "COMPLETED", "FAILED_LINKING"].includes(entry.status)).length;
    }
    const record = this.records.get(job.id);
    if (record) this.repository?.save(record);
  }
  private enqueue(record: StoredImportJob): void {
    const { job, user } = record;
    this.records.set(job.id, record); this.jobs.set(job.id, job);
    this.tail = this.tail.then(async () => {
      try {
        if (user.disabled) throw new Error("Import owner is disabled");
        const spotify = parseSpotifyPlaylistUrl(record.playlistUrl);
        if (!spotify) throw new Error("Stored playlist URL is invalid");
        job.status = "running"; job.stage = "fetching"; this.checkpoint(job);
        await this.run(job, spotify, user);
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "Spotify playlist import failed";
        for (const entry of job.manifest || []) if (!entry.status.startsWith("FAILED_") && entry.status !== "COMPLETED") {
          entry.status = "FAILED_DOWNLOAD"; entry.error = job.error;
        }
      } finally {
        try { this.checkpoint(job); }
        catch (error) {
          job.status = "failed";
          job.error = `Could not persist import checkpoint: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.records.delete(job.id);
        if (this.jobs.size > 100) {
          for (const [id, previous] of this.jobs) {
            if (this.jobs.size <= 100) break;
            if (!["queued", "running"].includes(previous.status)) this.jobs.delete(id);
          }
        }
      }
    });
  }
  /** Resume from durable per-track checkpoints; completed jobs remain queryable in SQLite. */
  resumeInterrupted(resolveUser?: (id: string) => SessionUser | null): void {
    for (const record of this.repository?.unfinished() || []) {
      if (resolveUser) record.user = resolveUser(record.job.userId) || { ...record.user, disabled: true };
      if (!this.jobs.has(record.job.id)) this.enqueue(record);
    }
  }

  private canonical(source: SpotifyTrackMetadata, file?: AcquiredFile): CanonicalAudioMetadata {
    const artists = [...new Set([source.artist, ...(source.artists || [])]
      .flatMap((value) => value.split(/\s*;\s*|\s+\/\s+/)).map((value) => value.trim()).filter(Boolean))];
    return { title: source.title, artists, album: source.album || file?.album || "",
      albumArtist: source.albumArtist && !/unknown/i.test(source.albumArtist) ? source.albumArtist : artists[0], year: source.year,
      isrc: source.isrc, artworkUrl: source.artworkUrl };
  }
  private async cleanup(directory: string, owner: { cleanupWarnings?: string[] }): Promise<void> {
    const warning = await cleanupTemporaryDirectory(directory);
    if (warning) owner.cleanupWarnings = [...(owner.cleanupWarnings || []), warning];
  }
  private async tagAndPublish(file: AcquiredFile, source: SpotifyTrackMetadata, stagingDir: string, root: string, entry: ImportEntry): Promise<AcquiredFile> {
    if (!this.audioTagger) { safeMusicPath(root, file.path); return file; }
    safeMusicPath(stagingDir, file.path);
    const destination = safeMusicPath(root, path.resolve(root, path.relative(stagingDir, file.path)), true);
    const metadata = this.canonical(source, file);
    // Existing audio is authoritative. Repair it in place without replacing its audio or rich tags.
    if (fs.existsSync(destination)) {
      if (!fs.statSync(destination).isFile() || !fs.statSync(destination).size) throw new Error("Destination is not valid audio");
      await this.audioTagger.verifyAndTag(destination, metadata, root);
    } else {
      await this.audioTagger.verifyAndTag(file.path, metadata, stagingDir);
      const pendingDir = fs.mkdtempSync(path.join(path.dirname(destination), ".musicdeck-publish-"));
      // A scanner must not index this extra hard link if Windows delays cleanup.
      const pending = path.join(pendingDir, `${path.basename(destination)}.partial`);
      try {
        fs.copyFileSync(file.path, pending, fs.constants.COPYFILE_EXCL); flushFile(pending);
        safeMusicPath(root, destination);
        // Atomic no-clobber publication: an overlapping download cannot replace existing audio.
        try { fs.linkSync(pending, destination); flushDirectory(path.dirname(destination)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          safeMusicPath(root, destination);
          await this.audioTagger.verifyAndTag(destination, metadata, root);
        }
      } finally { await this.cleanup(pendingDir, entry); }
    }
    return { ...file, path: destination, name: path.basename(destination), size: fs.statSync(destination).size };
  }
  start(playlistUrl: string, user: SessionUser): SpotifyImportJob {
    const spotify = parseSpotifyPlaylistUrl(playlistUrl);
    if (!spotify) throw new Error("Please enter a valid open.spotify.com/playlist URL");
    if ([...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length >= 5)
      throw new Error("The import queue is full. Please try again shortly.");
    const job: SpotifyImportJob = { id: createId("spimp"), userId: user.id, status: "queued", stage: "queued" };
    const record = { job, playlistUrl: spotify.url, user };
    this.repository?.save(record); this.enqueue(record);
    return structuredClone(job);
  }
  get(jobId: string, userId: string): SpotifyImportJob | null {
    const job = this.jobs.get(jobId) || this.repository?.get(jobId, userId)?.job;
    return job?.userId === userId ? structuredClone(job) : null;
  }

  private async spotifyDetails(playlistUrl: string): Promise<{ title: string | null; artworkUrl: string | null }> {
    try {
      const endpoint = new URL("https://open.spotify.com/oembed");
      endpoint.searchParams.set("url", playlistUrl);
      const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return { title: null, artworkUrl: null };
      const data = await response.json() as { title?: unknown; thumbnail_url?: unknown };
      const artwork = typeof data.thumbnail_url === "string" ? data.thumbnail_url : "";
      let artworkUrl: string | null = null;
      try {
        const parsed = new URL(artwork);
        if (parsed.protocol === "https:" && parsed.hostname === "i.scdn.co" && !parsed.username && !parsed.password) {
          artworkUrl = parsed.toString();
        }
      } catch { /* Spotify may omit the thumbnail. */ }
      return {
        title: typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 200) : null,
        artworkUrl,
      };
    } catch {
      return { title: null, artworkUrl: null };
    }
  }

  private async importArtwork(playlistId: string, artworkUrl: string | null): Promise<void> {
    if (!artworkUrl) return;
    try {
      const source = new URL(artworkUrl);
      if (source.protocol !== "https:" || source.hostname !== "i.scdn.co" || source.username || source.password) return;
      const response = await this.fetchImpl(artworkUrl, { signal: AbortSignal.timeout(4000), redirect: "error" });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !type || !["image/jpeg", "image/png", "image/webp"].includes(type)) return;
      const maxBytes = 5 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > maxBytes || !response.body) return;
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel(); return; }
        chunks.push(Buffer.from(value));
      }
      if (total > 0) this.playlists.setCustomArtwork(playlistId, Buffer.concat(chunks), type);
    } catch { /* Artwork is optional if Spotify's thumbnail is unavailable. */ }
  }

  private async findLibraryTrack(source: SpotifyTrackMetadata): Promise<Track | null> {
    if (!source.title.trim()) return null;
    const seen = new Set<string>();
    const artists = this.canonical(source).artists.map(normalizeSongText);
    const isrc = source.isrc?.trim().toUpperCase();
    for (let offset = 0; ; offset += 50) {
      const candidates = (await this.backend.search(source.title.trim(), ["tracks"], { offset, limit: 50 })).tracks;
      let newItems = 0;
      for (const track of candidates) {
        if (seen.has(String(track.id))) continue;
        seen.add(String(track.id)); newItems++;
        const trackIsrc = track.identityHints?.isrc?.trim().toUpperCase();
        const artistMatch = track.artistName.split(/\s*;\s*|\s+\/\s+/).some((artist) => artists.includes(normalizeSongText(artist)));
        const albumMatch = !source.album || normalizeSongText(track.albumName || "") === normalizeSongText(source.album);
        const durationMatch = !source.duration || (typeof track.durationSeconds === "number" && Math.abs(track.durationSeconds - source.duration) <= 4);
        if (normalizeSongText(track.title) === normalizeSongText(source.title) && artistMatch && albumMatch && durationMatch
          && (!isrc || !trackIsrc || isrc === trackIsrc)) return track;
      }
      if (candidates.length < 50 || !newItems) return null;
    }
  }
  private fail(entry: ImportEntry, status: ImportEntryStatus, error: unknown): void {
    entry.status = status; entry.error = error instanceof Error ? error.message : String(error);
  }
  private existingOutput(source: SpotifyTrackMetadata, root: string): string | null {
    if (!source.album) return null;
    // spotDL/utils/formatter.py uses comma-separated artists and sanitizes each placeholder.
    // Check both the current shared template and the earlier primary-artist layout.
    const sanitize = (value: string) => value.replace(/[/?\\*|<>]/g, "").replace(/\s{2,}/g, " ").replaceAll('"', "'").replaceAll(":", "-");
    const artists = [...new Set([this.canonical(source).artists.join(", "), source.artist])];
    for (const value of artists) {
      const artist = sanitize(value); const album = sanitize(source.album); const title = sanitize(source.title);
      if (!artist || !album || !title || `${artist} - ${title}.mp3`.length >= 255) continue;
      for (const extension of ["mp3", "flac", "m4a"]) {
        const destination = safeMusicPath(root, path.join(root, artist, album, `${artist} - ${title}.${extension}`));
        if (fs.existsSync(destination) && fs.statSync(destination).isFile() && fs.statSync(destination).size) return destination;
      }
    }
    return null;
  }
  private async runMatched(job: SpotifyImportJob, spotify: { id: string; url: string }, user: SessionUser): Promise<void> {
    const root = path.resolve(this.musicRoot);
    // Source manifests are private, outside the watched music library.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-playlist-"));
    try {
      if (!job.manifest) {
        const detailsPromise = this.spotifyDetails(spotify.url);
        const providerPromise = this.downloader.fetchPlaylistDetails?.(spotify.id);
        const result = await this.downloader.fetchPlaylistTracks!(spotify.url, {
          jobId: job.id + "-metadata", tmpDir: work, signal: new AbortController().signal,
        });
        if (result.status !== "completed" || !result.playlistTracks?.length) throw new Error(result.error?.message || "Could not read Spotify playlist tracks");
        const total = Math.max(result.playlistLength || 0, result.playlistTracks.length,
          ...result.playlistTracks.map((source) => Number.isSafeInteger(source.position) ? source.position : 0));
        if (total > 50_000) throw new Error("Playlist metadata exceeds the supported track count");
        const positions = new Map<number, SpotifyTrackMetadata>();
        for (const source of result.playlistTracks) {
          let position = source.position;
          if (!Number.isSafeInteger(position) || position < 1 || positions.has(position)) {
            position = 1; while (positions.has(position)) position++;
          }
          positions.set(position, source);
        }
        job.expectedCount = total;
        job.manifest = Array.from({ length: total }, (_, index) => ({
          position: index + 1, status: "PENDING", source: positions.get(index + 1)
            || { position: index + 1, url: "", title: "", artist: "", duration: 0 },
        }));
        this.checkpoint(job);
        const [details, provider] = await Promise.all([detailsPromise, providerPromise]);
        job.playlistName = provider?.title || details.title || `Spotify Playlist ${spotify.id.slice(0, 8)}`;
        job.playlistDescription = provider?.description?.trim() || `Imported from Spotify: ${spotify.url}`;
        job.playlistArtworkUrl = provider?.artworkUrl || details.artworkUrl;
        this.checkpoint(job);
      }
      // A crash after source checkpoint but before playlist creation reuses the deterministic identity.
      if (!job.playlistId) {
        if (!job.playlistName) {
          const [details, provider] = await Promise.all([this.spotifyDetails(spotify.url), this.downloader.fetchPlaylistDetails?.(spotify.id)]);
          job.playlistName = provider?.title || details.title || `Spotify Playlist ${spotify.id.slice(0, 8)}`;
          job.playlistDescription = provider?.description?.trim() || `Imported from Spotify: ${spotify.url}`;
          job.playlistArtworkUrl = provider?.artworkUrl || details.artworkUrl;
          this.checkpoint(job);
        }
        const playlist = this.repository
          ? await this.playlists.create(job.playlistName, user, job.playlistDescription, "mdpl_" + job.id)
          : await this.playlists.create(job.playlistName, user, job.playlistDescription);
        job.playlistId = playlist.id; job.playlistName = playlist.name; this.checkpoint(job);
      }
      await this.importArtwork(job.playlistId, job.playlistArtworkUrl || null);
      const entries = job.manifest!;
      const ready = new Map<string, ImportEntry>();
      let needsScan = entries.some((entry) => entry.status === "DOWNLOADED" || entry.requiresScan);
      for (const entry of entries) {
        if (entry.status === "COMPLETED" || entry.status === "READY") {
          ready.set(sourceKey(entry.source), entry); continue;
        }
        if (entry.status.startsWith("FAILED_")) continue;
        job.currentTrack = entry.position;
        job.currentTrackName = `${entry.source.artist} - ${entry.source.title}`;
        if (entry.status === "DOWNLOADED") { ready.set(sourceKey(entry.source), entry); this.checkpoint(job); continue; }
        let source = entry.source;
        if (!usableMetadata(source, Boolean(this.audioTagger))) {
          try {
            const recovered = await this.downloader.resolveTrackMetadata?.(source, {
              jobId: job.id + "-metadata-" + entry.position, tmpDir: work, signal: new AbortController().signal,
            });
            if (recovered) source = entry.source = { ...recovered, position: entry.position };
          } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
          if (!usableMetadata(source, Boolean(this.audioTagger))) {
            this.fail(entry, "FAILED_METADATA_MISSING", entry.error || "Could not resolve canonical Spotify track metadata");
            this.checkpoint(job); continue;
          }
          this.checkpoint(job);
        }
        const duplicate = ready.get(sourceKey(source));
        if (duplicate) {
          entry.providerTrackId = duplicate.providerTrackId; entry.filePath = duplicate.filePath;
          entry.duplicateOf = duplicate.position; entry.status = duplicate.status === "DOWNLOADED" ? "DOWNLOADED" : "READY";
          this.checkpoint(job); continue;
        }
        let track: Track | null = null;
        try { track = await this.findLibraryTrack(source); }
        catch (error) {
          // A failed library lookup is not evidence that a song is absent. Avoid a duplicate download.
          this.fail(entry, "FAILED_INDEXING", error); this.checkpoint(job); continue;
        }
        if (track) {
          try {
            const existing = await this.backend.getTrackFilePath?.(String(track.id));
            if (this.audioTagger && existing) {
              const repair = await this.audioTagger.verifyAndTag(safeMusicPath(root, path.resolve(root, existing)), this.canonical(source), root);
              if (repair?.repaired) { needsScan = true; entry.requiresScan = true; }
            }
            entry.providerTrackId = String(track.id); entry.status = "READY";
            ready.set(sourceKey(source), entry);
          } catch (error) { this.fail(entry, "FAILED_TAGGING", error); }
          this.checkpoint(job); continue;
        }
        if (!this.backend.scanLibrary) { this.fail(entry, "FAILED_INDEXING", "Library scanning is unavailable"); this.checkpoint(job); continue; }
        if (!/^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+$/.test(source.url)) {
          this.fail(entry, "FAILED_METADATA_MISSING", "Invalid Spotify track URL"); this.checkpoint(job); continue;
        }
        let staging = fs.mkdtempSync(path.join(work, "track-"));
        job.stage = "downloading"; this.checkpoint(job);
        try {
          // A checkpoint made before publication lets restarts reuse the finished file.
          if (!entry.filePath && this.audioTagger) {
            entry.filePath = this.existingOutput(source, root) || undefined;
            this.checkpoint(job);
          }
          if (entry.filePath && fs.existsSync(safeMusicPath(root, entry.filePath))) {
            await this.audioTagger?.verifyAndTag(entry.filePath, this.canonical(source), root);
          } else {
            const download = (broadenAudioSearch = false, audioProvider?: DownloadRequest["audioProvider"]) => this.downloader.download({
              spotifyTrackUrl: source.url, outputDirectory: staging,
              canonicalMetadata: source,
              libraryRoot: this.audioTagger ? staging : root,
              filenameTemplate: path.join(this.audioTagger ? staging : root, SPOTDL_LIBRARY_TEMPLATE),
              timeoutMs: broadenAudioSearch ? 120_000 : 300_000,
              broadenAudioSearch,
              audioProvider,
            }, { jobId: job.id + "-track-" + entry.position, tmpDir: staging,
              signal: new AbortController().signal,
              onProgress: (progress) => { if (progress.message) job.currentTrackName = progress.message; },
            });
            let result = await download();
            const recordAttempt = (result: DownloadResult) => {
              entry.downloadAttempts = [...(entry.downloadAttempts || []).slice(-3), {
                status: result.status, error: result.error?.message, errorCode: result.error?.code, diagnostics: result.diagnostics,
              }];
              this.checkpoint(job);
            };
            recordAttempt(result);
            const canRecover = (result: DownloadResult) => result.status === "failed"
              && ["not-found", "retryable", "general"].includes(result.error?.code || "general");
            // spotDL falls through providers when SEARCH finds no match, but stops
            // after a selected URL fails to DOWNLOAD. Isolate each recovery source.
            for (const provider of ["soundcloud", "youtube", "youtube-music"] as const) {
              if (!canRecover(result)) break;
              // A fresh staging directory prevents a partial first attempt being skipped as existing audio.
              await this.cleanup(staging, entry);
              staging = fs.mkdtempSync(path.join(work, "track-retry-"));
              job.currentTrackName = `Retrying via ${provider}: ${source.artist} - ${source.title}`; this.checkpoint(job);
              result = await download(true, provider);
              recordAttempt(result);
            }
            if (result.status !== "completed" || !result.files.length) {
              this.fail(entry, "FAILED_DOWNLOAD", result.error?.message || "Audio was unavailable"); this.checkpoint(job); continue;
            }
            const file = result.files[0];
            entry.filePath = this.audioTagger ? path.resolve(root, path.relative(staging, file.path)) : file.path;
            this.checkpoint(job);
            try { await this.tagAndPublish(file, source, staging, root, entry); }
            catch (error) { this.fail(entry, "FAILED_TAGGING", error); this.checkpoint(job); continue; }
          }
          entry.status = "DOWNLOADED"; needsScan = true; ready.set(sourceKey(source), entry); this.checkpoint(job);
        } catch (error) { this.fail(entry, "FAILED_DOWNLOAD", error); this.checkpoint(job); }
        finally { await this.cleanup(staging, entry); this.checkpoint(job); }
      }
      // Download all tracks before indexing; one stalled scan cannot stop the next download.
      if (needsScan) {
        job.stage = "scanning"; this.checkpoint(job);
        const pending = entries.filter((entry) => entry.status === "DOWNLOADED");
        try {
          await this.backend.scanLibrary!();
          for (const entry of entries) entry.requiresScan = false;
          this.checkpoint(job);
          const unresolved = new Set(pending);
          const deadline = Date.now() + 120_000;
          do {
            for (const entry of unresolved) {
              try {
                const track = await this.findLibraryTrack(entry.source);
                if (track) { entry.providerTrackId = String(track.id); entry.status = "READY"; unresolved.delete(entry); this.checkpoint(job); }
              } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
            }
            if (!unresolved.size) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } while (Date.now() < deadline);
          for (const entry of unresolved) this.fail(entry, "FAILED_INDEXING", "Downloaded audio was not indexed by the library");
        } catch (error) {
          for (const entry of entries) if (entry.status === "DOWNLOADED" || (entry.status === "READY" && entry.requiresScan))
            this.fail(entry, "FAILED_INDEXING", error);
        }
        this.checkpoint(job);
      }
      for (const entry of entries) {
        if (entry.status !== "READY" || !entry.providerTrackId) continue;
        try {
          const alreadyCompleted = entries.some((other) => other.status === "COMPLETED" && other.providerTrackId === entry.providerTrackId);
          const alreadyLinked = !alreadyCompleted && this.playlists.hasProviderTrack?.(job.playlistId!, entry.providerTrackId);
          if (!alreadyCompleted && !alreadyLinked) {
            const added = await this.playlists.addProviderTrack(job.playlistId!, entry.providerTrackId);
            if (!added.added) throw new Error("Could not link track to playlist");
          }
          entry.status = "COMPLETED"; delete entry.error;
        } catch (error) { this.fail(entry, "FAILED_LINKING", error); }
        this.checkpoint(job);
      }
      for (const entry of entries) {
        if (entry.status !== "COMPLETED" && !entry.status.startsWith("FAILED_"))
          this.fail(entry, "FAILED_INDEXING", "No playable library track ID was resolved");
      }
      job.stage = "completed"; this.checkpoint(job);
      if (job.failedCount) job.error = `Imported ${job.importedCount} unique songs; ${job.failedCount} of ${job.expectedCount} entries failed. `
        + entries.filter((entry) => entry.error).slice(0, 3).map((entry) => `#${entry.position} ${entry.status}: ${entry.error}`).join("; ");
    } finally { await this.cleanup(work, job); }
    job.status = job.failedCount ? (job.completedCount ? "partial" : "failed") : "completed";
    this.checkpoint(job);
  }

  private async run(job: SpotifyImportJob, spotify: { id: string; url: string }, user: SessionUser): Promise<void> {
    if (this.downloader.fetchPlaylistTracks) {
      await this.runMatched(job, spotify, user);
      return;
    }
    if (this.audioTagger) throw new Error("The downloader must expose per-track metadata for verified playlist imports");
    if (!this.backend.scanLibrary) {
      throw new Error("Playlist import requires a Navidrome library with scanning enabled");
    }

    const previousIds = new Set((await this.backend.listPlaylists()).map((playlist) => playlist.id));
    const titlePromise = this.spotifyDetails(spotify.url);
    const root = path.resolve(this.musicRoot);
    const outputDir = path.resolve(root, this.importSubdir, job.id);
    const relativeOutput = path.relative(root, outputDir);
    if (relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) {
      throw new Error("Spotify import folder must be inside the music library");
    }
    const m3uName = `musicdeck-${job.id}.m3u8`;
    safeMusicPath(root, outputDir, true);
    fs.mkdirSync(outputDir, { recursive: true });
    safeMusicPath(root, outputDir);
    job.stage = "downloading";

    const result = await this.downloader.download({
      query: spotify.url,
      outputDirectory: outputDir,
      libraryRoot: root,
      filenameTemplate: path.join(root, SPOTDL_LIBRARY_TEMPLATE),
      playlistM3uName: m3uName,
      timeoutMs: 30 * 60 * 1000,
    }, {
      jobId: job.id,
      tmpDir: outputDir,
      signal: new AbortController().signal,
      onProgress: (progress) => {
        if (!job.expectedCount) {
          const metadata = readLivePlaylistLength(path.join(outputDir, "musicdeck-source.spotdl"));
          if (metadata) job.expectedCount = metadata;
        }
        const message = progress.message || "";
        const downloading = /\b(?:downloading|downloaded|skipping)\s+(?:["']([^"']+)["']|(.+?)(?::\s*\d+%|\s*\(file already exists\)|$))/i.exec(message);
        if (downloading) job.currentTrackName = (downloading[1] || downloading[2]).trim();
        if (/\bdownloaded\s+/i.test(message) || /\bskipping\s+.*\(file already exists\)/i.test(message)) {
          job.downloadedCount = (job.downloadedCount || 0) + 1;
        }
        job.currentTrack = Math.min((job.downloadedCount || 0) + 1, job.expectedCount || Number.MAX_SAFE_INTEGER);
      },
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
    job.currentTrack = job.expectedCount;
    const filesByPosition = new Map<number, AcquiredFile>();
    for (const file of result.files) {
      const position = file.playlistPosition ?? Number(/^([0-9]+) - /.exec(path.basename(file.path))?.[1]);
      if (Number.isSafeInteger(position) && position > 0 && fs.existsSync(file.path)) filesByPosition.set(position, file);
    }

    // spotDL can exit 0 after individual songs fail. Retry those Spotify IDs
    // independently, preserving their original positions in the playlist.
    for (const track of sourceTracks) {
      if (filesByPosition.has(track.position) || !/^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+/.test(track.url)) continue;
      const retryManifest = `musicdeck-retry-${track.position}.m3u8`;
      const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-spotify-retry-"));
      let retry;
      try {
        retry = await this.downloader.download({
          spotifyTrackUrl: track.url,
          outputDirectory: retryDir,
          libraryRoot: root,
          filenameTemplate: path.join(root, SPOTDL_LIBRARY_TEMPLATE),
          playlistM3uName: retryManifest,
          broadenAudioSearch: true,
          timeoutMs: 120_000,
        }, {
          jobId: `${job.id}-retry-${track.position}`,
          tmpDir: retryDir,
          signal: new AbortController().signal,
        });
      } finally {
        // Retry manifests and metadata are temporary; only the main M3U
        // should be visible to Navidrome's playlist auto-import scan.
        await this.cleanup(retryDir, job);
      }
      const recovered = retry.files.find((file) => {
        safeMusicPath(root, file.path);
        const relative = path.relative(root, file.path);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.existsSync(file.path);
      });
      if (retry.status === "completed" && recovered) filesByPosition.set(track.position, recovered);
      job.downloadedCount = filesByPosition.size;
      job.currentTrack = Math.min(track.position + 1, job.expectedCount);
      job.currentTrackName = `${track.artist} - ${track.title}`;
    }

    const available = sourceTracks.filter((track) => filesByPosition.has(track.position));
    if (!available.length) throw new Error("spotDL could not obtain audio for any playlist tracks");
    job.downloadedCount = available.length;
    const m3uLines = ["#EXTM3U"];
    for (const track of available) {
      const file = filesByPosition.get(track.position)!;
      safeMusicPath(root, file.path);
      const withinRoot = path.relative(root, file.path);
      if (withinRoot === ".." || withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) {
        throw new Error("A downloaded track was placed outside the music library");
      }
      const relative = path.relative(outputDir, file.path);
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

    const details = await titlePromise;
    const playlist = await this.playlists.adoptProviderPlaylist(importedId, user, details.title || `Spotify Playlist ${spotify.id.slice(0, 8)}`);
    await this.importArtwork(playlist.id, details.artworkUrl);
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

function readLivePlaylistLength(filePath: string): number | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(data)) return data.reduce<number>((count, item) => {
      const declared = item && typeof item === "object" && "list_length" in item ? item.list_length : undefined;
      return Math.max(count, typeof declared === "number" && Number.isSafeInteger(declared) ? declared : 0);
    }, data.length) || undefined;
  } catch { /* spotDL may still be writing the metadata. */ }
  return undefined;
}

function normalizeSongText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function sourceKey(source: SpotifyTrackMetadata): string {
  // Album and duration distinguish recordings when no stable provider identity is available.
  return source.isrc?.trim().toUpperCase() || source.url
    || [source.artist, source.title, source.album || "", String(source.duration)].map(normalizeSongText).join("|");
}
function usableMetadata(source: SpotifyTrackMetadata, strict: boolean): boolean {
  return Boolean(source.title?.trim() && source.artist?.trim() && !/unknown/i.test(source.artist)
    && (!strict || (source.album?.trim() && /\b\d{4}\b/.test(source.year || ""))));
}
