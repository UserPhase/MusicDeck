import { controlPlaylistParty, startPlaylistParty } from "../../api/playlistCollaboration";
export function partyRequestKey(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure browser randomness is unavailable. Use a current browser to open party requests.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function partyDeviceId(): string {
  try { const old = sessionStorage.getItem("musicdeck:party-device"); if (old && /^[a-f0-9-]{36}$/.test(old)) return old;
    const id = partyRequestKey(); sessionStorage.setItem("musicdeck:party-device", id); return id; } catch { return fallbackDevice ?? (fallbackDevice = partyRequestKey()); }
}
let fallbackDevice: string | null = null;
interface HostSnapshot { ownerId: string | null; playlistId: string | null; error: string }
let state: HostSnapshot = { ownerId: null, playlistId: null, error: "" };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null, request: AbortController | null = null, generation = 0;
const publish = (patch: Partial<HostSnapshot>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const key = (owner: string) => `musicdeck:party-host:${owner}`;
const remember = () => { if (state.ownerId) try { if (state.playlistId) sessionStorage.setItem(key(state.ownerId), state.playlistId); else sessionStorage.removeItem(key(state.ownerId)); } catch { /* Hosting still works for this page lifetime. */ } };
async function heartbeat() {
  if (!state.ownerId || !state.playlistId) return;
  const owner = state.ownerId, playlist = state.playlistId, version = generation;
  const active = new AbortController(); request?.abort(); request = active;
  try {
    await controlPlaylistParty(playlist, owner, partyDeviceId(), "heartbeat", undefined, active.signal);
    if (!active.signal.aborted && version === generation) publish({ error: "" });
  } catch (error) {
    if (!active.signal.aborted && version === generation) {
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      publish({ error: error instanceof Error ? error.message : "Party queue connection lost.",
        ...([401, 403, 404, 409].includes(Number(status)) ? { playlistId: null } : {}) }); remember();
    }
  } finally {
    if (version === generation && !active.signal.aborted && state.playlistId === playlist) timer = setTimeout(() => void heartbeat(), 20_000);
  }
}
export const partyHost = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  activate(ownerId: string | null) {
    if (state.ownerId === ownerId) return;
    generation++; request?.abort(); if (timer) clearTimeout(timer); timer = null;
    let playlistId: string | null = null;
    if (ownerId) try { playlistId = sessionStorage.getItem(key(ownerId)); } catch { /* No saved hosting state. */ }
    publish({ ownerId, playlistId, error: "" }); if (playlistId) void heartbeat();
  },
  async start(playlistId: string, ownerId: string, signal: AbortSignal) {
    if (state.ownerId !== ownerId) throw new Error("Your signed-in account changed.");
    if (state.playlistId && state.playlistId !== playlistId) throw new Error("Close the party queue you are already hosting before opening another.");
    const result = await startPlaylistParty(playlistId, ownerId, partyDeviceId(), signal);
    if (signal.aborted || state.ownerId !== ownerId) return result;
    generation++; request?.abort(); if (timer) clearTimeout(timer);
    publish({ playlistId, error: "" }); remember(); timer = setTimeout(() => void heartbeat(), 20_000); return result;
  },
  async close(playlistId: string, ownerId: string, signal: AbortSignal) {
    try { await controlPlaylistParty(playlistId, ownerId, partyDeviceId(), "close", undefined, signal); }
    catch (error) { if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409) throw error; }
    if (signal.aborted || state.ownerId !== ownerId || state.playlistId !== playlistId) return;
    generation++; request?.abort(); if (timer) clearTimeout(timer); timer = null;
    publish({ playlistId: null, error: "" }); remember();
  },
};
