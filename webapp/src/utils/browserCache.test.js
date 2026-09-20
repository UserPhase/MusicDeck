import {
  clearLocalBrowserCache,
  formatStorageSize,
  getBrowserStorageUsage,
} from "./browserCache";

describe("browser cache utilities", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  test("formats estimated storage in a readable unit", () => {
    expect(formatStorageSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatStorageSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
    expect(formatStorageSize(null)).toBe("Unavailable");
  });

  test("returns a supported estimate when the browser provides one", async () => {
    const originalStorage = navigator.storage;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: jest.fn().mockResolvedValue({ usage: 6, quota: 12 }),
      },
    });

    await expect(getBrowserStorageUsage()).resolves.toEqual({
      supported: true,
      usage: 6,
      quota: 12,
    });

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: originalStorage,
    });
  });

  test("clears cached entries while preserving preferences and login data", async () => {
    localStorage.setItem("userPreferences", "preserve-me");
    localStorage.setItem("playerCrossfadeDuration", "7");
    localStorage.setItem("playerAccentColor", "#1ed760");
    localStorage.setItem("auth.token", "keep-me");
    localStorage.setItem("accessToken", "keep-me-too");
    localStorage.setItem("cachedAuthToken", "still-keep-me");
    localStorage.setItem("cachedArtwork", "remove-me");
    localStorage.setItem("normalizedTrackMetadata", "remove-me");
    localStorage.setItem("unrelatedApplicationState", "leave-me-alone");

    await clearLocalBrowserCache();

    expect(localStorage.getItem("userPreferences")).toBe("preserve-me");
    expect(localStorage.getItem("playerCrossfadeDuration")).toBe("7");
    expect(localStorage.getItem("playerAccentColor")).toBe("#1ed760");
    expect(localStorage.getItem("auth.token")).toBe("keep-me");
    expect(localStorage.getItem("accessToken")).toBe("keep-me-too");
    expect(localStorage.getItem("cachedAuthToken")).toBe("still-keep-me");
    expect(localStorage.getItem("cachedArtwork")).toBeNull();
    expect(localStorage.getItem("normalizedTrackMetadata")).toBeNull();
    expect(localStorage.getItem("unrelatedApplicationState")).toBe("leave-me-alone");
  });
});
