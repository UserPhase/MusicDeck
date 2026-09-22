import {
  useState,
} from "react";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";
import {
  getCoverUrl,
} from "../api/musicdeck";


function CompactTrackRow({ song, index, variant = "queue" }) {
  const duration = song.duration ?? song.metadata?.durationSeconds;
  const coverUrl = song.coverUrl || getCoverUrl(song.coverArt, 64);

  return (
    <div className={`queue-sidebar-track queue-sidebar-track-${variant}`} role="listitem">
      <span className="queue-sidebar-track-index">{index + 1}</span>
      <span className="queue-sidebar-track-cover" aria-hidden="true">
        {coverUrl ? <img src={coverUrl} alt="" width="32" height="32" loading="lazy" /> : <span>♫</span>}
      </span>
      <span className="queue-sidebar-track-info">
        <span className="queue-sidebar-track-title">{song.title || "Unknown title"}</span>
        <span className="queue-sidebar-track-artist">{song.artist || "Unknown artist"}</span>
      </span>
      <span className="queue-sidebar-track-duration">{formatDuration(duration)}</span>
    </div>
  );
}


function QueueSidebar({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState("queue");
  const {
    queue = [],
    queueIndex = -1,
    playHistory = [],
    layoutDensity = "comfortable",
  } = usePlayer();

  if (!isOpen) {
    return null;
  }

  const isQueueTab = activeTab === "queue";
  const tracks = isQueueTab ? queue.slice(queueIndex + 1) : playHistory;
  const emptyMessage = isQueueTab ? "Your queue is empty." : "Nothing played yet.";
  const sectionTitle = isQueueTab ? "Up next" : "Recently played";

  return (
    <aside
      className={`queue-sidebar sidebar-panel queue-sidebar-density-${layoutDensity}`}
      aria-label="Playback queue"
    >
      <header className="sidebar-panel-header">
        <h2>Queue</h2>
        <button
          className="queue-sidebar-close"
          type="button"
          onClick={onClose}
          aria-label="Close queue sidebar"
        >
          ×
        </button>
      </header>

      <div className="queue-sidebar-segmented" role="tablist" aria-label="Queue view">
        <button
          id="queue-sidebar-queue-tab"
          type="button"
          role="tab"
          aria-selected={isQueueTab}
          aria-controls="queue-sidebar-tabpanel"
          className={isQueueTab ? "active" : ""}
          onClick={() => setActiveTab("queue")}
        >
          Queue
        </button>
        <button
          id="queue-sidebar-history-tab"
          type="button"
          role="tab"
          aria-selected={!isQueueTab}
          aria-controls="queue-sidebar-tabpanel"
          className={!isQueueTab ? "active" : ""}
          onClick={() => setActiveTab("recent")}
        >
          Recently Played
        </button>
      </div>

      <section className="queue-sidebar-section queue-sidebar-up-next" aria-labelledby="queue-sidebar-list-title">
        <h3 id="queue-sidebar-list-title">{sectionTitle}</h3>
        <div
          id="queue-sidebar-tabpanel"
          className="queue-sidebar-list"
          role="tabpanel"
          aria-labelledby={isQueueTab ? "queue-sidebar-queue-tab" : "queue-sidebar-history-tab"}
          tabIndex={0}
        >
          {tracks.length === 0 ? (
            <p className="queue-sidebar-empty">{emptyMessage}</p>
          ) : (
            tracks.map((song, index) => (
              <CompactTrackRow
                key={`${song.id}-${index}`}
                song={song}
                index={index}
                variant={isQueueTab ? "queue" : "history"}
              />
            ))
          )}
        </div>
      </section>
    </aside>
  );
}


export default QueueSidebar;
