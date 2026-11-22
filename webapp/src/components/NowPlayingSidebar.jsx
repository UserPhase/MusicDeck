import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  getTrackLyrics,
} from "../api/musicdeck";
import { useArtistBiography } from "../hooks/useArtistBiography";
import { useAlbumArtwork } from "../hooks/useAlbumArtwork";
import { isDesktopRuntime } from "../services/desktop/desktopRuntime";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";

import AudioQualityBadge from "./player/AudioQualityBadge";
import ArtistBiography from "./ArtistBiography";
import TrackArtistLinks from "./TrackArtistLinks";
import LyricsView from "./player/LyricsView";
import PrivateListeningBadge from "./player/PrivateListeningBadge";
import { LyricsPlaybackControls, MobilePlaybackControls, MobileTrackActions } from "./Player";

function cycleDialogFocus(event) {
  const dialog = event.currentTarget;
  if (event.key !== "Tab" || event.defaultPrevented || !dialog.contains(event.target)) return;
  const controls = [...dialog.querySelectorAll("a[href], button:enabled, input:enabled, [tabindex='0']")]
    .filter((control) => control.tabIndex >= 0 && control.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.target !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first)?.focus();
}

function NowPlayingSidebar({
  isOpen, onClose, onOpenQueue, mobile = false, closeButtonRef, covered,
  queueButtonRef, fullScreenLyrics, onOpenLyrics, lyricsButtonRef,
}) {
  const [lyricsResult, setLyricsResult] = useState(null);
  const headerDrag = useRef(null);
  const player = usePlayer();
  const { currentSong, currentTime = 0, duration = 0, queue = [], queueIndex = -1,
    audioEngine, isRemotePlayback, playbackStatus, seekToSeconds } = player;
  const interpolateLyrics = !isDesktopRuntime();
  const readPosition = useCallback(() => audioEngine.getPosition(), [audioEngine]);
  const { url: coverUrl, onError: onCoverError } = useAlbumArtwork(currentSong, 512);
  const nextTrack = queue[queueIndex + 1] || null;
  const trackId = currentSong?.id;
  const songTitle = currentSong?.title;
  const songArtist = currentSong?.artist;
  const artistId = currentSong?.artistId || currentSong?.metadata?.artistId || songArtist;
  const { biography, loading: isLoadingBiography, error: biographyError } = useArtistBiography({
    artistId, artistName: songArtist, trackId, enabled: isOpen && Boolean(trackId),
  });
  const songAlbum = currentSong?.album;
  const lyricDuration = Math.round(Number(currentSong?.duration || currentSong?.metadata?.durationSeconds || duration) || 0);
  const result = lyricsResult?.trackId === trackId ? lyricsResult : null;

  useEffect(() => {
    let isCurrentRequest = true;
    if (!trackId) {
      setLyricsResult(null);
      return () => { isCurrentRequest = false; };
    }
    getTrackLyrics(trackId, {
      title: songTitle, artist: songArtist, album: songAlbum, duration: lyricDuration,
    }).then((result) => {
      if (!isCurrentRequest) return;
      setLyricsResult({ trackId, lyrics: result });
    }).catch(() => {
      if (isCurrentRequest) setLyricsResult({ trackId, error: "Could not load lyrics." });
    });
    return () => { isCurrentRequest = false; };
  }, [trackId, songTitle, songArtist, songAlbum, lyricDuration]);

  if (!isOpen) return null;

  function startSwipe(event) {
    if (event.pointerType !== "touch" || !event.isPrimary ||
      event.target.closest("button, a, input, select, textarea")) return;
    headerDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSwipe(event) {
    const drag = headerDrag.current;
    if (drag?.id !== event.pointerId) return;
    const down = event.clientY - drag.y;
    const sideways = Math.abs(event.clientX - drag.x);
    const offset = down > sideways * 1.25 ? Math.max(0, down - 12) : 0;
    event.currentTarget.parentElement.style.setProperty("--now-playing-swipe-offset", `${offset}px`);
  }

  function finishSwipe(event) {
    const drag = headerDrag.current;
    if (drag?.id !== event.pointerId) return;
    headerDrag.current = null;
    event.currentTarget.parentElement.style.removeProperty("--now-playing-swipe-offset");
    const down = event.clientY - drag.y;
    if (event.type === "pointerup" && down >= 72 && down > Math.abs(event.clientX - drag.x) * 1.25) onClose();
  }

  const trackInfo = currentSong ? (
    <section className="right-sidebar-song-info" aria-labelledby="now-playing-title">
      <div className="right-sidebar-now-cover">
        {coverUrl ? <img src={coverUrl} onError={onCoverError} alt="" width="512" height="512" /> : <span aria-hidden="true">♫</span>}
      </div>
      <div className="now-playing-track-summary">
        <div className="now-playing-track-copy">
          {!mobile && <div className="right-sidebar-song-kicker">Playing now</div>}
          <h2 id="now-playing-title">{currentSong.title || "Unknown title"}</h2>
          <p>{mobile ? currentSong.artist || "Unknown artist" : <TrackArtistLinks song={currentSong} />}</p>
          {mobile && player.isPreview ? <span className="audio-badge audio-badge-preview">Preview</span>
            : <AudioQualityBadge className="right-sidebar-audio-badge" />}
        </div>
        {mobile && <div className="mobile-track-actions"><MobileTrackActions player={player} /></div>}
      </div>
    </section>
  ) : (
    <div className="right-sidebar-empty">{mobile ? "Choose a track to start listening." : "Choose a track to see its story and lyrics."}</div>
  );

  const nextQueue = (
    <section className="now-playing-next-queue" aria-labelledby="next-in-queue-title">
      <header className="now-playing-next-header">
        <h3 id="next-in-queue-title">Next in queue</h3>
        {!mobile && <button type="button" onClick={onOpenQueue}>Open queue</button>}
      </header>
      {nextTrack ? (
        <div className="now-playing-next-track">
          <span className="now-playing-next-index" aria-hidden="true">→</span>
          <span className="queue-sidebar-track-info">
            <span className="queue-sidebar-track-title">{nextTrack.title || "Unknown title"}</span>
            <span className="queue-sidebar-track-artist">{nextTrack.artist || "Unknown artist"}</span>
          </span>
          <span className="queue-sidebar-track-duration">
            {formatDuration(nextTrack.duration ?? nextTrack.metadata?.durationSeconds)}
          </span>
        </div>
      ) : (
        <p className="queue-sidebar-empty">Nothing queued next.</p>
      )}
    </section>
  );

  return (
    <aside className={`right-sidebar now-playing-sidebar sidebar-panel${covered ? " is-covered" : ""}`}
      role={mobile ? "dialog" : undefined} inert={covered || undefined}
      aria-label="Now Playing" aria-modal={(mobile && !covered) || undefined}
      onKeyDown={mobile ? cycleDialogFocus : undefined}>
      <header className="sidebar-panel-header"
        onPointerDown={mobile ? startSwipe : undefined}
        onPointerMove={mobile ? moveSwipe : undefined}
        onPointerUp={mobile ? finishSwipe : undefined}
        onPointerCancel={mobile ? finishSwipe : undefined}
        onLostPointerCapture={mobile ? finishSwipe : undefined}>
        <h2>Now Playing</h2>
        <div className="now-playing-header-actions">
          <PrivateListeningBadge />
          <button className="queue-sidebar-close" type="button" ref={closeButtonRef}
            onClick={onClose} aria-label={mobile ? "Close Now Playing" : "Close Now Playing sidebar"}>×</button>
        </div>
      </header>

      <div className="right-sidebar-now-playing">
        {mobile ? (
          <div className="mobile-now-playing-deck">
            {trackInfo}
            <MobilePlaybackControls player={player} onOpenQueue={onOpenQueue} queueButtonRef={queueButtonRef} />
          </div>
        ) : trackInfo}

        {currentSong && (
          <>
            <LyricsView trackId={String(trackId ?? "")} title={songTitle || "Unknown title"} artist={songArtist}
              artwork={coverUrl} lyrics={result?.lyrics ?? null} loading={Boolean(trackId && !result)}
              mobile={mobile} readerControls={mobile ? <LyricsPlaybackControls player={player} /> : undefined}
              fullScreen={fullScreenLyrics} onOpenFullScreen={onOpenLyrics} onCloseFullScreen={onOpenLyrics ? onClose : undefined}
              fullScreenButtonRef={lyricsButtonRef}
              error={result?.error} currentTime={Number(currentTime)} positionSource={player} seekToSeconds={seekToSeconds}
              readPosition={interpolateLyrics && audioEngine && !isRemotePlayback && ["PLAYING", "TRANSITIONING"].includes(playbackStatus)
                ? readPosition : undefined} />

            <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-artist-title">
              <div className="right-sidebar-section-heading"><h3 id="now-playing-artist-title">About the artist</h3><span aria-hidden="true">✦</span></div>
              <ArtistBiography biography={biography} loading={isLoadingBiography}
                emptyText={biographyError || "No artist biography is available yet."} />
            </section>
          </>
        )}
        {mobile && nextQueue}
      </div>
      {!mobile && nextQueue}
    </aside>
  );
}


export default NowPlayingSidebar;
