import { useState } from "react";

import {
  getAdminBackendConnections,
  getAdminPlugins,
  getAdminSearchProviders,
  getAdminSourceProviders,
  testAdminSearchProvider,
  testAdminSourceProvider,
  updateAdminSearchProvider,
  updateAdminSourceProvider,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";


const ACQUISITION_CAPABILITY_PATTERN = /acquisition|download/i;
const DISCOVERY_CAPABILITY_PATTERN = /recommendation|discovery|radio/i;

const TEST_STATUS_LABELS = {
  success: "Connected",
  not_configured: "Not configured",
  authentication_failed: "Authentication failed",
  provider_unavailable: "Unavailable",
  timeout: "Timed out",
  permission_denied: "Permission denied",
  plugin_error: "Error",
};


function AdminSources() {
  const { data, setData, loading, saving, error, message, run } = useAdminData({
    backendConnections: getAdminBackendConnections,
    searchProviders: getAdminSearchProviders,
    sourceProviders: getAdminSourceProviders,
    plugins: getAdminPlugins,
  });

  const [regionDraft, setRegionDraft] = useState(null);
  const [spotifyDraft, setSpotifyDraft] = useState({ clientId: null, clientSecret: null });
  const [testResults, setTestResults] = useState({});
  const [testingId, setTestingId] = useState(null);

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

  async function handleTestSearchProvider(provider) {
    setTestingId(provider.id);
    try {
      const result = await testAdminSearchProvider(provider.id);
      setTestResults((current) => ({ ...current, [provider.id]: result }));
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { ok: false, message: err.message || "Test failed." },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleTestSourceProvider(provider) {
    setTestingId(provider.id);
    try {
      const result = await testAdminSourceProvider(provider.id);
      setTestResults((current) => ({ ...current, [provider.id]: result }));
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { ok: false, message: err.message || "Test failed." },
      }));
    } finally {
      setTestingId(null);
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
                    ? provider.statusMessage || "Search unavailable"
                    : provider.status}
                </span>
                {testResults[provider.id] && (
                  <span className={testResults[provider.id].ok ? "success" : "error"}>
                    {TEST_STATUS_LABELS[testResults[provider.id].status] || (testResults[provider.id].ok ? "Connected" : "Failed")}
                    {testResults[provider.id].message ? ` — ${testResults[provider.id].message}` : ""}
                  </span>
                )}
              </div>
              <span className="admin-provider-kind">{provider.kind}</span>
              <button
                type="button"
                className="account-action"
                disabled={saving || testingId === provider.id}
                onClick={() => handleTestSearchProvider(provider)}
              >
                {testingId === provider.id ? "Testing..." : "Test"}
              </button>
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
              {provider.id === "spotify" && (() => {
                const spotdlPlugin = plugins.find((plugin) => plugin.id === "spotdl-downloader");
                const spotdlHasCredentials = Boolean(
                  spotdlPlugin?.config?.clientId && spotdlPlugin?.config?.clientSecret
                );
                const hasOwnCredentials = Boolean(provider.config?.clientId);
                const clientIdValue =
                  spotifyDraft.clientId !== null
                    ? spotifyDraft.clientId
                    : provider.config?.clientId || "";
                const clientSecretValue =
                  spotifyDraft.clientSecret !== null ? spotifyDraft.clientSecret : "";

                function commitClientId(event) {
                  const clientId = event.target.value.trim();
                  setSpotifyDraft((current) => ({ ...current, clientId: null }));
                  if (clientId !== (provider.config?.clientId || "")) {
                    handleSearchProviderUpdate(provider, {
                      config: { ...provider.config, clientId },
                    });
                  }
                }

                function commitClientSecret(event) {
                  const clientSecret = event.target.value.trim();
                  setSpotifyDraft((current) => ({ ...current, clientSecret: null }));
                  if (clientSecret) {
                    handleSearchProviderUpdate(provider, {
                      config: { ...provider.config, clientSecret },
                    });
                  }
                }

                return (
                  <div className="admin-provider-config admin-provider-config-spotify">
                    <label>
                      <span>Spotify Client ID</span>
                      <input
                        aria-label="Spotify Client ID"
                        value={clientIdValue}
                        placeholder={
                          spotdlHasCredentials && !hasOwnCredentials
                            ? "Using spotDL Downloader credentials"
                            : "Client ID"
                        }
                        disabled={saving}
                        onChange={(event) =>
                          setSpotifyDraft((current) => ({ ...current, clientId: event.target.value }))
                        }
                        onBlur={commitClientId}
                      />
                    </label>
                    <label>
                      <span>Spotify Client Secret</span>
                      <input
                        type="password"
                        aria-label="Spotify Client Secret"
                        value={clientSecretValue}
                        placeholder={
                          spotdlHasCredentials && !hasOwnCredentials
                            ? "Using spotDL Downloader credentials"
                            : "Client secret"
                        }
                        disabled={saving}
                        onChange={(event) =>
                          setSpotifyDraft((current) => ({ ...current, clientSecret: event.target.value }))
                        }
                        onBlur={commitClientSecret}
                      />
                    </label>
                    {spotdlHasCredentials && !hasOwnCredentials && (
                      <small className="admin-provider-config-hint">
                        No credentials set here — reusing the Spotify app credentials already
                        configured on the spotDL Downloader plugin. Enter credentials above to
                        override them for search only.
                      </small>
                    )}
                    {!spotdlHasCredentials && !hasOwnCredentials && (
                      <small className="admin-provider-config-hint">
                        Enter Spotify app credentials here, or configure them once on the spotDL
                        Downloader plugin to share them with both acquisition and search.
                      </small>
                    )}
                  </div>
                );
              })()}
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
                {testResults[provider.id] && (
                  <span className={testResults[provider.id].ok ? "success" : "error"}>
                    {TEST_STATUS_LABELS[testResults[provider.id].status] || (testResults[provider.id].ok ? "Connected" : "Failed")}
                    {testResults[provider.id].message ? ` — ${testResults[provider.id].message}` : ""}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="account-action"
                disabled={saving || testingId === provider.id}
                onClick={() => handleTestSourceProvider(provider)}
              >
                {testingId === provider.id ? "Testing..." : "Test"}
              </button>
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
