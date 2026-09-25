import type { ExternalArtworkTokenStore } from "../../domain/external-catalog.js";
import type { ExternalAlbum, ExternalArtist, ExternalTrack, MetadataAdapter } from "./MetadataAdapter.js";

type ItunesItem = {
  trackId?: number; collectionId?: number; artistId?: number;
  trackName?: string; collectionName?: string; artistName?: string;
  trackTimeMillis?: number; artworkUrl100?: string; previewUrl?: string;
};

export class iTunesAdapter implements MetadataAdapter {
  readonly name = "iTunes";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly artworkTokens?: ExternalArtworkTokenStore,
    private readonly limit = 15
  ) {}

  private artwork(url: string | undefined) {
    const large = url?.replace(/100x100bb\.(jpg|png)/i, "1000x1000bb.$1");
    const id = this.artworkTokens?.token(large, ["mzstatic.com"]);
    return id ? { id, url: `/api/artwork/external/${encodeURIComponent(id)}` } : null;
  }

  private async search(entity: "song" | "album" | "musicArtist", query: string): Promise<ItunesItem[]> {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", query);
    url.searchParams.set("entity", entity);
    url.searchParams.set("limit", String(this.limit));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`iTunes search failed (HTTP ${response.status})`);
    const payload = await response.json() as { results?: ItunesItem[] };
    if (!Array.isArray(payload.results)) throw new Error("iTunes returned invalid search data");
    return payload.results;
  }

  async searchTracks(query: string): Promise<ExternalTrack[]> {
    const items = await this.search("song", query);
    return items.flatMap((item): ExternalTrack[] => item.trackId == null || !item.trackName ? [] : [{
      type: "track", id: `external_itunes_${item.trackId}`,
      title: item.trackName, subtitle: item.artistName || null,
      artist: item.artistName || null, album: item.collectionName || null,
      artwork: this.artwork(item.artworkUrl100), previewUrl: item.previewUrl || null,
      provider: "external", source: { kind: "external", count: 0, externalAvailable: true },
      availability: null,
      metadata: { durationSeconds: item.trackTimeMillis == null ? null : Math.round(item.trackTimeMillis / 1000), itunesTrackId: item.trackId },
    }]);
  }

  async searchAlbums(query: string): Promise<ExternalAlbum[]> {
    const items = await this.search("album", query);
    return items.flatMap((item): ExternalAlbum[] => item.collectionId == null || !item.collectionName ? [] : [{
      type: "album", id: `external_itunes_album_${item.collectionId}`,
      title: item.collectionName, subtitle: item.artistName || null,
      artist: item.artistName || null, album: null,
      artwork: this.artwork(item.artworkUrl100), provider: "external",
      source: { kind: "external", count: 0 }, availability: null, metadata: {},
    }]);
  }

  async searchArtists(query: string): Promise<ExternalArtist[]> {
    const items = await this.search("musicArtist", query);
    return items.flatMap((item): ExternalArtist[] => item.artistId == null ? [] : [{
      type: "artist", id: `external_itunes_artist_${item.artistId}`,
      title: item.artistName || query, subtitle: "Artist", artist: item.artistName || query,
      album: null, artwork: null, provider: "external",
      source: { kind: "external", count: 0 }, availability: null, metadata: {},
    }]);
  }

  async getArtistDetails(artistName: string): Promise<ExternalArtist | null> {
    const items = await this.searchArtists(artistName);
    return items.find((artist) => artist.title.toLocaleLowerCase() === artistName.toLocaleLowerCase()) || null;
  }
}
