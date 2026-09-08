import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  getAdminPlugins,
  testAdminPlugin,
  uninstallAdminPlugin,
  updateAdminPlugin,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";


const PLUGIN_STATUS_LABELS = {
  success: "Connected",
  not_configured: "Not configured",
  authentication_failed: "Authentication failed",
  provider_unavailable: "Provider unavailable",
  timeout: "Timed out",
  permission_denied: "Permission denied",
  plugin_error: "Plugin error",
};


function AdminPluginDetail() {
  const { pluginId } = useParams();
  const navigate = useNavigate();

  const { data, setData, loading, saving, error, message, run } = useAdminData({
    plugins: getAdminPlugins,
  });

  const [testResult, setTestResult] = useState(null);
  const [configValues, setConfigValues] = useState(null);
  const [approvedPermissions, setApprovedPermissions] = useState(null);

  const plugin = useMemo(
    () => (data.plugins || []).find((item) => item.id === pluginId) || null,
    [data.plugins, pluginId]
  );

  if (loading) {
    return <div className="loading">Loading plugin...</div>;
  }

  if (!plugin) {
    return (
      <div className="admin-page">
        <div className="account-header">
          <div>
            <div className="account-label">ADMIN · PLUGINS</div>
            <h1>Plugin not found</h1>
          </div>
        </div>
        <div className="library-empty">
          No plugin with id <code>{pluginId}</code> is installed.{" "}
          <Link to="/admin/plugins">Back to plugins</Link>
        </div>
      </div>
    );
  }

  // Lazily initialise the editable config once the plugin has loaded.
  const values =
    configValues ??
    Object.fromEntries(
      (plugin.configFields || []).map((field) => [
        field.key,
        field.secret ? "" : String(plugin.config?.[field.key] ?? ""),
      ])
    );
  const permissions = approvedPermissions ?? plugin.approvedPermissions ?? [];

  function replacePlugin(updated) {
    setData((current) => ({
      ...current,
      plugins: current.plugins.map((item) =>
        item.id === updated.id ? updated : item
      ),
    }));
  }

  async function handleSaveConfig() {
    const config = {};
    for (const field of plugin.configFields || []) {
      const value = values[field.key];
      if (field.secret && !value) {
        // Empty secret field keeps the existing stored value.
        if (plugin.config?.[field.key] === true) continue;
        config[field.key] = "";
      } else {
        config[field.key] = value;
      }
    }

    const updated = await run(
      () =>
        updateAdminPlugin(plugin.id, {
          enabled: plugin.enabled,
          config,
          permissions,
        }),
      {
        successMessage: "Plugin settings saved.",
        errorMessage: "Could not save plugin settings.",
      }
    );

    if (updated) {
      replacePlugin(updated);
      setConfigValues(null);
      setApprovedPermissions(null);
    }
  }

  async function handleToggleEnabled(enabled) {
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
      replacePlugin(updated);
    }
  }

  async function handleTest() {
    setTestResult(null);

    const result = await run(() => testAdminPlugin(plugin.id), {
      errorMessage: "Plugin unavailable.",
    });

    setTestResult(
      result || { ok: false, message: "Plugin unavailable" }
    );
  }

  async function handleUninstall() {
    if (
      !window.confirm(
        `This will remove ${plugin.name} and its configuration. Continue?`
      )
    ) {
      return;
    }

    const result = await run(() => uninstallAdminPlugin(plugin.id), {
      successMessage: `${plugin.name} uninstalled.`,
      errorMessage: "Could not uninstall plugin.",
    });

    if (result !== undefined) {
      navigate("/admin/plugins");
    }
  }

  const isNoneAuth = (values.authType || "none") === "none";

  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">
            <Link to="/admin/plugins">ADMIN · PLUGINS</Link>
          </div>
          <h1>{plugin.name}</h1>
          <div className="account-meta">
            v{plugin.version}
            {plugin.author ? ` · ${plugin.author}` : ""} ·{" "}
            {plugin.origin === "third-party" ? "Third-party" : "First-party"}
          </div>
        </div>
        <span
          className={`admin-job-status status-${
            plugin.enabled ? "completed" : "failed"
          }`}
        >
          {plugin.enabled ? "● Enabled" : "○ Disabled"}
        </span>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      {plugin.description && (
        <section className="admin-section">
          <p>{plugin.description}</p>
        </section>
      )}

      <section className="admin-section">
        <h2>Status</h2>
        <div className="admin-grid">
          <div className="admin-card">
            <span>State</span>
            <strong>{plugin.enabled ? "Enabled" : "Disabled"}</strong>
          </div>
          <div className="admin-card">
            <span>Connection</span>
            <strong>{plugin.status || "unknown"}</strong>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <h2>Capabilities</h2>
        {(plugin.capabilities || []).length === 0 ? (
          <div className="library-empty">This plugin declares no capabilities.</div>
        ) : (
          <div className="admin-tag-list">
            {plugin.capabilities.map((capability) => (
              <span className="admin-tag" key={capability}>
                {capability}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Permissions</h2>
        {(plugin.permissions || []).length === 0 ? (
          <div className="library-empty">This plugin requests no permissions.</div>
        ) : (
          <div className="admin-detail-grid">
            {plugin.permissions.map((permission) => (
              <label className="account-checkbox" key={permission}>
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  disabled={saving}
                  onChange={(event) =>
                    setApprovedPermissions(
                      event.target.checked
                        ? [...permissions, permission]
                        : permissions.filter((item) => item !== permission)
                    )
                  }
                />
                <span>{permission}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Configuration</h2>
        {(plugin.configFields || []).length === 0 ? (
          <div className="library-empty">
            This plugin has no configuration fields.
          </div>
        ) : (
          <form
            className="admin-form plugin-settings"
            onSubmit={(event) => {
              event.preventDefault();
              handleSaveConfig();
            }}
          >
            {(plugin.configFields || []).map((field) => {
              if (field.options && Array.isArray(field.options)) {
                return (
                  <label key={field.key}>
                    <span>{field.label}</span>
                    <select
                      value={values[field.key] || field.default || ""}
                      onChange={(event) =>
                        setConfigValues({
                          ...values,
                          [field.key]: event.target.value,
                        })
                      }
                    >
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }

              if (
                typeof field.default === "boolean" ||
                typeof values[field.key] === "boolean" ||
                /autoScan/i.test(field.key)
              ) {
                const isChecked =
                  values[field.key] !== undefined
                    ? Boolean(values[field.key])
                    : field.default !== undefined
                      ? Boolean(field.default)
                      : true;
                return (
                  <label className="account-checkbox" key={field.key}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(event) =>
                        setConfigValues({
                          ...values,
                          [field.key]: event.target.checked,
                        })
                      }
                    />
                    <span>{field.label}</span>
                  </label>
                );
              }

              return (
                <label key={field.key}>
                  <span>
                    {field.label}
                    {field.key === "accessToken" && isNoneAuth
                      ? " (No access token required for None authentication)"
                      : ""}
                    {field.secret && plugin.config?.[field.key] === true
                      ? " (configured — enter to replace, leave empty to keep)"
                      : ""}
                  </span>
                  {field.type === "textarea" ||
                  (!field.secret && /url|json|list/i.test(field.key)) ? (
                    <textarea
                      rows={3}
                      value={values[field.key] || ""}
                      autoComplete="off"
                      placeholder={
                        field.secret && plugin.config?.[field.key] === true
                          ? "Enter to replace, leave empty to keep"
                          : ""
                      }
                      onChange={(event) =>
                        setConfigValues({
                          ...values,
                          [field.key]: event.target.value,
                        })
                      }
                    />
                  ) : (
                    <input
                      type={
                        field.secret
                          ? "password"
                          : typeof field.default === "number" ||
                              /maxConcurrent/i.test(field.key)
                            ? "number"
                            : "text"
                      }
                      min={typeof field.default === "number" ? 1 : undefined}
                      max={typeof field.default === "number" ? 10 : undefined}
                      value={
                        values[field.key] !== undefined
                          ? values[field.key]
                          : field.default !== undefined
                            ? field.default
                            : ""
                      }
                      autoComplete="off"
                      placeholder={
                        field.key === "accessToken" && isNoneAuth
                          ? "Optional"
                          : ""
                      }
                      onChange={(event) =>
                        setConfigValues({
                          ...values,
                          [field.key]:
                            typeof field.default === "number" ||
                            /maxConcurrent/i.test(field.key)
                              ? Number(event.target.value)
                              : event.target.value,
                        })
                      }
                    />
                  )}
                </label>
              );
            })}

            <div className="admin-actions">
              <button type="submit" className="account-primary" disabled={saving}>
                Save plugin settings
              </button>
              <button
                type="button"
                className="account-action"
                disabled={saving}
                onClick={handleTest}
              >
                Test
              </button>
            </div>
          </form>
        )}

        {testResult && (
          <div className={testResult.ok ? "success" : "error"} role="status">
            {`${testResult.ok ? "✓" : "✕"} ${
              testResult.message ||
              PLUGIN_STATUS_LABELS[testResult.status] ||
              (testResult.ok ? "Connection successful" : "Connection failed")
            }`}
          </div>
        )}
      </section>

      <section className="admin-section admin-danger-zone">
        <h2>Danger zone</h2>
        <div className="admin-actions">
          {plugin.enabled ? (
            <button
              type="button"
              className="account-action"
              disabled={saving}
              onClick={() => handleToggleEnabled(false)}
            >
              Disable
            </button>
          ) : (
            <button
              type="button"
              className="account-primary"
              disabled={saving}
              onClick={() => handleToggleEnabled(true)}
            >
              Enable
            </button>
          )}

          {plugin.origin === "third-party" && (
            <button
              type="button"
              className="admin-danger"
              disabled={saving}
              onClick={handleUninstall}
            >
              Remove plugin
            </button>
          )}
        </div>
      </section>
    </div>
  );
}


export default AdminPluginDetail;
