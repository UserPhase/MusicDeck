/**
 * @typedef {Object} NormalizedTrack
 * @property {string|null} id
 * @property {"track"} type
 * @property {string} title
 * @property {string|null} artistId
 * @property {string} artist
 * @property {string|null} albumId
 * @property {string} album
 * @property {number|null} duration
 * @property {number|null} track
 * @property {string|null} coverArt
 * @property {string|null} coverUrl
 * @property {Object|null} artwork
 * @property {string|null} streamUrl
 * @property {string|null} previewUrl
 * @property {Object|null} availability
 * @property {Object|undefined} source
 * @property {string|undefined} provider
 * @property {Object} metadata
 * @property {Object|null} replayGain
 * @property {Array} sources
 * @property {boolean} isDownloaded
 * @property {string} origin
 */

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function completed(value) {
  return typeof value === "string" && [
    "complete",
    "completed",
    "downloaded",
    "available",
  ].includes(value.toLowerCase());
}

/**
 * Convert tracks from library, playlist, favorites, Navidrome, or Jellyfin
 * responses into the single shape consumed by the frontend.
 *
 * Playlist APIs sometimes return a wrapper whose own `id` identifies the
 * playlist entry. When a nested track/song exists, its ID deliberately wins.
 *
 * @param {Object} rawTrack
 * @param {string} [origin="unknown"]
 * @returns {NormalizedTrack}
 */
export function normalizeTrackData(rawTrack, origin = "unknown") {
  const wrapper = object(rawTrack) || {};
  const nestedTrack =
    object(wrapper.track) ||
    object(wrapper.song) ||
    object(wrapper.item?.track) ||
    object(wrapper.item);
  const track = nestedTrack || wrapper;
  const metadata = {
    ...(object(wrapper.metadata) || {}),
    ...(object(track.metadata) || {}),
  };
  const availability =
    object(track.availability) ||
    object(wrapper.availability) ||
    null;
  const normalizedSource =
    object(track.source) ||
    object(wrapper.source) ||
    undefined;
  const provider = first(
    track.provider,
    wrapper.provider,
    normalizedSource?.provider
  ) || undefined;
  const runTimeTicks = number(first(track.RunTimeTicks, wrapper.RunTimeTicks));
  const duration = number(first(
    metadata.durationSeconds,
    track.durationSeconds,
    track.duration,
    typeof track.trackTimeMillis === "number" ? track.trackTimeMillis / 1000 : null,
    wrapper.durationSeconds,
    wrapper.duration,
    runTimeTicks === null ? null : runTimeTicks / 10000000
  ));
  const explicitDownloadState = first(
    track.isDownloaded,
    wrapper.isDownloaded,
    track.downloaded,
    wrapper.downloaded,
    track.spotdlDownloaded,
    wrapper.spotdlDownloaded
  );
  const status = first(
    track.downloadStatus,
    wrapper.downloadStatus,
    track.spotdl?.status,
    wrapper.spotdl?.status,
    track.download?.status,
    wrapper.download?.status
  );
  const isDownloaded = typeof explicitDownloadState === "boolean"
    ? explicitDownloadState
    : Boolean(
        availability?.libraryAvailable ||
        normalizedSource?.kind === "library" ||
        provider === "library" ||
        completed(status)
      );

  const id = first(
    track.id,
    track.Id,
    track.songId,
    track.trackId,
    track.libraryTrackId,
    wrapper.songId,
    wrapper.trackId,
    wrapper.libraryTrackId,
    wrapper.id,
    wrapper.Id
  );
  const artwork =
    object(track.artwork) ||
    object(wrapper.artwork) ||
    null;
  const deezerArtist =
    object(track.artist)?.name ||
    object(wrapper.artist)?.name ||
    null;
  const deezerAlbum =
    object(track.album) ||
    object(wrapper.album) ||
    null;
  const replayGain =
    object(track.replayGain) ||
    object(wrapper.replayGain) ||
    object(metadata.replayGain) ||
    null;

  return {
    id: id === null ? null : String(id),
    type: "track",
    title: String(first(track.title, track.trackName, track.name, track.Name, wrapper.title, wrapper.trackName, wrapper.name, wrapper.Name) || "Unknown title"),
    artistId: first(
      metadata.artistId,
      track.artistId,
      track.ArtistItems?.[0]?.Id,
      wrapper.artistId,
      wrapper.ArtistItems?.[0]?.Id
    ),
    artist: String(first(
      typeof track.artist === "string" ? track.artist : null,
      deezerArtist,
      track.artistName,
      track.Artists?.[0],
      track.AlbumArtist,
      typeof wrapper.artist === "string" ? wrapper.artist : null,
      wrapper.artistName,
      wrapper.Artists?.[0],
      wrapper.AlbumArtist
    ) || "Unknown artist"),
    albumId: first(metadata.albumId, track.albumId, track.AlbumId, wrapper.albumId, wrapper.AlbumId),
    album: String(first(
      typeof track.album === "string" ? track.album : null,
      deezerAlbum?.title,
      track.albumName,
      track.collectionName,
      track.Album,
      typeof wrapper.album === "string" ? wrapper.album : null,
      wrapper.albumName,
      wrapper.collectionName,
      wrapper.Album
    ) || "Unknown album"),
    duration,
    track: number(first(track.trackNumber, track.indexNumber, track.IndexNumber, wrapper.trackNumber, wrapper.IndexNumber)),
    coverArt: first(
      artwork?.id,
      track.artworkId,
      track.coverArt,
      wrapper.artworkId,
      wrapper.coverArt
    ),
    coverUrl: first(
      track.coverUrl,
      deezerAlbum?.cover_xl,
      deezerAlbum?.cover_medium,
      deezerAlbum?.cover,
      wrapper.coverUrl,
      artwork?.url
    ),
    artwork,
    streamUrl: first(track.streamUrl, wrapper.streamUrl),
    previewUrl: first(
      track.previewUrl,
      track.preview,
      wrapper.previewUrl,
      wrapper.preview,
      metadata.previewUrl
    ),
    availability,
    source: normalizedSource,
    provider,
    metadata,
    replayGain,
    sources: Array.isArray(track.sources)
      ? track.sources
      : Array.isArray(wrapper.sources)
        ? wrapper.sources
        : [],
    isDownloaded,
    origin,
  };
}

export default normalizeTrackData;
