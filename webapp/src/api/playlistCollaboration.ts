import { request as apiRequest } from "./musicdeck";
async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController(), source = options.signal;
  const cancel = () => controller.abort(source?.reason);
  if (source?.aborted) cancel(); else source?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("MusicDeck did not respond in time. Check your connection and retry.")), 30_000);
  try { return await apiRequest(path, { ...options, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted && !source?.aborted) throw Object.assign(new Error("MusicDeck did not respond in time. Check your connection and retry."), { status: 0 });
    throw error;
  } finally { clearTimeout(timeout); source?.removeEventListener("abort", cancel); }
}
export type PlaylistVisibility = "PRIVATE" | "SHARED_READ" | "COLLABORATIVE" | "PUBLIC_SERVER";
export type CollaboratorRole = "VIEWER" | "COLLABORATOR";
export interface HouseholdUser { id: string; username: string; displayName: string; avatarUrl: string | null }
export interface PlaylistGrant { userId: string; role: CollaboratorRole; username: string; displayName: string; avatarUrl: string | null; disabled?: boolean }
export interface SharingState { playlistId: string; mode: PlaylistVisibility; revision: number; ownerUserId: string | null;
  grants: PlaylistGrant[]; links: { id: string; recipientUserId: string | null; recipientName: string | null; expiresAt: number }[] }
const path = (id: string) => `/api/v1/playlists/${encodeURIComponent(id)}`;
export const getPlaylistSharing = async (id: string, signal?: AbortSignal): Promise<SharingState> => request(`${path(id)}/sharing`, { signal });
export const searchSharingUsers = async (id: string, query: string, signal?: AbortSignal): Promise<{ users: HouseholdUser[] }> =>
  request(`${path(id)}/sharing/users?q=${encodeURIComponent(query)}`, { signal });
export const savePlaylistSharing = async (id: string, ownerId: string, revision: number, mode: PlaylistVisibility,
  grants: Pick<PlaylistGrant, "userId" | "role">[], signal?: AbortSignal): Promise<SharingState> =>
  request(`${path(id)}/sharing`, { method: "PUT", body: JSON.stringify({ ownerId, revision, mode, grants }), signal });
export const createPlaylistInvitation = async (id: string, ownerId: string, recipientUserId: string | null, signal?: AbortSignal): Promise<{ id: string; token: string; expiresAt: number }> =>
  request(`${path(id)}/sharing/links`, { method: "POST", body: JSON.stringify({ ownerId, recipientUserId }), signal });
export const revokePlaylistInvitation = async (id: string, ownerId: string, linkId: string, signal?: AbortSignal): Promise<null> =>
  request(`${path(id)}/sharing/links/${encodeURIComponent(linkId)}`, { method: "DELETE", body: JSON.stringify({ ownerId }), signal });
export const resolvePlaylistInvitation = async (token: string, signal?: AbortSignal): Promise<{ playlistId: string }> =>
  request("/api/v1/playlist-shares/resolve", { method: "POST", body: JSON.stringify({ token }), signal });
export interface PartyRequest { id: string; trackId: string; requestedByUserId: string | null; requestedBy: string | null; createdAt: number; track: Record<string, unknown> | null }
export interface PartyState { party: { id: string; isHost: boolean; expiresAt: number } | null; requests: PartyRequest[] }
export const getPartyState = async (id: string, deviceId: string, signal?: AbortSignal): Promise<PartyState> => request(`${path(id)}/party?deviceId=${encodeURIComponent(deviceId)}`, { signal });
export const startPlaylistParty = async (id: string, ownerId: string, deviceId: string, signal?: AbortSignal): Promise<{ id: string; expiresAt: number }> =>
  request(`${path(id)}/party`, { method: "POST", body: JSON.stringify({ ownerId, deviceId }), signal });
export const controlPlaylistParty = async (id: string, ownerId: string, deviceId: string, action: "heartbeat" | "close" | "QUEUED" | "DISMISSED", requestId?: string, signal?: AbortSignal): Promise<{ ok: true }> =>
  request(`${path(id)}/party/control`, { method: "POST", body: JSON.stringify({ ownerId, deviceId, action, requestId }), signal });
export const requestPartyTrack = async (id: string, ownerId: string, trackId: string, idempotencyKey: string, signal?: AbortSignal): Promise<{ id: string; state: string }> =>
  request(`${path(id)}/party/requests`, { method: "POST", body: JSON.stringify({ ownerId, trackId, idempotencyKey }), signal });
