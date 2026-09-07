import type { MusicDeckPlugin, MusicDeckPluginContext } from "./plugin-registry.js";
import type {
  CandidateResolver,
  SourceCandidate,
  SourceContainerProvider,
  SourceDiscoveryProvider,
} from "../domain/source-discovery.js";
import type { PlayableSource } from "../domain/playable-sources.js";
import type { UnifiedSearchResult } from "../domain/search.js";
import {
  extractTrackTitleFromPath,
  matchContainerFile,
  normalizeMusicText,
  versionSignature,
} from "../domain/music-identity.js";
import { validatedPlayableUrl } from "../domain/source-discovery.js";

export const AUDIO_EXTENSIONS = new Set(["flac", "mp3", "m4a", "aac", "ogg", "opus", "wav", "alac"]);
export const BLOCKED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "ico", "webp",
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm",
  "zip", "rar", "7z", "tar", "gz", "iso",
  "torrent", "xml", "json", "pdf", "txt", "cue",
  "log", "m3u", "m3u8", "md5", "ffp", "pk", "afpk",
  "sqlite", "db",
]);

export const DEFAULT_ARCHIVE_HEADERS = {
  "User-Agent": "MusicDeck/1.0.0 (https://github.com/musicdeck; musicdeck@example.com)",
  "Accept": "application/json, text/plain, */*",
};

export type ArchiveOrgDoc = {
  identifier: string;
  title?: string;
  creator?: string;
  album?: string;
  mediatype?: string;
  year?: string | number;
  description?: string;
};

export type ArchiveOrgFile = {
  name: string;
  source?: string;
  format?: string;
  length?: string | number;
  duration?: string | number;
  size?: string | number;
  bitrate?: string | number;
  title?: string;
  creator?: string;
  artist?: string;
  album?: string;
  track?: string | number;
};

export type ArchiveOrgMetadataResponse = {
  server?: string;
  dir?: string;
  metadata?: ArchiveOrgDoc;
  files?: ArchiveOrgFile[];
};

export function getFileExtension(filename: string): string {
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(filename);
  return match?.[1]?.toLowerCase() || "";
}

export function isAudioFile(filename: string, format?: string): boolean {
  const ext = getFileExtension(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  if (AUDIO_EXTENSIONS.has(ext)) return true;

  const fmt = (format || "").toLowerCase();
  if (
    fmt.includes("vbr mp3") || fmt.includes("mp3") || fmt.includes("flac") ||
    fmt.includes("ogg") || fmt.includes("vorbis") || fmt.includes("opus") ||
    fmt.includes("wave") || fmt.includes("wav") || fmt.includes("aac") ||
    fmt.includes("m4a") || fmt.includes("lossless audio")
  ) {
    return true;
  }

  return false;
}

export function detectCodec(filename: string, format?: string): string {
  const ext = getFileExtension(filename);
  if (ext === "flac") return "FLAC";
  if (ext === "mp3") return "MP3";
  if (ext === "ogg") return "OGG";
  if (ext === "opus") return "OPUS";
  if (ext === "m4a") return "M4A";
  if (ext === "aac") return "AAC";
  if (ext === "wav") return "WAV";
  if (ext === "alac") return "ALAC";

  const fmt = (format || "").toLowerCase();
  if (fmt.includes("flac")) return "FLAC";
  if (fmt.includes("mp3")) return "MP3";
  if (fmt.includes("ogg") || fmt.includes("vorbis")) return "OGG";
  if (fmt.includes("opus")) return "OPUS";
  if (fmt.includes("alac") || fmt.includes("apple lossless")) return "ALAC";
  if (fmt.includes("aac")) return "AAC";
  if (fmt.includes("m4a")) return "M4A";
  if (fmt.includes("wave") || fmt.includes("wav")) return "WAV";

  return ext.toUpperCase() || "MP3";
}

export function isLosslessCodec(codec: string): boolean {
  return ["FLAC", "ALAC", "WAV"].includes(codec.toUpperCase());
}

export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map(Number);
      if (parts.length > 0 && parts.every((p) => !Number.isNaN(p))) {
        let total = 0;
        for (const p of parts) {
          total = total * 60 + p;
        }
        if (total > 0) return Math.round(total);
      }
    }
    const num = parseFloat(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return Math.round(num);
    }
  }
  return undefined;
}

export type ArchiveRepresentation =
  | "direct-file"
  | "archive-container"
  | "torrent"
  | "metadata";

export type ArchiveRepresentationDetails = {
  identifier: string;
  directAudioFiles: ArchiveOrgFile[];
  torrentFile?: ArchiveOrgFile;
  torrentUrl?: string;
  hasTorrent: boolean;
  representations: ArchiveRepresentation[];
};

export function extractArchiveRepresentations(
  identifier: string,
  metaData: ArchiveOrgMetadataResponse
): ArchiveRepresentationDetails {
  const files = metaData.files || [];
  const directAudioFiles = files.filter((f) => isAudioFile(f.name, f.format));

  // Torrent file check: name ends with .torrent or format includes "torrent"
  const torrentFile = files.find((f) =>
    f.name.toLowerCase().endsWith(".torrent") ||
    (f.format || "").toLowerCase().includes("torrent")
  );

  const representations: ArchiveRepresentation[] = [];
  if (directAudioFiles.length > 0) {
    representations.push("direct-file");
  }
  if (torrentFile) {
    representations.push("torrent");
  }
  if (files.length > 0) {
    representations.push("archive-container");
    representations.push("metadata");
  }

  const torrentUrl = torrentFile
    ? buildArchiveDownloadUrl(identifier, torrentFile.name)
    : undefined;

  return {
    identifier,
    directAudioFiles,
    torrentFile,
    torrentUrl,
    hasTorrent: Boolean(torrentFile),
    representations,
  };
}

export function buildArchiveDownloadUrl(identifier: string, fileName: string): string {
  const cleanId = encodeURIComponent(identifier.trim());
  const cleanFile = fileName.split("/").map(encodeURIComponent).join("/");
  return `https://archive.org/download/${cleanId}/${cleanFile}`;
}

export function archiveFileMatches(
  result: UnifiedSearchResult,
  file: ArchiveOrgFile,
  itemDoc?: ArchiveOrgDoc
): boolean {
  const fileName = file.name || "";
  const fileTitle = file.title || "";
  const fileArtist = file.creator || file.artist || itemDoc?.creator || "";
  const fileAlbum = file.album || itemDoc?.album || "";
  const duration = parseDurationSeconds(file.length || file.duration);

  return matchContainerFile(result, {
    path: fileName,
    title: fileTitle,
    artist: fileArtist,
    album: fileAlbum,
    durationSeconds: duration,
  });
}

export class ArchiveOrgContainerProvider implements SourceContainerProvider {
  readonly id = "archive-org-container";
  readonly name = "Archive.org Container Provider";

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly metadataCache: Map<string, ArchiveOrgMetadataResponse> = new Map()
  ) {}

  canEnumerate(candidate: SourceCandidate): boolean {
    const isArchive = candidate.provider === "archive-org-source" || candidate.id.startsWith("archiveorg:");
    if (!isArchive) return false;
    if (candidate.kind === "album-container" || candidate.kind === "release-container" || candidate.kind === "item") {
      return true;
    }
    const rawId = candidate.id.startsWith("archiveorg:") ? candidate.id : `archiveorg:${candidate.id}`;
    const parts = rawId.split(":");
    return parts.length === 2 && Boolean(parts[1]);
  }

  async enumerate(candidate: SourceCandidate): Promise<SourceCandidate[]> {
    const rawId = candidate.id.startsWith("archiveorg:") ? candidate.id : `archiveorg:${candidate.id}`;
    const parts = rawId.split(":");
    const identifier = (candidate.metadata?.archiveIdentifier as string) || parts[1];
    if (!identifier) return [];

    let metaData = this.metadataCache.get(identifier);
    if (!metaData) {
      try {
        const metaUrl = new URL(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
        const res = await this.fetchImpl(metaUrl, { headers: DEFAULT_ARCHIVE_HEADERS });
        if (!res.ok) return [];
        metaData = (await res.json()) as ArchiveOrgMetadataResponse;
        this.metadataCache.set(identifier, metaData);
      } catch {
        return [];
      }
    }

    const audioFiles = (metaData.files || []).filter((f) => isAudioFile(f.name, f.format));
    const doc = metaData.metadata;

    return audioFiles.map((file) => {
      const cleanTitle = extractTrackTitleFromPath(file.name, file.creator || file.artist || doc?.creator || candidate.artist) || file.title || file.name.replace(/\.[a-z0-9]+$/i, "");
      const codec = detectCodec(file.name, file.format);
      const duration = parseDurationSeconds(file.length || file.duration);
      const fileSize = file.size ? Number(file.size) : undefined;
      const bitrate = file.bitrate ? Number(file.bitrate) : undefined;

      return {
        id: `archiveorg:${identifier}:${file.name}`,
        provider: "archive-org-source",
        kind: "file",
        title: cleanTitle,
        artist: file.creator || file.artist || doc?.creator || candidate.artist,
        album: file.album || doc?.album || candidate.album,
        durationSeconds: duration,
        fileSize,
        container: {
          id: identifier,
          title: candidate.title,
          artist: candidate.artist,
          album: candidate.album,
        },
        metadata: {
          archiveIdentifier: identifier,
          fileName: file.name,
        },
        quality: {
          codec,
          bitrate,
          durationSeconds: duration,
          fileSize,
          lossless: isLosslessCodec(codec),
        },
      };
    });
  }
}

export class ArchiveOrgDiscoveryProvider implements SourceDiscoveryProvider {
  readonly id = "archive-org-source";
  readonly name = "Archive.org";

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly metadataCache: Map<string, ArchiveOrgMetadataResponse> = new Map()
  ) {}

  async search(result: UnifiedSearchResult): Promise<SourceCandidate[]> {
    if (result.type !== "track") {
      return [];
    }

    const title = (result.title || "").trim();
    const artist = (result.artist || "").trim();
    const album = (result.album || "").trim();
    if (!title) return [];

    let query: string;
    if (album && normalizeMusicText(album) !== normalizeMusicText(title)) {
      query = `(("${title.replace(/"/g, "")}") OR ("${album.replace(/"/g, "")}"))`;
    } else {
      query = `("${title.replace(/"/g, "")}")`;
    }

    if (artist) {
      query += ` AND ("${artist.replace(/"/g, "")}")`;
    }
    query += " AND mediatype:(audio OR etree)";

    const searchUrl = new URL("https://archive.org/advancedsearch.php");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.append("fl[]", "identifier");
    searchUrl.searchParams.append("fl[]", "title");
    searchUrl.searchParams.append("fl[]", "creator");
    searchUrl.searchParams.append("fl[]", "album");
    searchUrl.searchParams.append("fl[]", "mediatype");
    searchUrl.searchParams.append("fl[]", "year");
    searchUrl.searchParams.set("rows", "10");
    searchUrl.searchParams.set("output", "json");

    let docs: ArchiveOrgDoc[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await this.fetchImpl(searchUrl, {
        headers: DEFAULT_ARCHIVE_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        return [];
      }

      const data = await res.json() as { response?: { docs?: ArchiveOrgDoc[] }; docs?: ArchiveOrgDoc[] };
      docs = data?.response?.docs || data?.docs || [];
    } catch {
      return [];
    }

    if (!Array.isArray(docs) || docs.length === 0) {
      return [];
    }

    const candidates: SourceCandidate[] = [];
    const topDocs = docs.slice(0, 5);

    let totalItemsFound = 0;
    let totalContainerRepresentations = 0;
    let totalDirectAudioFiles = 0;

    await Promise.allSettled(
      topDocs.map(async (doc) => {
        if (!doc.identifier) return;

        try {
          let metaData = this.metadataCache.get(doc.identifier);
          if (!metaData) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            const metaUrl = new URL(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
            const res = await this.fetchImpl(metaUrl, {
              headers: DEFAULT_ARCHIVE_HEADERS,
              signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) return;

            metaData = (await res.json()) as ArchiveOrgMetadataResponse;
            this.metadataCache.set(doc.identifier, metaData);
          }

          const rep = extractArchiveRepresentations(doc.identifier, metaData);
          if (rep.directAudioFiles.length === 0) return;

          totalItemsFound += 1;
          if (rep.hasTorrent || rep.representations.includes("archive-container")) {
            totalContainerRepresentations += 1;
          }
          totalDirectAudioFiles += rep.directAudioFiles.length;

          // Emit track file candidates (direct files)
          for (const file of rep.directAudioFiles) {
            const codec = detectCodec(file.name, file.format);
            const duration = parseDurationSeconds(file.length || file.duration);
            const fileSize = file.size ? Number(file.size) : undefined;
            const bitrate = file.bitrate ? Number(file.bitrate) : undefined;
            const cleanTitle = extractTrackTitleFromPath(file.name, file.creator || file.artist || doc.creator || artist) || file.title || (rep.directAudioFiles.length === 1 ? (extractTrackTitleFromPath(doc.title || "", doc.creator || artist) || doc.title) : file.name.replace(/\.[a-z0-9]+$/i, ""));

            candidates.push({
              id: `archiveorg:${doc.identifier}:${file.name}`,
              provider: "archive-org-source",
              kind: "file",
              title: cleanTitle || title,
              artist: file.creator || file.artist || doc.creator || artist,
              album: file.album || doc.album || doc.title,
              durationSeconds: duration,
              fileSize,
              container: {
                id: doc.identifier,
                title: doc.title || doc.album,
                artist: doc.creator || artist,
                album: doc.album || doc.title,
              },
              metadata: {
                source: "archive-org",
                archiveIdentifier: doc.identifier,
                fileName: file.name,
                representation: "direct-file",
              },
              quality: {
                codec,
                bitrate,
                durationSeconds: duration,
                fileSize,
                lossless: isLosslessCodec(codec),
              },
            });
          }

          // Also add container candidate for multi-file items or albums
          const isAlbum = rep.directAudioFiles.length > 1 || (doc.album && doc.album === doc.title) || rep.hasTorrent;
          if (isAlbum) {
            candidates.push({
              id: `archiveorg:container:${doc.identifier}`,
              provider: "archive-org-source",
              kind: "album-container",
              title: doc.title || doc.album || title,
              artist: doc.creator || artist,
              album: doc.album || doc.title,
              container: {
                id: doc.identifier,
                title: doc.title || doc.album,
                artist: doc.creator || artist,
                album: doc.album || doc.title,
              },
              metadata: {
                source: "archive-org",
                archiveIdentifier: doc.identifier,
                representation: rep.hasTorrent ? "torrent" : "archive-container",
                torrentUrl: rep.torrentUrl,
                hasTorrent: rep.hasTorrent,
                directAudioCount: rep.directAudioFiles.length,
              },
              quality: {
                codec: rep.directAudioFiles.length > 0 ? detectCodec(rep.directAudioFiles[0].name, rep.directAudioFiles[0].format) : "FLAC",
                lossless: rep.directAudioFiles.length > 0 ? isLosslessCodec(detectCodec(rep.directAudioFiles[0].name, rep.directAudioFiles[0].format)) : true,
              },
            });
          }
        } catch {
          // Bounded per-item error isolation
        }
      })
    );

    console.log(
      `[ArchiveOrg]\n` +
      `  itemsFound = ${totalItemsFound}\n` +
      `  containerRepresentations = ${totalContainerRepresentations}\n` +
      `  directAudioFiles = ${totalDirectAudioFiles}`
    );

    return candidates;
  }
}

export class ArchiveOrgResolver implements CandidateResolver {
  readonly id = "archive-org-resolver";
  readonly name = "Archive.org";

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly metadataCache: Map<string, ArchiveOrgMetadataResponse> = new Map()
  ) {}

  canResolve(candidate: SourceCandidate): boolean {
    const id = candidate.id || "";
    return id.startsWith("archiveorg:") || id.startsWith("archive-org:") || candidate.provider === "archive-org-source";
  }

  async resolve(
    candidate: SourceCandidate,
    options?: { target?: UnifiedSearchResult; limit?: number }
  ): Promise<PlayableSource[]> {
    const rawId = candidate.id.includes(":") ? candidate.id : `archiveorg:${candidate.id}`;
    const parts = rawId.split(":");
    // format: archiveorg:identifier or archiveorg:identifier:filename
    const identifier = (candidate.metadata?.archiveIdentifier as string) || parts[1];
    const fileName = (candidate.metadata?.fileName as string) || (parts.length > 2 ? parts.slice(2).join(":") : "");

    if (!identifier) {
      return [];
    }

    if (fileName) {
      // Direct file candidate
      const downloadUrl = buildArchiveDownloadUrl(identifier, fileName);
      const safeUrl = validatedPlayableUrl(downloadUrl);
      if (!safeUrl) return [];

      const codec = candidate.quality?.codec || detectCodec(fileName);
      return [{
        id: safeUrl,
        provider: "plugin",
        type: "external",
        mediaType: "audio",
        label: "Archive.org",
        availability: "available",
        quality: {
          codec,
          bitrate: candidate.quality?.bitrate,
          sampleRate: candidate.quality?.sampleRate,
          bitDepth: candidate.quality?.bitDepth,
          durationSeconds: candidate.durationSeconds || candidate.quality?.durationSeconds,
          fileSize: candidate.fileSize || candidate.quality?.fileSize,
          lossless: candidate.quality?.lossless ?? isLosslessCodec(codec),
        },
      }];
    }

    // Container candidate fallback: fetch metadata, inspect files, match target track
    try {
      let metaData = this.metadataCache.get(identifier);
      if (!metaData) {
        const metaUrl = new URL(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
        const res = await this.fetchImpl(metaUrl, { headers: DEFAULT_ARCHIVE_HEADERS });
        if (!res.ok) return [];
        metaData = (await res.json()) as ArchiveOrgMetadataResponse;
        this.metadataCache.set(identifier, metaData);
      }

      const audioFiles = (metaData.files || []).filter((f) => isAudioFile(f.name, f.format));

      const target = options?.target;
      const matchedFiles = target
        ? audioFiles.filter((f) => archiveFileMatches(target, f, metaData!.metadata))
        : audioFiles;

      const results: PlayableSource[] = [];
      for (const file of matchedFiles) {
        const downloadUrl = buildArchiveDownloadUrl(identifier, file.name);
        const safeUrl = validatedPlayableUrl(downloadUrl);
        if (!safeUrl) continue;

        const codec = detectCodec(file.name, file.format);
        const duration = parseDurationSeconds(file.length || file.duration);
        const fileSize = file.size ? Number(file.size) : undefined;
        const bitrate = file.bitrate ? Number(file.bitrate) : undefined;

        results.push({
          id: safeUrl,
          provider: "plugin",
          type: "external",
          mediaType: "audio",
          label: "Archive.org",
          availability: "available",
          quality: {
            codec,
            bitrate,
            durationSeconds: duration,
            fileSize,
            lossless: isLosslessCodec(codec),
          },
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      const searchUrl = new URL("https://archive.org/advancedsearch.php?q=Queen%20Bohemian%20Rhapsody&rows=1&output=json");
      const res = await this.fetchImpl(searchUrl, { headers: DEFAULT_ARCHIVE_HEADERS });
      return { ok: res.ok, message: res.ok ? "Archive.org is reachable" : "Archive.org is unavailable" };
    } catch {
      return { ok: false, message: "Archive.org connection failed" };
    }
  }
}

export function createArchiveOrgSourcePlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "archive-org-source",
      name: "Archive.org",
      version: "1.0.0",
      description: "Discovers and streams public-domain and creative commons audio files directly from Archive.org item metadata.",
      capabilities: ["source"],
      permissions: ["network.request", "external-source.play"],
      config: {
        fields: [],
      },
    },
    register(context) {
      const fetchImpl = (context.network?.fetch || fetch) as typeof fetch;
      const metadataCache = new Map<string, ArchiveOrgMetadataResponse>();

      context.sourceDiscovery?.register(new ArchiveOrgDiscoveryProvider(fetchImpl, metadataCache));
      context.sourceDiscovery?.configure("archive-org-source", true);

      context.sourceContainers?.register(new ArchiveOrgContainerProvider(fetchImpl, metadataCache));

      context.sourceResolvers?.register(new ArchiveOrgResolver(fetchImpl, metadataCache));
      context.sourceResolvers?.configure("archive-org-resolver", true);
    },
    async test(context) {
      const fetchImpl = (context.network?.fetch || fetch) as typeof fetch;
      try {
        const searchUrl = new URL("https://archive.org/advancedsearch.php?q=Queen%20Bohemian%20Rhapsody&rows=3&output=json");
        const res = await fetchImpl(searchUrl, { headers: DEFAULT_ARCHIVE_HEADERS });
        if (!res.ok) {
          return { ok: false, message: `Archive.org search returned HTTP ${res.status}` };
        }

        const data = await res.json() as { response?: { docs?: ArchiveOrgDoc[] }; docs?: ArchiveOrgDoc[] };
        const docs = data?.response?.docs || data?.docs || [];
        if (docs.length === 0) {
          return { ok: true, message: "Archive.org is reachable (0 items found)" };
        }

        // Test metadata endpoint with first item
        const firstId = docs[0].identifier;
        const metaRes = await fetchImpl(new URL(`https://archive.org/metadata/${encodeURIComponent(firstId)}`), {
          headers: DEFAULT_ARCHIVE_HEADERS,
        });

        let audioCount = 0;
        if (metaRes.ok) {
          const meta = await metaRes.json() as ArchiveOrgMetadataResponse;
          audioCount = (meta.files || []).filter((f) => isAudioFile(f.name, f.format)).length;
        }

        return {
          ok: true,
          message: `Archive.org is reachable (${docs.length} item(s), ${audioCount} audio file(s) found)`,
          details: {
            itemsFound: docs.length,
            audioFilesFound: audioCount,
          },
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Archive.org connection failed" };
      }
    },
  };
}
