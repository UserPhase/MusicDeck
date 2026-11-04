import { DeezerDiscoveryService, normalizeDeezerChart,
  type ExternalArtist, type ExternalAlbum, type ExternalTrack, type ExternalCharts } from "../../domain/deezer-discovery.js";
import { normalizeDiscoveryText } from "./discoveryIdentity.js";
import { currentPrivacyManager, gateFetch, privacyFetch } from "../PrivacyManager.js";

export interface DiscoveryCatalog {
  searchArtist(name: string): Promise<ExternalArtist | null>;
  related(artist: ExternalArtist): Promise<ExternalArtist[]>;
  tracks(artist: ExternalArtist): Promise<ExternalTrack[]>;
  albums(artist: ExternalArtist): Promise<ExternalAlbum[]>;
  charts(): Promise<ExternalCharts>;
}

function page(kind: keyof ExternalCharts, payload: unknown, artist?: ExternalArtist): ExternalCharts {
  const result: ExternalCharts = { artists: [], albums: [], tracks: [] };
  const data = payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data) ? payload.data : [];
  for (const raw of data.slice(0, 30)) {
    const row = artist && raw && typeof raw === "object"
      ? { ...raw, artist: { id: Number(artist.id.split("_").at(-1)), name: artist.name } } : raw;
    try {
      const normalized = normalizeDeezerChart({ artists: { data: [] }, albums: { data: [] }, tracks: { data: [] }, [kind]: { data: [row] } });
      result.artists.push(...normalized.artists);
      result.albums.push(...normalized.albums);
      result.tracks.push(...normalized.tracks);
    } catch { /* A malformed item cannot discard the other valid candidates. */ }
  }
  return result;
}

/** Shared public metadata cache: no listening history or account data lives
 * here. Two requests at a time, bounded queues, timeouts and negative caching
 * keep discovery inexpensive even when providers are slow or unavailable. */
export class DeezerDiscoveryCatalog implements DiscoveryCatalog {
  private readonly fetcher: typeof fetch;
  private readonly cache = new Map<string, { value: unknown; expires: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, number>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(fetcher: typeof fetch = privacyFetch,
    private readonly chartService = new DeezerDiscoveryService(fetcher),
    private readonly now = Date.now) {
    this.fetcher = gateFetch(fetcher, "metadata");
  }

  private async slot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) {
      if (this.waiting.length >= 32) throw new Error("Discovery is busy");
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(ready);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("Discovery request queue timed out"));
        }, 12_000);
        this.waiting.push(ready);
      });
    } else this.active++;
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async read(path: string): Promise<unknown> {
    // Check the policy even on a cache hit or an already-coalesced request.
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    const cached = this.cache.get(path);
    if (cached && cached.expires > this.now()) return cached.value;
    if ((this.failures.get(path) || 0) > this.now()) {
      if (cached && cached.expires + 7 * 86_400_000 > this.now()) return cached.value;
      throw new Error("External discovery is temporarily unavailable");
    }
    const pending = this.pending.get(path);
    if (pending) return pending;
    const request = this.slot(async () => {
      const response = await this.fetcher(`https://api.deezer.com${path}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error("External discovery request failed");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || "error" in value) throw new Error("Invalid discovery response");
      this.cache.delete(path);
      this.cache.set(path, { value, expires: this.now() + 6 * 60 * 60_000 });
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      this.failures.delete(path);
      return value;
    }).catch((error: unknown) => {
      this.failures.set(path, this.now() + 60_000);
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
      if (cached && cached.expires + 7 * 86_400_000 > this.now()) return cached.value;
      throw error;
    }).finally(() => { this.pending.delete(path); });
    this.pending.set(path, request);
    return request;
  }
  private id(artist: ExternalArtist): string {
    const id = /^external_deezer_artist_([0-9]+)$/.exec(artist.id)?.[1];
    if (!id) throw new Error("Invalid discovery artist ID");
    return id;
  }
  async searchArtist(name: string): Promise<ExternalArtist | null> {
    const payload = await this.read(`/search/artist?${new URLSearchParams({ q: name, limit: "5" })}`);
    return page("artists", payload).artists.find((artist) => normalizeDiscoveryText(artist.name) === normalizeDiscoveryText(name)) || null;
  }
  async related(artist: ExternalArtist): Promise<ExternalArtist[]> {
    return page("artists", await this.read(`/artist/${this.id(artist)}/related?limit=20`)).artists;
  }
  async tracks(artist: ExternalArtist): Promise<ExternalTrack[]> {
    return page("tracks", await this.read(`/artist/${this.id(artist)}/top?limit=30`)).tracks;
  }
  async albums(artist: ExternalArtist): Promise<ExternalAlbum[]> {
    return page("albums", await this.read(`/artist/${this.id(artist)}/albums?limit=20`), artist).albums;
  }
  async charts(): Promise<ExternalCharts> {
    currentPrivacyManager()?.assertExternalAllowed("metadata");
    return this.chartService.getCharts();
  }
}
