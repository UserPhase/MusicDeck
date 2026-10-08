import { updateUserSettings, USER_SETTINGS_CHANGED_EVENT } from "../api/musicdeck";

/*
 * Per-user layout preset. Mirrors utils/theme.js: the `ui.layoutPreset` user
 * setting is the source of truth and changes are broadcast through
 * USER_SETTINGS_CHANGED_EVENT so App.js re-renders <AppLayout />.
 *
 * Streaming services collapse into four structural archetypes; services
 * that share a skeleton (Tidal, Deezer, Qobuz, Amazon Music) map onto them.
 */
export const LAYOUT_PRESET_SETTING_KEY = "ui.layoutPreset";
export const DEFAULT_LAYOUT_PRESET = "spotify";
export const LAYOUT_PRESET_STORAGE_KEY = "musicdeckLayoutPreset";

/** Every desktop preset falls back to this shell below this width. */
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";
export const MOBILE_LAYOUT_SHELL = "mobile";

/**
 * Structural rules each archetype hands to <AppLayout />.
 *   navigation: "sidebar" (fixed left) | "drawer" (header + hamburger) | "header"
 *   header:     "standard" | "player" (transport in header) | "topnav"
 *   player:     "bar" (docked bottom) | "header" | "drawer" (floating, expandable)
 *   aside:      "panel" (now playing / queue) | "widgets" (inline feed column)
 */
export const LAYOUT_PRESETS = {
  spotify: {
    value: "spotify",
    label: "Spotify / Tidal",
    subtitle: "Sidebar + Bottom Player",
    description: "Fixed library sidebar, scrollable content, optional Now Playing panel and a docked player bar.",
    shell: { navigation: "sidebar", header: "standard", player: "bar", aside: "panel" },
  },
  apple: {
    value: "apple",
    label: "Apple Music",
    subtitle: "Sidebar + Top Controls",
    description: "Library sidebar with playback controls and search in the header, plus a full-height lyrics and queue panel.",
    shell: { navigation: "sidebar", header: "player", player: "header", aside: "panel" },
  },
  ytmusic: {
    value: "ytmusic",
    label: "YouTube Music",
    subtitle: "Top Navigation + Full Bleed",
    description: "Header navigation with a collapsible menu drawer, edge-to-edge content and an expandable floating player.",
    shell: { navigation: "drawer", header: "topnav", player: "drawer", aside: "panel" },
  },
  soundcloud: {
    value: "soundcloud",
    label: "SoundCloud",
    subtitle: "Top Header + Widget Column",
    description: "Header navigation over a feed with an inline widget column for what's next, recent plays and playlists.",
    shell: { navigation: "header", header: "topnav", player: "bar", aside: "widgets" },
  },
};

export const LAYOUT_PRESET_OPTIONS = Object.values(LAYOUT_PRESETS);

/** Presets that existed before the four archetypes were consolidated. */
const LEGACY_LAYOUT_PRESETS = { tidal: "spotify" };

export function normalizeLayoutPreset(value) {
  if (typeof value !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(LAYOUT_PRESETS, value)) return value;
  return LEGACY_LAYOUT_PRESETS[value] || null;
}

export function getLayoutPresetConfig(preset) {
  return LAYOUT_PRESETS[normalizeLayoutPreset(preset) || DEFAULT_LAYOUT_PRESET];
}

export function getActiveLayoutPreset() {
  return normalizeLayoutPreset(document.documentElement.dataset.layoutPreset) || DEFAULT_LAYOUT_PRESET;
}

export function readStoredLayoutPreset() {
  try {
    return normalizeLayoutPreset(localStorage.getItem(LAYOUT_PRESET_STORAGE_KEY)) || DEFAULT_LAYOUT_PRESET;
  } catch {
    return DEFAULT_LAYOUT_PRESET;
  }
}

export function broadcastLayoutPreset(preset) {
  const nextPreset = normalizeLayoutPreset(preset);
  if (!nextPreset) return;
  window.dispatchEvent(new CustomEvent(USER_SETTINGS_CHANGED_EVENT, {
    detail: { [LAYOUT_PRESET_SETTING_KEY]: nextPreset },
  }));
}

/**
 * Applies the preset immediately, then persists it. On failure the previous
 * preset is restored and the error is rethrown so callers can report it.
 */
export async function saveLayoutPresetPreference(preset) {
  const nextPreset = normalizeLayoutPreset(preset);
  if (!nextPreset) throw new Error("Unsupported layout preset");

  const previousPreset = getActiveLayoutPreset();
  broadcastLayoutPreset(nextPreset);
  try {
    await updateUserSettings({ [LAYOUT_PRESET_SETTING_KEY]: nextPreset });
  } catch (error) {
    broadcastLayoutPreset(previousPreset);
    throw error;
  }
}
