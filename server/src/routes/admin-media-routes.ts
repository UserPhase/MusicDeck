import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import type { MusicBackend } from "../backends/music-backend.js";
import type { CatalogService } from "../domain/catalog.js";
import { requireAdmin } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";

/** The relative check rejects siblings such as /music-backup and the root itself. */
export function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verifiedAudioPath(metadataPath: string, rootDir: string): Promise<string> {
  const candidate = path.resolve(rootDir, metadataPath);
  if (!isPathWithinRoot(candidate, rootDir)) throw new MediaPathError(400, "Track path is outside the music library");
  if (![".mp3", ".flac"].includes(path.extname(candidate).toLowerCase())) {
    throw new MediaPathError(400, "Only MP3 and FLAC files can be deleted from the server");
  }
  try {
    const [realRoot, realFile, stat] = await Promise.all([fs.realpath(rootDir), fs.realpath(candidate), fs.lstat(candidate)]);
    if (!isPathWithinRoot(realFile, realRoot) || !stat.isFile() || stat.isSymbolicLink()) {
      throw new MediaPathError(400, "Track path is outside the music library or is not a regular file");
    }
  } catch (error) {
    if (error instanceof MediaPathError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MediaPathError(404, "Track file not found on disk");
    throw error;
  }
  return candidate;
}

class MediaPathError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function removeEmptyParents(filePath: string, rootDir: string): Promise<void> {
  for (let dir = path.dirname(filePath); isPathWithinRoot(dir, rootDir); dir = path.dirname(dir)) {
    try { await fs.rmdir(dir); }
    catch (error) {
      if (["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) break;
      break; // Folder cleanup is optional; a permissions error must not prevent the rescan.
    }
  }
}

async function removeAlbumDirectoryIfSafe(filePaths: string[], rootDir: string): Promise<void> {
  const directories = [...new Set(filePaths.map((filePath) => path.dirname(filePath)))];
  if (directories.length !== 1) return;
  const albumDir = directories[0];
  const relative = path.relative(rootDir, albumDir);
  // A folder directly under the root might hold an artist's entire catalog.
  if (!isPathWithinRoot(albumDir, rootDir) || relative.split(path.sep).length < 2) return;
  try {
    const stat = await fs.lstat(albumDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await fs.readdir(albumDir, { withFileTypes: true });
    const audioExtensions = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".aiff", ".ape"]);
    if (entries.some((entry) => !entry.isFile() || audioExtensions.has(path.extname(entry.name).toLowerCase()))) return;
    for (const entry of entries) await fs.unlink(path.join(albumDir, entry.name));
    await fs.rmdir(albumDir);
  } catch {
    // Folder cleanup is best effort; the track deletion and rescan must still finish.
  }
}

export async function registerAdminMediaRoutes(app: FastifyInstance, db: Db, musicRoot: string, backend: MusicBackend, catalog: CatalogService) {
  const scan = async () => {
    if (!backend.requestLibraryRescan && !backend.scanLibrary) return "Library rescan is not supported by this backend";
    try {
      if (backend.requestLibraryRescan) await backend.requestLibraryRescan();
      else await backend.scanLibrary?.();
      return null;
    }
    catch { return "File deleted, but the library rescan could not be started"; }
  };

  app.delete("/api/v1/admin/tracks/:trackId", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const { trackId } = request.params as { trackId: string };
    const track = await catalog.getTrack(trackId);
    if (!track) return sendError(reply, 404, "Track not found");
    const metadataPath = await catalog.getTrackFilePath(trackId);
    if (!metadataPath) return sendError(reply, 409, "The media provider did not report a real file path. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.");
    try {
      const filePath = await verifiedAudioPath(metadataPath, musicRoot);
      await fs.unlink(filePath);
      await removeEmptyParents(filePath, musicRoot);
      const warning = await scan();
      return { success: true, message: "Track deleted from disk", trackId, ...(warning ? { warning } : {}) };
    } catch (error) {
      if (error instanceof MediaPathError) return sendError(reply, error.status, error.message);
      throw error;
    }
  });

  app.delete("/api/v1/admin/albums/:albumId", async (request, reply) => {
    if (!requireAdmin(db, request, reply)) return reply;
    const { albumId } = request.params as { albumId: string };
    const album = await catalog.getAlbum(albumId);
    if (!album) return sendError(reply, 404, "Album not found");
    const tracks = await catalog.getAlbumTracks(albumId);
    if (!tracks.length) return sendError(reply, 409, "Album has no server tracks to delete");
    try {
      const paths = [];
      for (const track of tracks) {
        const metadataPath = await catalog.getTrackFilePath(track.id);
        if (!metadataPath) return sendError(reply, 409, "The media provider did not report a real file path for an album track. In Navidrome, enable Report Real Path for the MusicDeck File Management player in Settings > Players.");
        paths.push(await verifiedAudioPath(metadataPath, musicRoot));
      }
      const uniquePaths = [...new Set(paths)];
      for (const filePath of uniquePaths) await fs.unlink(filePath);
      await removeAlbumDirectoryIfSafe(uniquePaths, musicRoot);
      for (const filePath of uniquePaths) await removeEmptyParents(filePath, musicRoot);
      const warning = await scan();
      return { success: true, message: "Album deleted from disk", albumId, trackIds: tracks.map((track) => track.id), ...(warning ? { warning } : {}) };
    } catch (error) {
      if (error instanceof MediaPathError) return sendError(reply, error.status, error.message);
      throw error;
    }
  });
}
