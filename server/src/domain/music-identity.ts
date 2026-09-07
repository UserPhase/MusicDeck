import crypto from "node:crypto";

import type { UnifiedSearchResult } from "./search.js";

const DISTINCT_VERSION = /\b(live|remix|radio edit|deluxe|reissue|remaster(?:ed)?|extended|acoustic|instrumental|demo)\b/gi;
const FEATURING_SUFFIX = /(?:\s*\((?:feat\.?|featuring|ft\.?)\s+[^)]*\)|\s*(?:[-,]\s*)?(?:feat\.?|featuring|ft\.?)\s+.+)$/i;

export function normalizeMusicText(value: string | null | undefined): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(FEATURING_SUFFIX, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Preserves meaningful release/recording distinctions in fallback keys. */
export function versionSignature(value: string | null | undefined): string {
  return Array.from((value || "").matchAll(DISTINCT_VERSION))
    .map((match) => normalizeMusicText(match[0]))
    .sort()
    .join("+");
}

function opaqueIdentity(key: string) {
  return `canonical_${crypto.createHash("sha256").update(key).digest("base64url").slice(0, 24)}`;
}

export function deriveCanonicalIdentity(item: UnifiedSearchResult) {
  const hints = item.identityHints;
  const identifier = hints?.musicBrainzId
    ? { strength: "musicbrainz" as const, value: hints.musicBrainzId }
    : item.type === "track" && hints?.isrc
      ? { strength: "isrc" as const, value: hints.isrc }
      : item.type === "album" && hints?.upc
        ? { strength: "upc" as const, value: hints.upc }
        : null;

  if (identifier) {
    return {
      id: opaqueIdentity(`${item.type}:${identifier.strength}:${normalizeMusicText(identifier.value)}`),
      strength: identifier.strength,
    };
  }

  const title = normalizeMusicText(item.title);
  const artist = normalizeMusicText(item.artist);
  const album = normalizeMusicText(item.album);
  const version = versionSignature(`${item.title} ${item.album || ""}`);

  let key: string | null = null;
  if (item.type === "artist" && title) {
    key = `artist:${title}`;
  } else if (item.type === "album" && title && artist) {
    key = `album:${artist}:${title}:${version}`;
  } else if (item.type === "track" && title && artist && album) {
    key = `track:${artist}:${album}:${title}:${version}`;
  }

  if (key) {
    return { id: opaqueIdentity(key), strength: "normalized" as const };
  }

  // No sufficiently safe cross-provider metadata: retain a stable per-result
  // identity rather than risking an incorrect merge.
  return { id: opaqueIdentity(`provider:${item.type}:${item.provider}:${item.id}`), strength: "provider" as const };
}

/**
 * Extracts a normalized track title from a file name or path.
 * Strips directory prefixes, file extension, and leading track/disc numbers.
 * Examples:
 *   "californication/03-Scar Tissue.flac" -> "Scar Tissue"
 *   "03 - Scar Tissue.flac" -> "Scar Tissue"
 *   "1-03. Scar Tissue.mp3" -> "Scar Tissue"
 *   "CD1-03 Scar Tissue.flac" -> "Scar Tissue"
 */
export function extractTrackTitleFromPath(filePath: string, artist?: string): string {
  if (!filePath || typeof filePath !== "string") return "";
  const fileName = filePath.split("/").pop() || filePath;
  const baseName = fileName.replace(/\.[a-z0-9]+(?:$|\?)/i, "").trim();
  let withoutPrefix = baseName
    .replace(/^(?:(?:cd|disc|d)?\d+[-._ ]+)?\d+[\s._-]+/i, "")
    .replace(/^(?:[a-d]\d+|\d+)[\s._-]+/i, "");

  if (artist) {
    const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    withoutPrefix = withoutPrefix.replace(new RegExp(`^${escapedArtist}\\s*-\\s*`, "i"), "");
  }
  return withoutPrefix.trim() || baseName;
}

export type ContainerFileMetadata = {
  path?: string;
  name?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
};

/**
 * Reusable container file matching against a requested target track.
 * Checks normalized title equality, artist/title combinations in filenames,
 * version protection, and duration tolerance.
 */
export function matchContainerFile(
  target: UnifiedSearchResult,
  file: ContainerFileMetadata
): boolean {
  const filePath = file.path || file.name || "";
  const extractedTitle = extractTrackTitleFromPath(filePath);
  const fileTitle = file.title || extractedTitle;

  const requestedTitle = normalizeMusicText(target.title);
  const normalizedFileTitle = normalizeMusicText(fileTitle);
  const normalizedExtractedTitle = normalizeMusicText(extractedTitle);
  const rawBaseName = (filePath.split("/").pop() || filePath).replace(/\.[a-z0-9]+(?:$|\?)/i, "");
  const normalizedRawName = normalizeMusicText(rawBaseName);

  if (!requestedTitle) return false;

  // Version check (remix, live, acoustic, etc.)
  const requestedVersion = versionSignature(target.title);
  const fileVersion = versionSignature(file.title || rawBaseName || filePath);
  if (requestedVersion !== fileVersion) {
    return false;
  }

  // Artist check if present
  const requestedArtist = normalizeMusicText(target.artist);
  const fileArtist = normalizeMusicText(file.artist || "");
  if (requestedArtist && fileArtist) {
    const artistMatches = fileArtist === requestedArtist
      || fileArtist.includes(requestedArtist)
      || requestedArtist.includes(fileArtist)
      || normalizedRawName.includes(requestedArtist);
    if (!artistMatches) {
      return false;
    }
  }

  // Title matching:
  // 1. Exact normalized fileTitle or extractedTitle
  const exactTitleMatch = normalizedFileTitle === requestedTitle
    || normalizedExtractedTitle === requestedTitle;

  // 2. Artist + Title in filename (e.g. "Red Hot Chili Peppers - Scar Tissue")
  const artistTitleMatch = Boolean(
    requestedArtist && (
      normalizedExtractedTitle === `${requestedArtist} ${requestedTitle}` ||
      normalizedRawName === `${requestedArtist} ${requestedTitle}` ||
      normalizedFileTitle === `${requestedArtist} ${requestedTitle}`
    )
  );

  let titleMatches = exactTitleMatch || artistTitleMatch;

  if (!titleMatches) {
    // Check if extracted title starts or ends with requested title cleanly
    if (
      normalizedExtractedTitle.startsWith(`${requestedTitle} `) ||
      normalizedExtractedTitle.endsWith(` ${requestedTitle}`) ||
      (normalizedFileTitle && (
        normalizedFileTitle.startsWith(`${requestedTitle} `) ||
        normalizedFileTitle.endsWith(` ${requestedTitle}`)
      ))
    ) {
      titleMatches = true;
    }
  }

  if (!titleMatches) {
    return false;
  }

  // Duration check if available (tolerance 20s)
  const requestedDuration = Number(target.metadata?.durationSeconds || 0);
  const fileDuration = file.durationSeconds;
  if (requestedDuration > 0 && fileDuration && fileDuration > 0) {
    if (Math.abs(fileDuration - requestedDuration) > 20) {
      return false;
    }
  }

  return true;
}

