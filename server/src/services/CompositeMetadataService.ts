import type { CatalogService } from "../domain/catalog.js";
import { deduplicateSearchGroups } from "../domain/search-deduplication.js";
import { groupSearchResults, type SearchGroups, type SearchResultType, type UnifiedSearchResult } from "../domain/search.js";
import { createLibraryMatchIndex, type MatchableAlbum, type MatchableTrack } from "../utils/libraryMatcher.js";
import type { MetadataAdapter } from "./adapters/MetadataAdapter.js";

type LibrarySnapshot = ReturnType<typeof createLibraryMatchIndex>;

/** Local data has its own completion path; keyless lookups never gate it. */
export class CompositeMetadataService {
  private librarySnapshot: { expiresAt: number; value: Promise<LibrarySnapshot> } | null = null;

  constructor(
    private readonly local: MetadataAdapter,
    private readonly external: MetadataAdapter[],
    private readonly catalog: CatalogService
  ) {}

  async searchLocal(query: string, types: SearchResultType[] = ["track", "album", "artist"]): Promise<SearchGroups> {
    if (this.local.searchAll) {
      return this.local.searchAll(query, types.map((type) => `${type}s`));
    }
    const requests: Promise<UnifiedSearchResult[]>[] = [];
    if (types.includes("track")) requests.push(this.local.searchTracks(query));
    if (types.includes("album")) requests.push(this.local.searchAlbums(query));
    if (types.includes("artist")) {
      requests.push(this.local.getArtistDetails(query).then((artist) => artist ? [artist] : []));
    }
    return groupSearchResults((await Promise.all(requests)).flat());
  }

  private getLibrarySnapshot(): Promise<LibrarySnapshot> {
    if (this.librarySnapshot && this.librarySnapshot.expiresAt > Date.now()) return this.librarySnapshot.value;
    const value = Promise.all([this.catalog.listTracks(), this.catalog.listAlbums()])
      .then(([tracks, albums]) => createLibraryMatchIndex(
        tracks.items.map((track): MatchableTrack => ({
          id: track.id, title: track.title, artist: track.artistName,
          isrc: track.identityHints?.isrc,
        })),
        albums.items.map((album): MatchableAlbum => ({
          id: album.id, title: album.name, artist: album.artistName,
        })),
      ))
      .catch((error) => {
        this.librarySnapshot = null;
        throw error;
      });
    this.librarySnapshot = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  }

  async annotateLibraryMatches(items: UnifiedSearchResult[]): Promise<UnifiedSearchResult[]> {
    if (!items.some((item) => item.type === "track" || item.type === "album")) return items;
    let snapshot: LibrarySnapshot;
    try {
      snapshot = await this.getLibrarySnapshot();
    } catch {
      // A temporarily unavailable local backend must not hide external results.
      return items;
    }
    return items.map((item) => {
      if (item.type === "track") {
        const match = snapshot.matchTrack({
          id: item.id, title: item.title, artist: item.artist || "",
          isrc: item.identityHints?.isrc,
        });
        return { ...item, ...match };
      }
      if (item.type === "album") {
        const match = snapshot.matchAlbum({
          id: item.id, title: item.title, artist: item.artist || "",
        });
        return { ...item, ...match };
      }
      return item;
    });
  }

  async searchExternal(query: string, types: SearchResultType[] = ["track", "album", "artist"]) {
    const requests = this.external.flatMap((adapter) => {
      const jobs: Promise<UnifiedSearchResult[]>[] = [];
      if (types.includes("track")) jobs.push(adapter.searchTracks(query));
      if (types.includes("album")) jobs.push(adapter.searchAlbums(query));
      if (types.includes("artist")) {
        jobs.push(adapter.searchArtists
          ? adapter.searchArtists(query)
          : adapter.getArtistDetails(query).then((artist) => artist ? [artist] : []));
      }
      return jobs;
    });
    const outcomes = await Promise.allSettled(requests);
    const items = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? outcome.value : []);
    const annotated = await this.annotateLibraryMatches(items);
    return {
      groups: deduplicateSearchGroups(groupSearchResults(annotated)),
      degraded: outcomes.some((outcome) => outcome.status === "rejected"),
    };
  }
}
