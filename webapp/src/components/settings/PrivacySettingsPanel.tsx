import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { usePrivacy } from "../../context/PrivacyContext";
import type { PrivacySettings } from "../../api/privacy";
import "../../styles/privacy.css";

const controls: { key: keyof PrivacySettings; label: string; description: string }[] = [
  { key: "localOnly", label: "Enable Local-Only Mode", description: "Block every managed third-party connection. Your configured library servers remain available." },
  { key: "allowMetadata", label: "Allow Deezer/iTunes Metadata Lookups", description: "Permit external discovery, previews, biographies and supplemental metadata." },
  { key: "allowImports", label: "Allow spotDL Spotify Imports", description: "Permit Spotify lookups and downloader connections, including YouTube and SoundCloud." },
  { key: "allowArtwork", label: "Allow External Cover Art Fetching", description: "Permit third-party covers and artist portraits. Library-provided artwork stays available." },
];
export default function PrivacySettingsPanel() {
  const { policy, error, busy, save, refresh } = usePrivacy();
  const admin = useAuth()?.session?.role === "admin";
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  const active = Boolean(policy?.localOnly || policy?.enforcedByEnvironment);
  const change = async (key: keyof PrivacySettings, enabled: boolean) => {
    if (!policy) return;
    setFailure(""); setMessage("");
    try {
      await save({ localOnly: policy.localOnly, allowMetadata: policy.allowMetadata, allowImports: policy.allowImports,
        allowArtwork: policy.allowArtwork, [key]: enabled });
      setMessage("Server privacy policy saved. All clients synchronize automatically.");
    } catch (problem) {
      console.error("Could not save privacy policy:", problem);
      setFailure(problem instanceof Error ? problem.message : "Could not save privacy policy.");
    }
  };
  return <section className="settings-section privacy-panel" aria-labelledby="privacy-title">
    <div className="settings-section-heading"><span aria-hidden="true">NET</span><h2 id="privacy-title">Privacy &amp; External Integrations</h2></div>
    <div className={`privacy-status${active ? " is-local" : ""}`}>
      <span className="privacy-status-light" aria-hidden="true" /><div><strong>{active ? "LOCAL LIBRARY / EXTERNAL OFFLINE" : "EXTERNAL INTEGRATIONS / CONTROLLED"}</strong>
        <p>Global server policy. Only administrators can change these controls.</p></div>
    </div>
    {policy?.enforcedByEnvironment && <p role="status">LOCAL_ONLY_MODE is enforced by the server environment and cannot be disabled here.</p>}
    {!admin && <p>Ask your server administrator to change the privacy policy.</p>}
    {!policy && <p role="status">{error || "Loading privacy policy..."} <button type="button" onClick={refresh}>Refresh policy</button></p>}
    {policy && controls.map(({ key, label, description }) => <article className="settings-row" key={key}>
      <div className="settings-row-copy"><h3>{label}</h3><p>{description}</p></div>
      <label className="settings-switch"><input type="checkbox" aria-label={label} checked={key === "localOnly" ? active : policy[key]}
        disabled={!admin || busy || Boolean(error) || policy.enforcedByEnvironment || (key !== "localOnly" && active)}
        onChange={(event) => { void change(key, event.target.checked); }} /><span aria-hidden="true" /></label>
    </article>)}
    <p className="privacy-footnote">Enabling a restriction aborts managed network transfers and stops affected spotDL workers. Imports require metadata and artwork permissions because spotDL manages its own nested connections. Disabling Local-Only restores your individual permissions. This is application policy, not an OS firewall.</p>
    {busy && <p role="status">Applying server policy...</p>}
    {message && <p role="status">{message}</p>}
    {failure && <p role="alert">{failure}</p>}
  </section>;
}
