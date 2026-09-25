import type { ExternalArtworkTokenStore } from "../../domain/external-catalog.js";
import type { ExternalAlbum, ExternalArtist, ExternalTrack, MetadataAdapter } from "./MetadataAdapter.js";

type DeezerArtist = { id?: number; name?: string; picture_xl?: string; picture_big?: string };
type DeezerAlbum = { id?: number; title?: string; cover_xl?: string; cover_big?: string; artist?: DeezerArtist };
type DeezerTrack = { id?: number; title?: string; duration?: number; isrc?: string; preview?: string; artist?: DeezerArtist; album?: DeezerAlbum };

export class DeezerAdapter implements MetadataAdapter {
  readonly name = "Deezer";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: ExternalArtworkTokenStore,
    private readonly limit = 12
  ) {}

  private artwork(url: string | undefined) {
    const id = this.artworkTokens?.token(url, ["dzcdn.net"]);
    return id ? { id, url: `/api/artwork/external/${encodeURIComponent(id)}` } : null;
  }

  private async search<T>(entity: string, query: string): Promise<T[]> {
    const url = new URL(`https://api.deezer.com/search/${entity}`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(this.limit));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Deezer search failed (HTTP ${response.status})`);
    const payload = await response.json() as { data?: T[]; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message || "Deezer search failed");
    if (payload.data === undefined) return [];
    if (!Array.isArray(payload.data)) throw new Error("Deezer returned invalid search data");
    return payload.data;
  }

  async searchTracks(query: string): Promise<ExternalTrack[]> {
    const items = await this.search<DeezerTrack>("track", query);
    return items.flatMap((item): ExternalTrack[] => item.id == null ? [] : [{
      type: "track", id: `external_deezer_track_${item.id}`,
      title: item.title || "Unknown title", subtitle: item.artist?.name || null,
      artist: item.artist?.name || null, album: item.album?.title || null,
      artwork: this.artwork(item.album?.cover_xl || item.album?.cover_big),
      previewUrl: item.preview || null, provider: "external",
      source: { kind: "external", count: 0 }, availability: null,
      metadata: { durationSeconds: item.duration ?? null },
      ...(item.isrc ? { identityHints: { isrc: item.isrc } } : {}),
    }]);
  }

  async searchAlbums(query: string): Promise<ExternalAlbum[]> {
    const items = await this.search<DeezerAlbum>("album", query);
    return items.flatMap((item): ExternalAlbum[] => item.id == null ? [] : [{
      type: "album", id: `external_deezer_album_${item.id}`,
      title: item.title || "Unknown album", subtitle: item.artist?.name || null,
      artist: item.artist?.name || null, album: null,
      artwork: this.artwork(item.cover_xl || item.cover_big),
      provider: "external", source: { kind: "external", count: 0 },
      availability: null, metadata: {},
    }]);
  }

  async searchArtists(query: string): Promise<ExternalArtist[]> {
    const items = await this.search<DeezerArtist>("artist", query);
    return items.flatMap((item): ExternalArtist[] => item.id == null ? [] : [{
      type: "artist", id: `external_deezer_artist_${item.id}`,
      title: item.name || query, subtitle: "Artist", artist: item.name || query,
      album: null, artwork: this.artwork(item.picture_xl || item.picture_big),
      provider: "external", source: { kind: "external", count: 0 },
      availability: null, metadata: {},
    }]);
  }

  async getArtistDetails(artistName: string): Promise<ExternalArtist | null> {
    const items = await this.searchArtists(artistName);
    return items.find((artist) => artist.title.toLocaleLowerCase() === artistName.toLocaleLowerCase()) || null;
  }
}
