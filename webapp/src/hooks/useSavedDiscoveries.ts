import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getSavedDiscoveries, removeSavedDiscovery, saveDiscovery } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import type { ExternalItemKind, ExternalMetadataItem } from "../services/externalActions";

export interface SavedDiscovery {
  id: string;
  provider: "deezer" | "itunes";
  external_id: string;
  type: ExternalItemKind;
  title: string;
  artist: string;
  cover_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  inLibrary?: boolean;
  status?: "IDLE" | "QUEUED" | "IMPORTING" | "IN_LIBRARY" | "FAILED" | "UNKNOWN";
  error?: string | null;
}

type SaveInput = Omit<SavedDiscovery, "id" | "created_at" | "inLibrary" | "status" | "error">;
type Snapshot = { items: SavedDiscovery[]; loading: boolean; error: string | null; warning: string | null };
type Dependencies = {
  list(): Promise<{ discoveries: SavedDiscovery[]; warning?: string | null }>;
  save(input: SaveInput): Promise<{ discovery: SavedDiscovery }>;
  remove(id: string): Promise<unknown>;
};

/** Provider IDs are normalized once for bookmark identity and reconstructed for imports. */
export function discoveryInput(kind: ExternalItemKind, item: ExternalMetadataItem): SaveInput | null {
  const prefixed = /^external_(deezer|itunes)_(track|album)_(.+)$/.exec(item.id);
  const provider = prefixed?.[1] || item.provider;
  if (provider !== "deezer" && provider !== "itunes") return null;
  if (prefixed && prefixed[2] !== kind) return null;
  const source = item as ExternalMetadataItem & {
    coverUrl?: string | null; coverArt?: { url?: string } | string | null;
    artwork?: { url?: string } | null; previewUrl?: string | null; isrc?: string | null;
    identityHints?: { isrc?: string | null } | null;
    songCount?: number; trackCount?: number;
  };
  const artwork = typeof source.coverArt === "object" ? source.coverArt?.url : null;
  return {
    provider, external_id: prefixed?.[3] || item.id, type: kind,
    title: item.title || item.name || "Unknown title", artist: item.artist || "Unknown artist",
    cover_url: source.coverUrl || artwork || source.artwork?.url || null,
    metadata: {
      ...item.metadata,
      ...(item.album ? { album: item.album } : {}),
      ...(kind === "album" && (source.trackCount || source.songCount)
        ? { songCount: source.trackCount || source.songCount } : {}),
      ...(source.previewUrl ? { previewUrl: source.previewUrl } : {}),
      ...(source.isrc || source.identityHints?.isrc ? { isrc: source.isrc || source.identityHints?.isrc } : {}),
    },
  };
}

export function savedDiscoveryItem(item: SavedDiscovery): ExternalMetadataItem & { previewUrl: string | null; coverUrl: string | null } {
  return {
    id: `external_${item.provider}_${item.type}_${item.external_id}`,
    provider: item.provider, title: item.title, artist: item.artist,
    album: typeof item.metadata.album === "string" ? item.metadata.album : null,
    previewUrl: typeof item.metadata.previewUrl === "string" ? item.metadata.previewUrl : null,
    coverUrl: item.cover_url,
    metadata: item.metadata, source: { kind: "external", count: 0 },
  };
}

const keyOf = (item: SaveInput) => `${item.provider}:${item.type}:${item.external_id}`;
function errorMessage(error: unknown) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline. Reconnect to update your saved discoveries.";
  if (error instanceof TypeError) return "Can't reach MusicDeck. Check your connection and try again.";
  return error instanceof Error ? error.message : "Could not update saved discoveries. Try again.";
}

export function createSavedDiscoveryStore(deps: Dependencies = {
  list: getSavedDiscoveries, save: saveDiscovery, remove: removeSavedDiscovery,
}) {
  let snapshot: Snapshot = { items: [], loading: true, error: null, warning: null };
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<boolean>>();
  let request: Promise<void> | null = null;
  let version = 0;
  let loaded = false;
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const refresh = () => {
    if (request) return request;
    const revision = version;
    request = Promise.resolve().then(deps.list).then((result) => {
      if (revision === version && !pending.size) publish({ items: result.discoveries, warning: result.warning || null, error: null });
      loaded = true;
    }).catch((error: unknown) => {
      if (revision === version) publish({ error: errorMessage(error) });
    }).finally(() => {
      publish({ loading: false });
      request = null;
    });
    return request;
  };
  const mutate = (key: string, action: () => Promise<void>) => {
    const existing = pending.get(key);
    if (existing) return existing;
    version += 1;
    publish({ error: null });
    const operation = Promise.resolve().then(action).then(() => true).catch((error: unknown) => {
      publish({ error: errorMessage(error) });
      return false;
    }).finally(() => { version += 1; pending.delete(key); });
    pending.set(key, operation);
    return operation;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureLoaded: () => { if (!loaded) void refresh(); },
    refresh,
    save: (input: SaveInput) => mutate(keyOf(input), async () => {
      const { discovery } = await deps.save(input);
      publish({ items: [discovery, ...snapshot.items.filter((item) => item.id !== discovery.id)] });
    }),
    remove: (id: string) => mutate(`remove:${id}`, async () => {
      await deps.remove(id);
      publish({ items: snapshot.items.filter((item) => item.id !== id) });
    }),
  };
}

// Each authenticated user has an isolated cache; late responses cannot cross accounts.
const stores = new Map<string, ReturnType<typeof createSavedDiscoveryStore>>();
const inactive = createSavedDiscoveryStore();
export function useSavedDiscoveries() {
  const auth: unknown = useAuth();
  const session = auth && typeof auth === "object" && "session" in auth ? auth.session : null;
  const userId = session && typeof session === "object" && "id" in session && typeof session.id === "string"
    ? session.id : undefined;
  const store = useMemo(() => {
    if (!userId) return inactive;
    let found = stores.get(userId);
    if (!found) { found = createSavedDiscoveryStore(); stores.set(userId, found); }
    return found;
  }, [userId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!userId) return;
    store.ensureLoaded();
    const refresh = () => { void store.refresh(); };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [store, userId]);
  return { ...snapshot, enabled: Boolean(userId), refresh: store.refresh, save: store.save, remove: store.remove };
}
