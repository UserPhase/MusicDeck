import { useMemo } from "react";
import { toAlbumRouteIdFromApiId, toArtistApiId, toTrackAlbumRouteId } from "../utils/idResolver";
import { normalizeArtistCredits } from "../utils/normalizeTrackData";

export function useDiscoveryPlayback(currentSong, isPlaying, enabled) {
  const albumId = enabled ? toTrackAlbumRouteId(currentSong) : "";
  const artistIds = useMemo(() => new Set(enabled && currentSong ? [
    currentSong.artistId || currentSong.metadata?.artistId,
    ...normalizeArtistCredits(currentSong.artistCredits).map((credit) => credit.id),
  ].map(toArtistApiId).filter(Boolean) : []), [currentSong, enabled]);
  const state = isPlaying ? "playing" : "paused";

  return {
    albumState: (album) => albumId && albumId === toAlbumRouteIdFromApiId(album.localAlbumId || album.id) ? state : null,
    artistState: (artist) => artistIds.has(toArtistApiId(artist.id)) ? state : null,
  };
}
