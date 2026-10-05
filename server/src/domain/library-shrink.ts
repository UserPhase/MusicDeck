import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Db } from "../db/database.js";

export type ShrinkOptions = {
  musicRoot: string;
  importSubdir: string;
  db: Db;
  ffmpegPath: string;
  apply?: boolean;
  includeAllFlacs?: boolean;
  runFfmpeg?: (args: string[]) => Promise<void>;
  rescan?: () => Promise<void>;
};

export type ShrinkResult = {
  scannedFlacs: number;
  eligibleFlacs: number;
  unverifiedFlacs: number;
  converted: number;
  skippedExistingMp3: number;
  bytesSaved: number;
  failures: Array<{ path: string; reason: string }>;
  rescanError?: string;
};

function withinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function walkLibrary(root: string): Promise<{ flacs: string[]; manifests: string[] }> {
  const flacs: string[] = [];
  const manifests: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".flac") flacs.push(filePath);
        if (ext === ".m3u" || ext === ".m3u8") manifests.push(filePath);
      }
    }
  }
  return { flacs, manifests };
}

function recordedSpotdlPaths(db: Db, root: string): Set<string> {
  const recorded = new Set<string>();
  const rows = db.prepare(
    "SELECT files_json FROM acquisition_jobs WHERE source_provider = 'spotdl' AND status = 'completed'"
  ).all() as Array<{ files_json: string }>;
  for (const row of rows) {
    try {
      const files = JSON.parse(row.files_json) as unknown;
      if (!Array.isArray(files)) continue;
      for (const item of files) {
        if (!item || typeof item !== "object") continue;
        const file = item as { path?: unknown; status?: unknown };
        if (file.status !== "imported" || typeof file.path !== "string") continue;
        const resolved = path.resolve(root, file.path);
        if (withinRoot(resolved, root) && path.extname(resolved).toLowerCase() === ".flac") {
          recorded.add(pathKey(resolved));
        }
      }
    } catch { /* A malformed historical job cannot authorize a file conversion. */ }
  }
  return recorded;
}

async function isLegacySpotdlImport(filePath: string, root: string, importSubdir: string): Promise<boolean> {
  const importRoot = path.resolve(root, importSubdir);
  if (!withinRoot(importRoot, root)) return false;
  const relative = path.relative(importRoot, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.length < 2 || !parts[0].startsWith("spimp_")) return false;
  try {
    const marker = await fs.lstat(path.join(importRoot, parts[0], "musicdeck-source.spotdl"));
    return marker.isFile() && !marker.isSymbolicLink();
  } catch { return false; }
}

async function verifiedFlac(filePath: string, root: string, realRoot: string): Promise<Stats> {
  if (!withinRoot(filePath, root) || path.extname(filePath).toLowerCase() !== ".flac") throw new Error("Path is outside the FLAC library");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source is not a regular file");
  const realPath = await fs.realpath(filePath);
  if (!withinRoot(realPath, realRoot)) throw new Error("Source resolves outside the music library");
  return stat;
}

function ffmpegArgs(source: string, output: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", source,
    "-map", "0:a:0", "-map", "0:v?", "-codec:a", "libmp3lame", "-b:a", "320k",
    "-codec:v", "copy", "-disposition:v", "attached_pic", "-map_metadata", "0",
    "-id3v2_version", "3", "-f", "mp3", output,
  ];
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)));
  });
}

async function rewriteManifestReferences(manifests: string[], source: string, destination: string): Promise<void> {
  for (const manifest of manifests) {
    const original = await fs.readFile(manifest, "utf8");
    const updated = original.replace(/[^\r\n]+/g, (line) => {
      if (!line || line.startsWith("#")) return line;
      const trimmed = line.trim();
      const resolved = path.resolve(path.dirname(manifest), trimmed.replaceAll("/", path.sep));
      if (pathKey(resolved) !== pathKey(source)) return line;
      const replacement = path.isAbsolute(trimmed)
        ? destination
        : path.relative(path.dirname(manifest), destination).replaceAll(path.sep, "/");
      return line.replace(trimmed, replacement);
    });
    if (updated === original) continue;
    const temporary = `${manifest}.musicdeck-shrink-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, updated, "utf8");
      await fs.rename(temporary, manifest);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

/** Default mode is a read-only inventory. Apply only converts files with spotDL provenance. */
export async function shrinkSpotdlLibrary(options: ShrinkOptions): Promise<ShrinkResult> {
  const root = path.resolve(options.musicRoot);
  const realRoot = await fs.realpath(root);
  const { flacs, manifests } = await walkLibrary(root);
  const recorded = recordedSpotdlPaths(options.db, root);
  const eligible: string[] = [];
  for (const filePath of flacs) {
    if (options.includeAllFlacs || recorded.has(pathKey(filePath)) || await isLegacySpotdlImport(filePath, root, options.importSubdir)) {
      eligible.push(filePath);
    }
  }
  const result: ShrinkResult = {
    scannedFlacs: flacs.length, eligibleFlacs: eligible.length, unverifiedFlacs: flacs.length - eligible.length,
    converted: 0, skippedExistingMp3: 0, bytesSaved: 0, failures: [],
  };
  if (!options.apply) return result;

  for (const source of eligible) {
    const destination = source.slice(0, -5) + ".mp3";
    let temporary = "";
    try {
      const before = await verifiedFlac(source, root, realRoot);
      try { await fs.lstat(destination); result.skippedExistingMp3 += 1; continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      temporary = path.join(path.dirname(source), `.${path.basename(source, ".flac")}.musicdeck-${randomUUID()}.mp3`);
      await (options.runFfmpeg || ((args) => runFfmpeg(options.ffmpegPath, args)))(ffmpegArgs(source, temporary));
      const output = await fs.lstat(temporary);
      if (!output.isFile() || output.isSymbolicLink() || output.size === 0) throw new Error("ffmpeg did not produce a valid MP3 file");
      if (output.size >= before.size) throw new Error("MP3 is not smaller than the source FLAC");
      const current = await verifiedFlac(source, root, realRoot);
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ino !== before.ino) {
        throw new Error("Source FLAC changed during conversion");
      }
      await fs.link(temporary, destination); // Exclusive: never replace an existing MP3.
      await rewriteManifestReferences(manifests, source, destination);
      await fs.unlink(source);
      result.converted += 1;
      result.bytesSaved += before.size - output.size;
    } catch (error) {
      result.failures.push({ path: source, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      if (temporary) await fs.rm(temporary, { force: true });
    }
  }
  if (result.converted && options.rescan) {
    try { await options.rescan(); }
    catch (error) { result.rescanError = error instanceof Error ? error.message : String(error); }
  }
  return result;
}
