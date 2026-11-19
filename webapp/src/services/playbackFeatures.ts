const defaults = {
  remoteControl: true,
  streamInspection: true,
  serverNormalization: true,
  queueCloudSync: true,
  mediaSessions: true,
  listeningEvents: true,
  silenceTrimming: true,
  autoplayRecommendations: true,
  audioEffects: true,
};

/** Per-browser overrides. Reload the player after changing a flag. */
export function playbackFeatureEnabled(feature: keyof typeof defaults): boolean {
  try {
    const override = localStorage.getItem(`musicdeck:playback:${feature}`)
      ?? (feature === "queueCloudSync" ? localStorage.getItem("musicdeck:playback:queueSync") : null);
    if (override === "true" || override === "false") return override === "true";
  } catch {
    // Playback also works when the browser denies access to storage.
  }
  return defaults[feature];
}
