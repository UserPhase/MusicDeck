import type { SearchGroups, UnifiedSearchResult } from "../../domain/search.js";

export type ExternalTrack = UnifiedSearchResult & { type: "track" };
export type ExternalAlbum = UnifiedSearchResult & { type: "album" };
export type ExternalArtist = UnifiedSearchResult & { type: "artist" };

/** Provider-neutral search contract. Local and keyless providers share one read model. */
export interface MetadataAdapter {
  readonly name: string;
  searchTracks(query: string): Promise<ExternalTrack[]>;
  searchAlbums(query: string): Promise<ExternalAlbum[]>;
  getArtistDetails(artistName: string): Promise<ExternalArtist | null>;
  searchArtists?(query: string): Promise<ExternalArtist[]>;
  searchAll?(query: string, types?: string[]): Promise<SearchGroups>;
}
