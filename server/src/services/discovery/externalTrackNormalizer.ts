export type NormalizedExternalTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  isrc: string | null;
  source: "external";
};

type RawExternalTrack = Record<string, unknown>;
type PreviewLookup = (query: string) => Promise<unknown[]>;

const PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LOOKUP_CONCURRENCY = 5;
const MAX_QUEUED_LOOKUPS = 100;
const previewCache = new Map<string, { previewUrl: string | null; expiresAt: number }>();
const pendingLookups = new Map<string, Promise<string | null>>();
let activeLookups = 0;
const waitingLookups: Array<() => void> = [];

async function withLookupSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeLookups >= MAX_LOOKUP_CONCURRENCY) {
    if (waitingLookups.length >= MAX_QUEUED_LOOKUPS) {
      throw new Error("External preview lookup queue is full");
    }
    await new Promise<void>((resolve) => waitingLookups.push(resolve));
  } else {
    activeLookups += 1;
  }
  try {
    return await operation();
  } finally {
    const next = waitingLookups.shift();
    if (next) next();
    else activeLookups -= 1;
  }
}

function stringValue(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || null;
}

function nestedString(value: unknown, ...keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return stringValue(...keys.map((key) => record[key]));
}

function validPreviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === "audio-ssl.itunes.apple.com"
      || url.hostname.endsWith(".dzcdn.net")
      || url.hostname === "dzcdn.net";
    return url.protocol === "https:" && trustedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function previewFrom(raw: RawExternalTrack): string | null {
  return [raw.previewUrl, raw.preview_url, raw.preview, raw.audio_preview_url]
    .map(validPreviewUrl)
    .find((previewUrl): previewUrl is string => Boolean(previewUrl)) || null;
}

export function normalizeExternalTrack(raw: RawExternalTrack): NormalizedExternalTrack | null {
  const rawId = raw.id ?? raw.trackId ?? raw.deezerTrackId;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId)
    ? String(rawId)
    : stringValue(rawId);
  const title = stringValue(raw.title, raw.trackName, raw.name);
  const artist = stringValue(raw.artistName, nestedString(raw.artist, "name"), raw.artist, raw.subtitle);
  if (!id || !title || !artist) return null;

  const album = stringValue(
    raw.album,
    raw.albumName,
    raw.collectionName,
    nestedString(raw.album, "title")
  );
  const coverUrl = stringValue(
    raw.coverUrl,
    raw.cover_url,
    raw.artworkUrl,
    nestedString(raw.coverArt, "url"),
    nestedString(raw.artwork, "url"),
    nestedString(raw.album, "cover_xl", "cover_big", "cover_medium", "artworkUrl100")
  );
  const previewUrl = previewFrom(raw);
  const isrc = stringValue(raw.isrc, nestedString(raw.identityHints, "isrc"));

  return { id, title, artist, album, coverUrl, previewUrl, isrc, source: "external" };
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
}

function queryKey(track: NormalizedExternalTrack): string {
  return track.isrc
    ? `isrc:${track.isrc.toLocaleLowerCase()}`
    : `track:${normalizedText(track.artist)}:${normalizedText(track.title)}`;
}

function matchPreview(track: NormalizedExternalTrack, results: unknown[]): string | null {
  const candidates = results.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as RawExternalTrack;
    const normalized = normalizeExternalTrack(item);
    const previewUrl = previewFrom(item);
    if (!previewUrl) return [];
    if (track.isrc && stringValue(item.isrc, nestedString(item.identityHints, "isrc"))?.toLowerCase() === track.isrc.toLowerCase()) {
      return [{ previewUrl, score: 2 }];
    }
    if (normalized
      && normalizedText(normalized.title) === normalizedText(track.title)
      && normalizedText(normalized.artist) === normalizedText(track.artist)) {
      return [{ previewUrl, score: 1 }];
    }
    return [];
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.previewUrl || null;
}

async function cachedLookup(track: NormalizedExternalTrack, lookup: PreviewLookup): Promise<string | null> {
  const key = queryKey(track);
  const cached = previewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.previewUrl;
  if (cached) previewCache.delete(key);
  const pending = pendingLookups.get(key);
  if (pending) return pending;

  const request = (async () => {
    const queries = track.isrc ? [track.isrc, `${track.artist} ${track.title}`] : [`${track.artist} ${track.title}`];
    for (const query of queries) {
      try {
        const previewUrl = matchPreview(track, await lookup(query));
        if (previewUrl) return previewUrl;
      } catch {
        if (query === queries[queries.length - 1]) return null;
      }
    }
    return null;
  })();
  pendingLookups.set(key, request);
  try {
    const previewUrl = await request;
    previewCache.set(key, {
      previewUrl,
      expiresAt: Date.now() + (previewUrl ? PREVIEW_CACHE_TTL_MS : NEGATIVE_PREVIEW_CACHE_TTL_MS),
    });
    if (previewCache.size > 1000) {
      const oldestKey = previewCache.keys().next().value;
      if (oldestKey) previewCache.delete(oldestKey);
    }
    return previewUrl;
  } finally {
    pendingLookups.delete(key);
  }
}

export async function hydrateMissingPreviews(
  tracks: NormalizedExternalTrack[],
  lookup: PreviewLookup,
  maxConcurrent = 5
): Promise<NormalizedExternalTrack[]> {
  const hydrated = tracks.slice();
  const tasks = tracks.flatMap((track, index) =>
    track.previewUrl ? [] : [{ track, index }]
  );
  let nextTask = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(maxConcurrent)), tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTask < tasks.length) {
      const taskIndex = nextTask++;
      const { track, index } = tasks[taskIndex];
      try {
        const previewUrl = await withLookupSlot(() => cachedLookup(track, lookup));
        if (previewUrl) hydrated[index] = { ...track, previewUrl };
      } catch {
        // Optional preview lookup must not prevent chart tracks from displaying.
      }
    }
  });
  await Promise.allSettled(workers);
  return hydrated;
}
