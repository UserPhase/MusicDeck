import { normalizeMusicText, versionSignature } from "../domain/music-identity.js";

export type MatchableTrack = {
  id: string;
  title: string;
  artist: string;
  isrc?: string | null;
};

export type MatchableAlbum = {
  id: string;
  title: string;
  artist: string;
};

export type LocalMatchResult = {
  inLibrary: boolean;
  localTrackId?: string;
};

export type LocalAlbumMatchResult = {
  inLibrary: boolean;
  localAlbumId?: string;
};

function normalizedIsrc(value: string | null | undefined) {
  return (value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function trackKey(title: string, artist: string) {
  return `${normalizeMusicText(title)}::${normalizeMusicText(artist)}::${versionSignature(title)}`;
}

function albumKey(title: string, artist: string) {
  return `${normalizeMusicText(title)}::${normalizeMusicText(artist)}::${versionSignature(title)}`;
}

/** ISRC is authoritative; title and artist are a conservative fallback. */
export function matchLocalTrack(externalTrack: MatchableTrack, localLibrary: MatchableTrack[]): LocalMatchResult {
  const isrc = normalizedIsrc(externalTrack.isrc);
  if (isrc) {
    const match = localLibrary.find((track) => normalizedIsrc(track.isrc) === isrc);
    if (match) return { inLibrary: true, localTrackId: match.id };
  }

  const key = trackKey(externalTrack.title, externalTrack.artist);
  if (!normalizeMusicText(externalTrack.title) || !normalizeMusicText(externalTrack.artist)) {
    return { inLibrary: false };
  }
  const match = localLibrary.find((track) => trackKey(track.title, track.artist) === key);
  return match ? { inLibrary: true, localTrackId: match.id } : { inLibrary: false };
}

export function matchLocalAlbum(externalAlbum: MatchableAlbum, localLibrary: MatchableAlbum[]): LocalAlbumMatchResult {
  if (!normalizeMusicText(externalAlbum.title) || !normalizeMusicText(externalAlbum.artist)) {
    return { inLibrary: false };
  }
  const key = albumKey(externalAlbum.title, externalAlbum.artist);
  const match = localLibrary.find((album) => albumKey(album.title, album.artist) === key);
  return match ? { inLibrary: true, localAlbumId: match.id } : { inLibrary: false };
}

/** Precompute keys once for a large library; external result annotation is O(1) per item. */
export function createLibraryMatchIndex(localTracks: MatchableTrack[], localAlbums: MatchableAlbum[]) {
  const byIsrc = new Map<string, string>();
  const byTrack = new Map<string, string>();
  const byAlbum = new Map<string, string>();
  for (const track of localTracks) {
    const isrc = normalizedIsrc(track.isrc);
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, track.id);
    const key = trackKey(track.title, track.artist);
    if (!byTrack.has(key)) byTrack.set(key, track.id);
  }
  for (const album of localAlbums) {
    const key = albumKey(album.title, album.artist);
    if (!byAlbum.has(key)) byAlbum.set(key, album.id);
  }
  return {
    matchTrack(track: MatchableTrack): LocalMatchResult {
      const isrc = normalizedIsrc(track.isrc);
      const id = (isrc && byIsrc.get(isrc)) || (
        normalizeMusicText(track.title) && normalizeMusicText(track.artist)
          ? byTrack.get(trackKey(track.title, track.artist))
          : undefined
      );
      return id ? { inLibrary: true, localTrackId: id } : { inLibrary: false };
    },
    matchAlbum(album: MatchableAlbum): LocalAlbumMatchResult {
      const id = normalizeMusicText(album.title) && normalizeMusicText(album.artist)
        ? byAlbum.get(albumKey(album.title, album.artist))
        : undefined;
      return id ? { inLibrary: true, localAlbumId: id } : { inLibrary: false };
    },
  };
}
