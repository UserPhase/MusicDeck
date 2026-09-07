import { deriveCanonicalIdentity } from "./music-identity.js";
import type { SearchGroups, SearchProviderKind, UnifiedSearchResult } from "./search.js";

function preferredProvider(current: SearchProviderKind, incoming: SearchProviderKind) {
  const rank: Record<SearchProviderKind, number> = {
    library: 0,
    musicdeck: 1,
    external: 2,
    plugin: 3,
  };
  return rank[incoming] < rank[current] ? incoming : current;
}

function mergeSources(current: UnifiedSearchResult["source"], incoming: UnifiedSearchResult["source"]) {
  const options = [...(current.options || []), ...(incoming.options || [])]
    .filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index);
  const hasExternal = current.kind === "external" || incoming.kind === "external" || current.externalAvailable || incoming.externalAvailable;

  return {
    kind: current.kind === "library" || incoming.kind === "library"
      ? "library" as const
      : current.kind === "musicdeck" || incoming.kind === "musicdeck"
        ? "musicdeck" as const
        : "external" as const,
    count: Math.max(current.count, incoming.count),
    ...(options.length > 0 ? { options } : {}),
    ...(hasExternal ? { externalAvailable: true } : {}),
  };
}

function mergeAvailability(current: UnifiedSearchResult["availability"], incoming: UnifiedSearchResult["availability"]) {
  if (!current) return incoming;
  if (!incoming) return current;

  return {
    ...current,
    state: current.state === "available" || incoming.state === "available"
      ? "available" as const
      : current.state === "degraded" || incoming.state === "degraded"
        ? "degraded" as const
        : "unavailable" as const,
    sourceCount: current.sourceCount + incoming.sourceCount,
    availableSourceCount: current.availableSourceCount + incoming.availableSourceCount,
    libraryAvailable: current.libraryAvailable || incoming.libraryAvailable,
  };
}

function mergeResult(current: UnifiedSearchResult, incoming: UnifiedSearchResult) {
  const useIncoming = preferredProvider(current.provider, incoming.provider) === incoming.provider;
  const primary = useIncoming ? incoming : current;
  const secondary = useIncoming ? current : incoming;

  return {
    ...primary,
    subtitle: primary.subtitle || secondary.subtitle,
    artist: primary.artist || secondary.artist,
    album: primary.album || secondary.album,
    artwork: primary.artwork || secondary.artwork,
    provider: preferredProvider(current.provider, incoming.provider),
    providers: Array.from(new Set([...(current.providers || [current.provider]), ...(incoming.providers || [incoming.provider])])),
    source: mergeSources(current.source, incoming.source),
    availability: mergeAvailability(current.availability, incoming.availability),
    metadata: { ...secondary.metadata, ...primary.metadata },
    identity: deriveCanonicalIdentity(current),
  } satisfies UnifiedSearchResult;
}

/**
 * Deterministically merge only results with the same conservative canonical
 * identity. The first provider result fixes group order; library entries are
 * preferred as the client-facing representative when present so existing
 * playback and navigation remain resolvable.
 */
export function deduplicateSearchGroups(groups: SearchGroups): SearchGroups {
  const deduplicate = (items: UnifiedSearchResult[]) => {
    const byIdentity = new Map<string, UnifiedSearchResult>();

    for (const item of items) {
      const identity = deriveCanonicalIdentity(item);
      const normalized = { ...item, identity, providers: [item.provider] };
      const existing = byIdentity.get(identity.id);

      byIdentity.set(identity.id, existing ? mergeResult(existing, normalized) : normalized);
    }

    return Array.from(byIdentity.values()).map(({ identityHints: _identityHints, ...item }) => item);
  };

  return {
    track: deduplicate(groups.track),
    album: deduplicate(groups.album),
    artist: deduplicate(groups.artist),
    playlist: deduplicate(groups.playlist),
  };
}
