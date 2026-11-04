import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import archiver from "archiver";
import { extract } from "tar-stream";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Db } from "../db/database.js";
import type { AppConfig } from "../config.js";
import { validateConfig } from "../config.js";
import { configurationSnapshot, durableJson, syncDirectory, systemConfigurationSchema, systemPaths, type SystemConfiguration } from "./systemConfiguration.js";

export const MAX_BACKUP_UPLOAD = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const idSchema = z.string().uuid();
const fileSchema = z.object({ path: z.string(), size: z.number().int().nonnegative().max(MAX_EXPANDED_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({ format: z.literal("musicdeck-system"), version: z.literal(1), createdAt: z.iso.datetime(), schema: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(fileSchema).min(2).max(10002), mediaIncluded: z.literal(false) }).strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
export interface BackupFile { id: string; filename: string; bytes: number; createdAt: string; kind: "system" | "safety" }
export interface RecoveryLifecycle { quiesce(): Promise<void>; closeDatabase(): void; restart(): Promise<void> }
export interface PreparedRestore { id: string; kind: "restore" | "configuration"; manifest?: BackupManifest }
export interface RecoveryStatus { state: "idle" | "validating" | "backup" | "stopping" | "installing" | "restarting" | "complete" | "failed"; message: string; updatedAt: string; safetyBackupId?: string; error?: string }
const journalSchema = z.object({ version: z.literal(1), id: idSchema, phase: z.enum(["installing", "committed"]), hadConfig: z.boolean(), hadArtwork: z.boolean(), replaceArtwork: z.boolean() }).strict();
type Journal = z.infer<typeof journalSchema>;
export class RecoveryError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); this.name = "RecoveryError"; } }

function removeTree(file: string, root: string): void {
  const target = path.resolve(file), boundary = path.resolve(root);
  if (!target.startsWith(`${boundary}${path.sep}`)) throw new RecoveryError("Refusing to remove a path outside the recovery directory.");
  fs.rmSync(target, { recursive: true, force: true });
}
function regular(file: string): boolean {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function databaseSchema(db: Db): string {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function validArchivePath(name: string): boolean {
  if (name.length > 1024) return false;
  if (["database.sqlite", "config.json"].includes(name)) return true;
  return /^artwork\/[a-zA-Z0-9_./ -]+\.(?:json|png|jpe?g|webp|gif|avif)$/i.test(name) && !name.split("/").some((part) => !part || part === "." || part === "..");
}
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
async function syncFile(file: string): Promise<void> { const handle = await fsp.open(file, "r+"); try { await handle.sync(); } finally { await handle.close(); } }
function restoreJournal(config: AppConfig, journal: Journal): void {
  const paths = systemPaths(config), stage = path.join(paths.recovery, journal.id);
  const artifacts = [
    { live: paths.database, old: path.join(stage, "old-database.sqlite"), existed: true, directory: false },
    { live: paths.configuration, old: path.join(stage, "old-config.json"), existed: journal.hadConfig, directory: false },
    ...(journal.replaceArtwork ? [{ live: paths.artwork, old: path.join(stage, "old-artwork"), existed: journal.hadArtwork, directory: true }] : []),
  ];
  for (const artifact of artifacts) {
    if (fs.existsSync(artifact.old)) {
      if (artifact.live === paths.database) for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(`${paths.database}${suffix}`, { force: true });
      if (artifact.directory) removeTree(artifact.live, paths.root); else fs.rmSync(artifact.live, { force: true });
      fs.renameSync(artifact.old, artifact.live);
    } else if (!artifact.existed) {
      if (artifact.directory) removeTree(artifact.live, paths.root); else fs.rmSync(artifact.live, { force: true });
    } else if (!fs.existsSync(artifact.live)) throw new RecoveryError("Recovery journal has no original database/configuration file. Use the pre-restore safety archive.", 500);
    syncDirectory(paths.root); syncDirectory(stage);
  }
}
/** Must run before loading config.json or opening SQLite after a process crash. */
export function recoverInterruptedRestore(config: AppConfig): boolean {
  if (config.databasePath === ":memory:") return false;
  const paths = systemPaths(config), file = path.join(paths.recovery, "journal.json");
  if (!fs.existsSync(file)) return false;
  if (!regular(file) || fs.statSync(file).size > 16384) throw new RecoveryError("Invalid restore journal; refusing to start with mixed recovery state.", 500);
  const journal = journalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (journal.phase !== "committed") restoreJournal(config, journal);
  let safetyBackupId: string | undefined;
  const statusFile = path.join(paths.recovery, "status.json");
  if (regular(statusFile) && fs.statSync(statusFile).size < 65536) {
    try { const status = JSON.parse(fs.readFileSync(statusFile, "utf8")); if (idSchema.safeParse(status.safetyBackupId).success) safetyBackupId = status.safetyBackupId; } catch { /* Recovery must not depend on an optional status report. */ }
  }
  durableJson(statusFile, { state: journal.phase === "committed" ? "complete" : "failed", message: journal.phase === "committed" ? "Restore was committed; startup finished recovery cleanup." : "An interrupted restore was rolled back before startup. The original system data was recovered.", updatedAt: new Date().toISOString(), ...(safetyBackupId ? { safetyBackupId } : {}) });
  fs.rmSync(file); syncDirectory(paths.recovery);
  removeTree(path.join(paths.recovery, journal.id), paths.recovery);
  return true;
}

export class BackupRestoreService {
  private busy = false;
  private prepared: PreparedRestore | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly paths;
  constructor(private readonly db: Db, private readonly config: AppConfig,
    private readonly options: { lifecycle?: RecoveryLifecycle; afterInstall?: () => void; now?: () => Date } = {}) { this.paths = systemPaths(config); }
  status(): RecoveryStatus {
    const file = path.join(this.paths.recovery, "status.json");
    if (!regular(file)) return { state: "idle", message: "Ready", updatedAt: new Date().toISOString() };
    if (fs.statSync(file).size > 65536) throw new RecoveryError("Invalid recovery status file.", 500);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  private update(state: RecoveryStatus["state"], message: string, extra: Partial<RecoveryStatus> = {}): void {
    durableJson(path.join(this.paths.recovery, "status.json"), { state, message, updatedAt: new Date().toISOString(), ...extra });
  }
  private initialize(): void {
    if (this.config.databasePath === ":memory:") throw new RecoveryError("System recovery requires a persistent SQLite database.", 409);
    for (const directory of [this.paths.root, this.paths.recovery, this.paths.backups]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new RecoveryError("Recovery paths must be real directories, not symbolic links.", 409);
    }
  }
  private lock(): void { if (this.busy) throw new RecoveryError("Another backup or restore is already running.", 409); this.initialize(); this.busy = true; }
  async listBackups(): Promise<BackupFile[]> {
    if (!fs.existsSync(this.paths.backups)) return [];
    const files: BackupFile[] = [];
    for (const entry of await fsp.readdir(this.paths.backups)) {
      const match = /^(system|safety)-([0-9a-f-]{36})\.tar\.gz$/.exec(entry);
      if (!match || !idSchema.safeParse(match[2]).success) continue;
      const file = path.join(this.paths.backups, entry); if (!regular(file)) continue;
      const stat = await fsp.stat(file);
      files.push({ id: match[2], filename: entry, kind: match[1] as BackupFile["kind"], bytes: stat.size, createdAt: stat.mtime.toISOString() });
    }
    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async backupPath(id: string): Promise<string> {
    idSchema.parse(id);
    const backup = (await this.listBackups()).find((item) => item.id === id);
    if (!backup) throw new RecoveryError("Backup not found.", 404);
    return path.join(this.paths.backups, backup.filename);
  }
  async createBackup(): Promise<BackupFile> {
    this.lock();
    try { this.update("backup", "Creating a consistent SQLite snapshot."); const result = await this.capture("system"); this.update("complete", "System backup created."); return result; }
    catch (error) { this.update("failed", "Backup failed; live data was not changed."); throw error; }
    finally { this.busy = false; }
  }
  private async onlineBackup(destination: string): Promise<void> {
    const started = Date.now();
    await this.db.backup(destination, { progress: () => { if (Date.now() - started > 120_000) throw new RecoveryError("SQLite backup exceeded two minutes; retry during a quieter period.", 503); return 128; } });
    await fsp.chmod(destination, 0o600); await syncFile(destination);
  }
  private inspectDatabase(file: string, expectedSchema: string): void {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.pragma("trusted_schema = OFF");
      if (databaseSchema(db) !== expectedSchema) throw new RecoveryError("Backup database schema does not match this MusicDeck build. Restore using the matching version first.");
      const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (result.length !== 1 || result[0].integrity_check !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length) throw new RecoveryError("Backup database failed SQLite integrity or foreign-key validation.");
      const admins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get() as { count: number };
      if (!admins.count) throw new RecoveryError("Backup has no active administrator account.");
    } finally { db.close(); }
  }
  private async capture(kind: BackupFile["kind"]): Promise<BackupFile> {
    const id = randomUUID(), stage = await fsp.mkdtemp(path.join(this.paths.recovery, "backup-"));
    const filename = `${kind}-${id}.tar.gz`, final = path.join(this.paths.backups, filename), temporary = `${final}.partial`;
    try {
      const database = path.join(stage, "database.sqlite"); await this.onlineBackup(database);
      const schema = databaseSchema(this.db); this.inspectDatabase(database, schema);
      const config = configurationSnapshot(this.config);
      durableJson(path.join(stage, "config.json"), config);
      const names = ["database.sqlite", "config.json"];
      if (fs.existsSync(this.paths.artwork)) {
        if (fs.lstatSync(this.paths.artwork).isSymbolicLink()) throw new RecoveryError("Artwork cache must not be a symbolic link.");
        const walk = async (directory: string, prefix: string): Promise<void> => {
          for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
            const name = `${prefix}/${item.name}`, source = path.join(directory, item.name);
            if (item.isSymbolicLink()) throw new RecoveryError("Artwork cache contains a symbolic link; remove it before backup.");
            if (item.isDirectory()) { await walk(source, name); continue; }
            if (!item.isFile() || !validArchivePath(name)) continue;
            if (names.length >= 10002 || (await fsp.stat(source)).size > 16 * 1024 * 1024) throw new RecoveryError("Artwork cache exceeds backup limits.");
            const destination = path.join(stage, name); await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL); names.push(name);
          }
        };
        await walk(this.paths.artwork, "artwork");
      }
      const files: BackupManifest["files"] = []; let total = 0;
      for (const name of names) { const file = path.join(stage, name), stat = await fsp.stat(file); total += stat.size; if (total > MAX_EXPANDED_BYTES) throw new RecoveryError("Backup exceeds the 1 GiB expanded size limit."); files.push({ path: name, size: stat.size, sha256: await digest(file) }); }
      const manifest: BackupManifest = { format: "musicdeck-system", version: 1, createdAt: (this.options.now?.() || new Date()).toISOString(), schema, files, mediaIncluded: false };
      const manifestJson = JSON.stringify(manifest);
      if (Buffer.byteLength(manifestJson) > MAX_MANIFEST_BYTES) throw new RecoveryError("Artwork inventory exceeds the archive manifest limit.");
      const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });
      const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      archive.on("warning", (error) => archive.destroy(error));
      const writing = pipeline(archive, output);
      // Manifest always precedes payload files. Each name is from our allowlist.
      archive.append(manifestJson, { name: "manifest.json", mode: 0o600 });
      for (const name of names) archive.file(path.join(stage, name), { name, mode: 0o600 });
      await Promise.all([archive.finalize(), writing]);
      const bytes = (await fsp.stat(temporary)).size;
      if (bytes > MAX_BACKUP_UPLOAD) throw new RecoveryError("Compressed backup exceeds the 256 MiB restore-upload limit.");
      await syncFile(temporary); await fsp.rename(temporary, final); syncDirectory(this.paths.backups);
      return { id, filename, bytes, kind, createdAt: manifest.createdAt };
    } finally { await fsp.rm(temporary, { force: true }); removeTree(stage, this.paths.recovery); }
  }
  async receiveUpload(source: Readable): Promise<string> {
    this.initialize(); const target = path.join(this.paths.recovery, `upload-${randomUUID()}.tar.gz`); let bytes = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, next) { bytes += chunk.length; next(bytes > MAX_BACKUP_UPLOAD ? new RecoveryError("Backup upload exceeds 256 MiB.", 413) : null, chunk); } });
    try { await pipeline(source, limit, fs.createWriteStream(target, { flags: "wx", mode: 0o600 })); if (!bytes) throw new RecoveryError("Backup file is empty."); return target; }
    catch (error) { await fsp.rm(target, { force: true }); throw error; }
  }
  async prepareRestore(upload: string): Promise<PreparedRestore> {
    try { this.lock(); }
    catch (error) {
      if (path.dirname(path.resolve(upload)) === this.paths.recovery && /^upload-[a-f0-9-]{36}\.tar\.gz$/.test(path.basename(upload))) await fsp.rm(upload, { force: true });
      throw error;
    }
    const id = randomUUID(), stage = path.join(this.paths.recovery, id);
    try {
      this.update("validating", "Validating the archive and SQLite database before stopping the server.");
      if (path.dirname(path.resolve(upload)) !== this.paths.recovery || !/^upload-[a-f0-9-]{36}\.tar\.gz$/.test(path.basename(upload)) || !regular(upload)) throw new RecoveryError("Invalid staged upload.");
      await fsp.mkdir(stage, { mode: 0o700 });
      const manifest = await this.unpack(upload, stage);
      if (manifest.schema !== databaseSchema(this.db)) throw new RecoveryError("Backup was created by an incompatible MusicDeck database schema.");
      this.inspectDatabase(path.join(stage, "database.sqlite"), manifest.schema);
      const config = systemConfigurationSchema.parse(JSON.parse(await fsp.readFile(path.join(stage, "config.json"), "utf8")));
      // Safety snapshots can represent an unfinished first-run setup. The main
      // runtime permits missing backend credentials so the admin wizard can fix
      // them; restoring that state must remain possible without weakening the
      // deployment/session-secret validation or accepting invalid URL schemes.
      validateConfig({ ...this.config, ...config, navidrome: { ...config.navidrome, username: config.navidrome.username || "setup", password: config.navidrome.password || "setup" }, jellyfin: { ...config.jellyfin, apiKey: config.jellyfin.apiKey || "setup" } });
      const staged = new Database(path.join(stage, "database.sqlite"));
      try { staged.exec("DELETE FROM sessions"); } finally { staged.close(); }
      await syncFile(path.join(stage, "database.sqlite"));
      this.prepared = { id, kind: "restore", manifest }; return this.prepared;
    } catch (error) { removeTree(stage, this.paths.recovery); this.busy = false; this.update("failed", "Backup validation failed; live data was not changed."); throw error; }
    finally { if (path.dirname(path.resolve(upload)) === this.paths.recovery && path.basename(upload).startsWith("upload-")) await fsp.rm(upload, { force: true }); }
  }
  async prepareConfiguration(config: SystemConfiguration): Promise<PreparedRestore> {
    const parsed = systemConfigurationSchema.parse(config); validateConfig({ ...this.config, ...parsed });
    this.lock(); const id = randomUUID(), stage = path.join(this.paths.recovery, id);
    try { await fsp.mkdir(stage, { mode: 0o700 }); durableJson(path.join(stage, "config.json"), parsed); this.prepared = { id, kind: "configuration" }; return this.prepared; }
    catch (error) { this.busy = false; removeTree(stage, this.paths.recovery); throw error; }
  }
  discardPrepared(plan: PreparedRestore): void {
    if (this.prepared?.id !== plan.id) return;
    try { removeTree(path.join(this.paths.recovery, idSchema.parse(plan.id)), this.paths.recovery); }
    finally { this.prepared = null; this.busy = false; }
    this.update("idle", "Staged recovery cancelled before changing live data.");
  }
  private async unpack(upload: string, stage: string): Promise<BackupManifest> {
    const tar = extract(), gunzip = createGunzip(); let expanded = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, next) { expanded += chunk.length; next(expanded > MAX_EXPANDED_BYTES + 16 * 1024 * 1024 ? new RecoveryError("Expanded archive exceeds its size limit.") : null, chunk); } });
    let producerError: unknown;
    const producing = pipeline(fs.createReadStream(upload), gunzip, limit, tar as unknown as Writable).catch((error) => { producerError = error; tar.destroy(error); });
    let manifest: BackupManifest | undefined; const seen = new Set<string>();
    try {
      for await (const entry of tar) {
        const header = entry.header, name = header.name;
        if (header.type !== "file" || seen.has(name) || seen.size > 10002 || !Number.isSafeInteger(header.size) || header.size < 0) throw new RecoveryError("Archive contains duplicate entries, links, devices, or invalid file headers.");
        seen.add(name);
        if (!manifest) {
          if (name !== "manifest.json" || header.size > MAX_MANIFEST_BYTES) throw new RecoveryError("Archive must begin with a valid MusicDeck manifest.");
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const value of entry) { const chunk = Buffer.from(value as Uint8Array); bytes += chunk.length; if (bytes > MAX_MANIFEST_BYTES) throw new RecoveryError("Manifest is too large."); chunks.push(chunk); }
          manifest = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const names = new Set(manifest.files.map((file) => file.path));
          if (names.size !== manifest.files.length || !names.has("database.sqlite") || !names.has("config.json") || manifest.files.some((file) => !validArchivePath(file.path)) || manifest.files.reduce((sum, file) => sum + file.size, 0) > MAX_EXPANDED_BYTES) throw new RecoveryError("Manifest has invalid, duplicate, oversized, or unsupported payload files.");
          continue;
        }
        const expected = manifest.files.find((file) => file.path === name);
        if (!expected || !validArchivePath(name) || header.size !== expected.size || (name === "config.json" && header.size > 1024 * 1024) || (name.startsWith("artwork/") && header.size > 16 * 1024 * 1024)) throw new RecoveryError("Archive payload does not match the manifest or allowed file limits.");
        const destination = path.join(stage, name); await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const hash = createHash("sha256"); let size = 0;
        const verifying = new Transform({ transform(chunk: Buffer, _encoding, next) { size += chunk.length; hash.update(chunk); next(size > expected.size ? new RecoveryError("Archive entry exceeds its declared size.") : null, chunk); } });
        await pipeline(entry as unknown as Readable, verifying, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new RecoveryError(`Backup checksum or size mismatch: ${name}`);
        await syncFile(destination);
      }
      await producing;
      if (producerError) throw producerError;
      if (!manifest || manifest.files.some((file) => !seen.has(file.path))) throw new RecoveryError("Backup is truncated or missing required payload files.");
      return manifest;
    } catch (error) { tar.destroy(error instanceof Error ? error : new Error("Invalid archive")); gunzip.destroy(); await producing; throw error; }
  }
  async restore(plan: PreparedRestore): Promise<{ safetyBackupId: string }> {
    if (!this.prepared || this.prepared.id !== plan.id || !this.busy) throw new RecoveryError("Restore has not been prepared.", 409);
    const lifecycle = this.options.lifecycle;
    if (!lifecycle) { this.busy = false; this.prepared = null; removeTree(path.join(this.paths.recovery, plan.id), this.paths.recovery); throw new RecoveryError("This server has no controlled restart lifecycle.", 409); }
    const stage = path.join(this.paths.recovery, idSchema.parse(plan.id)); let stopped = false, journal: Journal | undefined, safety: BackupFile | undefined;
    try {
      this.update("stopping", "Stopping requests, background jobs, and active streams."); await lifecycle.quiesce(); stopped = true;
      safety = await this.capture("safety");
      if (plan.kind === "configuration") {
        await this.onlineBackup(path.join(stage, "database.sqlite"));
        const candidate = systemConfigurationSchema.parse(JSON.parse(fs.readFileSync(path.join(stage, "config.json"), "utf8")));
        if (candidate.backend !== this.config.backend) {
          const copy = new Database(path.join(stage, "database.sqlite"));
          try {
            const tracks = copy.prepare("SELECT COUNT(*) AS count FROM library_items").get() as { count: number };
            if (tracks.count) throw new RecoveryError("Switching backend type requires an empty local catalog. Keep the current backend and migrate the library separately.", 409);
            copy.prepare("UPDATE backend_connections SET enabled=0").run();
            copy.prepare("INSERT INTO backend_connections (id,type,name,config_json,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)").run(`backend_${randomUUID()}`, candidate.backend, candidate.backend === "jellyfin" ? "Jellyfin" : "Navidrome", JSON.stringify({ url: candidate.backend === "jellyfin" ? candidate.jellyfin.url : candidate.navidrome.url, credentials: "configuration" }), new Date().toISOString(), new Date().toISOString());
          } finally { copy.close(); }
        }
      }
      await lifecycle.closeDatabase();
      for (const target of [this.paths.database, this.paths.configuration, this.paths.artwork]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new RecoveryError("Restore targets must not be symbolic links.");
      journal = { version: 1, id: plan.id, phase: "installing", hadConfig: fs.existsSync(this.paths.configuration), hadArtwork: fs.existsSync(this.paths.artwork), replaceArtwork: plan.kind === "restore" };
      durableJson(path.join(this.paths.recovery, "journal.json"), journal);
      this.update("installing", "Installing the staged database and configuration with rollback protection.", { safetyBackupId: safety.id });
      const entries = [{ live: this.paths.database, old: "old-database.sqlite", next: "database.sqlite" }, { live: this.paths.configuration, old: "old-config.json", next: "config.json" }, ...(journal.replaceArtwork ? [{ live: this.paths.artwork, old: "old-artwork", next: "artwork" }] : [])];
      for (const entry of entries) {
        if (fs.existsSync(entry.live)) fs.renameSync(entry.live, path.join(stage, entry.old));
        syncDirectory(this.paths.root); syncDirectory(stage);
        if (fs.existsSync(path.join(stage, entry.next))) fs.renameSync(path.join(stage, entry.next), entry.live);
        syncDirectory(this.paths.root); syncDirectory(stage);
      }
      this.options.afterInstall?.();
      this.update("restarting", "Restarting providers, caches, schedulers, and sessions.", { safetyBackupId: safety.id });
      await lifecycle.restart();
      durableJson(path.join(this.paths.recovery, "journal.json"), { ...journal, phase: "committed" });
      this.update("complete", plan.kind === "restore" ? "Restore complete. Sign in using an administrator account from the backup." : "Configuration saved and server restarted.", { safetyBackupId: safety.id });
    } catch (error) {
      if (stopped) {
        try {
          await lifecycle.quiesce(); await lifecycle.closeDatabase();
          if (journal) restoreJournal(this.config, journal);
          await lifecycle.restart();
        } catch (rollbackError) { this.update("failed", "Automatic recovery could not restart the server. Keep the recovery journal and safety archive for manual recovery.", { safetyBackupId: safety?.id }); throw new AggregateError([error, rollbackError], "Restore failed and requires operator recovery."); }
      }
      this.update("failed", "Restore failed. The original database and configuration were retained or restored.", { safetyBackupId: safety?.id });
      if (journal) { fs.rmSync(path.join(this.paths.recovery, "journal.json"), { force: true }); syncDirectory(this.paths.recovery); }
      try { removeTree(stage, this.paths.recovery); } catch { /* Preserve the original error if cleanup cannot remove staging files. */ }
      throw error;
    } finally { this.busy = false; this.prepared = null; }
    // Committed cleanup must never roll back a server that has already restarted.
    try { fs.rmSync(path.join(this.paths.recovery, "journal.json"), { force: true }); syncDirectory(this.paths.recovery); removeTree(stage, this.paths.recovery); } catch { /* Startup can finish committed journal cleanup safely. */ }
    return { safetyBackupId: safety!.id };
  }
  startScheduler(): void {
    this.timer = setInterval(() => {
      const failure = (error: unknown) => {
        if (error instanceof RecoveryError && error.statusCode === 409) return;
        try { this.update("failed", "Automatic backup could not run. Check storage permissions and free disk space."); }
        catch { console.error("MusicDeck could not write its automatic backup status."); }
      };
      try {
        if (this.busy || !this.db.open) return;
        const row = this.db.prepare("SELECT value FROM server_settings WHERE key='recovery.backupDaily'").get() as { value: string } | undefined;
        if (row?.value !== "true") return;
        void this.listBackups().then(async (files) => {
          if (files.some((file) => file.kind === "system" && Date.now() - Date.parse(file.createdAt) < 24 * 60 * 60_000)) return;
          await this.createBackup();
        }).catch(failure);
      } catch (error) { failure(error); }
    }, 60_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
