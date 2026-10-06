import { resolveArtworkUrl } from "./resolveArtworkUrl";

export function getEffectiveAlbumCover(album, size) {
  return resolveArtworkUrl(album, size);
}
