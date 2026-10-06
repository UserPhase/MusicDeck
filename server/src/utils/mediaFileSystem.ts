import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeMusicPath, flushFile, flushDirectory } from "../services/media/safeMusicPath.js";
import { isSpotifyArtworkUrl } from "./spotifyArtworkUrl.js";

const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

export async function saveAlbumArtworkToFolder(
  targetDir: string, imageUrl: string, musicRoot: string, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!isSpotifyArtworkUrl(imageUrl)) throw new Error("Album artwork must use the Spotify image CDN");
  safeMusicPath(musicRoot, targetDir);
  const destinations = ["cover.jpg", "folder.jpg"].map((name) => safeMusicPath(musicRoot, path.join(targetDir, name)));
  const missing = destinations.filter((file) => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error("Existing folder artwork is not a regular nonempty file");
      return false; // Never overwrite an operator's artwork.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  });
  if (!missing.length) return false;
  const response = await fetchImpl(imageUrl, { signal: AbortSignal.timeout(8_000), redirect: "error" });
  if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/jpeg") {
    await response.body?.cancel();
    throw new Error(`Spotify artwork returned invalid image response (${response.status})`);
  }
  if (!response.body) throw new Error("Spotify artwork response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_ARTWORK_BYTES) throw new Error("Spotify artwork exceeds 5 MB limit");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTWORK_BYTES) throw new Error("Spotify artwork exceeds 5 MB limit");
      chunks.push(value);
    }
  } catch (error) {
    // Preserve the download error if stream cleanup also fails.
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("Spotify artwork is not a complete JPEG");
  }
  const pending = safeMusicPath(musicRoot, path.join(targetDir, `.musicdeck-artwork-${randomUUID()}.partial`));
  let changed = false;
  try {
    fs.writeFileSync(pending, bytes, { flag: "wx", mode: 0o644 });
    fs.chmodSync(pending, 0o644);
    flushFile(pending);
    for (const destination of missing) {
      safeMusicPath(musicRoot, destination);
      try {
        fs.linkSync(pending, destination); // Atomic no-clobber publication on the same filesystem.
        changed = true;
        flushDirectory(targetDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        safeMusicPath(musicRoot, destination);
      }
    }
  } finally { fs.rmSync(pending, { force: true }); }
  return changed;
}
