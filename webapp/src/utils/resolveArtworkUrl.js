import { getCoverUrl } from "../api/musicdeck";
import { isDefaultPlaceholder } from "./placeholderDetector";

function ownArtwork(entity, size) {
  if (!entity || typeof entity !== "object") return [];
  const id = entity.coverArt || entity.artworkId || entity.artwork?.id;
  return [
    entity.coverUrl,
    entity.artworkUrl,
    entity.artwork?.url,
    isDefaultPlaceholder(id) ? null : getCoverUrl(id, size),
  ].filter((url) => typeof url === "string" && (
    /^https?:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//"))
  ) && !isDefaultPlaceholder(url));
}

/** Native IDs always use the authenticated proxy; URLs are never encoded as IDs. */
export function artworkCandidates(entity, size) {
  const children = [entity?.tracks, entity?.song, entity?.entry].filter(Array.isArray).flat();
  const candidates = [
    ...ownArtwork(entity, size),
    ...ownArtwork(entity?.album, size),
    ...children.flatMap((track) => [
      ...ownArtwork(track, size),
      ...ownArtwork(track?.album, size),
    ]),
  ];
  const blocked = new Set((entity?.unavailableArtworkIds || []).map((id) => `/api/artwork/${encodeURIComponent(id)}`));
  return [...new Set(candidates)].filter((url) => !blocked.has(url.split("?")[0]));
}

export function resolveArtworkUrl(entity, size) {
  return artworkCandidates(entity, size)[0] || null;
}
