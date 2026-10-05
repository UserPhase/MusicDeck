import fs from "node:fs";
import path from "node:path";

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Checks the existing ancestors before creating each next directory. */
export function safeMusicPath(rootDirectory: string, targetPath: string, createParents = false): string {
  const lexicalRoot = path.resolve(rootDirectory);
  const target = path.resolve(targetPath);
  if (!inside(lexicalRoot, target) || target === lexicalRoot) throw new Error("Path is outside the music root");
  const physicalRoot = fs.realpathSync(lexicalRoot);
  const parts = path.relative(lexicalRoot, target).split(path.sep);
  let current = lexicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (fs.existsSync(current)) {
      if (!inside(physicalRoot, fs.realpathSync(current))) throw new Error("Symlink path escapes the music root");
      if (index < parts.length - 1 && !fs.statSync(current).isDirectory()) throw new Error("Music path parent is not a directory");
    } else if (index < parts.length - 1 && createParents) {
      // A dangling link must not be followed by mkdir or subsequent writes.
      try { fs.lstatSync(current); throw new Error("Dangling link in music path"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fs.mkdirSync(current);
      if (!inside(physicalRoot, fs.realpathSync(current))) throw new Error("Music path changed during creation");
    } else {
      try { fs.lstatSync(current); throw new Error("Dangling link in music path"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return target;
}

export function flushFile(filePath: string): void {
  // FlushFileBuffers on Windows requires a handle opened for writing.
  const handle = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

/** POSIX directory entries need a separate flush after an atomic publication. */
export function flushDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const handle = fs.openSync(directory, "r");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}
