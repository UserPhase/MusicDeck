import {
  useCallback,
  useEffect,
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


function NowPlayingSidebar({ isOpen, onClose, onOpenQueue }) {
  const [lyricsResult, setLyricsResult] = useState(null);
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

  return (
    <aside className="right-sidebar now-playing-sidebar sidebar-panel" aria-label="Now Playing">
      <header className="sidebar-panel-header">
        <h2>Now Playing</h2>
        <div className="now-playing-header-actions">
          <PrivateListeningBadge />
          <button className="queue-sidebar-close" type="button" onClick={onClose} aria-label="Close Now Playing sidebar">×</button>
        </div>
      </header>

      <div className="right-sidebar-now-playing">
        {!currentSong ? (
          <div className="right-sidebar-empty">Choose a track to see its story and lyrics.</div>
        ) : (
          <>
            <section className="right-sidebar-song-info" aria-labelledby="now-playing-title">
              <div className="right-sidebar-now-cover">
                {coverUrl ? <img src={coverUrl} onError={onCoverError} alt="" width="512" height="512" /> : <span aria-hidden="true">♫</span>}
              </div>
              <div className="right-sidebar-song-kicker">Playing now</div>
              <h2 id="now-playing-title">{currentSong.title || "Unknown title"}</h2>
              <p><TrackArtistLinks song={currentSong} /></p>
              <AudioQualityBadge className="right-sidebar-audio-badge" />
            </section>

            <LyricsView trackId={String(trackId ?? "")} title={songTitle || "Unknown title"} artist={songArtist}
              artwork={coverUrl} lyrics={result?.lyrics ?? null} loading={Boolean(trackId && !result)}
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
