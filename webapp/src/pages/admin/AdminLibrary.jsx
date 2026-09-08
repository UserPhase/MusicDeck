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

  const statistics = data.statistics;

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
            <strong>{statistics?.totalTracks ?? statistics?.tracks ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Albums</span>
            <strong>{statistics?.totalAlbums ?? statistics?.albums ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Artists</span>
            <strong>{statistics?.totalArtists ?? statistics?.artists ?? "—"}</strong>
          </div>
          <div className="admin-card">
            <span>Genres</span>
            <strong>{statistics?.totalGenres ?? statistics?.genres ?? "—"}</strong>
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
