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

test("exports only portable preference keys", () => {
  localStorage.setItem("playerLayoutDensity", "compact");
  localStorage.setItem("accessToken", "secret");

  expect(createSettingsBackup().preferences).toEqual({
    playerLayoutDensity: "compact",
  });
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
    playerAccentColor: "#1ed760",
    playerAutoplayEnabled: "false",
  }));

  expect(preferences).toEqual({
    playerLayoutDensity: "compact",
    playerAccentColor: "#1ed760",
    playerAutoplayEnabled: "false",
  });
});
