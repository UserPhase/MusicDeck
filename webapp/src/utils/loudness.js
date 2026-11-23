export const DEFAULT_LOUDNESS_TARGET = -16;
export const LOUDNESS_TARGETS = [-18, -16, -14];

export function replayGainMetadata(song) {
  const tags = song?.replayGain || song?.metadata?.replayGain || {};
  const number = (value) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    trackGainDb: number(tags.trackGainDb ?? tags.trackGain ?? song?.replayGainTrackGainDb ?? song?.replayGainTrackGain ??
      song?.metadata?.replayGainTrackGainDb ?? song?.metadata?.replayGainTrackGain),
    albumGainDb: number(tags.albumGainDb ?? tags.albumGain ?? song?.replayGainAlbumGainDb ?? song?.replayGainAlbumGain ??
      song?.metadata?.replayGainAlbumGainDb ?? song?.metadata?.replayGainAlbumGain),
    trackPeak: number(tags.trackPeak),
    albumPeak: number(tags.albumPeak),
  };
}

export function validLoudness(value) {
  return value && Number.isFinite(value.integratedLufs) && value.integratedLufs >= -100 && value.integratedLufs <= 20 &&
    Number.isFinite(value.truePeakDb) && value.truePeakDb >= -100 && value.truePeakDb <= 20
    ? { integratedLufs: value.integratedLufs, truePeakDb: value.truePeakDb } : undefined;
}

export function loudnessGainDb(measurement, target = DEFAULT_LOUDNESS_TARGET) {
  const safe = validLoudness(measurement);
  if (!safe || !LOUDNESS_TARGETS.includes(target)) return undefined;
  const maxBoost = safe.integratedLufs < -65 ? 0 : 12;
  return Math.min(maxBoost, target - safe.integratedLufs, -1 - safe.truePeakDb);
}

export function preparedPlaybackGainDb(output, original, target) {
  const encoded = validLoudness(output);
  if (!encoded || !LOUDNESS_TARGETS.includes(target)) return undefined;
  const source = validLoudness(original);
  const desired = source ? source.integratedLufs + loudnessGainDb(source, target) : target;
  return Math.min(desired - encoded.integratedLufs, source ? 12 : 0, -1 - encoded.truePeakDb);
}

export function trackGainDb(song, target) {
  const measured = loudnessGainDb(song?.loudness ?? song?.metadata?.loudness, target);
  if (measured !== undefined) return measured;
  // Legacy gains were measured at -16; peak limiting makes offsets unreliable.
  const legacy = song?.normalizationGainDb ?? song?.metadata?.normalizationGainDb;
  if (target !== DEFAULT_LOUDNESS_TARGET || !Number.isFinite(legacy)) return undefined;
  if (legacy <= 0) return legacy;
  const peak = replayGainMetadata(song).trackPeak;
  return peak > 0 ? Math.min(legacy, 12, -1 - 20 * Math.log10(peak)) : undefined;
}
