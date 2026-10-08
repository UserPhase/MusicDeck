import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getPlaylists } from "../../api/playlists";
import { usePlayer } from "../../context/PlayerContext";
import { useAlbumArtwork } from "../../hooks/useAlbumArtwork";
import PlaylistCover from "../PlaylistCover";


function WidgetTrack({ song, onPlay, isCurrent = false }) {
  const { url, onError } = useAlbumArtwork(song, 40);
  return (
    <li>
      <button
        type="button"
        className={`widget-track${isCurrent ? " is-current" : ""}`}
        onClick={() => onPlay(song)}
        aria-label={`Play ${song.title || "Unknown title"} by ${song.artist || "Unknown artist"}`}
      >
        <span className="widget-track-cover" aria-hidden="true">
          {url ? <img src={url} alt="" width="40" height="40" loading="lazy" onError={onError} /> : <span>♫</span>}
        </span>
        <span className="widget-track-text">
          <span className="widget-track-title">{song.title || "Unknown title"}</span>
          <span className="widget-track-artist">{song.artist || "Unknown artist"}</span>
        </span>
      </button>
    </li>
  );
}


/**
 * SoundCloud-style inline widget column rendered beside the main feed:
 * now playing, next up, recently played and the user's playlists.
 */
function WidgetSidebar() {
  const {
    currentSong,
    queue = [],
    queueIndex = -1,
    recentlyPlayed = [],
    playSong,
    setActiveSidebar,
  } = usePlayer();
  const [playlists, setPlaylists] = useState([]);

  useEffect(() => {
    let isActive = true;
    const load = () => {
      getPlaylists()
        .then((data) => { if (isActive) setPlaylists(Array.isArray(data) ? data : []); })
        .catch(() => { if (isActive) setPlaylists([]); });
    };
    load();
    window.addEventListener("playlistsChanged", load);
    return () => {
      isActive = false;
      window.removeEventListener("playlistsChanged", load);
    };
  }, []);

  const upNext = queueIndex >= 0 ? queue.slice(queueIndex + 1, queueIndex + 4) : [];
  const recent = recentlyPlayed.filter((song) => song?.id !== currentSong?.id).slice(0, 5);

  return (
    <aside className="widget-sidebar" aria-label="Activity and recommendations">
      <section className="widget-card widget-card--now" aria-labelledby="widget-now-heading">
        <div className="widget-card-heading">
          <h2 id="widget-now-heading">Now playing</h2>
          {currentSong && (
            <button type="button" className="widget-card-action" onClick={() => setActiveSidebar("now-playing")}>
              Open
            </button>
          )}
        </div>
        {currentSong ? (
          <ul className="widget-track-list">
            <WidgetTrack song={currentSong} onPlay={() => setActiveSidebar("now-playing")} isCurrent />
          </ul>
        ) : (
          <p className="widget-empty">Nothing playing yet. Pick something from your feed.</p>
        )}
      </section>

      <section className="widget-card" aria-labelledby="widget-next-heading">
        <div className="widget-card-heading">
          <h2 id="widget-next-heading">Next up</h2>
          <button type="button" className="widget-card-action" onClick={() => setActiveSidebar("queue")}>
            Open queue
          </button>
        </div>
        {upNext.length ? (
          <ul className="widget-track-list">
            {upNext.map((song, index) => (
              <WidgetTrack key={`${song.id}-${index}`} song={song} onPlay={playSong} />
            ))}
          </ul>
        ) : (
          <p className="widget-empty">Your queue is empty.</p>
        )}
      </section>

      <section className="widget-card" aria-labelledby="widget-recent-heading">
        <div className="widget-card-heading">
          <h2 id="widget-recent-heading">Recently played</h2>
        </div>
        {recent.length ? (
          <ul className="widget-track-list">
            {recent.map((song, index) => (
              <WidgetTrack key={`${song.id}-${index}`} song={song} onPlay={playSong} />
            ))}
          </ul>
        ) : (
          <p className="widget-empty">Songs you play will show up here.</p>
        )}
      </section>

      <section className="widget-card" aria-labelledby="widget-playlists-heading">
        <div className="widget-card-heading">
          <h2 id="widget-playlists-heading">Your playlists</h2>
          <Link to="/library/playlists" className="widget-card-action">See all</Link>
        </div>
        {playlists.length ? (
          <ul className="widget-playlist-list">
            {playlists.slice(0, 5).map((playlist) => (
              <li key={playlist.id}>
                <Link to={`/playlist/${playlist.id}`} className="widget-playlist">
                  <span className="widget-track-cover" aria-hidden="true">
                    <PlaylistCover playlist={playlist} size={64} placeholderClassName="widget-playlist-placeholder" />
                  </span>
                  <span className="widget-track-title">{playlist.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="widget-empty">No playlists yet.</p>
        )}
      </section>
    </aside>
  );
}

export default WidgetSidebar;
