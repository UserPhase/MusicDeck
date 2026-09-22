import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Settings from "./Settings";
import {
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";
import {
  clearLocalBrowserCache,
  getBrowserStorageUsage,
} from "../utils/browserCache";


jest.mock("../api/musicdeck", () => ({
  analyzeSilence: jest.fn(async () => ({ status: "completed" })),
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(),
}));

jest.mock("../utils/browserCache", () => ({
  clearLocalBrowserCache: jest.fn(async () => ({})),
  formatStorageSize: jest.fn((bytes) => `${bytes / (1024 * 1024)} MB`),
  getBrowserStorageUsage: jest.fn(async () => ({
    supported: true,
    usage: 10 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
  })),
}));


beforeEach(() => {
  jest.clearAllMocks();
  getBrowserStorageUsage.mockResolvedValue({
    supported: true,
    usage: 10 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
  });
});


test("loads and updates user settings", async () => {
  getUserSettings.mockResolvedValue([
    { key: "playback.silenceTrim.enabled", value: "false" },
    { key: "playback.silenceTrim.thresholdDb", value: "-35" },
    { key: "playback.silenceTrim.minSilenceSeconds", value: "0.5" },
    { key: "playback.crossfadeDuration", value: "3" },
    { key: "playback.streamQuality", value: "\"original\"" },
    { key: "playback.downloadQuality", value: "\"320kbps\"" },
    { key: "playback.replayGain.enabled", value: "false" },
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
  expect(localStorage.getItem("playerReplayGainEnabled")).toBe("true");
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
      "playback.streamQuality": "320",
      "playback.downloadQuality": "256kbps",
      "playback.replayGain.enabled": true,
      "ui.layoutDensity": "compact",
      "ui.accentColor": "#10B981",
      "ui.autoOpenSidebar": true,
      "playback.autoplay.enabled": true,
    });
  });
  expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: /clear cache/i }));

  await waitFor(() => {
    expect(clearLocalBrowserCache).toHaveBeenCalledTimes(1);
  });
  expect(getBrowserStorageUsage).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/preferences and session are still intact/i)).toBeInTheDocument();
});
