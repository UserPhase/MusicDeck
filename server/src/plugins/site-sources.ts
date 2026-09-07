import type { MusicDeckPlugin, MusicDeckPluginContext } from "./plugin-registry.js";
import type {
  AcquisitionInputs,
  CandidateResolver,
  SourceCandidate,
  SourceContainerProvider,
  SourceDetailProvider,
  SourceDiscoveryOptions,
  SourceDiscoveryProvider,
} from "../domain/source-discovery.js";
import { isAlbumContainer, validatedPlayableUrl } from "../domain/source-discovery.js";
import type { PlayableSource } from "../domain/playable-sources.js";
import type { UnifiedSearchResult } from "../domain/search.js";
import { normalizeMusicText } from "../domain/music-identity.js";

export type SiteResultStrategy = "direct-files" | "detail-page" | "container" | "item-files" | "auto";

export type SiteInputMode = "text" | "spotify-url" | "either";

/**
 * Generic website source discovery. Each allowed site is described by a
 * declarative definition so additional sites can be added through plugin
 * configuration without new code. Sites must permit this access; MusicDeck
 * only reads public search pages/APIs and never bypasses authentication or
 * access controls.
 */
export type SiteSourceDefinition = {
  id: string;
  name: string;
  baseUrl: string;
  /** Search path containing the {query}, {spotifyUrl}, or {spotifyId} placeholder, e.g. "/search?q={query}". */
  searchPath: string;
  responseType: "html" | "json";
  resultStrategy?: SiteResultStrategy;
  inputMode?: SiteInputMode;
  spotifySearchPath?: string;
  detailPath?: string;
  /** True when searchPath was auto-guessed from a bare URL rather than given
   * explicitly; guessed paths are probed and fall back automatically. */
  guessedSearchPath?: boolean;
  /** Remembered working template after successful probing. */
  workingSearchPath?: string;
  /** Declarative JSON or HTML field selectors/keys for custom site definitions. */
  selectors?: {
    resultKey?: string;
    urlKey?: string;
    titleKey?: string;
    artistKey?: string;
    albumKey?: string;
    durationKey?: string;
    codecKey?: string;
    detailUrlKey?: string;
    filesKey?: string;
    containerIdKey?: string;
  };
};

const MEDIA_EXTENSIONS = ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "alac"];
const LOSSLESS = new Set(["flac", "wav", "alac"]);

const ANCHOR_TAG_REGEX = /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>([\s\S]*?)<\/a>/gi;
const RAW_MAGNET_REGEX = /magnet:\?xt=urn:[a-zA-Z0-9:]+[^"'\s<>]+/gi;
const RAW_MEDIA_REGEX = /https:\/\/[^"'\s<>]+\.(mp3|flac|m4a|aac|ogg|opus|wav|alac)(?:\?[^"'\s<>]*)?/gi;

/** Search path patterns tried in order when a bare site URL is pasted. The
 * conventional /search?q= guess is attempted first, then the common
 * Torrentio-style /search.php?q= and path-based variants. */
const SEARCH_PATH_GUESSES = [
  "/search?q={query}",
  "/search.php?q={query}",
  "/search/{query}",
];

export const DEFAULT_SEARCH_HEADERS: Record<string, string> = {
  "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "MusicDeck/1.0.0",
};

export type SiteDiscoveryFailure =
  | "http_forbidden"
  | "http_not_found"
  | "http_server_error"
  | "timeout"
  | "network_error"
  | "parse_error"
  | "no_results";

export type SiteDiscoveryStatus =
  | "success"
  | SiteDiscoveryFailure
  | "http_failure"
  | "unsupported_response"
  | "parsing_failure"
  | "blocked"
  | "misconfigured";

export type SiteDiscoveryDiagnostic = {
  siteId: string;
  siteName: string;
  searchUrl: string;
  status: SiteDiscoveryStatus;
  failure?: SiteDiscoveryFailure;
  httpStatus?: number;
  responseType: "html" | "json";
  candidateCount: number;
  mediaLinksFound?: number;
  magnetLinksFound?: number;
  candidatesAfterRelevance?: number;
  errorCode?: string;
  errorMessage?: string;
  attemptedPaths?: Array<{
    path: string;
    url: string;
    httpStatus?: number;
    error?: string;
  }>;
};

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL | string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 4000, ...fetchOptions } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchImpl(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return res;
  } catch (err: any) {
    if (timedOut || err?.name === "AbortError" || err?.name === "TimeoutError" || /timeout/i.test(err?.message || "")) {
      const timeoutErr = new Error("Request timed out");
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function isSpaAppShell(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return /<div\s+id=["'](?:root|app|__next|app-root)["']/i.test(html)
    || (/<script\b[^>]*src=/i.test(html) && !/<a\b/i.test(html));
}

export function decodeHtmlEntities(value: string): string {
  if (!value || typeof value !== "string") return "";
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#([0-9]{1,7});/g, (_, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    });
}

function codecFor(url: string) {
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(url);
  const extension = match?.[1]?.toLowerCase();
  if (!extension || !MEDIA_EXTENSIONS.includes(extension)) {
    return null;
  }
  return { extension, codec: extension.toUpperCase(), lossless: LOSSLESS.has(extension) };
}

function isPrivateHostname(hostname: string) {
  return hostname === "localhost"
    || hostname === "::1"
    || hostname.endsWith(".local")
    || hostname.startsWith("127.")
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || hostname.startsWith("169.254.");
}

export function validateSiteBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || isPrivateHostname(url.hostname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseFileName(url: string) {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  const file = decodeURIComponent(pathname.split("/").pop() || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .trim();
  if (!file) {
    return {};
  }

  const segments = file.split(/\s+-\s+/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length >= 2) {
    return { artist: segments[0], title: segments[segments.length - 1] };
  }
  return { title: file };
}

function parseMagnetDisplayName(magnetUrl: string): { title?: string; artist?: string } {
  const dnMatch = /[?&]dn=([^&]+)/.exec(magnetUrl);
  if (!dnMatch) return {};

  const decoded = decodeHtmlEntities(decodeURIComponent(dnMatch[1].replace(/\+/g, " ")));
  // Strip tags like [FLAC], [320kbps], etc.
  const cleaned = decoded.replace(/\[[^\]]+\]|\([^)]*(?:FLAC|320|kbps|MP3)[^)]*\)/gi, "").trim();
  const segments = cleaned.split(/\s+-\s+|\s+_\s+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    return { artist: segments[0], title: segments[segments.length - 1] };
  }
  return { title: cleaned || decoded };
}

function cleanAudioTags(value: string): string {
  if (!value || typeof value !== "string") return "";
  return value.replace(/\[[^\]]+\]|\([^)]*(?:FLAC|320|kbps|MP3|lossless|24bit|96khz|audio|wav|aac|m4a)[^)]*\)/gi, "").trim();
}

export function isGenericAnchorText(text: string): boolean {
  if (!text || typeof text !== "string") return true;
  const clean = text.trim().toLowerCase();
  if (clean.length <= 2) return true;
  return /^(?:download|get|stream|play|listen|magnet|torrent|file|direct link|direct|mirror|link|audio|mp3|flac|wav|aac|ogg|opus|m4a|click here|here|download now|open)$/i.test(clean)
    || /^(?:download|get|stream|play|listen|open)\s+(?:now|here|file|audio|link|torrent|magnet|mp3|flac|wav|track|song|media)$/i.test(clean)
    || /^(?:direct\s+download|torrent\s+file|magnet\s+link|audio\s+file)$/i.test(clean);
}

function toCandidate(site: SiteSourceDefinition, raw: {
  url?: unknown;
  detailUrl?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  duration?: unknown;
  durationSeconds?: unknown;
  kind?: SourceCandidate["kind"];
  container?: SourceCandidate["container"];
  metadata?: Record<string, unknown>;
  acquisitionInputs?: AcquisitionInputs;
}): SourceCandidate | null {
  const isDetail = Boolean(raw.detailUrl) || site.resultStrategy === "detail-page";
  const targetUrl = typeof raw.url === "string" ? raw.url : typeof raw.detailUrl === "string" ? raw.detailUrl : undefined;
  if (!targetUrl) {
    return null;
  }

  const isMagnet = targetUrl.startsWith("magnet:");
  let url: string;
  if (isMagnet) {
    url = targetUrl;
  } else {
    try {
      url = new URL(targetUrl, site.baseUrl).toString();
    } catch {
      return null;
    }
  }

  const quality = isMagnet ? null : codecFor(url);
  const fromName = isMagnet ? parseMagnetDisplayName(url) : parseFileName(url);
  const rawTitle = typeof raw.title === "string" && raw.title.trim() && !isGenericAnchorText(raw.title) ? raw.title.trim() : undefined;
  const rawArtist = typeof raw.artist === "string" && raw.artist.trim() && !isGenericAnchorText(raw.artist) ? raw.artist.trim() : undefined;
  const title = rawTitle || fromName.title;
  const artist = rawArtist || fromName.artist;
  const album = typeof raw.album === "string" && raw.album.trim() ? raw.album.trim() : undefined;
  const duration = Number(raw.durationSeconds ?? raw.duration);

  if (!isMagnet && !quality && !isDetail && site.resultStrategy !== "container") {
    return null;
  }

  const kind = raw.kind || (isDetail ? "detail-link" : site.resultStrategy === "container" ? "album-container" : isMagnet ? "release-container" : "track");

  return {
    id: `${site.id}:${url}`,
    provider: site.id,
    kind,
    title,
    artist,
    album,
    container: raw.container,
    detailUrl: isDetail || raw.detailUrl ? (typeof raw.detailUrl === "string" ? new URL(raw.detailUrl, site.baseUrl).toString() : url) : undefined,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    metadata: {
      ...(!isMagnet ? { acquisitionUrl: url } : {}),
      ...(raw.acquisitionInputs ? { acquisitionInputs: raw.acquisitionInputs } : {}),
      ...(raw.metadata || {}),
    },
    ...(quality ? {
      quality: {
        codec: quality.codec,
        lossless: quality.lossless,
      },
    } : {}),
  };
}

/** Conservative text relevance pre-filter before the pipeline's strict
 * candidate matching. A site result must contain the normalized track title
 * to become a candidate at all; exact recording identity is still enforced
 * downstream by matchesCandidate. A magnet whose display name is the album
 * (not the track) is also relevant: the debrid resolver enumerates the
 * contained files and selects only the matching track, so we keep it when
 * the candidate carries a matching artist AND album. */
function relevant(result: UnifiedSearchResult, candidate: SourceCandidate) {
  if (candidate.metadata?.acquisitionInputs?.spotifyTrackUrl) {
    return true;
  }
  const title = normalizeMusicText(result.title);
  if (!title) {
    return false;
  }
  const candidateTitle = normalizeMusicText(candidate.title);
  if (candidateTitle === title || candidateTitle.includes(title) || title.includes(candidateTitle)) {
    return true;
  }
  if (candidate.kind === "detail-link" || candidate.kind === "album-container" || candidate.kind === "release-container" || candidate.kind === "item") {
    const artist = normalizeMusicText(result.artist);
    const album = normalizeMusicText(result.album);
    const candidateArtist = normalizeMusicText(candidate.artist);
    const candidateAlbum = normalizeMusicText(candidate.album);
    if (artist && candidateArtist && (candidateArtist === artist || candidateArtist.includes(artist) || artist.includes(candidateArtist))) {
      if (!album || !candidateAlbum || candidateAlbum === album || candidateTitle === album) {
        return true;
      }
    }
  }
  return isAlbumContainer(result, candidate);
}

export function extractJsonCandidates(
  site: SiteSourceDefinition,
  payload: unknown,
  acquisitionInputs?: AcquisitionInputs
): SourceCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any).results)
      ? (payload as any).results
      : Array.isArray((payload as any).data)
        ? (payload as any).data
        : Array.isArray((payload as any).items)
          ? (payload as any).items
          : Array.isArray((payload as any).torrents)
            ? (payload as any).torrents
            : [];

  const candidates: SourceCandidate[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    // Direct files array in row
    const nestedFiles = row.files ?? (site.selectors?.filesKey ? row[site.selectors.filesKey] : undefined);
    if (Array.isArray(nestedFiles) && nestedFiles.length > 0) {
      const containerTitle = row.title ?? row.name;
      const containerArtist = row.artist ?? row.artistName;
      const containerAlbum = row.album ?? row.albumName ?? containerTitle;
      const containerId = `${site.id}:${row.id ?? row.url ?? containerTitle}`;

      for (const file of nestedFiles) {
        if (!file || typeof file !== "object") continue;
        const fileUrl = file.url ?? file.downloadUrl ?? file.streamUrl ?? file.link;
        if (!fileUrl) continue;
        const cand = toCandidate(site, {
          url: fileUrl,
          title: file.title ?? file.name,
          artist: file.artist ?? file.artistName ?? containerArtist,
          album: file.album ?? file.albumName ?? containerAlbum,
          durationSeconds: file.durationSeconds ?? file.duration ?? (file.duration_ms ? Math.round(file.duration_ms / 1000) : undefined),
          kind: "file",
          acquisitionInputs,
          container: {
            id: containerId,
            title: containerTitle,
            artist: containerArtist,
            album: containerAlbum,
          },
        });
        if (cand) {
          candidates.push(cand);
        }
      }
      continue;
    }

    const detailUrl = row.detailUrl ?? (site.selectors?.detailUrlKey ? row[site.selectors.detailUrlKey] : undefined) ?? (site.detailPath && row.id ? site.detailPath.replace("{id}", row.id) : undefined);
    const mediaUrl = row.url ?? row.downloadUrl ?? row.streamUrl ?? row.magnet ?? row.link ?? (site.selectors?.urlKey ? row[site.selectors.urlKey] : undefined);

    const candidate = toCandidate(site, {
      url: mediaUrl || detailUrl,
      detailUrl,
      title: row.title ?? row.name ?? (site.selectors?.titleKey ? row[site.selectors.titleKey] : undefined),
      artist: row.artist ?? row.artistName ?? (site.selectors?.artistKey ? row[site.selectors.artistKey] : undefined),
      album: row.album ?? row.albumName ?? (site.selectors?.albumKey ? row[site.selectors.albumKey] : undefined),
      durationSeconds: row.durationSeconds ?? row.duration ?? (row.duration_ms ? Math.round(row.duration_ms / 1000) : undefined) ?? (site.selectors?.durationKey ? row[site.selectors.durationKey] : undefined),
      kind: detailUrl && !mediaUrl ? (site.resultStrategy === "container" ? "album-container" : "detail-link") : undefined,
      acquisitionInputs,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export type ExtractedHtmlResult = {
  candidates: SourceCandidate[];
  mediaLinksFound: number;
  magnetLinksFound: number;
};

export function extractHtmlCandidatesDetailed(
  site: SiteSourceDefinition,
  rawHtml: string,
  acquisitionInputs?: AcquisitionInputs
): ExtractedHtmlResult {
  const html = decodeHtmlEntities(rawHtml);
  const candidates: SourceCandidate[] = [];
  let mediaLinksFound = 0;
  let magnetLinksFound = 0;

  // 1. Extract all anchor tags with href, title, and inner text
  ANCHOR_TAG_REGEX.lastIndex = 0;
  for (const match of html.matchAll(ANCHOR_TAG_REGEX)) {
    const attrs = `${match[1]} ${match[3]}`;
    const href = decodeHtmlEntities(match[2].trim());
    const innerText = decodeHtmlEntities(match[4].replace(/<[^>]+>/g, " ").trim());
    const titleAttrMatch = /title=["']([^"']+)["']/i.exec(attrs);
    const titleAttr = titleAttrMatch ? decodeHtmlEntities(titleAttrMatch[1].trim()) : "";

    if (href.startsWith("magnet:")) {
      magnetLinksFound++;
      const fromDn = parseMagnetDisplayName(href);
      let parsedTitle = fromDn.title;
      let parsedArtist = fromDn.artist;
      const nameText = innerText && !innerText.startsWith("magnet:") ? innerText : titleAttr;

      if (nameText && !isGenericAnchorText(nameText)) {
        const segments = nameText.split(/\s+-\s+|\s+_\s+/).map((s) => s.trim()).filter(Boolean);
        if (segments.length >= 2) {
          parsedArtist = segments[0];
          parsedTitle = segments[segments.length - 1];
        } else if (!fromDn.title) {
          parsedTitle = nameText;
        }
      }

      const candidate = toCandidate(site, {
        url: href,
        title: parsedTitle,
        artist: parsedArtist,
        acquisitionInputs,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    } else if (codecFor(href)) {
      mediaLinksFound++;
      const fromFile = parseFileName(href);
      let parsedTitle = fromFile.title;
      let parsedArtist = fromFile.artist;
      const nameText = innerText || titleAttr;

      const cleanedName = cleanAudioTags(nameText);
      if (cleanedName && !isGenericAnchorText(nameText)) {
        const segments = cleanedName.split(/\s+-\s+|\s+_\s+/).map((s) => s.trim()).filter(Boolean);
        if (segments.length >= 2) {
          parsedArtist = cleanAudioTags(segments[0]);
          parsedTitle = cleanAudioTags(segments[segments.length - 1]);
        } else {
          parsedTitle = cleanedName;
        }
      }

      const candidate = toCandidate(site, {
        url: href,
        title: parsedTitle,
        artist: parsedArtist,
        acquisitionInputs,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  // 2. Extract raw magnet URLs in HTML body
  RAW_MAGNET_REGEX.lastIndex = 0;
  for (const match of html.matchAll(RAW_MAGNET_REGEX)) {
    const magnet = decodeHtmlEntities(match[0].trim());
    magnetLinksFound++;
    const fromDn = parseMagnetDisplayName(magnet);
    const candidate = toCandidate(site, {
      url: magnet,
      title: fromDn.title,
      artist: fromDn.artist,
      acquisitionInputs,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  // 3. Extract direct audio URLs in HTML body
  RAW_MEDIA_REGEX.lastIndex = 0;
  for (const match of html.matchAll(RAW_MEDIA_REGEX)) {
    const mediaUrl = decodeHtmlEntities(match[0].trim());
    mediaLinksFound++;
    const candidate = toCandidate(site, { url: mediaUrl, acquisitionInputs });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return { candidates, mediaLinksFound, magnetLinksFound };
}

export function extractHtmlCandidates(
  site: SiteSourceDefinition,
  rawHtml: string,
  acquisitionInputs?: AcquisitionInputs
): SourceCandidate[] {
  return extractHtmlCandidatesDetailed(site, rawHtml, acquisitionInputs).candidates;
}

export class SiteDiscoveryProvider implements SourceDiscoveryProvider {
  readonly id: string;
  readonly name: string;
  private lastDiagnostic: SiteDiscoveryDiagnostic | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly site: SiteSourceDefinition,
    private readonly fetchImpl: typeof fetch,
    options?: { timeoutMs?: number }
  ) {
    this.id = `site-${site.id}`;
    this.name = site.name;
    this.timeoutMs = options?.timeoutMs ?? 4000;
  }

  getSite(): SiteSourceDefinition {
    return this.site;
  }

  getLastDiagnostic(): SiteDiscoveryDiagnostic | null {
    return this.lastDiagnostic;
  }

  async search(result: UnifiedSearchResult, options?: SourceDiscoveryOptions): Promise<SourceCandidate[]> {
    if (result.type !== "track") {
      return [];
    }

    const base = validateSiteBaseUrl(this.site.baseUrl);
    if (!base) {
      const diag: SiteDiscoveryDiagnostic = {
        siteId: this.site.id,
        siteName: this.site.name,
        searchUrl: this.site.baseUrl || "",
        status: "misconfigured",
        failure: "network_error",
        responseType: this.site.responseType,
        candidateCount: 0,
        errorCode: "MISCONFIGURED",
        errorMessage: "Invalid base URL",
      };
      this.lastDiagnostic = diag;
      console.log(`[SiteDiscovery] Site source failed:\nsite = ${this.site.name}\nurl = ${this.site.baseUrl}\nreason = invalid base URL`);
      const err = new Error(`Site source "${this.site.name}" is misconfigured`);
      (err as any).failure = "network_error";
      (err as any).site = this.site.name;
      throw err;
    }

    const hasSpotifyInput = Boolean(options?.spotifyTrackUrl);
    const requiresSpotify = this.site.inputMode === "spotify-url";
    const supportsSpotify = this.site.inputMode === "spotify-url" || this.site.inputMode === "either" || Boolean(this.site.spotifySearchPath) || this.site.searchPath.includes("{spotifyUrl}") || this.site.searchPath.includes("{spotifyId}");

    if (requiresSpotify && !hasSpotifyInput) {
      console.log(`[SiteDiscovery] site "${this.site.name}" requires Spotify URL input, but no Spotify URL was provided. Skipping.`);
      return [];
    }

    const useSpotifySearch = hasSpotifyInput && supportsSpotify;
    let effectiveTemplate = this.site.searchPath;

    if (useSpotifySearch && this.site.spotifySearchPath) {
      effectiveTemplate = this.site.spotifySearchPath;
    }

    const hasPlaceholder = effectiveTemplate.includes("{query}") || effectiveTemplate.includes("{spotifyUrl}") || effectiveTemplate.includes("{spotifyId}");
    if (!hasPlaceholder) {
      const diag: SiteDiscoveryDiagnostic = {
        siteId: this.site.id,
        siteName: this.site.name,
        searchUrl: this.site.baseUrl || "",
        status: "misconfigured",
        failure: "network_error",
        responseType: this.site.responseType,
        candidateCount: 0,
        errorCode: "MISCONFIGURED",
        errorMessage: "Missing {query}, {spotifyUrl}, or {spotifyId} in search path",
      };
      this.lastDiagnostic = diag;
      console.log(`[SiteDiscovery] Site source failed:\nsite = ${this.site.name}\nurl = ${this.site.baseUrl}\nreason = misconfigured search template`);
      const err = new Error(`Site source "${this.site.name}" is misconfigured`);
      (err as any).failure = "network_error";
      (err as any).site = this.site.name;
      throw err;
    }

    const query = [result.artist, result.title].filter(Boolean).join(" ").trim();
    if (!query && !hasSpotifyInput) {
      return [];
    }

    const spotifyInputs: AcquisitionInputs | undefined = hasSpotifyInput ? {
      spotifyTrackUrl: options!.spotifyTrackUrl,
      spotifyTrackId: options?.spotifyTrackId,
    } : undefined;

    console.log(`[PublicSource]\ndiscovery started\nsearch query = "${query}"${useSpotifySearch ? `\nspotifyUrl = "${options?.spotifyTrackUrl}"` : ""}`);

    const pathsToTry = this.site.workingSearchPath
      ? [this.site.workingSearchPath]
      : this.site.guessedSearchPath
        ? [...new Set([effectiveTemplate, ...SEARCH_PATH_GUESSES])]
        : [effectiveTemplate];

    let response: Response | null = null;
    let workingPath: string | null = null;
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let lastFailure: SiteDiscoveryFailure | undefined;
    let lastUrl = base.toString();
    const attemptLogs: Array<{ path: string; url: string; httpStatus?: number; error?: string }> = [];

    for (let i = 0; i < pathsToTry.length; i++) {
      const path = pathsToTry[i];
      let formattedPath = path;
      if (formattedPath.includes("{spotifyUrl}")) {
        formattedPath = formattedPath.replace("{spotifyUrl}", encodeURIComponent(options?.spotifyTrackUrl || ""));
      }
      if (formattedPath.includes("{spotifyId}")) {
        formattedPath = formattedPath.replace("{spotifyId}", encodeURIComponent(options?.spotifyTrackId || ""));
      }
      if (formattedPath.includes("{query}")) {
        formattedPath = formattedPath.replace("{query}", encodeURIComponent(useSpotifySearch && !formattedPath.includes("{spotifyUrl}") ? (options?.spotifyTrackUrl || query) : query));
      }

      const url = new URL(formattedPath, base);
      lastUrl = url.toString();
      try {
        const candidate = await fetchWithTimeout(this.fetchImpl, url, {
          headers: DEFAULT_SEARCH_HEADERS,
          timeoutMs: this.timeoutMs,
        });
        lastStatus = candidate.status;
        attemptLogs.push({ path, url: url.toString(), httpStatus: candidate.status });

        if (candidate.ok) {
          response = candidate;
          workingPath = path;
          break;
        }

        if (candidate.status === 401 || candidate.status === 403) {
          lastFailure = "http_forbidden";
          lastError = "site rejected request";
          break; // Stop probing on forbidden response
        }

        if (candidate.status === 404) {
          lastFailure = "http_not_found";
          lastError = "search endpoint not found";
        } else if (candidate.status >= 500) {
          lastFailure = "http_server_error";
          lastError = `server error (HTTP ${candidate.status})`;
          break; // Stop on 500 server error
        } else {
          lastFailure = "network_error";
          lastError = `HTTP ${candidate.status}`;
        }
      } catch (err: any) {
        const isTimeout = err?.name === "AbortError" || err?.name === "TimeoutError" || /timeout/i.test(err?.message || "");
        if (isTimeout) {
          lastFailure = "timeout";
          lastError = "request timed out";
          attemptLogs.push({ path, url: url.toString(), error: "timeout" });
          break; // Stop probing on timeout
        } else {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastFailure = "network_error";
          lastError = errMsg;
          attemptLogs.push({ path, url: url.toString(), error: errMsg });
          break; // Stop probing on connection error
        }
      }
    }

    if (pathsToTry.length > 1) {
      const attemptsSummary = attemptLogs.map((a, idx) => `  attempt ${idx + 1}: ${a.path} -> ${a.httpStatus ? a.httpStatus : a.error}`).join("\n");
      console.log(`[SiteDiscovery] site "${this.site.name}" search attempts:\n${attemptsSummary}`);
    }

    if (!response || !response.ok) {
      const failure: SiteDiscoveryFailure = lastFailure || "network_error";
      let diagStatus: SiteDiscoveryStatus = "http_failure";
      let errorCode = "HTTP_FAILURE";

      if (failure === "http_forbidden") {
        diagStatus = "blocked";
        errorCode = "BLOCKED";
      } else if (failure === "http_not_found") {
        diagStatus = "http_failure";
        errorCode = "NOT_FOUND";
      } else if (failure === "timeout") {
        diagStatus = "timeout";
        errorCode = "TIMEOUT";
      } else if (failure === "http_server_error") {
        diagStatus = "http_failure";
        errorCode = `HTTP_${lastStatus || 500}`;
      } else {
        diagStatus = "http_failure";
        errorCode = "NETWORK_ERROR";
      }

      this.lastDiagnostic = {
        siteId: this.site.id,
        siteName: this.site.name,
        searchUrl: lastUrl,
        status: diagStatus,
        failure,
        httpStatus: lastStatus,
        responseType: this.site.responseType,
        candidateCount: 0,
        errorCode,
        errorMessage: lastError || "search endpoint failed",
        attemptedPaths: attemptLogs,
      };

      console.log(
        `[SiteDiscovery] Site source failed:\n` +
        `site = ${this.site.name}\n` +
        `url = ${lastUrl}\n` +
        `status = ${lastStatus || "N/A"}\n` +
        `failure = ${failure}\n` +
        `reason = ${lastError || "search endpoint failed"}`
      );

      const err = new Error(`Site source "${this.site.name}" is unavailable: ${lastError || "search endpoint failed"}`);
      (err as any).failure = failure;
      (err as any).httpStatus = lastStatus;
      (err as any).site = this.site.name;
      throw err;
    }

    if (workingPath && this.site.guessedSearchPath) {
      this.site.workingSearchPath = workingPath;
    }

    let rawCandidates: SourceCandidate[] = [];
    let mediaLinksFound = 0;
    let magnetLinksFound = 0;

    if (this.site.responseType === "json") {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        const reason = "invalid JSON response";
        this.lastDiagnostic = {
          siteId: this.site.id,
          siteName: this.site.name,
          searchUrl: lastUrl,
          status: "parsing_failure",
          failure: "parse_error",
          httpStatus: response.status,
          responseType: "json",
          candidateCount: 0,
          errorCode: "PARSING_FAILURE",
          errorMessage: reason,
          attemptedPaths: attemptLogs,
        };
        console.log(`[SiteDiscovery] Site source failed:\nsite = ${this.site.name}\nurl = ${lastUrl}\nstatus = ${response.status}\nfailure = parse_error\nreason = ${reason}`);
        const parseErr = new Error(`Site source "${this.site.name}" returned invalid JSON`);
        (parseErr as any).failure = "parse_error";
        (parseErr as any).httpStatus = response.status;
        (parseErr as any).site = this.site.name;
        throw parseErr;
      }

      rawCandidates = extractJsonCandidates(this.site, payload, spotifyInputs);
    } else {
      let rawHtml = "";
      try {
        rawHtml = await response.text();
      } catch {
        const reason = "failed reading HTML response";
        this.lastDiagnostic = {
          siteId: this.site.id,
          siteName: this.site.name,
          searchUrl: lastUrl,
          status: "http_failure",
          failure: "network_error",
          httpStatus: response.status,
          responseType: "html",
          candidateCount: 0,
          errorCode: "READ_ERROR",
          errorMessage: reason,
          attemptedPaths: attemptLogs,
        };
        console.log(`[SiteDiscovery] Site source failed:\nsite = ${this.site.name}\nurl = ${lastUrl}\nstatus = ${response.status}\nfailure = network_error\nreason = ${reason}`);
        const readErr = new Error(`Site source "${this.site.name}" failed reading response`);
        (readErr as any).failure = "network_error";
        (readErr as any).httpStatus = response.status;
        (readErr as any).site = this.site.name;
        throw readErr;
      }

      const extracted = extractHtmlCandidatesDetailed(this.site, rawHtml, spotifyInputs);
      rawCandidates = extracted.candidates;
      mediaLinksFound = extracted.mediaLinksFound;
      magnetLinksFound = extracted.magnetLinksFound;

      if (rawCandidates.length === 0 && isSpaAppShell(rawHtml)) {
        const reason = "site returned HTML but no static search results were found";
        this.lastDiagnostic = {
          siteId: this.site.id,
          siteName: this.site.name,
          searchUrl: lastUrl,
          status: "no_results",
          failure: "no_results",
          httpStatus: response.status,
          responseType: "html",
          candidateCount: 0,
          mediaLinksFound: 0,
          magnetLinksFound: 0,
          candidatesAfterRelevance: 0,
          errorMessage: reason,
          attemptedPaths: attemptLogs,
        };
        console.log(
          `[SiteDiscovery] site = ${this.site.name}\n` +
          `status = 200\n` +
          `responseType = html\n` +
          `mediaLinksFound = 0\n` +
          `magnetLinksFound = 0\n` +
          `candidatesAfterRelevance = 0\n` +
          `reason = ${reason}`
        );
        return [];
      }
    }

    const seen = new Set<string>();
    const matchingCandidates = rawCandidates
      .filter((candidate) => relevant(result, candidate))
      .filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      })
      .slice(0, Math.max(1, Math.min(options?.limit || 10, 25)));

    console.log(
      `[PublicSource]\n` +
      `search URL = ${lastUrl}\n` +
      `search status = ${response?.status || 200}\n` +
      `response type = ${this.site.responseType}\n` +
      `raw results = ${rawCandidates.length}\n` +
      `candidates before filtering = ${rawCandidates.length}\n` +
      `candidates after filtering = ${matchingCandidates.length}`
    );

    console.log(
      `[SiteDiscovery] site = ${this.site.name}\n` +
      `status = ${response?.status || 200}\n` +
      `responseType = ${this.site.responseType}\n` +
      `mediaLinksFound = ${mediaLinksFound}\n` +
      `magnetLinksFound = ${magnetLinksFound}\n` +
      `candidatesAfterRelevance = ${matchingCandidates.length}`
    );

    if (matchingCandidates.length > 0) {
      this.lastDiagnostic = {
        siteId: this.site.id,
        siteName: this.site.name,
        searchUrl: lastUrl,
        status: "success",
        httpStatus: response.status,
        responseType: this.site.responseType,
        candidateCount: matchingCandidates.length,
        mediaLinksFound,
        magnetLinksFound,
        candidatesAfterRelevance: matchingCandidates.length,
        attemptedPaths: attemptLogs,
      };
    } else {
      const reason = rawCandidates.length > 0
        ? `Discovered ${rawCandidates.length} candidate(s), but none matched the requested recording`
        : "No search results found";
      this.lastDiagnostic = {
        siteId: this.site.id,
        siteName: this.site.name,
        searchUrl: lastUrl,
        status: "no_results",
        failure: "no_results",
        httpStatus: response.status,
        responseType: this.site.responseType,
        candidateCount: 0,
        mediaLinksFound,
        magnetLinksFound,
        candidatesAfterRelevance: 0,
        errorMessage: reason,
        attemptedPaths: attemptLogs,
      };
    }

    return matchingCandidates;
  }
}

export class SiteDetailProvider implements SourceDetailProvider {
  readonly id = "site-details";
  readonly name = "Website Detail Resolver";
  private readonly sitesMap: Map<string, SiteSourceDefinition>;

  constructor(
    sites: SiteSourceDefinition | Map<string, SiteSourceDefinition> | SiteSourceDefinition[],
    private readonly fetchImpl: typeof fetch
  ) {
    if (sites instanceof Map) {
      this.sitesMap = sites;
    } else if (Array.isArray(sites)) {
      this.sitesMap = new Map(sites.map((s) => [s.id, s]));
    } else {
      this.sitesMap = new Map([[sites.id, sites]]);
    }
  }

  canResolve(candidate: SourceCandidate): boolean {
    const site = this.sitesMap.get(candidate.provider);
    if (!site) return false;
    return Boolean(candidate.detailUrl) || candidate.kind === "detail-link";
  }

  async resolveDetails(candidate: SourceCandidate): Promise<SourceCandidate[]> {
    const site = this.sitesMap.get(candidate.provider);
    if (!site || !candidate.detailUrl) return [];

    try {
      const url = new URL(candidate.detailUrl, site.baseUrl);
      const res = await fetchWithTimeout(this.fetchImpl, url, {
        headers: DEFAULT_SEARCH_HEADERS,
        timeoutMs: 4000,
      });
      if (!res.ok) return [];

      const contentType = res.headers.get("content-type") || "";
      if (site.responseType === "json" || contentType.includes("json")) {
        const data = await res.json();
        const files = Array.isArray((data as any).files)
          ? (data as any).files
          : Array.isArray((data as any).tracks)
            ? (data as any).tracks
            : Array.isArray((data as any).items)
              ? (data as any).items
              : Array.isArray((data as any).results)
                ? (data as any).results
                : Array.isArray(data)
                  ? data
                  : [];

        const results: SourceCandidate[] = [];
        for (const file of files) {
          const fileUrl = file.url ?? file.downloadUrl ?? file.streamUrl ?? file.link;
          if (!fileUrl) continue;
          const fullUrl = new URL(fileUrl, site.baseUrl).toString();
          const quality = codecFor(fullUrl);
          const title = file.title ?? file.name ?? candidate.title;
          const artist = file.artist ?? file.artistName ?? candidate.artist;
          const album = file.album ?? file.albumName ?? candidate.album;
          const duration = Number(file.durationSeconds ?? file.duration ?? (file.duration_ms ? Math.round(file.duration_ms / 1000) : undefined));

          results.push({
            id: `${site.id}:${fullUrl}`,
            provider: site.id,
            kind: "file",
            title,
            artist,
            album,
            durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
            container: {
              id: candidate.id,
              title: candidate.title,
              artist: candidate.artist,
              album: candidate.album,
            },
            ...(quality ? { quality: { codec: quality.codec, lossless: quality.lossless } } : {}),
          });
        }
        return results;
      } else {
        const rawHtml = await res.text();
        const extracted = extractHtmlCandidatesDetailed(site, rawHtml);
        return extracted.candidates.map((c) => ({
          ...c,
          container: {
            id: candidate.id,
            title: candidate.title,
            artist: candidate.artist,
            album: candidate.album,
          },
        }));
      }
    } catch {
      return [];
    }
  }
}

export class SiteContainerProvider implements SourceContainerProvider {
  readonly id = "site-containers";
  readonly name = "Website Container Enumerator";
  private readonly sitesMap: Map<string, SiteSourceDefinition>;

  constructor(
    sites: SiteSourceDefinition | Map<string, SiteSourceDefinition> | SiteSourceDefinition[],
    private readonly fetchImpl: typeof fetch
  ) {
    if (sites instanceof Map) {
      this.sitesMap = sites;
    } else if (Array.isArray(sites)) {
      this.sitesMap = new Map(sites.map((s) => [s.id, s]));
    } else {
      this.sitesMap = new Map([[sites.id, sites]]);
    }
  }

  canEnumerate(candidate: SourceCandidate): boolean {
    const site = this.sitesMap.get(candidate.provider);
    if (!site) return false;
    return (candidate.kind === "album-container" || candidate.kind === "release-container" || candidate.kind === "item") && Boolean(candidate.detailUrl);
  }

  async enumerate(candidate: SourceCandidate): Promise<SourceCandidate[]> {
    const detailProvider = new SiteDetailProvider(this.sitesMap, this.fetchImpl);
    return detailProvider.resolveDetails(candidate);
  }
}

/**
 * Resolver for candidates that already carry a direct media URL. No remote
 * download service is required for these sources; the playback proxy streams
 * the validated URL.
 */
export class DirectSiteFileResolver implements CandidateResolver {
  readonly id = "site-direct-files";
  readonly name = "Site file";

  canResolve(candidate: SourceCandidate) {
    const value = candidate.id.slice(candidate.id.indexOf(":") + 1);
    return /^https:\/\//.test(value);
  }

  async resolve(candidate: SourceCandidate): Promise<PlayableSource[]> {
    const url = validatedPlayableUrl(candidate.id.slice(candidate.id.indexOf(":") + 1));
    if (!url) {
      return [];
    }

    return [{
      id: url,
      provider: "plugin",
      type: "external",
      mediaType: "audio",
      label: "Site file",
      availability: "available",
      quality: candidate.quality,
    }];
  }
}

export type SiteTestResult = {
  ok: boolean;
  site?: string;
  siteId?: string;
  name?: string;
  baseUrl?: string;
  searchUrl?: string;
  status?: number | string;
  failure?: SiteDiscoveryFailure | "misconfigured";
  candidates?: number;
  candidateCount?: number;
  filesEnumerated?: number;
  message?: string;
};

export async function testSite(
  site: SiteSourceDefinition,
  fetchImpl: typeof fetch,
  testQuery = "MusicDeck"
): Promise<SiteTestResult> {
  const base = validateSiteBaseUrl(site.baseUrl);
  if (!base) {
    return {
      ok: false,
      site: site.name,
      siteId: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      searchUrl: site.baseUrl,
      status: "misconfigured",
      failure: "misconfigured",
      message: "Invalid base URL",
    };
  }

  const pathsToTry = site.workingSearchPath
    ? [site.workingSearchPath]
    : site.guessedSearchPath
      ? [...new Set([site.searchPath, ...SEARCH_PATH_GUESSES])]
      : [site.searchPath];

  let lastStatus: number | undefined;
  let lastUrl = base.toString();
  let lastError: string | undefined;
  let lastFailure: SiteDiscoveryFailure | undefined;

  for (const path of pathsToTry) {
    const url = new URL(path.replace("{query}", encodeURIComponent(testQuery)), base);
    lastUrl = url.toString();
    try {
      const res = await fetchWithTimeout(fetchImpl, url, {
        headers: DEFAULT_SEARCH_HEADERS,
        timeoutMs: 4000,
      });
      lastStatus = res.status;

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          site: site.name,
          siteId: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          searchUrl: url.toString(),
          status: res.status,
          failure: "http_forbidden",
          message: "The site rejected the search request.",
        };
      }

      if (res.ok) {
        if (site.guessedSearchPath) {
          site.workingSearchPath = path;
        }

        if (site.responseType === "json") {
          try {
            const data = await res.json();
            const candidates = extractJsonCandidates(site, data);
            let detailCount = 0;
            if (candidates.length > 0 && candidates[0].detailUrl) {
              const sitesMap = new Map([[site.id, site]]);
              const detailProvider = new SiteDetailProvider(sitesMap, fetchImpl);
              const details = await detailProvider.resolveDetails(candidates[0]);
              detailCount = details.length;
            }

            return {
              ok: true,
              site: site.name,
              siteId: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              searchUrl: url.toString(),
              status: 200,
              candidates: candidates.length,
              candidateCount: candidates.length,
              filesEnumerated: detailCount,
              message: candidates.length > 0
                ? (detailCount > 0
                  ? `Searchable JSON API (${candidates.length} candidate(s), detail resolution: ${detailCount} file(s) enumerated)`
                  : `Searchable JSON API (${candidates.length} candidate(s) found)`)
                : "Searchable JSON API (0 results for test query)",
            };
          } catch {
            return {
              ok: false,
              site: site.name,
              siteId: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              searchUrl: url.toString(),
              status: 200,
              failure: "parse_error",
              message: "Invalid JSON response",
            };
          }
        } else {
          const rawHtml = await res.text();
          const detailed = extractHtmlCandidatesDetailed(site, rawHtml);
          const candidates = detailed.candidates;
          const isJsShell = isSpaAppShell(rawHtml);

          if (candidates.length > 0) {
            return {
              ok: true,
              site: site.name,
              siteId: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              searchUrl: url.toString(),
              status: 200,
              candidates: candidates.length,
              candidateCount: candidates.length,
              message: `Reachable and searchable (${candidates.length} candidate link(s) found)`,
            };
          } else if (isJsShell) {
            return {
              ok: true,
              site: site.name,
              siteId: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              searchUrl: url.toString(),
              status: 200,
              candidates: 0,
              candidateCount: 0,
              message: "Reachable (HTML returned but no static search results found)",
            };
          } else {
            return {
              ok: true,
              site: site.name,
              siteId: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              searchUrl: url.toString(),
              status: 200,
              candidates: 0,
              candidateCount: 0,
              message: "Reachable and searchable (0 results for test query)",
            };
          }
        }
      }

      if (res.status === 404) {
        lastFailure = "http_not_found";
        lastError = "search endpoint not found";
      } else if (res.status >= 500) {
        return {
          ok: false,
          site: site.name,
          siteId: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          searchUrl: url.toString(),
          status: res.status,
          failure: "http_server_error",
          message: `Server error (HTTP ${res.status})`,
        };
      }
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError" || err?.name === "TimeoutError" || /timeout/i.test(err?.message || "");
      if (isTimeout) {
        return {
          ok: false,
          site: site.name,
          siteId: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          searchUrl: url.toString(),
          failure: "timeout",
          message: "Request timed out",
        };
      }
      lastFailure = "network_error";
      lastError = err instanceof Error ? err.message : "Connection failed";
      break;
    }
  }

  // If search endpoints failed, check root reachability
  try {
    const rootRes = await fetchWithTimeout(fetchImpl, base, {
      headers: DEFAULT_SEARCH_HEADERS,
      timeoutMs: 3000,
    });
    if (rootRes.ok) {
      return {
        ok: false,
        site: site.name,
        siteId: site.id,
        name: site.name,
        baseUrl: site.baseUrl,
        searchUrl: lastUrl,
        status: lastStatus || rootRes.status,
        failure: lastFailure || "http_not_found",
        message: `Reachable at root, but search endpoint failed (${lastStatus ? `HTTP ${lastStatus}` : lastError || "no response"})`,
      };
    }
    return {
      ok: false,
      site: site.name,
      siteId: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      searchUrl: lastUrl,
      status: rootRes.status,
      failure: rootRes.status === 403 ? "http_forbidden" : rootRes.status >= 500 ? "http_server_error" : "http_not_found",
      message: `Unavailable (HTTP ${rootRes.status})`,
    };
  } catch (err: any) {
    const isTimeout = err?.name === "AbortError" || err?.name === "TimeoutError" || /timeout/i.test(err?.message || "");
    return {
      ok: false,
      site: site.name,
      siteId: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      searchUrl: lastUrl,
      status: lastStatus,
      failure: isTimeout ? "timeout" : (lastFailure || "network_error"),
      message: isTimeout ? "Request timed out" : (lastError || "Connection failed"),
    };
  }
}

export function parseSiteUrlList(value: unknown): SiteSourceDefinition[] | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const entries = value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    return null;
  }

  const sites: SiteSourceDefinition[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    const url = validateSiteBaseUrl(entry);
    if (!url) {
      return null;
    }

    const id = url.hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const hasTemplate = entry.includes("{query}");
    const parsedPath = `${url.pathname}${url.search}`.replace(/%7Bquery%7D/gi, "{query}");

    sites.push({
      id,
      name: url.hostname,
      baseUrl: `${url.protocol}//${url.host}`,
      searchPath: hasTemplate && parsedPath.includes("{query}") ? parsedPath : SEARCH_PATH_GUESSES[0],
      responseType: "html",
      guessedSearchPath: !(hasTemplate && parsedPath.includes("{query}")),
    });
  }

  return sites.length > 0 ? sites : null;
}

export function parseSiteDefinitions(value: unknown): SiteSourceDefinition[] | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const sites: SiteSourceDefinition[] = [];
    const seenIds = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(item.id)
        || typeof item.name !== "string" || !item.name
        || typeof item.baseUrl !== "string" || !validateSiteBaseUrl(item.baseUrl)
        || typeof item.searchPath !== "string"
        || (item.responseType !== "html" && item.responseType !== "json")) {
        return null;
      }
      const validTemplate = item.searchPath.includes("{query}") || item.searchPath.includes("{spotifyUrl}") || item.searchPath.includes("{spotifyId}") || (typeof item.spotifySearchPath === "string");
      if (!validTemplate) {
        return null;
      }
      const normalizedId = item.id.toLowerCase();
      if (seenIds.has(normalizedId)) {
        continue;
      }
      seenIds.add(normalizedId);
      sites.push({
        id: normalizedId,
        name: item.name,
        baseUrl: item.baseUrl,
        searchPath: item.searchPath,
        responseType: item.responseType,
        resultStrategy: item.resultStrategy,
        inputMode: item.inputMode,
        spotifySearchPath: item.spotifySearchPath,
        detailPath: item.detailPath,
        selectors: item.selectors,
      });
    }

    return sites.length > 0 ? sites : null;
  } catch {
    return null;
  }
}

/** Resolves the sites a Website Scraper installation should use: the simple
 * "paste URLs" field takes priority (auto-configuring id/name/search path
 * for each site), falling back to the advanced JSON field for administrators
 * who need a custom search path or a JSON API instead of HTML scraping.
 * There are no built-in preset sites; the administrator supplies the list. */
export function resolveConfiguredSites(context: MusicDeckPluginContext): SiteSourceDefinition[] {
  const parsed = parseSiteUrlList(context.settings.get("siteUrls"))
    || parseSiteDefinitions(context.settings.get("sites"))
    || [];
  const seen = new Set<string>();
  return parsed.filter((site) => {
    if (seen.has(site.id)) return false;
    seen.add(site.id);
    return true;
  });
}

export function createSiteSourcesPlugin(): MusicDeckPlugin {
  return {
    manifest: {
      id: "site-sources",
      name: "Website Scraper",
      version: "1.0.0",
      description: "Torrentio-style website discovery without preset sites. Paste one or more site/indexer URLs (one per line, or comma-separated) and MusicDeck searches each one for the playing track, collects magnet links and direct audio files, then resolves them — magnets are fetched through the External Cloud Source (debrid) plugin, direct files stream as-is.",
      capabilities: ["source"],
      permissions: ["network.request", "external-source.play"],
      config: {
        fields: [
          {
            key: "siteUrls",
            label: "Website URLs (one per line, e.g. https://audio.com — or include {query} for a custom search URL, e.g. https://indexer.example/search/{query}/1/)",
            required: false,
          },
          {
            key: "sites",
            label: "Advanced: custom site definitions (JSON array)",
            required: false,
          },
        ],
      },
    },
    register(context) {
      const fetchImpl = context.network!.fetch as typeof fetch;
      const sites = resolveConfiguredSites(context);
      const sitesMap = new Map<string, SiteSourceDefinition>();

      for (const site of sites) {
        sitesMap.set(site.id, site);
        context.sourceDiscovery!.register(new SiteDiscoveryProvider(site, fetchImpl));
        context.sourceDiscovery!.configure(`site-${site.id}`, true);
        console.log(`[PublicSource]\nprovider registered = true\nprovider id = site-${site.id}\nprovider enabled = true\ndiscovery provider registered = true`);
      }

      if (sites.length > 0) {
        context.sourceDetail?.register(new SiteDetailProvider(sitesMap, fetchImpl));
        context.sourceContainers?.register(new SiteContainerProvider(sitesMap, fetchImpl));
      }

      context.sourceResolvers!.register(new DirectSiteFileResolver());
      context.sourceResolvers!.configure("site-direct-files", true);
    },
    async test(context) {
      const sites = resolveConfiguredSites(context);
      if (sites.length === 0) {
        return { ok: false, status: "not_configured" as const, message: "No site sources configured" };
      }

      const siteResults: SiteTestResult[] = [];
      const fetchImpl = context.network!.fetch as typeof fetch;

      for (const site of sites) {
        siteResults.push(await testSite(site, fetchImpl));
      }

      const anyOk = siteResults.some((r) => r.ok);
      const allMisconfigured = siteResults.every((r) => r.status === "misconfigured" || r.failure === "misconfigured");
      const allBlocked = siteResults.every((r) => r.status === 403 || r.failure === "http_forbidden");
      const allUnavailable = siteResults.every((r) => r.status === "unavailable" || r.failure === "timeout" || r.failure === "network_error" || r.failure === "http_server_error");

      const topStatus = anyOk
        ? "success"
        : allMisconfigured
          ? "not_configured"
          : allBlocked
            ? "permission_denied"
            : allUnavailable
              ? "provider_unavailable"
              : "plugin_error";

      const firstSite = siteResults[0];
      const summary = siteResults.map((r) => `${r.site || r.name}: ${r.message || (r.ok ? "OK" : r.failure)}`).join("; ");
      return {
        ok: anyOk,
        status: topStatus,
        site: firstSite?.site,
        searchUrl: firstSite?.searchUrl,
        httpStatus: typeof firstSite?.status === "number" ? firstSite.status : undefined,
        failure: firstSite?.failure,
        candidates: siteResults.reduce((acc, r) => acc + (r.candidates ?? r.candidateCount ?? 0), 0),
        candidateCount: siteResults.reduce((acc, r) => acc + (r.candidates ?? r.candidateCount ?? 0), 0),
        message: summary || "Site sources verified",
        details: { sites: siteResults },
      };
    },
  };
}
