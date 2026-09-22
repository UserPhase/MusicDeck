import { ACCENT_COLORS } from "./accentColors";

const BACKUP_VERSION = 1;
const MAX_PREFERENCE_LENGTH = 64 * 1024;
export const MAX_SETTINGS_BACKUP_BYTES = 128 * 1024;
const BOOLEAN_VALUES = new Set(["true", "false"]);
const ACCENT_VALUES = new Set(ACCENT_COLORS.map((accent) => accent.value));

// Keep this allowlist deliberately small: authentication and cached media never
// belong in a portable settings file.
export const SETTINGS_STORAGE_KEYS = [
  "userPreferences",
  "theme",
  "playerVolume",
  "playerCrossfadeDuration",
  "playerStreamQuality",
  "playerDownloadQuality",
  "playerReplayGainEnabled",
  "playerLayoutDensity",
  "playerAccentColor",
  "playerAutoOpenSidebar",
  "playerAutoplayEnabled",
];

function isFiniteNumberInRange(value, minimum, maximum) {
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) && number >= minimum && number <= maximum;
}

function isJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const SETTING_VALIDATORS = {
  userPreferences: isJsonObject,
  theme: (value) => /^[a-z0-9_-]{1,32}$/i.test(value),
  playerVolume: (value) => isFiniteNumberInRange(value, 0, 1),
  playerCrossfadeDuration: (value) => isFiniteNumberInRange(value, 0, 12),
  playerStreamQuality: (value) => ["128", "320", "original"].includes(value),
  playerDownloadQuality: (value) => ["lossless", "320kbps", "256kbps", "192kbps", "128kbps"].includes(value),
  playerReplayGainEnabled: (value) => BOOLEAN_VALUES.has(value),
  playerLayoutDensity: (value) => ["comfortable", "compact"].includes(value),
  playerAccentColor: (value) => ACCENT_VALUES.has(value),
  playerAutoOpenSidebar: (value) => BOOLEAN_VALUES.has(value),
  playerAutoplayEnabled: (value) => BOOLEAN_VALUES.has(value),
};

export function createSettingsBackup(storage = window.localStorage) {
  const preferences = {};
  SETTINGS_STORAGE_KEYS.forEach((key) => {
    const value = storage.getItem(key);
    if (value !== null) preferences[key] = value;
  });

  return {
    schema: "musicdeck-settings",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    preferences,
  };
}

export function validateSettingsBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The backup must be a JSON object.");
  }
  if (value.schema !== "musicdeck-settings" || value.version !== BACKUP_VERSION) {
    throw new Error("This backup format is not supported.");
  }
  if (
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt))
  ) {
    throw new Error("The backup timestamp is invalid.");
  }
  if (!value.preferences || typeof value.preferences !== "object" || Array.isArray(value.preferences)) {
    throw new Error("The backup does not contain valid preferences.");
  }

  const preferences = {};
  for (const [key, entry] of Object.entries(value.preferences)) {
    if (
      !SETTINGS_STORAGE_KEYS.includes(key) ||
      typeof entry !== "string" ||
      entry.length > MAX_PREFERENCE_LENGTH ||
      !SETTING_VALIDATORS[key]?.(entry)
    ) {
      throw new Error("The backup contains an invalid preference.");
    }
    preferences[key] = entry;
  }
  return preferences;
}

export function applySettingsBackup(value, storage = window.localStorage) {
  const preferences = validateSettingsBackup(value);
  Object.entries(preferences).forEach(([key, entry]) => storage.setItem(key, entry));
  window.dispatchEvent(new CustomEvent("musicdeck:preferences-restored", {
    detail: preferences,
  }));
  return preferences;
}

export function downloadSettingsBackup(backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "musicdeck-settings-backup.json";
  anchor.click();
  URL.revokeObjectURL(url);
}
