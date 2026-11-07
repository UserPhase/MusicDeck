import { useEffect, useMemo, useSyncExternalStore } from "react";
import { clearTaskHistory, controlTask, setTaskPriority, taskStreamUrl } from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";
import { useVisualActivity } from "./useVisualActivity";

export type TaskState = "QUEUED" | "PROCESSING" | "PAUSED" | "FINISHED" | "FAILED" | "CANCELLED";
export interface ActivityTask {
  id: string;
  type: string;
  state: TaskState;
  priority: number;
  progress: { percent: number; itemsProcessed: number; totalItems: number | null; memoryBytes: number; message: string | null; speedBytesPerSecond?: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface TaskMetrics {
  memoryBytes: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  loadPerCore: number;
  activeStreams: number;
  activeWorkers: number;
  maxConcurrent: number;
  constrained: boolean;
}
type Listener = () => void;
type Connection = { status: "connecting" | "live" | "reconnecting" | "unavailable"; error: string | null };
type Groups = { active: string[]; queued: string[]; history: string[] };
const terminal = (state: TaskState) => ["FINISHED", "FAILED", "CANCELLED"].includes(state);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
function isTask(value: unknown): value is ActivityTask {
  if (!object(value) || !object(value.progress)) return false;
  const p = value.progress;
  return typeof value.id === "string" && typeof value.type === "string" &&
    ["QUEUED", "PROCESSING", "PAUSED", "FINISHED", "FAILED", "CANCELLED"].includes(String(value.state)) &&
    finite(value.priority) && finite(p.percent) && finite(p.itemsProcessed) && finite(p.memoryBytes) &&
    (p.totalItems === null || finite(p.totalItems)) && (p.speedBytesPerSecond === undefined || finite(p.speedBytesPerSecond)) &&
    nullableText(p.message) && nullableText(value.error) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    nullableText(value.startedAt) && nullableText(value.finishedAt);
}
function isMetrics(value: unknown): value is TaskMetrics {
  return object(value) && ["memoryBytes", "freeMemoryBytes", "totalMemoryBytes", "loadPerCore", "activeStreams", "activeWorkers", "maxConcurrent"]
    .every((key) => finite(value[key])) && typeof value.constrained === "boolean";
}
function listen(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const notify = (listeners?: Set<Listener>) => listeners?.forEach((listener) => listener());
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** One authenticated connection; task snapshots and structural lists have separate subscriptions. */
export function createTaskStreamStore() {
  const tasks = new Map<string, ActivityTask>();
  const revisions = new Map<string, number>();
  const rowListeners = new Map<string, Set<Listener>>();
  const groupListeners = new Set<Listener>();
  const connectionListeners = new Set<Listener>();
  const metricListeners = new Set<Listener>();
  let groups: Groups = { active: [], queued: [], history: [] };
  let connection: Connection = { status: "connecting", error: null };
  let metrics: TaskMetrics | null = null;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<string>();
  let running = false;
  let attempts = 0;
  let epoch = 0;

  const setConnection = (status: Connection["status"], error: string | null = null) => {
    if (connection.status === status && connection.error === error) return;
    connection = { status, error };
    notify(connectionListeners);
  };
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    // Match the server's descending priority / FIFO ordering, with stable ties.
    const ordered = [...tasks.values()].sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    const history = ordered.filter((task) => terminal(task.state))
      .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt));
    for (const task of history.slice(500)) { tasks.delete(task.id); revisions.delete(task.id); pending.add(task.id); }
    const next: Groups = {
      active: ordered.filter((task) => task.state === "PROCESSING" || (task.state === "PAUSED" && task.startedAt !== null)).map((task) => task.id),
      queued: ordered.filter((task) => task.state === "QUEUED" || (task.state === "PAUSED" && task.startedAt === null)).map((task) => task.id),
      history: history.slice(0, 500).map((task) => task.id),
    };
    if (!sameIds(groups.active, next.active) || !sameIds(groups.queued, next.queued) || !sameIds(groups.history, next.history)) {
      groups = next;
      notify(groupListeners);
    }
    const changed = pending;
    pending = new Set();
    changed.forEach((id) => notify(rowListeners.get(id)));
  };
  const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 100); };
  const ingest = (task: ActivityTask) => {
    const previous = tasks.get(task.id);
    if (previous && (previous.updatedAt > task.updatedAt || (terminal(previous.state) && !terminal(task.state)))) return;
    tasks.set(task.id, task);
    revisions.set(task.id, (revisions.get(task.id) ?? 0) + 1);
    pending.add(task.id);
    scheduleFlush();
  };
  const remove = (ids: string[]) => {
    ids.forEach((id) => { tasks.delete(id); revisions.delete(id); pending.add(id); });
    flush();
  };
  const disconnect = () => {
    source?.close();
    source = null;
    clearTimeout(watchdog);
  };
  const reconnect = (message: string) => {
    disconnect();
    clearTimeout(retry);
    setConnection("reconnecting", message);
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6));
    retry = setTimeout(connect, delay + Math.floor(Math.random() * delay * 0.2));
  };
  const touch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => reconnect("The task stream stopped responding."), 45_000);
  };
  function connect() {
    if (!running) return;
    if (typeof EventSource === "undefined") {
      setConnection("unavailable", "This browser does not support live task streams.");
      return;
    }
    let current: EventSource;
    try { current = new EventSource(taskStreamUrl(), { withCredentials: true }); }
    catch (error) {
      reconnect(error instanceof Error ? error.message : "Could not open the task stream.");
      return;
    }
    source = current;
    touch();
    const receive = (kind: string) => (event: MessageEvent<string>) => {
      if (!running || source !== current) return;
      try {
        const data: unknown = JSON.parse(event.data);
        if (!object(data)) throw new Error("Invalid task stream response.");
        touch();
        if (kind === "ready") {
          if (!Array.isArray(data.tasks) || !data.tasks.every(isTask) || !isMetrics(data.metrics)) throw new Error("Invalid task snapshot.");
          tasks.forEach((_task, id) => pending.add(id));
          tasks.clear();
          revisions.clear();
          data.tasks.forEach(ingest);
          metrics = data.metrics;
          notify(metricListeners);
          flush();
          attempts = 0;
          setConnection("live");
        } else if (kind === "task.state" || kind === "task.progress") {
          if (!isTask(data.task)) throw new Error("Invalid task update.");
          ingest(data.task);
        } else if (kind === "metrics") {
          if (!isMetrics(data.metrics)) throw new Error("Invalid resource metrics.");
          metrics = data.metrics;
          notify(metricListeners);
        } else if (kind === "history.cleared") {
          if (!Array.isArray(data.ids) || !data.ids.every((id) => typeof id === "string")) throw new Error("Invalid history update.");
          remove(data.ids);
        }
      } catch (error) {
        reconnect(error instanceof Error ? error.message : "Could not read the task stream.");
      }
    };
    ["ready", "task.state", "task.progress", "metrics", "history.cleared", "heartbeat"].forEach((kind) => current.addEventListener(kind, receive(kind)));
    current.onerror = () => {
      if (running && source === current) reconnect("Connection lost. Retrying automatically; check your session if this persists.");
    };
  }
  return {
    subscribe: (listener: Listener) => listen(groupListeners, listener),
    getSnapshot: () => groups,
    subscribeConnection: (listener: Listener) => listen(connectionListeners, listener),
    getConnection: () => connection,
    subscribeMetrics: (listener: Listener) => listen(metricListeners, listener),
    getMetrics: () => metrics,
    subscribeTask: (id: string, listener: Listener) => {
      const listeners = rowListeners.get(id) ?? new Set<Listener>();
      rowListeners.set(id, listeners);
      const unsubscribe = listen(listeners, listener);
      return () => { unsubscribe(); if (!listeners.size) rowListeners.delete(id); };
    },
    getTask: (id: string) => tasks.get(id),
    start: ({ keepSnapshot = false } = {}) => {
      running = true;
      epoch++;
      setConnection("connecting");
      connect();
      return () => {
        running = false;
        epoch++;
        disconnect();
        clearTimeout(retry);
        clearTimeout(flushTimer);
        flushTimer = undefined;
        if (keepSnapshot) return;
        tasks.clear();
        revisions.clear();
        pending.clear();
        groups = { active: [], queued: [], history: [] };
        metrics = null;
      };
    },
    async act(id: string, action: "pause" | "resume" | "cancel" | "priority", priority?: number) {
      const version = revisions.get(id);
      const requestEpoch = epoch;
      const result = action === "priority" ? await setTaskPriority(id, priority) : await controlTask(id, action);
      if (running && requestEpoch === epoch && revisions.get(id) === version) {
        if (!isTask(result.task)) throw new Error("Invalid task control response.");
        ingest(result.task);
      }
    },
    async clearHistory() {
      const requestEpoch = epoch;
      const result = await clearTaskHistory();
      if (!Array.isArray(result.ids) || !result.ids.every((id: unknown) => typeof id === "string")) throw new Error("Invalid history response.");
      if (running && requestEpoch === epoch) remove(result.ids);
    },
  };
}
export type TaskStreamStore = ReturnType<typeof createTaskStreamStore>;

export default function useTaskStream(): TaskStreamStore {
  const auth: unknown = useAuth();
  const visualActive = useVisualActivity();
  const session = object(auth) && object(auth.session) ? auth.session : null;
  const userId = session?.role === "admin" && typeof session.id === "string" ? session.id : undefined;
  const store = useMemo(createTaskStreamStore, [userId]);
  useEffect(() => userId && visualActive ? store.start({ keepSnapshot: true }) : undefined, [store, userId, visualActive]);
  return store;
}

export function useActivityTask(store: TaskStreamStore, id: string) {
  const subscription = useMemo(() => ({
    subscribe: (listener: Listener) => store.subscribeTask(id, listener),
    snapshot: () => store.getTask(id),
  }), [store, id]);
  return useSyncExternalStore(subscription.subscribe, subscription.snapshot);
}
