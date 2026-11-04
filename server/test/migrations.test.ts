import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrations.js";

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-migrate-"));
  return path.join(directory, "musicdeck.sqlite");
}

describe("migrations", () => {
  test("opens a legacy file in WAL mode and applies the catalog indexes once", async () => {
    const databasePath = tempDbPath();
    const legacy = new Database(databasePath);
    try {
      legacy.pragma("journal_mode = DELETE");
      runMigrations(legacy, 49);
      legacy.prepare("INSERT INTO settings VALUES (?, ?, CURRENT_TIMESTAMP)").run("fixture", "before");
    } finally { legacy.close(); }

    const config = loadConfig({ databasePath });
    const db = await openDatabase(config);
    let applied: unknown;
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      applied = db.prepare("SELECT * FROM schema_migrations WHERE id = 50").get();
      expect(applied).toMatchObject({ name: "catalog-and-playlist-query-indexes" });

      const plans = [
        ["SELECT id FROM playlists WHERE owner_user_id = 'user' AND deleted_at IS NULL", "playlists_owner_deleted_idx"],
        ["SELECT id FROM smart_playlist_tracks WHERE artist COLLATE NOCASE = 'Artist' ORDER BY title COLLATE NOCASE, id", "smart_tracks_artist"],
        ["SELECT id FROM smart_playlist_tracks WHERE album COLLATE NOCASE = 'Album' ORDER BY title COLLATE NOCASE, id", "smart_tracks_album"],
        ["SELECT id FROM smart_playlist_tracks WHERE title COLLATE NOCASE = 'Song'", "smart_tracks_title"],
        ["SELECT id FROM listening_events WHERE user_id = 'user' AND counted = 1 AND created_at >= '2026' ORDER BY created_at DESC, id DESC", "listening_activity_history_idx"],
      ];
      for (const [query, index] of plans) {
        const plan = db.prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all();
        expect(plan.some(({ detail }) => detail.includes(`SEARCH`) && detail.includes(index))).toBe(true);
      }

      const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const read = reader.prepare("SELECT value FROM settings WHERE key = 'fixture'").pluck();
        db.transaction(() => {
          db.prepare("UPDATE settings SET value = 'after' WHERE key = 'fixture'").run();
          expect(read.get()).toBe("before");
        }).immediate();
        expect(read.get()).toBe("after");
      } finally { reader.close(); }
    } finally { db.close(); }

    const reopened = await openDatabase(config);
    try {
      expect(reopened.prepare("SELECT * FROM schema_migrations WHERE id = 50").get()).toEqual(applied);
      expect(reopened.prepare("SELECT value FROM settings WHERE key = 'fixture'").pluck().get()).toBe("after");
      expect(reopened.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally { reopened.close(); }
  });

  test("removes saved Lidarr credentials without touching other plugins", async () => {
    const db = await openDatabase(loadConfig({ databasePath: tempDbPath() }));
    const insert = db.prepare(`
      INSERT INTO plugin_configs (plugin_id, enabled, config_json, permissions_json, updated_at)
      VALUES (?, 1, ?, '[]', CURRENT_TIMESTAMP)
    `);
    insert.run("lidarr", '{"apiKey":"old-secret"}');
    insert.run("other-plugin", '{}');
    db.prepare("DELETE FROM schema_migrations WHERE id = 20").run();

    runMigrations(db);

    expect(db.prepare("SELECT plugin_id FROM plugin_configs WHERE plugin_id = 'lidarr'").get()).toBeUndefined();
    expect(db.prepare("SELECT plugin_id FROM plugin_configs WHERE plugin_id = 'other-plugin'").get()).toBeTruthy();
    db.close();
  });

  test("fresh installs include Phase 5 domain tables", async () => {
    const databasePath = tempDbPath();
    const db = await openDatabase(loadConfig({
      databasePath,
      firstAdmin: { username: "admin", password: "admin-password" },
    }));

    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row: any) => row.name);

    expect(tables).toContain("recently_played");
    expect(tables).toContain("favorites");
    expect(tables).toContain("playlists");
    expect(tables).toContain("playlist_items");
    expect(tables).toContain("user_settings");
    expect(tables).toContain("server_settings");

    db.close();
  });

  test("existing Phase 4 databases migrate forward", async () => {
    const databasePath = tempDbPath();
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE roles (name TEXT PRIMARY KEY, description TEXT NOT NULL);
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
      INSERT INTO schema_migrations (id, name, applied_at)
      VALUES (1, 'initial-auth-and-backend-config', '2026-09-03T00:00:00.000Z');
    `);
    db.close();

    const migrated = await openDatabase(loadConfig({ databasePath }));
    const avatarColumn = migrated.prepare("PRAGMA table_info(users)").all()
      .some((row: any) => row.name === "avatar_ref");
    const recentTable = migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recently_played'
    `).get();

    expect(avatarColumn).toBe(true);
    expect(recentTable).toBeTruthy();

    migrated.close();
  });

  test("fresh installs do not store Navidrome credentials in backend config", async () => {
    const databasePath = tempDbPath();
    const db = await openDatabase(loadConfig({
      databasePath,
      sessionSecret: "test-secret",
      navidrome: {
        url: "http://navidrome:4533",
        username: "service-user",
        password: "service-password",
      },
    }));

    const row = db.prepare(
      "SELECT config_json FROM backend_connections WHERE type = ?"
    ).get("navidrome") as { config_json: string };
    const config = JSON.parse(row.config_json);

    expect(config).toMatchObject({
      url: "http://navidrome:4533",
      credentials: "environment",
    });
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();

    db.close();
  });

  test("existing database-stored backend secrets are scrubbed when env credentials exist", async () => {
    const databasePath = tempDbPath();
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE roles (name TEXT PRIMARY KEY, description TEXT NOT NULL);
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
      INSERT INTO schema_migrations (id, name, applied_at)
      VALUES (1, 'initial-auth-and-backend-config', '2026-09-03T00:00:00.000Z');
      INSERT INTO backend_connections
        (id, type, name, config_json, enabled, created_at, updated_at)
      VALUES
        ('backend-1', 'navidrome', 'Navidrome', '{"url":"http://old","username":"old-user","password":"old-password"}', 1, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
    `);
    db.close();

    const migrated = await openDatabase(loadConfig({
      databasePath,
      navidrome: {
        url: "http://navidrome:4533",
        username: "service-user",
        password: "service-password",
      },
    }));
    const row = migrated.prepare(
      "SELECT config_json FROM backend_connections WHERE id = ?"
    ).get("backend-1") as { config_json: string };
    const config = JSON.parse(row.config_json);

    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.credentials).toBe("environment");

    migrated.close();
  });
});
