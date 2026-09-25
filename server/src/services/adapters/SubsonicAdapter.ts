import type { CatalogService } from "../../domain/catalog.js";
import { toAlbumSearchResult, toArtistSearchResult, toTrackSearchResult } from "../../domain/search.js";
import { toSearchGroups, type SearchGroups } from "../../domain/search.js";
import type { ExternalAlbum, ExternalArtist, ExternalTrack, MetadataAdapter } from "./MetadataAdapter.js";

/** Uses MusicDeck's catalog aggregator, so Navidrome and Jellyfin IDs remain stable. */
export class SubsonicAdapter implements MetadataAdapter {
  readonly name = "Subsonic";

  constructor(private readonly catalog: CatalogService) {}

  async searchAll(query: string, types?: string[]): Promise<SearchGroups> {
    return toSearchGroups(await this.catalog.search(query, types), []);
  }

  async searchTracks(query: string): Promise<ExternalTrack[]> {
    const found = await this.catalog.search(query, ["tracks"]);
    return found.tracks.map((track) => toTrackSearchResult(track) as ExternalTrack);
  }

  async searchAlbums(query: string): Promise<ExternalAlbum[]> {
    const found = await this.catalog.search(query, ["albums"]);
    return found.albums.map((album) => toAlbumSearchResult(album) as ExternalAlbum);
  }

  async getArtistDetails(artistName: string): Promise<ExternalArtist | null> {
    const found = await this.catalog.search(artistName, ["artists"]);
    const exact = found.artists.find((artist) => artist.name.toLocaleLowerCase() === artistName.toLocaleLowerCase());
    return exact ? toArtistSearchResult(exact) as ExternalArtist : null;
  }
}
