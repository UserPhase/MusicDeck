import type { UnifiedSearchResult } from "./search.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";

/**
 * Merges MusicDeck's local library reads with the existing (iTunes-backed)
 * external catalog to keep known-but-undownloaded tracks/albums visible on
 * album/artist detail pages instead of silently disappearing once any track
 * from the same album/artist has been downloaded locally.
 *
 * Matching is conservative: normalized title + preserved version signature
 * (live/remix/acoustic/etc, see music-identity.ts) so a remaster/live take is
 * never merged into the wrong local recording. When no safe match is found,
 * the catalog entry is treated as a new, still-visible, undownloaded item —
 * never silently dropped, never fabricated beyond what the catalog reported.
 */

function titleKey(title: string | null | undefined): string {
  return `${normalizeMusicText(title)}|${versionSignature(title || "")}`;
}

/**
 * Combine local (already-playable) tracks with catalog tracks for the same
 * album. Local tracks are returned unchanged (they remain the normal,
 * playable library tracks). Catalog tracks that do not match any local track
 * by normalized title/version are appended as undownloaded entries so the
 * complete known tracklist stays visible.
 */
export function mergeAlbumTracks(
  localTracks: UnifiedSearchResult[],
  catalogTracks: UnifiedSearchResult[]
): UnifiedSearchResult[] {
  const localKeys = new Set(localTracks.map((track) => titleKey(track.title)));

  const undownloaded = catalogTracks.filter(
    (item) => item.type === "track" && !localKeys.has(titleKey(item.title))
  );

  return [...localTracks, ...undownloaded];
}

/**
 * Combine local album summaries with catalog album summaries for the same
 * artist. Local albums are unchanged. Catalog albums with no locally
 * downloaded track are appended so they remain visible (per requirement:
 * artist pages must not hide albums with zero downloaded tracks).
 */
export function mergeArtistAlbums(
  localAlbums: UnifiedSearchResult[],
  catalogAlbums: UnifiedSearchResult[]
): UnifiedSearchResult[] {
  const localKeys = new Set(localAlbums.map((album) => titleKey(album.title)));
  const undownloaded = catalogAlbums.filter(
    (album) => album.type === "album" && !localKeys.has(titleKey(album.title))
  );
  return [...localAlbums, ...undownloaded];
}

/**
 * Find the best exact (normalized) album match for a local album's name +
 * artist among external search results. Returns null when there is no
 * confident match — never guesses to avoid merging distinct albums.
 */
export function findMatchingExternalAlbum(
  results: UnifiedSearchResult[],
  albumName: string,
  artistName: string | null
): UnifiedSearchResult | null {
  const targetTitle = normalizeMusicText(albumName);
  const targetArtist = normalizeMusicText(artistName);

  return (
    results.find(
      (item) =>
        item.type === "album" &&
        normalizeMusicText(item.title) === targetTitle &&
        (!targetArtist || normalizeMusicText(item.artist) === targetArtist)
    ) || null
  );
}

/**
 * Find the best exact (normalized) artist match among external search
 * results. Returns null when there is no confident match.
 */
export function findMatchingExternalArtist(
  results: UnifiedSearchResult[],
  artistName: string
): UnifiedSearchResult | null {
  const targetTitle = normalizeMusicText(artistName);

  return results.find((item) => item.type === "artist" && normalizeMusicText(item.title) === targetTitle) || null;
}
