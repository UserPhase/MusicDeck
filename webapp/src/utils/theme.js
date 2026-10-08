import { updateUserSettings, USER_SETTINGS_CHANGED_EVENT } from "../api/musicdeck";

/*
 * Single path for theme changes. The persisted `ui.theme` user setting is the
 * source of truth; both theme controls (Settings and the admin panel)
 * broadcasts changes through USER_SETTINGS_CHANGED_EVENT so App.js updates
 * the <html data-theme> attribute and other open views stay in sync.
 */
export const THEME_SETTING_KEY = "ui.theme";

export const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function normalizeTheme(value) {
  return value === "light" || value === "dark" ? value : null;
}

export function getActiveTheme() {
  return normalizeTheme(document.documentElement.dataset.theme) || "dark";
}

export function broadcastTheme(theme) {
  const nextTheme = normalizeTheme(theme);
  if (!nextTheme) return;
  window.dispatchEvent(new CustomEvent(USER_SETTINGS_CHANGED_EVENT, {
    detail: { [THEME_SETTING_KEY]: nextTheme },
  }));
}

/**
 * Applies the theme immediately, then persists it. On failure the previous
 * theme is restored and the error is rethrown so callers can report it.
 */
export async function saveThemePreference(theme) {
  const nextTheme = normalizeTheme(theme);
  if (!nextTheme) throw new Error("Unsupported theme");

  const previousTheme = getActiveTheme();
  broadcastTheme(nextTheme);
  try {
    await updateUserSettings({ [THEME_SETTING_KEY]: nextTheme });
  } catch (error) {
    broadcastTheme(previousTheme);
    throw error;
  }
}
