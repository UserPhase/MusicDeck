import { Link } from "react-router-dom";

import {
  getAdminAcquisitions,
  getAdminHealth,
  getAdminPlugins,
  getLibraryStatistics,
  getUsers,
} from "../../api/musicdeck";
import { useAuth } from "../../context/AuthContext";
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


function AdminDashboard() {
  const { session } = useAuth();

  const { data, loading, error } = useAdminData({
    health: getAdminHealth,
    users: getUsers,
    plugins: getAdminPlugins,
    acquisitions: getAdminAcquisitions,
    statistics: getLibraryStatistics,
  });

  if (loading) {
    return <div className="loading">Loading admin dashboard...</div>;
  }

  const health = data.health;
  const users = data.users || [];
  const plugins = data.plugins || [];
  const acquisitions = data.acquisitions;
  const statistics = data.statistics;

  const enabledPlugins = plugins.filter((plugin) => plugin.enabled).length;
  const activeJobs =
    (acquisitions?.activeJobs || 0) + (acquisitions?.queuedJobs || 0);

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Dashboard</h1>
          <div className="account-meta">Signed in as {session?.username}</div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <section className="admin-section">
        <h2>Overview</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Server</span>
            <strong>{health?.ok ? "Online" : "Unknown"}</strong>
            <small>{health?.backend || "Unknown backend"}</small>
          </div>
          <div className="admin-card">
            <span>Database</span>
            <strong>{health?.database || "Unknown"}</strong>
            <small>{health?.counts?.sessions ?? 0} sessions</small>
          </div>
          <div className="admin-card">
            <span>Users</span>
            <strong>{health?.counts?.users ?? users.length}</strong>
            <small>
              {users.filter((user) => user.role === "admin").length} admin
            </small>
          </div>
          <div className="admin-card">
            <span>Library</span>
            <strong>
              {statistics?.totalTracks ?? statistics?.tracks ?? "—"}
            </strong>
            <small>
              {statistics?.totalAlbums != null
                ? `${statistics.totalAlbums} albums`
                : "tracks indexed"}
            </small>
          </div>
          <div className="admin-card">
            <span>Downloads</span>
            <strong>{activeJobs}</strong>
            <small>
              {acquisitions
                ? `${acquisitions.completedJobs} completed · ${acquisitions.failedJobs} failed`
                : "no acquisition data"}
            </small>
          </div>
          <div className="admin-card">
            <span>Plugins</span>
            <strong>
              {enabledPlugins}/{plugins.length}
            </strong>
            <small>enabled</small>
          </div>
          <div className="admin-card">
            <span>Storage</span>
            <strong>{formatBytes(acquisitions?.storageUsedBytes)}</strong>
            <small>
              temp {formatBytes(acquisitions?.tempStorageUsedBytes)}
            </small>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Recent activity</h2>
        {acquisitions?.recentJobs?.length ? (
          <div className="admin-table" role="table" aria-label="Recent activity">
            {acquisitions.recentJobs.slice(0, 8).map((job) => (
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
        ) : (
          <div className="library-empty">
            No recent download activity. Trigger a download from search or the{" "}
            <Link to="/admin/server/downloads">downloads page</Link>.
          </div>
        )}
      </section>
    </div>
  );
}


export default AdminDashboard;
