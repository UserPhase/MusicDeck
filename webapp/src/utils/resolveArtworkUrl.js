import { getCoverUrl } from "../api/musicdeck";
import { isDefaultPlaceholder } from "./placeholderDetector";
import { isBrowserIntegrationAllowed } from "../services/privacyPolicy";
import { getDesktopServerUrl, isDesktopRuntime, resolveDesktopApiUrl } from "../services/desktop/desktopRuntime";

function stripDesktopOrigin(url) {
  if (typeof url !== "string" || !isDesktopRuntime()) return url;
  const serverUrl = getDesktopServerUrl();
  if (serverUrl && url.startsWith(`${serverUrl}/api/`)) {
    return url.slice(serverUrl.length);
  }
  return url;
}

function ownArtwork(entity, size) {
  if (!entity || typeof entity !== "object") return [];
  const id = entity.coverArt || entity.artworkId || entity.artwork?.id;
  return [
    entity.coverUrl,
    entity.artworkUrl,
    entity.artwork?.url,
    isDefaultPlaceholder(id) ? null : getCoverUrl(id, size),
  ].filter((url) => {
    if (typeof url !== "string" || isDefaultPlaceholder(url)) return false;
    const relative = stripDesktopOrigin(url);
    const valid = /^https?:\/\//i.test(relative) || (relative.startsWith("/") && !relative.startsWith("//"));
    if (!valid) return false;
    return isBrowserIntegrationAllowed("artwork") || (
      relative.startsWith("/") && !relative.startsWith("//") && !relative.startsWith("/api/artwork/external/")
    );
  });
}

/** Native IDs always use the authenticated proxy; URLs are never encoded as IDs. */
export function artworkCandidates(entity, size) {
  const children = [entity?.tracks, entity?.song, entity?.entry].filter(Array.isArray).flat();
  const candidates = [
    /^\/api\/albums\/[^/?]+\/artwork$/.test(entity?.albumArtworkUrl || "")
      ? resolveDesktopApiUrl(`${entity.albumArtworkUrl}?${new URLSearchParams({ size: String(size || 360) })}`) : null,
    ...ownArtwork(entity, size),
    ...ownArtwork(entity?.album, size),
    ...children.flatMap((track) => [
      ...ownArtwork(track, size),
      ...ownArtwork(track?.album, size),
    ]),
  ];
  const blocked = new Set((entity?.unavailableArtworkIds || []).map((id) => `/api/artwork/${encodeURIComponent(id)}`));
  return [...new Set(candidates)].filter((url) => url && !blocked.has(stripDesktopOrigin(url).split("?")[0]));
}

export function resolveArtworkUrl(entity, size) {
  return artworkCandidates(entity, size)[0] || null;
}
