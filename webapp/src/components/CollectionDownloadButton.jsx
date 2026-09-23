import { useMemo, useState } from "react";

import { downloadToDevice } from "../utils/downloadManager";

function isAvailableOnServer(track) {
  return Boolean(
    track?.isDownloaded ||
    track?.availability?.libraryAvailable ||
    track?.source?.kind === "library"
  );
}

function CollectionDownloadButton({ tracks = [], quality = "320kbps", label = "collection" }) {
  const eligibleTracks = useMemo(
    () => tracks.filter((track) => track?.id && isAvailableOnServer(track)),
    [tracks]
  );
  const [batch, setBatch] = useState({ status: "idle", completed: 0, total: 0 });
  const isDownloading = batch.status === "downloading";
  const progress = batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0;

  async function handleCollectionDownload() {
    if (isDownloading || eligibleTracks.length === 0) return;

    setBatch({ status: "downloading", completed: 0, total: eligibleTracks.length });
    let failed = 0;

    for (let index = 0; index < eligibleTracks.length; index += 1) {
      try {
        await downloadToDevice(eligibleTracks[index].id, quality);
      } catch (error) {
        failed += 1;
        console.error("Could not download collection track:", error);
      } finally {
        setBatch({
          status: "downloading",
          completed: index + 1,
          total: eligibleTracks.length,
        });
      }
    }

    setBatch({
      status: failed === 0 ? "downloaded" : "failed",
      completed: eligibleTracks.length - failed,
      total: eligibleTracks.length,
    });
  }

  const accessibleLabel = isDownloading
    ? `Downloading ${label}: ${batch.completed} of ${batch.total}`
    : batch.status === "downloaded"
      ? `${label} downloaded to this device`
      : batch.status === "failed"
        ? `Some tracks in this ${label} could not be downloaded. Retry.`
        : `Download ${label} to this device`;

  return (
    <button
      type="button"
      className={`detail-secondary-action collection-download-action ${batch.status === "downloaded" ? "is-active" : ""}`}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      disabled={isDownloading || eligibleTracks.length === 0}
      onClick={handleCollectionDownload}
    >
      {isDownloading ? (
        <span
          className="collection-download-progress"
          style={{ "--collection-progress": `${progress * 3.6}deg` }}
          aria-hidden="true"
        >
          <span />
        </span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill={batch.status === "downloaded" ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M12 3v11" />
          <path d="m8 10 4 4 4-4" />
          <path d="M5 18.5h14" />
        </svg>
      )}
    </button>
  );
}

export default CollectionDownloadButton;
