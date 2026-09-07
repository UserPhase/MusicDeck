import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import {
  createUser,
  deleteUser,
  getAdminAcquisitions,
  getDownloaderDiagnostics,
  getAdminBackendConnections,
  getAdminHealth,
  getAdminPlugins,
  getAdminSearchProviders,
  getAdminSourceProviders,
  getServerSettings,
  getUsers,
  installAdminPlugin,
  uninstallAdminPlugin,
  updateServerSettings,
  updateAdminPlugin,
  updateAdminSearchProvider,
  updateAdminSourceProvider,
  testAdminPlugin,
  updateUser,
  cleanupAdminAcquisitions,
  scanAdminAcquisitions,
} from "../api/musicdeck";

import {
  useAuth,
} from "../context/AuthContext";


const PLUGIN_STATUS_LABELS = {
  success: "Connected",
  not_configured: "Not configured",
  authentication_failed: "Authentication failed",
  provider_unavailable: "Provider unavailable",
  timeout: "Timed out",
  permission_denied: "Permission denied",
  plugin_error: "Plugin error",
};

function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getSetting(settings, key, fallback) {
  const setting = settings.find((item) => item.key === key);
  return setting ? parseSettingValue(setting.value) : fallback;
}


function Admin() {
  const { session } = useAuth();

  const [health, setHealth] = useState(null);
  const [users, setUsers] = useState([]);
  const [backendConnections, setBackendConnections] = useState([]);
  const [searchProviders, setSearchProviders] = useState([]);
  const [sourceProviders, setSourceProviders] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [serverSettings, setServerSettings] = useState([]);
  const [acquisitions, setAcquisitions] = useState(null);
  const [downloaders, setDownloaders] = useState([]);
  const [pluginConfig, setPluginConfig] = useState(null);
  const [pluginTestResults, setPluginTestResults] = useState({});
  const [addPluginOpen, setAddPluginOpen] = useState(false);
  const [addPluginManifestText, setAddPluginManifestText] = useState("");
  const [addPluginPreview, setAddPluginPreview] = useState(null);
  const [addPluginError, setAddPluginError] = useState("");
  const [scanSchedule, setScanSchedule] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [regionDraft, setRegionDraft] = useState(null);
  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    displayName: "",
    role: "user",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");


  useEffect(() => {
    let cancelled = false;

    async function loadAdmin() {
      try {
        setLoading(true);
        setError(null);

        const [
          healthData,
          usersData,
          backendData,
          searchProviderData,
          sourceProviderData,
          pluginData,
          settingsData,
          acquisitionsData,
          downloaderData,
        ] = await Promise.all([
          getAdminHealth(),
          getUsers(),
          getAdminBackendConnections(),
          getAdminSearchProviders(),
          getAdminSourceProviders(),
          getAdminPlugins(),
          getServerSettings(),
          Promise.resolve(getAdminAcquisitions ? getAdminAcquisitions() : null).catch(() => null),
          Promise.resolve(getDownloaderDiagnostics ? getDownloaderDiagnostics() : []).catch(() => []),
        ]);

        if (!cancelled) {
          setHealth(healthData);
          setUsers(usersData);
          setBackendConnections(backendData);
          setSearchProviders(searchProviderData);
          setSourceProviders(sourceProviderData);
          setPlugins(pluginData);
          setServerSettings(settingsData);
          setAcquisitions(acquisitionsData);
          setDownloaders(downloaderData || []);
          setScanSchedule(String(getSetting(settingsData, "library.scanSchedule", "")));
          setMaxConcurrency(Number(getSetting(settingsData, "jobs.maxConcurrency", 1)));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load admin dashboard.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (session?.role === "admin") {
      loadAdmin();
    }

    return () => {
      cancelled = true;
    };
  }, [session]);


  if (session?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  async function handleCreateUser(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const user = await createUser({
        username: newUser.username.trim(),
        password: newUser.password,
        displayName: newUser.displayName.trim() || undefined,
        role: newUser.role,
      });

      setUsers((current) => [...current, user]);
      setNewUser({ username: "", password: "", displayName: "", role: "user" });
      setMessage("User created.");
    } catch (err) {
      setError(err.message || "Could not create user.");
    } finally {
      setSaving(false);
    }
  }


  async function handleUpdateUser(userId, updates) {
    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const updated = await updateUser(userId, updates);
      setUsers((current) => current.map((user) => user.id === userId ? updated : user));
      setMessage("User updated.");
    } catch (err) {
      setError(err.message || "Could not update user.");
    } finally {
      setSaving(false);
    }
  }


  async function handleDeleteUser(user) {
    if (user.id === session.id) {
      setError("You cannot delete your own administrator account here.");
      return;
    }

    const confirmed = window.confirm(`Delete ${user.username}?`);

    if (!confirmed) {
      return;
    }

    try {
      setSaving(true);
      setMessage("");
      setError(null);

      await deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setMessage("User deleted.");
    } catch (err) {
      setError(err.message || "Could not delete user.");
    } finally {
      setSaving(false);
    }
  }


  async function handleSaveServerSettings(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const settings = await updateServerSettings({
        "library.scanSchedule": scanSchedule,
        "jobs.maxConcurrency": Number(maxConcurrency),
      });

      setServerSettings(settings);
      setMessage("Server settings saved.");
    } catch (err) {
      setError(err.message || "Could not save server settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSearchProviderUpdate(provider, updates) {
    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const updated = await updateAdminSearchProvider(provider.id, updates);
      setSearchProviders((current) => current.map((item) => item.id === provider.id ? updated : item));
      setMessage("Search provider updated.");
    } catch (err) {
      setError(err.message || "Could not update search provider.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSourceProviderUpdate(provider, enabled) {
    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const updated = await updateAdminSourceProvider(provider.id, { enabled });
      setSourceProviders((current) => current.map((item) => item.id === provider.id ? updated : item));
      setMessage("Source provider updated.");
    } catch (err) {
      setError(err.message || "Could not update source provider.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePluginUpdate(plugin, enabled) {
    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const updated = await updateAdminPlugin(plugin.id, {
        enabled,
        // Enabling an integration is the administrator's approval of the
        // permissions it declared. Keep the permissions control in the
        // settings panel for administrators who need to revoke individual
        // permissions after enabling it.
        permissions: enabled
          ? plugin.permissions || []
          : plugin.approvedPermissions || [],
      });
      setPlugins((current) => current.map((item) => item.id === plugin.id ? updated : item));
      setMessage("Plugin updated.");
    } catch (err) {
      setError(err.message || "Could not update plugin.");
    } finally {
      setSaving(false);
    }
  }

  function openPluginSettings(plugin) {
    if (pluginConfig?.id === plugin.id) {
      setPluginConfig(null);
      return;
    }

    setPluginConfig({
      id: plugin.id,
      values: Object.fromEntries(
        (plugin.configFields || []).map((field) => [
          field.key,
          field.secret ? "" : String(plugin.config?.[field.key] ?? ""),
        ])
      ),
      permissions: plugin.approvedPermissions || [],
    });
  }

  async function handleSavePluginSettings(plugin) {
    if (!pluginConfig) return;

    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const config = {};
      for (const field of plugin.configFields || []) {
        const value = pluginConfig.values[field.key];
        if (field.secret && !value) {
          // Empty secret field keeps the existing stored value.
          if (plugin.config?.[field.key] === true) continue;
          config[field.key] = "";
        } else {
          config[field.key] = value;
        }
      }

      const updated = await updateAdminPlugin(plugin.id, {
        enabled: plugin.enabled,
        config,
        permissions: pluginConfig.permissions,
      });
      setPlugins((current) => current.map((item) => item.id === plugin.id ? updated : item));
      setMessage("Plugin settings saved.");
    } catch (err) {
      setError(err.message || "Could not save plugin settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestPlugin(plugin) {
    try {
      setSaving(true);
      setError(null);
      const result = await testAdminPlugin(plugin.id);
      setPluginTestResults((current) => ({ ...current, [plugin.id]: result }));
    } catch (err) {
      setPluginTestResults((current) => ({
        ...current,
        [plugin.id]: { ok: false, message: err.message || "Plugin unavailable" },
      }));
    } finally {
      setSaving(false);
    }
  }

  function handleManifestTextChange(value) {
    setAddPluginManifestText(value);
    setAddPluginError("");
    if (!value.trim()) {
      setAddPluginPreview(null);
      return;
    }
    try {
      const manifest = JSON.parse(value);
      setAddPluginPreview(manifest);
    } catch {
      setAddPluginPreview(null);
      setAddPluginError("The provided manifest.json is not valid JSON syntax.");
    }
  }

  async function handleInstallPlugin(event) {
    event.preventDefault();
    if (!addPluginPreview) {
      setAddPluginError("Provide a valid manifest.json before installing.");
      return;
    }
    try {
      setSaving(true);
      setAddPluginError("");
      const installed = await installAdminPlugin(addPluginPreview);
      setPlugins((current) => [...current, installed]);
      setMessage(`${installed.name} installed. It is disabled until you review its permissions and enable it.`);
      setAddPluginOpen(false);
      setAddPluginManifestText("");
      setAddPluginPreview(null);
    } catch (err) {
      setAddPluginError(err.message || "Could not install plugin.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUninstallPlugin(plugin) {
    try {
      setSaving(true);
      setError(null);
      await uninstallAdminPlugin(plugin.id);
      setPlugins((current) => current.filter((item) => item.id !== plugin.id));
      setPluginConfig((current) => (current?.id === plugin.id ? null : current));
      setMessage(`${plugin.name} uninstalled.`);
    } catch (err) {
      setError(err.message || "Could not uninstall plugin.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCleanupAcquisitions() {
    try {
      setSaving(true);
      setError(null);
      const res = await cleanupAdminAcquisitions();
      setMessage(`Cleanup completed: freed ${((res.bytesFreed || 0) / (1024 * 1024)).toFixed(2)} MB (${res.filesRemoved || 0} files removed).`);
      const updated = await getAdminAcquisitions();
      setAcquisitions(updated);
    } catch (err) {
      setError(err.message || "Failed to clean up temporary storage.");
    } finally {
      setSaving(false);
    }
  }

  async function handleScanAcquisitions() {
    try {
      setSaving(true);
      setError(null);
      await scanAdminAcquisitions();
      setMessage("Library scan triggered successfully.");
    } catch (err) {
      setError(err.message || "Failed to trigger library scan.");
    } finally {
      setSaving(false);
    }
  }


  if (loading) {
    return <div className="loading">Loading admin dashboard...</div>;
  }

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Admin Dashboard</h1>
          <div className="account-meta">Signed in as {session.username}</div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section">
        <h2>Overview</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>MusicDeck server</span>
            <strong>{health?.ok ? "Online" : "Unknown"}</strong>
          </div>
          <div className="admin-card">
            <span>Backend</span>
            <strong>{health?.backend || "Unknown"}</strong>
          </div>
          <div className="admin-card">
            <span>Users</span>
            <strong>{health?.counts?.users ?? users.length}</strong>
          </div>
          <div className="admin-card">
            <span>Database</span>
            <strong>{health?.database || "Unknown"}</strong>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Users</h2>

        <form className="admin-form" onSubmit={handleCreateUser}>
          <label>
            <span>Username</span>
            <input
              value={newUser.username}
              onChange={(event) => setNewUser({ ...newUser, username: event.target.value })}
              required
            />
          </label>
          <label>
            <span>Display name</span>
            <input
              value={newUser.displayName}
              onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={newUser.password}
              onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
              minLength={8}
              required
            />
          </label>
          <label>
            <span>Role</span>
            <select
              value={newUser.role}
              onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit" className="account-primary" disabled={saving}>
            Create user
          </button>
        </form>

        <div className="admin-table" role="table" aria-label="Users">
          {users.length === 0 ? (
            <div className="library-empty">No users found.</div>
          ) : users.map((user) => (
            <div className="admin-row" key={user.id} role="row">
              <div>
                <strong>{user.username}</strong>
                <span>{user.displayName}</span>
              </div>
              <select
                aria-label={`Role for ${user.username}`}
                value={user.role}
                onChange={(event) => handleUpdateUser(user.id, { role: event.target.value })}
                disabled={saving}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={!user.disabled}
                  onChange={(event) => handleUpdateUser(user.id, { disabled: !event.target.checked })}
                  disabled={saving}
                />
                <span>Enabled</span>
              </label>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(user.externalSearchEnabled)}
                  onChange={(event) => handleUpdateUser(user.id, { externalSearchEnabled: event.target.checked })}
                  disabled={saving}
                />
                <span>External search</span>
              </label>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(user.externalPlaybackEnabled)}
                  onChange={(event) => handleUpdateUser(user.id, { externalPlaybackEnabled: event.target.checked })}
                  disabled={saving}
                />
                <span>External playback</span>
              </label>
              <button
                type="button"
                className="admin-danger"
                disabled={saving || user.id === session.id}
                onClick={() => handleDeleteUser(user)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h2>Backend</h2>
        {backendConnections.length === 0 ? (
          <div className="library-empty">No backend connections configured.</div>
        ) : backendConnections.map((connection) => (
          <div className="admin-card" key={connection.id}>
            <span>{connection.name}</span>
            <strong>{connection.type}</strong>
            <small>{connection.enabled ? "Enabled" : "Disabled"}</small>
          </div>
        ))}
      </section>

      <section className="admin-section">
        <h2>Search providers</h2>
        <div className="admin-table" role="table" aria-label="Search providers">
          {searchProviders.map((provider) => (
            <div className="admin-row admin-provider-row" key={provider.id} role="row">
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.status === "error" ? "Search unavailable" : provider.status}</span>
              </div>
              <span className="admin-provider-kind">{provider.kind}</span>
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  disabled={saving}
                  onChange={(event) => handleSearchProviderUpdate(provider, { enabled: event.target.checked })}
                />
                <span>Enabled</span>
              </label>
              {provider.id === "itunes" && (
                <label className="admin-provider-config">
                  <span>Region</span>
                  <input
                    aria-label="External catalog region"
                    value={regionDraft !== null ? regionDraft : (provider.config?.country || "")}
                    placeholder="US"
                    disabled={saving}
                    onChange={(event) => setRegionDraft(event.target.value)}
                    onBlur={(event) => {
                      const country = event.target.value.trim().toUpperCase();
                      setRegionDraft(null);
                      if (country !== (provider.config?.country || "")) {
                        handleSearchProviderUpdate(provider, { config: { ...provider.config, country } });
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
        <h2>Playback sources</h2>
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
                  onChange={(event) => handleSourceProviderUpdate(provider, event.target.checked)}
                />
                <span>Enabled</span>
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-header">
          <h2>Plugins</h2>
          <button
            type="button"
            className="account-primary"
            onClick={() => setAddPluginOpen((open) => !open)}
          >
            + Add Plugin
          </button>
        </div>

        {addPluginOpen && (
          <form className="admin-form plugin-install-form" onSubmit={handleInstallPlugin}>
            <label>
              <span>manifest.json</span>
              <textarea
                rows={10}
                placeholder='{"manifestVersion": 1, "id": "com.example.music-plugin", ...}'
                value={addPluginManifestText}
                onChange={(event) => handleManifestTextChange(event.target.value)}
              />
            </label>

            {addPluginError && <div className="error" role="alert">{addPluginError}</div>}

            {addPluginPreview && !addPluginError && (
              <div className="plugin-install-preview">
                <strong>{addPluginPreview.name || addPluginPreview.id}</strong>
                <span>{addPluginPreview.version} · {addPluginPreview.author || "Unknown author"}</span>
                {addPluginPreview.description && <p>{addPluginPreview.description}</p>}

                <fieldset>
                  <legend>Requested capabilities</legend>
                  {(addPluginPreview.capabilities || []).map((capability) => (
                    <div key={capability}>{capability}</div>
                  ))}
                </fieldset>

                <fieldset>
                  <legend>Requested permissions</legend>
                  {(addPluginPreview.permissions || []).length === 0 ? (
                    <div>None requested.</div>
                  ) : (addPluginPreview.permissions || []).map((permission) => (
                    <label className="account-checkbox" key={permission}>
                      <input type="checkbox" checked readOnly />
                      <span>{permission}</span>
                    </label>
                  ))}
                </fieldset>

                <p className="hint">
                  This plugin will be installed disabled. Review and approve its permissions from the
                  plugin settings before enabling it.
                </p>
              </div>
            )}

            <div className="admin-actions">
              <button type="submit" className="account-primary" disabled={saving || !addPluginPreview}>
                Install plugin (disabled)
              </button>
              <button
                type="button"
                className="account-action"
                onClick={() => {
                  setAddPluginOpen(false);
                  setAddPluginManifestText("");
                  setAddPluginPreview(null);
                  setAddPluginError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="admin-table" role="table" aria-label="Plugins">
          {plugins.length === 0 ? (
            <div className="library-empty">No plugins registered.</div>
          ) : plugins.map((plugin) => (
            <div key={plugin.id}>
              <div className="admin-row admin-provider-row" role="row">
                <div>
                  <strong>{plugin.name}</strong>
                  <span>
                    {plugin.version} · {plugin.status} ·{" "}
                    {plugin.origin === "third-party" ? "Third-party" : "First-party"}
                  </span>
                  <span>{plugin.capabilities.join(", ")}</span>
                </div>
                <span className="admin-provider-kind">{plugin.permissions.length} permissions</span>
                <label className="account-checkbox">
                  <input
                    type="checkbox"
                    checked={plugin.enabled}
                    disabled={saving}
                    onChange={(event) => handlePluginUpdate(plugin, event.target.checked)}
                  />
                  <span>Enabled</span>
                </label>
                <button
                  type="button"
                  className="account-action"
                  aria-label={`${plugin.name} settings`}
                  onClick={() => openPluginSettings(plugin)}
                >
                  ⚙
                </button>
                {plugin.origin === "third-party" && (
                  <button
                    type="button"
                    className="account-action"
                    disabled={saving}
                    onClick={() => {
                      if (window.confirm(`This will remove ${plugin.name} and its configuration. Continue?`)) {
                        handleUninstallPlugin(plugin);
                      }
                    }}
                  >
                    Uninstall
                  </button>
                )}
              </div>


              {pluginTestResults[plugin.id] && (
                <div className={pluginTestResults[plugin.id].ok ? "success" : "error"} role="status">
                  {`${pluginTestResults[plugin.id].ok ? "✓" : "✕"} ${pluginTestResults[plugin.id].message || PLUGIN_STATUS_LABELS[pluginTestResults[plugin.id].status] || (pluginTestResults[plugin.id].ok ? "Connection successful" : "Connection failed")}`}
                </div>
              )}

              {pluginConfig?.id === plugin.id && (
                <form
                  className="admin-form plugin-settings"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSavePluginSettings(plugin);
                  }}
                >
                  {(plugin.configFields || []).map((field) => {
                    const isNoneAuth = (pluginConfig.values.authType || "none") === "none";
                    if (field.options && Array.isArray(field.options)) {
                      return (
                        <label key={field.key}>
                          <span>{field.label}</span>
                          <select
                            value={pluginConfig.values[field.key] || field.default || ""}
                            onChange={(event) => setPluginConfig((current) => ({
                              ...current,
                              values: { ...current.values, [field.key]: event.target.value },
                            }))}
                          >
                            {field.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </label>
                      );
                    }

                    if (typeof field.default === "boolean" || typeof pluginConfig.values[field.key] === "boolean" || /autoScan/i.test(field.key)) {
                      const isChecked = pluginConfig.values[field.key] !== undefined
                        ? Boolean(pluginConfig.values[field.key])
                        : field.default !== undefined ? Boolean(field.default) : true;
                      return (
                        <label className="account-checkbox" key={field.key}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(event) => setPluginConfig((current) => ({
                              ...current,
                              values: { ...current.values, [field.key]: event.target.checked },
                            }))}
                          />
                          <span>{field.label}</span>
                        </label>
                      );
                    }

                    return (
                      <label key={field.key}>
                        <span>
                          {field.label}
                          {field.key === "accessToken" && isNoneAuth ? " (No access token required for None authentication)" : ""}
                          {field.secret && plugin.config?.[field.key] === true ? " (configured — enter to replace, leave empty to keep)" : ""}
                        </span>
                        {field.type === "textarea" || (!field.secret && /url|json|list/i.test(field.key)) ? (
                          <textarea
                            rows={3}
                            value={pluginConfig.values[field.key] || ""}
                            autoComplete="off"
                            placeholder={field.secret && plugin.config?.[field.key] === true ? "Enter to replace, leave empty to keep" : ""}
                            onChange={(event) => setPluginConfig((current) => ({
                              ...current,
                              values: { ...current.values, [field.key]: event.target.value },
                            }))}
                          />
                        ) : (
                          <input
                            type={field.secret ? "password" : (typeof field.default === "number" || /maxConcurrent/i.test(field.key) ? "number" : "text")}
                            min={typeof field.default === "number" ? 1 : undefined}
                            max={typeof field.default === "number" ? 10 : undefined}
                            value={pluginConfig.values[field.key] !== undefined ? pluginConfig.values[field.key] : (field.default !== undefined ? field.default : "")}
                            autoComplete="off"
                            placeholder={field.key === "accessToken" && isNoneAuth ? "Optional" : ""}
                            onChange={(event) => setPluginConfig((current) => ({
                              ...current,
                              values: {
                                ...current.values,
                                [field.key]: typeof field.default === "number" || /maxConcurrent/i.test(field.key)
                                  ? Number(event.target.value)
                                  : event.target.value,
                              },
                            }))}
                          />
                        )}
                      </label>
                    );
                  })}

                  {plugin.permissions.length > 0 && (
                    <fieldset>
                      <legend>Permissions</legend>
                      {plugin.permissions.map((permission) => (
                        <label className="account-checkbox" key={permission}>
                          <input
                            type="checkbox"
                            checked={pluginConfig.permissions.includes(permission)}
                            onChange={(event) => setPluginConfig((current) => ({
                              ...current,
                              permissions: event.target.checked
                                ? [...current.permissions, permission]
                                : current.permissions.filter((item) => item !== permission),
                            }))}
                          />
                          <span>{permission}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  <div className="admin-actions">
                    <button type="submit" className="account-primary" disabled={saving}>
                      Save plugin settings
                    </button>
                    <button
                      type="button"
                      className="account-action"
                      disabled={saving}
                      onClick={() => handleTestPlugin(plugin)}
                    >
                      Test connection
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2>On-Demand Library</h2>
            <div className="account-meta" style={{ marginTop: 4 }}>
              Music Library: <code>{acquisitions?.musicRoot || acquisitions?.downloadDirectory || "./data/music"}</code>
            </div>
          </div>
          <div className="admin-actions">
            <button
              type="button"
              className="account-action"
              disabled={saving}
              onClick={handleScanAcquisitions}
            >
              Scan Library
            </button>
            <button
              type="button"
              className="account-action"
              disabled={saving}
              onClick={handleCleanupAcquisitions}
            >
              Clean Temp Files
            </button>
          </div>
        </div>

        {acquisitions ? (
          <div className="admin-acquisition-stats">
            <div className="admin-card">
              <span>Active Downloads</span>
              <strong>{acquisitions.activeJobs}</strong>
              <small>{acquisitions.queuedJobs} queued</small>
            </div>
            <div className="admin-card">
              <span>Completed Acquisitions</span>
              <strong>{acquisitions.completedJobs}</strong>
              <small>{acquisitions.failedJobs} failed</small>
            </div>
            <div className="admin-card">
              <span>Storage Used</span>
              <strong>{(acquisitions.storageUsedBytes / (1024 * 1024)).toFixed(1)} MB</strong>
              <small>Temp: {(acquisitions.tempStorageUsedBytes / (1024 * 1024)).toFixed(1)} MB</small>
            </div>
            <div className="admin-card">
              <span>Concurrency</span>
              <strong>{acquisitions.maxConcurrentDownloads} max</strong>
              <small>{acquisitions.autoScanLibrary ? "Auto-scan enabled" : "Manual scan"}</small>
            </div>
          </div>
        ) : (
          <div className="library-empty">On-demand library acquisition is ready.</div>
        )}

        {downloaders.length > 0 && (
          <div className="admin-table" role="table" aria-label="Downloader Adapters" style={{ marginTop: 16 }}>
            {downloaders.map((downloader) => (
              <div className="admin-row" key={downloader.id} role="row">
                <div>
                  <strong>{downloader.name}</strong>
                  <span>
                    {downloader.diagnostics?.spotdlVersion
                      ? `spotDL ${downloader.diagnostics.spotdlVersion}`
                      : "spotDL"}
                    {downloader.diagnostics?.ffmpegVersion ? ` · FFmpeg ${downloader.diagnostics.ffmpegVersion}` : ""}
                  </span>
                </div>
                <span className={`admin-job-status status-${downloader.available ? "completed" : "failed"}`}>
                  {downloader.available ? "Available" : "Not detected"}
                </span>
                <small>
                  {downloader.diagnostics?.ffmpegAvailable === false
                    ? "FFmpeg missing"
                    : downloader.error || ""}
                </small>
              </div>
            ))}
          </div>
        )}

        {acquisitions?.recentJobs && acquisitions.recentJobs.length > 0 && (
          <div className="admin-table" role="table" aria-label="Recent Acquisitions">
            {acquisitions.recentJobs.slice(0, 10).map((job) => (
              <div className="admin-row" key={job.id} role="row">
                <div>
                  <strong>{job.requestedTrackId || job.requestedAlbumId || job.id}</strong>
                  <span>{job.sourceProvider || "auto-discovered"}</span>
                </div>
                <span className={`admin-job-status status-${job.status}`}>
                  {job.status}
                  {job.progress?.percent !== undefined && job.status === "downloading" && ` (${job.progress.percent}%)`}
                </span>
                <small>{new Date(job.createdAt).toLocaleTimeString()}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Server settings</h2>
        <form className="admin-form" onSubmit={handleSaveServerSettings}>
          <label>
            <span>Library scan schedule</span>
            <input
              value={scanSchedule}
              onChange={(event) => setScanSchedule(event.target.value)}
              placeholder="Not scheduled"
            />
          </label>
          <label>
            <span>Job concurrency</span>
            <input
              type="number"
              min="1"
              max="8"
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(event.target.value)}
            />
          </label>
          {serverSettings.length === 0 && (
            <div className="library-empty">No server settings saved yet.</div>
          )}
          <button type="submit" className="account-primary" disabled={saving}>
            Save server settings
          </button>
        </form>
      </section>
    </div>
  );
}


export default Admin;
