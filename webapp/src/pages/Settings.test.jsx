import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Settings from "./Settings";
import {
  getUserSettings,
  updateUserSettings,
  getDataExportSummary,
} from "../api/musicdeck";
import { calculateStorageUsage, clearImageCache } from "../services/storage/StorageManager";


jest.mock("../api/musicdeck", () => ({
  USER_SETTINGS_CHANGED_EVENT: "musicdeck:user-settings-changed",
  analyzeSilence: jest.fn(async () => ({ status: "completed" })),
  getUserSettings: jest.fn(),
  getDataExportSummary: jest.fn(async () => ({
    playlists: [], counts: { playlists: 0, playlistTracks: 0, history: 0, favorites: 0, feedback: 0, ratings: 0, settings: 0, smartPlaylists: 0, savedDiscoveries: 0 },
    estimatedBytes: { history: 0, favorites: 0, settings: 0, json: 0, zip: 0 }, notes: [],
  })),
  downloadUserData: jest.fn(),
  getLoudnessScan: jest.fn(async () => null),
  getSilenceScan: jest.fn(async () => null),
  startSilenceScan: jest.fn(),
  startLoudnessScan: jest.fn(),
  updateUserSettings: jest.fn(),
}));

jest.mock("../services/storage/StorageManager", () => ({
  clearImageCache: jest.fn(async () => 1),
  purgeStaleWebCache: jest.fn(async () => 0),
  purgeOfflineTracks: jest.fn(async () => 0),
  calculateStorageUsage: jest.fn(async () => ({
    supported: true,
    usage: 10 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
    offlineTracks: 0, offlineBytes: 0,
  })),
}));


beforeEach(() => {
  jest.clearAllMocks();
  getDataExportSummary.mockResolvedValue({
    playlists: [], counts: { playlists: 0, playlistTracks: 0, history: 0, favorites: 0, feedback: 0, ratings: 0, settings: 0, smartPlaylists: 0, savedDiscoveries: 0 },
    estimatedBytes: { history: 0, favorites: 0, settings: 0, json: 0, zip: 0 }, notes: [],
  });
  calculateStorageUsage.mockResolvedValue({
    supported: true,
    usage: 10 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
    offlineTracks: 0, offlineBytes: 0,
  });

});

test("loads smart shuffle, applies mode changes locally and includes the choice in account settings", async () => {
  localStorage.removeItem("playerShuffleMode");
  getUserSettings.mockResolvedValue([{ key: "playback.shuffleMode", value: '"smart"' }]);
  updateUserSettings.mockResolvedValue([]);
  render(<Settings />);
  expect(await screen.findByRole("radio", { name: "Smart Shuffle" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Standard Shuffle" }));
  expect(localStorage.getItem("playerShuffleMode")).toBe("standard");
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ "playback.shuffleMode": "standard" })));
});

test("loads album awareness and persists the changed policy locally and to the account", async () => {
  getUserSettings.mockResolvedValue([{ key: "playback.albumAware", value: "true" }]);
  updateUserSettings.mockResolvedValue([]);
  render(<Settings />);
  const toggle = await screen.findByRole("checkbox", { name: "Album-aware playback" });
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle);
  expect(localStorage.getItem("playerAlbumAware")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ "playback.albumAware": false })));
});

test("loads an account loudness target and saves the selected preset", async () => {
  getUserSettings.mockResolvedValue([{ key: "playback.normalization.targetLufs", value: "-18" }]);
  updateUserSettings.mockResolvedValue([]);
  render(<Settings />);
  const target = await screen.findByRole("combobox", { name: "Loudness target" });
  expect(target).toHaveValue("-18");
  fireEvent.change(target, { target: { value: "-14" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ "playback.normalization.targetLufs": -14 })));
});

test("groups loudness controls under normalization and disables them independently of silence trimming", async () => {
  getUserSettings.mockResolvedValue([
    { key: "playback.normalization.enabled", value: "false" },
    { key: "playback.normalization.targetLufs", value: "-18" },
    { key: "playback.silenceTrim.enabled", value: "true" },
  ]);
  render(<Settings />);
  const group = await screen.findByRole("group", { name: "Volume normalization options" });
  const target = screen.getByRole("combobox", { name: "Loudness target" });
  const scan = screen.getByRole("button", { name: "Scan all tracks" });
  expect(group).toContainElement(target);
  expect(group).toContainElement(scan);
  expect(target).toBeDisabled();
  expect(scan).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Automatic Silence Trimming" })).toBeChecked();
  const silenceGroup = screen.getByRole("group", { name: "Library silence scan" });
  expect(silenceGroup).toContainElement(screen.getByRole("button", { name: "Re-analyze current track" }));
  expect(silenceGroup).toContainElement(screen.getByRole("button", { name: "Analyze all tracks" }));
  expect(screen.getByRole("button", { name: "Analyze all tracks" })).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Volume Normalization" }));
  expect(target).toBeEnabled();
  expect(target).toHaveValue("-18");
  expect(scan).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Volume Normalization" }));
  expect(target).toBeDisabled();
  expect(target).toHaveValue("-18");
  expect(scan).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Automatic Silence Trimming" }));
  expect(screen.getByRole("button", { name: "Analyze all tracks" })).toBeDisabled();
});


test("loads and updates user settings", async () => {
  getUserSettings.mockResolvedValue([
    { key: "playback.silenceTrim.enabled", value: "false" },
    { key: "playback.silenceTrim.thresholdDb", value: "-35" },
    { key: "playback.silenceTrim.minSilenceSeconds", value: "0.5" },
    { key: "playback.crossfadeDuration", value: "3" },
    { key: "playback.streamQuality", value: "\"original\"" },
    { key: "playback.downloadQuality", value: "\"320kbps\"" },
    { key: "playback.normalization.enabled", value: "false" },
    { key: "ui.layoutDensity", value: "\"comfortable\"" },
    { key: "ui.autoOpenSidebar", value: "false" },
    { key: "playback.autoplay.enabled", value: "false" },
    { key: "acquisition.autoDownloadLiked", value: "false" },
  ]);
  updateUserSettings.mockResolvedValue([]);

  render(<Settings />);

  expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /audio & playback/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /interface & layout/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /data & storage/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("checkbox", { name: /automatic silence trimming/i }));
  fireEvent.change(screen.getByRole("slider", { name: /crossfade duration/i }), {
    target: { value: "7" },
  });
  expect(screen.getByText("7 s")).toBeInTheDocument();
  expect(localStorage.getItem("playerCrossfadeDuration")).toBe("7");
  fireEvent.change(screen.getByRole("combobox", { name: /streaming quality/i }), {
    target: { value: "320" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: /download quality/i }), {
    target: { value: "256kbps" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /volume normalization/i }));
  expect(localStorage.getItem("playerStreamQuality")).toBe("320");
  expect(localStorage.getItem("playerDownloadQuality")).toBe("256kbps");
  expect(localStorage.getItem("playerNormalizationEnabled")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: /compact/i }));
  expect(localStorage.getItem("playerLayoutDensity")).toBe("compact");
  fireEvent.click(screen.getByRole("radio", { name: /vinyl mint/i }));
  expect(localStorage.getItem("playerAccentColor")).toBe("#10B981");
  fireEvent.click(screen.getByRole("checkbox", { name: /auto-open now playing sidebar/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /autoplay \/ endless radio/i }));
  expect(localStorage.getItem("playerAutoOpenSidebar")).toBe("true");
  expect(localStorage.getItem("playerAutoplayEnabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

  await waitFor(() => {
    expect(updateUserSettings).toHaveBeenCalledWith({
      "playback.silenceTrim.enabled": true,
      "playback.silenceTrim.thresholdDb": -35,
      "playback.silenceTrim.minSilenceSeconds": 0.5,
      "playback.crossfadeDuration": 7,
      "playback.transitionMode": "crossfade",
      "playback.shuffleMode": "standard",
      "playback.albumAware": false,
      "playback.streamQuality": "320",
      "playback.downloadQuality": "256kbps",
      "playback.normalization.enabled": true,
      "playback.normalization.targetLufs": -16,
      "ui.layoutDensity": "compact",
      "ui.accentColor": "#10B981",
      "ui.autoOpenSidebar": true,
      "playback.autoplay.enabled": true,
    });
  });
  expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
});


test("transition mode loads from the account, gates the crossfade slider, and saves", async () => {
  localStorage.clear();
  getUserSettings.mockResolvedValue([
    { key: "playback.crossfadeDuration", value: "4" },
    { key: "playback.transitionMode", value: "\"gapless\"" },
  ]);
  updateUserSettings.mockResolvedValue([]);
  render(<Settings />);

  const gapless = await screen.findByRole("radio", { name: "Gapless" });
  await waitFor(() => expect(gapless).toBeChecked());
  const slider = screen.getByRole("slider", { name: /crossfade duration/i });
  expect(slider).toBeDisabled();
  expect(slider).toHaveValue("4");

  fireEvent.click(screen.getByRole("radio", { name: "Crossfade" }));
  expect(localStorage.getItem("playerTransitionMode")).toBe("crossfade");
  expect(slider).toBeEnabled();
  fireEvent.change(slider, { target: { value: "10" } });
  expect(screen.getByText("10 s")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("radio", { name: "Off" }));
  expect(slider).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({
    "playback.transitionMode": "none",
    "playback.crossfadeDuration": 10,
  })));
});


test("theme selector reflects the saved theme and applies changes instantly", async () => {
  document.documentElement.dataset.theme = "dark";
  getUserSettings.mockResolvedValue([{ key: "ui.theme", value: "\"light\"" }]);
  updateUserSettings.mockResolvedValue([]);
  const themeEvents = jest.fn();
  window.addEventListener("musicdeck:user-settings-changed", themeEvents);

  render(<Settings />);

  const themeGroup = await screen.findByRole("radiogroup", { name: "Theme" });
  await waitFor(() => expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true"));
  expect(themeGroup).toBeInTheDocument();

  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

  expect(themeEvents.mock.calls[0][0].detail).toEqual({ "ui.theme": "dark" });
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith({ "ui.theme": "dark" }));
  expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

  window.dispatchEvent(new CustomEvent("musicdeck:user-settings-changed", { detail: { "ui.theme": "light" } }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true"));
  window.removeEventListener("musicdeck:user-settings-changed", themeEvents);
});


test("theme selector restores the previous theme when saving fails", async () => {
  document.documentElement.dataset.theme = "dark";
  getUserSettings.mockResolvedValue([]);
  updateUserSettings.mockRejectedValue(new Error("Offline"));

  render(<Settings />);

  fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
});


test("layout style selector reflects the saved preset and applies changes instantly", async () => {
  delete document.documentElement.dataset.layoutPreset;
  getUserSettings.mockResolvedValue([{ key: "ui.layoutPreset", value: "\"soundcloud\"" }]);
  updateUserSettings.mockResolvedValue([]);
  const settingsEvents = jest.fn();
  window.addEventListener("musicdeck:user-settings-changed", settingsEvents);

  render(<Settings />);

  const presetGroup = await screen.findByRole("radiogroup", { name: "Layout Style" });
  await waitFor(() => expect(screen.getByRole("radio", { name: "SoundCloud" })).toHaveAttribute("aria-checked", "true"));
  expect(presetGroup.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(screen.getByRole("radio", { name: "YouTube Music" })).toHaveAccessibleDescription(/header navigation/i);

  fireEvent.click(screen.getByRole("radio", { name: "Apple Music" }));

  expect(settingsEvents.mock.calls[0][0].detail).toEqual({ "ui.layoutPreset": "apple" });
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith({ "ui.layoutPreset": "apple" }));
  expect(screen.getByRole("radio", { name: "Apple Music" })).toHaveAttribute("aria-checked", "true");

  fireEvent.keyDown(presetGroup, { key: "ArrowRight" });
  await waitFor(() => expect(updateUserSettings).toHaveBeenCalledWith({ "ui.layoutPreset": "ytmusic" }));
  expect(screen.getByRole("radio", { name: "YouTube Music" })).toHaveFocus();
  window.removeEventListener("musicdeck:user-settings-changed", settingsEvents);
});


test("layout style maps the retired Tidal preset to the Spotify / Tidal archetype", async () => {
  delete document.documentElement.dataset.layoutPreset;
  getUserSettings.mockResolvedValue([{ key: "ui.layoutPreset", value: "\"tidal\"" }]);

  render(<Settings />);

  await waitFor(() => expect(screen.getByRole("radio", { name: "Spotify / Tidal" })).toHaveAttribute("aria-checked", "true"));
});


test("layout style restores the previous preset when saving fails", async () => {
  document.documentElement.dataset.layoutPreset = "spotify";
  getUserSettings.mockResolvedValue([]);
  updateUserSettings.mockRejectedValue(new Error("Offline"));

  render(<Settings />);

  fireEvent.click(await screen.findByRole("radio", { name: "YouTube Music" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  expect(screen.getByRole("radio", { name: "Spotify / Tidal" })).toHaveAttribute("aria-checked", "true");
  delete document.documentElement.dataset.layoutPreset;
});


test("shows API errors when settings fail to load", async () => {
  getUserSettings.mockRejectedValue(new Error("Settings unavailable"));

  render(<Settings />);

  expect(await screen.findByText(/settings unavailable/i)).toBeInTheDocument();
});


test("silence trim re-analyze button is disabled without a current song", async () => {
  getUserSettings.mockResolvedValue([]);

  render(<Settings />);

  expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /re-analyze current track/i })).toBeDisabled();
});

test("shows storage usage and clears only the local media cache", async () => {
  getUserSettings.mockResolvedValue([]);

  render(<Settings />);

  expect(await screen.findByRole("progressbar", { name: /local browser storage usage/i })).toHaveAttribute(
    "aria-valuenow",
    "10",
  );
  fireEvent.click(screen.getByRole("button", { name: /clear cover art cache/i }));

  await waitFor(() => {
    expect(clearImageCache).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => expect(calculateStorageUsage).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/preferences and login are unchanged/i)).toBeInTheDocument();
});
