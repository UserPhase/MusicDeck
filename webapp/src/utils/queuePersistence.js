import { replayGainMetadata, validLoudness } from "./loudness";
import { isMediaResumeContext } from "../services/mediaSessions";

const PREFIX = "musicdeck:queue:v1:";

export function queueStorageKey(userId) {
  return `${PREFIX}${encodeURIComponent(String(userId))}`;
}

function validItem(song) {
  if (!song || typeof song !== "object" || song.id == null) return null;
  const gain = song.normalizationGainDb ?? song.metadata?.normalizationGainDb;
  const loudness = validLoudness(song.loudness ?? song.metadata?.loudness);
  return {
    id: String(song.id),
    title: typeof song.title === "string" ? song.title : "Unknown title",
    artist: typeof song.artist === "string" ? song.artist : "Unknown artist",
    album: typeof song.album === "string" ? song.album : "Unknown album",
    artistId: song.artistId || null,
    albumId: song.albumId || null,
    ...(isMediaResumeContext(song.mediaResume) ? { mediaResume: { ...song.mediaResume } } : {}),
    ...(typeof song.albumPlaybackId === "string" ? { albumPlaybackId: song.albumPlaybackId } : {}),
    ...(Number.isInteger(song.albumTrackIndex) && song.albumTrackIndex >= 0 ? { albumTrackIndex: song.albumTrackIndex } : {}),
    replayGain: replayGainMetadata(song),
    duration: Number.isFinite(Number(song.duration)) ? Number(song.duration) : null,
    coverArt: song.coverArt || null,
    previewUrl: song.previewUrl || null,
    provider: song.provider || null,
    ...(song.recommendationGenerated === true ? { recommendationGenerated: true } : {}),
    ...(song.autoplayGenerated === true ? { autoplayGenerated: true } : {}),
    ...(Number.isFinite(gain) && gain >= -60 && gain <= 12 ? { normalizationGainDb: gain } : {}),
    ...(loudness ? { loudness } : {}),
    source: song.source?.kind ? { kind: song.source.kind, count: Number(song.source.count) || 0 } : null,
    metadata: {
      ...(typeof song.metadata?.recommendationReason === "string"
        ? { recommendationReason: song.metadata.recommendationReason.slice(0, 500) } : {}),
      durationSeconds: Number.isFinite(Number(song.metadata?.durationSeconds))
        ? Number(song.metadata.durationSeconds)
        : null,
    },
  };
}

export function createQueueSnapshot({ currentSong, queue, queueIndex, isShuffleEnabled, shuffleSeed = /** @type {number | null} */ (null), isLooping, volume, currentTime, wasPlaying = false }) {
  const queueItems = (Array.isArray(queue) ? queue : []).map(validItem).filter(Boolean);
  const currentTrackId = currentSong?.id == null ? null : String(currentSong.id);
  const selectedIndex = Number.isInteger(queueIndex) && queueItems[queueIndex]?.id === currentTrackId
    ? queueIndex
    : queueItems.findIndex((item) => item.id === currentTrackId);
  const safeIndex = selectedIndex >= 0 ? selectedIndex : Math.max(-1, Math.min(Number(queueIndex) || 0, queueItems.length - 1));
  return {
    version: 1,
    currentTrackId,
    queueTrackIds: queueItems.map((item) => item.id),
    queueItems,
    queueIndex: safeIndex,
    shuffleEnabled: Boolean(isShuffleEnabled),
    shuffleSeed: Number.isInteger(shuffleSeed) && shuffleSeed >= 0 && shuffleSeed <= 0xffffffff ? shuffleSeed : null,
    repeatMode: isLooping ? "one" : "off",
    volume: Math.max(0, Math.min(1, Number(volume) || 0)),
    playbackProgressSeconds: Math.max(0, Number(currentTime) || 0),
    wasPlaying: Boolean(currentTrackId && wasPlaying),
  };
}

export function readQueueSnapshot(storage, userId) {
  try {
    const raw = storage.getItem(queueStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.queueTrackIds) || !Array.isArray(parsed.queueItems)) return null;
    const queueItems = parsed.queueItems.map(validItem).filter(Boolean);
    const queueTrackIds = parsed.queueTrackIds.map(String);
    if (queueItems.length !== queueTrackIds.length || queueItems.some((item, index) => item.id !== queueTrackIds[index])) return null;
    const queueIndex = Number.isInteger(parsed.queueIndex) && queueItems[parsed.queueIndex]?.id === parsed.currentTrackId
      ? parsed.queueIndex
      : queueItems.findIndex((item) => item.id === parsed.currentTrackId);
    return {
      ...parsed,
      queueItems,
      queueTrackIds,
      queueIndex,
      currentTrackId: queueIndex >= 0 ? queueItems[queueIndex].id : null,
      shuffleEnabled: parsed.shuffleEnabled === true,
      shuffleSeed: Number.isInteger(parsed.shuffleSeed) && parsed.shuffleSeed >= 0 && parsed.shuffleSeed <= 0xffffffff ? parsed.shuffleSeed : null,
      repeatMode: parsed.repeatMode === "one" ? "one" : "off",
      volume: Number.isFinite(Number(parsed.volume)) ? Math.max(0, Math.min(1, Number(parsed.volume))) : 1,
      playbackProgressSeconds: Number.isFinite(Number(parsed.playbackProgressSeconds))
        ? Math.max(0, Number(parsed.playbackProgressSeconds)) : 0,
      wasPlaying: queueIndex >= 0 && parsed.wasPlaying === true,
    };
  } catch {
    return null;
  }
}
