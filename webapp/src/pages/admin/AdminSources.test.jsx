import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import AdminSources from "./AdminSources";
import {
  getAdminBackendConnections,
  getAdminPlugins,
  getAdminSearchProviders,
  getAdminSourceProviders,
  testAdminSearchProvider,
  testAdminSourceProvider,
  updateAdminSearchProvider,
  updateAdminSourceProvider,
} from "../../api/musicdeck";


jest.mock("../../api/musicdeck", () => ({
  getAdminBackendConnections: jest.fn(async () => []),
  getAdminPlugins: jest.fn(async () => []),
  getAdminSearchProviders: jest.fn(),
  getAdminSourceProviders: jest.fn(),
  testAdminSearchProvider: jest.fn(),
  testAdminSourceProvider: jest.fn(),
  updateAdminSearchProvider: jest.fn(),
  updateAdminSourceProvider: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
});


test("testing a search provider surfaces the specific provider name/message, not a generic failure", async () => {
  getAdminSearchProviders.mockResolvedValue([
    { id: "spotify", name: "Spotify", kind: "external", enabled: true, status: "enabled", config: {} },
  ]);
  getAdminSourceProviders.mockResolvedValue([]);
  testAdminSearchProvider.mockResolvedValue({
    id: "spotify",
    ok: false,
    status: "not_configured",
    message: "Spotify search is not configured — add a Client ID/Secret here or on the spotDL Downloader plugin.",
  });

  render(<AdminSources />);

  const testButton = await screen.findByRole("button", { name: "Test" });
  fireEvent.click(testButton);

  await waitFor(() => {
    expect(testAdminSearchProvider).toHaveBeenCalledWith("spotify");
  });

  expect(await screen.findByText(/Spotify search is not configured/i)).toBeInTheDocument();
});

test("testing a source provider shows the provider name instead of a generic 'Provider is unavailable' message", async () => {
  getAdminSearchProviders.mockResolvedValue([]);
  getAdminSourceProviders.mockResolvedValue([
    { id: "itunes-preview", name: "External preview", enabled: true, capabilities: {}, config: {} },
  ]);
  testAdminSourceProvider.mockResolvedValue({
    id: "itunes-preview",
    ok: false,
    status: "plugin_error",
    message: "External preview is unavailable (iTunes responded with 500)",
  });

  render(<AdminSources />);

  const testButton = await screen.findByRole("button", { name: "Test" });
  fireEvent.click(testButton);

  await waitFor(() => {
    expect(testAdminSourceProvider).toHaveBeenCalledWith("itunes-preview");
  });

  expect(
    await screen.findByText(/External preview is unavailable \(iTunes responded with 500\)/i)
  ).toBeInTheDocument();
});

test("checking the search provider enabled box still calls update as before", async () => {
  getAdminSearchProviders.mockResolvedValue([
    { id: "spotify", name: "Spotify", kind: "external", enabled: false, status: "disabled", config: {} },
  ]);
  getAdminSourceProviders.mockResolvedValue([]);
  updateAdminSearchProvider.mockResolvedValue({
    id: "spotify",
    name: "Spotify",
    kind: "external",
    enabled: true,
    status: "enabled",
    config: {},
  });

  render(<AdminSources />);

  const checkbox = await screen.findByRole("checkbox");
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(updateAdminSearchProvider).toHaveBeenCalledWith("spotify", { enabled: true });
  });
});
