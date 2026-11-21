export function normalizeRecordingText(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/(?:\s*\((?:feat\.?|featuring|ft\.?)\s+[^)]*\)|\s*(?:[-,]\s*)?(?:feat\.?|featuring|ft\.?)\s+.+)$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

const code = (value) => String(value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
const conflicts = (left, right) => left && right && left !== right;

/** Keeps the first occurrence in caller-supplied order. */
export function createTrackDeduplicator() {
  const ids = new Set();
  const isrcs = new Set();
  const recordings = new Set();
  const byTitleArtist = new Map();
  return (track) => {
    if (!track) return false;
    const trackIds = [track.id ?? track.trackId ?? track.songId, track.localTrackId]
      .filter((id) => id != null && String(id).trim() !== "").map(String);
    const knownId = trackIds.some((id) => ids.has(id));
    trackIds.forEach((id) => ids.add(id));
    if (knownId) return false;

    const hints = track.identityHints;
    const metadata = track.metadata;
    const isrc = code(hints?.isrc || metadata?.isrc || track.isrc);
    const recording = code(hints?.musicBrainzId || metadata?.musicBrainzId || track.musicBrainzId);
    if (isrcs.has(isrc) || recordings.has(recording)) return false;
    const title = normalizeRecordingText(track.title || track.trackName);
    const credit = track.artistCredits?.[0];
    const artistName = typeof track.artist === "string" ? track.artist : track.artist?.name;
    const artist = normalizeRecordingText(credit?.name || (typeof credit === "string" ? credit : null)
      || artistName || track.artistName);
    if (title && artist && title !== "unknown title" && title !== "unavailable track" && artist !== "unknown artist") {
      const duration = [track.durationSeconds, track.metadataDuration, track.duration, metadata?.durationSeconds]
        .map(Number).find((seconds) => Number.isFinite(seconds) && seconds > 0);
      const key = JSON.stringify([title, artist]);
      const group = byTitleArtist.get(key) || [];
      if (group.some((other) => !conflicts(isrc, other.isrc) && !conflicts(recording, other.recording)
        && (duration === undefined || other.duration === undefined || Math.abs(duration - other.duration) <= 5))) return false;
      group.push({ isrc, recording, duration });
      byTitleArtist.set(key, group);
    }
    if (isrc) isrcs.add(isrc);
    if (recording) recordings.add(recording);
    return true;
  };
}

export function uniqueTracks(tracks, limit = Infinity) {
  const keep = createTrackDeduplicator();
  const result = [];
  for (const track of tracks) {
    if (result.length >= limit) break;
    if (keep(track)) result.push(track);
  }
  return result;
}
