import type { DownloadRequest } from "./downloader-adapter.js";
import type { SourceCandidate } from "./source-discovery.js";

export class AcquisitionValidationError extends Error {
  constructor() {
    super("Invalid or unsupported acquisition input");
  }
}

function parsedHttps(raw: string): URL {
  if (raw.length > 2048 || /[\s\\|\x00-\x1f\x7f]/.test(raw) || !raw.startsWith("https://")) {
    throw new AcquisitionValidationError();
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new AcquisitionValidationError(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.endsWith(".")) {
    throw new AcquisitionValidationError();
  }
  return url;
}

export function canonicalSpotifyUrl(raw: string): string {
  const url = parsedHttps(raw);
  if (url.hostname !== "open.spotify.com" || !/^\/(track|album|playlist)\/[a-zA-Z0-9]{1,64}\/?$/.test(url.pathname)) {
    throw new AcquisitionValidationError();
  }
  return `https://open.spotify.com${url.pathname.replace(/\/$/, "")}`;
}

export function canonicalManualAcquisitionUrl(raw: string): string {
  const url = parsedHttps(raw);
  const host = url.hostname;
  const youtube = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
  if (youtube.has(host) || host === "youtu.be" || host === "www.youtu.be") {
    const id = host.endsWith("youtu.be")
      ? url.pathname.slice(1)
      : url.pathname === "/watch" ? url.searchParams.get("v")
        : /^\/(shorts|live|embed)\/[a-zA-Z0-9_-]{1,100}\/?$/.test(url.pathname) ? url.pathname.split("/")[2] : null;
    if (id && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    const playlist = url.searchParams.get("list");
    if (youtube.has(host) && url.pathname === "/playlist" && playlist && /^[a-zA-Z0-9_-]{1,150}$/.test(playlist)) {
      return `https://www.youtube.com/playlist?list=${playlist}`;
    }
    throw new AcquisitionValidationError();
  }
  const soundcloud = ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host);
  const bandcamp = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bandcamp\.com$/.test(host);
  if ((soundcloud && /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+\/?$/.test(url.pathname))
    || (bandcamp && /^\/(track|album)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname))) {
    return `https://${host}${url.pathname}`;
  }
  throw new AcquisitionValidationError();
}

/** Validate every supported field, not just the first field selected by a downloader. */
export function validateCandidateDownloadUrls(candidate: SourceCandidate): void {
  const metadata = candidate.metadata;
  for (const raw of [metadata?.acquisitionUrl, metadata?.downloadUrl, metadata?.fileUrl, candidate.detailUrl]) {
    if (raw !== undefined) {
      if (typeof raw !== "string") throw new AcquisitionValidationError();
      canonicalManualAcquisitionUrl(raw);
    }
  }
  for (const raw of [metadata?.spotifyTrackUrl, metadata?.spotifyUrl, metadata?.acquisitionInputs?.spotifyTrackUrl]) {
    if (raw !== undefined) {
      if (typeof raw !== "string") throw new AcquisitionValidationError();
      canonicalSpotifyUrl(raw);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate.id)) {
    if (candidate.id.startsWith("https://open.spotify.com/")) canonicalSpotifyUrl(candidate.id);
    else canonicalManualAcquisitionUrl(candidate.id);
  }
}

export function validateSpotDLRequest(request: DownloadRequest): void {
  if (request.candidate) validateCandidateDownloadUrls(request.candidate);
  if (request.sourceUrl !== undefined) canonicalManualAcquisitionUrl(request.sourceUrl);
  if (request.spotifyTrackUrl !== undefined) canonicalSpotifyUrl(request.spotifyTrackUrl);
  if (request.spotifyTrackId !== undefined && !/^[a-zA-Z0-9]{1,64}$/.test(request.spotifyTrackId)) {
    throw new AcquisitionValidationError();
  }
  if (request.query !== undefined) {
    const query = request.query.trim();
    if (query.startsWith("https://open.spotify.com/")) canonicalSpotifyUrl(query);
    else if (!query || query.length > 2000 || /^[-/\\.]|[|\x00-\x1f\x7f]|[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|ftp|sftp|data|gopher|spotify):/i.test(query)) {
      throw new AcquisitionValidationError();
    }
  }
}
