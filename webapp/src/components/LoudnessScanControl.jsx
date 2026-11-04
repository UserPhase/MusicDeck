import { getLoudnessScan, startLoudnessScan } from "../api/musicdeck";
import useLibraryScan from "../hooks/useLibraryScan";
import LibraryScanProgress from "./LibraryScanProgress";
import { useAuth } from "../context/AuthContext";

export default function LoudnessScanControl({ disabled = false } = {}) {
  const playlistsOnly = useAuth()?.session?.role === "user";
  const { scan, starting, active, error, start } = useLibraryScan({ getScan: getLoudnessScan, startScan: startLoudnessScan, disabled });
  return (
    <article className="settings-loudness-scan" aria-labelledby="loudness-scan-title">
      <div className="settings-row">
        <div className="settings-row-copy">
          <h3 id="loudness-scan-title">Library loudness scan</h3>
          <p>{playlistsOnly ? "Measure loudness for tracks in playlists you own." : "Measure loudness for all tracks, starting with your listening history and playlists."} New downloads are analysed automatically.</p>
        </div>
        <button type="button" className="account-secondary" disabled={disabled || starting || active} onClick={start}>
          {starting ? "Starting..." : active ? "Scanning..." : playlistsOnly ? "Scan my playlists" : "Scan all tracks"}
        </button>
      </div>
      <LibraryScanProgress scan={scan} label="Library loudness scan" disabledMessage={disabled ? "Normalization is off for your account. This scan continues in the background." : undefined} />
      {error && <p role="alert" className="settings-inline-error">{error}</p>}
    </article>
  );
}
