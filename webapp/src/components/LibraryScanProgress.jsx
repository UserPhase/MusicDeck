export default function LibraryScanProgress({ scan, label, disabledMessage, children }) {
  if (!scan) return null;
  const active = ["discovering", "running"].includes(scan.status);
  const processed = scan.completedTracks + scan.failedTracks;
  return <div className="settings-scan-progress">
    <p role="status" aria-live="polite">
      {scan.status === "discovering" ? "Finding your library tracks..." : scan.status === "failed" ? "Scan interrupted" :
        `${active ? "Analysed" : "Scan complete:"} ${scan.completedTracks} of ${scan.totalTracks} tracks${scan.failedTracks ? ` · ${scan.failedTracks} failed` : ""}`}
      {scan.skippedTracks > 0 && ` · ${scan.skippedTracks} already prepared`}
    </p>
    {scan.totalTracks > 0 && <progress aria-label={label} value={processed} max={scan.totalTracks} />}
    {children}
    {active && <p className="settings-scan-detail">{scan.currentTrack || "Preparing analysis..."}</p>}
    {active && <p className="settings-scan-detail">{disabledMessage || "You can keep listening or leave this page. The scan continues in the background."}</p>}
    {scan.warning && <p className="settings-inline-error">{scan.warning}</p>}
    {!active && scan.failedTracks > 0 && <p className="settings-scan-detail">Run another scan to retry failed tracks. Prepared tracks are reused.</p>}
  </div>;
}
