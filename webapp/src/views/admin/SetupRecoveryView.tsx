import { useCallback, useEffect, useRef, useState } from "react";
import { startVisualPolling } from "../../services/visualActivity";
import {
  completeSystemSetup, createSystemBackup, getSystemRecoveryStatus, restoreSystemBackup, runSystemDiagnostics,
  saveSystemConfiguration, systemBackupUrl, SystemRecoveryRequestError, updateDailyBackupPolicy,
  type DiagnosticReport, type SystemConfigurationInput, type SystemRecoveryStatus,
} from "../../api/setupRecovery";
import "../../styles/setup-recovery.css";

const message = (error: unknown) => error instanceof Error ? error.message : "The server could not complete this operation.";
const bytes = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GiB` : `${(size / 1024 ** 2).toFixed(1)} MiB`;
export default function SetupRecoveryView() {
  const [status, setStatus] = useState<SystemRecoveryStatus | null>(null);
  const [draft, setDraft] = useState<SystemConfigurationInput | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const initialized = useRef(false), mounted = useRef(false), operation = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const data = await getSystemRecoveryStatus(signal);
    if (!mounted.current) return;
    setStatus(data);
    if (!initialized.current) {
      initialized.current = true; setStep(data.firstRun ? 0 : 1);
      setDraft({ version: 1, backend: data.configuration.backend, navidrome: { url: data.configuration.navidrome.url, username: data.configuration.navidrome.username }, jellyfin: { url: data.configuration.jellyfin.url }, musicRoot: data.configuration.musicRoot, acquisitionTmpDir: data.configuration.acquisitionTmpDir });
    }
  }, []);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void load(controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);
  useEffect(() => {
    if (!restarting && !busy) return;
    let disposed = false, pending = false; const deadline = Date.now() + 120_000;
    const poll = async () => {
      if (pending || disposed) return; pending = true;
      try {
        const data = await getSystemRecoveryStatus();
        if (disposed) return;
        setStatus(data);
        if (restarting && ["complete", "failed"].includes(data.operation.state)) {
          setRestarting(false); setNotice(data.operation.message);
          if (data.operation.state === "failed") setError(data.operation.message);
          initialized.current = false; await load();
        }
      } catch (reason) {
        if (disposed) return;
        if (reason instanceof SystemRecoveryRequestError && reason.status === 401) { setSignInRequired(true); setRestarting(false); setNotice("Sign in to confirm the restore outcome and download the pre-restore safety snapshot."); }
        else if (Date.now() > deadline && restarting) { setRestarting(false); setError("The server has not returned within two minutes. Check server logs and recovery status before retrying the operation."); }
      } finally { pending = false; }
    };
    const stopPolling = startVisualPolling(poll, 2000, { immediate: false });
    return () => { disposed = true; stopPolling(); };
  }, [restarting, busy, load]);
  async function run(label: string, action: () => Promise<void>) {
    if (operation.current || restarting) return;
    operation.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { operation.current = false; if (mounted.current) setBusy(""); }
  }
  const disabled = Boolean(busy || restarting || signInRequired);
  const diagnostics = async (candidate = false) => {
    const result = await runSystemDiagnostics(candidate && draft ? draft : undefined);
    if (mounted.current) { setReport(result.report); setNotice(result.report.ready ? "Core setup checks passed. Review any optional dependency warnings." : "Some checks need attention. Follow the fix instructions below."); }
  };
  const field = (key: "musicRoot" | "acquisitionTmpDir", value: string) => setDraft((current) => current ? { ...current, [key]: value } : current);
  return <main className="setup-recovery-view" aria-labelledby="setup-recovery-title">
    <header className="recovery-heading"><div><span className="recovery-eyebrow">MUSICDECK / SYSTEM OPERATIONS</span><h1 id="setup-recovery-title">Setup & recovery</h1><p>Connect your library. Check your server. Keep a way back.</p></div><span className={`recovery-state ${report?.status || "unchecked"}`}>{restarting ? "Restarting" : report ? report.ready ? "Core checks passed" : "Needs attention" : "Not checked"}</span></header>
    {status?.firstRun && <aside className="recovery-notice">First-run setup: work through connection, health, and backup checks. Your first administrator and session secret remain managed by deployment settings.</aside>}
    <nav className="recovery-steps" aria-label="Setup steps">{["Connect", "Check health", "Protect & recover"].map((label, index) => <button type="button" key={label} onClick={() => setStep(index)} aria-current={step === index ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</button>)}</nav>
    {error && <p className="recovery-error" role="alert">{error}</p>}
    {notice && <p className="recovery-notice" role="status">{notice}</p>}
    {signInRequired && <a className="recovery-primary" href="/login">Sign in after restore</a>}
    {restarting && <p className="recovery-notice" role="status">The server is restarting. Active streams and background jobs stop while the database and configuration are replaced. This page will check for its return.</p>}
    {!status && <button type="button" disabled={disabled} onClick={() => { void run("Loading system status", () => load()); }}>Retry loading system status</button>}
    {step === 0 && draft && <section className="recovery-panel" aria-labelledby="connect-title"><div className="recovery-section-heading"><span>01</span><div><h2 id="connect-title">Connect your music server</h2><p>Credentials stay on the server. Leave a secret field blank to keep its saved value.</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void run("Checking connection and paths", () => diagnostics(true)); }}>
        <div className="recovery-form"><label>Backend<select disabled={disabled} value={draft.backend} onChange={(event) => setDraft({ ...draft, backend: event.target.value as SystemConfigurationInput["backend"] })}><option value="navidrome">Navidrome</option><option value="jellyfin">Jellyfin</option></select></label>
          {draft.backend === "navidrome" ? <><label>Navidrome URL<input type="url" required disabled={disabled} value={draft.navidrome.url} onChange={(event) => setDraft({ ...draft, navidrome: { ...draft.navidrome, url: event.target.value } })} /></label><label>Navidrome username<input required disabled={disabled} autoComplete="off" value={draft.navidrome.username} onChange={(event) => setDraft({ ...draft, navidrome: { ...draft.navidrome, username: event.target.value } })} /></label><label>Navidrome password<input type="password" disabled={disabled} autoComplete="new-password" value={draft.navidrome.password || ""} placeholder={status?.configuration.navidrome.passwordSet ? "Saved; leave blank to keep" : "Enter backend password"} onChange={(event) => setDraft({ ...draft, navidrome: { ...draft.navidrome, password: event.target.value || undefined } })} /></label></>
            : <><label>Jellyfin URL<input type="url" required disabled={disabled} value={draft.jellyfin.url} onChange={(event) => setDraft({ ...draft, jellyfin: { ...draft.jellyfin, url: event.target.value } })} /></label><label>Jellyfin API key<input type="password" disabled={disabled} autoComplete="new-password" value={draft.jellyfin.apiKey || ""} placeholder={status?.configuration.jellyfin.apiKeySet ? "Saved; leave blank to keep" : "Enter Jellyfin API key"} onChange={(event) => setDraft({ ...draft, jellyfin: { ...draft.jellyfin, apiKey: event.target.value || undefined } })} /></label></>}
          <label>Music directory on the server<input required disabled={disabled} value={draft.musicRoot} onChange={(event) => field("musicRoot", event.target.value)} /></label><label>Download staging directory on the server<input required disabled={disabled} value={draft.acquisitionTmpDir} onChange={(event) => field("acquisitionTmpDir", event.target.value)} /></label></div>
        <p className="recovery-help">Use container paths when MusicDeck runs in Docker. The music directory must match the media server’s shared volume. Changing backend type is supported during setup with an empty local catalog.</p>
        <div className="recovery-actions"><button type="submit" disabled={disabled}>{busy || "Test connection & paths"}</button><button type="button" className="recovery-primary" disabled={disabled || !status?.restartSupported} onClick={() => { void run("Saving configuration", async () => { await saveSystemConfiguration(draft); setDraft({ ...draft, navidrome: { ...draft.navidrome, password: undefined }, jellyfin: { ...draft.jellyfin, apiKey: undefined } }); setRestarting(true); }); }}>Save & restart server</button><button type="button" disabled={disabled} onClick={() => setStep(1)}>Continue to health checks →</button></div>
      </form>
    </section>}
    {step === 1 && <section aria-labelledby="health-title"><div className="recovery-section-heading"><span>02</span><div><h2 id="health-title">Know what needs attention</h2><p>Tests the active backend credentials, filesystem writes, download tools, and database integrity.</p></div></div>
      <div className="recovery-actions"><button type="button" className="recovery-primary" disabled={disabled} onClick={() => { void run("Running system diagnostics", () => diagnostics()); }}>{busy || "Run health diagnostics"}</button><button type="button" disabled={disabled || !report?.ready} onClick={() => { void run("Completing setup", async () => { const result = await completeSystemSetup(); setReport(result.report); await load(); setStep(2); setNotice("Setup checks completed. Create your first system backup."); }); }}>Complete setup & continue →</button></div>
      {!report && <p className="recovery-help">Run diagnostics to get an actionable report. Optional spotDL or FFmpeg warnings do not prevent streaming existing music.</p>}
    </section>}
    {report && <section className="recovery-diagnostics" aria-label="System health diagnostic report">{report.checks.map((check) => <article className={`recovery-check ${check.status}`} key={check.id}><div className="recovery-check-heading"><span className={`recovery-state ${check.status}`}>{check.status === "pass" ? "Passed" : check.status === "warning" ? "Warning" : "Failed"}</span><span>{check.durationMs} ms</span></div><h3>{check.title}</h3><p>{check.message}</p>{check.fix && <div className="recovery-fix"><strong>How to fix</strong><p>{check.fix}</p></div>}</article>)}</section>}
    {step === 2 && <section aria-labelledby="protect-title"><div className="recovery-section-heading"><span>03</span><div><h2 id="protect-title">Keep a recovery point</h2><p>Database, user preferences, playlists, configuration, and server artwork cache. Raw audio and transcoded playback caches are excluded.</p></div></div>
      <div className="recovery-backup-grid"><article className="recovery-panel"><h3>System backups</h3><p>Archives contain account data and credentials. Keep them private and download a copy outside this server.</p><button type="button" className="recovery-primary" disabled={disabled} onClick={() => { void run("Creating system backup", async () => { const result = await createSystemBackup(); setNotice(`Backup created: ${result.backup.filename}. Download a copy below.`); await load(); }); }}>Create System Backup</button>
        <label className="recovery-toggle"><input type="checkbox" disabled={disabled || !status} checked={status?.backupDaily || false} onChange={(event) => { const daily = event.target.checked; void run("Saving backup policy", async () => { await updateDailyBackupPolicy(daily); await load(); }); }} /> Create a backup daily while this server runs</label><p className="recovery-help">Backups are retained on the server. Check available disk space and manage off-server copies.</p></article>
        <article className="recovery-panel"><h3>Restore from a backup</h3><p>Only verified MusicDeck .tar.gz archives from a matching database schema are accepted. A pre-restore safety archive is created automatically.</p>
          <input ref={input} type="file" accept=".tar.gz,application/gzip" aria-label="Backup file" disabled={disabled} onChange={(event) => { setError(""); const selected = event.target.files?.[0] || null; if (selected && selected.size > (status?.limits.uploadBytes || 256 * 1024 * 1024)) { setError("This file exceeds the 256 MiB backup upload limit."); event.target.value = ""; setFile(null); return; } setFile(selected); setConfirmRestore(false); setAcknowledged(false); }} />
          {file && <p className="recovery-help">{file.name} · {bytes(file.size)}</p>}
          <button type="button" disabled={disabled || !file || !status?.restartSupported} onClick={() => setConfirmRestore(true)}>Restore from Backup File</button>
          {confirmRestore && file && <div className="recovery-confirm" role="alertdialog" aria-labelledby="restore-confirm-title"><h3 id="restore-confirm-title">Replace this server’s system data?</h3><p>The database, configuration and server artwork cache will be replaced. Active streams stop and all sessions are signed out. Audio files are not changed. Sign in afterward with an administrator account from the backup.</p><label className="recovery-toggle"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={disabled} /> I understand this replaces the current system data.</label><div className="recovery-actions"><button type="button" className="recovery-danger" disabled={disabled || !acknowledged} onClick={() => { void run("Validating backup file", async () => { await restoreSystemBackup(file); setConfirmRestore(false); setRestarting(true); }); }}>Validate & restore backup</button><button type="button" disabled={disabled} onClick={() => setConfirmRestore(false)}>Cancel</button></div></div>}
        </article></div>
      {status && <section className="recovery-backups" aria-label="Saved system backups"><h3>Available recovery points</h3>{!status.backups.length && <p>No system backups yet.</p>}{status.backups.map((backup) => <article key={backup.id}><div><strong>{backup.kind === "safety" ? "Pre-restore safety snapshot" : "System backup"}</strong><p>{new Date(backup.createdAt).toLocaleString()} · {bytes(backup.bytes)}</p><small>{backup.filename}</small></div><a href={systemBackupUrl(backup.id)}>Download archive ↓</a></article>)}</section>}
    </section>}
    {status && <footer className="recovery-footer" aria-live="polite"><span>Last operation</span><strong>{status.operation.message}</strong><button type="button" disabled={disabled} onClick={() => { void run("Refreshing recovery status", () => load()); }}>Refresh status</button></footer>}
  </main>;
}
