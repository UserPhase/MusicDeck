import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runMigrations } from "../src/db/migrations.js";
import { shrinkSpotdlLibrary } from "../src/domain/library-shrink.js";

const roots: string[] = [];
const databases: Database.Database[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-shrink-"));
  roots.push(root);
  const db = new Database(":memory:");
  databases.push(db);
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', 'Admin')").run();
  db.prepare(`INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
    VALUES ('admin', 'admin', 'hash', 'Admin', 'admin', 0, datetime('now'), datetime('now'))`).run();
  return { root, db };
}

function recordedFlac(db: Database.Database, filePath: string, status = "imported") {
  db.prepare(`INSERT INTO acquisition_jobs (id, user_id, status, source_provider, files_json, created_at, updated_at)
    VALUES (?, 'admin', 'completed', 'spotdl', ?, datetime('now'), datetime('now'))`)
    .run(`job-${Math.random()}`, JSON.stringify([{ path: filePath, status }]));
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("spotDL library shrink", () => {
  test("dry run selects recorded and legacy spotDL FLACs but leaves other FLACs alone", async () => {
    const { root, db } = fixture();
    const recorded = path.join(root, "Artist", "Album", "Artist - Song.flac");
    const legacyDir = path.join(root, "Spotify Imports", "spimp_123");
    const legacy = path.join(legacyDir, "1 - Artist - Song.flac");
    const unrelated = path.join(root, "Archive", "master.flac");
    for (const filePath of [recorded, legacy, unrelated]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.alloc(1000));
    }
    fs.writeFileSync(path.join(legacyDir, "musicdeck-source.spotdl"), "[]");
    recordedFlac(db, recorded);
    recordedFlac(db, unrelated, "already_in_library");

    const result = await shrinkSpotdlLibrary({ musicRoot: root, importSubdir: "Spotify Imports", db, ffmpegPath: "ffmpeg" });
    expect(result).toMatchObject({ scannedFlacs: 3, eligibleFlacs: 2, unverifiedFlacs: 1, converted: 0 });
    expect(fs.existsSync(recorded)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test("converts, rewrites playlist references, deletes the FLAC, and rescans", async () => {
    const { root, db } = fixture();
    const source = path.join(root, "Artist", "Album", "Artist - Song.flac");
    const manifest = path.join(root, "Spotify Imports", "spimp_123", "musicdeck-spimp_123.m3u8");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(source, Buffer.alloc(1000));
    fs.writeFileSync(manifest, `#EXTM3U\n../../Artist/Album/Artist - Song.flac\n`);
    recordedFlac(db, source);
    const runFfmpeg = vi.fn(async (args: string[]) => { fs.writeFileSync(args.at(-1)!, Buffer.alloc(400)); });
    const rescan = vi.fn(async () => {});

    const result = await shrinkSpotdlLibrary({
      musicRoot: root, importSubdir: "Spotify Imports", db, ffmpegPath: "ffmpeg", apply: true, runFfmpeg, rescan,
    });
    expect(result).toMatchObject({ converted: 1, bytesSaved: 600, failures: [] });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.statSync(source.slice(0, -5) + ".mp3").size).toBe(400);
    expect(fs.readFileSync(manifest, "utf8")).toContain("Artist - Song.mp3");
    expect(runFfmpeg.mock.calls[0][0]).toEqual(expect.arrayContaining([
      "-codec:a", "libmp3lame", "-b:a", "320k", "-map_metadata", "0", "-disposition:v", "attached_pic",
    ]));
    expect(rescan).toHaveBeenCalledOnce();
  });

  test("keeps the FLAC on conversion failure or when the MP3 already exists", async () => {
    const { root, db } = fixture();
    const failed = path.join(root, "failed.flac");
    const existing = path.join(root, "existing.flac");
    fs.writeFileSync(failed, Buffer.alloc(1000));
    fs.writeFileSync(existing, Buffer.alloc(1000));
    fs.writeFileSync(path.join(root, "existing.mp3"), Buffer.alloc(300));
    recordedFlac(db, failed);
    recordedFlac(db, existing);
    const runFfmpeg = vi.fn(async () => { throw new Error("encoder failed"); });
    const rescan = vi.fn(async () => {});

    const result = await shrinkSpotdlLibrary({
      musicRoot: root, importSubdir: "Spotify Imports", db, ffmpegPath: "ffmpeg", apply: true, runFfmpeg, rescan,
    });
    expect(result.converted).toBe(0);
    expect(result.skippedExistingMp3).toBe(1);
    expect(result.failures).toEqual([{ path: failed, reason: "encoder failed" }]);
    expect(fs.existsSync(failed)).toBe(true);
    expect(fs.existsSync(existing)).toBe(true);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    expect(rescan).not.toHaveBeenCalled();
  });
});
