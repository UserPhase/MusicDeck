import type { Album, Artist, Track } from "../types.js";

export type SearchResult = {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
};

/**
 * Catalog capability: answers "what music exists?" using MusicDeck domain
 * models. Provider-specific payloads (Subsonic, Jellyfin, etc.) must be
 * mapped inside the provider implementation.
 */
export interface CatalogProvider {
  listAlbums(limit?: number): Promise<Album[]>;
  getAlbum(albumId: string): Promise<Album | null>;
  getAlbumTracks(albumId: string): Promise<Track[]>;
  listArtists(): Promise<Artist[]>;
  getArtist(artistId: string, options?: { includeArtistInfo?: boolean }): Promise<Artist | null>;
  getArtistAlbums(artistId: string): Promise<Album[]>;
  getArtistTracks(artistId: string): Promise<Track[]>;
  /** Bounded artist-page preview; providers must filter by the exact artist ID. */
  getArtistTopTracks?(artistId: string, limit: number): Promise<Track[]>;
  listTracks(): Promise<Track[]>;
  getTrack(trackId: string): Promise<Track | null>;
  /** Optional provider-native metadata used by the Now Playing context panel. */
  getLyrics?(trackId: string): Promise<string | null>;
  getArtistBiographyForTrack?(trackId: string): Promise<string | null>;
  search(query: string, types?: string[]): Promise<SearchResult>;
  getRandomTracks(limit?: number): Promise<Track[]>;
  getRandomAlbums(limit?: number): Promise<Album[]>;
  scanLibrary?(): Promise<{ count?: number; scanning?: boolean }>;
}
