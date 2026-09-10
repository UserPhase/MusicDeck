import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  getAdminPlugins,
  installAdminPlugin,
  updateAdminPlugin,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminBadge, AdminPageHeader } from "../../components/admin/ui";


function AdminPlugins() {
  const navigate = useNavigate();

  const { data, setData, loading, saving, error, message, run } = useAdminData({
    plugins: getAdminPlugins,
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [manifestText, setManifestText] = useState("");
  const [manifestPreview, setManifestPreview] = useState(null);
  const [manifestError, setManifestError] = useState("");

  const plugins = useMemo(() => data.plugins || [], [data.plugins]);

  const visiblePlugins = useMemo(() => {
    const query = search.trim().toLowerCase();

    return plugins.filter((plugin) => {
      if (statusFilter === "enabled" && !plugin.enabled) {
        return false;
      }
      if (statusFilter === "disabled" && plugin.enabled) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        plugin.name.toLowerCase().includes(query) ||
        plugin.id.toLowerCase().includes(query) ||
        (plugin.capabilities || []).join(" ").toLowerCase().includes(query)
      );
    });
  }, [plugins, search, statusFilter]);

  async function handleTogglePlugin(plugin, enabled) {
    const updated = await run(
      () =>
        updateAdminPlugin(plugin.id, {
          enabled,
          permissions: enabled
            ? plugin.permissions || []
            : plugin.approvedPermissions || [],
        }),
      {
        successMessage: `${plugin.name} ${enabled ? "enabled" : "disabled"}.`,
        errorMessage: "Could not update plugin.",
      }
    );

    if (updated) {
      setData((current) => ({
        ...current,
        plugins: current.plugins.map((item) =>
          item.id === plugin.id ? updated : item
        ),
      }));
    }
  }

  function handleManifestTextChange(value) {
    setManifestText(value);
    setManifestError("");

    if (!value.trim()) {
      setManifestPreview(null);
      return;
    }

    try {
      setManifestPreview(JSON.parse(value));
    } catch {
      setManifestPreview(null);
      setManifestError("The provided manifest.json is not valid JSON syntax.");
    }
  }

  async function handleInstallPlugin(event) {
    event.preventDefault();

    if (!manifestPreview) {
      setManifestError("Provide a valid manifest.json before installing.");
      return;
    }

    const installed = await run(() => installAdminPlugin(manifestPreview), {
      successMessage: (plugin) =>
        `${plugin.name} installed. It is disabled until you review its permissions and enable it.`,
      errorMessage: "Could not install plugin.",
    });

    if (installed) {
      setData((current) => ({
        ...current,
        plugins: [...current.plugins, installed],
      }));
      setAddOpen(false);
      setManifestText("");
      setManifestPreview(null);
    }
  }

  if (loading) {
    return <div className="loading">Loading plugins...</div>;
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Plugins"
        meta={`${plugins.filter((plugin) => plugin.enabled).length} of ${plugins.length} enabled`}
        actions={
          <button
            type="button"
            className="account-primary"
            onClick={() => setAddOpen((open) => !open)}
          >
            + Add Plugin
          </button>
        }
      />

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      {addOpen && (
        <section className="admin-section">
          <h2>Add plugin</h2>
          <form className="admin-form plugin-install-form" onSubmit={handleInstallPlugin}>
            <label>
              <span>manifest.json</span>
              <textarea
                rows={10}
                placeholder='{"manifestVersion": 1, "id": "com.example.music-plugin", ...}'
                value={manifestText}
                onChange={(event) => handleManifestTextChange(event.target.value)}
              />
            </label>

            {manifestError && (
              <div className="error" role="alert">
                {manifestError}
              </div>
            )}

            {manifestPreview && !manifestError && (
              <div className="plugin-install-preview">
                <strong>{manifestPreview.name || manifestPreview.id}</strong>
                <span>
                  {manifestPreview.version} ·{" "}
                  {manifestPreview.author || "Unknown author"}
                </span>
                {manifestPreview.description && <p>{manifestPreview.description}</p>}

                <fieldset>
                  <legend>Requested capabilities</legend>
                  {(manifestPreview.capabilities || []).map((capability) => (
                    <div key={capability}>{capability}</div>
                  ))}
                </fieldset>

                <fieldset>
                  <legend>Requested permissions</legend>
                  {(manifestPreview.permissions || []).length === 0 ? (
                    <div>None requested.</div>
                  ) : (
                    (manifestPreview.permissions || []).map((permission) => (
                      <label className="account-checkbox" key={permission}>
                        <input type="checkbox" checked readOnly />
                        <span>{permission}</span>
                      </label>
                    ))
                  )}
                </fieldset>

                <p className="hint">
                  This plugin will be installed disabled. Review and approve its
                  permissions from the plugin detail page before enabling it.
                </p>
              </div>
            )}

            <div className="admin-actions">
              <button
                type="submit"
                className="account-primary"
                disabled={saving || !manifestPreview}
              >
                Install plugin (disabled)
              </button>
              <button
                type="button"
                className="account-action"
                onClick={() => {
                  setAddOpen(false);
                  setManifestText("");
                  setManifestPreview(null);
                  setManifestError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="admin-section">
        <div className="admin-toolbar">
          <input
            type="search"
            className="admin-search"
            placeholder="Search plugins..."
            aria-label="Search plugins"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter plugins"
            className="admin-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All plugins</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="admin-table admin-plugins-table" role="table" aria-label="Plugins">
          <div className="admin-row admin-row-head" role="row">
            <span>Plugin</span>
            <span>Version</span>
            <span>Description</span>
            <span>Status</span>
          </div>

          {visiblePlugins.length === 0 ? (
            <div className="library-empty">No plugins match this filter.</div>
          ) : (
            visiblePlugins.map((plugin) => (
              <div className="admin-row admin-provider-row" key={plugin.id} role="row">
                <button
                  type="button"
                  className="admin-row-main admin-plugin-link"
                  onClick={() => navigate(`/admin/plugins/${plugin.id}`)}
                  aria-label={`Open ${plugin.name}`}
                >
                  <strong>{plugin.name}</strong>
                </button>
                <span className="admin-provider-kind">{plugin.version}</span>
                <span className="admin-plugin-description">
                  {plugin.description || (plugin.capabilities || []).join(", ") || "No description"}
                </span>
                <label className="admin-plugin-status">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${plugin.name}`}
                    checked={plugin.enabled}
                    disabled={saving}
                    onChange={(event) => handleTogglePlugin(plugin, event.target.checked)}
                  />
                  <AdminBadge
                    active={plugin.enabled}
                    activeLabel="Enabled · On"
                    inactiveLabel="Disabled · Off"
                  />
                </label>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}


export default AdminPlugins;
