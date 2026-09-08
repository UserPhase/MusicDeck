import { useState } from "react";

import {
  getAdminBackendConnections,
  getAdminPlugins,
  getAdminSearchProviders,
  getAdminSourceProviders,
  updateAdminSearchProvider,
  updateAdminSourceProvider,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";


const ACQUISITION_CAPABILITY_PATTERN = /acquisition|download/i;
const DISCOVERY_CAPABILITY_PATTERN = /recommendation|discovery|radio/i;


function AdminSources() {
  const { data, setData, loading, saving, error, message, run } = useAdminData({
    backendConnections: getAdminBackendConnections,
    searchProviders: getAdminSearchProviders,
    sourceProviders: getAdminSourceProviders,
    plugins: getAdminPlugins,
  });

  const [regionDraft, setRegionDraft] = useState(null);

  const backendConnections = data.backendConnections || [];
  const searchProviders = data.searchProviders || [];
  const sourceProviders = data.sourceProviders || [];
  const plugins = data.plugins || [];

  const acquisitionPlugins = plugins.filter((plugin) =>
    (plugin.capabilities || []).some((capability) =>
      ACQUISITION_CAPABILITY_PATTERN.test(capability)
    )
  );
  const discoveryPlugins = plugins.filter((plugin) =>
    (plugin.capabilities || []).some((capability) =>
      DISCOVERY_CAPABILITY_PATTERN.test(capability)
    )
  );

  async function handleSearchProviderUpdate(provider, updates) {
    const updated = await run(
      () => updateAdminSearchProvider(provider.id, updates),
      {
        successMessage: "Search provider updated.",
        errorMessage: "Could not update search provider.",
      }
    );

    if (updated) {
      setData((current) => ({
        ...current,
        searchProviders: current.searchProviders.map((item) =>
          item.id === provider.id ? updated : item
        ),
      }));
    }
  }

  async function handleSourceProviderUpdate(provider, enabled) {
    const updated = await run(
      () => updateAdminSourceProvider(provider.id, { enabled }),
      {
        successMessage: "Source provider updated.",
        errorMessage: "Could not update source provider.",
      }
    );

    if (updated) {
      setData((current) => ({
        ...current,
        sourceProviders: current.sourceProviders.map((item) =>
          item.id === provider.id ? updated : item
        ),
      }));
    }
  }

  if (loading) {
    return <div className="loading">Loading sources & providers...</div>;
  }

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Sources &amp; Providers</h1>
          <div className="account-meta">
            Library backends, search, source, discovery and acquisition
            integrations
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section">
        <h2>Library backends</h2>
        {backendConnections.length === 0 ? (
          <div className="library-empty">No backend connections configured.</div>
        ) : (
          <div className="admin-grid">
            {backendConnections.map((connection) => (
              <div className="admin-card" key={connection.id}>
                <span>{connection.name}</span>
                <strong>{connection.type}</strong>
                <small>{connection.enabled ? "Enabled" : "Disabled"}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Search providers</h2>
        <div className="admin-table" role="table" aria-label="Search providers">
          {searchProviders.map((provider) => (
            <div className="admin-row admin-provider-row" key={provider.id} role="row">
              <div>
                <strong>{provider.name}</strong>
                <span>
                  {provider.status === "error"
                    ? "Search unavailable"
                    : provider.status}
                </span>
              </div>
              <span className="admin-provider-kind">{provider.kind}</span>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  disabled={saving}
                  onChange={(event) =>
                    handleSearchProviderUpdate(provider, {
                      enabled: event.target.checked,
                    })
                  }
                />
                <span>Enabled</span>
              </label>
              {provider.id === "itunes" && (
                <label className="admin-provider-config">
                  <span>Region</span>
                  <input
                    aria-label="External catalog region"
                    value={
                      regionDraft !== null
                        ? regionDraft
                        : provider.config?.country || ""
                    }
                    placeholder="US"
                    disabled={saving}
                    onChange={(event) => setRegionDraft(event.target.value)}
                    onBlur={(event) => {
                      const country = event.target.value.trim().toUpperCase();
                      setRegionDraft(null);
                      if (country !== (provider.config?.country || "")) {
                        handleSearchProviderUpdate(provider, {
                          config: { ...provider.config, country },
                        });
                      }
                    }}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h2>Source providers</h2>
        <div className="admin-table" role="table" aria-label="Playback sources">
          {sourceProviders.map((provider) => (
            <div className="admin-row admin-provider-row" key={provider.id} role="row">
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.enabled ? "Enabled" : "Disabled"}</span>
              </div>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  disabled={saving}
                  onChange={(event) =>
                    handleSourceProviderUpdate(provider, event.target.checked)
                  }
                />
                <span>Enabled</span>
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h2>Discovery providers</h2>
        {discoveryPlugins.length === 0 ? (
          <div className="library-empty">
            No discovery-capable plugins installed.
          </div>
        ) : (
          <div className="admin-table" role="table" aria-label="Discovery providers">
            {discoveryPlugins.map((plugin) => (
              <div className="admin-row" key={plugin.id} role="row">
                <div>
                  <strong>{plugin.name}</strong>
                  <span>{(plugin.capabilities || []).join(", ")}</span>
                </div>
                <span
                  className={`admin-job-status status-${
                    plugin.enabled ? "completed" : "failed"
                  }`}
                >
                  {plugin.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Acquisition providers</h2>
        {acquisitionPlugins.length === 0 ? (
          <div className="library-empty">
            No acquisition-capable plugins installed.
          </div>
        ) : (
          <div className="admin-table" role="table" aria-label="Acquisition providers">
            {acquisitionPlugins.map((plugin) => (
              <div className="admin-row" key={plugin.id} role="row">
                <div>
                  <strong>{plugin.name}</strong>
                  <span>{(plugin.capabilities || []).join(", ")}</span>
                </div>
                <span
                  className={`admin-job-status status-${
                    plugin.enabled ? "completed" : "failed"
                  }`}
                >
                  {plugin.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


export default AdminSources;
