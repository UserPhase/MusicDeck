import { useEffect, useRef, useState } from "react";
import { useVisualActivity } from "../../hooks/useVisualActivity";
import { request } from "../../api/musicdeck";
import "../../styles/sonic-extension.css";

const route = "/api/v1/admin/sonic";
type Settings = { enabled: boolean; threads: number; weight: number; schedule: "manual" | "hourly" | "nightly" };
type Snapshot = {
  settings: Settings;
  counts: { indexed: number; catalog: number };
  activeStreams: number;
  task: {
    state: "QUEUED" | "PROCESSING" | "PAUSED" | "FINISHED" | "FAILED" | "CANCELLED";
    progress: { itemsProcessed: number; totalItems: number | null; percent: number; message: string | null };
    error: string | null;
  } | null;
};

export default function SonicExtensionView() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Settings>();
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const visualActive = useVisualActivity();
  useEffect(() => {
    if (busy || !visualActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next: Snapshot = await request(route, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRefreshError("");
        setSnapshot(next);
        setDraft(current => current ?? next.settings);
      } catch (failure) {
        if (!controller.signal.aborted) setRefreshError(failure instanceof Error ? failure.message : "Could not load sonic analysis.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [busy, visualActive]);

  async function mutate(method: "PUT" | "POST", body: Settings | { action: "start" | "pause" | "resume" | "cancel" }) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next: Snapshot = await request(route, { method, body: JSON.stringify(body) });
      setSnapshot(next);
      if (method === "PUT") setDraft(next.settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sonic analysis could not be updated.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const task = snapshot?.task;
  const pending = task?.state === "QUEUED" || task?.state === "PROCESSING" || task?.state === "PAUSED";
  const indexed = snapshot?.counts.indexed ?? 0;
  const catalog = snapshot?.counts.catalog ?? 0;
  const percent = catalog ? (100 * indexed / catalog).toFixed(1) : "0.0";
  return <main className="sonic-extension">
    <header>
      <p className="sonic-kicker">Library analysis</p>
      <h1>Sonic recommendations</h1>
      <p>Index the sound of local tracks so recommendations can use timbre, rhythm, and harmony.</p>
    </header>
    {error && <p role="alert">{error}</p>}
    {refreshError && <p role="alert">{refreshError}</p>}
    {!snapshot || !draft ? <p role="status">Waiting for sonic analysis settings…</p> : <>
      <section className="sonic-card" aria-label="Sonic index progress">
        <div className="sonic-count">{indexed.toLocaleString()} <span>of {catalog.toLocaleString()} tracks analyzed</span></div>
        <progress max={Math.max(1, catalog)} value={indexed} aria-label="Indexed tracks" />
        <p>{percent}% indexed · {task?.state.toLowerCase() ?? "idle"}</p>
        {task?.progress.message && <p>{task.progress.message}</p>}
        {task?.error && <p role="alert">{task.error}</p>}
        {snapshot.activeStreams > 0 && pending && <p role="status">Waiting for active audio streams to finish.</p>}
        <div className="sonic-actions">
          <button type="button" disabled={busy || pending || !snapshot.settings.enabled}
            onClick={() => void mutate("POST", { action: "start" })}>Start analysis</button>
          {pending && <button type="button" disabled={busy}
            onClick={() => void mutate("POST", { action: task.state === "PAUSED" ? "resume" : "pause" })}>
            {task.state === "PAUSED" ? "Resume" : "Pause"}
          </button>}
          {pending && <button type="button" disabled={busy} onClick={() => void mutate("POST", { action: "cancel" })}>Cancel scan</button>}
        </div>
      </section>
      <form className="sonic-card" onSubmit={event => { event.preventDefault(); void mutate("PUT", draft); }}>
        <fieldset disabled={busy}>
          <legend>Analysis settings</legend>
          <label className="sonic-toggle"><input type="checkbox" checked={draft.enabled}
            onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> Enable Sonic Audio Analysis</label>
          <div className="sonic-fields">
            <label>Decoder thread limit <select value={draft.threads} onChange={event => setDraft({ ...draft, threads: Number(event.target.value) })}>
              {[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}
            </select></label>
            <label>Schedule <select value={draft.schedule} onChange={event => setDraft({ ...draft, schedule: event.target.value as Settings["schedule"] })}>
              <option value="manual">Manual</option>
              <option value="hourly">Hourly at :30</option>
              <option value="nightly">Nightly at 02:30 (server time)</option>
            </select></label>
            <label>Acoustic weight <input type="number" min="0" max="6" step="0.1" value={draft.weight}
              onChange={event => setDraft({ ...draft, weight: Number(event.target.value) })} /></label>
          </div>
          <p>One track runs at a time. Audio must be accessible under the MusicDeck music root.</p>
          <button type="submit">Save settings</button>
        </fieldset>
      </form>
    </>}
  </main>;
}
