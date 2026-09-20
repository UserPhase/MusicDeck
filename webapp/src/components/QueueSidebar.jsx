import {
  useState,
} from "react";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";


function CompactTrackRow({ song, index, variant = "queue" }) {
  const duration = song.duration ?? song.metadata?.durationSeconds;

  return (
    <div className={`queue-sidebar-track queue-sidebar-track-${variant}`} role="listitem">
      <span className="queue-sidebar-track-index">{index + 1}</span>
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
    playHistory = [],
  } = usePlayer();

  if (!isOpen) {
    return null;
  }

  const isQueueTab = activeTab === "queue";
  const tracks = isQueueTab ? queue : playHistory;
  const emptyMessage = isQueueTab ? "Your queue is empty." : "Nothing played yet.";
  const sectionTitle = isQueueTab ? "Up next" : "Recently played";

  return (
    <aside className="queue-sidebar" aria-label="Playback queue">
      <header className="queue-sidebar-header">
        <div>
          <span className="queue-sidebar-kicker">Playback</span>
          <h2>Queue</h2>
        </div>
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
        <span
          className={`queue-sidebar-segment-indicator${isQueueTab ? "" : " recent"}`}
          aria-hidden="true"
        />
        <button
          type="button"
          role="tab"
          aria-selected={isQueueTab}
          className={isQueueTab ? "active" : ""}
          onClick={() => setActiveTab("queue")}
        >
          Queue
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!isQueueTab}
          className={!isQueueTab ? "active" : ""}
          onClick={() => setActiveTab("recent")}
        >
          Recently Played
        </button>
      </div>

      <section className="queue-sidebar-section queue-sidebar-up-next" aria-labelledby="queue-sidebar-list-title">
        <h3 id="queue-sidebar-list-title">{sectionTitle}</h3>
        <div className="queue-sidebar-list" role="list">
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
