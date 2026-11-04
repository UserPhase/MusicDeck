// Approximate perceived loudness: each halving of the slider lowers gain by
// 10 dB. Keep mute exact and apply ReplayGain/crossfade gains afterwards.
const LOUDNESS_EXPONENT = Math.log2(10) / 2;

export function perceptualVolumeToGain(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value)) ** LOUDNESS_EXPONENT;
}

export function gainToPerceptualVolume(gain) {
  const value = Number(gain);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value)) ** (1 / LOUDNESS_EXPONENT);
}
