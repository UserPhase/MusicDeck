import { useEffect, useRef } from "react";

interface SessionPlayer {
  currentSong: { id: string | number; title?: string; artist?: unknown; album?: unknown } | null;
  isPlaying: boolean;
  isRemotePlayback: boolean;
  isCasting: boolean;
  currentTime: number;
  duration: number;
  togglePlay(): void | Promise<void>;
  previousSong(): void | Promise<void>;
  nextSong(): void | Promise<void>;
  seek(percent: number): void;
}

/** Keep OS media controls attached to the mounted local player across route changes. */
export function useBrowserMediaSession(player: SessionPlayer): void {
  const latest = useRef(player);
  latest.current = player;
  const available = typeof navigator !== "undefined" && "mediaSession" in navigator;
  const local = !player.isRemotePlayback && !player.isCasting;
  const song = player.currentSong;
  const hasSong = Boolean(song);
  const title = song?.title || "Unknown title";
  const artist = typeof song?.artist === "string" ? song.artist : "";
  const album = typeof song?.album === "string" ? song.album : "";

  useEffect(() => {
    if (!available) return;
    const session = navigator.mediaSession;
    const invoke = (operation: () => void | Promise<void>) => {
      try { void Promise.resolve(operation()).catch(error => console.warn("Media control failed:", error)); }
      catch (error) { console.warn("Media control failed:", error); }
    };
    const seek = (position: number) => {
      const current = latest.current;
      if (Number.isFinite(position) && current.duration > 0 && Number.isFinite(current.duration)) {
        current.seek(Math.min(100, Math.max(0, position / current.duration * 100)));
      }
    };
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { if (!latest.current.isPlaying) invoke(() => latest.current.togglePlay()); },
      pause: () => { if (latest.current.isPlaying) invoke(() => latest.current.togglePlay()); },
      previoustrack: () => invoke(() => latest.current.previousSong()),
      nexttrack: () => invoke(() => latest.current.nextSong()),
      seekto: event => seek(event.seekTime ?? latest.current.currentTime),
      seekbackward: event => seek(latest.current.currentTime - (event.seekOffset ?? 10)),
      seekforward: event => seek(latest.current.currentTime + (event.seekOffset ?? 10)),
    };
    const registered: MediaSessionAction[] = [];
    if (local) for (const [name, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(name as MediaSessionAction, handler!); registered.push(name as MediaSessionAction); }
      catch { /* Unsupported media actions vary by browser. */ }
    }
    return () => {
      for (const name of registered) session.setActionHandler(name, null);
      session.playbackState = "none";
      session.metadata = null;
    };
  }, [available, local]);

  useEffect(() => {
    if (!available) return;
    navigator.mediaSession.metadata = hasSong && local && typeof MediaMetadata !== "undefined"
      ? new MediaMetadata({ title, artist, album }) : null;
  }, [available, local, hasSong, title, artist, album]);

  useEffect(() => {
    if (!available) return;
    navigator.mediaSession.playbackState = !hasSong || !local ? "none" : player.isPlaying ? "playing" : "paused";
    const duration = player.duration, position = player.currentTime;
    if (typeof navigator.mediaSession.setPositionState === "function") {
      try {
        navigator.mediaSession.setPositionState(hasSong && local && Number.isFinite(duration) && duration > 0
          ? { duration, playbackRate: 1, position: Math.max(0, Math.min(duration, Number.isFinite(position) ? position : 0)) }
          : undefined);
      } catch { /* Some media implementations reject position updates while changing streams. */ }
    }
  }, [available, local, hasSong, player.isPlaying, player.duration, player.currentTime]);
}
