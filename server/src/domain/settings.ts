import type { Db } from "../db/database.js";

const ALLOWED_USER_SETTINGS = new Set([
  "playback.defaultVolume",
  "ui.compactLists",
  "catalog.sourceMode",
  "playback.sourcePreference",
  "acquisition.enabled",
  "acquisition.provider",
  "acquisition.autoScan",
]);

const ALLOWED_SERVER_SETTINGS = new Set([
  "library.scanSchedule",
  "jobs.maxConcurrency",
  "acquisition.maxConcurrentDownloads",
  "acquisition.autoScanLibrary",
]);

export function listUserSettings(db: Db, userId: string) {
  return db.prepare(
    "SELECT key, value, updated_at FROM user_settings WHERE user_id = ? ORDER BY key ASC"
  ).all(userId);
}

export function updateUserSettings(
  db: Db,
  userId: string,
  settings: Record<string, unknown>
) {
  const now = new Date().toISOString();
  const update = db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  for (const [key, value] of Object.entries(settings)) {
    if (!ALLOWED_USER_SETTINGS.has(key)) {
      continue;
    }

    update.run(userId, key, JSON.stringify(value), now);
  }

  return listUserSettings(db, userId);
}

export function listServerSettings(db: Db) {
  return db.prepare(
    "SELECT key, value, updated_at FROM server_settings ORDER BY key ASC"
  ).all();
}

export function updateServerSettings(db: Db, settings: Record<string, unknown>) {
  const now = new Date().toISOString();
  const update = db.prepare(`
    INSERT INTO server_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  for (const [key, value] of Object.entries(settings)) {
    if (!ALLOWED_SERVER_SETTINGS.has(key)) {
      continue;
    }

    update.run(key, JSON.stringify(value), now);
  }

  return listServerSettings(db);
}
