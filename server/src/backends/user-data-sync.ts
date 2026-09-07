import type { Playlist, Track } from "../types.js";

/**
 * Optional provider-side user-data synchronization capability.
 *
 * Not every provider can or should store user state (favorites, playlists)
 * remotely. Providers implement this only when the capability is genuinely
 * supported; callers must check with `hasUserDataSync` instead of assuming
 * the methods exist.
 */
export interface UserDataSync {
  listFavoriteTracks(): Promise<Track[]>;
  setTrackFavorite(trackId: string, liked: boolean): Promise<void>;
  listPlaylists(): Promise<Playlist[]>;
  createPlaylist(name: string): Promise<Playlist | null>;
  getPlaylist(playlistId: string): Promise<Playlist | null>;
  updatePlaylist(playlistId: string, input: { name?: string; description?: string | null }): Promise<Playlist | null>;
  deletePlaylist(playlistId: string): Promise<void>;
  addTrackToPlaylist(playlistId: string, trackId: string): Promise<{ added: boolean }>;
  removePlaylistItem(playlistId: string, playlistItemId: string): Promise<void>;
  reorderPlaylistTracks(playlistId: string, trackIds: string[]): Promise<Playlist | null>;
}

/** Simple structural capability check for optional user-data sync. */
export function hasUserDataSync(provider: unknown): provider is UserDataSync {
  const candidate = provider as Partial<UserDataSync> | null | undefined;

  return Boolean(
    candidate
      && typeof candidate.setTrackFavorite === "function"
      && typeof candidate.listFavoriteTracks === "function"
      && typeof candidate.listPlaylists === "function"
      && typeof candidate.createPlaylist === "function"
  );
}
