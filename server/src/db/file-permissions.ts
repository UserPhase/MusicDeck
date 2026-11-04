import fs from "node:fs";
import path from "node:path";
import { serverLogs } from "../utils/logger.js";

function warn(message: string, file: string, code?: string): void {
  serverLogs.push({ level: "warn", source: "server", message, meta: { file, ...(code ? { code } : {}) } });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function protectDatabaseFile(file: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("SQLite data files must be regular files, not symbolic links");
  if (process.platform === "win32") return;
  if (!(stat.mode & 0o077)) return;
  if (stat.uid !== process.getuid?.()) {
    warn("SQLite file permissions are unsafe; restrict this file to the service account on the host. Ownership was not changed.", file);
    return;
  }
  try {
    fs.chmodSync(file, 0o600);
    if (fs.statSync(file).mode & 0o077) {
      warn("SQLite filesystem did not enforce mode 0600; restrict host ACLs or move the database to a private filesystem.", file);
    }
  } catch (error) {
    warn("Cannot enforce SQLite mode 0600; restrict host ACLs or correct service-account permissions.", file,
      error instanceof Error && "code" in error ? String(error.code) : "PERMISSION_ERROR");
  }
}

export function protectDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) protectDatabaseFile(`${databasePath}${suffix}`);
}

export function prepareDatabasePath(databasePath: string): void {
  const directory = path.dirname(path.resolve(databasePath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    warn("SQLite POSIX permissions cannot be verified on Windows. Restrict the database directory, sidecars and backups to the service account with host ACLs.", directory);
  } else {
    const stat = fs.statSync(directory);
    if (stat.mode & 0o077) {
      warn("SQLite directory permits group/other access. Use a dedicated service-owned directory with mode 0700; existing directory permissions were not changed.", directory);
    }
  }
  try {
    fs.closeSync(fs.openSync(databasePath, "wx", 0o600));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  protectDatabaseFiles(databasePath);
}
