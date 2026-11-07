import { useLayoutEffect, useState } from "react";
import { isDesktopRuntime } from "../services/desktop/desktopRuntime";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";
import { useVisualActivity } from "./useVisualActivity";

export type PlaybackPositionSource = {
  currentTime?: number;
  isPlaying?: boolean;
  playbackPositionKey?: string;
  audioEngine?: PlaybackEngine | null;
  readPlaybackPosition?: () => number;
};

/** Sample the desktop's local audio clock without updating the shared player context. */
export function usePlaybackDisplayPosition(
  { currentTime = 0, isPlaying, playbackPositionKey, audioEngine, readPlaybackPosition }: PlaybackPositionSource,
  enabled = true,
  resolution = 1,
): number {
  const visualActive = useVisualActivity();
  const desktopClock = isDesktopRuntime() && audioEngine && readPlaybackPosition;
  const [position, setPosition] = useState(currentTime);

  useLayoutEffect(() => {
    if (!desktopClock || !audioEngine || !readPlaybackPosition || !enabled || !visualActive) return;
    let bucket = -1;
    const sample = (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      const nextBucket = Math.floor(seconds / resolution);
      if (bucket === nextBucket) return;
      bucket = nextBucket;
      setPosition(seconds);
    };
    sample(readPlaybackPosition());
    return audioEngine.on("timeUpdate", ({ position }) => sample(position));
  }, [audioEngine, currentTime, desktopClock, enabled, isPlaying, playbackPositionKey, readPlaybackPosition, resolution, visualActive]);

  return desktopClock ? position : currentTime;
}
