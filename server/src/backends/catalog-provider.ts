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
  getArtist(artistId: string): Promise<Artist | null>;
  getArtistAlbums(artistId: string): Promise<Album[]>;
  getArtistTracks(artistId: string): Promise<Track[]>;
  listTracks(): Promise<Track[]>;
  getTrack(trackId: string): Promise<Track | null>;
  search(query: string, types?: string[]): Promise<SearchResult>;
  getRandomTracks(limit?: number): Promise<Track[]>;
  getRandomAlbums(limit?: number): Promise<Album[]>;
  scanLibrary?(): Promise<{ count?: number; scanning?: boolean }>;
}
