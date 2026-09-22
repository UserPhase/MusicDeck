import { useState, useEffect, useRef } from "react";
import { createAcquisition, getAcquisition } from "../api/musicdeck";

function ServerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v6c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
      <path d="M5 11v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </svg>
  );
}

function CloudDownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 8.4 4.8 4.8 0 0 0 7 18Z" />
      <path d="M12 11v6" />
      <path d="m9.75 14.75 2.25 2.25 2.25-2.25" />
    </svg>
  );
}

/**
 * Download button for tracks positioned between album and track duration.
 * Triggers acquisition via spotDL and provides real-time progress feedback.
 */
function TrackDownloadButton({ song, className = "", completedPlaceholder = false }) {
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const pollTimerRef = useRef(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  if (!song) {
    return null;
  }

  // Already in the library (or otherwise fully streamable) — show a neutral
  // server indicator instead of an actionable spotDL control.
  const alreadyInLibrary =
    Boolean(song.availability?.libraryAvailable) || song.source?.kind === "library";

  if (alreadyInLibrary && status === "idle") {
    const titleText = song.title || "track";
    return (
      <div
        className={`track-download-container ${className}`.trim()}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span
          className="track-download-btn already-downloaded"
          role="img"
          aria-label={`${titleText} already downloaded`}
          title="Already downloaded"
        >
          <ServerIcon />
        </span>
      </div>
    );
  }

  async function handleDownload(event) {
    event.stopPropagation();
    event.preventDefault();

    if (status === "downloading" || status === "queued" || status === "processing") {
      return;
    }

    try {
      setStatus("queued");
      setErrorMessage(null);
      setProgress(null);

      const title = song.title || "";
      const artist = song.artist || (typeof song.artistName === "string" ? song.artistName : "");
      const album = song.album || (typeof song.albumName === "string" ? song.albumName : "");

      const payload = {
        result: {
          id: song.id,
          type: "track",
          title,
          artist,
          album,
          provider: song.provider || (song.source?.kind === "external" ? "external" : "library"),
          source: song.source || { kind: song.source?.kind || "library", count: 1 },
          metadata: {
            ...(song.metadata || {}),
            spotifyTrackUrl: song.metadata?.spotifyTrackUrl || song.spotifyUrl,
            spotifyTrackId: song.metadata?.spotifyTrackId,
          },
        },
        trackId: song.id,
        sourceProvider: "spotdl",
      };

      const res = await createAcquisition(payload);

      if (!isMountedRef.current) return;

      if (res.status === "completed") {
        setStatus("completed");
        return;
      }

      setStatus(res.job?.status || res.status || "downloading");

      const jobId = res.jobId || res.job?.id;
      if (!jobId) return;

      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }

      pollTimerRef.current = setInterval(async () => {
        try {
          const job = await getAcquisition(jobId);
          if (!isMountedRef.current) return;

          if (job) {
            setStatus(job.status);
            if (job.progress?.percent !== undefined) {
              setProgress(job.progress.percent);
            }

            if (job.status === "completed") {
              clearInterval(pollTimerRef.current);
              setStatus("completed");
            } else if (job.status === "failed") {
              clearInterval(pollTimerRef.current);
              setStatus("failed");
              setErrorMessage(job.errorMessage || "Download failed");
            } else if (job.status === "cancelled") {
              clearInterval(pollTimerRef.current);
              setStatus("idle");
            }
          }
        } catch (pollErr) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
          }
        }
      }, 1000);
    } catch (err) {
      if (isMountedRef.current) {
        setStatus("failed");
        setErrorMessage(err.message || "Failed to start download");
      }
    }
  }

  const titleText = song.title || "track";
  let label = `Download ${titleText} with spotDL`;
  let titleAttr = "Download with spotDL";

  if (status === "queued") {
    label = `Queued download for ${titleText}`;
    titleAttr = "Queued for download";
  } else if (status === "downloading" || status === "discovering" || status === "processing" || status === "importing") {
    const pctText = progress !== null ? ` (${progress}%)` : "";
    label = `Downloading ${titleText}${pctText}`;
    titleAttr = `Downloading${pctText}`;
  } else if (status === "completed") {
    label = `${titleText} downloaded to library`;
    titleAttr = "Downloaded to library";
  } else if (status === "failed") {
    label = `Download failed for ${titleText}. Click to retry.`;
    titleAttr = errorMessage || "Download failed (click to retry)";
  }

  const isWorking = status === "queued" || status === "downloading" || status === "discovering" || status === "processing" || status === "importing";

  if (status === "completed" && completedPlaceholder) {
    return (
      <div className={`track-download-container ${className}`.trim()} aria-hidden="true">
        <span className="track-server-placeholder">{"\u2063"}</span>
      </div>
    );
  }

  return (
    <div
      className={`track-download-container ${className}`.trim()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`track-download-btn ${status !== "idle" ? status : ""} ${isWorking ? "active" : ""}`.trim()}
        aria-label={label}
        title={titleAttr}
        disabled={isWorking}
        onClick={handleDownload}
      >
        {isWorking ? (
          <svg
            className="track-download-spinner"
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round" />
          </svg>
        ) : status === "completed" ? (
          <ServerIcon />
        ) : status === "failed" ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5zm.75 6.5a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75z" />
          </svg>
        ) : <CloudDownloadIcon />}
      </button>
    </div>
  );
}

export default TrackDownloadButton;
