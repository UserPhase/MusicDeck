import { getSilenceScan, startSilenceScan } from "../api/musicdeck";
import useLibraryScan from "../hooks/useLibraryScan";
import LibraryScanProgress from "./LibraryScanProgress";
import { useAuth } from "../context/AuthContext";

export default function SilenceScanControl({ disabled, thresholdDb, minSilenceSeconds, children }) {
  const playlistsOnly = useAuth()?.session?.role === "user";
  const parameters = { thresholdDb: Number(thresholdDb), minSilenceSeconds: Number(minSilenceSeconds) };
  const invalid = !Number.isFinite(parameters.thresholdDb) || parameters.thresholdDb < -100 || parameters.thresholdDb > 0 ||
    !Number.isFinite(parameters.minSilenceSeconds) || parameters.minSilenceSeconds <= 0 || parameters.minSilenceSeconds > 30 || thresholdDb === "";
  const { scan, starting, active, error, start } = useLibraryScan({
    getScan: getSilenceScan, startScan: startSilenceScan, disabled: disabled || invalid, parameters,
  });
  return <div className="settings-silence-scan" role="group" aria-label="Library silence scan">
    <div className="settings-row-actions settings-silence-actions">
      {children}
      <button type="button" className="account-secondary" disabled={disabled || invalid || starting || active} onClick={start}>
        {starting ? "Starting analysis..." : active ? (playlistsOnly ? "Analyzing playlists..." : "Analyzing library...") : playlistsOnly ? "Analyze my playlists" : "Analyze all tracks"}
      </button>
    </div>
    <p className="settings-scan-description">{playlistsOnly ? "Analyze tracks in playlists you own using the threshold and duration above." : "Scan silence using the threshold and duration above. Your listened tracks come first, then your playlists and the rest of your library."} Matching results are reused.</p>
    {disabled && <p className="settings-scan-description">Enable Automatic Silence Trimming to analyze your library.</p>}
    {invalid && !disabled && <p role="alert" className="settings-inline-error">Choose a threshold from −100 to 0 dB and a minimum silence duration greater than 0, up to 30 seconds.</p>}
    <LibraryScanProgress scan={scan} label="Library silence scan"
      disabledMessage={disabled ? "Silence trimming is off for your account. This scan continues in the background." : undefined}>
      {scan?.parameters?.thresholdDb !== undefined && <p className="settings-scan-detail">Scan settings: {scan.parameters.thresholdDb} dB · {scan.parameters.minSilenceSeconds} s minimum silence</p>}
    </LibraryScanProgress>
    {error && <p role="alert" className="settings-inline-error">{error}</p>}
  </div>;
}
