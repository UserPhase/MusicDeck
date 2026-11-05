import { useEffect, useState } from "react";
import {
  checkDesktopServerConnection,
  DESKTOP_CHECK_UPDATES_EVENT,
  getDesktopAutoCheckUpdates,
  getDesktopCloseToTray,
  getDesktopServerUrl,
  saveDesktopConfig,
} from "../../services/desktop/desktopRuntime";

function DesktopServerModal({ isOpen, onClose, onSaved }) {
  const [serverUrl, setServerUrl] = useState(getDesktopServerUrl);
  const [closeToTray, setCloseToTray] = useState(getDesktopCloseToTray);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(getDesktopAutoCheckUpdates);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setServerUrl(getDesktopServerUrl());
    setCloseToTray(getDesktopCloseToTray());
    setAutoCheckUpdates(getDesktopAutoCheckUpdates());
    setStatus(null);
    setError("");
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleTestConnection() {
    setError("");
    setStatus(null);
    setTesting(true);
    try {
      const result = await checkDesktopServerConnection(serverUrl);
      if (result.reachable) {
        setServerUrl(result.serverUrl);
        setStatus(`Connected to ${result.appName || "MusicDeck"} (${result.serverUrl})`);
      } else {
        setError(result.error || "Unable to reach MusicDeck server.");
      }
    } catch (err) {
      setError(err.message || "Invalid MusicDeck server URL.");
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setStatus(null);
    setSaving(true);
    try {
      const saved = await saveDesktopConfig({
        serverUrl,
        closeToTray,
        autoCheckUpdates,
      });
      setServerUrl(saved.serverUrl);
      onSaved?.(saved);
      onClose?.();
    } catch (err) {
      setError(err.message || "Could not save desktop server settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="desktop-server-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="desktop-server-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.72)",
        backdropFilter: "blur(8px)",
        padding: "16px",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "100%",
          maxWidth: "460px",
          background: "var(--panel-chrome, #12161f)",
          color: "var(--text-primary, #f9fafb)",
          border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.12))",
          borderRadius: "14px",
          padding: "24px",
          boxShadow: "0 20px 48px rgba(0, 0, 0, 0.45)",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="desktop-server-modal-title" style={{ margin: 0, fontSize: "1.2rem" }}>
            Desktop Server Connection
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close server settings"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary, #9ca3af)",
              cursor: "pointer",
              fontSize: "1.1rem",
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-secondary, #9ca3af)" }}>
          Connect the MusicDeck desktop app to your self-hosted MusicDeck server.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "0.875rem" }}>
          <span>MusicDeck Server URL</span>
          <input
            type="url"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="http://localhost:4534"
            aria-label="MusicDeck Server URL"
            required
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.16))",
              background: "var(--main-surface, rgba(255, 255, 255, 0.05))",
              color: "var(--text-primary, #f9fafb)",
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={closeToTray}
            onChange={(event) => setCloseToTray(event.target.checked)}
          />
          <span>Keep MusicDeck running in the system tray when closing the window</span>
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoCheckUpdates}
            onChange={(event) => setAutoCheckUpdates(event.target.checked)}
          />
          <span>Automatically check for desktop updates on startup</span>
        </label>

        {error && (
          <div
            role="alert"
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              background: "rgba(239, 68, 68, 0.14)",
              color: "#fca5a5",
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}

        {status && (
          <div
            role="status"
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              background: "rgba(34, 197, 94, 0.14)",
              color: "#86efac",
              fontSize: "0.85rem",
            }}
          >
            {status}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", marginTop: "6px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing || saving}
              style={{
                padding: "9px 14px",
                borderRadius: "8px",
                border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.18))",
                background: "transparent",
                color: "var(--text-primary, #f9fafb)",
                cursor: "pointer",
              }}
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(DESKTOP_CHECK_UPDATES_EVENT))}
              disabled={saving}
              style={{
                padding: "9px 14px",
                borderRadius: "8px",
                border: "1px solid var(--panel-border, rgba(255, 255, 255, 0.18))",
                background: "transparent",
                color: "var(--text-primary, #f9fafb)",
                cursor: "pointer",
              }}
            >
              Check for Updates
            </button>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "9px 14px",
                borderRadius: "8px",
                border: "none",
                background: "transparent",
                color: "var(--text-secondary, #9ca3af)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "9px 16px",
                borderRadius: "8px",
                border: "none",
                background: "var(--accent, #1db954)",
                color: "#04130a",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default DesktopServerModal;
