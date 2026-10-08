import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";

import {
  usePlayer,
} from "../context/PlayerContext";

import {
  formatDuration,
} from "../utils/formatDuration";
import {
  getCoverUrl,
} from "../api/musicdeck";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useQueueReorder } from "../hooks/useQueueReorder";

// Display caps only: playback still runs through the whole queue.
export const QUEUE_DISPLAY_LIMIT = 25;
export const HISTORY_DISPLAY_LIMIT = 10;


function CompactTrackRow({ song, index, variant = "queue", reorder, showHandle }) {
  const duration = song.duration ?? song.metadata?.durationSeconds;
  const coverUrl = song.coverUrl || getCoverUrl(song.coverArt, 64);

  return (
    <div
      className={`queue-sidebar-track queue-sidebar-track-${variant}${reorder ? " queue-sidebar-track-sortable" : ""}`}
      role="listitem"
      tabIndex={reorder ? 0 : undefined}
      aria-label={reorder ? `${song.title || "Unknown title"}, upcoming position ${index + 1}` : undefined}
      aria-describedby={reorder ? "queue-sidebar-reorder-instructions" : undefined}
      {...reorder?.rowProps}
    >
      <span className="queue-sidebar-track-index">{index + 1}</span>
      <span className="queue-sidebar-track-cover" aria-hidden="true">
        {coverUrl ? <img src={coverUrl} alt="" width="32" height="32" loading="lazy" draggable={false} /> : <span>♫</span>}
      </span>
      <span className="queue-sidebar-track-info">
        <span className="queue-sidebar-track-title">{song.title || "Unknown title"}</span>
        <span className="queue-sidebar-track-artist">{song.artist || "Unknown artist"}</span>
      </span>
      <span className="queue-sidebar-track-duration">{formatDuration(duration)}</span>
      {reorder && showHandle && (
        <button
          type="button"
          className="queue-sidebar-drag-handle"
          aria-label={`Reorder ${song.title || "Unknown title"}, position ${index + 1}`}
          aria-describedby="queue-sidebar-reorder-instructions"
          title="Drag to reorder, or use Arrow Up and Arrow Down"
        >
          <svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true">
            <circle cx="4" cy="4" r="1.5" /><circle cx="10" cy="4" r="1.5" />
            <circle cx="4" cy="9" r="1.5" /><circle cx="10" cy="9" r="1.5" />
            <circle cx="4" cy="14" r="1.5" /><circle cx="10" cy="14" r="1.5" />
          </svg>
        </button>
      )}
    </div>
  );
}


function QueueSidebar({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState("queue");
  const [showFullQueue, setShowFullQueue] = useState(false);
  const listRef = useRef(null);
  const touchCapable = useMediaQuery("(any-pointer: coarse)");
  const primaryTouch = useMediaQuery("(pointer: coarse)");
  const [lastPointerType, setLastPointerType] = useState(null);
  const showTouchHandle = touchCapable && (lastPointerType ? lastPointerType !== "mouse" : primaryTouch);
  useEffect(() => {
    const update = (event) => setLastPointerType(event.pointerType);
    window.addEventListener("pointerdown", update, true);
    return () => window.removeEventListener("pointerdown", update, true);
  }, []);
  const {
    queue = [],
    queueIndex = -1,
    playHistory = [],
    layoutDensity = "comfortable",
    moveQueueItem,
  } = usePlayer();

  const isQueueTab = activeTab === "queue";
  const { entries, drag, announcement, rowProps } = useQueueReorder({
    queue, queueIndex, moveQueueItem,
    enabled: Boolean(isOpen && isQueueTab && moveQueueItem), listRef,
    onMove: (to) => {
      if (to - queueIndex > QUEUE_DISPLAY_LIMIT) setShowFullQueue(true);
    },
  });

  if (!isOpen) {
    return null;
  }

  const allTracks = isQueueTab ? entries.slice(queueIndex + 1) : playHistory.map((song, index) => ({ song, key: `history-${index}` }));
  const tracks = allTracks.slice(0, isQueueTab ? (showFullQueue ? allTracks.length : QUEUE_DISPLAY_LIMIT) : HISTORY_DISPLAY_LIMIT);
  const emptyMessage = isQueueTab ? "Your queue is empty." : "Nothing played yet.";
  const sectionTitle = isQueueTab ? "Up next" : "Recently played";

  return (
    <aside
      className={`queue-sidebar sidebar-panel queue-sidebar-density-${layoutDensity}${showTouchHandle ? " queue-sidebar-touch-capable" : ""}${drag ? " queue-sidebar-is-dragging" : ""}`}
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
      {isQueueTab && allTracks.length > QUEUE_DISPLAY_LIMIT && (
        <button
          type="button"
          className="queue-sidebar-expand"
          onClick={() => setShowFullQueue((value) => !value)}
        >
          {showFullQueue ? "Show fewer tracks" : "Show full queue"}
        </button>
      )}

      <section className="queue-sidebar-section queue-sidebar-up-next" aria-labelledby="queue-sidebar-list-title">
        <h3 id="queue-sidebar-list-title">{sectionTitle}</h3>
        <span className="queue-sidebar-announcement" role="status">{announcement}</span>
        <span id="queue-sidebar-reorder-instructions" className="queue-sidebar-announcement">
          Use Arrow Up or Arrow Down to move this upcoming song. Drag with a mouse,
          or use the handle on a touchscreen. Press Escape to cancel a drag.
        </span>
        <div
          id="queue-sidebar-tabpanel"
          className="queue-sidebar-list"
          role="tabpanel"
          aria-labelledby={isQueueTab ? "queue-sidebar-queue-tab" : "queue-sidebar-history-tab"}
          tabIndex={0}
          ref={listRef}
        >
          {tracks.length === 0 ? (
            <p className="queue-sidebar-empty">{emptyMessage}</p>
          ) : (
            tracks.map((entry, index) => (
              <CompactTrackRow
                key={entry.key}
                song={entry.song}
                index={index}
                variant={isQueueTab ? "queue" : "history"}
                showHandle={showTouchHandle}
                reorder={isQueueTab && moveQueueItem ? {
                  rowProps: rowProps(entry, queueIndex + index + 1),
                } : null}
              />
            ))
          )}
        </div>
        {!isQueueTab && (
          <Link className="queue-sidebar-history-link" to="/listening-activity?tab=history">
            View full history <span aria-hidden="true">&rarr;</span>
          </Link>
        )}
      </section>
    </aside>
  );
}


export default QueueSidebar;
