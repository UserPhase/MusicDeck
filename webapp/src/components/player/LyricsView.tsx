import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { useAuth } from "../../context/AuthContext";
import { offlineDownloadEngine } from "../../services/storage/OfflineDownloadEngine";
import {
  activeLyricIndex, normalizeLyricLines, useLyricsOffset,
  type LyricLine,
} from "../../hooks/useLyricsOffset";
import FullScreenLyricsModal from "./FullScreenLyricsModal";
import "../../styles/lyrics-view.css";
import { useVisualActivity } from "../../hooks/useVisualActivity";
import { usePlaybackDisplayPosition, type PlaybackPositionSource } from "../../hooks/usePlaybackDisplayPosition";

export type LyricsData = {
  syncedLyrics?: unknown;
  plainLyrics?: string | null;
  isSynced?: boolean;
  instrumental?: boolean;
};

type Props = {
  trackId: string;
  title: string;
  artist?: string;
  artwork?: string | null;
  lyrics: LyricsData | null;
  loading: boolean;
  error?: string;
  currentTime: number;
  positionSource?: PlaybackPositionSource;
  readPosition?: () => number;
  seekToSeconds?: (seconds: number) => void;
  fullScreen?: boolean;
  onOpenFullScreen?: () => void;
  onCloseFullScreen?: () => void;
  fullScreenButtonRef?: Ref<HTMLButtonElement>;
  mobile?: boolean;
  readerControls?: ReactNode;
};

const LyricRow = memo(function LyricRow({ line, active, seek }: {
  line: LyricLine; active: boolean; seek?: (milliseconds: number) => void;
}) {
  return <button type="button" className={`right-sidebar-lyric-line${active ? " is-active" : ""}`}
    aria-current={active ? "true" : undefined} disabled={!seek}
    onClick={() => seek?.(line.timestampMs)}>
    {line.text || <span aria-label="Instrumental break">♪</span>}
  </button>;
});

function LyricLines({ lines, offsetMs, currentTime, positionSource, readPosition, seek, plain, loading, error, preferenceError, mobileReader }: {
  lines: readonly LyricLine[];
  offsetMs: number;
  currentTime: number;
  positionSource?: PlaybackPositionSource;
  readPosition?: () => number;
  seek?: (milliseconds: number) => void;
  plain?: string | null;
  loading: boolean;
  error?: string;
  preferenceError?: string;
  mobileReader?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const visualActive = useVisualActivity();
  const position = usePlaybackDisplayPosition(positionSource ?? { currentTime }, lines.length > 0, 0.25);
  const lastScroll = useRef(-Infinity);
  const lastManualScroll = useRef(-Infinity);
  const [live, setLive] = useState<{ lines: readonly LyricLine[]; offsetMs: number; index: number }>();
  const active = readPosition && live?.lines === lines && live.offsetMs === offsetMs
    ? live.index : activeLyricIndex(lines, position * 1000, offsetMs);

  useEffect(() => {
    if (!visualActive || !readPosition || !lines.length) return;
    let frame = 0;
    let previous = -2;
    const tick = () => {
      const index = activeLyricIndex(lines, readPosition() * 1000, offsetMs);
      if (index !== previous) {
        previous = index;
        setLive({ lines, offsetMs, index });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [readPosition, lines, offsetMs, visualActive]);

  const center = useCallback((behavior: ScrollBehavior) => {
    if (!visualActive || performance.now() - lastManualScroll.current < 4000) return;
    const container = scroller.current;
    const line = container?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!container || !line) return;
    const lineRect = line.getBoundingClientRect();
    const top = container.scrollTop + lineRect.top - container.getBoundingClientRect().top
      - (container.clientHeight - lineRect.height) / 2;
    if (typeof container.scrollTo === "function") container.scrollTo({ top: Math.max(0, top), behavior });
    else container.scrollTop = Math.max(0, top);
  }, [visualActive]);

  const timed = lines.length > 0;
  useEffect(() => {
    const container = scroller.current;
    if (!container || !timed) return;
    const resize = () => {
      container.style.setProperty("--lyrics-center-space", `${container.clientHeight / 2}px`);
      center("auto");
    };
    resize();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    return () => observer?.disconnect();
  }, [timed, center]);
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const now = performance.now();
    center(reduced || now - lastScroll.current < 250 ? "auto" : "smooth");
    lastScroll.current = now;
  }, [active, center, lines, offsetMs]);

  const rememberManualScroll = mobileReader ? () => { lastManualScroll.current = performance.now(); } : undefined;
  return <div ref={scroller} className={`right-sidebar-lyrics lyrics-scroll${timed ? " right-sidebar-lyrics--synced" : ""}`}
    onWheel={rememberManualScroll} onTouchMove={rememberManualScroll}
    onKeyDown={mobileReader ? (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) rememberManualScroll?.();
    } : undefined}
    tabIndex={timed || plain ? 0 : undefined} aria-label={timed ? "Synchronized lyrics" : "Lyrics text"}>
    {preferenceError && <p className="lyrics-reader-notice" role="alert">{preferenceError}</p>}
    {loading ? <span role="status" className="right-sidebar-metadata-state">Finding lyrics…</span>
      : timed ? <div className="right-sidebar-lyric-lines">
        {lines.map((line, index) => <LyricRow key={`${line.timestampMs}:${index}`} line={line} active={index === active} seek={seek} />)}
      </div> : plain ? <div className="right-sidebar-lyrics-plain">{plain}</div>
        : <span className="right-sidebar-metadata-state">{error || "Lyrics not available for this track."}</span>}
  </div>;
}

function LyricsPreview({ lines, offsetMs, currentTime, positionSource, plain, loading, error, paused }: {
  lines: readonly LyricLine[];
  offsetMs: number;
  currentTime: number;
  positionSource?: PlaybackPositionSource;
  plain?: string | null;
  loading: boolean;
  error?: string;
  paused: boolean;
}) {
  const position = usePlaybackDisplayPosition(positionSource ?? { currentTime }, !paused && lines.length > 0, .25);
  const active = activeLyricIndex(lines, position * 1000, offsetMs);
  const start = Math.max(0, Math.min(active, lines.length - 3));
  return <div className="lyrics-preview">
    {loading ? <p className="lyrics-preview-excerpt" role="status">Finding lyrics.</p>
      : lines.length ? lines.slice(start, start + 3).map((line, index) => (
        <p className="lyrics-preview-line" aria-current={start + index === active ? "true" : undefined}
          key={`${line.timestampMs}:${start + index}`}>{line.text || "Instrumental break"}</p>
      )) : plain ? <p className="lyrics-preview-excerpt">{plain.trim()}</p>
        : <p className="lyrics-preview-excerpt">{error || "Lyrics not available for this track."}</p>}
  </div>;
}

export default function LyricsView({
  trackId, title, artist, artwork, lyrics, loading, error, currentTime, positionSource, readPosition, seekToSeconds,
  fullScreen, onOpenFullScreen, onCloseFullScreen, fullScreenButtonRef, mobile = false, readerControls,
}: Props) {
  const auth = useAuth();
  const account = auth?.session?.id ?? null;
  const owner = account ?? (auth && !auth.isLoading ? offlineDownloadEngine.getOwner() : null);
  const prefs = useLyricsOffset(owner, trackId);
  const [localFullScreen, setLocalFullScreen] = useState(false);
  const timedInput = prefs.replacement ?? (lyrics?.isSynced === false ? null : lyrics?.syncedLyrics);
  const lines = useMemo(() => normalizeLyricLines(timedInput), [timedInput]);
  const seekRef = useRef(seekToSeconds);
  seekRef.current = seekToSeconds;
  const seek = useCallback((milliseconds: number) => {
    seekRef.current?.(Math.max(0, milliseconds + prefs.offsetMs) / 1000);
  }, [prefs.offsetMs]);
  const readerOpen = fullScreen ?? localFullScreen;
  const lyricsCopy = {
    lines, offsetMs: prefs.offsetMs, currentTime, positionSource, plain: prefs.replacement ?? lyrics?.plainLyrics,
    loading: loading && prefs.replacement === null, error,
  };
  const display = <>
    {!mobile && prefs.error && <p role="alert">{prefs.error}</p>}
    <LyricLines {...lyricsCopy} readPosition={readPosition} seek={seekToSeconds ? seek : undefined}
      preferenceError={mobile ? prefs.error : undefined} mobileReader={mobile} />
  </>;
  return <section className="right-sidebar-metadata-section lyrics-view" aria-label="Lyrics">
    <div className="right-sidebar-section-heading">
      <h3>Lyrics</h3>
      <button type="button" aria-haspopup="dialog" ref={fullScreenButtonRef}
        onClick={onOpenFullScreen ?? (() => setLocalFullScreen(true))}>Full screen</button>
    </div>
    {mobile && <LyricsPreview {...lyricsCopy} paused={readerOpen} />}
    {readerOpen ? <FullScreenLyricsModal title={title} artist={artist} artwork={artwork}
      onClose={onCloseFullScreen ?? (() => setLocalFullScreen(false))} mobile={mobile} controls={readerControls}>
      {display}
    </FullScreenLyricsModal> : !mobile && display}
  </section>;
}
