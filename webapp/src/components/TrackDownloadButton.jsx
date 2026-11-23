import { useState, useEffect, useRef, useId } from "react";
import { createAcquisition, getAcquisition, retryAcquisition } from "../api/musicdeck";
import { acquisitionPayload } from "../services/externalActions";
import { usePrivacy } from "../context/PrivacyContext";
import { startVisualPolling } from "../services/visualActivity";
import { downloadPhaseLabels } from "../services/downloadStatus";

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
  const { canImport } = usePrivacy();
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [phase, setPhase] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const errorId = useId();
  const [statusRetrying, setStatusRetrying] = useState(false);
  const stopPollingRef = useRef(null);
  const jobRef = useRef(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopPollingRef.current?.();
    };
  }, []);

  useEffect(() => {
    jobRef.current = null;
    stopPollingRef.current?.();
    setStatus("idle");
    setProgress(null);
    setPhase(null);
    setErrorMessage(null);
    setStatusRetrying(false);
  }, [song?.id]);

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

  if (!canImport) return null;

  async function handleDownload(event) {
    event.stopPropagation();
    event.preventDefault();

    if (!canImport || status === "downloading" || status === "queued" || status === "processing") {
      return;
    }

    try {
      setStatus("queued");
      setErrorMessage(null);
      setProgress(null);
      setPhase(null);
      setStatusRetrying(false);

      const res = (status === "failed" || status === "partial") && jobRef.current
        ? await retryAcquisition(jobRef.current)
        : await createAcquisition(acquisitionPayload("track", {
          ...song,
          artist: song.artist || song.artistName,
          album: song.album || song.albumName,
        }));
      if (!isMountedRef.current) return;

      if (res.status === "completed") {
        setStatus("completed");
        return;
      }

      setStatus(res.job?.status || res.status || "downloading");

      const jobId = res.jobId || res.job?.id;
      if (!jobId) throw new Error("The server did not confirm the download. Check Server downloads before trying again.");
      jobRef.current = jobId;

      stopPollingRef.current?.();
      let inFlight = false;
      let failures = 0;
      let retryAt = 0;
      const controller = new AbortController();
      const stopPolling = () => {
        controller.abort();
        stopVisualPolling();
      };
      const stopVisualPolling = startVisualPolling(async () => {
        if (inFlight || Date.now() < retryAt) return;
        inFlight = true;
        try {
          const job = await getAcquisition(jobId, controller.signal);
          if (controller.signal.aborted || !isMountedRef.current || stopPollingRef.current !== stopPolling) return;
          if (!job?.status) throw new Error("Missing download status");

          failures = 0;
          retryAt = 0;
          setStatusRetrying(false);
          setStatus(job.status);
          setPhase(job.stage || job.progress?.stage);
          if (job.progress?.percent !== undefined) {
            setProgress(job.progress.percent);
          }

          if (job.status === "completed") {
            stopPolling();
          } else if (job.status === "partial") {
            stopPolling();
            setErrorMessage(job.errorMessage || "Part of the download was imported");
          } else if (job.status === "failed") {
            stopPolling();
            setErrorMessage(job.errorMessage || "Download failed");
          } else if (job.status === "cancelled") {
            stopPolling();
            jobRef.current = null;
            setStatus("idle");
          }
        } catch (error) {
          if (controller.signal.aborted || !isMountedRef.current || stopPollingRef.current !== stopPolling) return;
          if ([401, 403, 404].includes(error.status)) {
            stopPolling();
            jobRef.current = null;
            setStatus("failed");
            setStatusRetrying(false);
            setErrorMessage("This download is no longer available.");
          } else {
            failures += 1;
            retryAt = Date.now() + Math.min(10000, 1000 * 2 ** (failures - 1));
            setStatusRetrying(true);
          }
        } finally {
          inFlight = false;
        }
      }, 1000, { immediate: false });
      stopPollingRef.current = stopPolling;
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

  if (statusRetrying) {
    label = `Reconnecting to check the download for ${titleText}`;
    titleAttr = "Could not refresh download status. Retrying.";
  } else if (status === "queued") {
    label = `Queued download for ${titleText}`;
    titleAttr = "Queued for download";
  } else if (status === "downloading" || status === "discovering" || status === "processing" || status === "importing") {
    const waiting = phase === "provider_cooldown" || phase === "retry_wait";
    const phaseLabel = phase === "conversion" ? "Converting" : phase === "scan" ? "Scanning" : phase === "playlist_creation" ? "Creating playlist for" : downloadPhaseLabels[phase] || "Downloading";
    const pctText = !waiting && progress !== null ? ` (${Math.round(progress)}%)` : "";
    label = waiting ? `${phaseLabel} for ${titleText}` : `${phaseLabel} ${titleText}${pctText}`;
    titleAttr = `${phaseLabel}${pctText}`;
  } else if (status === "completed") {
    label = `${titleText} downloaded to library`;
    titleAttr = "Downloaded to library";
  } else if (status === "partial") {
    label = `Partially imported ${titleText}. Click to retry.`;
    titleAttr = errorMessage || "Partially imported";
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
        aria-describedby={errorMessage ? errorId : undefined}
        title={titleAttr}
        disabled={isWorking || status === "completed"}
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
      {errorMessage && <span id={errorId} hidden>{errorMessage}</span>}
    </div>
  );
}

export default TrackDownloadButton;
