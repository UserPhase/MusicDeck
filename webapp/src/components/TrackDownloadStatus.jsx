function TrackDownloadStatus({
  isDownloaded: normalizedDownloadState,
  availability,
  source,
}) {
  const isDownloaded =
    typeof normalizedDownloadState === "boolean"
      ? normalizedDownloadState
      : Boolean(availability?.libraryAvailable) ||
        source?.kind === "library";

  return (
    <span
      className={
        `track-availability-mark ${
          isDownloaded
            ? "available"
            : "unavailable"
        }`
      }
      aria-label={
        isDownloaded
          ? "Downloaded"
          : "Not downloaded"
      }
      title={
        isDownloaded
          ? "Downloaded"
          : "Not downloaded"
      }
    >
      {isDownloaded ? "✓" : "↓"}
    </span>
  );
}

export default TrackDownloadStatus;
