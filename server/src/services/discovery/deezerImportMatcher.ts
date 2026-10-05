import type { SpotifyImportTrackMetadata } from "../../domain/downloader-adapter.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isrcKey = (value?: string) => (value || "").replace(/-/g, "").toUpperCase();

export type DeezerImportMatch = { track: SpotifyImportTrackMetadata | null; detail: string };

/** Metadata only: Deezer preview URLs must never become full-song download inputs. */
export class DeezerImportMatcher {
  private readonly cache = new Map<string, { expires: number; value: DeezerImportMatch }>();
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async match(source: SpotifyImportTrackMetadata, signal: AbortSignal): Promise<DeezerImportMatch> {
    const key = JSON.stringify([isrcKey(source.isrc), normalize(source.artist), normalize(source.title), source.duration]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      const value = structuredClone(cached.value);
      if (value.track) value.track = { ...value.track, url: source.url, position: source.position };
      return value;
    }
    const read = async (endpoint: string | URL): Promise<Json> => {
      const response = await this.fetchImpl(endpoint, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: "error",
      });
      if (!response.ok) throw new Error(`Deezer returned HTTP ${response.status}`);
      const data = object(await response.json());
      if (data.error) throw new Error("Deezer metadata lookup failed");
      return data;
    };
    const parse = (raw: Json): SpotifyImportTrackMetadata => {
      const artist = object(raw.artist); const album = object(raw.album);
      const contributors = Array.isArray(raw.contributors) ? raw.contributors.map((entry) => string(object(entry).name)).filter(Boolean) : [];
      const artwork = string(album.cover_xl) || string(album.cover_big);
      return { position: source.position, url: source.url, title: string(raw.title), artist: string(artist.name),
        artists: [...new Set([string(artist.name), ...contributors].filter(Boolean))],
        duration: typeof raw.duration === "number" ? raw.duration : 0,
        album: string(album.title), albumArtist: string(artist.name), year: string(raw.release_date),
        artworkUrl: /^https:\/\//.test(artwork) ? artwork : undefined, isrc: string(raw.isrc) || undefined };
    };
    const valid = (candidate: SpotifyImportTrackMetadata): boolean => {
      // Preserve version qualifiers: an Edit, live recording or remix is a separate recording.
      const sameTitle = normalize(source.title) === normalize(candidate.title);
      const sameArtist = normalize(candidate.artist) === normalize(source.artist);
      const sameDuration = source.duration > 0 && candidate.duration > 0 && Math.abs(source.duration - candidate.duration) <= 4;
      const sameIsrc = !source.isrc || !candidate.isrc || isrcKey(source.isrc) === isrcKey(candidate.isrc);
      return sameTitle && sameArtist && sameDuration && sameIsrc;
    };
    let result: DeezerImportMatch = { track: null, detail: "No matching Deezer recording; retained Spotify metadata" };
    const remember = () => {
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + (result.track ? 24 * 60 * 60_000 : 5 * 60_000), value: structuredClone(result) });
      return result;
    };
    try {
      if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrcKey(source.isrc))) {
        try {
          const candidate = parse(await read(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrcKey(source.isrc))}`));
          if (valid(candidate) && isrcKey(candidate.isrc) === isrcKey(source.isrc)) {
            result = { track: candidate, detail: "Matched Deezer by ISRC" }; return remember();
          }
        } catch (error) { if (signal.aborted) throw error; /* Continue with the independent title search. */ }
      }
      if (!source.artist.trim() || !source.title.trim() || source.duration <= 0) return remember();
      const endpoint = new URL("https://api.deezer.com/search");
      endpoint.searchParams.set("q", `${source.artist} ${source.title}`); endpoint.searchParams.set("limit", "10");
      const response = await read(endpoint);
      const candidates = Array.isArray(response.data) ? response.data.slice(0, 10) : [];
      for (const raw of candidates) {
        const item = object(raw); const candidate = parse(item);
        if (!valid(candidate) || !/^\d+$/.test(String(item.id))) continue;
        const full = parse(await read(`https://api.deezer.com/track/${encodeURIComponent(String(item.id))}`));
        if (valid(full)) { result = { track: full, detail: "Matched Deezer by artist, title and duration" }; break; }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      result = { track: null, detail: error instanceof Error ? error.message : "Deezer unavailable; retained Spotify metadata" };
    }
    return remember();
  }
}
