import { useEffect, useRef, useState } from "react";

import Menu from "./ui/Menu";
import { getAcquisitions, cancelAcquisition, retryAcquisition } from "../api/musicdeck";

const ACTIVE_STATUSES = new Set(["queued", "discovering", "downloading", "processing", "importing"]);
const POLL_INTERVAL_MS = 2000;

function statusLabel(job) {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "discovering":
      return "Finding source…";
    case "downloading": {
      const pct = job.progress?.percent;
      return pct !== undefined && pct !== null ? `Downloading ${pct}%` : "Downloading…";
    }
    case "processing":
      return "Processing…";
    case "importing":
      return "Adding to library…";
    case "completed":
      return "Added to library";
    case "failed":
      return job.errorMessage || "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return job.status;
  }
}

function jobTitle(job) {
  return job.files?.[0]?.title || job.requestedTrackId || job.sourceCandidateId || "Track";
}

/**
 * Downloads button shown in the topbar next to the account menu (Reverb-style).
 * Shows current/recent acquisition jobs with live progress, polling the
 * existing /api/acquisitions endpoint (already used by TrackDownloadButton).
 */
function DownloadsMenu() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollTimerRef = useRef(null);
  const isMountedRef = useRef(true);

  async function refresh() {
    try {
      const list = await getAcquisitions();
      if (isMountedRef.current) {
        setJobs(list);
      }
    } catch {
      // Keep the last known list on transient errors.
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    isMountedRef.current = true;

    setLoading(true);
    refresh();

    pollTimerRef.current = setInterval(refresh, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const activeJobs = (jobs || []).filter((job) => ACTIVE_STATUSES.has(job.status));
  const activeCount = activeJobs.length;

  async function handleCancel(jobId) {
    try {
      await cancelAcquisition(jobId);
      refresh();
    } catch {
      // Ignore; refresh will reflect current server state on next poll.
    }
  }

  async function handleRetry(jobId) {
    try {
      await retryAcquisition(jobId);
      refresh();
    } catch {
      // Ignore; refresh will reflect current server state on next poll.
    }
  }

  return (
    <Menu
      label="Downloads"
      title="Downloads"
      className="downloads-menu"
      toggleClassName="downloads-menu-toggle"
      menuClassName="downloads-menu-popover"
      renderToggle={(toggleProps) => (
        <button type="button" {...toggleProps} className="downloads-menu-toggle" aria-label="Downloads">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5zM2.5 12a.75.75 0 0 1 .75.75v.5c0 .414.336.75.75.75h8a.75.75 0 0 0 .75-.75v-.5a.75.75 0 0 1 1.5 0v.5A2.25 2.25 0 0 1 12 15.5H4A2.25 2.25 0 0 1 1.75 13.25v-.5A.75.75 0 0 1 2.5 12z" />
          </svg>
          {activeCount > 0 && <span className="downloads-menu-badge">{activeCount}</span>}
        </button>
      )}
    >
      {() => (
        <div className="downloads-menu-list">
          {loading && jobs.length === 0 && (
            <div className="downloads-menu-empty">Loading…</div>
          )}

          {!loading && jobs.length === 0 && (
            <div className="downloads-menu-empty">No downloads yet</div>
          )}

          {jobs.slice(0, 10).map((job) => {
            const isActive = ACTIVE_STATUSES.has(job.status);
            const pct = job.progress?.percent;

            return (
              <div key={job.id} className={`downloads-menu-item status-${job.status}`}>
                <div className="downloads-menu-item-info">
                  <div className="downloads-menu-item-title">{jobTitle(job)}</div>
                  <div className="downloads-menu-item-status">{statusLabel(job)}</div>

                  {isActive && (
                    <div className="downloads-menu-progress">
                      <div
                        className="downloads-menu-progress-bar"
                        style={{ width: `${typeof pct === "number" ? pct : 0}%` }}
                      />
                    </div>
                  )}
                </div>

                {isActive && (
                  <button
                    type="button"
                    className="downloads-menu-action"
                    onClick={() => handleCancel(job.id)}
                    aria-label={`Cancel download of ${jobTitle(job)}`}
                  >
                    Cancel
                  </button>
                )}

                {job.status === "failed" && (
                  <button
                    type="button"
                    className="downloads-menu-action"
                    onClick={() => handleRetry(job.id)}
                    aria-label={`Retry download of ${jobTitle(job)}`}
                  >
                    Retry
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Menu>
  );
}

export default DownloadsMenu;
