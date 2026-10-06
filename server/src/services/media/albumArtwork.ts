import { isDefaultPlaceholder } from "./placeholderDetector.js";

export type ArtworkEntity = {
  coverUrl?: string | null;
  artworkId?: string | null;
  artworkUrl?: string | null;
  artwork?: { id: string; url: string | null } | null;
};

export function artwork(entity: ArtworkEntity) {
  const id = entity.artworkId || entity.artwork?.id || null;
  let url = entity.coverUrl || entity.artworkUrl || entity.artwork?.url || null;
  if (isDefaultPlaceholder(id) || isDefaultPlaceholder(url)) return { id: null, url: null };
  if (!url && id) {
    const isUrl = /^https?:\/\//i.test(id) || (id.startsWith("/") && !id.startsWith("//"));
    url = isUrl ? id : `/api/artwork/${id.startsWith("extart_") ? "external/" : ""}${encodeURIComponent(id)}`;
  }
  return { id, url };
}

/** Reuses already-stamped child artwork without exposing provider credentials. */
export function withAlbumArtwork<T extends ArtworkEntity>(album: T, tracks: ArtworkEntity[]) {
  const root = artwork(album);
  const resolved = root.url ? root : tracks.map(artwork).find((item) => item.url) || root;
  return {
    ...album,
    artworkId: resolved.id,
    artworkUrl: resolved.url,
    coverUrl: resolved.url,
  };
}
