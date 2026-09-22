import TrackLikeButton from "./TrackLikeButton";

function qualityLabel(quality) {
  return quality === "lossless"
    ? "Lossless"
    : String(quality || "320kbps").replace("kbps", " kbps");
}

function TrackContextMenu({
  song,
  downloadQuality,
  isServerSynced,
  offlineStatus,
  onOfflineDownload,
  children,
}) {
  const isDownloading = offlineStatus === "downloading";
  const isDownloaded = offlineStatus === "downloaded";
  const downloadSubtitle = isServerSynced
    ? `${qualityLabel(downloadQuality)}${isDownloaded ? " • Downloaded" : ""}`
    : `${qualityLabel(downloadQuality)} • Save to server first`;

  return (
    <div
      className="playlist-menu track-context-menu"
      role="menu"
      aria-label={`Actions for ${song.title || "track"}`}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="playlist-menu-title">Track actions</div>

      <TrackLikeButton song={song} variant="menu" />

      <button
        type="button"
        role="menuitem"
        className={`playlist-menu-item track-context-menu-item${isDownloaded ? " is-downloaded" : ""}`}
        disabled={!isServerSynced || isDownloading || isDownloaded}
        onClick={onOfflineDownload}
      >
        <span className="track-context-menu-icon" aria-hidden="true">
          {isDownloading ? (
            <span className="track-offline-spinner" />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill={isDownloaded ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v11" />
              <path d="m8 10 4 4 4-4" />
              <path d="M5 18.5h14" />
            </svg>
          )}
        </span>
        <span className="track-context-menu-copy">
          <span>{isDownloading ? "Downloading to Device" : "Download to Device"}</span>
          <small>{downloadSubtitle}</small>
        </span>
      </button>

      {children && <div className="track-context-menu-divider" aria-hidden="true" />}
      {children}
    </div>
  );
}

export default TrackContextMenu;
