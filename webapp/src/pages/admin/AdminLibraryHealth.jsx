import { getLibraryStatistics } from "../../api/musicdeck";
import LibraryHealth from "../../components/admin/LibraryHealth";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibraryHealth() {
  const { data, loading, error } = useAdminData({
    statistics: getLibraryStatistics,
  });

  const collection = data.statistics?.collection || {};

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>Health</h1>
        </div>
      </div>

      <AdminLibraryNav />

      <LibraryHealth />

      <section className="admin-section">
        <h2>Collection statistics</h2>
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="loading">Loading collection statistics...</div>
        ) : (
          <div className="admin-grid">
            <div className="admin-card">
              <span>Artists</span>
              <strong>{collection.artists || 0}</strong>
            </div>
            <div className="admin-card">
              <span>Total duration</span>
              <strong>
                {Math.round((collection.totalDurationSeconds || 0) / 3600)} h
              </strong>
            </div>
            <div className="admin-card">
              <span>Played</span>
              <strong>{collection.playedPercentage || 0}%</strong>
            </div>
            <div className="admin-card">
              <span>Favorites</span>
              <strong>{collection.favoritePercentage || 0}%</strong>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}


export default AdminLibraryHealth;