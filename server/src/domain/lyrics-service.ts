export type LyricsTrack = {
  title: string;
  artist: string;
  album?: string;
  durationSeconds: number;
};

export type LyricsResult = {
  syncedLyrics: ParsedLrcLine[] | null;
  plainLyrics: string | null;
  isSynced: boolean;
  provider: "lrclib" | "lyricsovh" | "none";
  instrumental: boolean;
};

export type ParsedLrcLine = { time: number; text: string };

type LrclibPayload = {
  plainLyrics?: unknown;
  syncedLyrics?: unknown;
  instrumental?: unknown;
  duration?: unknown;
};

const FOUND_TTL = 24 * 60 * 60_000;
const MISSING_TTL = 10 * 60_000;
const ERROR_TTL = 30_000;
const LRCLIB_CLIENT = "MusicDeck/0.1.0 (https://github.com/UserPhase/MusicDeck)";
const LRCLIB_HEADERS = { "Lrclib-Client": LRCLIB_CLIENT, "User-Agent": LRCLIB_CLIENT };

export function parseLrcLines(value: string): ParsedLrcLine[] {
  const lines: ParsedLrcLine[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d)\.(\d{2,3})\]/g)];
    if (!stamps.length) continue;
    const text = raw.slice(stamps[stamps.length - 1].index! + stamps[stamps.length - 1][0].length).trim();
    for (const stamp of stamps) {
      lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2])
        + Number(stamp[3]) / (stamp[3].length === 2 ? 100 : 1000), text });
    }
  }
  return lines.sort((left, right) => left.time - right.time);
}

function noneResult(instrumental = false): LyricsResult {
  return { syncedLyrics: null, plainLyrics: null, isSynced: false, provider: "none", instrumental };
}

export function sanitizeTrackTitle(title: string): string {
  return title
    .replace(/\s*[([]\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^)\]]+[)\]]/gi, "")
    .replace(/\s*[([]\s*(?:(?:\d{4}\s*)?remaster(?:ed)?|deluxe(?:\s+edition)?|single|[^)\]]*\bversion)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s*-\s*(?:single|ep|remaster(?:ed)?)\b.*$/gi, "")
    .trim();
}

export function primaryArtistName(artist: string): string {
  return artist.split(/\s*(?:&|,|\bfeat(?:uring)?\.?\s|\bft\.?\s)\s*/i)[0]?.trim() || artist.trim();
}

function lyricsFrom(data: LrclibPayload): LyricsResult {
  const plainLyrics = typeof data.plainLyrics === "string" ? data.plainLyrics.slice(0, 100_000).trim() || null : null;
  const lines = typeof data.syncedLyrics === "string" ? parseLrcLines(data.syncedLyrics.slice(0, 100_000)) : [];
  return { syncedLyrics: lines.length ? lines : null, plainLyrics, isSynced: lines.length > 0,
    provider: "lrclib", instrumental: data.instrumental === true };
}

function hasLyrics(data: LrclibPayload): boolean {
  return (typeof data.syncedLyrics === "string" && data.syncedLyrics.trim().length > 0)
    || (typeof data.plainLyrics === "string" && data.plainLyrics.trim().length > 0);
}

/** LRCLIB timed/plain lyrics, then keyless lyrics.ovh plain text; in-flight-deduplicated caching. */
export class LyricsService {
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<LyricsResult> }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(track: LyricsTrack): Promise<LyricsResult> {
    const title = sanitizeTrackTitle(track.title) || track.title.trim();
    const artist = track.artist.trim();
    let direct: LyricsResult | null = null;
    try { direct = await this.direct(track, title, artist); } catch { /* Continue to search. */ }
    if (direct?.isSynced || direct?.plainLyrics) return direct;
    let searched: LyricsResult | null = null;
    try { searched = await this.search(track, title, artist); } catch { /* Continue to Tier 3. */ }
    if (searched?.isSynced || searched?.plainLyrics) return searched;
    try {
      const fallback = await this.lyricsOvh(artist, title);
      if (fallback) return fallback;
    } catch { /* Offline/404/unavailable: settle to the standard empty state. */ }
    return noneResult(direct?.instrumental || searched?.instrumental || false);
  }

  private async direct(track: LyricsTrack, title: string, artist: string): Promise<LyricsResult | null> {
    const url = new URL("https://lrclib.net/api/get");
    url.searchParams.set("track_name", title);
    url.searchParams.set("artist_name", artist);
    url.searchParams.set("duration", String(Math.round(track.durationSeconds)));
    const response = await this.fetchImpl(url, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(4_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`);
    const data = await response.json() as LrclibPayload;
    return hasLyrics(data) || data.instrumental === true ? lyricsFrom(data) : null;
  }

  private async search(track: LyricsTrack, title: string, artist: string): Promise<LyricsResult | null> {
    const searchArtist = async (name: string): Promise<LyricsResult | null> => {
      const url = new URL("https://lrclib.net/api/search");
      url.searchParams.set("track_name", title);
      url.searchParams.set("artist_name", name);
      const response = await this.fetchImpl(url, { headers: LRCLIB_HEADERS, signal: AbortSignal.timeout(4_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`LRCLIB search returned ${response.status}`);
      const candidates = await response.json() as unknown;
      if (!Array.isArray(candidates)) return null;
      const best = (candidates as LrclibPayload[])
        .filter((candidate) => candidate && hasLyrics(candidate)
          && typeof candidate.duration === "number" && Number.isFinite(candidate.duration))
        .sort((left, right) => Math.abs((left.duration as number) - track.durationSeconds)
          - Math.abs((right.duration as number) - track.durationSeconds))[0];
      if (!best || Math.abs((best.duration as number) - track.durationSeconds) > 8) return null;
      const result = lyricsFrom(best);
      return result.isSynced || result.plainLyrics ? result : null;
    };

    const result = await searchArtist(artist);
    if (result) return result;
    const primary = primaryArtistName(artist);
    return primary.toLowerCase() !== artist.toLowerCase() ? searchArtist(primary) : null;
  }

  private async lyricsOvh(artist: string, title: string): Promise<LyricsResult | null> {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { lyrics?: unknown };
    if (typeof payload?.lyrics !== "string") return null;
    const plainLyrics = payload.lyrics.slice(0, 100_000).replace(/\r\n?/g, "\n")
      .split("\n").map((line) => line.trimEnd()).join("\n").trim();
    return plainLyrics ? { syncedLyrics: null, plainLyrics, isSynced: false,
      provider: "lyricsovh", instrumental: false } : null;
  }

  get(trackId: string, track: LyricsTrack): Promise<LyricsResult> {
    const key = `${trackId}\0${track.title}\0${track.artist}\0${Math.round(track.durationSeconds)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const entry = {
      expiresAt: Date.now() + FOUND_TTL,
      value: Promise.resolve(noneResult()) as Promise<LyricsResult>,
    };
    entry.value = this.request(track).then((result) => {
      if (result.provider === "none") entry.expiresAt = Date.now() + MISSING_TTL;
      return result;
    }).catch(() => {
      entry.expiresAt = Date.now() + ERROR_TTL;
      return noneResult();
    });
    this.cache.set(key, entry);
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return entry.value;
  }
}
