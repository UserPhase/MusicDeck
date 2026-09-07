import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-migrate-"));
  return path.join(directory, "musicdeck.sqlite");
}

describe("migrations", () => {
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
