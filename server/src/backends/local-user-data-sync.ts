import type { Playlist, Track } from "../types.js";
import type { MusicBackend, MusicProvider } from "./music-backend.js";
import { hasUserDataSync } from "./user-data-sync.js";

/**
 * Adapt a provider that does not implement provider-side user-data sync
 * (e.g. Jellyfin) into the `MusicBackend` shape the current routes and
 * services consume.
 *
 * MusicDeck already treats provider-side playlist/favorite sync as
 * best-effort — favorites live in MusicDeck's own database, and
 * PlaylistService wraps every remote call in try/catch and keeps its local
 * state authoritative. So the correct behavior for a sync-less backend is
 * "no remote mirror", not "refuse to start". These methods therefore report
 * an empty remote state and accept writes as local-only no-ops, keeping
 * catalog browsing and streaming fully functional.
 */
export function withLocalUserDataSync(provider: MusicProvider): MusicBackend {
  if (hasUserDataSync(provider)) {
    return provider as MusicBackend;
  }

  const localOnly: Record<string, unknown> = {
    async listFavoriteTracks(): Promise<Track[]> {
      return [];
    },
    async setTrackFavorite(): Promise<void> {},
    async listPlaylists(): Promise<Playlist[]> {
      return [];
    },
    async createPlaylist(): Promise<Playlist | null> {
      return null;
    },
    async getPlaylist(): Promise<Playlist | null> {
      return null;
    },
    async updatePlaylist(): Promise<Playlist | null> {
      return null;
    },
    async deletePlaylist(): Promise<void> {},
    async addTrackToPlaylist(): Promise<{ added: boolean }> {
      return { added: false };
    },
    async removePlaylistItem(): Promise<void> {},
    async reorderPlaylistTracks(): Promise<Playlist | null> {
      return null;
    },
  };

  // A Proxy keeps the underlying provider instance intact (including its
  // own private state and prototype methods) and only supplies the missing
  // user-data-sync methods.
  return new Proxy(provider as object, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      return localOnly[property as string];
    },
    has(target, property) {
      return property in target || property in localOnly;
    },
  }) as MusicBackend;
}
