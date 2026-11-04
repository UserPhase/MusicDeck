import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { getCollectorCatalog } from "../api/musicdeck";
import { collectorMetadata, emptyCollectorFilters, hasCollectorFilters, useCollectorFilters, type CollectorItem } from "./useCollectorFilters";
import { useAuth } from "../context/AuthContext";
import { normalizePlaylistSearch, playlistTrackSearchText } from "../utils/playlistSearch";

type Track = CollectorItem & { albumId?: string | null; favorite?: boolean; played?: boolean };
type Album = CollectorItem & { id: string; name: string };
type Catalog = { ownerId: string; tracks: Track[]; albums: Album[]; degraded: boolean };
const emptyTracks: Track[] = [];
const emptyAlbums: Album[] = [];

export function useCollectorLibrary(type: "track" | "album", options: {
  favoritesOnly?: boolean;
  unplayedOnly?: boolean;
  exclude?: (item: CollectorItem) => boolean;
  sortActive?: boolean;
} = {}) {
  const { favoritesOnly, unplayedOnly, exclude, sortActive } = options;
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(emptyCollectorFilters);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searchTokens = useMemo(() => normalizePlaylistSearch(deferredQuery).trim().split(/\s+/).filter(Boolean), [deferredQuery]);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ owner: string; catalog?: Catalog; error?: string }>();
  const active = hasCollectorFilters(filters) || searchTokens.length > 0;
  const owner = useAuth()?.session?.id;
  const current = snapshot?.owner === owner ? snapshot : undefined;
  const enabled = open || active || Boolean(sortActive);
  useEffect(() => {
    if (!owner || !enabled) return;
    const controller = new AbortController();
    void getCollectorCatalog(type === "album", controller.signal).then((catalog: Catalog) => {
      if (catalog.ownerId !== owner) throw new Error("The signed-in account changed.");
      if (!controller.signal.aborted) setSnapshot({ owner, catalog });
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot({ owner, error: "Could not load collector metadata." });
    });
    return () => controller.abort();
  }, [owner, enabled, type, attempt]);
  const catalog = current?.catalog;
  const items = useMemo(() => {
    if (type === "track") {
      if (!catalog) return emptyTracks;
      return catalog.tracks.filter(track =>
        !exclude?.(track) && (!favoritesOnly || track.favorite) && (!unplayedOnly || !track.played));
    }
    if (!catalog) return emptyAlbums;
    const byAlbum = new Map<string, { genres: Set<string>; formats: Set<string>; remaster: boolean }>();
    for (const track of catalog.tracks) {
      if (!track.albumId) continue;
      let details = byAlbum.get(track.albumId);
      if (!details) {
        details = { genres: new Set(), formats: new Set(), remaster: false };
        byAlbum.set(track.albumId, details);
      }
      const meta = collectorMetadata(track);
      meta.genres.forEach(genre => details.genres.add(genre));
      meta.formats.forEach(format => details.formats.add(format));
      details.remaster ||= meta.remaster;
    }
    return catalog.albums.filter(album => !exclude?.(album)).map(album => {
      const details = byAlbum.get(album.id);
      return details ? { ...album, metadata: { ...album.metadata, genres: [...details.genres], formats: [...details.formats], remaster: details.remaster } } : album;
    });
  }, [type, catalog, exclude, favoritesOnly, unplayedOnly]);
  const filtered = useCollectorFilters(items, filters);
  const results = useMemo(() => searchTokens.length ? filtered.items.filter(item => {
    const text = playlistTrackSearchText({ ...item, title: item.title || item.name });
    return searchTokens.every(token => text.includes(token));
  }) : filtered.items, [filtered.items, searchTokens]);
  const error = current?.error || (enabled && !owner ? "Sign in to use collector filters." : "");
  return {
    ...filtered,
    items: results,
    searchTokens,
    active,
    showSnapshot: active || Boolean(catalog && (sortActive || (type === "album" && open))),
    bar: {
      open, onOpenChange: setOpen, query, onQueryChange: setQuery, filters, onChange: setFilters, genres: filtered.genres,
      busy: enabled && !error && !catalog, error: enabled ? error : "",
      degraded: enabled && catalog?.degraded,
      onRetry: () => { setSnapshot(undefined); setAttempt(value => value + 1); },
    },
  };
}
