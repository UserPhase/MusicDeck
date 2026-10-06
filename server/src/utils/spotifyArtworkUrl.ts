export function isSpotifyArtworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "i.scdn.co"
      && !url.port && !url.username && !url.password && /^\/image\/[a-zA-Z0-9]+$/.test(url.pathname)
      && !url.search && !url.hash;
  } catch { return false; }
}

export function largestSpotifyArtwork(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  let selected: string | null = null;
  let maximum = -1;
  for (const value of images) {
    if (!value || typeof value !== "object") continue;
    const image = value as Record<string, unknown>;
    if (typeof image.url !== "string" || !isSpotifyArtworkUrl(image.url)) continue;
    const width = typeof image.width === "number" && Number.isFinite(image.width) ? Math.max(0, image.width) : 0;
    const height = typeof image.height === "number" && Number.isFinite(image.height) ? Math.max(0, image.height) : 0;
    const area = width * height;
    if (area > maximum) { maximum = area; selected = image.url; }
  }
  return selected;
}
