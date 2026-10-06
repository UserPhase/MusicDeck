const CACHE_PREFIX = "musicdeck:wikipedia-bio:v1:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EXTRACT_LENGTH = 800;
const pending = new Map();
const MUSIC_CONTEXT = /\b(singer|musician|band|rapper|songwriter|vocalist|composer|record producer|recording artist|musical group|music group|rock group|hip[- ]hop|discography|album)s?\b/i;

function cacheKey(artistId) {
  return `${CACHE_PREFIX}${String(artistId)}`;
}

function readCached(artistId, artistName) {
  try {
    const stored = JSON.parse(localStorage.getItem(cacheKey(artistId)) || "null");
    if (stored?.expiresAt > Date.now() && stored.artistName === artistName
      && typeof stored.text === "string" && typeof stored.url === "string") {
      return { text: stored.text, url: stored.url, source: "wikipedia" };
    }
  } catch { /* Private browsing or disabled storage is fine. */ }
  return null;
}

export function getCachedWikipediaBiography(artistId, artistName) {
  if (!artistId || !artistName) return null;
  return readCached(artistId, String(artistName).trim());
}

function saveCached(artistId, artistName, biography) {
  try {
    localStorage.setItem(cacheKey(artistId), JSON.stringify({
      artistName, text: biography.text, url: biography.url,
      expiresAt: Date.now() + CACHE_TTL_MS,
    }));
  } catch { /* Cache is optional. */ }
}

export function sanitizeBiographyExtract(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/<[^>]*>/g, " ")
    .replace(/\[(?:\d+|citation needed)\]/gi, "")
    .replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_EXTRACT_LENGTH) return clean;
  const limit = clean.slice(0, MAX_EXTRACT_LENGTH + 1);
  const sentenceEnd = Math.max(limit.lastIndexOf(". "), limit.lastIndexOf("! "), limit.lastIndexOf("? "));
  return sentenceEnd >= 480 ? limit.slice(0, sentenceEnd + 1) : `${limit.slice(0, limit.lastIndexOf(" "))}…`;
}

async function lookup(artistName, fetchImpl) {
  const response = await fetchImpl(`/api/metadata/artist-biography?${new URLSearchParams({ artist: artistName })}`, {
    headers: { Accept: "application/json" }, credentials: "include",
  });
  if (!response.ok) throw new Error(`Artist biography lookup failed (${response.status})`);
  const data = await response.json();
  if (!data.biography) return null;
  const text = sanitizeBiographyExtract(data.biography.text);
  if (!text || !MUSIC_CONTEXT.test(text)) return null;
  return { text, url: data.biography.url, source: "wikipedia" };
}

/** Same-origin, keyless fallback; positive results survive repeat page loads. */
export function getWikipediaBiography(artistId, artistName, fetchImpl = fetch) {
  const name = String(artistName || "").trim();
  if (!name || !artistId) return Promise.resolve(null);
  const cached = readCached(artistId, name);
  if (cached) return Promise.resolve(cached);
  const key = `${artistId}:${name}`;
  if (!pending.has(key)) {
    const request = lookup(name, fetchImpl).then((biography) => {
      if (biography) saveCached(artistId, name, biography);
      return biography;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return pending.get(key);
}
