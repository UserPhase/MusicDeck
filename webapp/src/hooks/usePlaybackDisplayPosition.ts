import { useLayoutEffect, useState } from "react";
import { isDesktopRuntime } from "../services/desktop/desktopRuntime";
import type { PlaybackEngine } from "../services/audio/PlaybackEngine";
import { useVisualActivity } from "./useVisualActivity";

export type PlaybackPositionSource = {
  currentTime?: number;
  isPlaying?: boolean;
  isRemotePlayback?: boolean;
  playbackPositionKey?: string;
  audioEngine?: PlaybackEngine | null;
  readPlaybackPosition?: () => number;
};

/** Sample the desktop's local audio clock without updating the shared player context. */
export function usePlaybackDisplayPosition(
  { currentTime = 0, isPlaying, isRemotePlayback, playbackPositionKey, audioEngine, readPlaybackPosition }: PlaybackPositionSource,
  enabled = true,
  resolution = 1,
): number {
  const visualActive = useVisualActivity();
  const desktopClock = !isRemotePlayback && isDesktopRuntime() && audioEngine && readPlaybackPosition;
  const remoteClock = isRemotePlayback && readPlaybackPosition;
  const [position, setPosition] = useState(currentTime);

  useLayoutEffect(() => {
    if ((!desktopClock && !remoteClock) || !readPlaybackPosition || !enabled || !visualActive) return;
    let bucket = -1;
    const sample = (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      const nextBucket = Math.floor(seconds / resolution);
      if (bucket === nextBucket) return;
      bucket = nextBucket;
      setPosition(seconds);
    };
    sample(readPlaybackPosition());
    if (remoteClock) {
      if (!isPlaying) return;
      let frame: number;
      const tick = () => {
        sample(remoteClock());
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    return audioEngine?.on("timeUpdate", ({ position }) => sample(position));
  }, [audioEngine, currentTime, desktopClock, remoteClock, enabled, isPlaying, playbackPositionKey, readPlaybackPosition, resolution, visualActive]);

  return desktopClock || remoteClock ? position : currentTime;
}
