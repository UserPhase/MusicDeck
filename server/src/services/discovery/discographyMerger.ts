export type DiscographySource = "local" | "external";

export type DiscographyAlbum = {
  id: string;
  title: string;
  artist?: string | null;
  year?: number | null;
  artworkId?: string | null;
  source: DiscographySource;
  provider?: string;
};

export type DiscographyTrack = {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
  artworkId?: string | null;
  previewUrl?: string | null;
  source: DiscographySource;
  provider?: string;
  metadata?: Record<string, unknown>;
};

const NOISE = /\b(?:deluxe|expanded|anniversary|remaster(?:ed)?|remix(?:ed)?|bonus(?:\s+tracks?)?|version|edition|reissue|re-release|digital|explicit|clean)\b(?:\s+\d{2,4})?/gi;

/** A stable comparison key for titles returned by different music providers. */
export function normalizeDiscographyText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[([{][^\]})]*[\]})]/g, " ")
    .replace(NOISE, " ")
    .replace(/\b(?:feat(?:uring)?|ft)\.?\s+.+$/i, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[right.length];
}

export function similarDiscographyTitle(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizeDiscographyText(left);
  const normalizedRight = normalizeDiscographyText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  if (longest < 7) return false;
  return 1 - levenshtein(normalizedLeft, normalizedRight) / longest >= 0.9;
}

function sameArtist(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeDiscographyText(left);
  const b = normalizeDiscographyText(right);
  return !a || !b || a === b;
}

function duplicateAlbum(candidate: DiscographyAlbum, existing: DiscographyAlbum[]) {
  return existing.some((item) => sameArtist(item.artist, candidate.artist) && similarDiscographyTitle(item.title, candidate.title));
}

export function discographyTracksMatch(candidate: DiscographyTrack, existing: DiscographyTrack) {
  if (!sameArtist(existing.artist, candidate.artist) || !similarDiscographyTitle(existing.title, candidate.title)) return false;
  const leftDuration = existing.durationSeconds;
  const rightDuration = candidate.durationSeconds;
  return leftDuration == null || rightDuration == null || Math.abs(leftDuration - rightDuration) <= 20;
}

function duplicateTrack(candidate: DiscographyTrack, existing: DiscographyTrack[]) {
  return existing.some((item) => {
    return discographyTracksMatch(candidate, item);
  });
}

export function mergeDiscography(
  local: { albums: DiscographyAlbum[]; tracks: DiscographyTrack[] },
  external: { albums: DiscographyAlbum[]; tracks: DiscographyTrack[] }
) {
  const knownAlbums = [...local.albums];
  const missingAlbums: DiscographyAlbum[] = [];
  for (const album of external.albums) {
    if (duplicateAlbum(album, knownAlbums)) continue;
    knownAlbums.push(album);
    missingAlbums.push(album);
  }

  const knownTracks = [...local.tracks];
  const missingTracks: DiscographyTrack[] = [];
  for (const track of external.tracks) {
    if (duplicateTrack(track, knownTracks)) continue;
    knownTracks.push(track);
    missingTracks.push(track);
  }

  return { missingAlbums, missingTracks };
}
