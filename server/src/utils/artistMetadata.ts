import type { Track } from "../types.js";

const PLACEHOLDER_ARTISTS = new Set(["unknown", "unknown artist", "various artists", "unspecified", ""]);

/** Compare whole names: e.g. Unknown Mortal Orchestra is a real artist. */
export function isPlaceholderArtist(value: string | null | undefined): boolean {
  return PLACEHOLDER_ARTISTS.has((value ?? "").trim().toLowerCase());
}

/** Various Artists is valid as the album artist of a compilation. */
export function isPlaceholderAlbumArtist(value: string | null | undefined): boolean {
  return isPlaceholderArtist(value) && value?.trim().toLowerCase() !== "various artists";
}

export function isTrackCreditedTo(track: Pick<Track, "artistId" | "artistCredits">, artistId: string) {
  return track.artistId === artistId || Boolean(track.artistCredits?.some((credit) => credit.id === artistId));
}

