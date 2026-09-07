import type { Album, Artist, IdentityHints, Playlist, Track } from "../types.js";
import type { Availability, CatalogSearchResult, SourceOption } from "./catalog.js";

export type SearchResultType = "track" | "album" | "artist" | "playlist";
export type SearchProviderKind = "library" | "musicdeck" | "plugin" | "external";

export type CanonicalIdentity = {
  id: string;
  strength: "musicbrainz" | "isrc" | "upc" | "normalized" | "provider";
};

export type SearchOptions = {
  types?: SearchResultType[];
  limit?: number;
  mode?: "library" | "hybrid" | "external";
};

/**
 * Lightweight contract for future search-capable providers. CatalogProvider
 * already satisfies the catalog part of this shape through its `search`
 * method; future plugin/external adapters can return the same read model
 * without changing the client grouping code.
 */
export interface SearchProvider {
  id: string;
  name: string;
  search(query: string, options?: SearchOptions): Promise<UnifiedSearchResult[]>;
}

export type UnifiedSearchResult = {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  artist: string | null;
  album: string | null;
  artwork: { id: string; url: string } | null;
  provider: SearchProviderKind;
  source: {
    kind: "library" | "musicdeck" | "external";
    count: number;
    options?: SourceOption[];
    externalAvailable?: boolean;
  };
  availability: Availability | null;
  identity?: CanonicalIdentity;
  providers?: SearchProviderKind[];
  metadata: {
    durationSeconds?: number | null;
    year?: number | null;
    songCount?: number;
    artistId?: string | null;
    albumId?: string | null;
    recommendationReason?: string;
    spotifyTrackUrl?: string;
    spotifyUrl?: string;
    spotifyTrackId?: string;
    spotifyId?: string;
  };
  /** Internal matching input; removed before the API response. */
  identityHints?: IdentityHints;
};

export type SearchGroups = Record<SearchResultType, UnifiedSearchResult[]>;

export type SearchProviderResult = {
  providerId: string;
  items: UnifiedSearchResult[];
};

function artwork(id: string | null, url: string | null) {
  return id && url ? { id, url } : null;
}

function source(availability: Availability | null, options?: SourceOption[]) {
  return {
    kind: "library" as const,
    count: options?.length || availability?.availableSourceCount || 1,
    ...(options ? { options } : {}),
  };
}

export function toTrackSearchResult(track: Track & { availability: Availability; sources?: SourceOption[] }): UnifiedSearchResult {
  return {
    type: "track",
    id: track.id,
    title: track.title,
    subtitle: track.artistName,
    artist: track.artistName,
    album: track.albumName,
    artwork: artwork(track.artworkId, track.artworkUrl),
    provider: "library",
    source: source(track.availability, track.sources),
    availability: track.availability,
    metadata: {
      durationSeconds: track.durationSeconds,
      artistId: track.artistId,
      albumId: track.albumId,
    },
    identityHints: track.identityHints,
  };
}

export function toAlbumSearchResult(album: Album & { availability: Availability; sources?: SourceOption[] }): UnifiedSearchResult {
  return {
    type: "album",
    id: album.id,
    title: album.name,
    subtitle: album.artistName,
    artist: album.artistName,
    album: null,
    artwork: artwork(album.artworkId, album.artworkUrl),
    provider: "library",
    source: source(album.availability, album.sources),
    availability: album.availability,
    metadata: {
      year: album.year,
      songCount: album.songCount,
      artistId: album.artistId,
    },
    identityHints: album.identityHints,
  };
}

export function toArtistSearchResult(artist: Artist & { availability: Availability; sources?: SourceOption[] }): UnifiedSearchResult {
  return {
    type: "artist",
    id: artist.id,
    title: artist.name,
    subtitle: "Artist",
    artist: artist.name,
    album: null,
    artwork: artwork(artist.artworkId, artist.artworkUrl),
    provider: "library",
    source: source(artist.availability, artist.sources),
    availability: artist.availability,
    metadata: { songCount: artist.albumCount },
    identityHints: artist.identityHints,
  };
}

export function toPlaylistSearchResult(playlist: Playlist): UnifiedSearchResult {
  return {
    type: "playlist",
    id: playlist.id,
    title: playlist.name,
    subtitle: playlist.description || "Playlist",
    artist: null,
    album: null,
    artwork: artwork(playlist.artworkId, playlist.artworkUrl),
    provider: "musicdeck",
    source: { kind: "musicdeck", count: 1 },
    availability: null,
    metadata: { songCount: playlist.songCount },
  };
}

/**
 * Additive normalized result groups. Legacy artists/albums/tracks/playlists
 * arrays remain available on /api/search for current callers.
 */
export function toSearchGroups(catalog: CatalogSearchResult, playlists: Playlist[]): SearchGroups {
  return {
    track: catalog.tracks.map(toTrackSearchResult),
    album: catalog.albums.map(toAlbumSearchResult),
    artist: catalog.artists.map(toArtistSearchResult),
    playlist: playlists.map(toPlaylistSearchResult),
  };
}

export function groupSearchResults(items: UnifiedSearchResult[]): SearchGroups {
  return items.reduce<SearchGroups>((groups, item) => {
    groups[item.type].push(item);
    return groups;
  }, { track: [], album: [], artist: [], playlist: [] });
}

/**
 * Compatibility projection for legacy /api/search arrays. External/plugin
 * entries intentionally remain in normalized `results` only: they have no
 * provider-native stream/artwork contract in the legacy shape.
 */
export function toLegacySearchResponse(groups: SearchGroups) {
  const libraryItems = (type: SearchResultType) => groups[type]
    .filter((item) => item.provider === "library" || item.provider === "musicdeck");

  return {
    tracks: libraryItems("track").map((item) => ({
      id: item.id,
      providerId: item.id,
      title: item.title,
      artistId: item.metadata.artistId || null,
      artistName: item.artist || "Unknown artist",
      albumId: item.metadata.albumId || null,
      albumName: item.album || "Unknown album",
      durationSeconds: item.metadata.durationSeconds || null,
      trackNumber: null,
      artworkId: item.artwork?.id || null,
      artworkUrl: item.artwork?.url || null,
      streamUrl: `/api/tracks/${encodeURIComponent(item.id)}/stream`,
      availability: item.availability,
      sources: item.source.options,
    })),
    albums: libraryItems("album").map((item) => ({
      id: item.id,
      providerId: item.id,
      name: item.title,
      artistId: item.metadata.artistId || null,
      artistName: item.artist || "Unknown artist",
      year: item.metadata.year || null,
      artworkId: item.artwork?.id || null,
      artworkUrl: item.artwork?.url || null,
      songCount: item.metadata.songCount || 0,
      availability: item.availability,
      sources: item.source.options,
    })),
    artists: libraryItems("artist").map((item) => ({
      id: item.id,
      providerId: item.id,
      name: item.title,
      artworkId: item.artwork?.id || null,
      artworkUrl: item.artwork?.url || null,
      albumCount: item.metadata.songCount || 0,
      availability: item.availability,
      sources: item.source.options,
    })),
    playlists: libraryItems("playlist").map((item) => ({
      id: item.id,
      providerId: item.id,
      name: item.title,
      description: item.subtitle === "Playlist" ? null : item.subtitle,
      artworkId: item.artwork?.id || null,
      artworkUrl: item.artwork?.url || null,
      songCount: item.metadata.songCount || 0,
    })),
  };
}
