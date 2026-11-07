import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { startVisualPolling } from "../services/visualActivity";
import { Link } from "react-router-dom";
import { getTaskLogs } from "../api/musicdeck";
import { scanReleases } from "../api/artistFollows";
import { usePrivacy } from "../context/PrivacyContext";
import useTaskStream, { useActivityTask, type ActivityTask, type TaskStreamStore } from "../hooks/useTaskStream";
import "../styles/activity-center.css";

const titles: Record<string, string> = {
  SPOTDL_IMPORT: "spotDL import", SPOTDL_DOWNLOAD: "Media download",
  LIBRARY_SCAN: "Library re-index", AUDIO_ANALYSIS: "Audio analysis", NEW_RELEASES_SCAN: "Followed artist releases",
};
const stateLabels = { QUEUED: "Queued", PROCESSING: "Processing", PAUSED: "Paused", FINISHED: "Finished", FAILED: "Failed", CANCELLED: "Cancelled" };
const isTerminal = (task: ActivityTask) => ["FINISHED", "FAILED", "CANCELLED"].includes(task.state);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please try again.";
function bytes(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
}
function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ConnectionStatus({ store }: { store: TaskStreamStore }) {
  const { status, error } = useSyncExternalStore(store.subscribeConnection, store.getConnection);
  const label = { connecting: "Connecting...", live: "Live updates", reconnecting: "Reconnecting...", unavailable: "Stream unavailable" }[status];
  return <div className={`activity-connection is-${status}`} role="status">
    <span className="activity-signal" aria-hidden="true" />{label}
    {error && <span className="activity-connection-detail">{error} Displayed data may be out of date.</span>}
  </div>;
}

function ResourceStrip({ store }: { store: TaskStreamStore }) {
  const metrics = useSyncExternalStore(store.subscribeMetrics, store.getMetrics);
  return <section className="activity-resources" aria-label="Server resources">
    <div><span>Worker slots</span><strong>{metrics ? `${metrics.activeWorkers} / ${metrics.maxConcurrent}` : "--"}</strong></div>
    <div><span>Server process RSS</span><strong>{metrics ? bytes(metrics.memoryBytes) : "--"}</strong></div>
    <div><span>Host memory free</span><strong>{metrics ? `${bytes(metrics.freeMemoryBytes)} / ${bytes(metrics.totalMemoryBytes)}` : "--"}</strong></div>
    <div><span>Load / core <small>(1 min)</small></span><strong>{metrics ? metrics.loadPerCore.toFixed(2) : "--"}</strong></div>
    <div><span>Media streams</span><strong>{metrics?.activeStreams ?? "--"}</strong></div>
    {metrics?.constrained && <p className="activity-resource-warning">Resource pressure: new work is waiting; cooperative workers yield at checkpoints.</p>}
  </section>;
}

interface DiagnosticEntry { seq: number; at: string; source: string; message: string }
function isDiagnostic(value: unknown): value is DiagnosticEntry {
  return typeof value === "object" && value !== null && "seq" in value && typeof value.seq === "number" &&
    "at" in value && typeof value.at === "string" && "source" in value && typeof value.source === "string" &&
    "message" in value && typeof value.message === "string";
}
function Diagnostics({ task }: { task: ActivityTask }) {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const terminal = isTerminal(task);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | undefined;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const result = await getTaskLogs(task.id, controller.signal);
        if (!Array.isArray(result.entries) || !result.entries.every(isDiagnostic)) throw new Error("Invalid task diagnostics response.");
        if (!disposed) { setEntries(result.entries); setError(""); setLoaded(true); }
      } catch (failure) {
        if (!disposed) setError(errorMessage(failure));
      } finally { inFlight = false; }
    }
    if (terminal) void load();
    const stopPolling = terminal ? undefined : startVisualPolling(load, 2000);
    return () => { disposed = true; controller?.abort(); stopPolling?.(); };
  }, [task.id, terminal, refresh]);
  return <div className="activity-diagnostics">
    <div className="activity-diagnostics-heading"><span>Diagnostic tail / last 200 entries</span>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh diagnostics</button></div>
    {error && <p role="alert">{error}</p>}
    {!loaded && !error && <p role="status">Loading diagnostics...</p>}
    {loaded && entries.length === 0 && <p>No retained trace for this task. Older tasks may predate diagnostic capture.</p>}
    {entries.length > 0 && <pre tabIndex={0} aria-label={`Diagnostics for ${task.id}`}>{entries.map((entry) =>
      `${entry.at} [${entry.source}] ${entry.message}`).join("\n")}</pre>}
    {task.error && <p className="activity-task-error">{task.error}</p>}
  </div>;
}

function usePace(task: ActivityTask) {
  const previous = useRef({ percent: task.progress.percent, at: Date.now(), state: task.state });
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    const before = previous.current;
    const delta = task.progress.percent - before.percent;
    if (task.state !== "PROCESSING" || before.state !== "PROCESSING" || delta < 0) setRate(null);
    else if (delta > 0 && now > before.at) setRate(delta / ((now - before.at) / 1000));
    if (delta !== 0 || before.state !== task.state) previous.current = { percent: task.progress.percent, at: now, state: task.state };
  }, [task.progress.percent, task.state]);
  if (task.state !== "PROCESSING") return "Speed / ETA paused";
  const speed = task.progress.speedBytesPerSecond;
  const pace = speed ? `${bytes(speed)}/s` : rate ? `${rate.toFixed(1)}%/s` : "Measuring speed";
  const seconds = rate ? Math.ceil((100 - task.progress.percent) / rate) : null;
  const eta = seconds === null ? "ETA pending" : seconds < 60 ? `~${seconds}s left` : `~${Math.ceil(seconds / 60)}m left`;
  return `${pace} / ${eta}`;
}

const TaskRow = memo(function TaskRow({ store, id }: { store: TaskStreamStore; id: string }) {
  const task = useActivityTask(store, id);
  return task ? <TaskCard store={store} task={task} /> : null;
});

function TaskCard({ store, task }: { store: TaskStreamStore; task: ActivityTask }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [priority, setPriority] = useState(String(task.priority));
  const actionLock = useRef(false);
  const pace = usePace(task);
  const terminal = isTerminal(task);
  const queued = task.state === "QUEUED" || (task.state === "PAUSED" && !task.startedAt);
  useEffect(() => setPriority(String(task.priority)), [task.priority]);
  async function act(action: "pause" | "resume" | "cancel" | "priority") {
    if (actionLock.current) return;
    if (action === "priority" && (!/^\d+$/.test(priority) || Number(priority) > 1000)) {
      setError("Priority must be a whole number from 0 to 1000.");
      return;
    }
    if (action === "cancel" && !window.confirm("Cancel this task? Work stops at its next cancellation boundary.")) return;
    actionLock.current = true;
    setBusy(action);
    setError("");
    try { await store.act(task.id, action, Number(priority)); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { actionLock.current = false; setBusy(""); }
  }
  const title = titles[task.type] ?? task.type;
  const percent = Math.max(0, Math.min(100, task.progress.percent));
  return <article className={`activity-task state-${task.state.toLowerCase()}`} aria-label={`${title} ${task.id}`}>
    <div className="activity-task-heading">
      <div><span className="activity-task-id">{task.id}</span><h3>{title}</h3></div>
      <span className={`activity-badge badge-${task.state.toLowerCase()}`}>{stateLabels[task.state]}</span>
    </div>
    <p className="activity-current-item">{task.progress.message || (queued ? "Waiting for a worker slot" : terminal ? "Task settled" : "Preparing the next item")}</p>
    {!terminal && !queued && <>
      <div className="activity-progress-label"><span>{task.progress.itemsProcessed.toLocaleString()}{task.progress.totalItems !== null ? ` / ${task.progress.totalItems.toLocaleString()}` : ""} items</span>
        <strong>{percent.toFixed(1)}%</strong></div>
      <div className="activity-progress" role="progressbar" aria-label={`${title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} /></div>
      <p className="activity-pace">{pace}</p>
    </>}
    <div className="activity-task-meta">
      <time dateTime={task.finishedAt ?? task.createdAt}>{terminal ? "Settled" : "Created"} {time(task.finishedAt ?? task.createdAt)}</time>
      <span>Priority {task.priority}</span>
    </div>
    {task.error && <p className="activity-task-error">{task.error}</p>}
    <div className="activity-actions">
      {!terminal && <>
        <button type="button" disabled={Boolean(busy)} onClick={() => void act(task.state === "PAUSED" ? "resume" : "pause")}>
          {task.state === "PAUSED" ? "Resume" : "Pause"}</button>
        <button type="button" className="activity-danger" disabled={Boolean(busy)} onClick={() => void act("cancel")}>Cancel</button>
        {queued && <div className="activity-priority">
          <label>Priority<input type="number" min={0} max={1000} step={1} value={priority} disabled={Boolean(busy)} onChange={(event) => setPriority(event.target.value)} /></label>
          <button type="button" disabled={Boolean(busy) || priority === String(task.priority)} onClick={() => void act("priority")}>Apply priority</button>
        </div>}
      </>}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide diagnostics" : "View diagnostics"}</button>
    </div>
    {busy && <p role="status">Requesting {busy}... Changes take effect at a cooperative checkpoint.</p>}
    {error && <p role="alert">{error}</p>}
    {expanded && <Diagnostics task={task} />}
  </article>;
}

function TaskSections({ store }: { store: TaskStreamStore }) {
  const groups = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const connection = useSyncExternalStore(store.subscribeConnection, store.getConnection);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const clearLock = useRef(false);
  const history = groups.history.filter((id) => {
    const task = store.getTask(id);
    const needle = search.trim().toLowerCase();
    return task && (filter === "all" || task.state === filter) &&
      `${titles[task.type] ?? task.type} ${task.id} ${task.error ?? ""} ${task.progress.message ?? ""}`.toLowerCase().includes(needle);
  });
  async function clear() {
    if (clearLock.current || !window.confirm("Permanently clear all finished, failed, and cancelled task history and diagnostics? Active and queued work will be kept.")) return;
    clearLock.current = true;
    setClearing(true);
    setClearError("");
    try { await store.clearHistory(); }
    catch (error) { setClearError(errorMessage(error)); }
    finally { clearLock.current = false; setClearing(false); }
  }
  if (connection.status !== "live" && !groups.active.length && !groups.queued.length && !groups.history.length) {
    return <div className="activity-panel"><p role="status">Waiting for the server task snapshot. No task state has been confirmed yet.</p></div>;
  }
  return <>
    <div className="activity-work-grid">
      <section className="activity-panel" aria-labelledby="activity-active">
        <header className="activity-section-heading"><div><span className="activity-eyebrow">01 / In motion</span><h2 id="activity-active">Active tasks</h2></div><span className="activity-count">{groups.active.length}</span></header>
        {groups.active.length === 0 ? <div className="activity-empty"><strong>All quiet.</strong><p>No tasks are running. Your music has the floor.</p></div> :
          groups.active.map((id) => <TaskRow key={id} id={id} store={store} />)}
      </section>
      <section className="activity-panel" aria-labelledby="activity-queued">
        <header className="activity-section-heading"><div><span className="activity-eyebrow">02 / Up next</span><h2 id="activity-queued">Task queue</h2></div><span className="activity-count">{groups.queued.length}</span></header>
        <p className="activity-section-note">Higher priorities run first (0-1000). Equal priorities keep arrival order. Paused tasks must be resumed.</p>
        {groups.queued.length === 0 ? <div className="activity-empty"><strong>Nothing waiting.</strong><p>New coordinated jobs will appear here.</p></div> :
          groups.queued.map((id) => <TaskRow key={id} id={id} store={store} />)}
      </section>
    </div>
    <section className="activity-panel activity-history" aria-labelledby="activity-history">
      <header className="activity-section-heading"><div><span className="activity-eyebrow">03 / The record</span><h2 id="activity-history">Task history &amp; audit log</h2></div>
        <button type="button" disabled={clearing || groups.history.length === 0} onClick={() => void clear()}>{clearing ? "Clearing..." : "Clear history"}</button></header>
      <div className="activity-filters">
        <label>Status<select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All settled tasks</option><option value="FINISHED">Finished</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option>
        </select></label>
        <label>Search history<input type="search" placeholder="Task, ID, item or error..." value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <p className="activity-section-note">Latest 500 settled tasks. Diagnostics retain the last 200 state, progress, and redacted process-output entries per task. Clearing removes all server task history, not just the current filter.</p>
      {clearError && <p role="alert">{clearError}</p>}
      {history.length === 0 ? <p className="activity-empty">No task history matches this view.</p> : history.map((id) => <TaskRow key={id} id={id} store={store} />)}
    </section>
  </>;
}

export default function ActivityCenter() {
  const store = useTaskStream();
  const { canMetadata } = usePrivacy();
  const [checkingReleases, setCheckingReleases] = useState(false);
  const [releaseNotice, setReleaseNotice] = useState("");
  const [releaseError, setReleaseError] = useState("");
  async function checkReleases() {
    setCheckingReleases(true);
    setReleaseNotice("");
    setReleaseError("");
    try {
      await scanReleases();
      setReleaseNotice("Release check queued.");
    } catch (error) {
      setReleaseError(errorMessage(error));
    } finally {
      setCheckingReleases(false);
    }
  }
  return <main className="activity-center">
    <header className="activity-page-heading">
      <div><span className="activity-eyebrow">MusicDeck / Operations</span><h1>Activity center<span aria-hidden="true">.</span></h1>
        <p>One place for the work behind your music.</p></div>
      <ConnectionStatus store={store} />
    </header>
    <ResourceStrip store={store} />
    <section className="activity-section" aria-label="Followed artist releases">
      <button type="button" className="account-secondary" disabled={!canMetadata || checkingReleases} onClick={() => void checkReleases()}>
        {checkingReleases ? "Queuing release check…" : "Check releases"}
      </button>
      {releaseNotice && <p role="status">{releaseNotice}</p>}
      {releaseError && <p role="alert">{releaseError}</p>}
    </section>
    <details className="activity-scope-note">
      <summary>Monitoring &amp; control notes</summary>
      <p>Monitoring TaskManager imports, catalog scans, and registered analysis jobs (up to 500 active/pending records). Pause and cancel take effect at worker boundaries; resource-paused work may wait after Resume. Smart playlist previews run on demand, not as background jobs. Load is a host load average, not CPU utilization; some hosts do not report it. <Link to="/admin/server/logs">Open server logs</Link></p>
    </details>
    <TaskSections store={store} />
  </main>;
}
