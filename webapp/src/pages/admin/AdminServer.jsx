import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import {
  cleanupAdminAcquisitions,
  getAdminAcquisitions,
  getAdminBackendConnections,
  getAdminHealth,
  getAdminLibraryScanStatus,
  getDownloaderDiagnostics,
  getServerSettings,
  scanAdminAcquisitions,
  triggerAdminLibraryScan,
  updateServerSettings,
} from "../../api/musicdeck";
import ScanSchedulePicker from "../../components/admin/ScanSchedulePicker";
import { DEFAULT_SCHEDULE, configToCron, parseCronSchedule } from "../../utils/cronUtils";
import AdminLogs from "./AdminLogs";
import { useAdminData } from "./useAdminData";


function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "0 MB";
  }
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
}


function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getSetting(settings, key, fallback) {
  const setting = (settings || []).find((item) => item.key === key);
  return setting ? parseSettingValue(setting.value) : fallback;
}


function ServerSettingsForm({ settings, saving, run, onSaved, scanStatus }) {
  const storedSchedule = String(getSetting(settings, "library.scanSchedule", "") ?? "");
  const parsedSchedule = useMemo(() => parseCronSchedule(storedSchedule), [storedSchedule]);
  const [schedule, setSchedule] = useState(parsedSchedule.config);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(
    Number(getSetting(settings, "jobs.maxConcurrency", 1)) || 1
  );

  // Re-sync when the stored value changes (e.g. after a save normalizes it).
  useEffect(() => {
    setSchedule(parsedSchedule.config);
    setScheduleTouched(false);
  }, [parsedSchedule]);

  const showLegacy = parsedSchedule.status === "unsupported" && !scheduleTouched;

  function handleScheduleChange(next) {
    setSchedule(next);
    setScheduleTouched(true);
  }

  async function handleSave(event) {
    event.preventDefault();
    const payload = { "jobs.maxConcurrency": Math.min(8, Math.max(1, Number(maxConcurrency) || 1)) };
    // An untouched legacy expression is preserved rather than overwritten by the suggested default.
    if (parsedSchedule.status !== "unsupported" || scheduleTouched) {
      payload["library.scanSchedule"] = configToCron(schedule);
    }

    const updated = await run(() => updateServerSettings(payload), {
      successMessage: "Server settings saved.",
      errorMessage: "Could not save server settings.",
    });
    if (updated) onSaved(updated);
  }

  return (
    <form className="admin-form" onSubmit={handleSave}>
      <ScanSchedulePicker
        value={schedule}
        onChange={handleScheduleChange}
        legacyExpression={showLegacy ? parsedSchedule.raw : null}
        onReset={() => handleScheduleChange({ ...DEFAULT_SCHEDULE })}
        timezone={scanStatus?.timezone}
        disabled={saving}
      />
      <label>
        <span>Job concurrency</span>
        <input
          name="maxConcurrency"
          type="number"
          min="1"
          max="8"
          value={maxConcurrency}
          onChange={(event) => setMaxConcurrency(event.target.value)}
        />
      </label>
      {settings.length === 0 && (
        <div className="library-empty">No server settings saved yet.</div>
      )}
      <button type="submit" className="account-primary" disabled={saving}>
        Save server settings
      </button>
    </form>
  );
}

const SCAN_POLL_MS = 2000;
const RUN_LABELS = {
  succeeded: "Completed",
  partial: "Partially failed",
  failed: "Failed",
  skipped: "Skipped",
  running: "Running",
};

function formatDateTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function LibraryScanControl({ status, onStatus }) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const running = Boolean(status?.running);

  // Poll only while a scan is in flight; stops as soon as it finishes or the page unmounts.
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await getAdminLibraryScanStatus();
        if (!cancelled) onStatus(next);
      } catch {
        // Transient poll failures are retried on the next tick.
      }
    }, SCAN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, onStatus]);

  async function handleScan() {
    setRequesting(true);
    setError(null);
    setNotice("");
    try {
      const result = await triggerAdminLibraryScan();
      if (result?.status) onStatus(result.status);
      setNotice(result?.alreadyRunning ? "A scan is already running." : "Library scan started.");
    } catch (err) {
      setError(err.message || "Could not start a library scan.");
    } finally {
      setRequesting(false);
    }
  }

  const busy = requesting || running;
  const lastRun = status?.lastRun;
  const nextRun = formatDateTime(status?.nextRunAt);

  return (
    <div className="scan-now">
      <div className="scan-now__info">
        <strong>Manual scan</strong>
        <dl>
          <div>
            <dt>Next scheduled</dt>
            <dd>{nextRun || "Not scheduled"}</dd>
          </div>
          <div>
            <dt>Last scan</dt>
            <dd>
              {running
                ? `Running since ${formatDateTime(status.currentRun?.startedAt) || "now"}`
                : lastRun
                  ? (
                    <>
                      <span className={`scan-now__state is-${lastRun.status}`}>{RUN_LABELS[lastRun.status] || lastRun.status}</span>
                      {" "}{formatDateTime(lastRun.finishedAt || lastRun.startedAt)} · {lastRun.trigger}
                    </>
                  )
                  : "Never"}
            </dd>
          </div>
        </dl>
        {lastRun?.message && !running && <p className="scan-now__detail">{lastRun.message}</p>}
        {status && !status.valid && status.error && <p className="scan-now__detail is-error">{status.error}</p>}
        {error && <p className="scan-now__detail is-error" role="alert">{error}</p>}
        {notice && !error && <p className="scan-now__detail" role="status">{notice}</p>}
      </div>
      <button type="button" className="account-primary scan-now__button" onClick={handleScan} disabled={busy} aria-busy={busy}>
        {busy && <span className="scan-now__spinner" aria-hidden="true" />}
        {running ? "Scanning…" : requesting ? "Queuing…" : "Scan library now"}
      </button>
    </div>
  );
}

function AdminServerGeneral() {
  const { data, setData, loading, saving, error, message, run } = useAdminData({
    health: getAdminHealth,
    settings: getServerSettings,
    scanStatus: getAdminLibraryScanStatus,
  });
  const setScanStatus = useCallback(
    (scanStatus) => setData((current) => ({ ...current, scanStatus })),
    [setData]
  );

  if (loading) {
    return <div className="loading">Loading server settings...</div>;
  }

  const settings = data.settings || [];

  async function handleSaved(updated) {
    setData((current) => ({ ...current, settings: updated }));
    try {
      setScanStatus(await getAdminLibraryScanStatus());
    } catch {
      // The next poll or page load will pick up the new schedule.
    }
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section">
        <h2>General</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Status</span>
            <strong>{data.health?.ok ? "Online" : "Unknown"}</strong>
          </div>
          <div className="admin-card">
            <span>Backend</span>
            <strong>{data.health?.backend || "Unknown"}</strong>
          </div>
          <div className="admin-card">
            <span>Database</span>
            <strong>{data.health?.database || "Unknown"}</strong>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Server settings</h2>
        <ServerSettingsForm
          settings={settings}
          saving={saving}
          run={run}
          onSaved={handleSaved}
          scanStatus={data.scanStatus}
        />
        <LibraryScanControl status={data.scanStatus} onStatus={setScanStatus} />
      </section>
    </>
  );
}


function AdminServerStorage() {
  const { data, loading } = useAdminData({ acquisitions: getAdminAcquisitions });

  if (loading) {
    return <div className="loading">Loading storage...</div>;
  }

  const acquisitions = data.acquisitions;

  return (
    <section className="admin-section">
      <h2>Storage</h2>
      {acquisitions ? (
        <div className="admin-grid">
          <div className="admin-card">
            <span>Library</span>
            <strong>{formatBytes(acquisitions.storageUsedBytes)}</strong>
            <small>
              <code>
                {acquisitions.musicRoot ||
                  acquisitions.downloadDirectory ||
                  "./data/music"}
              </code>
            </small>
          </div>
          <div className="admin-card">
            <span>Temporary files</span>
            <strong>{formatBytes(acquisitions.tempStorageUsedBytes)}</strong>
          </div>
        </div>
      ) : (
        <div className="library-empty">No storage data available.</div>
      )}
    </section>
  );
}


function AdminServerTasks() {
  const { data, setData, loading, saving, error, message, run } = useAdminData({
    acquisitions: getAdminAcquisitions,
  });

  if (loading) {
    return <div className="loading">Loading tasks...</div>;
  }

  const acquisitions = data.acquisitions;

  async function handleCleanup() {
    const result = await run(() => cleanupAdminAcquisitions(), {
      successMessage: (res) =>
        `Cleanup completed: freed ${formatBytes(res?.bytesFreed || 0)} (${res?.filesRemoved || 0} files removed).`,
      errorMessage: "Failed to clean up temporary storage.",
    });

    if (result !== undefined) {
      const updated = await getAdminAcquisitions().catch(() => null);
      if (updated) {
        setData((current) => ({ ...current, acquisitions: updated }));
      }
    }
  }

  async function handleScan() {
    await run(() => scanAdminAcquisitions(), {
      successMessage: "Library scan triggered successfully.",
      errorMessage: "Failed to trigger library scan.",
    });
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section">
        <h2>Tasks</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Active downloads</span>
            <strong>{acquisitions?.activeJobs ?? 0}</strong>
            <small>{acquisitions?.queuedJobs ?? 0} queued</small>
          </div>
          <div className="admin-card">
            <span>Concurrency</span>
            <strong>{acquisitions?.maxConcurrentDownloads ?? "—"} max</strong>
            <small>
              {acquisitions?.autoScanLibrary
                ? "Auto-scan enabled"
                : "Manual scan"}
            </small>
          </div>
        </div>

        <div className="admin-actions">
          <button
            type="button"
            className="account-action"
            disabled={saving}
            onClick={handleScan}
          >
            Scan Library
          </button>
          <button
            type="button"
            className="account-action"
            disabled={saving}
            onClick={handleCleanup}
          >
            Clean Temp Files
          </button>
        </div>
      </section>
    </>
  );
}


function AdminServerLogs() {
  return <AdminLogs />;
}


function AdminServerHealth() {
  const { data, loading } = useAdminData({
    health: getAdminHealth,
    backendConnections: getAdminBackendConnections,
    downloaders: getDownloaderDiagnostics,
  });

  if (loading) {
    return <div className="loading">Checking server health...</div>;
  }

  const health = data.health;
  const backends = data.backendConnections || [];
  const downloaders = data.downloaders || [];

  return (
    <>
      <section className="admin-section">
        <h2>Health</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Server</span>
            <strong>{health?.ok ? "Online" : "Offline"}</strong>
          </div>
          <div className="admin-card">
            <span>Backend connections</span>
            <strong>{backends.filter((b) => b.enabled).length}</strong>
            <small>{backends.length} configured</small>
          </div>
          <div className="admin-card">
            <span>Downloaders</span>
            <strong>
              {downloaders.filter((d) => d.available).length}/
              {downloaders.length}
            </strong>
            <small>available</small>
          </div>
        </div>
      </section>
    </>
  );
}


function AdminServerAbout() {
  const { data, loading } = useAdminData({ health: getAdminHealth });

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <section className="admin-section">
      <h2>About</h2>
      <div className="admin-grid">
        <div className="admin-card">
          <span>Service</span>
          <strong>{data.health?.service || "musicdeck-server"}</strong>
        </div>
        <div className="admin-card">
          <span>Backend</span>
          <strong>{data.health?.backend || "Unknown"}</strong>
        </div>
      </div>
    </section>
  );
}


function AdminServerDownloads() {
  const { data, setData, loading, saving, error, message, run } = useAdminData({
    acquisitions: getAdminAcquisitions,
    downloaders: getDownloaderDiagnostics,
  });

  if (loading) {
    return <div className="loading">Loading downloads...</div>;
  }

  const acquisitions = data.acquisitions;
  const downloaders = data.downloaders || [];

  async function handleCleanup() {
    const result = await run(() => cleanupAdminAcquisitions(), {
      successMessage: (res) =>
        `Cleanup completed: freed ${formatBytes(res?.bytesFreed || 0)} (${res?.filesRemoved || 0} files removed).`,
      errorMessage: "Failed to clean up temporary storage.",
    });

    if (result !== undefined) {
      const updated = await getAdminAcquisitions().catch(() => null);
      if (updated) {
        setData((current) => ({ ...current, acquisitions: updated }));
      }
    }
  }

  async function handleScan() {
    await run(() => scanAdminAcquisitions(), {
      successMessage: "Library scan triggered successfully.",
      errorMessage: "Failed to trigger library scan.",
    });
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2>On-Demand Library</h2>
            <div className="account-meta" style={{ marginTop: 4 }}>
              Music Library:{" "}
              <code>
                {acquisitions?.musicRoot ||
                  acquisitions?.downloadDirectory ||
                  "./data/music"}
              </code>
            </div>
          </div>
          <div className="admin-actions">
            <button
              type="button"
              className="account-action"
              disabled={saving}
              onClick={handleScan}
            >
              Scan Library
            </button>
            <button
              type="button"
              className="account-action"
              disabled={saving}
              onClick={handleCleanup}
            >
              Clean Temp Files
            </button>
          </div>
        </div>

        {acquisitions ? (
          <div className="admin-acquisition-stats">
            <div className="admin-card">
              <span>Active Downloads</span>
              <strong>{acquisitions.activeJobs}</strong>
              <small>{acquisitions.queuedJobs} queued</small>
            </div>
            <div className="admin-card">
              <span>Completed Acquisitions</span>
              <strong>{acquisitions.completedJobs}</strong>
              <small>{acquisitions.failedJobs} failed</small>
            </div>
            <div className="admin-card">
              <span>Storage Used</span>
              <strong>{formatBytes(acquisitions.storageUsedBytes)}</strong>
              <small>
                Temp: {formatBytes(acquisitions.tempStorageUsedBytes)}
              </small>
            </div>
            <div className="admin-card">
              <span>Concurrency</span>
              <strong>{acquisitions.maxConcurrentDownloads} max</strong>
              <small>
                {acquisitions.autoScanLibrary
                  ? "Auto-scan enabled"
                  : "Manual scan"}
              </small>
            </div>
          </div>
        ) : (
          <div className="library-empty">
            On-demand library acquisition is ready.
          </div>
        )}

        {downloaders.length > 0 && (
          <div
            className="admin-table"
            role="table"
            aria-label="Downloader Adapters"
            style={{ marginTop: 16 }}
          >
            {downloaders.map((downloader) => (
              <div className="admin-row" key={downloader.id} role="row">
                <div>
                  <strong>{downloader.name}</strong>
                  <span>
                    {downloader.diagnostics?.spotdlVersion
                      ? `spotDL ${downloader.diagnostics.spotdlVersion}`
                      : "spotDL"}
                    {downloader.diagnostics?.ffmpegVersion
                      ? ` · FFmpeg ${downloader.diagnostics.ffmpegVersion}`
                      : ""}
                  </span>
                </div>
                <span
                  className={`admin-job-status status-${
                    downloader.available ? "completed" : "failed"
                  }`}
                >
                  {downloader.available ? "Available" : "Not detected"}
                </span>
                <small>
                  {downloader.diagnostics?.ffmpegAvailable === false
                    ? "FFmpeg missing"
                    : downloader.error || ""}
                </small>
              </div>
            ))}
          </div>
        )}

        {acquisitions?.recentJobs && acquisitions.recentJobs.length > 0 && (
          <div className="admin-table" role="table" aria-label="Recent Acquisitions">
            {acquisitions.recentJobs.slice(0, 10).map((job) => (
              <div className="admin-row" key={job.id} role="row">
                <div>
                  <strong>
                    {job.requestedTrackId || job.requestedAlbumId || job.id}
                  </strong>
                  <span>{job.sourceProvider || "auto-discovered"}</span>
                </div>
                <span className={`admin-job-status status-${job.status}`}>
                  {job.status}
                  {job.progress?.percent != null
                    ? ` ${Math.round(job.progress.percent)}%`
                    : ""}
                </span>
                <small>{new Date(job.createdAt).toLocaleTimeString()}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}


function AdminServer() {
  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Server</h1>
        </div>
      </div>

      <nav className="admin-subnav" aria-label="Server sections">
        <NavLink to="/admin/server" end className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          General
        </NavLink>
        <NavLink to="/admin/server/storage" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Storage
        </NavLink>
        <NavLink to="/admin/server/tasks" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Tasks
        </NavLink>
        <NavLink to="/admin/server/downloads" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Downloads
        </NavLink>
        <NavLink to="/admin/server/logs" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Logs
        </NavLink>
        <NavLink to="/admin/server/health" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Health
        </NavLink>
        <NavLink to="/admin/server/about" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          About
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<AdminServerGeneral />} />
        <Route path="storage" element={<AdminServerStorage />} />
        <Route path="tasks" element={<AdminServerTasks />} />
        <Route path="downloads" element={<AdminServerDownloads />} />
        <Route path="logs" element={<AdminServerLogs />} />
        <Route path="health" element={<AdminServerHealth />} />
        <Route path="about" element={<AdminServerAbout />} />
      </Routes>
    </div>
  );
}


export default AdminServer;
