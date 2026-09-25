const PREFIX = "musicdeck:queue:v1:";
const MAX_QUEUE = 500;

export function queueStorageKey(userId) {
  return `${PREFIX}${encodeURIComponent(String(userId))}`;
}

function validItem(song) {
  if (!song || typeof song !== "object" || song.id == null) return null;
  return {
    id: String(song.id),
    title: typeof song.title === "string" ? song.title : "Unknown title",
    artist: typeof song.artist === "string" ? song.artist : "Unknown artist",
    album: typeof song.album === "string" ? song.album : "Unknown album",
    artistId: song.artistId || null,
    albumId: song.albumId || null,
    duration: Number.isFinite(Number(song.duration)) ? Number(song.duration) : null,
    coverArt: song.coverArt || null,
    previewUrl: song.previewUrl || null,
    provider: song.provider || null,
    source: song.source?.kind ? { kind: song.source.kind, count: Number(song.source.count) || 0 } : null,
    metadata: {
      durationSeconds: Number.isFinite(Number(song.metadata?.durationSeconds))
        ? Number(song.metadata.durationSeconds)
        : null,
    },
  };
}

export function createQueueSnapshot({ currentSong, queue, queueIndex, isShuffleEnabled, isLooping, volume, currentTime, wasPlaying = false }) {
  const queueItems = (Array.isArray(queue) ? queue : []).map(validItem).filter(Boolean).slice(0, MAX_QUEUE);
  const currentTrackId = currentSong?.id == null ? null : String(currentSong.id);
  const selectedIndex = queueItems.findIndex((item) => item.id === currentTrackId);
  const safeIndex = selectedIndex >= 0 ? selectedIndex : Math.max(-1, Math.min(Number(queueIndex) || 0, queueItems.length - 1));
  return {
    version: 1,
    currentTrackId,
    queueTrackIds: queueItems.map((item) => item.id),
    queueItems,
    queueIndex: safeIndex,
    shuffleEnabled: Boolean(isShuffleEnabled),
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
    const queueItems = parsed.queueItems.map(validItem).filter(Boolean).slice(0, MAX_QUEUE);
    const queueTrackIds = parsed.queueTrackIds.map(String).slice(0, MAX_QUEUE);
    if (queueItems.length !== queueTrackIds.length || queueItems.some((item, index) => item.id !== queueTrackIds[index])) return null;
    const queueIndex = queueItems.findIndex((item) => item.id === parsed.currentTrackId);
    return {
      ...parsed,
      queueItems,
      queueTrackIds,
      queueIndex,
      currentTrackId: queueIndex >= 0 ? queueItems[queueIndex].id : null,
      shuffleEnabled: parsed.shuffleEnabled === true,
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
