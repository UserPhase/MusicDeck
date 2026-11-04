import type { Album, Artist, Playlist, Track, TrackArtistCredit } from "../../types.js";
import { withTrackContent } from "../../services/media/contentRevision.js";

function id(value: unknown) {
  return value === undefined || value === null ? null : String(value);
}

function replayGainNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function replayGain(song: any) {
  const values = song.replayGain || song.replaygain || {};
  return {
    trackGainDb: replayGainNumber(values.trackGain ?? values.trackGainDb ?? song.replayGainTrackGain),
    trackPeak: replayGainNumber(values.trackPeak ?? song.replayGainTrackPeak),
    albumGainDb: replayGainNumber(values.albumGain ?? values.albumGainDb ?? song.replayGainAlbumGain),
    albumPeak: replayGainNumber(values.albumPeak ?? song.replayGainAlbumPeak),
  };
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
  const artistCredits: TrackArtistCredit[] = Array.isArray(song.artists)
    ? song.artists.flatMap((artist: { id?: unknown; name?: unknown } | null) =>
      typeof artist?.name === "string" && artist.name.trim()
        ? [{ id: id(artist.id) || null, name: artist.name.trim() }]
        : [])
    : [];

  return withTrackContent({
    id: trackId,
    providerId: trackId,
    title: song.title || "Unknown title",
    artistId: id(song.artistId) || artistCredits[0]?.id || null,
    artistName: song.displayArtist || song.artist || artistCredits.map(({ name }) => name).join(", ") || "Unknown artist",
    ...(artistCredits.length ? { artistCredits } : {}),
    albumId: id(song.albumId),
    albumName: song.album || "Unknown album",
    durationSeconds: typeof song.duration === "number" ? song.duration : null,
    genres: Array.isArray(song.genres)
      ? song.genres.flatMap((genre: unknown) => {
        if (typeof genre === "string") return [genre];
        return genre && typeof genre === "object" && "name" in genre && typeof genre.name === "string" ? [genre.name] : [];
      })
      : typeof song.genre === "string" ? [song.genre] : [],
    moods: typeof song.mood === "string" ? [song.mood] : [],
    year: typeof song.year === "number" ? song.year : null,
    originalReleaseYear: typeof song.originalReleaseDate?.year === "number" ? song.originalReleaseDate.year : null,
    bpm: typeof song.bpm === "number" && Number.isFinite(song.bpm) ? song.bpm : null,
    playCount: typeof song.playCount === "number" ? song.playCount : null,
    lastPlayedAt: typeof song.played === "string" ? song.played : null,
    addedAt: typeof song.created === "string" ? song.created : null,
    trackNumber: typeof song.track === "number" ? song.track : null,
    artworkId: id(song.coverArt),
    artworkUrl: artworkUrl(id(song.coverArt)),
    streamUrl: streamUrl(trackId),
    audioMetadata: {
      codec: typeof song.contentType === "string" ? song.contentType.replace(/^audio\//, "") : typeof song.suffix === "string" ? song.suffix : null,
      container: typeof song.suffix === "string" ? song.suffix : null,
      bitrateKbps: typeof song.bitRate === "number" && song.bitRate > 0 ? song.bitRate : null,
      sampleRateHz: typeof song.samplingRate === "number" && song.samplingRate > 0 ? song.samplingRate : null,
      bitDepth: typeof song.bitDepth === "number" && song.bitDepth > 0 ? song.bitDepth : null,
      channels: typeof song.channelCount === "number" && song.channelCount > 0 ? song.channelCount : null,
    },
    replayGain: replayGain(song),
    identityHints: identityHints(song),
  }, { path: song.path, size: song.size, modified: song.modified, suffix: song.suffix });
}

export function mapAlbum(album: any): Album {
  const albumId = String(album.id);
  const childCover = Array.isArray(album.song)
    ? album.song.find((song: { coverArt?: unknown } | null) => song?.coverArt)?.coverArt
    : null;
  const artId = id(album.coverArt || childCover);

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
    songCount: typeof artist.songCount === "number" ? artist.songCount : null,
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
