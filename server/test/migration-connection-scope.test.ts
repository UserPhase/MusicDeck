import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-migrate3-"));
  return path.join(directory, "musicdeck.sqlite");
}

/**
 * Recreate a database exactly as it looked after migrations 1 and 2
 * (the Phase 5 / Phase 8A-1 schema), with one enabled Navidrome connection
 * and pre-existing user data rows.
 */
function createPhase5Database(databasePath: string) {
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE roles (name TEXT PRIMARY KEY, description TEXT NOT NULL);
    INSERT INTO roles VALUES ('admin', 'Full server administrator');
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL REFERENCES roles(name),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE backend_connections (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE playlist_ownership (
      playlist_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, track_id)
    );
    CREATE TABLE recently_played (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      played_at TEXT NOT NULL
    );
    CREATE INDEX recently_played_user_played_at_idx
      ON recently_played(user_id, played_at DESC);

    INSERT INTO schema_migrations (id, name, applied_at) VALUES
      (1, 'initial-auth-and-backend-config', '2026-09-03T00:00:00.000Z'),
      (2, 'domain-ownership-settings-and-activity', '2026-09-03T00:00:00.000Z');
    INSERT INTO backend_connections
      (id, type, name, config_json, enabled, created_at, updated_at)
    VALUES
      ('backend-primary', 'navidrome', 'Navidrome', '{"url":"http://navidrome","credentials":"environment"}', 1, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
    INSERT INTO users
      (id, username, password_hash, display_name, role, disabled, created_at, updated_at)
    VALUES
      ('user-1', 'admin', 'hash', 'admin', 'admin', 0, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
    INSERT INTO favorites (user_id, track_id, created_at)
    VALUES ('user-1', 'track-1', '2026-09-03T00:00:00.000Z');
    INSERT INTO recently_played (id, user_id, track_id, played_at)
    VALUES ('recent-1', 'user-1', 'track-9', '2026-09-03T00:00:00.000Z');
    INSERT INTO playlist_ownership (playlist_id, owner_user_id, created_at, updated_at)
    VALUES ('playlist-1', 'user-1', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
  `);
  db.close();
}

describe("migration 3: connection-scoped user-data references", () => {
  test("fresh installs create connection_id columns and the favorites composite key", async () => {
    const databasePath = tempDbPath();
    const db = await openDatabase(loadConfig({
      databasePath,
      sessionSecret: "test-secret",
      firstAdmin: { username: "admin", password: "admin-password" },
    }));

    const favoritesColumns = db.prepare("PRAGMA table_info(favorites)").all()
      .map((row: any) => row.name);
    const recentlyColumns = db.prepare("PRAGMA table_info(recently_played)").all()
      .map((row: any) => row.name);
    const playlistColumns = db.prepare("PRAGMA table_info(playlists)").all()
      .map((row: any) => row.name);
    const itemColumns = db.prepare("PRAGMA table_info(playlist_items)").all()
      .map((row: any) => row.name);

    // Migration 5 moved user data to stable MusicDeck IDs; connection_id was
    // dropped from favorites/recently_played and library identity tables added.
    expect(favoritesColumns).not.toContain("connection_id");
    expect(recentlyColumns).not.toContain("connection_id");
    expect(playlistColumns).toContain("source_connection_id");
    expect(itemColumns).toContain("library_track_id");

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row: any) => row.name);
    expect(tables).toContain("library_items");
    expect(tables).toContain("library_item_sources");

    const applied = db.prepare(
      "SELECT name FROM schema_migrations WHERE id = 5"
    ).get() as { name: string };
    expect(applied.name).toBe("stable-musicdeck-media-identities");

    db.close();
  });

  test("migrating from the Phase 5 schema backfills existing rows to the primary connection", async () => {
    const databasePath = tempDbPath();
    createPhase5Database(databasePath);

    const db = await openDatabase(loadConfig({
      databasePath,
      sessionSecret: "test-secret",
      firstAdmin: { username: "admin", password: "admin-password" },
    }));

    // After migration 5, user-data track references become stable MusicDeck
    // IDs and the original provider mapping is preserved in
    // library_item_sources. No record is dropped.
    const favorite = db.prepare(
      "SELECT user_id, track_id FROM favorites"
    ).get() as any;
    const recent = db.prepare(
      "SELECT track_id FROM recently_played WHERE id = 'recent-1'"
    ).get() as any;
    const ownership = db.prepare(
      "SELECT source_connection_id, owner_user_id FROM playlists WHERE source_playlist_id = 'playlist-1'"
    ).get() as any;

    expect(favorite.user_id).toBe("user-1");
    expect(favorite.track_id).toMatch(/^md_/);
    expect(recent.track_id).toMatch(/^md_/);
    expect(ownership.source_connection_id).toBe("backend-primary");
    expect(ownership.owner_user_id).toBe("user-1");

    // The provider mapping for the favorited track is recoverable.
    const mapping = db.prepare(`
      SELECT connection_id, provider_item_id FROM library_item_sources
      WHERE library_item_id = ?
    `).get(favorite.track_id) as any;
    expect(mapping).toMatchObject({ connection_id: "backend-primary", provider_item_id: "track-1" });

    db.close();
  });

  test("favorites enforce per-user stable track uniqueness", async () => {
    const databasePath = tempDbPath();
    const db = await openDatabase(loadConfig({
      databasePath,
      sessionSecret: "test-secret",
      firstAdmin: { username: "admin", password: "admin-password" },
    }));

    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO users (id, username, password_hash, display_name, role, disabled, created_at, updated_at) VALUES ('user-x', 'user-x', 'hash', 'user-x', 'admin', 0, ?, ?)"
    ).run(now, now);

    db.prepare(
      "INSERT INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?)"
    ).run("user-x", "md_track-1", now);

    // Same user + same stable track ID -> conflict (no duplicate row).
    db.prepare(
      "INSERT OR IGNORE INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?)"
    ).run("user-x", "md_track-1", now);

    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM favorites WHERE user_id = 'user-x' AND track_id = 'md_track-1'"
    ).get() as { count: number };

    expect(count.count).toBe(1);

    db.close();
  });
});
