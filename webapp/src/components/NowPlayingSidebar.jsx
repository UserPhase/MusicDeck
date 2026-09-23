import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getCoverUrl,
  getTrackLyrics,
} from "../api/musicdeck";
import { useArtistBiography } from "../hooks/useArtistBiography";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";

import AudioBadge from "./AudioBadge";
import ArtistBiography from "./ArtistBiography";
import { activeLrcIndex, parseLrc } from "../utils/lrc";


function NowPlayingSidebar({ isOpen, onClose, onOpenQueue }) {
  const [lyrics, setLyrics] = useState(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const { currentSong, currentTime = 0, duration = 0, queue = [], queueIndex = -1 } = usePlayer();
  const nextTrack = queue[queueIndex + 1] || null;
  const trackId = currentSong?.id;
  const songTitle = currentSong?.title;
  const songArtist = currentSong?.artist;
  const artistId = currentSong?.artistId || currentSong?.metadata?.artistId || songArtist;
  const { biography, loading: isLoadingBiography } = useArtistBiography({
    artistId, artistName: songArtist, trackId, enabled: isOpen && Boolean(trackId),
  });
  const songAlbum = currentSong?.album;
  const lyricDuration = Math.round(Number(currentSong?.duration || currentSong?.metadata?.durationSeconds || duration) || 0);
  const lyricLines = useMemo(() => lyrics?.isSynced === false ? []
    : Array.isArray(lyrics?.syncedLyrics) ? lyrics.syncedLyrics : parseLrc(lyrics?.syncedLyrics),
  [lyrics?.syncedLyrics, lyrics?.isSynced]);
  const activeLine = lyrics?.isSynced === false ? -1 : activeLrcIndex(lyricLines, Number(currentTime));
  const lineRefs = useRef([]);

  useEffect(() => {
    let isCurrentRequest = true;
    setLyrics(null);
    if (!trackId) {
      setIsLoadingLyrics(false);
      return () => { isCurrentRequest = false; };
    }
    setIsLoadingLyrics(true);
    getTrackLyrics(trackId, {
      title: songTitle, artist: songArtist, album: songAlbum, duration: lyricDuration,
    }).then((result) => {
      if (!isCurrentRequest) return;
      setLyrics(result);
      setIsLoadingLyrics(false);
    }).catch(() => {
      if (isCurrentRequest) { setLyrics(null); setIsLoadingLyrics(false); }
    });
    return () => { isCurrentRequest = false; };
  }, [trackId, songTitle, songArtist, songAlbum, lyricDuration]);

  useEffect(() => {
    if (!isOpen || lyrics?.isSynced === false || activeLine < 0) return;
    const element = lineRefs.current[activeLine];
    if (typeof element?.scrollIntoView !== "function") return;
    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }, [activeLine, isOpen, trackId, lyrics?.isSynced]);

  if (!isOpen) return null;

  return (
    <aside className="right-sidebar now-playing-sidebar sidebar-panel" aria-label="Now Playing">
      <header className="sidebar-panel-header">
        <h2>Now Playing</h2>
        <button className="queue-sidebar-close" type="button" onClick={onClose} aria-label="Close Now Playing sidebar">×</button>
      </header>

      <div className="right-sidebar-now-playing">
        {!currentSong ? (
          <div className="right-sidebar-empty">Choose a track to see its story and lyrics.</div>
        ) : (
          <>
            <section className="right-sidebar-song-info" aria-labelledby="now-playing-title">
              <div className="right-sidebar-now-cover">
                {currentSong.coverArt ? <img src={getCoverUrl(currentSong.coverArt, 512)} alt="" width="512" height="512" /> : <span aria-hidden="true">♫</span>}
              </div>
              <div className="right-sidebar-song-kicker">Playing now</div>
              <h2 id="now-playing-title">{currentSong.title || "Unknown title"}</h2>
              <p>{currentSong.artist || "Unknown artist"}</p>
              <AudioBadge
                type={
                  currentSong.isPreview || currentSong.previewUrl
                    ? "preview"
                    : currentSong.audioType || currentSong.metadata?.codec || currentSong.source?.quality?.codec
                }
                bitrate={currentSong.bitrate || currentSong.metadata?.bitrate || currentSong.source?.quality?.bitrate}
                className="right-sidebar-audio-badge"
              />
            </section>

            <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-lyrics-title">
              <div className="right-sidebar-section-heading"><h3 id="now-playing-lyrics-title">Lyrics</h3><span aria-hidden="true">♪</span></div>
              <div className={`right-sidebar-lyrics${lyricLines.length ? " right-sidebar-lyrics--synced" : ""}`} tabIndex={lyrics ? 0 : undefined}>
                {isLoadingLyrics ? <span className="right-sidebar-metadata-state">Finding lyrics…</span>
                  : lyricLines.length ? <div className="right-sidebar-lyric-lines" aria-label="Synchronized lyrics">
                    {lyricLines.map((line, index) => <p key={`${line.time}-${index}`}
                      ref={(element) => { lineRefs.current[index] = element; }}
                      className={`right-sidebar-lyric-line${index === activeLine ? " is-active" : ""}`}
                      aria-current={index === activeLine ? "true" : undefined}>
                      {line.text || <span aria-label="Instrumental break">♪</span>}
                    </p>)}
                  </div> : lyrics?.plainLyrics ? <div className="right-sidebar-lyrics-plain">{lyrics.plainLyrics}</div>
                  : <span className="right-sidebar-metadata-state">Lyrics not available for this track.</span>}
              </div>
            </section>

            <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-artist-title">
              <div className="right-sidebar-section-heading"><h3 id="now-playing-artist-title">About the artist</h3><span aria-hidden="true">✦</span></div>
              <ArtistBiography biography={biography} loading={isLoadingBiography}
                emptyText="No artist biography is available yet." />
            </section>
          </>
        )}
      </div>

      <section className="now-playing-next-queue" aria-labelledby="next-in-queue-title">
        <header className="now-playing-next-header">
          <h3 id="next-in-queue-title">Next in queue</h3>
          <button type="button" onClick={onOpenQueue}>Open queue</button>
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
    </aside>
  );
}


export default NowPlayingSidebar;
