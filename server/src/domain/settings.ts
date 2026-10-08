import type { Db } from "../db/database.js";

const ALLOWED_USER_SETTINGS = new Set([
  "playback.defaultVolume",
  "ui.compactLists",
  "catalog.sourceMode",
  "playback.sourcePreference",
  "acquisition.enabled",
  "acquisition.provider",
  "acquisition.autoScan",
  "playback.silenceTrim.enabled",
  "playback.silenceTrim.thresholdDb",
  "playback.silenceTrim.minSilenceSeconds",
  "playback.crossfadeDuration",
  "playback.streamQuality",
  "playback.downloadQuality",
  "playback.replayGain.enabled",
  "playback.autoplay.enabled",
  "ui.theme",
  "ui.layoutDensity",
  "ui.accentColor",
  "ui.autoOpenSidebar",
  "ui.layoutPreset",
]);

export const DEFAULT_APP_NAME = "MusicDeck";
const APP_NAME_SETTING_KEY = "branding.appName";

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

export interface AppConfig {
  appName: string;
}

export function getAppConfig(db: Db): AppConfig {
  const row = db.prepare(
    "SELECT value FROM server_settings WHERE key = ?"
  ).get(APP_NAME_SETTING_KEY) as { value: string } | undefined;

  let appName: unknown = null;
  if (row) {
    try {
      appName = JSON.parse(row.value);
    } catch {
      appName = null;
    }
  }

  return {
    appName: typeof appName === "string" && appName.trim() ? appName.trim() : DEFAULT_APP_NAME,
  };
}

/** Persists the global display name. Callers validate the value first. */
export function updateAppConfig(db: Db, config: AppConfig): AppConfig {
  db.prepare(`
    INSERT INTO server_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(APP_NAME_SETTING_KEY, JSON.stringify(config.appName), new Date().toISOString());

  return getAppConfig(db);
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
