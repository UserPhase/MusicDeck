import type { Album, Artist, Track } from "../../types.js";

/**
 * Jellyfin → MusicDeck domain transformations.
 *
 * All Jellyfin response shapes are converted here so the backend never leaks
 * raw Jellyfin payloads. MusicDeck conventions are preserved: plural Jellyfin
 * artist fields collapse to a single display name, RunTimeTicks convert to
 * seconds, and artwork references use the item's own ID (Jellyfin addresses
 * artwork as /Items/{itemId}/Images/Primary).
 *
 * IDs are provider-native here; the CatalogService stamps stable MusicDeck
 * IDs on top. streamUrl/artworkUrl are set to null-safe placeholders because
 * the public URL is produced by the MusicDeck stream/artwork routes.
 */

function id(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function firstName(list: unknown): string | null {
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    if (first && typeof first === "object" && "Name" in first) {
      return String((first as { Name: unknown }).Name);
    }
  }
  return null;
}

function joinNames(list: unknown): string | null {
  if (Array.isArray(list) && list.length > 0) {
    const names = list
      .map((entry) => (entry && typeof entry === "object" && "Name" in entry ? String((entry as { Name: unknown }).Name) : null))
      .filter(Boolean);
    if (names.length > 0) {
      return names.join(", ");
    }
  }
  return null;
}

function ticksToSeconds(ticks: unknown): number | null {
  return typeof ticks === "number" ? Math.round(ticks / 10_000_000) : null;
}

function identityHints(item: any, musicBrainzKey: string) {
  return {
    musicBrainzId: id(item.ProviderIds?.[musicBrainzKey] || item.ProviderIds?.MusicBrainz),
    isrc: id(item.ProviderIds?.Isrc || item.Isrc),
    upc: id(item.ProviderIds?.Upc || item.ProviderIds?.UPC),
  };
}

export function mapJellyfinTrack(item: any): Track {
  const trackId = String(item.Id);

  return {
    id: trackId,
    providerId: trackId,
    title: item.Name || "Unknown title",
    artistId: id(item.ArtistItems?.[0]?.Id ?? item.AlbumArtists?.[0]?.Id),
    artistName: joinNames(item.Artists) || firstName(item.AlbumArtists) || "Unknown artist",
    albumId: id(item.AlbumId),
    albumName: item.Album || "Unknown album",
    durationSeconds: ticksToSeconds(item.RunTimeTicks),
    trackNumber: typeof item.IndexNumber === "number" ? item.IndexNumber : null,
    artworkId: item.ImageTags?.Primary ? trackId : null,
    artworkUrl: item.ImageTags?.Primary ? `/api/artwork/${encodeURIComponent(trackId)}` : null,
    streamUrl: `/api/tracks/${encodeURIComponent(trackId)}/stream`,
    identityHints: identityHints(item, "MusicBrainzTrack"),
  };
}

export function mapJellyfinAlbum(item: any): Album {
  const albumId = String(item.Id);
  const artId = item.ImageTags?.Primary ? albumId : null;

  return {
    id: albumId,
    providerId: albumId,
    name: item.Name || "Unknown album",
    artistId: id(item.AlbumArtists?.[0]?.Id ?? item.ArtistItems?.[0]?.Id),
    artistName: joinNames(item.AlbumArtists) || firstName(item.Artists) || "Unknown artist",
    year: typeof item.ProductionYear === "number" ? item.ProductionYear : null,
    artworkId: artId,
    artworkUrl: artId ? `/api/artwork/${encodeURIComponent(artId)}` : null,
    songCount: typeof item.ChildCount === "number" ? item.ChildCount : 0,
    identityHints: identityHints(item, "MusicBrainzAlbum"),
  };
}

export function mapJellyfinArtist(item: any): Artist {
  const artistId = String(item.Id);
  const artId = item.ImageTags?.Primary ? artistId : null;

  return {
    id: artistId,
    providerId: artistId,
    name: item.Name || "Unknown artist",
    artworkId: artId,
    artworkUrl: artId ? `/api/artwork/${encodeURIComponent(artId)}` : null,
    albumCount: typeof item.ChildCount === "number" ? item.ChildCount : 0,
    identityHints: identityHints(item, "MusicBrainzArtist"),
  };
}
