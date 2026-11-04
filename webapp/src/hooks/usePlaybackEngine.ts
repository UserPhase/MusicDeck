import { useEffect, useRef, useState } from "react";
import { PlaybackEngine } from "../services/audio/PlaybackEngine";
import type { PlaybackEngineOptions } from "../services/audio/PlaybackEngine";

/**
 * Creates one PlaybackEngine per mounted owner and destroys it (audio nodes,
 * elements, timers, in-flight fetches) on unmount. Construction options are
 * read once; transition mode, crossfade window and volume stay live.
 */
export function usePlaybackEngine(options: PlaybackEngineOptions = {}): PlaybackEngine | null {
  const [engine, setEngine] = useState<PlaybackEngine | null>(null);
  const initialOptions = useRef(options);
  const { transitionMode, crossfadeSeconds, crossfadeCurve, volume, albumAware } = options;

  useEffect(() => {
    const instance = new PlaybackEngine(initialOptions.current);
    setEngine(instance);
    return () => {
      instance.destroy();
      setEngine(null);
    };
  }, []);

  useEffect(() => {
    if (engine && transitionMode) engine.setTransitionMode(transitionMode);
  }, [engine, transitionMode]);

  useEffect(() => {
    if (engine && typeof albumAware === "boolean") engine.setAlbumAware(albumAware);
  }, [engine, albumAware]);

  useEffect(() => {
    if (engine && typeof crossfadeSeconds === "number") engine.setCrossfadeSeconds(crossfadeSeconds);
  }, [engine, crossfadeSeconds]);

  useEffect(() => {
    if (engine && crossfadeCurve) engine.setCrossfadeCurve(crossfadeCurve);
  }, [engine, crossfadeCurve]);

  useEffect(() => {
    if (engine && typeof volume === "number") engine.setVolume(volume);
  }, [engine, volume]);

  return engine;
}
