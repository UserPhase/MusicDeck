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

function wikipediaUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function candidatesFor(artistName) {
  return [artistName, `${artistName} (musician)`, `${artistName} (band)`, `${artistName} (singer)`];
}

async function lookup(artistName, fetchImpl) {
  for (const title of candidatesFor(artistName)) {
    let response;
    try {
      response = await fetchImpl(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, "_"))}`, {
        headers: { Accept: "application/json" }, credentials: "omit",
      });
    } catch {
      return null; // Offline/CORS: no noisy retries through the other titles.
    }
    if (response.status === 404) continue;
    if (!response.ok) return null;
    let data;
    try { data = await response.json(); } catch { return null; }
    if (data?.type === "disambiguation") continue;
    const text = sanitizeBiographyExtract(data?.extract);
    if (!text || !MUSIC_CONTEXT.test(`${data?.description || ""} ${text}`)) continue;
    const pageTitle = typeof data.title === "string" && data.title.trim() ? data.title.trim() : title;
    return { text, url: wikipediaUrl(pageTitle), source: "wikipedia" };
  }
  return null;
}

/** Keyless, client-side fallback; positive results survive repeat page loads. */
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
    }).catch(() => null).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return pending.get(key);
}
