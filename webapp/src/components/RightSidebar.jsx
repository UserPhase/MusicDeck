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


function RightSidebar({
  isOpen,
  onToggle,
}) {
  const [activeTab, setActiveTab] = useState("now-playing");
  const [lyrics, setLyrics] = useState(null);
  const [biography, setBiography] = useState(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [isLoadingBiography, setIsLoadingBiography] = useState(false);
  const [isBiographyExpanded, setIsBiographyExpanded] = useState(false);
  const {
    currentSong,
    queue = [],
    queueIndex = -1,
  } = usePlayer();

  useEffect(() => {
    let isCurrentRequest = true;
    const trackId = currentSong?.id;

    setLyrics(null);
    setBiography(null);
    setIsBiographyExpanded(false);

    if (!trackId) {
      setIsLoadingLyrics(false);
      setIsLoadingBiography(false);
      return () => {
        isCurrentRequest = false;
      };
    }

    setIsLoadingLyrics(true);
    setIsLoadingBiography(true);

    async function fetchLyrics() {
      try {
        return await getTrackLyrics(trackId);
      } catch {
        return null;
      }
    }

    async function fetchArtistBiography() {
      try {
        return await getTrackArtistBiography(trackId);
      } catch {
        return null;
      }
    }

    Promise.allSettled([fetchLyrics(), fetchArtistBiography()]).then(([lyricsResult, biographyResult]) => {
      if (!isCurrentRequest) return;

      setLyrics(lyricsResult.status === "fulfilled" ? lyricsResult.value : null);
      setBiography(biographyResult.status === "fulfilled" ? biographyResult.value : null);
      setIsLoadingLyrics(false);
      setIsLoadingBiography(false);
    });

    return () => {
      isCurrentRequest = false;
    };
  }, [currentSong?.id]);

  if (!isOpen) {
    return (
      <button
        className="right-sidebar-reopen"
        type="button"
        onClick={onToggle}
        aria-label="Open context sidebar"
        title="Open context sidebar"
      >
        ☰
      </button>
    );
  }

  return (
    <aside className="right-sidebar" aria-label="Playback context">
      <div className="right-sidebar-header">
        <div className="right-sidebar-tabs" role="tablist" aria-label="Sidebar view">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "now-playing"}
            className={activeTab === "now-playing" ? "active" : ""}
            onClick={() => setActiveTab("now-playing")}
          >
            Now Playing
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "queue"}
            className={activeTab === "queue" ? "active" : ""}
            onClick={() => setActiveTab("queue")}
          >
            Queue
          </button>
        </div>

        <button
          className="right-sidebar-collapse"
          type="button"
          onClick={onToggle}
          aria-label="Close context sidebar"
          title="Close context sidebar"
        >
          ›
        </button>
      </div>

      {activeTab === "now-playing" ? (
        <div className="right-sidebar-now-playing" role="tabpanel" aria-label="Now Playing">
          {!currentSong ? (
            <div className="right-sidebar-empty">Choose a track to see its story and lyrics.</div>
          ) : (
            <>
              <section className="right-sidebar-song-info" aria-labelledby="now-playing-title">
                <div className="right-sidebar-now-cover">
                  {currentSong.coverArt ? (
                    <img
                      src={getCoverUrl(currentSong.coverArt, 512)}
                      alt=""
                    />
                  ) : (
                    <span aria-hidden="true">♫</span>
                  )}
                </div>
                <div className="right-sidebar-song-kicker">Playing now</div>
                <h2 id="now-playing-title">{currentSong.title || "Unknown title"}</h2>
                <p>{currentSong.artist || "Unknown artist"}</p>
              </section>

              <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-lyrics-title">
                <div className="right-sidebar-section-heading">
                  <h3 id="now-playing-lyrics-title">Lyrics</h3>
                  <span aria-hidden="true">♪</span>
                </div>
                <div className="right-sidebar-lyrics" tabIndex={lyrics ? 0 : undefined}>
                  {isLoadingLyrics ? (
                    <span className="right-sidebar-metadata-state">Finding lyrics…</span>
                  ) : lyrics ? (
                    lyrics
                  ) : (
                    <span className="right-sidebar-metadata-state">No lyrics available for this track.</span>
                  )}
                </div>
              </section>

              <section className="right-sidebar-metadata-section" aria-labelledby="now-playing-artist-title">
                <div className="right-sidebar-section-heading">
                  <h3 id="now-playing-artist-title">About the artist</h3>
                  <span aria-hidden="true">✦</span>
                </div>
                {isLoadingBiography ? (
                  <p className="right-sidebar-metadata-state">Finding the artist story…</p>
                ) : biography ? (
                  <>
                    <div
                      className={`right-sidebar-biography${isBiographyExpanded ? " expanded" : ""}`}
                      tabIndex={isBiographyExpanded ? 0 : undefined}
                    >
                      {biography}
                    </div>
                    {biography.length > 280 && (
                      <button
                        className="right-sidebar-read-more"
                        type="button"
                        onClick={() => setIsBiographyExpanded((expanded) => !expanded)}
                        aria-expanded={isBiographyExpanded}
                      >
                        {isBiographyExpanded ? "Show less" : "Read more"}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="right-sidebar-metadata-state">No artist biography is available yet.</p>
                )}
              </section>
            </>
          )}
        </div>
      ) : (
        <div className="right-sidebar-queue" role="list" aria-label="Playback queue">
          {queue.length === 0 ? (
            <div className="right-sidebar-empty">Your queue is empty.</div>
          ) : (
            queue.map((song, index) => {
              const isCurrent = index === queueIndex;
              const duration = song.duration ?? song.metadata?.durationSeconds;

              return (
                <div
                  key={`${song.id}-${index}`}
                  className={`right-sidebar-track${isCurrent ? " current" : ""}`}
                  role="listitem"
                  aria-current={isCurrent ? "true" : undefined}
                >
                  <span className="right-sidebar-track-index">
                    {isCurrent ? "•" : index + 1}
                  </span>
                  <span className="right-sidebar-track-info">
                    <span className="right-sidebar-track-title">{song.title || "Unknown title"}</span>
                    <span className="right-sidebar-track-artist">{song.artist || "Unknown artist"}</span>
                  </span>
                  <span className="right-sidebar-track-duration">{formatDuration(duration)}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}


export default RightSidebar;
