import { useCallback, useEffect, useRef, useState } from "react";
import { discoverExtensions, getExtensions, setExtensionEnabled, type ExtensionInventory, type ServerExtension } from "../../api/extensions";
import "../../styles/extension-settings.css";

export default function ExtensionSettings() {
  const [inventory, setInventory] = useState<ExtensionInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const operation = useRef(false);
  const version = useRef(0);
  const report = useCallback((failure: unknown) => {
    console.error("Could not manage server extensions:", failure);
    if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not manage server extensions");
  }, []);
  const load = useCallback(async (scan = false) => {
    const current = ++version.current;
    if (mounted.current) { setLoading(true); setError(""); }
    try {
      const data = await (scan ? discoverExtensions() : getExtensions());
      if (mounted.current && version.current === current) setInventory(data);
    } catch (failure) { if (version.current === current) report(failure); }
    finally { if (mounted.current && version.current === current) setLoading(false); }
  }, [report]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  const toggle = async (item: ServerExtension, enabled: boolean) => {
    if (operation.current) return;
    if (enabled && !window.confirm(`Enable ${item.name}? This runs trusted server code with the MusicDeck process's privileges. Only enable code you have reviewed.`)) return;
    operation.current = true; setBusy(item.id); setError(""); setMessage("");
    try {
      const updated = await setExtensionEnabled(item.id, enabled);
      if (mounted.current) {
        setInventory((current) => current ? { ...current, extensions: current.extensions.map((entry) => entry.id === item.id ? updated : entry) } : current);
        setMessage(`${item.name} ${enabled ? "enabled" : "disabled"}. No container restart required.`);
      }
    } catch (failure) {
      report(failure);
      // Activation can roll back into an error state; reload it rather than leaving a success-shaped toggle.
      try {
        const current = await getExtensions();
        if (mounted.current) setInventory(current);
      } catch (refreshError) { report(refreshError); }
    } finally {
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  };
  const locked = loading || Boolean(busy);
  return <section className="admin-section extension-settings" aria-labelledby="extension-settings-title">
    <div className="extension-heading"><div>
      <p className="extension-eyebrow">OPTIONAL SERVER CAPABILITIES / API V1</p>
      <h2 id="extension-settings-title">Server extensions</h2>
    </div><span className="extension-count">{inventory ? `${inventory.extensions.filter((item) => item.enabled).length} / ${inventory.extensions.length} active` : "Inventory"}</span></div>
    <p className="extension-trust">Trusted code only. Unlike catalog plugin manifests, these modules execute on your server.
      Install reviewed files in the configured extensions directory, then scan. Modules are disabled until an administrator enables them.</p>
    <div className="admin-actions">
      <button type="button" className="account-action" disabled={locked} onClick={() => { void load(); }}>Refresh status</button>
      <button type="button" className="account-action" disabled={locked} onClick={() => { void load(true); }}>Scan extensions</button>
    </div>
    {loading && <p role="status">Loading server extensions...</p>}
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="success" role="status">{message}</div>}
    {inventory && inventory.issues.length > 0 && <div className="extension-issues" role="alert">
      <strong>Installation needs attention</strong><ul>{inventory.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>
    </div>}
    {inventory && !inventory.extensions.length && <p className="extension-empty">No server extensions installed.
      Core playback and library features do not require an extension.</p>}
    {inventory && inventory.extensions.length > 0 && <ul className="extension-list" aria-label="Installed server extensions">
      {inventory.extensions.map((item) => <li key={item.id} className={`extension-card extension-card--${item.status}`}>
        <div className="extension-mark" aria-hidden="true">{item.name.slice(0, 2).toUpperCase()}</div>
        <div className="extension-detail"><h3>{item.name} <span>{item.version}</span></h3>
          <code>{item.id}</code><p>{item.description || "Optional administrator capability"}</p>
          {item.error && <p className="error" role="alert">{item.error}</p>}
        </div>
        <div className="extension-control"><span className="extension-state">{busy === item.id ? "Applying..." : item.status}</span>
          <label className="account-checkbox"><input type="checkbox" aria-label={`Enable server extension ${item.name}`}
            checked={item.enabled} disabled={locked || item.status === "starting" || item.status === "stopping" || item.status === "error"}
            onChange={(event) => { void toggle(item, event.target.checked); }} /><span>Enabled</span></label>
          {item.status === "error" && <button type="button" className="account-action" disabled={locked}
            onClick={() => { void toggle(item, false); }}>Finish cleanup</button>}
        </div>
      </li>)}
    </ul>}
    {busy && <p role="status">Applying lifecycle change. Disabling stops new work and waits for cooperative tasks and resource cleanup.</p>}
    <p className="hint">New installations can be scanned without restarting. Replacing already discovered code requires a server restart.
      Uncooperative extensions cannot be forcibly unloaded safely; disable them and inspect server logs.</p>
  </section>;
}
