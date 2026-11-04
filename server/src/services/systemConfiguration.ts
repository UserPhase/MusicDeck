import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";

const endpoint = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, "Use an HTTP(S) server URL without embedded credentials, query parameters, or fragments.");
export const systemConfigurationSchema = z.object({
  version: z.literal(1), backend: z.enum(["navidrome", "jellyfin"]),
  navidrome: z.object({ url: endpoint, username: z.string().max(512), password: z.string().max(4096) }).strict(),
  jellyfin: z.object({ url: endpoint, apiKey: z.string().max(4096) }).strict(),
  musicRoot: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
  acquisitionTmpDir: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
}).strict();
export type SystemConfiguration = z.infer<typeof systemConfigurationSchema>;
export function systemPaths(config: AppConfig) {
  const root = path.dirname(path.resolve(config.databasePath));
  return { root, database: path.resolve(config.databasePath), configuration: path.join(root, "config.json"), artwork: path.join(root, "artwork"), recovery: path.join(root, ".recovery"), backups: path.join(root, "backups") };
}
export function configurationSnapshot(config: AppConfig): SystemConfiguration {
  return { version: 1, backend: config.backend, navidrome: { ...config.navidrome }, jellyfin: { ...config.jellyfin }, musicRoot: config.musicRoot, acquisitionTmpDir: config.acquisitionTmpDir };
}
/** Saved setup values override backend/path defaults. Listener, database path,
 * session secret and initial administrator credentials remain deployment-owned. */
export function applySystemConfiguration(config: AppConfig): AppConfig {
  if (config.databasePath === ":memory:") return config;
  const file = systemPaths(config).configuration;
  if (!fs.existsSync(file)) return config;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid MusicDeck config.json file.");
  const saved = systemConfigurationSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return { ...config, backend: saved.backend, navidrome: saved.navidrome, jellyfin: saved.jellyfin, musicRoot: saved.musicRoot, acquisitionTmpDir: saved.acquisitionTmpDir };
}
export function syncDirectory(directory: string): void {
  // Windows does not permit directory fsync through the Node filesystem API.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
