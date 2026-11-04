export const PWA_CACHE_PREFIX = "musicdeck-pwa-";
export const CACHE_VERSION = "v1";
export const SHELL_CACHE = `${PWA_CACHE_PREFIX}shell-${CACHE_VERSION}`;
export const STATIC_CACHE = `${PWA_CACHE_PREFIX}static-${CACHE_VERSION}`;
export const METADATA_CACHE = `${PWA_CACHE_PREFIX}metadata-${CACHE_VERSION}`;
export const ARTWORK_CACHE_PREFIX = `${PWA_CACHE_PREFIX}artwork-${CACHE_VERSION}-`;
export const CATALOG_CACHE_PREFIX = `${PWA_CACHE_PREFIX}catalog-${CACHE_VERSION}-`;
export const ARTWORK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ARTWORK_MAX_ITEMS = 1000;

export function isArtworkCache(name: string): boolean {
  return name.startsWith(`${PWA_CACHE_PREFIX}artwork-`);
}
export function isCatalogCache(name: string): boolean {
  return name.startsWith(`${PWA_CACHE_PREFIX}catalog-`);
}
export function isStaleWebCache(name: string): boolean {
  return name.startsWith(PWA_CACHE_PREFIX) && ![SHELL_CACHE, STATIC_CACHE, METADATA_CACHE].includes(name) &&
    !name.startsWith(`${SHELL_CACHE}-`) && !name.startsWith(`${STATIC_CACHE}-`) &&
    !name.startsWith(CATALOG_CACHE_PREFIX) &&
    !name.startsWith(ARTWORK_CACHE_PREFIX);
}
export function isPurgeableWebCache(name: string): boolean {
  return isStaleWebCache(name) || isCatalogCache(name);
}
export function isCatalogPath(path: string): boolean {
  const match = path.match(/^\/api\/(?:albums|artists|tracks)(?:\/([^/]+))?$/);
  if (!match) return false;
  if (!match[1]) return true;
  try {
    const id = decodeURIComponent(match[1]);
    return !id.includes("/") && !/^(?:external_|extdetail_|deezer_|ext:)/i.test(id);
  } catch (error) {
    console.warn("Skipping a malformed catalog cache path:", error);
    return false;
  }
}
export function isAudioRequest(request: Pick<Request, "url" | "destination"> & { headers: Pick<Headers, "has"> }): boolean {
  const url = new URL(request.url);
  return request.destination === "audio" || request.destination === "video" || request.headers.has("range") ||
    /^\/api\/(?:tracks\/[^/]+\/(?:stream|download)|playback\/(?:preview|normalize)|streams?)(?:\/|$)/i.test(url.pathname) ||
    /\.(?:mp3|m4a|aac|flac|alac|ogg|opus|wav|webm|mp4|m3u8|mpd)$/i.test(url.pathname);
}
export function isArtworkPath(path: string): boolean {
  try { if (/^\/api\/artwork\/mdplart_/.test(decodeURIComponent(path))) return false; } catch { return false; }
  return /^\/api\/artwork\/[^/]+(?:\/[^/]+)?$/.test(path);
}
