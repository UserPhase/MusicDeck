import type { Db } from "../db/database.js";
import type { UnifiedSearchResult } from "./search.js";
import { normalizeMusicText, versionSignature } from "./music-identity.js";

export type SpotifyResolveConfidence = "high" | "medium" | "low";

export type SpotifyResolutionMode = "public-web" | "web-api" | "auto";

export type SpotifyMatchedTrack = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
};

export type SpotifyResolveResult = {
  url: string;
  trackId: string;
  confidence: SpotifyResolveConfidence;
  matchedTrack?: SpotifyMatchedTrack;
};

export type SpotifyTrackResolverOptions = {
  db?: Db;
  fetchImpl?: typeof fetch;
  mode?: SpotifyResolutionMode;
  publicWebBaseUrl?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
};

export type SpotifyApiTrack = {
  id: string;
  name: string;
  artists: Array<{ name: string; id?: string }>;
  album?: { name: string; id?: string };
  duration_ms?: number;
  external_urls?: { spotify?: string };
};

export type SpotifyMatchEvaluation = {
  matches: boolean;
  confidence: SpotifyResolveConfidence;
  score: number;
  reason?: string;
};

const SPOTIFY_TRACK_URL_REGEX = /^https?:\/\/(?:open\.)?spotify\.com\/track\/([a-zA-Z0-9]{22})(?:[/?#]|$)/i;
const SPOTIFY_URI_REGEX = /^spotify:track:([a-zA-Z0-9]{22})$/i;
const SPOTIFY_ID_REGEX = /^[a-zA-Z0-9]{22}$/;

/**
 * Validates and extracts a canonical 22-character Spotify track ID from
 * a URL, URI, or bare ID.
 */
export function extractSpotifyTrackId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(SPOTIFY_TRACK_URL_REGEX);
  if (urlMatch) return urlMatch[1];

  const uriMatch = trimmed.match(SPOTIFY_URI_REGEX);
  if (uriMatch) return uriMatch[1];

  if (SPOTIFY_ID_REGEX.test(trimmed)) return trimmed;

  return null;
}

/**
 * Constructs a canonical Spotify track URL from a valid track ID.
 */
export function buildCanonicalSpotifyTrackUrl(trackId: string): string {
  const id = extractSpotifyTrackId(trackId);
  if (!id) {
    throw new Error(`Invalid Spotify track ID: ${trackId}`);
  }
  return `https://open.spotify.com/track/${id}`;
}

/**
 * Validates a Spotify track URL, returning the canonical URL if valid or null if invalid.
 */
export function validateSpotifyTrackUrl(input: unknown): string | null {
  const id = extractSpotifyTrackId(input);
  return id ? `https://open.spotify.com/track/${id}` : null;
}

const VERSION_FLAGS = [
  { flag: "live", regex: /\blive\b/i },
  { flag: "remix", regex: /\b(?:remix|mix|club mix|dub mix|extended mix)\b/i },
  { flag: "acoustic", regex: /\bacoustic\b/i },
  { flag: "instrumental", regex: /\binstrumental\b/i },
  { flag: "demo", regex: /\bdemo\b/i },
];

/**
 * Strict matching between a target recording and a candidate Spotify track.
 * Enforces version distinctions (live/remix/acoustic/demo), duration tolerance,
 * and normalized text equality.
 */
export function evaluateSpotifyTrackMatch(
  target: UnifiedSearchResult,
  candidate: SpotifyApiTrack
): SpotifyMatchEvaluation {
  const targetTitle = normalizeMusicText(target.title);
  const targetArtist = normalizeMusicText(target.artist);
  const targetAlbum = normalizeMusicText(target.album);

  const candidateTitle = normalizeMusicText(candidate.name);
  const candidateArtists = (candidate.artists || []).map((a) => normalizeMusicText(a.name));
  const candidateAlbum = normalizeMusicText(candidate.album?.name);

  if (!candidateTitle || candidateArtists.length === 0) {
    return { matches: false, confidence: "low", score: 0, reason: "Missing title or artist on candidate" };
  }

  // 1. Version distinctions: Target and candidate must agree on version qualifiers
  const targetFullTitle = `${target.title} ${target.album || ""}`;
  const candidateFullTitle = `${candidate.name} ${candidate.album?.name || ""}`;

  for (const { flag, regex } of VERSION_FLAGS) {
    const targetHas = regex.test(targetFullTitle);
    const candidateHas = regex.test(candidateFullTitle);
    if (targetHas !== candidateHas) {
      return {
        matches: false,
        confidence: "low",
        score: 0,
        reason: `${flag === "live" ? "Live version" : flag === "remix" ? "Remix" : "Version"} mismatch`,
      };
    }
  }

  // Version signature matching
  const targetVersionSig = versionSignature(targetFullTitle);
  const candidateVersionSig = versionSignature(candidateFullTitle);
  if (targetVersionSig !== candidateVersionSig) {
    // If one specifies version attributes that the other does not, reject
    const targetHasSignificant = targetVersionSig.length > 0 && !targetVersionSig.includes("remaster");
    const candidateHasSignificant = candidateVersionSig.length > 0 && !candidateVersionSig.includes("remaster");
    if (targetHasSignificant || candidateHasSignificant) {
      if (targetVersionSig !== candidateVersionSig) {
        return { matches: false, confidence: "low", score: 0, reason: "Version signature mismatch" };
      }
    }
  }

  // 2. Artist match check
  const artistMatches = candidateArtists.some(
    (a) => a === targetArtist || (targetArtist && (a.includes(targetArtist) || targetArtist.includes(a)))
  );
  if (!artistMatches && targetArtist) {
    return {
      matches: false,
      confidence: "low",
      score: 0,
      reason: `Artist mismatch: target "${targetArtist}", candidate "${candidateArtists.join(", ")}"`,
    };
  }

  // 3. Title match check
  const exactTitle = candidateTitle === targetTitle;
  const partialTitle = targetTitle && (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle));
  if (!exactTitle && !partialTitle) {
    return {
      matches: false,
      confidence: "low",
      score: 0,
      reason: `Title mismatch: target "${targetTitle}", candidate "${candidateTitle}"`,
    };
  }

  let score = 0;
  if (exactTitle) score += 40;
  else if (partialTitle) score += 20;

  if (candidateArtists.some((a) => a === targetArtist)) score += 30;
  else score += 15;

  if (targetAlbum && candidateAlbum) {
    if (targetAlbum === candidateAlbum) {
      score += 20;
    } else if (candidateAlbum.includes(targetAlbum) || targetAlbum.includes(candidateAlbum)) {
      score += 10;
    }
  }

  // 4. Duration check
  const requestedDuration = Number(target.metadata?.durationSeconds || 0);
  const candidateDuration = candidate.duration_ms ? Math.round(candidate.duration_ms / 1000) : 0;

  if (requestedDuration > 0 && candidateDuration > 0) {
    const diff = Math.abs(candidateDuration - requestedDuration);
    if (diff > 20) {
      return {
        matches: false,
        confidence: "low",
        score: 0,
        reason: `Duration difference exceeds tolerance: ${diff}s difference`,
      };
    }
    if (diff <= 3) {
      score += 20;
    } else if (diff <= 8) {
      score += 10;
    } else {
      score -= 10;
    }
  }

  let confidence: SpotifyResolveConfidence = "low";
  if (score >= 80) {
    confidence = "high";
  } else if (score >= 50) {
    confidence = "medium";
  }

  return { matches: score >= 40, confidence, score };
}

/**
 * Parses ISO 8601 duration format (e.g. PT3M45S) to milliseconds.
 */
export function parseDurationFromIso(durationStr: string): number | undefined {
  if (typeof durationStr !== "string") return undefined;
  const match = durationStr.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return undefined;
  const hours = parseFloat(match[1] || "0");
  const minutes = parseFloat(match[2] || "0");
  const seconds = parseFloat(match[3] || "0");
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.round(totalSeconds * 1000);
}

/**
 * Extracts candidate Spotify tracks from a public Spotify search/open web page.
 * Uses only publicly accessible, unauthenticated metadata (HTML links, JSON-LD, embedded public state).
 */
export function parsePublicSpotifySearchResults(html: string): SpotifyApiTrack[] {
  const tracks: SpotifyApiTrack[] = [];
  const seenIds = new Set<string>();

  function addTrack(track: Partial<SpotifyApiTrack>) {
    const id = extractSpotifyTrackId(track.id);
    if (!id || seenIds.has(id)) return;
    if (!track.name) return;
    seenIds.add(id);
    tracks.push({
      id,
      name: track.name.trim(),
      artists: track.artists && track.artists.length > 0
        ? track.artists.map((a) => ({ name: a.name.trim() }))
        : [{ name: "Unknown Artist" }],
      album: track.album?.name ? { name: track.album.name.trim() } : undefined,
      duration_ms: track.duration_ms,
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    });
  }

  // 1. JSON-LD scripts (Schema.org structured data)
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const processItem = (item: any) => {
        if (!item || typeof item !== "object") return;
        const type = item["@type"] || item.type;
        if (type === "MusicRecording") {
          const trackId = extractSpotifyTrackId(item.url || item["@id"] || item.identifier);
          const name = item.name || item.title;
          const artistName = item.byArtist?.name || item.byArtist || (Array.isArray(item.byArtist) ? item.byArtist[0]?.name : undefined);
          const albumName = item.inAlbum?.name || item.inAlbum;
          const duration = parseDurationFromIso(item.duration);
          if (trackId && name) {
            addTrack({
              id: trackId,
              name,
              artists: artistName ? [{ name: artistName }] : [],
              album: albumName ? { name: albumName } : undefined,
              duration_ms: duration,
            });
          }
        } else if (Array.isArray(item.itemListElement)) {
          for (const elem of item.itemListElement) {
            processItem(elem.item || elem);
          }
        }
      };

      if (Array.isArray(data)) {
        for (const item of data) processItem(item);
      } else {
        processItem(data);
      }
    } catch {}
  }

  // 2. Next.js / Initial State scripts
  const nextDataRegex = /<script\b[^>]*id=["'](?:__NEXT_DATA__|initial-state|session)["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = nextDataRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const walk = (obj: any) => {
        if (!obj || typeof obj !== "object") return;
        if (
          typeof obj.id === "string" &&
          typeof obj.name === "string" &&
          (obj.uri?.startsWith("spotify:track:") || obj.type === "track" || SPOTIFY_ID_REGEX.test(obj.id))
        ) {
          const artists = Array.isArray(obj.artists)
            ? obj.artists.map((a: any) => ({ name: typeof a === "string" ? a : a?.name || "" }))
            : obj.artistName ? [{ name: obj.artistName }] : [];
          addTrack({
            id: obj.id,
            name: obj.name,
            artists,
            album: obj.album ? { name: typeof obj.album === "string" ? obj.album : obj.album?.name || "" } : undefined,
            duration_ms: obj.duration_ms || obj.duration,
          });
        }
        for (const key of Object.keys(obj)) {
          walk(obj[key]);
        }
      };
      walk(data);
    } catch {}
  }

  // 3. HTML Links with /track/
  const trackLinkRegex = /<a\b[^>]*href=["'](?:https?:\/\/open\.spotify\.com)?\/track\/([a-zA-Z0-9]{22})["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = trackLinkRegex.exec(html)) !== null) {
    const trackId = match[1];
    const fullTag = match[0];
    const inner = match[2];

    const ariaMatch = fullTag.match(/aria-label=["']([^"']+)["']/i);
    let title = "";
    let artist = "";

    if (ariaMatch) {
      const label = ariaMatch[1].trim();
      const splitMatch = label.match(/^(.*?)\s+(?:by|•|-)\s+(.*)$/i);
      if (splitMatch) {
        title = splitMatch[1].trim();
        artist = splitMatch[2].trim();
      } else {
        title = label;
      }
    }

    if (!title) {
      title = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    if (title) {
      addTrack({
        id: trackId,
        name: title,
        artists: artist ? [{ name: artist }] : [],
      });
    }
  }

  // 4. Regex fallback for JSON fragments in raw scripts
  const rawTrackObjRegex = /\{[^{}]*"(?:uri|id)"\s*:\s*"(?:spotify:track:)?([a-zA-Z0-9]{22})"[^{}]*"name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"[^{}]*\}/gi;
  while ((match = rawTrackObjRegex.exec(html)) !== null) {
    try {
      const id = match[1];
      const name = JSON.parse(`"${match[2]}"`);
      addTrack({ id, name });
    } catch {}
  }

  return tracks;
}

/**
 * SpotifyTrackResolver service: Obtains a canonical Spotify track URL for
 * a requested MusicDeck track or search result.
 * Supports public-web resolution (no credentials required) and authenticated Web API resolution.
 * Spotify is used strictly as an identity/link bridge, NOT as an audio download source.
 */
export class SpotifyTrackResolver {
  private readonly db?: Db;
  private readonly fetchImpl: typeof fetch;
  public readonly mode: SpotifyResolutionMode;
  private readonly publicWebBaseUrl: string;
  private readonly staticToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly getAccessTokenFn?: () => Promise<string | null> | string | null;

  constructor(options: SpotifyTrackResolverOptions = {}) {
    this.db = options.db;
    this.fetchImpl = options.fetchImpl || fetch;
    this.mode = options.mode || "auto";
    this.publicWebBaseUrl = options.publicWebBaseUrl || "https://open.spotify.com";
    this.staticToken = options.token;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.getAccessTokenFn = options.getAccessToken;
  }

  /**
   * Checks whether Spotify Web API credentials or tokens are configured.
   */
  public hasApiCredentials(): boolean {
    if (this.staticToken || this.getAccessTokenFn || process.env.SPOTIFY_ACCESS_TOKEN) return true;
    if (this.clientId && this.clientSecret) return true;
    if (this.db) {
      try {
        const row = this.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = 'spotify-importer'").get() as any;
        if (row?.config_json) {
          const config = JSON.parse(row.config_json);
          if (config.accessToken && typeof config.accessToken === "string" && config.accessToken.trim()) {
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  private async getToken(): Promise<string | null> {
    if (this.staticToken) return this.staticToken;
    if (this.getAccessTokenFn) {
      try {
        const t = await this.getAccessTokenFn();
        if (t) return t;
      } catch {}
    }
    if (process.env.SPOTIFY_ACCESS_TOKEN) return process.env.SPOTIFY_ACCESS_TOKEN;

    if (this.clientId && this.clientSecret) {
      try {
        const body = new URLSearchParams({ grant_type: "client_credentials" });
        const res = await this.fetchImpl("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          },
          body: body.toString(),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.access_token) {
            return data.access_token;
          }
        }
      } catch {}
    }

    if (this.db) {
      try {
        const row = this.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = 'spotify-importer'").get() as any;
        if (row?.config_json) {
          const config = JSON.parse(row.config_json);
          if (config.accessToken && typeof config.accessToken === "string") {
            return config.accessToken.trim();
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Performs public Spotify web search without requiring login or API credentials.
   */
  public async searchPublicWeb(target: UnifiedSearchResult): Promise<SpotifyResolveResult | null> {
    const trackTitle = target.title;
    const trackArtist = target.artist || "Unknown";

    console.log(
      `[SpotifyResolver]\nmode = public-web\ntrack = ${trackTitle}\nartist = ${trackArtist}\nstatus = searching`
    );

    const query = [target.artist, target.title].filter(Boolean).join(" ").trim();
    if (!query) {
      console.log(
        `[SpotifyResolver]\nmode = public-web\nstatus = unavailable\nreason = empty search query\nfallback = text`
      );
      return null;
    }

    try {
      const searchUrl = `${this.publicWebBaseUrl}/search/${encodeURIComponent(query)}`;
      const res = await this.fetchImpl(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!res.ok) {
        console.log(
          `[SpotifyResolver]\nmode = public-web\nstatus = unavailable\nreason = public page returned HTTP ${res.status}\nfallback = text`
        );
        return null;
      }

      const html = await res.text();
      const candidates = parsePublicSpotifySearchResults(html);

      if (candidates.length === 0) {
        console.log(
          `[SpotifyResolver]\nmode = public-web\nstatus = unavailable\nreason = public page did not expose a reliable match\nfallback = text`
        );
        return null;
      }

      let bestMatch: { candidate: SpotifyApiTrack; score: number; confidence: SpotifyResolveConfidence } | null = null;

      for (const cand of candidates) {
        const evalResult = evaluateSpotifyTrackMatch(target, cand);
        if (evalResult.matches) {
          if (!bestMatch || evalResult.score > bestMatch.score) {
            bestMatch = { candidate: cand, score: evalResult.score, confidence: evalResult.confidence };
          }
        }
      }

      if (bestMatch) {
        const canonicalUrl = buildCanonicalSpotifyTrackUrl(bestMatch.candidate.id);
        console.log(
          `[SpotifyResolver]\nmode = public-web\nstatus = matched\nspotifyTrackId = ${bestMatch.candidate.id}\nconfidence = ${bestMatch.confidence}`
        );
        return {
          url: canonicalUrl,
          trackId: bestMatch.candidate.id,
          confidence: bestMatch.confidence,
          matchedTrack: {
            id: bestMatch.candidate.id,
            title: bestMatch.candidate.name,
            artist: bestMatch.candidate.artists?.[0]?.name || trackArtist,
            album: bestMatch.candidate.album?.name,
            durationSeconds: bestMatch.candidate.duration_ms ? Math.round(bestMatch.candidate.duration_ms / 1000) : undefined,
          },
        };
      }

      console.log(
        `[SpotifyResolver]\nmode = public-web\nstatus = unavailable\nreason = candidates did not meet match verification criteria\nfallback = text`
      );
      return null;
    } catch (err: any) {
      console.log(
        `[SpotifyResolver]\nmode = public-web\nstatus = unavailable\nreason = ${err instanceof Error ? err.message : String(err)}\nfallback = text`
      );
      return null;
    }
  }

  /**
   * Performs official Spotify Web API search with OAuth access token or client credentials.
   */
  public async searchWebApi(target: UnifiedSearchResult): Promise<SpotifyResolveResult | null> {
    const trackTitle = target.title;
    const trackArtist = target.artist || "Unknown";

    const token = await this.getToken();
    if (!token) {
      console.log(
        `[SpotifyResolver]\nmode = web-api\nstatus = unavailable\nreason = no Spotify Web API credentials configured\nfallback = text`
      );
      return null;
    }

    console.log(
      `[SpotifyResolver]\nmode = web-api\ntrack = ${trackTitle}\nartist = ${trackArtist}\nstatus = searching`
    );

    const query = [target.artist, target.title].filter(Boolean).join(" ").trim();
    if (!query) {
      console.log(
        `[SpotifyResolver]\nmode = web-api\nstatus = unavailable\nreason = empty search query\nfallback = text`
      );
      return null;
    }

    try {
      const searchUrl = new URL("https://api.spotify.com/v1/search");
      searchUrl.searchParams.set("q", query);
      searchUrl.searchParams.set("type", "track");
      searchUrl.searchParams.set("limit", "5");

      const res = await this.fetchImpl(searchUrl.toString(), {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });

      if (!res.ok) {
        console.log(
          `[SpotifyResolver]\nmode = web-api\nstatus = unavailable\nreason = API returned HTTP ${res.status}\nfallback = text`
        );
        return null;
      }

      const data = (await res.json()) as { tracks?: { items?: SpotifyApiTrack[] } };
      const candidates = data.tracks?.items || [];

      let bestMatch: { candidate: SpotifyApiTrack; score: number; confidence: SpotifyResolveConfidence } | null = null;

      for (const cand of candidates) {
        const evalResult = evaluateSpotifyTrackMatch(target, cand);
        if (evalResult.matches) {
          if (!bestMatch || evalResult.score > bestMatch.score) {
            bestMatch = { candidate: cand, score: evalResult.score, confidence: evalResult.confidence };
          }
        }
      }

      if (bestMatch) {
        const canonicalUrl = buildCanonicalSpotifyTrackUrl(bestMatch.candidate.id);
        console.log(
          `[SpotifyResolver]\nmode = web-api\nstatus = matched\nspotifyTrackId = ${bestMatch.candidate.id}\nconfidence = ${bestMatch.confidence}`
        );
        return {
          url: canonicalUrl,
          trackId: bestMatch.candidate.id,
          confidence: bestMatch.confidence,
          matchedTrack: {
            id: bestMatch.candidate.id,
            title: bestMatch.candidate.name,
            artist: bestMatch.candidate.artists?.[0]?.name || trackArtist,
            album: bestMatch.candidate.album?.name,
            durationSeconds: bestMatch.candidate.duration_ms ? Math.round(bestMatch.candidate.duration_ms / 1000) : undefined,
          },
        };
      }

      console.log(
        `[SpotifyResolver]\nmode = web-api\nstatus = unavailable\nreason = no reliable match found in Spotify Web API\nfallback = text`
      );
      return null;
    } catch (err: any) {
      console.log(
        `[SpotifyResolver]\nmode = web-api\nstatus = unavailable\nreason = ${err instanceof Error ? err.message : String(err)}\nfallback = text`
      );
      return null;
    }
  }

  /**
   * Alias for resolve(target, options)
   */
  async resolveTrack(
    target: UnifiedSearchResult,
    options?: { manualUrl?: string; searchIfMissing?: boolean; mode?: SpotifyResolutionMode }
  ): Promise<SpotifyResolveResult | null> {
    return this.resolve(target, options);
  }

  /**
   * Resolves a canonical Spotify track URL for the target recording.
   * Preferred order:
   * 1. Manual Spotify URL or existing known Spotify ID/URL metadata (fast path)
   * 2. Public Spotify web lookup (no credentials needed)
   * 3. Authenticated Web API lookup if configured
   */
  async resolve(
    target: UnifiedSearchResult,
    options?: { manualUrl?: string; searchIfMissing?: boolean; mode?: SpotifyResolutionMode }
  ): Promise<SpotifyResolveResult | null> {
    const trackTitle = target.title;
    const trackArtist = target.artist || "Unknown";

    // Step 1: Check manual URL fallback
    if (options?.manualUrl) {
      const trackId = extractSpotifyTrackId(options.manualUrl);
      if (trackId) {
        const canonicalUrl = buildCanonicalSpotifyTrackUrl(trackId);
        console.log(
          `[SpotifyResolver]\ntrack = ${trackTitle}\nartist = ${trackArtist}\nspotify lookup = success (manual URL)\nspotify track id = ${trackId}\nconfidence = high`
        );
        return {
          url: canonicalUrl,
          trackId,
          confidence: "high",
          matchedTrack: {
            id: trackId,
            title: trackTitle,
            artist: trackArtist,
            album: target.album || undefined,
            durationSeconds: target.metadata?.durationSeconds || undefined,
          },
        };
      }
    }

    // Step 2: Check existing metadata on the target
    const existingId =
      extractSpotifyTrackId(target.metadata?.spotifyTrackUrl) ||
      extractSpotifyTrackId(target.metadata?.spotifyUrl) ||
      extractSpotifyTrackId(target.metadata?.spotifyTrackId) ||
      extractSpotifyTrackId(target.metadata?.spotifyId) ||
      extractSpotifyTrackId(target.identityHints?.musicBrainzId?.startsWith("spotify:") ? target.identityHints.musicBrainzId : null) ||
      (target.provider === "plugin" && target.id.startsWith("spotify:") ? extractSpotifyTrackId(target.id) : null);

    if (existingId) {
      const canonicalUrl = buildCanonicalSpotifyTrackUrl(existingId);
      console.log(
        `[SpotifyResolver]\ntrack = ${trackTitle}\nartist = ${trackArtist}\nspotify lookup = success (existing metadata)\nspotify track id = ${existingId}\nconfidence = high`
      );
      return {
        url: canonicalUrl,
        trackId: existingId,
        confidence: "high",
        matchedTrack: {
          id: existingId,
          title: trackTitle,
          artist: trackArtist,
          album: target.album || undefined,
          durationSeconds: target.metadata?.durationSeconds || undefined,
        },
      };
    }

    // Step 3: Resolution mode execution
    if (options?.searchIfMissing === false) {
      return null;
    }

    const effectiveMode = options?.mode || this.mode || "auto";

    if (effectiveMode === "public-web") {
      return await this.searchPublicWeb(target);
    }

    if (effectiveMode === "web-api") {
      return await this.searchWebApi(target);
    }

    // "auto" mode:
    // 1. Try public web first (no credentials required)
    const publicResult = await this.searchPublicWeb(target);
    if (publicResult) {
      return publicResult;
    }

    // 2. If public web was unavailable and Web API credentials exist, try Web API
    if (this.hasApiCredentials()) {
      const apiResult = await this.searchWebApi(target);
      if (apiResult) {
        return apiResult;
      }
    }

    return null;
  }
}

