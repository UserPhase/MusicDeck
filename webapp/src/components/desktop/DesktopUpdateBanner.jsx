import { useCallback, useEffect, useState } from "react";
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
  const [installStage, setInstallStage] = useState("idle");
  const [installError, setInstallError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const runUpdateCheck = useCallback(async (isManual = false) => {
    if (!isDesktopRuntime()) return;
    if (isManual) {
      setDismissed(false);
      setInstallError("");
      setManualMessage("Checking for updates...");
    }

    const result = await checkDesktopUpdates();
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
        if (payload?.stage === "downloading" || payload?.stage === "installing") {
          setInstallStage(payload.stage);
        } else if (payload?.stage === "error") {
          setInstallStage("idle");
          setInstallError(payload.error || "Update installation failed.");
        }
      },
    });
  }, [runUpdateCheck]);

  async function handleInstallUpdate() {
    if (!updateInfo?.installerUrl) return;
    setInstallError("");
    setInstallStage("downloading");
    try {
      await installDesktopUpdate({
        installerUrl: updateInfo.installerUrl,
        sha256: updateInfo.sha256,
      });
    } catch (err) {
      setInstallStage("idle");
      setInstallError(err?.message || "Failed to install update.");
    }
  }

  if (!isDesktopRuntime() || dismissed) return null;
  if (!updateInfo && !manualMessage && !installError) return null;

  const isInstalling = installStage === "downloading" || installStage === "installing";

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
              ? "Downloading and verifying update package..."
              : installStage === "installing"
              ? "Launching installer and restarting MusicDeck..."
              : updateInfo.notes || "A newer version of MusicDeck Desktop is ready to install."}
          </span>
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
