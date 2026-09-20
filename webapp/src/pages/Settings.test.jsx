import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Settings from "./Settings";
import {
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  analyzeSilence: jest.fn(async () => ({ status: "completed" })),
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
});


test("loads and updates user settings", async () => {
  getUserSettings.mockResolvedValue([
    { key: "playback.silenceTrim.enabled", value: "false" },
    { key: "playback.silenceTrim.thresholdDb", value: "-35" },
    { key: "playback.silenceTrim.minSilenceSeconds", value: "0.5" },
    { key: "playback.crossfadeDuration", value: "3" },
    { key: "playback.streamQuality", value: "\"original\"" },
    { key: "playback.replayGain.enabled", value: "false" },
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
  fireEvent.click(screen.getByRole("checkbox", { name: /volume normalization/i }));
  expect(localStorage.getItem("playerStreamQuality")).toBe("320");
  expect(localStorage.getItem("playerReplayGainEnabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

  await waitFor(() => {
    expect(updateUserSettings).toHaveBeenCalledWith({
      "playback.silenceTrim.enabled": true,
      "playback.silenceTrim.thresholdDb": -35,
      "playback.silenceTrim.minSilenceSeconds": 0.5,
      "playback.crossfadeDuration": 7,
      "playback.streamQuality": "320",
      "playback.replayGain.enabled": true,
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
