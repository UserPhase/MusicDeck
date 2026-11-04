import { getCoverUrl } from "../api/musicdeck";
import { isDefaultPlaceholder } from "./placeholderDetector";
import { isBrowserIntegrationAllowed } from "../services/privacyPolicy";

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
  ) && !isDefaultPlaceholder(url) && (isBrowserIntegrationAllowed("artwork") || (
    url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/api/artwork/external/")
  )));
}

/** Native IDs always use the authenticated proxy; URLs are never encoded as IDs. */
export function artworkCandidates(entity, size) {
  const children = [entity?.tracks, entity?.song, entity?.entry].filter(Array.isArray).flat();
  const candidates = [
    /^\/api\/albums\/[^/?]+\/artwork$/.test(entity?.albumArtworkUrl || "")
      ? `${entity.albumArtworkUrl}?${new URLSearchParams({ size: String(size || 360) })}` : null,
    ...ownArtwork(entity, size),
    ...ownArtwork(entity?.album, size),
    ...children.flatMap((track) => [
      ...ownArtwork(track, size),
      ...ownArtwork(track?.album, size),
    ]),
  ];
  const blocked = new Set((entity?.unavailableArtworkIds || []).map((id) => `/api/artwork/${encodeURIComponent(id)}`));
  return [...new Set(candidates)].filter((url) => url && !blocked.has(url.split("?")[0]));
}

export function resolveArtworkUrl(entity, size) {
  return artworkCandidates(entity, size)[0] || null;
}
