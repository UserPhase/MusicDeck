import type { MusicDeckPlugin, MusicDeckPluginContext } from "../plugin-registry.js";
import type { PlayableSource, SourceProvider } from "../../domain/playable-sources.js";
import type { UnifiedSearchResult } from "../../domain/search.js";
import { matchContainerFile, normalizeMusicText, versionSignature } from "../../domain/music-identity.js";

type ExternalAudioSource = {
  id?: string;
  url?: string;
  title?: string;
  artist?: string;
  album?: string;
  codec?: string;
  bitrate?: number;
  sampleRate?: number;
  bitDepth?: number;
  durationSeconds?: number;
  fileSize?: number;
  lossless?: boolean;
};

function privateHostname(hostname: string) {
  return hostname === "localhost"
    || hostname.endsWith(".local")
    || hostname.startsWith("127.")
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || hostname.startsWith("169.254.")
    || hostname === "::1";
}

function validatedSourceUrl(value: unknown, baseUrl: string) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || privateHostname(url.hostname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function sourceMatches(result: UnifiedSearchResult, source: ExternalAudioSource) {
  const providerId = source.id || source.url;
  if (providerId && result.id === `external_http_${normalizeMusicText(providerId).replace(/\s+/g, "-")}`) {
    return true;
  }

  const title = normalizeMusicText(source.title);
  const artist = normalizeMusicText(source.artist);
  const album = normalizeMusicText(source.album);

  return Boolean(title)
    && normalizeMusicText(result.title) === title
    && (!artist || normalizeMusicText(result.artist) === artist)
    && (!album || normalizeMusicText(result.album) === album);
}

class AuthorizedHttpSourceProvider implements SourceProvider {
  readonly id = "authorized-http-source";
  readonly name = "External source";
  readonly capabilities = {
    tracks: true,
    albums: false,
    quality: true,
    multipleSources: true,
    caching: true,
  };

  constructor(
    private readonly context: MusicDeckPluginContext,
    private readonly fetchImpl: typeof fetch
  ) {}

  private config() {
    const baseUrl = this.context.settings.get<string>("baseUrl");
    const token = this.context.settings.get<string>("accessToken");
    if (!baseUrl || !token) {
      throw new Error("External source is misconfigured");
    }

    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || privateHostname(base.hostname)) {
      throw new Error("External source is unavailable");
    }

    return { baseUrl: base.toString(), token };
  }

  private async request(path: string, init?: RequestInit) {
    const { baseUrl, token } = this.config();
    const response = await this.fetchImpl(new URL(path, baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error("External source is unavailable");
    }
    return response;
  }

  canResolve(result: UnifiedSearchResult) {
    return result.type === "track";
  }

  async getSources(result: UnifiedSearchResult): Promise<PlayableSource[]> {
    if (!(await this.canResolve(result))) return [];

    const query = new URLSearchParams({
      title: result.title,
      artist: result.artist || "",
      album: result.album || "",
    });
    const response = await this.request(`/v1/sources?${query.toString()}`);
    const payload = await response.json() as { sources?: ExternalAudioSource[] };
    const { baseUrl } = this.config();

    return (payload.sources || []).flatMap((source) => {
      if (!sourceMatches(result, source)) return [];
      const url = validatedSourceUrl(source.url, baseUrl);
      if (!url) return [];

      return [{
        id: url.toString(),
        provider: "plugin" as const,
        type: "external" as const,
        mediaType: "audio" as const,
        label: "External source",
        availability: "available" as const,
        quality: {
          codec: source.codec,
          bitrate: source.bitrate,
          sampleRate: source.sampleRate,
          bitDepth: source.bitDepth,
          durationSeconds: source.durationSeconds,
          fileSize: source.fileSize,
          lossless: typeof source.lossless === "boolean"
            ? source.lossless
            : ["flac", "alac", "wav"].includes(String(source.codec || "").toLowerCase()),
        },
      }];
    });
  }

  async test() {
    await this.request("/v1/health");
    return { ok: true, message: "External source is reachable" };
  }

  async fetchStream(source: PlayableSource, range?: string) {
    const url = validatedSourceUrl(source.id, this.config().baseUrl);
    if (!url) {
      throw new Error("External source is unavailable");
    }

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.config().token}`,
        ...(range ? { Range: range } : {}),
      },
    });
    if (!response.ok) {
      throw new Error("External source is unavailable");
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/^(audio\/|application\/octet-stream)/i.test(contentType)) {
      throw new Error("External source is unavailable");
    }

    return { body: response.body, status: response.status, headers: response.headers };
  }
}

export function createAuthorizedExternalSourcePlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "authorized-external-source",
      name: "Authorized External Source",
      version: "1.0.0",
      description: "Resolves authorized external audio sources through a configured HTTPS service.",
      capabilities: ["source"],
      permissions: ["network.request", "external-source.play"],
      config: {
        fields: [
          { key: "baseUrl", label: "Provider base URL", required: true },
          { key: "accessToken", label: "Access token", secret: true, required: true },
        ],
      },
    },
    register(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      context.sources?.register(new AuthorizedHttpSourceProvider(context, fetchImpl));
    },
    async test(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      return new AuthorizedHttpSourceProvider(context, fetchImpl).test();
    },
  };
}

type DebridFile = {
  id?: string;
  name?: string;
  url?: string;
  size?: number;
  durationSeconds?: number;
  codec?: string;
  bitrate?: number;
  sampleRate?: number;
  bitDepth?: number;
};

type DebridJob = {
  id: string;
  status: "queued" | "processing" | "ready" | "failed";
  files?: DebridFile[];
};

const AUDIO_EXTENSIONS = new Set(["flac", "mp3", "m4a", "aac", "ogg", "opus", "wav", "alac"]);
const BLOCKED_EXTENSIONS = new Set(["mp4", "mkv", "avi", "mov", "srt", "vtt", "zip", "rar", "7z"]);

function fileExtension(file: DebridFile) {
  const name = file.name || file.url || "";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(name);
  return match?.[1]?.toLowerCase() || "";
}

function isAudioFile(file: DebridFile) {
  const extension = fileExtension(file);
  return AUDIO_EXTENSIONS.has(extension) && !BLOCKED_EXTENSIONS.has(extension);
}

/** Submission inputs the debrid provider may accept. Any direct media/page
 * URL or magnet link can be submitted; the provider decides whether it can
 * fetch it, and only audio files come back as playable sources. */
function validatedSubmission(value: string): string | null {
  if (value.startsWith("magnet:")) {
    return value.includes("xt=urn:") ? value : null;
  }
  return validatedSourceUrl(value, "https://debrid.example")?.toString() || null;
}

export function debridFileMatchesForTest(result: UnifiedSearchResult, file: DebridFile) {
  return fileMatches(result, file);
}

function isTrackNumberOrTag(segment: string): boolean {
  const clean = segment.trim();
  return /^\d{1,3}$/.test(clean)
    || /^(?:track|disc|cd|side|part)\s*\d+$/i.test(clean)
    || /^(?:flac|mp3|wav|320|320kbps|v0|lossless|audio|cbr|vbr)$/i.test(clean);
}

function fileMatches(result: UnifiedSearchResult, file: DebridFile) {
  const rawName = (file.name || file.url || "").replace(/\.[a-z0-9]+(?:$|\?)/i, "");
  const segments = rawName.split(/\s+-\s+|\s+_\s+/).map((segment) => normalizeMusicText(segment)).filter(Boolean);
  const title = normalizeMusicText(result.title);
  const artist = normalizeMusicText(result.artist);
  const album = normalizeMusicText(result.album);
  const requestedVersion = versionSignature(result.title);
  const fileVersion = versionSignature(rawName);

  if (!title) return false;
  const titleMatches = segments.some((segment) => segment === title || segment.includes(title))
    || normalizeMusicText(rawName).includes(title);
  if (!titleMatches) return false;

  if (requestedVersion !== fileVersion) return false;

  const requestedDuration = Number(result.metadata?.durationSeconds || 0);
  if (requestedDuration && file.durationSeconds && Math.abs(file.durationSeconds - requestedDuration) > 20) {
    return false;
  }

  const nonTitleSegments = segments.filter((s) => s !== title && !s.includes(title) && !isTrackNumberOrTag(s));
  if (nonTitleSegments.length > 0 && artist) {
    const matchesKnownMetadata = nonTitleSegments.some(
      (s) => s === artist || s.includes(artist) || artist.includes(s) || (album && (s === album || s.includes(album) || album.includes(s)))
    );
    if (!matchesKnownMetadata) {
      return false;
    }
  }

  return true;
}

function sourceFromFile(result: UnifiedSearchResult, file: DebridFile): PlayableSource | null {
  if (!isAudioFile(file) || !fileMatches(result, file)) return null;
  const url = validatedSourceUrl(file.url, "https://debrid.example");
  if (!url) return null;

  const codec = file.codec || fileExtension(file).toUpperCase();
  return {
    id: url.toString(),
    provider: "plugin",
    type: "external",
    mediaType: "audio",
    label: "External cloud source",
    availability: "available",
    quality: {
      codec,
      bitrate: file.bitrate,
      sampleRate: file.sampleRate,
      bitDepth: file.bitDepth,
      durationSeconds: file.durationSeconds,
      fileSize: file.size,
      lossless: ["FLAC", "ALAC", "WAV"].includes(codec),
    },
  };
}

type DebridDriver = {
  test(): Promise<void>;
  resolveTrack(result: UnifiedSearchResult): Promise<DebridJob>;
  fetchUrl(url: string, target?: UnifiedSearchResult): Promise<DebridJob>;
};

/**
 * Real-Debrid (https://real-debrid.com) REST adapter. Real-Debrid does not
 * speak MusicDeck's generic /v1 job contract, so this driver maps that
 * contract onto Real-Debrid's own endpoints:
 *   test        -> GET  /user
 *   fetchUrl    -> POST /torrents/addMagnet
 *                  GET  /torrents/info/{id}            (inspect files)
 *                  POST /torrents/selectFiles/{id}     (select requested audio)
 *                  GET  /torrents/info/{id}            (poll until downloaded)
 *                  POST /unrestrict/link               (turn link -> CDN url)
 * Base URL must be the API root, https://api.real-debrid.com/rest/1.0.
 */
class RealDebridDriver implements DebridDriver {
  private readonly base: URL;
  private readonly cleanToken: string;

  constructor(
    baseUrl: string,
    token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly pollDelayMs: (attempt: number) => number
  ) {
    this.cleanToken = (token || "").trim().replace(/^Bearer\s+/i, "");
    let normalized = (baseUrl || "").trim();
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      normalized = `https://${normalized}`;
    }
    const url = new URL(normalized);
    if (url.protocol !== "https:" || privateHostname(url.hostname)) {
      throw new Error("External source is unavailable");
    }
    // Accept https://real-debrid.com, https://api.real-debrid.com, etc., normalizing to the REST API root.
    if (url.hostname.toLowerCase().includes("real-debrid.com") && !url.pathname.includes("/rest/1.0")) {
      this.base = new URL("https://api.real-debrid.com/rest/1.0");
    } else {
      this.base = url;
    }
  }

  private async call<T>(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.base.toString().endsWith("/") ? this.base.toString() : `${this.base}/`);
    const headers: Record<string, string> = { authorization: `Bearer ${this.cleanToken}` };
    let body: string | undefined;
    if (init?.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const response = await this.fetchImpl(url, { method: init?.method || "GET", headers, body });
    if (response.status === 401 || response.status === 403) {
      throw new Error("External source authentication failed");
    }
    if (!response.ok) {
      throw new Error("External source is unavailable");
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }

  async test() {
    await this.call("/user");
  }

  private async addMagnet(magnet: string) {
    const added = await this.call<{ id: string }>("/torrents/addMagnet", { method: "POST", form: { magnet } });
    if (!added?.id) throw new Error("External source is unavailable");
    return added.id;
  }

  private async info(id: string) {
    return this.call<{
      id: string;
      status?: string;
      files?: Array<{ id: number; path: string; bytes: number; selected: number }>;
      links?: string[];
    }>(`/torrents/info/${encodeURIComponent(id)}`);
  }

  private async unrestrict(link: string) {
    const out = await this.call<{ download?: string }>("/unrestrict/link", { method: "POST", form: { link } });
    if (!out?.download) throw new Error("External source is unavailable");
    return out.download;
  }

  /** Poll a torrent until Real-Debrid has cached or downloaded it. */
  private async waitForDownloaded(id: string) {
    const maxAttempts = 6;
    let info = await this.info(id);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (info.status === "downloaded") return info;
      if (["error", "magnet_error", "magnet_conversion", "virus", "dead"].includes(info.status || "")) {
        return null;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs(attempt)));
        info = await this.info(id);
      }
    }
    return info.status === "downloaded" ? info : null;
  }

  async fetchUrl(url: string, target?: UnifiedSearchResult): Promise<DebridJob> {
    if (!url.startsWith("magnet:")) {
      // Real-Debrid fetches torrents via magnet; plain https file links can be
      // unrestricted directly if they are supported hoster links.
      const download = await this.unrestrict(url);
      return { id: `rd-direct-${Date.now()}`, status: "ready", files: [{ url: download }] };
    }

    // Step 1: Add magnet to Real-Debrid
    const torrentId = await this.addMagnet(url);

    // Step 2: Get initial torrent info to inspect files
    const initialInfo = await this.info(torrentId);
    if (!initialInfo || !Array.isArray(initialInfo.files) || initialInfo.files.length === 0) {
      return { id: torrentId, status: "failed" };
    }

    // Step 3: Inspect files and select audio files (preferring ones matching target track if provided)
    const audio = initialInfo.files.filter((file) => isAudioFile({ name: file.path, size: file.bytes }));
    if (audio.length === 0) {
      return { id: torrentId, status: "failed" };
    }

    let selectedFiles = audio;
    if (target) {
      const matching = audio.filter((file) => fileMatches(target, { name: file.path.split("/").pop() || file.path, size: file.bytes }));
      if (matching.length > 0) {
        selectedFiles = matching;
      }
    }

    // Step 4: Call selectFiles on Real-Debrid to start torrent processing
    await this.call(`/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
      method: "POST",
      form: { files: selectedFiles.map((file) => String(file.id)).join(",") },
    });

    // Step 5: Poll provider state until 'downloaded'
    const completedInfo = await this.waitForDownloaded(torrentId);
    if (!completedInfo || !Array.isArray(completedInfo.links) || completedInfo.links.length === 0) {
      return { id: torrentId, status: "failed" };
    }

    // Step 6: Map generated links explicitly to selected file items
    const selectedSet = new Set(selectedFiles.map((f) => f.id));
    const completedSelected = (completedInfo.files || []).filter((f) => f.selected === 1 || selectedSet.has(f.id));
    const filesToMap = completedSelected.length > 0 ? completedSelected : selectedFiles;

    const files: DebridFile[] = [];
    for (let index = 0; index < completedInfo.links.length && index < filesToMap.length; index += 1) {
      const file = filesToMap[index];
      try {
        const download = await this.unrestrict(completedInfo.links[index]);
        files.push({ name: file.path.split("/").pop() || file.path, url: download, size: file.bytes });
      } catch {
        // A single unrestrict failure should not drop the other files.
      }
    }

    return { id: torrentId, status: files.length > 0 ? "ready" : "failed", files };
  }

  async resolveTrack(result: UnifiedSearchResult): Promise<DebridJob> {
    // Real-Debrid has no title/artist search; track resolution flows through
    // the discovery pipeline (a scraper supplies the magnet) into fetchUrl.
    return { id: "rd-unsupported", status: "failed" };
  }
}

/** MusicDeck's generic /v1 job contract, used by compatible debrid shims. */
class GenericDebridDriver implements DebridDriver {
  constructor(private readonly provider: DebridCloudSourceProvider) {}

  async test() {
    await this.provider.requestPublic("/v1/account");
  }

  async resolveTrack(result: UnifiedSearchResult): Promise<DebridJob> {
    const response = await this.provider.requestPublic("/v1/resolve", {
      method: "POST",
      body: JSON.stringify({
        title: result.title,
        artist: result.artist,
        album: result.album,
        durationSeconds: result.metadata.durationSeconds || null,
        identity: result.identity || null,
      }),
    });
    return response.json() as Promise<DebridJob>;
  }

  async fetchUrl(url: string, _target?: UnifiedSearchResult): Promise<DebridJob> {
    const response = await this.provider.requestPublic("/v1/fetch", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    const job = await response.json() as DebridJob;
    if (job?.id && job.status !== "ready" && job.status !== "failed") {
      const ready = await this.provider.waitForReadyPublic(job.id);
      if (ready) return ready;
    }
    return job;
  }
}

type CachedContainerJob = {
  containerKey: string;
  jobId: string;
  submission: string;
  files: DebridFile[];
  expiresAt: number;
  inFlight?: Promise<DebridJob>;
};

export class DebridCloudSourceProvider implements SourceProvider {
  readonly id = "debrid-cloud";
  readonly name = "External cloud source";
  readonly capabilities = {
    tracks: true,
    albums: false,
    quality: true,
    multipleSources: true,
    caching: true,
  };

  private readonly containerJobCache = new Map<string, CachedContainerJob>();

  constructor(
    private readonly context: MusicDeckPluginContext,
    private readonly fetchImpl: typeof fetch,
    private readonly pollDelayMs: (attempt: number) => number = (attempt) => Math.min(500 * (attempt + 1), 2000)
  ) {}

  registerResolver() {
    this.context.sourceResolvers?.register({
      id: "debrid-cloud",
      name: "External cloud source",
      canResolve: (candidate) => {
        if (candidate.provider === "archive-org-source" || candidate.id.startsWith("archiveorg:") || candidate.id.startsWith("archive-org:")) {
          return Boolean(
            (candidate.metadata as any)?.torrentUrl ||
            (candidate.metadata as any)?.representation === "torrent" ||
            (candidate.metadata as any)?.hasTorrent
          );
        }
        if (candidate.kind === "album-container" || candidate.kind === "release-container") {
          return true;
        }
        if ((candidate.metadata as any)?.torrentUrl || (candidate.metadata as any)?.representation === "torrent") {
          return true;
        }
        const separator = candidate.id.indexOf(":");
        const value = separator >= 0 ? candidate.id.slice(separator + 1) : candidate.id;
        return value.startsWith("magnet:") || /^https:\/\//.test(value) || value.includes(".torrent");
      },
      resolve: (candidate, options) => this.resolveCandidate(candidate, options),
      test: () => this.test(),
    });
  }

  private config() {
    const rawBaseUrl = (this.context.settings.get<string>("baseUrl") || "").trim();
    const token = (this.context.settings.get<string>("accessToken") || "").trim();
    if (!rawBaseUrl || !token) throw new Error("External source is misconfigured");

    let baseUrl = rawBaseUrl;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = `https://${baseUrl}`;
    }

    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || privateHostname(base.hostname)) {
      throw new Error("External source is unavailable");
    }

    return { baseUrl: base.toString(), token };
  }

  /** Choose the Real-Debrid adapter when the configured base URL is
   * Real-Debrid's API host or root domain, otherwise use MusicDeck's generic
   * /v1 contract (compatible shims). The choice is explicit and server-side. */
  private isRealDebrid() {
    try {
      const hostname = new URL(this.config().baseUrl).hostname.toLowerCase();
      return hostname === "api.real-debrid.com" || hostname === "real-debrid.com" || hostname.endsWith(".real-debrid.com");
    } catch {
      return false;
    }
  }

  private driver(): DebridDriver {
    if (this.isRealDebrid()) {
      const { baseUrl, token } = this.config();
      return new RealDebridDriver(baseUrl, token, this.fetchImpl, this.pollDelayMs);
    }
    return new GenericDebridDriver(this);
  }

  /** Public thin wrappers used by the generic driver; not part of the SDK. */
  requestPublic(path: string, init?: RequestInit) {
    return this.request(path, init);
  }

  waitForReadyPublic(jobId: string) {
    return this.waitForReady(jobId);
  }

  private async request(path: string, init?: RequestInit) {
    const { baseUrl, token } = this.config();
    const url = path.startsWith("https://") ? new URL(path) : new URL(path, baseUrl);
    if (url.protocol !== "https:" || privateHostname(url.hostname)) {
      throw new Error("External source is unavailable");
    }

    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!response.ok) throw new Error("External source is unavailable");
    return response;
  }

  canResolve(result: UnifiedSearchResult) {
    return result.type === "track";
  }

  private async createJob(result: UnifiedSearchResult) {
    return this.driver().resolveTrack(result);
  }

  /** Submit a discovered input (direct URL, magnet, or provider-supported
   * link) for remote fetch, then return provider-hosted audio files. The
   * input stays server-side and is never returned to the client. */
  private async resolveCandidate(
    candidate: { id: string; kind?: string; container?: { id?: string }; metadata?: Record<string, unknown> },
    options?: { target?: UnifiedSearchResult; limit?: number }
  ): Promise<PlayableSource[]> {
    const rawUrl = (candidate.metadata?.torrentUrl as string)
      || ((candidate.id.includes(":") && !candidate.id.startsWith("archiveorg:") && !candidate.id.startsWith("archive-org:"))
        ? candidate.id.slice(candidate.id.indexOf(":") + 1)
        : candidate.id);
    if (!rawUrl || rawUrl.startsWith("archiveorg:") || rawUrl.startsWith("archive-org:") || rawUrl.startsWith("container:")) {
      return [];
    }
    const submission = validatedSubmission(rawUrl);
    if (!submission) {
      return [];
    }

    const containerKey = candidate.container?.id
      ? `container:${candidate.container.id}`
      : candidate.metadata?.archiveIdentifier
        ? `archive-org:${candidate.metadata.archiveIdentifier}`
        : candidate.metadata?.containerKey
          ? String(candidate.metadata.containerKey)
          : submission.startsWith("magnet:")
            ? `magnet:${submission.split("&")[0]}`
            : submission;

    let cached = this.containerJobCache.get(containerKey);
    let jobReused = false;
    let containerSubmitted = false;
    let job: DebridJob | null = null;

    if (cached && cached.expiresAt > Date.now() && cached.files.length > 0) {
      jobReused = true;
      job = { id: cached.jobId, status: "ready", files: cached.files };
    } else if (cached?.inFlight) {
      // Concurrent in-flight request for the same container
      jobReused = true;
      job = await cached.inFlight;
    } else {
      containerSubmitted = true;
      const inFlightPromise = (async () => {
        return this.driver().fetchUrl(submission, options?.target);
      })();

      this.containerJobCache.set(containerKey, {
        containerKey,
        jobId: "pending",
        submission,
        files: [],
        expiresAt: Date.now() + 30 * 60_000,
        inFlight: inFlightPromise,
      });

      try {
        job = await inFlightPromise;
      } catch (err) {
        this.containerJobCache.delete(containerKey);
        throw err;
      }

      if (job?.id && job.status === "ready" && Array.isArray(job.files) && job.files.length > 0) {
        this.containerJobCache.set(containerKey, {
          containerKey,
          jobId: job.id,
          submission,
          files: job.files,
          expiresAt: Date.now() + 30 * 60_000,
        });
      } else {
        this.containerJobCache.delete(containerKey);
        return [];
      }
    }

    if (!job || job.status !== "ready" || !Array.isArray(job.files)) {
      return [];
    }

    const audio = job.files.filter((f) => isAudioFile(f));
    const target = options?.target;
    let matching = audio;
    if (target) {
      matching = audio.filter((file) =>
        fileMatches(target, file) ||
        matchContainerFile(target, {
          path: file.name || file.url,
          title: file.name,
          artist: target.artist || undefined,
          durationSeconds: file.durationSeconds,
        })
      );
    }

    const selectedFile = matching[0];
    const playableSources: PlayableSource[] = [];

    for (const file of matching) {
      const playable = validatedSourceUrl(file.url, this.config().baseUrl);
      if (!playable) continue;

      const codec = file.codec || fileExtension(file).toUpperCase();
      playableSources.push({
        id: playable.toString(),
        provider: "plugin" as const,
        type: "external" as const,
        mediaType: "audio" as const,
        label: "External cloud source",
        availability: "available" as const,
        quality: {
          codec,
          bitrate: file.bitrate,
          sampleRate: file.sampleRate,
          bitDepth: file.bitDepth,
          durationSeconds: file.durationSeconds,
          fileSize: file.size,
          lossless: ["FLAC", "ALAC", "WAV"].includes(codec),
        },
      });
    }

    console.log(
      `[Debrid]\n` +
      `  container submitted = ${containerSubmitted}\n` +
      `  job reused = ${jobReused}\n` +
      `  files enumerated = ${jobReused ? "cache hit" : audio.length}\n` +
      `  matching files = ${matching.length}\n` +
      `  selected = ${selectedFile?.name || "none"}\n` +
      `  playable sources = ${playableSources.length}`
    );

    return playableSources;
  }

  private async waitForReady(jobId: string) {
    const maxAttempts = 6;
    let job: DebridJob | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.request(`/v1/resolve/${encodeURIComponent(jobId)}`);
      job = await response.json() as DebridJob;
      if (job.status === "ready" || job.status === "failed") return job;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs(attempt)));
      }
    }

    return job;
  }

  async getSources(result: UnifiedSearchResult): Promise<PlayableSource[]> {
    if (this.isRealDebrid()) {
      // Real-Debrid cannot search by track/artist metadata directly;
      // resolution flows via discovery providers into resolveCandidate().
      return [];
    }

    if (!(await this.canResolve(result))) return [];

    let job: DebridJob;
    try {
      job = await this.createJob(result);
      if (!job?.id || !job.status) return [];
      if (job.status === "failed") return [];
      if (job.status !== "ready") {
        const readyJob = await this.waitForReady(job.id);
        if (!readyJob) return [];
        job = readyJob;
      }
    } catch {
      throw new Error("External source is unavailable");
    }

    if (!job || job.status !== "ready") return [];

    const matches = (job.files || [])
      .map((file) => sourceFromFile(result, file))
      .filter((source): source is PlayableSource => Boolean(source));

    const unique = new Map(matches.map((source) => [source.id, source]));
    return [...unique.values()];
  }

  async test() {
    try {
      await this.driver().test();
      return { ok: true, message: this.isRealDebrid() ? "Real-Debrid is reachable and authenticated" : "External cloud source is reachable" };
    } catch (error) {
      // Map Real-Debrid auth failures to the normalized state so the admin UI
      // shows "authentication failed" rather than a generic error.
      if (error instanceof Error && /authentication failed/i.test(error.message)) {
        throw new Error("External source authentication failed");
      }
      throw error;
    }
  }

  async fetchStream(source: PlayableSource, range?: string) {
    const url = validatedSourceUrl(source.id, this.config().baseUrl);
    if (!url) throw new Error("External source is unavailable");

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.config().token}`,
        ...(range ? { Range: range } : {}),
      },
    });
    if (!response.ok) throw new Error("External source is unavailable");

    const contentType = response.headers.get("content-type") || "";
    if (!/^(audio\/|application\/octet-stream)/i.test(contentType)) {
      throw new Error("External source is unavailable");
    }

    return { body: response.body, status: response.status, headers: response.headers };
  }
}

export function createDebridCloudSourcePlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "debrid-cloud-source",
      name: "External Cloud Source",
      version: "1.0.0",
      description: "Resolves cloud-download media (e.g. magnets found by the Website Scraper) through a configured debrid provider and streams the audio back. Supports Real-Debrid (set base URL to https://api.real-debrid.com/rest/1.0 with a private API token) or any compatible debrid service exposing MusicDeck's /v1 job API.",
      capabilities: ["source"],
      permissions: ["network.request", "external-source.play", "playback.start"],
      config: {
        fields: [
          { key: "baseUrl", label: "Provider base URL (Real-Debrid: https://api.real-debrid.com/rest/1.0)", required: true },
          { key: "accessToken", label: "Access token", secret: true, required: true },
        ],
      },
    },
    register(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      const provider = new DebridCloudSourceProvider(context, fetchImpl);
      context.sources?.register(provider);
      provider.registerResolver();
    },
    async test(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      return new DebridCloudSourceProvider(context, fetchImpl).test();
    },
  };
}
