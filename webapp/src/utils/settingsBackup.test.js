import {
  applySettingsBackup,
  createSettingsBackup,
  validateSettingsBackup,
} from "./settingsBackup";

function backup(preferences) {
  return {
    schema: "musicdeck-settings",
    version: 1,
    exportedAt: "2026-09-20T12:00:00.000Z",
    preferences,
  };
}

beforeEach(() => localStorage.clear());

test.each(["256", "direct"])("preserves the %s streaming preference in portable backups", (quality) => {
  localStorage.setItem("playerStreamQuality", quality);
  expect(validateSettingsBackup(createSettingsBackup())).toEqual({ playerStreamQuality: quality });
});

test("exports only portable preference keys", () => {
  localStorage.setItem("playerLayoutDensity", "compact");
  localStorage.setItem("accessToken", "secret");

  expect(createSettingsBackup().preferences).toEqual({
    playerLayoutDensity: "compact",
  });
});

test("backs up shuffle mode but never exports private listening history", () => {
  localStorage.setItem("playerShuffleMode", "smart");
  localStorage.setItem("musicdeck:shuffle-history:v1:user-1", JSON.stringify([{ id: "private-track", playedAt: Date.now() }]));
  const exported = createSettingsBackup();
  expect(exported.preferences).toEqual({ playerShuffleMode: "smart" });
  expect(validateSettingsBackup(exported)).toEqual({ playerShuffleMode: "smart" });
  expect(() => validateSettingsBackup(backup({ playerShuffleMode: "invalid" }))).toThrow(/invalid preference/i);
});

test("album-aware playback is portable and strictly boolean", () => {
  localStorage.setItem("playerAlbumAware", "true");
  expect(validateSettingsBackup(createSettingsBackup())).toEqual({ playerAlbumAware: "true" });
  expect(() => validateSettingsBackup(backup({ playerAlbumAware: "enabled" }))).toThrow(/invalid preference/i);
});

test("rejects invalid values before writing any preference", () => {
  localStorage.setItem("playerVolume", "0.5");

  expect(() => applySettingsBackup(backup({
    playerVolume: "0.8",
    playerCrossfadeDuration: "not-a-number",
  }))).toThrow(/invalid preference/i);

  expect(localStorage.getItem("playerVolume")).toBe("0.5");
  expect(localStorage.getItem("playerCrossfadeDuration")).toBeNull();
});

test("accepts a complete valid settings backup", () => {
  const preferences = validateSettingsBackup(backup({
    playerLayoutDensity: "compact",
    playerAccentColor: "#10B981",
    playerAutoplayEnabled: "false",
    playerDownloadQuality: "256kbps",
  }));

  expect(preferences).toEqual({
    playerLayoutDensity: "compact",
    playerAccentColor: "#10B981",
    playerAutoplayEnabled: "false",
    playerDownloadQuality: "256kbps",
  });
});
