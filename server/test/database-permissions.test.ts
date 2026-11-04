import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { prepareDatabasePath, protectDatabaseFile, protectDatabaseFiles } from "../src/db/file-permissions.js";
import { serverLogs } from "../src/utils/logger.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  if (getuid) Object.defineProperty(process, "getuid", getuid);
  else Reflect.deleteProperty(process, "getuid");
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  serverLogs.clear();
});

function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-permissions-"));
  return path.join(directory, "private-data", "musicdeck.sqlite");
}

describe("database filesystem protections", () => {
  test("new and existing databases remain readable/writable and preserve credential records", async () => {
    const databasePath = fixture();
    const config = loadConfig({ databasePath, sessionSecret: "fixture-session-secret", firstAdmin: { username: "admin", password: "fixture-password" } });
    const first = await openDatabase(config);
    try {
      first.exec("CREATE TABLE permission_fixture(value TEXT)");
      first.prepare("INSERT INTO permission_fixture VALUES (?)").run("fixture-value");
      expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
      first.prepare("INSERT INTO permission_fixture VALUES (?)").run("wal-value");
      protectDatabaseFiles(databasePath);
      expect(fs.existsSync(`${databasePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(true);
      if (process.platform !== "win32") {
        for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
        expect(fs.statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
      } else {
        expect(serverLogs.list().some((entry) => entry.message.includes("Windows"))).toBe(true);
      }
    } finally { first.close(); }
    const reopened = await openDatabase(config);
    try {
      expect(reopened.prepare("SELECT value FROM permission_fixture ORDER BY rowid").all()).toEqual([
        { value: "fixture-value" }, { value: "wal-value" },
      ]);
      reopened.prepare("INSERT INTO permission_fixture VALUES (?)").run("reopened");
    } finally { reopened.close(); }
  });

  test.skipIf(process.platform === "win32")("actual POSIX modes are 0700/0600 even with a permissive umask", () => {
    const databasePath = fixture();
    const previous = process.umask(0);
    try {
      prepareDatabasePath(databasePath);
      expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
      fs.chmodSync(databasePath, 0o666);
      protectDatabaseFiles(databasePath);
      expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    } finally { process.umask(previous); }
  });

  test("mocked POSIX policy restricts only owned files and covers every SQLite sidecar", () => {
    const databasePath = fixture();
    prepareDatabasePath(databasePath);
    const stat = fs.statSync(databasePath);
    stat.mode = 0o100666;
    stat.uid = 1000;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "getuid", { value: () => 1000, configurable: true });
    vi.spyOn(fs, "lstatSync").mockReturnValue(stat);
    const restricted = fs.statSync(databasePath);
    restricted.mode = 0o100600;
    vi.spyOn(fs, "statSync").mockReturnValue(restricted);
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    protectDatabaseFiles(databasePath);
    expect(chmod.mock.calls).toEqual(["", "-wal", "-shm", "-journal"].map((suffix) => [`${databasePath}${suffix}`, 0o600]));
    chmod.mockClear();
    stat.uid = 2000;
    protectDatabaseFile(databasePath);
    expect(chmod).not.toHaveBeenCalled();
    expect(serverLogs.list().some((entry) => entry.message.includes("Ownership was not changed"))).toBe(true);
  });

  test("mocked unsupported chmod produces actionable diagnostics without leaking exception text", () => {
    const databasePath = fixture();
    prepareDatabasePath(databasePath);
    const stat = fs.statSync(databasePath);
    stat.mode = 0o100666;
    stat.uid = 1000;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "getuid", { value: () => 1000, configurable: true });
    vi.spyOn(fs, "lstatSync").mockReturnValue(stat);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => { throw Object.assign(new Error("sensitive failure detail"), { code: "EPERM" }); });
    protectDatabaseFile(databasePath);
    expect(serverLogs.list()).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Cannot enforce SQLite mode 0600"),
      meta: expect.objectContaining({ code: "EPERM" }),
    }));
    expect(JSON.stringify(serverLogs.list())).not.toContain("sensitive failure detail");
  });

  test("existing directories are not chmodded or chowned and memory databases need no files", async () => {
    const databasePath = fixture();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const mode = fs.statSync(path.dirname(databasePath)).mode;
    prepareDatabasePath(databasePath);
    expect(fs.statSync(path.dirname(databasePath)).mode).toBe(mode);
    const db = await openDatabase(loadConfig({ databasePath: ":memory:", firstAdmin: { username: "admin", password: "fixture-password" } }));
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    db.close();
  });

  test("rejects database symlinks without following or chmodding their targets", () => {
    const databasePath = fixture();
    prepareDatabasePath(databasePath);
    const stat = fs.lstatSync(databasePath);
    vi.spyOn(stat, "isSymbolicLink").mockReturnValue(true);
    vi.spyOn(fs, "lstatSync").mockReturnValue(stat);
    const chmod = vi.spyOn(fs, "chmodSync");
    expect(() => protectDatabaseFile(databasePath)).toThrow("must be regular files");
    expect(chmod).not.toHaveBeenCalled();
  });

  test("warns when a filesystem silently ignores chmod", () => {
    const databasePath = fixture();
    prepareDatabasePath(databasePath);
    const stat = fs.statSync(databasePath);
    stat.mode = 0o100666;
    stat.uid = 1000;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    Object.defineProperty(process, "getuid", { value: () => 1000, configurable: true });
    vi.spyOn(fs, "lstatSync").mockReturnValue(stat);
    vi.spyOn(fs, "statSync").mockReturnValue(stat);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    protectDatabaseFile(databasePath);
    expect(serverLogs.list().some((entry) => entry.message.includes("filesystem did not enforce mode 0600"))).toBe(true);
  });

  test("Docker source requests a private data directory and restrictive runtime umask", () => {
    const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const entrypoint = fs.readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
    expect(dockerfile).toContain("RUN chmod 0700 /app/data");
    expect(dockerfile.indexOf("mkdir -p /app/home /app/data")).toBeLessThan(dockerfile.indexOf("RUN chmod 0700 /app/data"));
    expect(entrypoint).toMatch(/set -eu\r?\numask 077/);
    expect(entrypoint).toContain('exec gosu musicdeck "$@"');
  });
});
