import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { BackupRestoreService, databaseSchema, recoverInterruptedRestore } from "../src/services/BackupRestoreService.js";
import { applySystemConfiguration, configurationSnapshot, durableJson, systemPaths } from "../src/services/systemConfiguration.js";

const roots: string[] = [], handles: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of handles.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) { const absolute = path.resolve(root); if (!absolute.startsWith(path.join(os.tmpdir(), "musicdeck-recovery-test-"))) throw new Error("Invalid test cleanup path"); fs.rmSync(absolute, { recursive: true, force: true }); } });
async function fixture(afterInstall?: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-recovery-test-")); roots.push(root);
  const config = loadConfig({ databasePath: path.join(root, "musicdeck.sqlite"), musicRoot: path.join(root, "music"), acquisitionTmpDir: path.join(root, "staging"), sessionSecret: "recovery-test-secret", navidrome: { url: "http://navidrome.test", username: "music", password: "secret-backend-password" }, firstAdmin: { username: "admin", password: "recovery-test-password" } });
  let db = await openDatabase(config); handles.push(db); db.pragma("journal_mode = WAL");
  const paths = systemPaths(config); fs.mkdirSync(config.musicRoot); fs.mkdirSync(config.acquisitionTmpDir); fs.mkdirSync(paths.artwork);
  fs.writeFileSync(path.join(config.musicRoot, "song.flac"), "raw media must remain unchanged"); fs.writeFileSync(path.join(paths.artwork, "cover.png"), "old artwork");
  const user = db.prepare("SELECT id FROM users WHERE role='admin'").get() as { id: string };
  db.prepare("INSERT INTO playlists (id,owner_user_id,name,created_at,updated_at) VALUES ('roadtrip',?,'Road trip',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(user.id);
  const setting = (value: string) => db.prepare("INSERT INTO server_settings (key,value,updated_at) VALUES ('test.value',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
  setting("before");
  const quiesce = vi.fn(async () => {}), restart = vi.fn(async () => { db = new Database(config.databasePath); db.pragma("foreign_keys = ON"); handles.push(db); });
  const service = new BackupRestoreService(db, config, { lifecycle: { quiesce, closeDatabase: () => { if (db.open) { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } }, restart }, afterInstall });
  return { root, config, paths, service, quiesce, restart, get db() { return db; }, setting };
}
async function upload(service: BackupRestoreService, id: string) { return service.receiveUpload(fs.createReadStream(await service.backupPath(id))); }
async function makeArchive(root: string, entries: Array<{ name: string; data?: Buffer | string; type?: "file" | "symlink" }>) {
  const file = path.join(root, `malicious-${randomUUID()}.tar.gz`), tar = pack();
  const output = pipeline(tar as unknown as Readable, createGzip(), fs.createWriteStream(file));
  for (const entry of entries) tar.entry({ name: entry.name, type: entry.type || "file", mode: 0o600, ...(entry.type === "symlink" ? { linkname: "../../outside" } : {}) }, entry.data || "");
  tar.finalize(); await output; return file;
}

test("SQLite online backup remains consistent under live writes and excludes raw media", async () => {
  const context = await fixture();
  const insert = context.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)");
  context.db.transaction(() => { for (let index = 0; index < 1200; index++) insert.run(`padding-${index}`, "x".repeat(2048)); })();
  let writes = 0;
  const update = context.db.transaction(() => { context.db.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES ('counter-a',?,CURRENT_TIMESTAMP),('counter-b',?,CURRENT_TIMESTAMP)").run(String(writes), String(writes)); });
  const timer = setInterval(() => { writes++; update(); }, 1);
  let backup;
  try { const job = context.service.createBackup(); await expect(context.service.createBackup()).rejects.toThrow(/already running/); backup = await job; } finally { clearInterval(timer); }
  expect(writes).toBeGreaterThan(0);
  const prepared = await context.service.prepareRestore(await upload(context.service, backup.id));
  expect(prepared.manifest?.mediaIncluded).toBe(false);
  expect(prepared.manifest?.files.map((file) => file.path)).toEqual(expect.arrayContaining(["database.sqlite", "config.json", "artwork/cover.png"]));
  expect(prepared.manifest?.files.some((file) => /\.flac$|playback-cache/.test(file.path))).toBe(false);
  const copy = new Database(path.join(context.paths.recovery, prepared.id, "database.sqlite")); handles.push(copy);
  expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(copy.prepare("SELECT value FROM settings WHERE key='counter-a'").get()).toEqual(copy.prepare("SELECT value FROM settings WHERE key='counter-b'").get());
  copy.close(); context.service.discardPrepared(prepared);
});

test("restores database/config/artwork, preserves media, clears sessions, and makes a safety snapshot", async () => {
  const context = await fixture();
  context.db.prepare("INSERT INTO sessions (id,user_id,created_at,expires_at) SELECT 'old-session',id,CURRENT_TIMESTAMP,'2099-01-01' FROM users LIMIT 1").run();
  const backup = await context.service.createBackup();
  context.setting("after"); fs.writeFileSync(path.join(context.paths.artwork, "cover.png"), "new artwork");
  const prepared = await context.service.prepareRestore(await upload(context.service, backup.id));
  const result = await context.service.restore(prepared);
  expect(context.db.prepare("SELECT value FROM server_settings WHERE key='test.value'").get()).toEqual({ value: "before" });
  expect(context.db.prepare("SELECT name FROM playlists WHERE id='roadtrip'").get()).toEqual({ name: "Road trip" });
  expect(context.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  expect(fs.readFileSync(path.join(context.paths.artwork, "cover.png"), "utf8")).toBe("old artwork");
  expect(fs.readFileSync(path.join(context.config.musicRoot, "song.flac"), "utf8")).toBe("raw media must remain unchanged");
  expect(applySystemConfiguration(context.config).navidrome.password).toBe("secret-backend-password");
  expect((await context.service.listBackups()).some((file) => file.id === result.safetyBackupId && file.kind === "safety")).toBe(true);
  expect(context.service.status().state).toBe("complete"); expect(context.restart).toHaveBeenCalledTimes(1);
});

test("an injected failure after file replacement rolls back the database, config and artwork", async () => {
  const context = await fixture(() => { throw new Error("simulated installation failure"); });
  const backup = await context.service.createBackup();
  context.setting("latest-live-state"); fs.writeFileSync(path.join(context.paths.artwork, "cover.png"), "latest artwork");
  const originalConfig = { ...configurationSnapshot(context.config), musicRoot: context.config.musicRoot };
  durableJson(context.paths.configuration, originalConfig);
  const prepared = await context.service.prepareRestore(await upload(context.service, backup.id));
  await expect(context.service.restore(prepared)).rejects.toThrow("simulated installation failure");
  expect(context.db.prepare("SELECT value FROM server_settings WHERE key='test.value'").get()).toEqual({ value: "latest-live-state" });
  expect(fs.readFileSync(path.join(context.paths.artwork, "cover.png"), "utf8")).toBe("latest artwork");
  expect(JSON.parse(fs.readFileSync(context.paths.configuration, "utf8"))).toEqual(originalConfig);
  expect(context.service.status().state).toBe("failed");
  expect(fs.existsSync(path.join(context.paths.recovery, "journal.json"))).toBe(false);
});

test("rejects incompatible database schemas before stopping the server", async () => {
  const context = await fixture(), backup = await context.service.createBackup();
  context.db.exec("CREATE TABLE different_schema (id INTEGER)");
  await expect(context.service.prepareRestore(await upload(context.service, backup.id))).rejects.toThrow(/incompatible.*schema/i);
  expect(context.quiesce).not.toHaveBeenCalled(); expect(context.db.open).toBe(true);
});

test("rejects traversal and symlink entries before changing live state", async () => {
  const context = await fixture();
  const manifest = { format: "musicdeck-system", version: 1, createdAt: new Date().toISOString(), schema: databaseSchema(context.db), files: [{ path: "database.sqlite", size: 0, sha256: "0".repeat(64) }, { path: "config.json", size: 0, sha256: "0".repeat(64) }], mediaIncluded: false };
  for (const entry of [{ name: "../../outside", data: "escape" }, { name: "database.sqlite", type: "symlink" as const }]) {
    const archive = await makeArchive(context.root, [{ name: "manifest.json", data: JSON.stringify(manifest) }, entry]);
    await expect(context.service.prepareRestore(await context.service.receiveUpload(fs.createReadStream(archive)))).rejects.toThrow();
  }
  expect(context.quiesce).not.toHaveBeenCalled(); expect(context.db.open).toBe(true);
});

test("detects forged file payloads even when the manifest looks valid", async () => {
  const context = await fixture();
  const config = Buffer.from(JSON.stringify(configurationSnapshot(context.config))), fake = Buffer.from("not a database");
  const manifest = { format: "musicdeck-system", version: 1, createdAt: new Date().toISOString(), schema: databaseSchema(context.db), files: [{ path: "database.sqlite", size: fake.length, sha256: "0".repeat(64) }, { path: "config.json", size: config.length, sha256: createHash("sha256").update(config).digest("hex") }], mediaIncluded: false };
  const archive = await makeArchive(context.root, [{ name: "manifest.json", data: JSON.stringify(manifest) }, { name: "database.sqlite", data: fake }, { name: "config.json", data: config }]);
  await expect(context.service.prepareRestore(await context.service.receiveUpload(fs.createReadStream(archive)))).rejects.toThrow(/checksum/);
  expect(context.quiesce).not.toHaveBeenCalled();
});

test("startup crash recovery restores originals and discards the replacement's WAL sidecars", async () => {
  const context = await fixture(), id = randomUUID(), stage = path.join(context.paths.recovery, id);
  context.db.pragma("wal_checkpoint(TRUNCATE)"); context.db.close();
  fs.mkdirSync(stage, { recursive: true }); fs.renameSync(context.paths.database, path.join(stage, "old-database.sqlite"));
  fs.writeFileSync(context.paths.database, "incomplete replacement"); fs.writeFileSync(`${context.paths.database}-wal`, "uncommitted new WAL");
  durableJson(context.paths.configuration, configurationSnapshot(context.config));
  durableJson(path.join(context.paths.recovery, "journal.json"), { version: 1, id, phase: "installing", hadConfig: false, hadArtwork: true, replaceArtwork: false });
  expect(recoverInterruptedRestore(context.config)).toBe(true);
  expect(fs.existsSync(`${context.paths.database}-wal`)).toBe(false);
  expect(fs.existsSync(context.paths.configuration)).toBe(false);
  const restored = new Database(context.paths.database); handles.push(restored);
  expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(restored.prepare("SELECT value FROM server_settings WHERE key='test.value'").get()).toEqual({ value: "before" });
});

test("configuration restart snapshots the latest database state instead of reverting intervening writes", async () => {
  const context = await fixture();
  const draft = { ...configurationSnapshot(context.config), navidrome: { ...context.config.navidrome, username: "updated" } };
  const prepared = await context.service.prepareConfiguration(draft); context.setting("written-after-preparation");
  await context.service.restore(prepared);
  expect(context.db.prepare("SELECT value FROM server_settings WHERE key='test.value'").get()).toEqual({ value: "written-after-preparation" });
  expect(applySystemConfiguration(context.config).navidrome.username).toBe("updated");
});

test("a failed runtime restart rolls back and boots the original system", async () => {
  const context = await fixture(), backup = await context.service.createBackup(); context.setting("newer-live-state");
  context.restart.mockImplementationOnce(async () => { throw new Error("runtime failed to boot"); });
  const prepared = await context.service.prepareRestore(await upload(context.service, backup.id));
  await expect(context.service.restore(prepared)).rejects.toThrow("runtime failed to boot");
  expect(context.restart).toHaveBeenCalledTimes(2);
  expect(context.db.prepare("SELECT value FROM server_settings WHERE key='test.value'").get()).toEqual({ value: "newer-live-state" });
  expect(context.service.status().state).toBe("failed");
});

test("daily backup scheduling honors the saved policy and skips a recent system backup", async () => {
  const context = await fixture();
  context.db.prepare("INSERT INTO server_settings (key,value,updated_at) VALUES ('recovery.backupDaily','true',CURRENT_TIMESTAMP)").run();
  const backup = vi.spyOn(context.service, "createBackup").mockResolvedValue({ id: randomUUID(), filename: "system-test.tar.gz", kind: "system", bytes: 1, createdAt: new Date().toISOString() });
  const list = vi.spyOn(context.service, "listBackups").mockResolvedValue([]);
  vi.useFakeTimers();
  try {
    context.service.startScheduler(); await vi.advanceTimersByTimeAsync(60_000); expect(backup).toHaveBeenCalledTimes(1);
    list.mockResolvedValue([{ id: randomUUID(), filename: "recent.tar.gz", kind: "system", bytes: 1, createdAt: new Date().toISOString() }]);
    await vi.advanceTimersByTimeAsync(60_000); expect(backup).toHaveBeenCalledTimes(1);
  } finally { context.service.close(); vi.useRealTimers(); }
});

test("a safety archive from unfinished setup can be validated before backend credentials exist", async () => {
  const context = await fixture(); context.config.navidrome.username = ""; context.config.navidrome.password = "";
  const backup = await context.service.createBackup();
  const prepared = await context.service.prepareRestore(await upload(context.service, backup.id));
  expect(prepared.kind).toBe("restore"); context.service.discardPrepared(prepared);
});
