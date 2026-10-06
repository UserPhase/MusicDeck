import { z } from "zod";
import { normalizeExternalTrack } from "../services/discovery/externalTrackNormalizer.js";

const artwork = z.string().url().nullable().optional();
const artist = z.object({
  id: z.number().int(),
  name: z.string(),
  link: z.string().url().optional(),
  picture_xl: artwork,
  picture_big: artwork,
  picture_medium: artwork,
});
const album = z.object({
  id: z.number().int(),
  title: z.string(),
  link: z.string().url().optional(),
  cover_xl: artwork,
  cover_big: artwork,
  cover_medium: artwork,
  artist: artist.nullable().optional(),
});
const track = z.object({
  id: z.number().int(),
  title: z.string(),
  link: z.string().url().optional(),
  duration: z.number().int().nonnegative(),
  preview: z.string().nullable().optional(),
  preview_url: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
  audio_preview_url: z.string().nullable().optional(),
  isrc: z.string().nullable().optional(),
  artist: artist.nullable().optional(),
  album: album.nullable().optional(),
}).passthrough();
const chart = z.object({
  tracks: z.object({ data: z.array(track) }),
  albums: z.object({ data: z.array(album) }),
  artists: z.object({ data: z.array(artist) }),
});

export type DeezerArtist = z.infer<typeof artist>;
export type DeezerAlbum = z.infer<typeof album>;
export type DeezerTrack = z.infer<typeof track>;
export type DeezerChart = z.infer<typeof chart>;

type CoverArt = { url: string } | null;
type ExternalBase = {
  id: string;
  external: true;
  provider: "deezer";
  source: { kind: "external"; count: 0 };
  deezerUrl: string | null;
  coverArt: CoverArt;
};
export type ExternalArtist = ExternalBase & { type: "artist"; name: string };
export type ExternalAlbum = ExternalBase & { type: "album"; title: string; artist: string };
export type ExternalTrack = ExternalBase & {
  type: "track";
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  isrc: string | null;
  duration: number;
  durationLabel: string;
  metadata: { durationSeconds: number; artistId?: string | null; albumId?: string | null; isrc?: string | null };
};
export type ExternalCharts = { artists: ExternalArtist[]; albums: ExternalAlbum[]; tracks: ExternalTrack[] };

function coverArt(...candidates: (string | null | undefined)[]): CoverArt {
  const url = candidates.find((value) => value?.startsWith("https://"));
  return url ? { url } : null;
}

function base(id: number, kind: "artist" | "album" | "track", url: string | undefined, image: CoverArt): ExternalBase {
  return {
    // Keep chart entities compatible with the detail catalog route. A chart
    // artist must be navigable even when it has no local-library counterpart.
    id: `external_deezer_${kind}_${id}`,
    external: true,
    provider: "deezer",
    source: { kind: "external", count: 0 },
    deezerUrl: url || null,
    coverArt: image,
  };
}

export function normalizeDeezerChart(input: unknown): ExternalCharts {
  const data: DeezerChart = chart.parse(input);
  return {
    artists: data.artists.data.map((item): ExternalArtist => ({
      ...base(item.id, "artist", item.link, coverArt(item.picture_xl, item.picture_big, item.picture_medium)),
      type: "artist",
      name: item.name,
    })),
    albums: data.albums.data.map((item): ExternalAlbum => ({
      ...base(item.id, "album", item.link, coverArt(item.cover_xl, item.cover_big, item.cover_medium)),
      type: "album",
      title: item.title,
      artist: item.artist?.name || "Unknown artist",
    })),
    tracks: data.tracks.data.map((item): ExternalTrack => {
      const image = coverArt(item.album?.cover_xl, item.album?.cover_big, item.album?.cover_medium);
      const normalized = normalizeExternalTrack({
        ...item,
        id: `external_deezer_track_${item.id}`,
        artist: item.artist?.name,
        album: item.album?.title,
        coverArt: image,
      });
      if (!normalized) throw new Error("Deezer returned an invalid chart track");
      return {
        ...base(item.id, "track", item.link, image),
        ...normalized,
        id: `external_deezer_track_${item.id}`,
        source: { kind: "external", count: 0 },
        coverArt: image,
        type: "track",
        duration: item.duration,
        durationLabel: `${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, "0")}`,
        metadata: {
          durationSeconds: item.duration,
          artistId: item.artist?.id != null ? `external_deezer_artist_${item.artist.id}` : null,
          albumId: item.album?.id != null ? `external_deezer_album_${item.album.id}` : null,
          ...(normalized.isrc ? { isrc: normalized.isrc } : {}),
        },
      };
    }),
  };
}

const CHART_URL = "https://api.deezer.com/chart?limit=14";
const CACHE_MS = 10 * 60 * 1000;

export class DeezerDiscoveryService {
  private cache: { value: ExternalCharts; expiresAt: number } | null = null;
  private pending: Promise<ExternalCharts> | null = null;

  constructor(private readonly fetchChart: typeof fetch = fetch) {}

  async getCharts(): Promise<ExternalCharts> {
    if (this.cache && Date.now() < this.cache.expiresAt) return this.cache.value;
    if (this.pending) return this.pending;

    this.pending = this.loadCharts();
    try {
      return await this.pending;
    } catch (error) {
      if (this.cache) return this.cache.value;
      throw error;
    } finally {
      this.pending = null;
    }
  }

  private async loadCharts(): Promise<ExternalCharts> {
    const response = await this.fetchChart(CHART_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Deezer chart request failed (${response.status})`);
    const normalized = normalizeDeezerChart(await response.json());
    this.cache = { value: normalized, expiresAt: Date.now() + CACHE_MS };
    return normalized;
  }
}
