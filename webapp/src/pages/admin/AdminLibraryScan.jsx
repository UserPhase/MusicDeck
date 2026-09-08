import { useState } from "react";

import { scanAdminAcquisitions } from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibraryScan() {
  const { saving, error, message, run } = useAdminData({});
  const [lastScan, setLastScan] = useState(null);

  async function handleScan() {
    const result = await run(() => scanAdminAcquisitions(), {
      successMessage: "Library scan triggered successfully.",
      errorMessage: "Failed to trigger library scan.",
    });

    if (result !== undefined) {
      setLastScan(new Date());
    }
  }

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>Scan</h1>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <AdminLibraryNav />

      <section className="admin-section">
        <h2>Library scan</h2>
        <p className="account-meta">
          Trigger a rescan so newly downloaded or copied files are indexed.
          The scan waits for the library backend to finish before reporting
          completion.
        </p>
        <div className="admin-actions">
          <button
            type="button"
            className="account-primary"
            disabled={saving}
            onClick={handleScan}
          >
            {saving ? "Scanning..." : "Scan library now"}
          </button>
        </div>
        {lastScan && (
          <p className="account-meta">
            Last scan triggered at {lastScan.toLocaleTimeString()}.
          </p>
        )}
      </section>
    </div>
  );
}


export default AdminLibraryScan;
