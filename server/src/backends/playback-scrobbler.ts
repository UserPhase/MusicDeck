/** Optional provider capability: submit a qualified play using its native ID. */
export interface PlaybackScrobbler {
  scrobbleTrack(trackId: string, playedAt?: number): Promise<void>;
}

export function hasPlaybackScrobbler(provider: unknown): provider is PlaybackScrobbler {
  return Boolean(provider && typeof (provider as Partial<PlaybackScrobbler>).scrobbleTrack === "function");
}
