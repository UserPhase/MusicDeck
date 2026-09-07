import type { Album, Artist, Playlist, Track } from "../../types.js";

function id(value: unknown) {
  return value === undefined || value === null ? null : String(value);
}

function identityHints(value: any) {
  return {
    musicBrainzId: id(value.musicBrainzId || value.mbId),
    isrc: id(value.isrc),
    upc: id(value.upc),
  };
}

export function artworkUrl(artworkId: string | null) {
  return artworkId ? `/api/artwork/${encodeURIComponent(artworkId)}` : null;
}

export function streamUrl(trackId: string) {
  return `/api/tracks/${encodeURIComponent(trackId)}/stream`;
}

export function mapTrack(song: any): Track {
  const trackId = String(song.id);

  return {
    id: trackId,
    providerId: trackId,
    title: song.title || "Unknown title",
    artistId: id(song.artistId),
    artistName: song.artist || "Unknown artist",
    albumId: id(song.albumId),
    albumName: song.album || "Unknown album",
    durationSeconds: typeof song.duration === "number" ? song.duration : null,
    trackNumber: typeof song.track === "number" ? song.track : null,
    artworkId: id(song.coverArt),
    artworkUrl: artworkUrl(id(song.coverArt)),
    streamUrl: streamUrl(trackId),
    identityHints: identityHints(song),
  };
}

export function mapAlbum(album: any): Album {
  const albumId = String(album.id);
  const artId = id(album.coverArt);

  return {
    id: albumId,
    providerId: albumId,
    name: album.name || album.title || "Unknown album",
    artistId: id(album.artistId),
    artistName: album.artist || "Unknown artist",
    year: typeof album.year === "number" ? album.year : null,
    artworkId: artId,
    artworkUrl: artworkUrl(artId),
    songCount: typeof album.songCount === "number" ? album.songCount : album.song?.length || 0,
    identityHints: identityHints(album),
  };
}

export function mapArtist(artist: any): Artist {
  const artistId = String(artist.id);
  const artId = id(artist.coverArt);

  return {
    id: artistId,
    providerId: artistId,
    name: artist.name || "Unknown artist",
    artworkId: artId,
    artworkUrl: artworkUrl(artId),
    albumCount: typeof artist.albumCount === "number" ? artist.albumCount : artist.album?.length || 0,
    identityHints: identityHints(artist),
  };
}

export function mapPlaylist(playlist: any, includeTracks = false): Playlist {
  const playlistId = String(playlist.id);
  const artId = id(playlist.coverArt);
  const entries = playlist.entry || [];

  return {
    id: playlistId,
    providerId: playlistId,
    name: playlist.name || "Untitled playlist",
    description: playlist.comment || null,
    artworkId: artId,
    artworkUrl: artworkUrl(artId),
    songCount: typeof playlist.songCount === "number" ? playlist.songCount : entries.length,
    ...(includeTracks ? { tracks: entries.map(mapTrack) } : {}),
  };
}
