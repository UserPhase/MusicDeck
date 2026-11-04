import type { Available } from "./catalog.js";
import type { Album, Track } from "../types.js";
import { deriveCanonicalIdentity } from "./music-identity.js";
import { toTrackSearchResult } from "./search.js";

export type LibraryHealthIssueType =
  | "missing-artwork"
  | "missing-metadata"
  | "missing-artist"
  | "missing-album"
  | "duplicate-track"
  | "duplicate-album"
  | "unavailable"
  | "incomplete-album"
  | "album-not-listed"
  | "orphaned-track";

export type LibraryHealthIssue = {
  type: LibraryHealthIssueType;
  itemType: "track" | "album" | "artist";
  itemId: string;
  title: string;
  detail: string;
};

export type LibraryHealthCounts = {
  missingArtwork: number;
  metadataIssues: number;
  duplicates: number;
  unavailable: number;
  incompleteAlbums: number;
  syncMismatches: number;
  orphanedTracks: number;
};

export class LibraryHealthAuditCancelled extends Error {
  constructor() {
    super("The library health check was cancelled.");
  }
}

export type CatalogAuditOptions = {
  /** Yield to the event loop after this many items (0 disables yielding). */
  yieldEvery?: number;
  /** Reports items processed so far in this audit. */
  onProgress?: (processed: number) => void;
  isCancelled?: () => boolean;
  /**
   * Only a complete album listing can prove an album is missing on the
   * server; capped listings must leave this off to avoid false positives.
   */
  albumsComplete?: boolean;
};

const METADATA_TYPES = new Set<LibraryHealthIssueType>(["missing-metadata", "missing-artist", "missing-album"]);

export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Two passes over tracks (checks, duplicate grouping) plus one over albums. */
export function catalogAuditWork(trackCount: number, albumCount: number) {
  return trackCount * 2 + albumCount;
}

/**
 * Catalog-level checks shared by the user health summary and the admin scan.
 * The loop yields periodically so large libraries never block the server.
 */
export async function auditCatalog(
  tracks: ReadonlyArray<Available<Track>>,
  albums: ReadonlyArray<Available<Album>>,
  options: CatalogAuditOptions = {}
): Promise<LibraryHealthIssue[]> {
  const yieldEvery = options.yieldEvery ?? 0;
  let processed = 0;
  const tick = async () => {
    processed += 1;
    if (!yieldEvery || processed % yieldEvery !== 0) return;
    options.onProgress?.(processed);
    await yieldToEventLoop();
    if (options.isCancelled?.()) throw new LibraryHealthAuditCancelled();
  };

  const issues: LibraryHealthIssue[] = [];
  const trackCounts = new Map<string, number>();
  const albumIds = new Set(albums.map((album) => album.id));

  for (const track of tracks) {
    if (!track.artworkId) issues.push({ type: "missing-artwork", itemType: "track", itemId: track.id, title: track.title, detail: "Missing artwork" });
    if (!track.title) issues.push({ type: "missing-metadata", itemType: "track", itemId: track.id, title: "Untitled", detail: "Missing title" });
    if (!track.artistId || !track.artistName) issues.push({ type: "missing-artist", itemType: "track", itemId: track.id, title: track.title, detail: "Missing artist" });
    if (!track.albumId || !track.albumName) issues.push({ type: "missing-album", itemType: "track", itemId: track.id, title: track.title, detail: "Missing album" });
    if (track.availability.state === "unavailable") issues.push({ type: "unavailable", itemType: "track", itemId: track.id, title: track.title, detail: "Unavailable" });
    if (options.albumsComplete && track.albumId && !albumIds.has(track.albumId)) {
      issues.push({
        type: "album-not-listed",
        itemType: "track",
        itemId: track.id,
        title: track.title,
        detail: `Album "${track.albumName || "Unknown"}" is missing from the server's album list`,
      });
    }
    if (track.albumId) trackCounts.set(track.albumId, (trackCounts.get(track.albumId) || 0) + 1);
    await tick();
  }

  const trackGroups = new Map<string, Available<Track>[]>();
  for (const track of tracks) {
    const key = deriveCanonicalIdentity(toTrackSearchResult(track)).id;
    const group = trackGroups.get(key) || [];
    group.push(track);
    trackGroups.set(key, group);
    await tick();
  }
  for (const group of trackGroups.values()) {
    if (group.length < 2) continue;
    for (const track of group) {
      issues.push({ type: "duplicate-track", itemType: "track", itemId: track.id, title: track.title, detail: "Possible duplicate" });
    }
  }

  for (const album of albums) {
    if (!album.artworkId) issues.push({ type: "missing-artwork", itemType: "album", itemId: album.id, title: album.name, detail: "Missing artwork" });
    if (!album.artistId || !album.artistName) issues.push({ type: "missing-artist", itemType: "album", itemId: album.id, title: album.name, detail: "Missing artist" });
    if (album.availability.state === "unavailable") issues.push({ type: "unavailable", itemType: "album", itemId: album.id, title: album.name, detail: "Unavailable" });
    const count = trackCounts.get(album.id) || 0;
    if (album.songCount > 0 && count > 0 && count < album.songCount) {
      issues.push({ type: "incomplete-album", itemType: "album", itemId: album.id, title: album.name, detail: `${count} / ${album.songCount} tracks available` });
    }
    await tick();
  }

  options.onProgress?.(processed);
  return issues;
}

export function countIssues(issues: ReadonlyArray<LibraryHealthIssue>): LibraryHealthCounts {
  const counts: LibraryHealthCounts = {
    missingArtwork: 0,
    metadataIssues: 0,
    duplicates: 0,
    unavailable: 0,
    incompleteAlbums: 0,
    syncMismatches: 0,
    orphanedTracks: 0,
  };
  for (const issue of issues) {
    if (issue.type === "missing-artwork") counts.missingArtwork += 1;
    else if (METADATA_TYPES.has(issue.type)) counts.metadataIssues += 1;
    else if (issue.type === "duplicate-track" || issue.type === "duplicate-album") counts.duplicates += 1;
    else if (issue.type === "unavailable") counts.unavailable += 1;
    else if (issue.type === "orphaned-track") counts.orphanedTracks += 1;
    if (issue.type === "incomplete-album") counts.incompleteAlbums += 1;
    if (issue.type === "incomplete-album" || issue.type === "album-not-listed") counts.syncMismatches += 1;
  }
  return counts;
}
