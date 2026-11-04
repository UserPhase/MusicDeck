import { request } from "./musicdeck";
export type ArtistProvider = "library" | "deezer" | "itunes";
export interface FollowedArtist {
  key: string; artistId: string; artistName: string; provider: ArtistProvider;
  followedAt: string; checkedAt: string | null; nextScanAt: string; error: string | null;
}
export interface NewRelease {
  id: string; provider: "deezer" | "itunes"; providerId: string; title: string; artist: string;
  artistId: string; releaseDate: string; albumType: "Album" | "EP" | "Single";
  coverUrl: string | null; storeUrl: string | null; trackCount: number;
}
export interface ReleaseFeed { releases: NewRelease[]; artists: FollowedArtist[]; hasMore: boolean }
export async function getReleaseFeed(offset = 0, limit = 30, signal?: AbortSignal): Promise<ReleaseFeed> {
  return request(`/api/v1/new-releases?offset=${offset}&limit=${limit}`, { signal });
}
export async function getArtistFollows(signal?: AbortSignal): Promise<{ artists: FollowedArtist[] }> {
  return request("/api/v1/artist-follows", { signal });
}
export async function followArtist(ownerId: string, artistId: string, artistName: string, provider: ArtistProvider, signal?: AbortSignal): Promise<{ artist: FollowedArtist }> {
  return request("/api/v1/artist-follows", { method: "POST", body: JSON.stringify({ ownerId, artistId, artistName, provider }), signal });
}
export async function unfollowArtist(ownerId: string, key: string, signal?: AbortSignal): Promise<null> {
  return request(`/api/v1/artist-follows/${encodeURIComponent(key)}`, { method: "DELETE", body: JSON.stringify({ ownerId }), signal });
}
export async function scanReleases(signal?: AbortSignal): Promise<{ taskId: string }> {
  return request("/api/v1/new-releases/scan", { method: "POST", signal });
}
export const followsChanged = () => window.dispatchEvent(new Event("musicdeck:artist-follows-changed"));
