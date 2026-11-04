import os from "node:os";
import { EventEmitter } from "node:events";
import cron, { type ScheduledTask } from "node-cron";
import { createId } from "../utils/ids.js";
import type { Db } from "../db/database.js";
import { redactText } from "../utils/logger.js";

export const TASK_TYPES = ["SPOTDL_IMPORT", "SPOTDL_DOWNLOAD", "LIBRARY_SCAN", "AUDIO_ANALYSIS", "NEW_RELEASES_SCAN", "SONIC_AUDIO_ANALYSIS"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskState = "QUEUED" | "PROCESSING" | "PAUSED" | "FINISHED" | "FAILED" | "CANCELLED";

const DEFAULT_PRIORITY: Record<TaskType, number> = {
  SPOTDL_IMPORT: 300,
  SPOTDL_DOWNLOAD: 300,
  LIBRARY_SCAN: 200,
  AUDIO_ANALYSIS: 100,
  NEW_RELEASES_SCAN: 50,
  SONIC_AUDIO_ANALYSIS: 10,
};
const isAnalysisTask = (type: TaskType) => type === "AUDIO_ANALYSIS" || type === "SONIC_AUDIO_ANALYSIS";
const isBackgroundTask = (type: TaskType) => isAnalysisTask(type) || type === "LIBRARY_SCAN" || type === "NEW_RELEASES_SCAN";
const MAX_TASK_PAYLOAD_BYTES = 64 * 1024;
const MAX_TERMINAL_HISTORY = 1_000;

const TERMINAL_STATES = new Set<TaskState>(["FINISHED", "FAILED", "CANCELLED"]);

export interface TaskProgress {
  percent: number;
  itemsProcessed: number;
  totalItems: number | null;
  memoryBytes: number;
  message: string | null;
  speedBytesPerSecond?: number;
}

export interface ManagedTask {
  id: string;
  type: TaskType;
  state: TaskState;
  priority: number;
  payload: unknown;
  progress: TaskProgress;
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskRunContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  /** Report quantitative progress. Percent is clamped to 0-100. */
  report(progress: Partial<TaskProgress>): void;
  /** Only pass credential-redacted process output. */
  log?(source: "stdout" | "stderr", message: string): void;
  /**
   * Cooperatively stop work when paused, under resource pressure, or while
   * media is streaming. Runners must call this between bounded units of work.
   */
  checkpoint(): Promise<void>;
  throwIfCancelled(): void;
  isPaused(): boolean;
  /** Abort a bounded work unit before awaiting the next checkpoint. */
  onYield?(handler: () => void): () => void;
  onCancel(handler: () => void | Promise<void>): () => void;
}

export interface TaskDefinition<T = unknown> {
  validate(payload: unknown): payload is T;
  run(payload: T, context: TaskRunContext): Promise<void>;
}

export type TaskInterceptor = (
  task: Readonly<Pick<ManagedTask, "id" | "type" | "payload">>,
  context: TaskRunContext,
  next: () => Promise<void>,
) => Promise<void>;

export interface TaskManagerOptions {
  maxConcurrent?: number;
  maxAnalysisWorkers?: number;
  minFreeMemoryBytes?: number;
  maxCpuLoadPerCore?: number;
  monitorIntervalMs?: number;
  activeMediaStreams?: () => number;
  logger?: Pick<Console, "warn" | "error">;
}

interface TaskRow {
  id: string;
  type: TaskType;
  state: TaskState;
  priority: number;
  payload_json: string;
  progress_json: string;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ActiveTask {
  controller: AbortController;
  worker: Promise<void>;
  manualPause: boolean;
  resourcePause: boolean;
  cancelHandlers: Set<() => void | Promise<void>>;
  yieldHandlers: Set<() => void>;
  slotHeld: boolean;
}

interface ScheduleRow {
  id: string;
  task_type: TaskType;
  payload_json: string;
  expression: string;
  enabled: number;
  created_by: string;
}

export class TaskNotFoundError extends Error {
  constructor() {
    super("Background task not found");
  }
}

export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

function parseCron(value: unknown): string {
  if (typeof value !== "string") throw new TaskValidationError("Schedule must be a five-field cron expression");
  const expression = value.trim().replace(/\s+/g, " ");
  if (expression.split(" ").length !== 5 || !cron.validate(expression)) {
    throw new TaskValidationError("Schedule must be a valid five-field cron expression");
  }
  return expression;
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Cancelled";
  return "Background task failed. Review server logs for details.";
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function serializePayload(payload: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new TaskValidationError("Task payload must be JSON serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_TASK_PAYLOAD_BYTES) {
    throw new TaskValidationError("Task payload must not exceed 64 KiB");
  }
  return serialized;
}

/**
 * Persistent, priority-ordered cooperative scheduler for resource-intensive
 * background work. Runner callbacks must call `checkpoint()` between bounded
 * units; the manager cannot safely suspend arbitrary JavaScript or native
 * child processes that do not cooperate.
 */
export class TaskManager {
  private readonly definitions = new Map<TaskType, TaskDefinition<unknown>>();
  private readonly interceptors = new Map<string, TaskInterceptor>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly events = new EventEmitter();
  private readonly schedules = new Map<string, ScheduledTask>();
  private readonly options: Required<Omit<TaskManagerOptions, "activeMediaStreams" | "logger">> &
    Pick<TaskManagerOptions, "activeMediaStreams" | "logger">;
  private readonly logger: Pick<Console, "warn" | "error">;
  private monitor: NodeJS.Timeout | null = null;
  private activeSlots = 0;
  private stopping = false;
  private pumping = false;

  constructor(private readonly db: Db, options: TaskManagerOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 2,
      maxAnalysisWorkers: options.maxAnalysisWorkers ?? 1,
      minFreeMemoryBytes: options.minFreeMemoryBytes ?? 128 * 1024 * 1024,
      maxCpuLoadPerCore: options.maxCpuLoadPerCore ?? 0.9,
      monitorIntervalMs: options.monitorIntervalMs ?? 1000,
      activeMediaStreams: options.activeMediaStreams,
      logger: options.logger,
    };
    this.logger = options.logger ?? console;
    this.events.setMaxListeners(0);
    this.validateOptions();
    this.initializeTables();
    this.recoverInterruptedTasks();
    this.restoreSchedules();
    this.monitor = setInterval(() => this.refreshResourcePauses(), this.options.monitorIntervalMs);
    this.monitor.unref?.();
  }

  register<T>(type: TaskType, definition: TaskDefinition<T>): void {
    if (this.definitions.has(type)) throw new Error(`A task runner is already registered for ${type}`);
    this.definitions.set(type, definition as TaskDefinition<unknown>);
    this.pump();
  }

  unregister(type: TaskType): void {
    this.definitions.delete(type);
  }

  intercept(id: string, interceptor: TaskInterceptor): () => void {
    if (this.interceptors.has(id)) throw new Error(`A task interceptor is already registered for ${id}`);
    this.interceptors.set(id, interceptor);
    return () => { this.interceptors.delete(id); };
  }

  waitForSettlement(id: string): Promise<ManagedTask> {
    const current = this.requireTask(id);
    if (TERMINAL_STATES.has(current.state)) return Promise.resolve(current);
    if (this.stopping) return Promise.reject(new TaskConflictError("Task manager is shutting down"));
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((_event, task) => {
        if (task.id === id && TERMINAL_STATES.has(task.state)) {
          unsubscribe();
          this.events.off("close", onClose);
          resolve(task);
        }
      });
      const onClose = () => {
        unsubscribe();
        reject(new TaskConflictError("Task manager closed before the task settled"));
      };
      this.events.once("close", onClose);
    });
  }

  enqueue(type: TaskType, payload: unknown, createdBy: string, priority = DEFAULT_PRIORITY[type]): ManagedTask {
    this.assertRunning();
    if (!isTaskType(type)) throw new TaskValidationError("Unknown task type");
    const definition = this.definitions.get(type);
    if (!definition) throw new TaskConflictError(`No worker is registered for ${type}`);
    if (!definition.validate(payload)) throw new TaskValidationError(`Invalid ${type} task payload`);
    if (type === "SONIC_AUDIO_ANALYSIS" && this.findPending(type, {})) {
      throw new TaskConflictError("Sonic analysis is already queued or running");
    }
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1000) {
      throw new TaskValidationError("Priority must be an integer from 0 to 1000");
    }
    if (typeof createdBy !== "string" || !createdBy) throw new TaskValidationError("Task owner is required");

    const now = new Date().toISOString();
    const id = createId("task");
    const payloadJson = serializePayload(payload);
    const progress: TaskProgress = {
      percent: 0,
      itemsProcessed: 0,
      totalItems: null,
      memoryBytes: process.memoryUsage().rss,
      message: null,
    };
    this.db.prepare(`INSERT INTO background_tasks
      (id, type, state, priority, payload_json, progress_json, created_by, created_at, updated_at)
      VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`)
      .run(id, type, priority, payloadJson, JSON.stringify(progress), createdBy, now, now);
    const task = this.get(id)!;
    this.emit("task.state", task);
    if (type === "SPOTDL_IMPORT" || type === "SPOTDL_DOWNLOAD") this.refreshResourcePauses();
    else this.pump();
    return task;
  }

  get(id: string): ManagedTask | null {
    const row = this.db.prepare("SELECT * FROM background_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  findPending(type: TaskType, payload: unknown): ManagedTask | null {
    const row = this.db.prepare(`SELECT * FROM background_tasks
      WHERE type = ? AND payload_json = ? AND state IN ('QUEUED','PROCESSING','PAUSED')
      ORDER BY created_at, rowid LIMIT 1`).get(type, serializePayload(payload)) as TaskRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(options: { limit?: number; includeTerminal?: boolean } = {}): ManagedTask[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TaskValidationError("Task list limit must be from 1 to 500");
    }
    const rows = options.includeTerminal
      ? this.db.prepare("SELECT * FROM background_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as TaskRow[]
      : this.db.prepare("SELECT * FROM background_tasks WHERE state IN ('QUEUED','PROCESSING','PAUSED') ORDER BY priority DESC, created_at, rowid LIMIT ?").all(limit) as TaskRow[];
    return rows.map((row) => this.mapRow(row));
  }

  metrics() {
    return {
      memoryBytes: process.memoryUsage().rss,
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem(),
      loadPerCore: os.loadavg()[0] / Math.max(1, os.cpus().length),
      activeStreams: (this.options.activeMediaStreams?.() ?? 0) + this.mediaStreams,
      activeWorkers: this.activeSlots,
      maxConcurrent: this.options.maxConcurrent,
      constrained: this.resourceSnapshot().constrained,
    };
  }

  diagnostics(id: string): Array<{ seq: number; at: string; source: string; message: string }> {
    this.requireTask(id);
    return this.db.prepare("SELECT seq, at, source, message FROM background_task_logs WHERE task_id=? ORDER BY seq")
      .all(id) as Array<{ seq: number; at: string; source: string; message: string }>;
  }

  clearHistory(): string[] {
    const rows = this.db.prepare("SELECT id FROM background_tasks WHERE state IN ('FINISHED','FAILED','CANCELLED')")
      .all() as Array<{ id: string }>;
    this.db.prepare("DELETE FROM background_tasks WHERE state IN ('FINISHED','FAILED','CANCELLED')").run();
    const ids = rows.map((row) => row.id);
    this.events.emit("history.cleared", ids);
    return ids;
  }

  subscribeHistoryCleared(listener: (ids: string[]) => void): () => void {
    this.events.on("history.cleared", listener);
    return () => { this.events.off("history.cleared", listener); };
  }

  pause(id: string): ManagedTask {
    const task = this.requireTask(id);
    if (TERMINAL_STATES.has(task.state)) throw new TaskConflictError("Finished tasks cannot be paused");
    const active = this.active.get(id);
    if (active) {
      active.manualPause = true;
      active.yieldHandlers.forEach(handler => handler());
      if (task.state === "QUEUED") this.update(id, { state: "PAUSED" });
    } else {
      this.update(id, { state: "PAUSED" });
    }
    this.refreshResourcePauses();
    return this.requireTask(id);
  }

  resume(id: string): ManagedTask {
    const task = this.requireTask(id);
    if (TERMINAL_STATES.has(task.state)) throw new TaskConflictError("Finished tasks cannot be resumed");
    const active = this.active.get(id);
    if (active) {
      active.manualPause = false;
    } else if (task.state === "PAUSED") {
      this.update(id, { state: "QUEUED" });
    }
    this.refreshResourcePauses();
    return this.requireTask(id);
  }

  async cancel(id: string): Promise<ManagedTask> {
    const task = this.requireTask(id);
    if (TERMINAL_STATES.has(task.state)) throw new TaskConflictError("Finished tasks cannot be cancelled");
    const active = this.active.get(id);
    if (!active) {
      this.update(id, { state: "CANCELLED", finishedAt: new Date().toISOString() });
      this.pump();
      return this.requireTask(id);
    }
    active.controller.abort();
    for (const handler of active.cancelHandlers) {
      try {
        await handler();
      } catch (error) {
        this.logger.warn({ taskId: id, err: error }, "Task cancellation handler failed");
      }
    }
    return this.requireTask(id);
  }

  reprioritize(id: string, priority: number): ManagedTask {
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1000) {
      throw new TaskValidationError("Priority must be an integer from 0 to 1000");
    }
    const task = this.requireTask(id);
    if (TERMINAL_STATES.has(task.state)) {
      throw new TaskConflictError("Finished tasks cannot be re-prioritized");
    }
    this.update(id, { priority });
    this.refreshResourcePauses();
    return this.requireTask(id);
  }

  subscribe(listener: (event: "task.state" | "task.progress", task: ManagedTask) => void): () => void {
    this.events.on("task.state", listener);
    this.events.on("task.progress", listener);
    return () => {
      this.events.off("task.state", listener);
      this.events.off("task.progress", listener);
    };
  }

  setSchedule(type: TaskType, payload: unknown, expression: string, createdBy: string): { id: string; type: TaskType; expression: string; enabled: boolean } {
    this.assertRunning();
    const definition = this.definitions.get(type);
    if (!definition) throw new TaskConflictError(`No worker is registered for ${type}`);
    if (!definition.validate(payload)) throw new TaskValidationError(`Invalid ${type} task payload`);
    const normalized = parseCron(expression);
    const payloadJson = serializePayload(payload);
    const id = createId("taskschedule");
    this.db.prepare(`INSERT INTO background_task_schedules
      (id, task_type, payload_json, expression, enabled, created_by, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(task_type) DO UPDATE SET payload_json = excluded.payload_json,
        expression = excluded.expression, enabled = 1, created_by = excluded.created_by,
        updated_at = excluded.updated_at`)
      .run(id, type, payloadJson, normalized, createdBy, new Date().toISOString());
    const schedule = this.scheduleForType(type)!;
    this.armSchedule(schedule);
    return this.scheduleStatus(type)!;
  }

  removeSchedule(type: TaskType): void {
    const row = this.scheduleForType(type);
    if (!row) return;
    this.schedules.get(row.id)?.stop();
    this.schedules.delete(row.id);
    this.db.prepare("DELETE FROM background_task_schedules WHERE id = ?").run(row.id);
  }

  listSchedules(): Array<{ id: string; type: TaskType; expression: string; enabled: boolean }> {
    const rows = this.db.prepare("SELECT id, task_type, expression, enabled FROM background_task_schedules ORDER BY task_type").all() as Array<{
      id: string; task_type: TaskType; expression: string; enabled: number;
    }>;
    return rows.map((row) => ({ id: row.id, type: row.task_type, expression: row.expression, enabled: row.enabled === 1 }));
  }

  /** Called when an HTTP media response begins; the matching release is idempotent. */
  acquireMediaStream(): () => void {
    this.mediaStreams++;
    this.refreshResourcePauses();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.mediaStreams = Math.max(0, this.mediaStreams - 1);
      this.refreshResourcePauses();
      this.pump();
    };
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    for (const task of this.schedules.values()) task.stop();
    this.schedules.clear();
    for (const active of this.active.values()) {
      active.controller.abort();
      for (const handler of active.cancelHandlers) {
        try {
          await handler();
        } catch (error) {
          this.logger.warn({ err: error }, "Task cancellation handler failed during shutdown");
        }
      }
    }
    await Promise.allSettled([...this.active.values()].map(({ worker }) => worker));
    this.events.emit("close");
    this.events.removeAllListeners();
  }

  private mediaStreams = 0;

  private validateOptions(): void {
    const { maxConcurrent, maxAnalysisWorkers, minFreeMemoryBytes, maxCpuLoadPerCore, monitorIntervalMs } = this.options;
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error("maxConcurrent must be from 1 to 32");
    if (!Number.isSafeInteger(maxAnalysisWorkers) || maxAnalysisWorkers < 1 || maxAnalysisWorkers > maxConcurrent) throw new Error("maxAnalysisWorkers must be between 1 and maxConcurrent");
    if (!Number.isSafeInteger(minFreeMemoryBytes) || minFreeMemoryBytes < 0) throw new Error("minFreeMemoryBytes must be a non-negative integer");
    if (!Number.isFinite(maxCpuLoadPerCore) || maxCpuLoadPerCore <= 0) throw new Error("maxCpuLoadPerCore must be positive");
    if (!Number.isSafeInteger(monitorIntervalMs) || monitorIntervalMs < 100) throw new Error("monitorIntervalMs must be at least 100 ms");
  }

  private initializeTables(): void {
    // Rebuild CHECK constraints without renaming a referenced parent table.
    // Keep logs (and their IDs) through upgrades while foreign keys stay enabled.
    this.db.transaction(() => {
      for (const table of ["background_tasks", "background_task_schedules"]) {
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string } | undefined;
        if (!schema || TASK_TYPES.every(type => schema.sql.includes(`'${type}'`))) continue;
        const logSchema = table === "background_tasks" ? this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_task_logs'")
          .get() as { sql: string } | undefined : undefined;
        if (logSchema) this.db.exec("CREATE TEMP TABLE release_upgrade_logs AS SELECT * FROM background_task_logs; DROP TABLE background_task_logs");
        const updated = schema.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?\w+["`\]]?/i, `CREATE TABLE ${table}_updated`)
          .replace(/\b(type|task_type)\s+IN\s*\([^)]*\)/i, `$1 IN (${TASK_TYPES.map(type => `'${type}'`).join(",")})`);
        this.db.exec(updated);
        this.db.exec(`INSERT INTO ${table}_updated SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_updated RENAME TO ${table}`);
        if (logSchema) {
          this.db.exec(logSchema.sql);
          this.db.exec("INSERT INTO background_task_logs SELECT * FROM release_upgrade_logs; DROP TABLE release_upgrade_logs");
        }
      }
    })();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (${TASK_TYPES.map(type => `'${type}'`).join(",")})),
        state TEXT NOT NULL CHECK (state IN ('QUEUED','PROCESSING','PAUSED','FINISHED','FAILED','CANCELLED')),
        priority INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        error TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS background_tasks_queue_idx
        ON background_tasks(state, priority DESC, created_at);
      CREATE TABLE IF NOT EXISTS background_task_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS background_task_logs_task ON background_task_logs(task_id, seq);
      CREATE TABLE IF NOT EXISTS background_task_schedules (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL UNIQUE CHECK (task_type IN (${TASK_TYPES.map(type => `'${type}'`).join(",")})),
        payload_json TEXT NOT NULL,
        expression TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private recoverInterruptedTasks(): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE background_tasks SET state = 'FAILED',
      error = 'Task was interrupted by a server restart', finished_at = ?, updated_at = ?
      WHERE state = 'PROCESSING'`).run(now, now);
  }

  private restoreSchedules(): void {
    const rows = this.db.prepare("SELECT * FROM background_task_schedules WHERE enabled = 1").all() as ScheduleRow[];
    for (const row of rows) this.armSchedule(row);
  }

  private armSchedule(row: ScheduleRow): void {
    this.schedules.get(row.id)?.stop();
    try {
      const task = cron.schedule(row.expression, () => {
        try {
          const active = this.db.prepare("SELECT id FROM background_tasks WHERE type = ? AND state IN ('QUEUED','PROCESSING','PAUSED') LIMIT 1")
            .get(row.task_type);
          if (active) {
            this.logger.warn({ scheduleId: row.id, taskType: row.task_type }, "Scheduled background task skipped because the same task type is active");
            return;
          }
          this.enqueue(row.task_type, JSON.parse(row.payload_json), row.created_by);
        } catch (error) {
          this.logger.warn({ scheduleId: row.id, err: error }, "Scheduled background task was not queued");
        }
      }, { name: `musicdeck-${row.id}`, noOverlap: true });
      this.schedules.set(row.id, task);
    } catch (error) {
      this.db.prepare("UPDATE background_task_schedules SET enabled = 0 WHERE id = ?").run(row.id);
      this.logger.error({ scheduleId: row.id, err: error }, "Invalid persisted task schedule disabled");
    }
  }

  private scheduleForType(type: TaskType): ScheduleRow | undefined {
    return this.db.prepare("SELECT * FROM background_task_schedules WHERE task_type = ?").get(type) as ScheduleRow | undefined;
  }

  private scheduleStatus(type: TaskType): { id: string; type: TaskType; expression: string; enabled: boolean } | null {
    const row = this.scheduleForType(type);
    return row ? { id: row.id, type: row.task_type, expression: row.expression, enabled: row.enabled === 1 } : null;
  }

  private requireTask(id: string): ManagedTask {
    const task = this.get(id);
    if (!task) throw new TaskNotFoundError();
    return task;
  }

  private mapRow(row: TaskRow): ManagedTask {
    if (!isTaskType(row.type)) throw new Error(`Unknown persisted background task type: ${row.type}`);
    const progress = JSON.parse(row.progress_json) as TaskProgress;
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      priority: row.priority,
      payload: JSON.parse(row.payload_json),
      progress,
      error: row.error,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  private update(id: string, fields: Partial<Pick<ManagedTask, "state" | "priority" | "error" | "finishedAt" | "startedAt">>, progress?: TaskProgress): void {
    const task = this.requireTask(id);
    const nextState = fields.state ?? task.state;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE background_tasks SET state = ?, priority = ?, error = ?,
      started_at = ?, finished_at = ?, progress_json = ?, updated_at = ? WHERE id = ?`)
      .run(nextState, fields.priority ?? task.priority, fields.error === undefined ? task.error : fields.error,
        fields.startedAt === undefined ? task.startedAt : fields.startedAt,
        fields.finishedAt === undefined ? task.finishedAt : fields.finishedAt,
        JSON.stringify(progress ?? task.progress), now, id);
    const updated = this.requireTask(id);
    if (fields.state && fields.state !== task.state) {
      this.appendLog(id, "state", `${updated.state}${updated.error ? `: ${updated.error}` : ""}`);
    }
    if ((fields.state && fields.state !== task.state) || (fields.priority !== undefined && fields.priority !== task.priority)) {
      this.emit("task.state", updated);
    }
    if (TERMINAL_STATES.has(nextState)) this.pruneHistory();
  }

  private report(id: string, patch: Partial<TaskProgress>): void {
    const task = this.requireTask(id);
    const next: TaskProgress = {
      ...task.progress,
      ...patch,
      percent: patch.percent === undefined ? task.progress.percent : clampPercent(patch.percent),
      itemsProcessed: patch.itemsProcessed === undefined || !Number.isFinite(patch.itemsProcessed)
        ? task.progress.itemsProcessed
        : Math.max(0, Math.floor(patch.itemsProcessed)),
      totalItems: patch.totalItems === undefined
        ? task.progress.totalItems
        : patch.totalItems === null || !Number.isFinite(patch.totalItems)
          ? null
          : Math.max(0, Math.floor(patch.totalItems)),
      memoryBytes: patch.memoryBytes === undefined || !Number.isFinite(patch.memoryBytes)
        ? process.memoryUsage().rss
        : Math.max(0, Math.floor(patch.memoryBytes)),
      message: typeof patch.message === "string" ? patch.message.slice(0, 500) : patch.message ?? task.progress.message,
      speedBytesPerSecond: patch.speedBytesPerSecond === undefined ? task.progress.speedBytesPerSecond
        : Number.isFinite(patch.speedBytesPerSecond) ? Math.max(0, patch.speedBytesPerSecond) : 0,
    };
    this.update(id, {}, next);
    if (next.message && next.message !== task.progress.message) this.appendLog(id, "progress", next.message);
    this.emit("task.progress", this.requireTask(id));
  }

  private appendLog(id: string, source: string, message: string): void {
    if (!message.trim() || !this.get(id)) return;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO background_task_logs(task_id,at,source,message) VALUES(?,?,?,?)")
        .run(id, new Date().toISOString(), source, redactText(message).slice(0, 2000));
      this.db.prepare(`DELETE FROM background_task_logs WHERE task_id=? AND seq NOT IN
        (SELECT seq FROM background_task_logs WHERE task_id=? ORDER BY seq DESC LIMIT 200)`).run(id, id);
    })();
  }

  private emit(event: "task.state" | "task.progress", task: ManagedTask): void {
    this.events.emit(event, event, task);
  }

  private assertRunning(): void {
    if (this.stopping) throw new TaskConflictError("Task manager is shutting down");
  }

  private resourceSnapshot(): { constrained: boolean; memoryBytes: number } {
    const free = os.freemem();
    const load = os.loadavg()[0] / Math.max(1, os.cpus().length);
    return {
      constrained: free < this.options.minFreeMemoryBytes ||
        (load > 0 && load >= this.options.maxCpuLoadPerCore),
      memoryBytes: process.memoryUsage().rss,
    };
  }

  private refreshResourcePauses(): void {
    const constrained = this.resourceSnapshot().constrained;
    const streams = (this.options.activeMediaStreams?.() ?? 0) + this.mediaStreams;
    for (const [id, active] of this.active) {
      const task = this.get(id);
      if (!task) continue;
      const shouldPause = this.blocked(task.type, constrained, streams);
      if (shouldPause && !active.resourcePause && !active.controller.signal.aborted) {
        active.yieldHandlers.forEach(handler => handler());
      }
      active.resourcePause = shouldPause && !active.controller.signal.aborted;
    }
    if (!constrained) this.pump();
  }

  private blocked(type: TaskType, constrained = this.resourceSnapshot().constrained,
    streams = (this.options.activeMediaStreams?.() ?? 0) + this.mediaStreams): boolean {
    if (isBackgroundTask(type) && (streams > 0 || constrained)) return true;
    return type === "SONIC_AUDIO_ANALYSIS" && Boolean(this.db.prepare(`SELECT 1 FROM background_tasks
      WHERE type IN ('SPOTDL_IMPORT','SPOTDL_DOWNLOAD') AND priority >= 200
      AND state IN ('QUEUED','PROCESSING') LIMIT 1`).get());
  }

  private pump(): void {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      const rows = this.db.prepare(`SELECT id, type FROM background_tasks
        WHERE state = 'QUEUED' ORDER BY priority DESC, created_at, rowid`).all() as Array<{ id: string; type: TaskType }>;
      for (const row of rows) {
        if (this.activeSlots >= this.options.maxConcurrent) break;
        if (this.active.has(row.id) || !this.definitions.has(row.type)) continue;
        if (isAnalysisTask(row.type) && this.analysisWorkers() >= this.options.maxAnalysisWorkers) continue;
        if (this.resourceSnapshot().constrained) continue;
        const task = this.requireTask(row.id);
        const streams = (this.options.activeMediaStreams?.() ?? 0) + this.mediaStreams;
        if (this.blocked(task.type, false, streams)) continue;
        this.startTask(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  private analysisWorkers(): number {
    let count = 0;
    for (const [id, active] of this.active) {
      const type = this.get(id)?.type;
      if (active.slotHeld && type && isAnalysisTask(type)) count++;
    }
    return count;
  }

  private startTask(task: ManagedTask): void {
    const controller = new AbortController();
    const active: ActiveTask = {
      controller,
      worker: Promise.resolve(),
      manualPause: false,
      resourcePause: false,
      cancelHandlers: new Set(),
      yieldHandlers: new Set(),
      slotHeld: false,
    };
    this.active.set(task.id, active);
    active.worker = this.execute(task, active);
    active.worker.catch((error) => {
      this.logger.error({ taskId: task.id, err: error }, "Background task worker crashed");
    }).finally(() => {
      this.releaseSlot(active);
      this.active.delete(task.id);
      this.pump();
    });
  }

  private async execute(task: ManagedTask, active: ActiveTask): Promise<void> {
    const definition = this.definitions.get(task.type);
    if (!definition) return;
    const context: TaskRunContext = {
      taskId: task.id,
      signal: active.controller.signal,
      report: (progress) => this.report(task.id, progress),
      log: (source, message) => this.appendLog(task.id, source, message),
      checkpoint: async () => this.checkpoint(task.id, active),
      throwIfCancelled: () => {
        if (active.controller.signal.aborted) throw this.abortError();
      },
      isPaused: () => active.manualPause || active.resourcePause,
      onYield: (handler) => {
        active.yieldHandlers.add(handler);
        if (active.manualPause || active.resourcePause) handler();
        return () => { active.yieldHandlers.delete(handler); };
      },
      onCancel: (handler) => {
        if (active.controller.signal.aborted) {
          void Promise.resolve(handler()).catch((error) => {
            this.logger.warn({ taskId: task.id, err: error }, "Late task cancellation handler failed");
          });
          return () => {};
        }
        active.cancelHandlers.add(handler);
        return () => active.cancelHandlers.delete(handler);
      },
    };
    try {
      await this.acquireSlot(active, task.id);
      context.throwIfCancelled();
      this.update(task.id, { state: "PROCESSING", startedAt: task.startedAt ?? new Date().toISOString(), error: null });
      await context.checkpoint();
      const current = this.requireTask(task.id);
      const middleware = [...this.interceptors.values()];
      const invoke = async (index: number): Promise<void> => {
        context.throwIfCancelled();
        const interceptor = middleware[index];
        if (!interceptor) return definition.run(current.payload, context);
        let called = false;
        let open = true;
        let downstream: Promise<void> | undefined;
        try {
          await interceptor({ id: current.id, type: current.type, payload: current.payload }, context, () => {
            if (!open) throw new Error("A task interceptor called next after returning");
            if (called) throw new Error("A task interceptor called next more than once");
            called = true;
            downstream = invoke(index + 1);
            // Retain rejection handling even if a faulty extension forgets to await next().
            void downstream.catch(() => {});
            return downstream;
          });
        } finally {
          open = false;
          await downstream;
        }
      };
      await invoke(0);
      context.throwIfCancelled();
      const final = this.requireTask(task.id);
      this.update(task.id, { state: "FINISHED", finishedAt: new Date().toISOString() }, {
        ...final.progress, percent: 100, memoryBytes: process.memoryUsage().rss,
      });
    } catch (error) {
      if (active.controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.update(task.id, { state: "CANCELLED", finishedAt: new Date().toISOString(), error: "Cancelled" });
        return;
      }
      this.update(task.id, { state: "FAILED", finishedAt: new Date().toISOString(), error: safeError(error) });
      this.logger.error({ taskId: task.id, err: error }, "Background task failed");
    } finally {
      this.releaseSlot(active);
    }
  }

  private async checkpoint(id: string, active: ActiveTask): Promise<void> {
    active.controller.signal.throwIfAborted();
    const task = this.requireTask(id);
    active.resourcePause = this.blocked(task.type);

    while ((active.manualPause || active.resourcePause) && !active.controller.signal.aborted) {
      this.releaseSlot(active);
      if (this.get(id)?.state !== "PAUSED") this.update(id, { state: "PAUSED" });
      this.pump();
      await this.delay(250, active.controller.signal);
      active.resourcePause = this.blocked(task.type);
    }
    active.controller.signal.throwIfAborted();
    if (!active.slotHeld) await this.acquireSlot(active, id);
    if (this.get(id)?.state === "PAUSED") this.update(id, { state: "PROCESSING" });
  }

  private async acquireSlot(active: ActiveTask, id: string): Promise<void> {
    while (!active.controller.signal.aborted && this.activeSlots >= this.options.maxConcurrent) {
      await this.delay(50, active.controller.signal);
    }
    active.controller.signal.throwIfAborted();
    if (!active.slotHeld) {
      this.activeSlots++;
      active.slotHeld = true;
    }
    const type = this.get(id)?.type;
    if (type && isAnalysisTask(type)) {
      while (this.analysisSlots() > this.options.maxAnalysisWorkers) {
        this.releaseSlot(active);
        await this.delay(50, active.controller.signal);
        while (!active.controller.signal.aborted && this.activeSlots >= this.options.maxConcurrent) {
          await this.delay(50, active.controller.signal);
        }
        active.controller.signal.throwIfAborted();
        this.activeSlots++;
        active.slotHeld = true;
      }
    }
  }

  private analysisSlots(): number {
    let count = 0;
    for (const [id, active] of this.active) {
      const type = this.get(id)?.type;
      if (active.slotHeld && type && isAnalysisTask(type)) count++;
    }
    return count;
  }

  private releaseSlot(active: ActiveTask): void {
    if (!active.slotHeld) return;
    active.slotHeld = false;
    this.activeSlots = Math.max(0, this.activeSlots - 1);
  }

  private pruneHistory(): void {
    this.db.prepare(`DELETE FROM background_tasks
      WHERE state IN ('FINISHED','FAILED','CANCELLED')
        AND id NOT IN (
          SELECT id FROM background_tasks
          WHERE state IN ('FINISHED','FAILED','CANCELLED')
          ORDER BY finished_at DESC, rowid DESC LIMIT ?
        )`).run(MAX_TERMINAL_HISTORY);
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(this.abortError());
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(this.abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private abortError(): Error {
    const error = new Error("Task cancelled");
    error.name = "AbortError";
    return error;
  }
}
