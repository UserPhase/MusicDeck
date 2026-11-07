import { useCallback, useEffect, useRef, useState } from "react";
import { getVisualActivity, startVisualPolling } from "../../services/visualActivity";
import { useAuth } from "../../context/AuthContext";
import { usePrivacy } from "../../context/PrivacyContext";
import { useOnlineStatus } from "../OfflineStatusBanner";
import { beginLastFmAuthorization, connectScrobble, getScrobbleConnections, scrobbleAction,
  type ScrobbleConnection, type ScrobbleProvider } from "../../api/scrobble";
import "../../styles/scrobble-settings.css";

const names = { lastfm: "Last.fm", listenbrainz: "ListenBrainz" };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "None yet";
const labels: Record<string, string> = { connected: "Connected", disconnected: "Not connected", paused: "Paused",
  "auth-error": "Reconnect needed", "configuration-error": "Configuration needed", error: "Needs attention" };
export default function ScrobbleSettingsPanel() {
  const owner = useAuth()?.session?.id ?? null;
  const { policy } = usePrivacy();
  const online = useOnlineStatus();
  // Remount private fields on account changes; an old account's credentials never survive a switch.
  return <ScrobbleAccountPanel key={owner || "signed-out"} owner={owner} privacyAllowed={Boolean(policy?.effective.external)} online={online} />;
}
function ScrobbleAccountPanel({ owner, privacyAllowed, online }: { owner: string | null; privacyAllowed: boolean; online: boolean }) {
  const [connections, setConnections] = useState<ScrobbleConnection[]>([]);
  const [credentials, setCredentials] = useState({ lastfm: "", listenbrainz: "" });
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!owner || request.current || operation.current || !navigator.onLine || document.visibilityState === "hidden") return;
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await getScrobbleConnections(controller.signal);
      if (mounted.current && !controller.signal.aborted) { setConnections(result.connections); setError(""); }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load scrobble connections.");
    } finally { if (request.current === controller) request.current = null; }
  }, [owner]);
  useEffect(() => {
    mounted.current = true;
    const stopPolling = startVisualPolling(refresh, 15_000, { refreshOnWindowFocus: true });
    const changed = () => { if (getVisualActivity()) void refresh(); };
    window.addEventListener("online", changed);
    return () => { mounted.current = false; request.current?.abort(); request.current = null; operation.current?.abort();
      stopPolling(); window.removeEventListener("online", changed); };
  }, [refresh]);
  async function run(provider: ScrobbleProvider, action: "connect" | "authorize" | "test" | "retry" | "disconnect") {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    request.current?.abort(); request.current = null;
    setBusy(`${provider}:${action}`); setError(""); setNotice("");
    try {
      if (action === "authorize") {
        const { authorizationUrl } = await beginLastFmAuthorization(controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        const url = new URL(authorizationUrl);
        if (url.origin !== "https://www.last.fm" || url.pathname !== "/api/auth/") throw new Error("The server returned an invalid authorization address.");
        window.location.assign(url.toString());
      } else {
        const result = action === "connect" ? await connectScrobble(provider, credentials[provider].trim(), controller.signal)
          : await scrobbleAction(provider, action, controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        setConnections(result.connections);
        setNotice(action === "test" ? `${names[provider]} credentials verified. No test listen was submitted.` : action === "retry" ? "Queued listens will retry when the provider's waiting period ends."
          : action === "disconnect" ? `${names[provider]} disconnected; pending submissions were cancelled.` : `${names[provider]} connected. Future qualified listens will be submitted.`);
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Scrobble operation failed.");
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) { setBusy(""); setCredentials((old) => ({ ...old, [provider]: "" })); }
    }
  }
  return <section className="settings-section scrobble-panel" aria-labelledby="scrobble-title">
    <div className="settings-section-heading"><span aria-hidden="true">↗</span><h2 id="scrobble-title">Listening connections</h2></div>
    <p className="scrobble-intro">Keep your listening history in sync. Connect your own accounts to share future plays after half a track or four minutes of listening.</p>
    <p className="scrobble-note">Last.fm requires a track longer than 30 seconds. Retries keep the original listening time. Previously saved history is never imported automatically.</p>
    {!owner && <p role="status">Sign in to manage your listening connections.</p>}
    {!online && <p role="status">You are offline. Saved listens stay in the server queue until connectivity returns.</p>}
    {!privacyAllowed && owner && <p className="scrobble-warning">External sharing is paused by privacy settings. New plays are not queued while this policy is active.</p>}
    {error && <p role="alert" className="scrobble-warning">{error}</p>}
    {notice && <p role="status" className="scrobble-notice">{notice}</p>}
    <div className="scrobble-grid">{(["lastfm", "listenbrainz"] as const).map((provider) => {
      const connection = connections.find((item) => item.provider === provider);
      const disabled = Boolean(busy || !owner || !online || !privacyAllowed || !connection?.available);
      return <article className={`scrobble-card scrobble-card-${provider}`} key={provider} aria-labelledby={`scrobble-${provider}`}>
        <div className="scrobble-card-heading"><h3 id={`scrobble-${provider}`}>{names[provider]}</h3>
          <span className={`scrobble-status ${connection?.status === "connected" ? "is-connected" : ""}`}>{connection ? labels[connection.status] || connection.status : owner ? "Checking…" : "Sign in"}</span></div>
        <p className="scrobble-account">{connection?.username ? `Connected as ${connection.username}` : "Your music. Your account."}</p>
        <dl className="scrobble-metrics"><div><dt>Last successful scrobble</dt><dd>{date(connection?.lastSuccessfulScrobble || null)}</dd></div>
          <div><dt>Original listening time</dt><dd>{date(connection?.lastListenedAt || null)}</dd></div>
          <div><dt>Queue</dt><dd>{connection?.pending || 0} waiting · {connection?.failed || 0} failed</dd></div>
          {connection?.nextRetryAt && <div><dt>Next retry</dt><dd>{date(connection.nextRetryAt)}</dd></div>}
        </dl>
        {connection?.unavailableReason && <p className="scrobble-warning">{connection.unavailableReason}</p>}
        {connection?.error && <p className="scrobble-warning">{connection.error.message} <code>{connection.error.code}{connection.error.httpStatus ? ` / HTTP ${connection.error.httpStatus}` : ""}</code></p>}
        {provider === "lastfm" && <>
          <button type="button" className="account-primary" disabled={disabled} onClick={() => void run(provider, "authorize")}>{busy === "lastfm:authorize" ? "Opening Last.fm…" : connection?.enabled ? "Reconnect Last.fm" : "Connect Last.fm"}</button>
          <button type="button" className="scrobble-text-button" aria-expanded={manual} onClick={() => setManual(!manual)}>{manual ? "Hide session key" : "Use an existing session key"}</button>
        </>}
        {(provider === "listenbrainz" || manual) && <div className="scrobble-credential">
          <label htmlFor={`credential-${provider}`}>{provider === "lastfm" ? "Last.fm session key for this application" : "ListenBrainz user token"}</label>
          <input id={`credential-${provider}`} type="password" autoComplete="off" spellCheck={false} maxLength={4096}
            disabled={disabled} value={credentials[provider]} onChange={(event) => setCredentials((old) => ({ ...old, [provider]: event.target.value }))} />
          {provider === "listenbrainz" && <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer">Find your user token on ListenBrainz</a>}
          <button type="button" className="settings-storage-refresh" disabled={disabled || !credentials[provider].trim()} onClick={() => void run(provider, "connect")}>
            {busy === `${provider}:connect` ? "Validating…" : "Validate & connect"}</button>
        </div>}
        {connection?.enabled && <div className="scrobble-actions">
          <button type="button" disabled={disabled} onClick={() => void run(provider, "test")}>{busy === `${provider}:test` ? "Testing…" : `Test ${names[provider]} connection`}</button>
          <button type="button" disabled={disabled || !(connection.pending || connection.failed)} onClick={() => void run(provider, "retry")}>Retry failed listens</button>
          <button type="button" disabled={Boolean(busy || !online)} onClick={() => void run(provider, "disconnect")}>Disconnect {names[provider]}</button>
        </div>}
        {!!connection?.diagnostics.length && <details className="scrobble-diagnostics"><summary>Submission diagnostics ({connection.diagnostics.length})</summary>
          <ul>{connection.diagnostics.map((item) => <li key={item.id}><strong>{item.artist} — {item.track}</strong>
            <span>{date(item.listenedAt)} · {item.state} · {item.attempts} attempts</span><p>{item.message}</p>
            <code>{item.code}{item.httpStatus ? ` / HTTP ${item.httpStatus}` : ""}</code>{item.nextRetryAt && <span>Retry after {date(item.nextRetryAt)}</span>}</li>)}</ul>
        </details>}
      </article>;
    })}</div>
  </section>;
}
