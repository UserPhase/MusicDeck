import {
  useEffect,
  useState,
} from "react";

import {
  getCoverUrl,
  getTrackArtistBiography,
  getTrackLyrics,
} from "../api/musicdeck";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";

import AudioBadge from "./AudioBadge";


function NowPlayingSidebar({ isOpen, onClose, onOpenQueue }) {
  const [lyrics, setLyrics] = useState(null);
  const [biography, setBiography] = useState(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [isLoadingBiography, setIsLoadingBiography] = useState(false);
  const [isBiographyExpanded, setIsBiographyExpanded] = useState(false);
  const { currentSong, queue = [], queueIndex = -1 } = usePlayer();
  const nextTrack = queue[queueIndex + 1] || null;

  useEffect(() => {
    let isCurrentRequest = true;
    const trackId = currentSong?.id;

    setLyrics(null);
    setBiography(null);
    setIsBiographyExpanded(false);

    if (!isOpen || !trackId) {
      setIsLoadingLyrics(false);
      setIsLoadingBiography(false);
      return () => { isCurrentRequest = false; };
    }

    setIsLoadingLyrics(true);
    setIsLoadingBiography(true);

    Promise.allSettled([getTrackLyrics(trackId), getTrackArtistBiography(trackId)]).then(([lyricsResult, biographyResult]) => {
      if (!isCurrentRequest) return;
      setLyrics(lyricsResult.status === "fulfilled" ? lyricsResult.value : null);
      setBiography(biographyResult.status === "fulfilled" ? biographyResult.value : null);
      setIsLoadingLyrics(false);
      setIsLoadingBiography(false);
    });

    return () => { isCurrentRequest = false; };
  }, [currentSong?.id, isOpen]);

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
              <div className="right-sidebar-lyrics" tabIndex={lyrics ? 0 : undefined}>
                {isLoadingLyrics ? <span className="right-sidebar-metadata-state">Finding lyrics…</span> : lyrics || <span className="right-sidebar-metadata-state">No lyrics available for this track.</span>}
              </div>
            </section>

            <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-artist-title">
              <div className="right-sidebar-section-heading"><h3 id="now-playing-artist-title">About the artist</h3><span aria-hidden="true">✦</span></div>
              {isLoadingBiography ? <p className="right-sidebar-metadata-state">Finding the artist story…</p> : biography ? (
                <>
                  <div className={`right-sidebar-biography${isBiographyExpanded ? " expanded" : ""}`}>{biography}</div>
                  {biography.length > 280 && <button className="right-sidebar-read-more" type="button" onClick={() => setIsBiographyExpanded((expanded) => !expanded)} aria-expanded={isBiographyExpanded}>{isBiographyExpanded ? "Show less" : "Read more"}</button>}
                </>
              ) : <p className="right-sidebar-metadata-state">No artist biography is available yet.</p>}
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
