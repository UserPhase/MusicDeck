import type { ProviderRegistry, RegisteredProvider } from "../backends/registry.js";
import type { StreamProvider, StreamResult } from "../backends/stream-provider.js";
import type { LibraryService, SourceRef } from "./library.js";

/**
 * Error thrown when no mapped source can satisfy a media request. The route
 * layer translates this into the existing MusicDeck backend error shape; the
 * message intentionally carries no provider internals.
 */
export class SourceUnavailableError extends Error {
  constructor(message = "No playable source is available for this item") {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

export type { SourceRef };

/**
 * MusicDeck-owned playback source resolution.
 *
 * Converts a stable MusicDeck media ID into a playable provider source. The
 * resolver reads the provider mappings from `library_item_sources`, orders
 * them deterministically by the registry's connection order, and tries each
 * source in turn until one succeeds. A failed source is a source-level
 * failure — it never becomes an HTTP 500 while another mapped source can
 * satisfy the request.
 *
 * Depends only on ProviderRegistry + StreamProvider, never on a concrete
 * backend. Resolution is lazy: no catalog fan-out or availability probing —
 * the requested operation's own success/failure is the authoritative result.
 */
export class SourceResolver {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly library: LibraryService
  ) {}

  /**
   * Map a MusicDeck ID to its candidate sources in deterministic registry
   * connection order. Sources whose connection is not currently enabled are
   * excluded (an unavailable connection is not a playable candidate).
   */
  private candidateSources(libraryItemId: string): Array<{ source: SourceRef; provider: RegisteredProvider }> {
    const sources = this.library.getSources(libraryItemId);

    if (sources.length === 0) {
      return [];
    }

    const registryOrder = new Map(
      this.registry.list().map((entry, index) => [entry.connectionId, index] as const)
    );

    return sources
      .map((source) => {
        const provider = this.registry.getByConnectionId(source.connectionId);
        return provider ? { source, provider } : null;
      })
      .filter((entry): entry is { source: SourceRef; provider: RegisteredProvider } => entry !== null)
      .sort((a, b) =>
        (registryOrder.get(a.source.connectionId) ?? Number.MAX_SAFE_INTEGER)
        - (registryOrder.get(b.source.connectionId) ?? Number.MAX_SAFE_INTEGER)
      );
  }

  /**
   * Try each candidate source in order, returning the first successful
   * result. Throws SourceUnavailableError when no mapping exists or every
   * source fails.
   */
  private async resolveWithFallback(
    libraryItemId: string,
    operation: (provider: StreamProvider, source: SourceRef) => Promise<StreamResult>,
    preferredConnectionId?: string
  ): Promise<StreamResult> {
    let candidates = this.candidateSources(libraryItemId);

    if (preferredConnectionId) {
      candidates = [...candidates].sort((a, b) => {
        const aPreferred = a.source.connectionId === preferredConnectionId ? 0 : 1;
        const bPreferred = b.source.connectionId === preferredConnectionId ? 0 : 1;
        return aPreferred - bPreferred;
      });
    }

    if (candidates.length === 0) {
      throw new SourceUnavailableError();
    }

    let lastError: unknown;

    for (const { source, provider } of candidates) {
      try {
        const result = await operation(provider.provider, source);

        if (result.body || result.status < 500) {
          return result;
        }

        lastError = new Error(`source returned status ${result.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    throw new SourceUnavailableError(
      lastError instanceof SourceUnavailableError ? lastError.message : undefined
    );
  }

  /** Resolve a stable track ID to a playable stream, with source fallback.
   * When `preferredConnectionId` is given and maps to a mapped, enabled
   * source, that source is tried first; other sources still provide fallback
   * if it fails. */
  fetchStream(libraryItemId: string, range?: string, preferredConnectionId?: string): Promise<StreamResult> {
    return this.resolveWithFallback(libraryItemId, (provider, source) =>
      provider.fetchStream(source.providerItemId, range)
    , preferredConnectionId);
  }

  /** Resolve a stable artwork/library ID to artwork, with source fallback. */
  fetchArtwork(libraryItemId: string, size?: number): Promise<StreamResult> {
    return this.resolveWithFallback(libraryItemId, (provider, source) =>
      // Omitted rather than passed as undefined so providers without
      // thumbnail support see an unchanged call.
      size === undefined
        ? provider.fetchArtwork(source.providerItemId)
        : provider.fetchArtwork(source.providerItemId, size)
    );
  }

  /** Whether any enabled source exists for the item (used to distinguish
   * unknown IDs from unavailable sources). */
  hasSource(libraryItemId: string): boolean {
    return this.candidateSources(libraryItemId).length > 0;
  }
}
