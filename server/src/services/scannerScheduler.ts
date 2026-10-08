import cron, { type ScheduledTask } from "node-cron";

import type { Db } from "../db/database.js";

export const SCAN_SCHEDULE_SETTING_KEY = "library.scanSchedule";
const LAST_SCAN_SETTING_KEY = "library.lastScanRun";

/** Legacy free-text values that meant "no automatic scans". */
const DISABLED_ALIASES = new Set(["", "disabled", "manual", "none", "off", "never", "not scheduled"]);

export type ScanTrigger = "manual" | "scheduled";
export type ScanRunStatus = "running" | "succeeded" | "partial" | "failed" | "skipped";

export interface ScanRunRecord {
  trigger: ScanTrigger;
  status: ScanRunStatus;
  startedAt: string;
  finishedAt?: string;
  message?: string;
}

export interface ScanOutcome {
  attempted: number;
  failures: unknown[];
}

export interface ScannerScheduleStatus {
  /** Normalized cron expression, or null when automatic scans are off. */
  expression: string | null;
  /** The raw stored value, so the UI can show legacy/invalid entries. */
  stored: string;
  enabled: boolean;
  valid: boolean;
  error?: string;
  timezone: string;
  nextRunAt: string | null;
  running: boolean;
  currentRun: ScanRunRecord | null;
  lastRun: ScanRunRecord | null;
}

export type CronValidation =
  | { ok: true; expression: string | null }
  | { ok: false; error: string };

/**
 * Validates a library scan schedule. Accepts an empty value (or a legacy
 * "disabled" alias) and standard 5-field cron expressions only; node-cron's
 * optional seconds field is rejected so schedules stay portable.
 */
export function validateScanSchedule(raw: unknown): CronValidation {
  if (raw === null || raw === undefined) return { ok: true, expression: null };
  if (typeof raw !== "string") return { ok: false, error: "Library scan schedule must be a string" };

  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (DISABLED_ALIASES.has(trimmed.toLowerCase())) return { ok: true, expression: null };

  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    return { ok: false, error: "Library scan schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week)" };
  }
  if (!cron.validate(trimmed)) {
    return { ok: false, error: `"${trimmed}" is not a valid cron expression` };
  }
  return { ok: true, expression: trimmed };
}

interface SchedulerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const consoleLogger: SchedulerLogger = {
  info: (obj, msg) => console.log(msg ?? obj, msg ? obj : ""),
  warn: (obj, msg) => console.warn(msg ?? obj, msg ? obj : ""),
  error: (obj, msg) => console.error(msg ?? obj, msg ? obj : ""),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the in-memory node-cron job that triggers library scans. The schedule
 * lives in `server_settings`; `apply()` swaps the job in place so a settings
 * change takes effect without restarting the process. Manual and scheduled
 * runs share one in-flight guard so scans never overlap.
 */
export class ScannerScheduler {
  private task: ScheduledTask | null = null;
  private expression: string | null = null;
  private stored = "";
  private invalidReason: string | undefined;
  private currentRun: ScanRunRecord | null = null;
  private inFlight: Promise<void> | null = null;
  private lastRun: ScanRunRecord | null;
  private readonly logger: SchedulerLogger;
  private readonly timezone?: string;

  constructor(
    private readonly db: Db,
    private readonly scan: () => Promise<ScanOutcome | void>,
    options: { logger?: SchedulerLogger; timezone?: string } = {},
  ) {
    this.logger = options.logger ?? consoleLogger;
    this.timezone = options.timezone;
    this.lastRun = this.readLastRun();
  }

  /** Loads the persisted schedule and arms the job. */
  start(): ScannerScheduleStatus {
    return this.apply(this.readStoredSchedule());
  }

  /** Replaces the running job with `raw`; invalid values leave scans off. */
  apply(raw: unknown): ScannerScheduleStatus {
    this.disarm();
    this.stored = typeof raw === "string" ? raw : "";
    this.invalidReason = undefined;
    this.expression = null;

    const validation = validateScanSchedule(raw);
    if (!validation.ok) {
      this.invalidReason = validation.error;
      this.logger.warn({ schedule: this.stored }, `Library scan schedule ignored: ${validation.error}`);
      return this.status();
    }
    if (!validation.expression) {
      return this.status();
    }

    this.expression = validation.expression;
    this.task = cron.schedule(
      validation.expression,
      () => {
        const { started } = this.runNow("scheduled");
        if (!started) this.logger.warn({}, "Scheduled library scan skipped: a scan is already running");
      },
      { name: "musicdeck-library-scan", noOverlap: true, timezone: this.timezone },
    );
    this.logger.info({ schedule: validation.expression }, "Library scan schedule armed");
    return this.status();
  }

  /** Starts a scan unless one is already running. Never throws. */
  runNow(trigger: ScanTrigger): { started: boolean; run: ScanRunRecord } {
    if (this.currentRun && this.inFlight) {
      return { started: false, run: this.currentRun };
    }

    const run: ScanRunRecord = { trigger, status: "running", startedAt: new Date().toISOString() };
    this.currentRun = run;
    this.inFlight = this.execute(run).finally(() => {
      this.currentRun = null;
      this.inFlight = null;
    });
    return { started: true, run };
  }

  /** Resolves once the in-flight scan (if any) has finished. */
  async waitForIdle(): Promise<void> {
    await this.inFlight;
  }

  status(): ScannerScheduleStatus {
    const next = this.task?.getNextRun() ?? null;
    return {
      expression: this.expression,
      stored: this.stored,
      enabled: Boolean(this.task),
      valid: !this.invalidReason,
      ...(this.invalidReason ? { error: this.invalidReason } : {}),
      timezone: this.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      nextRunAt: next ? next.toISOString() : null,
      running: Boolean(this.currentRun),
      currentRun: this.currentRun,
      lastRun: this.lastRun,
    };
  }

  stop(): void {
    this.disarm();
  }

  private disarm() {
    if (!this.task) return;
    const task = this.task;
    this.task = null;
    void Promise.resolve(task.destroy()).catch((error) => {
      this.logger.warn({ err: error }, "Failed to stop library scan job");
    });
  }

  private async execute(run: ScanRunRecord) {
    this.logger.info({ trigger: run.trigger }, "Library scan started");
    let finished: ScanRunRecord;
    try {
      const outcome = await this.scan();
      finished = { ...run, finishedAt: new Date().toISOString(), ...this.classify(outcome) };
    } catch (error) {
      finished = { ...run, finishedAt: new Date().toISOString(), status: "failed", message: errorMessage(error) };
    }

    const log = finished.status === "failed" ? this.logger.error : finished.status === "partial" ? this.logger.warn : this.logger.info;
    log.call(this.logger, { trigger: run.trigger, status: finished.status, detail: finished.message }, "Library scan finished");
    this.lastRun = finished;
    this.persistLastRun(finished);
  }

  private classify(outcome: ScanOutcome | void): Pick<ScanRunRecord, "status" | "message"> {
    if (!outcome) return { status: "succeeded" };
    if (outcome.attempted === 0) {
      return { status: "skipped", message: "No connected music server supports library scans" };
    }
    if (outcome.failures.length === 0) return { status: "succeeded" };
    const detail = outcome.failures.map(errorMessage).join("; ");
    return outcome.failures.length >= outcome.attempted
      ? { status: "failed", message: detail }
      : { status: "partial", message: `${outcome.failures.length} of ${outcome.attempted} servers failed: ${detail}` };
  }

  private readStoredSchedule(): unknown {
    return this.readSetting(SCAN_SCHEDULE_SETTING_KEY) ?? "";
  }

  private readLastRun(): ScanRunRecord | null {
    const value = this.readSetting(LAST_SCAN_SETTING_KEY);
    return value && typeof value === "object" && "startedAt" in value ? (value as ScanRunRecord) : null;
  }

  private readSetting(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM server_settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  private persistLastRun(run: ScanRunRecord) {
    try {
      this.db.prepare(`
        INSERT INTO server_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(LAST_SCAN_SETTING_KEY, JSON.stringify(run), new Date().toISOString());
    } catch (error) {
      // The database may already be closed during shutdown.
      this.logger.warn({ err: error }, "Could not persist last library scan result");
    }
  }
}
