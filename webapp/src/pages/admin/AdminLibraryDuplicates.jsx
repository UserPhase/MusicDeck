import { useMemo, useState } from "react";

import { getLibraryHealth } from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibraryDuplicates() {
  const { data, loading, error } = useAdminData({ health: getLibraryHealth });
  const [onlyDuplicates, setOnlyDuplicates] = useState(true);

  const issues = useMemo(() => {
    const all = data.health?.issues || [];
    return all.filter((issue) =>
      onlyDuplicates ? issue.type === "duplicate" : true
    );
  }, [data.health, onlyDuplicates]);

  if (loading) {
    return <div className="loading">Scanning for duplicates...</div>;
  }

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>Duplicates</h1>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <AdminLibraryNav />

      <section className="admin-section">
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={onlyDuplicates}
            onChange={(event) => setOnlyDuplicates(event.target.checked)}
          />
          <span>Show only duplicates</span>
        </label>

        {issues.length === 0 ? (
          <div className="library-empty">No duplicate tracks detected.</div>
        ) : (
          <div className="admin-table" role="table" aria-label="Duplicate tracks">
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


export default AdminLibraryDuplicates;
