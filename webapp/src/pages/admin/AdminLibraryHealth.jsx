import { getLibraryHealth, getLibraryStatistics } from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibraryHealth() {
  const { data, loading, error } = useAdminData({
    health: getLibraryHealth,
    statistics: getLibraryStatistics,
  });

  if (loading) {
    return <div className="loading">Checking library health...</div>;
  }

  const health = data.health || {};
  const summary = health.summary || {};
  const collection = data.statistics?.collection || {};

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>Health</h1>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <AdminLibraryNav />

      <section className="admin-section">
        <h2>Library health</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>Albums</span>
            <strong>{summary.albums || 0}</strong>
          </div>
          <div className="admin-card">
            <span>Tracks</span>
            <strong>{summary.tracks || 0}</strong>
          </div>
          <div className="admin-card">
            <span>Missing artwork</span>
            <strong>{summary.missingArtwork || 0}</strong>
          </div>
          <div className="admin-card">
            <span>Metadata issues</span>
            <strong>{summary.metadataIssues || 0}</strong>
          </div>
          <div className="admin-card">
            <span>Duplicates</span>
            <strong>{summary.duplicates || 0}</strong>
          </div>
          <div className="admin-card">
            <span>Unavailable</span>
            <strong>{summary.unavailable || 0}</strong>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Collection statistics</h2>
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
      </section>

      <section className="admin-section">
        <h2>Issues</h2>
        {!health.issues || health.issues.length === 0 ? (
          <div className="library-empty">No library issues detected.</div>
        ) : (
          <div className="admin-table" role="table" aria-label="Library issues">
            {health.issues.map((issue) => (
              <div className="admin-row" key={`${issue.type}:${issue.itemId}`} role="row">
                <div>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                </div>
                <span className="admin-provider-kind">{issue.type}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


export default AdminLibraryHealth;
