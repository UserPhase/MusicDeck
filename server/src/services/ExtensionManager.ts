import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { PrivacyManager } from "./PrivacyManager.js";
import { redactText } from "../utils/logger.js";
import { TaskManager, type TaskDefinition, type TaskInterceptor, type TaskRunContext } from "./TaskManager.js";

const manifestSchema = z.object({
  apiVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(120), version: z.string().min(1).max(80),
  description: z.string().max(1000).default(""), entry: z.literal("index.mjs"),
}).strict();
export type ExtensionManifest = z.infer<typeof manifestSchema>;
export type ExtensionStatus = "disabled" | "starting" | "enabled" | "stopping" | "error";
export interface ExtensionInfo extends ExtensionManifest {
  enabled: boolean; status: ExtensionStatus; error: string | null;
}
export type ExtensionRoute = (request: FastifyRequest, reply: FastifyReply, signal: AbortSignal) => Promise<unknown>;
export interface ExtensionContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly network: { fetch: typeof fetch };
  readonly logging: Pick<Console, "info" | "warn" | "error">;
  /** Only optional audio analysis may supply a runner; core runners cannot be replaced. */
  readonly tasks: { registerAudioAnalysis(definition: TaskDefinition<unknown>): void };
}
export interface ExtensionHooks {
  onServerStart?(context: ExtensionContext): Promise<void>;
  registerRoutes?(register: (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", route: string, handler: ExtensionRoute) => void): void | Promise<void>;
  interceptTaskRunner?: TaskInterceptor;
  onServerStop?(): Promise<void>;
}
interface Runtime {
  hooks: ExtensionHooks; controller: AbortController; routes: Map<string, ExtensionRoute>;
  pending: Set<Promise<unknown>>; dispose: Array<() => void>; accepting: boolean;
}
interface RecordState {
  manifest: ExtensionManifest; directory: string; fingerprint: string;
  status: ExtensionStatus; error: string | null; runtime?: Runtime;
}
interface Stored { extension_id: string; enabled: number; }
export class ExtensionError extends Error {
  constructor(readonly code: "EXTENSION_NOT_FOUND" | "EXTENSION_CONFLICT" | "EXTENSION_FAILED", message: string) { super(message); }
}
const hooksSchema = z.object({
  onServerStart: z.custom<NonNullable<ExtensionHooks["onServerStart"]>>((value) => typeof value === "function").optional(),
  registerRoutes: z.custom<NonNullable<ExtensionHooks["registerRoutes"]>>((value) => typeof value === "function").optional(),
  interceptTaskRunner: z.custom<TaskInterceptor>((value) => typeof value === "function").optional(),
  onServerStop: z.custom<NonNullable<ExtensionHooks["onServerStop"]>>((value) => typeof value === "function").optional(),
}).strict();
const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const routeSchema = z.string().regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).max(200);

/** Trusted local modules, not a JavaScript sandbox. Only enabled factories execute. */
export class ExtensionManager {
  private readonly records = new Map<string, RecordState>();
  private readonly loaded = new Map<string, { fingerprint: string; factory: () => unknown }>();
  private readonly issues: string[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly root: string;

  constructor(private readonly db: Db, directory: string, private readonly tasks: TaskManager,
    private readonly logger: Pick<Console, "info" | "warn" | "error">, private readonly privacy: PrivacyManager) {
    this.root = path.resolve(directory);
    db.exec(`CREATE TABLE IF NOT EXISTS server_extensions (
      extension_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      updated_at TEXT NOT NULL
    )`);
  }
  list(): { extensions: ExtensionInfo[]; issues: string[] } {
    return { extensions: [...this.records.values()].map((record) => this.info(record))
      .sort((a, b) => a.id.localeCompare(b.id)), issues: [...this.issues] };
  }
  private info(record: RecordState): ExtensionInfo {
    return { ...record.manifest, enabled: record.status === "enabled", status: record.status, error: record.error };
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action);
    this.serial = next.catch(() => {});
    return next;
  }
  async start(): Promise<void> {
    await this.discover();
    const desired = this.db.prepare("SELECT extension_id, enabled FROM server_extensions WHERE enabled = 1").all() as Stored[];
    for (const row of desired) {
      if (!this.records.has(row.extension_id)) {
        this.logger.error(`Enabled extension ${row.extension_id} is missing`); continue;
      }
      try { await this.setEnabled(row.extension_id, true); }
      catch (error) { this.logger.error({ extensionId: row.extension_id, err: error }, "Extension startup failed"); }
    }
  }
  discover(): Promise<{ extensions: ExtensionInfo[]; issues: string[] }> {
    return this.exclusive(async () => {
      if (this.closing) throw new ExtensionError("EXTENSION_CONFLICT", "The extension manager is shutting down");
      this.issues.length = 0;
      let folders;
      try { folders = await fs.readdir(this.root, { withFileTypes: true }); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          if (this.records.size) {
            this.issues.push("The extensions directory is missing. Loaded modules remain until disabled.");
            this.logger.warn(this.issues[0]);
          }
          this.reportMissingInstallations();
          return this.list();
        }
        this.logger.error({ err: error }, "Could not inspect extensions directory");
        throw new ExtensionError("EXTENSION_FAILED", "Could not inspect the extensions directory. Review server logs.");
      }
      const realRoot = await fs.realpath(this.root);
      const seen = new Set<string>();
      for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!folder.isDirectory() && !folder.isSymbolicLink()) continue;
        try {
          if (folder.isSymbolicLink()) throw new Error("Extension directory links are not allowed");
          const directory = path.join(realRoot, folder.name);
          const manifestPath = path.join(directory, "extension.json");
          const entryPath = path.join(directory, "index.mjs");
          for (const file of [manifestPath, entryPath]) {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Extension manifest and entry must be regular files");
          }
          if ((await fs.stat(manifestPath)).size > 16 * 1024) throw new Error("Extension manifest exceeds 16 KiB");
          const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
          if (manifest.id !== folder.name) throw new Error("Extension ID must match its directory");
          const fingerprint = await this.fingerprint(directory);
          const existing = this.records.get(manifest.id);
          if (existing && (existing.fingerprint !== fingerprint || existing.directory !== directory)) {
            seen.add(manifest.id);
            throw new Error("Installed extension files changed. Restart the server to load replacement code");
          }
          seen.add(manifest.id);
          if (!existing) this.records.set(manifest.id, { manifest, directory, fingerprint, status: "disabled", error: null });
        } catch (error) {
          const message = `Could not discover extension ${folder.name}. Review its manifest, regular files and server logs.`;
          this.issues.push(message); this.logger.error({ directory: folder.name, err: error }, message);
        }
      }
      for (const [id, record] of this.records) {
        if (seen.has(id)) continue;
        if (record.runtime) this.issues.push(`Extension ${id} was removed from disk. Disable it to stop its loaded runtime.`);
        else this.records.delete(id);
      }
      this.reportMissingInstallations();
      return this.list();
    });
  }
  private reportMissingInstallations(): void {
    const desired = this.db.prepare("SELECT extension_id, enabled FROM server_extensions WHERE enabled = 1").all() as Stored[];
    for (const row of desired) {
      if (!this.records.has(row.extension_id)) {
        const message = `Enabled extension ${row.extension_id} is missing. Restore its reviewed files and scan, then disable it if no longer needed.`;
        this.issues.push(message);
        this.logger.warn(message);
      }
    }
  }
  private async fingerprint(directory: string): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await fs.readFile(path.join(directory, "extension.json")));
    const file = await fs.open(path.join(directory, "index.mjs"), "r");
    try { for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes); }
    finally { await file.close(); }
    return hash.digest("hex");
  }
  setEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
    return this.exclusive(async () => {
      if (this.closing) throw new ExtensionError("EXTENSION_CONFLICT", "The extension manager is shutting down");
      const record = this.records.get(id);
      if (!record) throw new ExtensionError("EXTENSION_NOT_FOUND", "Extension not found. Scan for installed extensions first.");
      if (enabled && record.status === "enabled") return this.info(record);
      if (enabled && record.runtime) throw new ExtensionError("EXTENSION_CONFLICT", "Disable the failed runtime completely before enabling it again");
      if (!enabled) {
        this.persist(id, false);
        if (record.runtime) await this.stop(record);
        record.status = "disabled"; record.error = null;
      } else await this.enable(record);
      return this.info(record);
    });
  }
  private persist(id: string, enabled: boolean): void {
    this.db.prepare(`INSERT INTO server_extensions (extension_id, enabled, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(extension_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(id, enabled ? 1 : 0, new Date().toISOString());
  }
  private async enable(record: RecordState): Promise<void> {
    const id = record.manifest.id;
    record.status = "starting"; record.error = null;
    try {
      for (const file of ["extension.json", "index.mjs"]) {
        const stat = await fs.lstat(path.join(record.directory, file));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Extension files must not be symlinks");
      }
      if (await fs.realpath(record.directory) !== record.directory || await this.fingerprint(record.directory) !== record.fingerprint) {
        throw new Error("Extension files changed since discovery; restart after reviewing replacement code");
      }
      let loaded = this.loaded.get(id);
      if (!loaded) {
        const module: unknown = await import(pathToFileURL(path.join(record.directory, "index.mjs")).href);
        const exported = z.object({ default: z.custom<() => unknown>((value) => typeof value === "function",
          "Extension must export a default synchronous createExtension factory") }).parse(module);
        const factory = exported.default;
        loaded = { fingerprint: record.fingerprint, factory }; this.loaded.set(id, loaded);
      }
      if (loaded.fingerprint !== record.fingerprint) throw new Error("Extension module changed; restart required");
      const hooks = hooksSchema.parse(loaded.factory());
      const runtime: Runtime = { hooks, controller: new AbortController(), routes: new Map(), pending: new Set(), dispose: [], accepting: false };
      record.runtime = runtime;
      let definition: TaskDefinition<unknown> | undefined;
      let collecting = true;
      const log = (level: "info" | "warn" | "error", message: unknown) =>
        this.logger[level](`[extension:${id}] ${redactText(String(message)).slice(0, 2000)}`);
      const context: ExtensionContext = Object.freeze({
        id, signal: runtime.controller.signal,
        network: Object.freeze({ fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          const signal = requestSignal ? AbortSignal.any([requestSignal, runtime.controller.signal]) : runtime.controller.signal;
          return this.privacy.fetch(input, { ...init, signal });
        } }),
        logging: Object.freeze({ info: (message: unknown) => log("info", message),
          warn: (message: unknown) => log("warn", message), error: (message: unknown) => log("error", message) }),
        tasks: Object.freeze({ registerAudioAnalysis: (runner: TaskDefinition<unknown>) => {
          if (!collecting || definition) throw new Error("Register one audio-analysis runner during onServerStart");
          if (typeof runner?.validate !== "function" || typeof runner.run !== "function") throw new Error("Invalid task definition");
          definition = runner;
        } }),
      });
      await hooks.onServerStart?.(context);
      await hooks.registerRoutes?.((method, route, handler) => {
        methodSchema.parse(method); routeSchema.parse(route);
        if (!collecting || typeof handler !== "function") throw new Error("Routes must be registered during activation");
        const key = `${method} ${route}`;
        if (runtime.routes.has(key)) throw new Error(`Duplicate extension route ${key}`);
        if (runtime.routes.size >= 100) throw new Error("An extension may register at most 100 routes");
        runtime.routes.set(key, handler);
      });
      collecting = false; runtime.accepting = true;
      if (hooks.interceptTaskRunner) {
        const interceptor = hooks.interceptTaskRunner;
        runtime.dispose.push(this.tasks.intercept(`extension:${id}`, async (task, taskContext, next) => {
          if (!runtime.accepting || task.type !== "AUDIO_ANALYSIS") return next();
          await this.runTask(runtime, taskContext, (context) => interceptor(task, context, next));
        }));
      }
      if (definition) {
        const runner = definition;
        this.tasks.register("AUDIO_ANALYSIS", { validate: (value): value is unknown => runtime.accepting && runner.validate(value),
          run: (payload, taskContext) => this.runTask(runtime, taskContext, async (context) => {
            if (!runtime.accepting) throw new Error("Extension has been disabled");
            await runner.run(payload, context);
          }) });
        runtime.dispose.push(() => this.tasks.unregister("AUDIO_ANALYSIS"));
      }
      this.persist(id, true); record.status = "enabled";
    } catch (error) {
      this.logger.error({ extensionId: id, err: error }, "Extension activation failed");
      if (record.runtime) {
        try { await this.stop(record); }
        catch (cleanupError) { this.logger.error({ extensionId: id, err: cleanupError }, "Extension rollback failed"); }
      }
      record.status = "error"; record.error = "Extension activation failed. Review server logs, then disable to finish cleanup before retrying.";
      throw new ExtensionError("EXTENSION_FAILED", record.error);
    }
  }
  private runTask(runtime: Runtime, context: TaskRunContext, work: (context: TaskRunContext) => Promise<void>): Promise<void> {
    return this.run(runtime, async () => {
      const signal = runtime.controller.signal;
      const cancel = () => {
        const task = this.tasks.get(context.taskId);
        if (!task || !["QUEUED", "PROCESSING", "PAUSED"].includes(task.state)) return;
        void this.run(runtime, () => this.tasks.cancel(context.taskId)).catch((error) => {
          this.logger.error({ taskId: context.taskId, err: error }, "Could not cancel extension task");
        });
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const combined = AbortSignal.any([context.signal, signal]);
      try {
        combined.throwIfAborted();
        await work({ ...context, signal: combined,
          throwIfCancelled: () => { combined.throwIfAborted(); context.throwIfCancelled(); },
          checkpoint: async () => { combined.throwIfAborted(); await context.checkpoint(); combined.throwIfAborted(); },
        });
      } finally { signal.removeEventListener("abort", cancel); }
    });
  }
  private run<T>(runtime: Runtime, work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    runtime.pending.add(operation);
    void operation.finally(() => runtime.pending.delete(operation)).catch(() => {});
    return operation;
  }
  async dispatch(id: string, method: string, route: string, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const runtime = this.records.get(id)?.runtime;
    if (!runtime?.accepting) throw new ExtensionError("EXTENSION_NOT_FOUND", "Extension is disabled or unavailable");
    const handler = runtime.routes.get(`${method} ${route}`);
    if (!handler) throw new ExtensionError("EXTENSION_NOT_FOUND", "Extension route not found");
    return this.run(runtime, () => handler(request, reply, runtime.controller.signal));
  }
  private async stop(record: RecordState): Promise<void> {
    const runtime = record.runtime;
    if (!runtime) return;
    record.status = "stopping"; runtime.accepting = false;
    runtime.dispose.splice(0).reverse().forEach((dispose) => dispose());
    runtime.controller.abort(new DOMException("Extension disabled", "AbortError"));
    try {
      while (runtime.pending.size) await Promise.allSettled([...runtime.pending]);
      await runtime.hooks.onServerStop?.();
      record.runtime = undefined;
    } catch (error) {
      this.logger.error({ extensionId: record.manifest.id, err: error }, "Extension shutdown failed");
      record.status = "error"; record.error = "Extension cleanup failed. Review server logs and retry disabling.";
      throw new ExtensionError("EXTENSION_FAILED", record.error);
    }
  }
  close(): Promise<void> {
    this.closing = true;
    return this.exclusive(async () => {
      const failures: unknown[] = [];
      for (const record of this.records.values()) {
        try { await this.stop(record); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Extension shutdown failed");
    });
  }
}
