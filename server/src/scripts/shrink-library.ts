import Database from "better-sqlite3";
import path from "node:path";

import { JellyfinBackend } from "../backends/jellyfin/jellyfin-backend.js";
import { NavidromeBackend } from "../backends/navidrome/navidrome-backend.js";
import { loadConfig } from "../config.js";
import { shrinkSpotdlLibrary } from "../domain/library-shrink.js";
import { autoDetectFFmpegPath } from "../domain/spotdl-downloader-adapter.js";

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !["--apply", "--all-flac"].includes(flag))) {
    throw new Error("Usage: npm run library:shrink -- [--apply] [--all-flac]");
  }
  const config = loadConfig();
  const db = new Database(path.resolve(config.databasePath), { readonly: true, fileMustExist: true });
  try {
    const backend = config.backend === "jellyfin"
      ? new JellyfinBackend(config.jellyfin)
      : new NavidromeBackend(config.navidrome);
    const result = await shrinkSpotdlLibrary({
      musicRoot: config.musicRoot,
      importSubdir: config.spotifyImportSubdir,
      db,
      ffmpegPath: process.env.FFMPEG_PATH || autoDetectFFmpegPath(),
      apply: flags.has("--apply"),
      includeAllFlacs: flags.has("--all-flac"),
      rescan: async () => { await backend.requestLibraryRescan(); },
    });
    console.log(JSON.stringify({ mode: flags.has("--apply") ? "applied" : "dry-run", ...result }, null, 2));
    if (result.failures.length || result.rescanError) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
