import { useEffect, useState } from "react";

import {
  getPlugins,
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";


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


function Settings() {
  const [settings, setSettings] = useState([]);
  const [compactLists, setCompactLists] = useState(false);
  const [defaultVolume, setDefaultVolume] = useState(1);
  const [sourceMode, setSourceMode] = useState("hybrid");
  const [sourcePreference, setSourcePreference] = useState("manual");
  const [acquisitionEnabled, setAcquisitionEnabled] = useState(true);
  const [acquisitionProvider, setAcquisitionProvider] = useState("auto");
  const [autoScanLibrary, setAutoScanLibrary] = useState(true);
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");


  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        setLoading(true);
        setError(null);

        const data = await getUserSettings();
        const pluginData = await Promise.resolve(getPlugins()).catch(() => []);

        if (!cancelled) {
          setSettings(data);
          setPlugins(pluginData || []);
          setCompactLists(Boolean(getSetting(data, "ui.compactLists", false)));
          setDefaultVolume(Number(getSetting(data, "playback.defaultVolume", 1)));
          setSourceMode(getSetting(data, "catalog.sourceMode", "hybrid"));
          setSourcePreference(getSetting(data, "playback.sourcePreference", "manual"));
          setAcquisitionEnabled(Boolean(getSetting(data, "acquisition.enabled", true)));
          setAcquisitionProvider(getSetting(data, "acquisition.provider", "auto"));
          setAutoScanLibrary(Boolean(getSetting(data, "acquisition.autoScan", true)));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load settings.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);


  async function handleSubmit(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("");
      setError(null);

      const data = await updateUserSettings({
        "ui.compactLists": compactLists,
        "playback.defaultVolume": Number(defaultVolume),
        "catalog.sourceMode": sourceMode,
        "playback.sourcePreference": sourcePreference,
        "acquisition.enabled": acquisitionEnabled,
        "acquisition.provider": acquisitionProvider,
        "acquisition.autoScan": autoScanLibrary,
      });

      setSettings(data);
      setMessage("Settings saved.");
    } catch (err) {
      setError(err.message || "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }


  if (loading) {
    return <div className="loading">Loading settings...</div>;
  }

  return (
    <div className="account-page">
      <div className="account-header">
        <div>
          <div className="account-label">SETTINGS</div>
          <h1>Settings</h1>
          <div className="account-meta">User preferences</div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <form className="account-form" onSubmit={handleSubmit}>
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={compactLists}
            onChange={(event) => setCompactLists(event.target.checked)}
          />
          <span>Use compact library lists</span>
        </label>

        <label>
          <span>Default playback volume</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={defaultVolume}
            onChange={(event) => setDefaultVolume(event.target.value)}
          />
        </label>

        <label>
          <span>Catalog mode</span>
          <select
            value={sourceMode}
            onChange={(event) => setSourceMode(event.target.value)}
          >
            <option value="library">Library</option>
            <option value="hybrid">Hybrid</option>
            <option value="external">External</option>
          </select>
        </label>

        <label>
          <span>When more than one source is available</span>
          <select
            value={sourcePreference}
            onChange={(event) => setSourcePreference(event.target.value)}
          >
            <option value="manual">Ask me</option>
            <option value="library">Prefer library</option>
            <option value="external">Prefer external</option>
            <option value="best">Best available</option>
            <option value="lossless">Lossless preferred</option>
            <option value="highest-bitrate">Highest bitrate</option>
          </select>
        </label>

        <fieldset>
          <legend>On-Demand Downloads</legend>
          <label className="account-checkbox">
            <input
              type="checkbox"
              checked={acquisitionEnabled}
              onChange={(event) => setAcquisitionEnabled(event.target.checked)}
            />
            <span>Allow downloads to library</span>
          </label>

          <label>
            <span>Preferred acquisition provider</span>
            <select
              value={acquisitionProvider}
              onChange={(event) => setAcquisitionProvider(event.target.value)}
              disabled={!acquisitionEnabled}
            >
              <option value="auto">Auto / Best Available</option>
              <option value="authorized-http-acquisition">Authorized HTTP Acquisition</option>
            </select>
          </label>

          <label className="account-checkbox">
            <input
              type="checkbox"
              checked={autoScanLibrary}
              onChange={(event) => setAutoScanLibrary(event.target.checked)}
              disabled={!acquisitionEnabled}
            />
            <span>Auto-scan library after import</span>
          </label>
        </fieldset>

        {settings.length === 0 && (
          <div className="library-empty">
            No saved settings yet.
          </div>
        )}

        {message && <div className="success">{message}</div>}

        <button type="submit" className="account-primary" disabled={saving}>
          {saving ? "Saving..." : "Save settings"}
        </button>
      </form>

      <section className="admin-section" aria-labelledby="plugin-settings-title">
        <h2 id="plugin-settings-title">Plugins</h2>
        <div className="admin-table" role="table" aria-label="Plugin settings">
          {plugins.length === 0 ? (
            <div className="library-empty">No plugins available.</div>
          ) : plugins.map((plugin) => (
            <div className="admin-row admin-provider-row" key={plugin.id} role="row">
              <div>
                <strong>{plugin.name}</strong>
                <span>{plugin.version} · {plugin.status}</span>
                <span>{plugin.capabilities.join(", ")}</span>
                {(plugin.configFields || []).length > 0 && (
                  <span>
                    {plugin.configFields
                      .filter((field) => field.required || field.secret)
                      .map((field) => `${field.label}: ${field.configured ? "Configured" : "Not configured"}`)
                      .join(" · ")}
                  </span>
                )}
              </div>
              <span className="admin-provider-kind">
                {plugin.enabled ? "Enabled by administrator" : "Disabled"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}


export default Settings;
