import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Settings from "./Settings";
import {
  getPlugins,
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";


jest.mock("../api/musicdeck", () => ({
  analyzeSilence: jest.fn(async () => ({ status: "completed" })),
  getPlugins: jest.fn(async () => []),
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
});


test("loads and updates user settings", async () => {
  getUserSettings.mockResolvedValue([
    { key: "ui.compactLists", value: "true" },
    { key: "playback.defaultVolume", value: "0.5" },
    { key: "catalog.sourceMode", value: "\"hybrid\"" },
    { key: "playback.sourcePreference", value: "\"manual\"" },
  ]);
  updateUserSettings.mockResolvedValue([
    { key: "ui.compactLists", value: "false" },
    { key: "playback.defaultVolume", value: "0.75" },
    { key: "catalog.sourceMode", value: "\"hybrid\"" },
    { key: "playback.sourcePreference", value: "\"manual\"" },
  ]);

  render(<Settings />);

  expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText(/use compact library lists/i));
  fireEvent.change(screen.getByLabelText(/default playback volume/i), {
    target: { value: "0.75" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

  await waitFor(() => {
    expect(updateUserSettings).toHaveBeenCalledWith({
      "ui.compactLists": false,
      "playback.defaultVolume": 0.75,
      "catalog.sourceMode": "hybrid",
      "playback.sourcePreference": "manual",
      "acquisition.enabled": true,
      "acquisition.provider": "auto",
      "acquisition.autoScan": true,
      "playback.silenceTrim.enabled": false,
      "playback.silenceTrim.thresholdDb": -35,
      "playback.silenceTrim.minSilenceSeconds": 0.5,
    });
  });
  expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
});


test("shows safe plugin status without credentials", async () => {
  getUserSettings.mockResolvedValue([]);
  getPlugins.mockResolvedValue([
    {
      id: "debrid-cloud-source",
      name: "External Cloud Source",
      version: "1.0.0",
      status: "enabled",
      enabled: true,
      capabilities: ["source"],
      configFields: [
        { key: "baseUrl", label: "Provider base URL", required: false, secret: false, configured: true },
        { key: "accessToken", label: "Access token", required: true, secret: true, configured: true },
      ],
    },
  ]);

  render(<Settings />);

  expect(await screen.findByRole("heading", { name: /^plugins$/i })).toBeInTheDocument();
  expect(screen.getByText("External Cloud Source")).toBeInTheDocument();
  expect(screen.getByText(/access token: configured/i)).toBeInTheDocument();
  expect(screen.queryByText(/debrid-token|bearer/i)).toBeNull();
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
