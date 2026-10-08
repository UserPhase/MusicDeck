import { EventEmitter } from "node:events";
import { formatWithOptions } from "node:util";

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogSource = "server" | "console" | "process";

export interface LogEntry {
  id: string;
  seq: number;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  stack?: string;
  meta?: Record<string, unknown>;
}

export type LogInput = {
  level: LogLevel;
  source: LogSource;
  message: string;
  stack?: string;
  meta?: Record<string, unknown>;
  time?: number;
};

export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];
export const DEFAULT_LOG_CAPACITY = 1_000;
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 8 * 1024;
const MAX_STACK_CHARS = 16 * 1024;
const MAX_META_CHARS = 4 * 1024;
const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const knownSecrets = new Set<string>();

/**
 * Register a literal secret (session secret, provider passwords, API keys)
 * so any occurrence is masked before it reaches the buffer. Short values are
 * ignored: masking 1-5 character strings would shred unrelated log text.
 */
export function registerLogSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= 6) knownSecrets.add(value);
}

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|session|credential|salt)/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(https?:\/\/)[^\s/"'<>]*@/gi, `$1${REDACTED}@`],
  // Authorization: Bearer xyz / Basic xyz
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Header-style "cookie: a=b; c=d" or "x-emby-token=abc"
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-emby-token|x-mediabrowser-token|x-api-key)(["']?\s*[:=]\s*["']?)[^"'\r\n,}]+/gi, `$1$2${REDACTED}`],
  [/\bmusicdeck_session=[^;\s&"']+/g, `musicdeck_session=${REDACTED}`],
  // Subsonic auth query params (u is the username and stays visible).
  [/([?&](?:t|s|p))=[^&#\s"']*/g, `$1=${REDACTED}`],
  // "apiKey": "value" in serialized JSON.
  [/(["'][\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[\w-]*["']\s*:\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, `$1"${REDACTED}"`],
  // key=value pairs in query strings, env dumps and CLI arguments.
  [/(\b[\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[\w-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}#;"']+)/gi, `$1${REDACTED}`],
];

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function redactText(input: string): string {
  let output = input.replace(ANSI_PATTERN, "");
  for (const secret of knownSecrets) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 5) return "[Object]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) && item != null ? REDACTED : redactValue(item, depth + 1);
  }
  return result;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

type Slot = { entry: LogEntry; bytes: number };

/**
 * Fixed-capacity circular buffer of structured log entries. Bounded both by
 * entry count and by approximate byte size, so a burst of large stack traces
 * cannot grow the heap past the cap inside a memory-limited container.
 */
export class LogBuffer {
  private readonly slots: Array<Slot | undefined>;
  private head = 0;
  private count = 0;
  private bytes = 0;
  private seq = 0;
  readonly emitter = new EventEmitter();

  constructor(
    readonly capacity = DEFAULT_LOG_CAPACITY,
    readonly maxBytes = DEFAULT_LOG_MAX_BYTES,
  ) {
    this.slots = new Array(capacity);
    // One listener per open SSE client; the route caps concurrent clients.
    this.emitter.setMaxListeners(0);
  }

  push(input: LogInput): LogEntry {
    this.seq += 1;
    const entry: LogEntry = {
      id: String(this.seq),
      seq: this.seq,
      timestamp: new Date(input.time ?? Date.now()).toISOString(),
      level: input.level,
      source: input.source,
      message: truncate(redactText(input.message), MAX_MESSAGE_CHARS),
    };
    if (input.stack) entry.stack = truncate(redactText(input.stack), MAX_STACK_CHARS);
    if (input.meta && Object.keys(input.meta).length) {
      const meta = redactValue(input.meta) as Record<string, unknown>;
      const json = safeStringify(meta);
      entry.meta = json.length > MAX_META_CHARS
        ? { truncated: true, preview: json.slice(0, MAX_META_CHARS) }
        : meta;
    }

    const bytes = Buffer.byteLength(safeStringify(entry));
    if (this.count === this.capacity) this.evictOldest();
    while (this.count > 0 && this.bytes + bytes > this.maxBytes) this.evictOldest();

    const tail = (this.head + this.count) % this.capacity;
    this.slots[tail] = { entry, bytes };
    this.count += 1;
    this.bytes += bytes;
    this.emitter.emit("entry", entry);
    return entry;
  }

  /** Oldest-to-newest snapshot, optionally filtered. */
  list(options: { level?: LogLevel; limit?: number; after?: number } = {}): LogEntry[] {
    const result: LogEntry[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const slot = this.slots[(this.head + index) % this.capacity]!;
      if (options.after !== undefined && slot.entry.seq <= options.after) continue;
      if (options.level && slot.entry.level !== options.level) continue;
      result.push(slot.entry);
    }
    return options.limit !== undefined && result.length > options.limit
      ? result.slice(result.length - options.limit)
      : result;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    this.emitter.emit("clear");
  }

  stats() {
    return { size: this.count, capacity: this.capacity, bytes: this.bytes, maxBytes: this.maxBytes, lastSeq: this.seq };
  }

  subscribe(onEntry: (entry: LogEntry) => void, onClear?: () => void): () => void {
    this.emitter.on("entry", onEntry);
    if (onClear) this.emitter.on("clear", onClear);
    return () => {
      this.emitter.off("entry", onEntry);
      if (onClear) this.emitter.off("clear", onClear);
    };
  }

  private evictOldest(): void {
    const slot = this.slots[this.head];
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    this.bytes -= slot?.bytes ?? 0;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** Process-wide buffer shared by the Fastify logger, console and routes. */
export const serverLogs = new LogBuffer();
export const logEmitter = serverLogs.emitter;

// ---------------------------------------------------------------------------
// Capture: pino (Fastify) stream, console, process events
// ---------------------------------------------------------------------------

let capturing = false;

function record(buffer: LogBuffer, input: LogInput): void {
  // A subscriber that itself logs (or a console patched by a test runner)
  // must not recurse back into the buffer.
  if (capturing) return;
  capturing = true;
  try {
    buffer.push(input);
  } catch {
    // Logging must never break the caller.
  } finally {
    capturing = false;
  }
}

function pinoLevel(level: unknown): LogLevel {
  const numeric = typeof level === "number" ? level : 30;
  if (numeric >= 50) return "error";
  if (numeric >= 40) return "warn";
  if (numeric >= 30) return "info";
  return "debug";
}

const PINO_INTERNAL_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "err", "error", "v"]);

export function parsePinoLine(line: string): LogInput | null {
  let record: Record<string, any>;
  try {
    record = JSON.parse(line);
  } catch {
    const text = line.trim();
    return text ? { level: "info", source: "server", message: text } : null;
  }
  if (!record || typeof record !== "object") return null;

  const err = record.err ?? record.error;
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PINO_INTERNAL_KEYS.has(key)) meta[key] = value;
  }
  if (err && typeof err === "object") {
    for (const key of ["type", "code", "statusCode"]) {
      if (err[key] !== undefined) meta[`err.${key}`] = err[key];
    }
  }

  let message = typeof record.msg === "string" ? record.msg : "";
  if (!message && err?.message) message = String(err.message);
  if (record.req?.method && record.req?.url) message = `${message} ${record.req.method} ${record.req.url}`.trim();
  if (record.res?.statusCode !== undefined) {
    const took = typeof record.responseTime === "number" ? ` (${record.responseTime.toFixed(1)}ms)` : "";
    message = `${message} ${record.res.statusCode}${took}`.trim();
  }

  return {
    level: pinoLevel(record.level),
    source: "server",
    message: message || "(empty log line)",
    stack: typeof err?.stack === "string" ? err.stack : undefined,
    meta,
    time: typeof record.time === "number" ? record.time : undefined,
  };
}

/**
 * Destination for Fastify's pino logger: forwards each line to the original
 * output (Docker/terminal logs keep working) and records a structured copy.
 */
export function createLogCaptureStream(
  buffer: LogBuffer = serverLogs,
  target: { write(chunk: string): unknown } = process.stdout,
) {
  return {
    write(chunk: string) {
      target.write(chunk);
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        const parsed = parsePinoLine(line);
        if (parsed) record(buffer, parsed);
      }
    },
  };
}

const CONSOLE_LEVELS: Array<[keyof Console, LogLevel]> = [
  ["error", "error"],
  ["warn", "warn"],
  ["log", "info"],
  ["info", "info"],
  ["debug", "debug"],
];

export function formatConsoleArgs(args: unknown[]): { message: string; stack?: string } {
  const error = args.find((arg): arg is Error => arg instanceof Error);
  const message = formatWithOptions(
    { colors: false, depth: 4, breakLength: Infinity },
    ...args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : arg)),
  );
  return { message, stack: error?.stack };
}

let consolePatched = false;
let processHooked = false;

/**
 * Mirror console.* into the buffer (the original method still prints) and
 * capture process-level failures. Idempotent.
 */
export function installLogCapture(buffer: LogBuffer = serverLogs): void {
  if (!consolePatched) {
    consolePatched = true;
    for (const [method, level] of CONSOLE_LEVELS) {
      const original = (console[method] as (...args: unknown[]) => void).bind(console);
      (console as any)[method] = (...args: unknown[]) => {
        original(...args);
        const { message, stack } = formatConsoleArgs(args);
        record(buffer, { level, source: "console", message, stack });
      };
    }
  }

  if (!processHooked) {
    processHooked = true;
    // Registering this listener stops Node from crashing on a stray rejected
    // promise; the rejection is logged loudly instead. Truly uncaught
    // exceptions still terminate the process (see the monitor below).
    process.on("unhandledRejection", (reason) => {
      const error = reason instanceof Error ? reason : undefined;
      const text = error ? `${error.name}: ${error.message}` : formatConsoleArgs([reason]).message;
      process.stderr.write(`Unhandled promise rejection: ${error?.stack ?? text}\n`);
      record(buffer, {
        level: "error",
        source: "process",
        message: `Unhandled promise rejection: ${text}`,
        stack: error?.stack,
      });
    });
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      record(buffer, {
        level: "error",
        source: "process",
        message: `Uncaught exception (${origin}): ${error?.message ?? String(error)}`,
        stack: error?.stack,
      });
    });
    process.on("warning", (warning) => {
      record(buffer, {
        level: "warn",
        source: "process",
        message: `${warning.name}: ${warning.message}`,
        stack: warning.stack,
      });
    });
  }
}
