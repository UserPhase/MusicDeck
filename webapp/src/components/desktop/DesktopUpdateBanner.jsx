import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkDesktopUpdates,
  getDesktopAutoCheckUpdates,
  installDesktopUpdate,
  isDesktopRuntime,
  subscribeDesktopRuntimeEvents,
} from "../../services/desktop/desktopRuntime";

function DesktopUpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [manualMessage, setManualMessage] = useState("");
  const [installStatus, setInstallStatus] = useState({ stage: "idle" });
  const [installError, setInstallError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const installing = useRef(false);

  const runUpdateCheck = useCallback(async (isManual = false) => {
    if (!isDesktopRuntime() || installing.current) return;
    if (isManual) {
      setDismissed(false);
      setInstallError("");
      setManualMessage("Checking for updates...");
    }

    const result = await checkDesktopUpdates();
    if (installing.current) return;
    if (result.updateAvailable && result.installerUrl) {
      setUpdateInfo(result);
      setManualMessage("");
      setDismissed(false);
    } else if (isManual) {
      setUpdateInfo(null);
      if (result.error) {
        setInstallError(result.error);
        setManualMessage("");
      } else {
        setManualMessage(
          `MusicDeck Desktop is up to date (v${result.currentVersion || "0.1.0"}).`
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;

    if (getDesktopAutoCheckUpdates()) {
      void runUpdateCheck(false);
    }

    return subscribeDesktopRuntimeEvents({
      onCheckForUpdates: () => {
        void runUpdateCheck(true);
      },
      onUpdateStatus: (payload) => {
        if (["downloading", "verifying", "installing"].includes(payload?.stage)) {
          setInstallStatus(payload);
        } else if (payload?.stage === "error") {
          setInstallStatus({ stage: "idle" });
          setInstallError(payload.error || "Update installation failed.");
        }
      },
    });
  }, [runUpdateCheck]);

  async function handleInstallUpdate() {
    if (!updateInfo?.installerUrl || installing.current) return;
    installing.current = true;
    setInstallError("");
    setInstallStatus({ stage: "downloading" });
    try {
      await installDesktopUpdate({
        installerUrl: updateInfo.installerUrl,
        sha256: updateInfo.sha256,
      });
    } catch (err) {
      installing.current = false;
      setInstallStatus({ stage: "idle" });
      setInstallError(typeof err === "string" ? err : err?.message || "Failed to install update.");
    }
  }

  if (!isDesktopRuntime() || dismissed) return null;
  if (!updateInfo && !manualMessage && !installError) return null;

  const { stage: installStage, downloadedBytes, totalBytes } = installStatus;
  const isInstalling = installStage !== "idle";
  const downloadPercent = installStage === "downloading" && Number.isFinite(downloadedBytes) && totalBytes > 0
    ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100))
    : undefined;

  return (
    <div
      className="desktop-update-banner"
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: "12px",
        right: "16px",
        zIndex: 9998,
        maxWidth: "420px",
        background: "var(--panel-chrome, #12161f)",
        color: "var(--text-primary, #f9fafb)",
        border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.16))",
        borderRadius: "12px",
        padding: "12px 16px",
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.42)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        fontSize: "0.875rem",
      }}
    >
      {updateInfo ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
            <strong>
              Update Available (v{updateInfo.latestVersion || updateInfo.currentVersion})
            </strong>
            {!isInstalling && (
              <button
                type="button"
                onClick={() => setDismissed(true)}
                aria-label="Dismiss update notification"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary, #9ca3af)",
                  cursor: "pointer",
                  padding: "0 4px",
                }}
              >
                ✕
              </button>
            )}
          </div>
          <span style={{ color: "var(--text-secondary, #9ca3af)", fontSize: "0.82rem" }}>
            {installStage === "downloading"
              ? `Downloading update${downloadPercent === undefined ? "..." : ` (${downloadPercent}%)`}`
              : installStage === "verifying"
              ? "Verifying the downloaded update..."
              : installStage === "installing"
              ? "Installing update and restarting MusicDeck..."
              : updateInfo.notes || "A newer version of MusicDeck Desktop is ready to install."}
          </span>
          {(installStage === "downloading" || installStage === "verifying") && (
            <progress
              aria-label="Update download progress"
              max={100}
              value={installStage === "verifying" ? 100 : downloadPercent}
              style={{ width: "100%", accentColor: "var(--accent, #1db954)" }}
            />
          )}
          {installError && (
            <span role="alert" style={{ color: "#fca5a5", fontSize: "0.8rem" }}>
              {installError}
            </span>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
            {!isInstalling && (
              <button
                type="button"
                onClick={() => setDismissed(true)}
                style={{
                  padding: "6px 12px",
                  borderRadius: "7px",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary, #9ca3af)",
                  cursor: "pointer",
                }}
              >
                Later
              </button>
            )}
            <button
              type="button"
              onClick={handleInstallUpdate}
              disabled={isInstalling}
              style={{
                padding: "6px 14px",
                borderRadius: "7px",
                border: "none",
                background: "var(--accent, #1db954)",
                color: "#04130a",
                fontWeight: 600,
                cursor: isInstalling ? "default" : "pointer",
              }}
            >
              {installStage === "downloading"
                ? "Downloading..."
                : installStage === "verifying"
                ? "Verifying..."
                : installStage === "installing"
                ? "Restarting..."
                : "Update & Restart"}
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <span style={{ color: installError ? "#fca5a5" : "var(--text-primary, #f9fafb)" }}>
            {installError || manualMessage}
          </span>
          <button
            type="button"
            onClick={() => {
              setManualMessage("");
              setInstallError("");
              setDismissed(true);
            }}
            aria-label="Dismiss update status"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary, #9ca3af)",
              cursor: "pointer",
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

export default DesktopUpdateBanner;
