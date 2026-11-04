import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { autoDetectSpotDLPath, autoDetectFFmpegPath } from "../domain/spotdl-downloader-adapter.js";
import { DefaultProcessRunner, type ProcessRunner } from "../domain/process-runner.js";
import { configurationSnapshot, systemPaths, type SystemConfiguration } from "./systemConfiguration.js";

export type DiagnosticStatus = "pass" | "warning" | "fail";
export interface DiagnosticCheck { id: string; category: "connection" | "storage" | "dependencies" | "database"; title: string; status: DiagnosticStatus; message: string; fix: string; durationMs: number }
export interface DiagnosticReport { checkedAt: string; status: DiagnosticStatus; ready: boolean; checks: DiagnosticCheck[] }
export class SystemHealthWizard {
  private running: Promise<DiagnosticReport> | null = null;
  constructor(private readonly db: Db, private readonly config: AppConfig,
    private readonly options: { fetch?: typeof fetch; runner?: ProcessRunner; timeoutMs?: number } = {}) {}
  run(candidate: SystemConfiguration = configurationSnapshot(this.config)): Promise<DiagnosticReport> {
    // Requests for custom candidates remain independent of the regular dashboard run.
    return this.inspect(candidate);
  }
  runConfigured(): Promise<DiagnosticReport> {
    if (!this.running) this.running = this.inspect(configurationSnapshot(this.config)).finally(() => { this.running = null; });
    return this.running;
  }
  private async inspect(candidate: SystemConfiguration): Promise<DiagnosticReport> {
    const paths = systemPaths(this.config);
    const tasks: Array<() => Promise<DiagnosticCheck>> = [
      () => this.connection(candidate),
      () => this.directory("database-directory", "Database and configuration directory", paths.root, true),
      () => this.directory("music-directory", "Music library directory", path.resolve(candidate.musicRoot), true),
      () => this.directory("download-directory", "Download staging directory", path.resolve(candidate.acquisitionTmpDir), true),
      () => this.directory("artwork-directory", "Artwork cache directory", paths.artwork, false),
      () => this.directory("backup-directory", "Backup directory", paths.backups, false),
      () => this.dependency("spotdl", "spotDL", this.toolPath("spotdlPath", process.env.SPOTDL_PATH || autoDetectSpotDLPath()), ["--version"]),
      () => this.dependency("ffmpeg", "FFmpeg", this.toolPath("ffmpegPath", process.env.FFMPEG_PATH || autoDetectFFmpegPath()), ["-version"]),
      () => this.database(),
    ];
    const checks = await Promise.all(tasks.map((task) => task()));
    const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warning") ? "warning" : "pass";
    return { checkedAt: new Date().toISOString(), status, ready: !checks.some((check) => check.status === "fail"), checks };
  }
  private toolPath(key: string, fallback: string): string {
    try {
      const row = this.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = ?").get("spotdl-downloader") as { config_json: string } | undefined;
      if (row) { const value = JSON.parse(row.config_json)[key]; if (typeof value === "string" && value.trim()) return value.trim(); }
    } catch { /* The database diagnostic reports unavailable tables; tool checks can still inspect auto-detected paths. */ }
    return fallback;
  }
  private async connection(config: SystemConfiguration): Promise<DiagnosticCheck> {
    const started = Date.now(), jellyfin = config.backend === "jellyfin", id = "backend-connection";
    const title = jellyfin ? "Jellyfin connection and API key" : "Navidrome connection and credentials";
    const result = (status: DiagnosticStatus, message: string, fix = ""): DiagnosticCheck => ({ id, category: "connection", title, status, message, fix, durationMs: Date.now() - started });
    const target = jellyfin ? config.jellyfin.url : config.navidrome.url;
    let endpoint: URL;
    try {
      endpoint = new URL(target);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    } catch { return result("fail", "The configured backend URL is invalid.", "Enter an HTTP(S) backend URL without embedded credentials or query parameters."); }
    if (jellyfin ? !config.jellyfin.apiKey : !config.navidrome.username || !config.navidrome.password) return result("fail", "Backend credentials have not been configured.", jellyfin ? "Create an API key in Jellyfin Dashboard → API Keys and save it in Setup." : "Enter a Navidrome username and password in Setup.");
    const headers: Record<string, string> = { accept: "application/json" };
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${jellyfin ? "System/Info" : "rest/ping.view"}`;
    if (jellyfin) headers["X-Emby-Token"] = config.jellyfin.apiKey;
    else {
      const salt = randomUUID();
      endpoint.search = new URLSearchParams({ u: config.navidrome.username, t: createHash("md5").update(config.navidrome.password + salt).digest("hex"), s: salt, v: "1.16.1", c: "MusicDeck", f: "json" }).toString();
    }
    try {
      const response = await (this.options.fetch || fetch)(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs || 8000) });
      if ([401, 403].includes(response.status)) { await response.body?.cancel(); return result("fail", "The backend rejected the credentials.", jellyfin ? "Replace the API key with a valid key from this Jellyfin server." : "Verify the Navidrome username/password and the account's Subsonic API access."); }
      if (!response.ok) { await response.body?.cancel(); return result("fail", `The backend returned HTTP ${response.status}.`, "Check the server URL, reverse-proxy base path, and upstream service logs. Redirects are not followed."); }
      // Bound JSON responses: a mistaken proxy must not stream an entire media file into RAM.
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) throw new Error("empty response");
      try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1024 * 1024) throw new Error("oversized response"); chunks.push(item.value); } } finally { await reader.cancel().catch(() => undefined); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (jellyfin ? typeof data.Version !== "string" || !data.Id : data["subsonic-response"]?.status !== "ok") return result("fail", "The endpoint did not confirm an authenticated backend response.", "Check credentials and ensure the URL points to the media server rather than its login page or another proxy service.");
      return result("pass", `Authenticated successfully with ${jellyfin ? "Jellyfin" : "Navidrome"}.`);
    } catch { return result("fail", "The backend could not be reached or returned an invalid response.", "Check DNS, Docker service names, the reverse-proxy base path, TLS trust, firewall rules, and whether the backend is running. Requests time out after eight seconds."); }
  }
  private async directory(id: string, title: string, directory: string, required: boolean): Promise<DiagnosticCheck> {
    const started = Date.now(), probe = path.join(directory, `.musicdeck-write-check-${randomUUID()}`);
    const base = { id, title, category: "storage" as const };
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) throw new Error("not a directory");
      await fs.access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
      const file = await fs.open(probe, "wx", 0o600);
      try { await file.writeFile("MusicDeck permission probe"); await file.sync(); } finally { await file.close(); }
      await fs.unlink(probe);
      return { ...base, status: "pass", message: `Read/write test succeeded: ${directory}`, fix: "", durationMs: Date.now() - started };
    } catch (error) {
      await fs.unlink(probe).catch(() => undefined);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return { ...base, status: missing && !required ? "warning" : "fail", message: missing ? `Directory does not exist: ${directory}` : `Directory is not writable: ${directory}`,
        fix: missing ? `Create ${directory} as the MusicDeck service user, or mount the correct directory in the container.` : `Check the volume's read-only flag, free disk space, and ownership for service UID ${process.getuid?.() ?? "the configured service account"}. Grant that account read/write/search permission on this directory; do not make the whole music tree world-writable.`, durationMs: Date.now() - started };
    }
  }
  private async dependency(id: string, title: string, command: string, args: string[]): Promise<DiagnosticCheck> {
    const started = Date.now();
    try {
      const result = await (this.options.runner || new DefaultProcessRunner()).run(command, args, { timeoutMs: 8000 }).promise;
      if (result.exitCode !== 0) throw new Error();
      return { id, title, category: "dependencies", status: "pass", message: `Executable responds: ${command}`, fix: "", durationMs: Date.now() - started };
    } catch { return { id, title, category: "dependencies", status: "warning", message: `Executable is missing, not executable, or failed: ${command}`, fix: id === "spotdl" ? "Install spotDL in the server/container, then set its executable path under Admin → Plugins → spotDL. Streaming existing music does not require spotDL." : "Install FFmpeg in the server/container and configure its executable path under Admin → Plugins → spotDL.", durationMs: Date.now() - started }; }
  }
  private async database(): Promise<DiagnosticCheck> {
    const started = Date.now(), base = { id: "database-integrity", category: "database" as const, title: "SQLite integrity and write lock" };
    if (this.db.inTransaction) return { ...base, status: "warning", message: "A database transaction is already active; the diagnostic did not interrupt it.", fix: "Retry the health check after the current database operation completes.", durationMs: Date.now() - started };
    try {
      const checks = this.db.pragma("quick_check") as Array<{ quick_check: string }>;
      const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
      if (checks.some((check) => check.quick_check !== "ok") || foreignKeys.length) throw new Error("integrity");
      const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((table) => table.name));
      if (["users", "server_settings", "schema_migrations", "backend_connections", "plugin_configs"].some((table) => !tables.has(table))) throw new Error("application schema");
      this.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      return { ...base, status: "pass", message: "SQLite quick_check and foreign-key checks passed; a write reservation was available.", fix: "", durationMs: Date.now() - started };
    } catch {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      return { ...base, status: "fail", message: "SQLite failed an integrity check or could not obtain a write reservation.", fix: "Check free disk space, database-directory permissions, and competing SQLite writers. Stop other MusicDeck instances. If corruption persists, restore a verified backup; do not copy a live WAL database file.", durationMs: Date.now() - started };
    }
  }
}
