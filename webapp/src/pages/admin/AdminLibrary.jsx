import { Link } from "react-router-dom";

import {
  getLibraryStatistics,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibrary() {
  const { data, loading, error } = useAdminData({
    statistics: getLibraryStatistics,
  });

  if (loading) {
    return <div className="loading">Loading library overview...</div>;
  }

  const collection = data.statistics?.collection;

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Library</h1>
          <div className="account-meta">
            Manage the indexed music library
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <AdminLibraryNav />

      <section className="admin-section">
        <h2>Overview</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Tracks</span>
            <strong>{collection?.tracks ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Albums</span>
            <strong>{collection?.albums ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Artists</span>
            <strong>{collection?.artists ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Total duration</span>
            <strong>{collection?.totalDurationSeconds != null
              ? `${Math.round(collection.totalDurationSeconds / 3600)} h`
              : "—"}</strong>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Maintenance</h2>
        <div className="admin-link-grid">
          <Link to="/admin/library/health" className="admin-link-card">
            <strong>Health</strong>
            <span>Missing files, broken references, scan status.</span>
          </Link>
          <Link to="/admin/library/duplicates" className="admin-link-card">
            <strong>Duplicates</strong>
            <span>Find tracks that appear multiple times.</span>
          </Link>
          <Link to="/admin/library/metadata" className="admin-link-card">
            <strong>Metadata</strong>
            <span>Tracks with missing or incomplete tags.</span>
          </Link>
          <Link to="/admin/library/scan" className="admin-link-card">
            <strong>Scan</strong>
            <span>Trigger a rescan after adding files.</span>
          </Link>
        </div>
      </section>
    </div>
  );
}


export default AdminLibrary;
