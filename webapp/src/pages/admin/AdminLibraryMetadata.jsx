import { useMemo } from "react";

import { getLibraryHealth } from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


const METADATA_ISSUE_TYPES = new Set([
  "metadata",
  "missing_metadata",
  "missing_artwork",
  "missing-artwork",
  "metadata_issue",
]);


function AdminLibraryMetadata() {
  const { data, loading, error } = useAdminData({ health: getLibraryHealth });

  const issues = useMemo(() => {
    const all = data.health?.issues || [];
    return all.filter(
      (issue) =>
        METADATA_ISSUE_TYPES.has(issue.type) ||
        /metadata|artwork/i.test(issue.type || "")
    );
  }, [data.health]);

  if (loading) {
    return <div className="loading">Checking metadata...</div>;
  }

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>Metadata</h1>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <AdminLibraryNav />

      <section className="admin-section">
        <h2>Metadata issues</h2>
        {issues.length === 0 ? (
          <div className="library-empty">No metadata issues detected.</div>
        ) : (
          <div className="admin-table" role="table" aria-label="Metadata issues">
            {issues.map((issue) => (
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


export default AdminLibraryMetadata;
