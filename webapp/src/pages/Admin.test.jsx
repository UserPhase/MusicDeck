import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Admin from "./Admin";
import {
  createUser,
  deleteUser,
  getAdminBackendConnections,
  getAdminHealth,
  getAdminPlugins,
  getAdminSearchProviders,
  getAdminSourceProviders,
  getAdminAcquisitions,
  cleanupAcquisitions,
  scanAcquisitionsLibrary,
  getServerSettings,
  getUsers,
  installAdminPlugin,
  uninstallAdminPlugin,
  updateServerSettings,
  updateAdminPlugin,
  updateAdminSearchProvider,
  testAdminPlugin,
  updateUser,
} from "../api/musicdeck";
import { useAuth } from "../context/AuthContext";


jest.mock("../api/musicdeck", () => ({
  createUser: jest.fn(),
  deleteUser: jest.fn(),
  getAdminBackendConnections: jest.fn(),
  getAdminHealth: jest.fn(),
  getAdminPlugins: jest.fn(),
  getAdminSearchProviders: jest.fn(),
  getAdminSourceProviders: jest.fn(),
  getAdminAcquisitions: jest.fn(),
  cleanupAcquisitions: jest.fn(),
  scanAcquisitionsLibrary: jest.fn(),
  getServerSettings: jest.fn(),
  getUsers: jest.fn(),
  installAdminPlugin: jest.fn(),
  uninstallAdminPlugin: jest.fn(),
  updateServerSettings: jest.fn(),
  updateAdminPlugin: jest.fn(),
  updateAdminSearchProvider: jest.fn(),
  updateAdminSourceProvider: jest.fn(),
  testAdminPlugin: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock("../context/AuthContext", () => ({
  useAuth: jest.fn(),
}));


function mockAdminApi() {
  getAdminHealth.mockResolvedValue({
    ok: true,
    backend: "navidrome",
    database: "sqlite",
    counts: { users: 2 },
  });
  getUsers.mockResolvedValue([
    {
      id: "admin-1",
      username: "admin",
      displayName: "Admin",
      role: "admin",
      disabled: false,
    },
    {
      id: "user-1",
      username: "listener",
      displayName: "Listener",
      role: "user",
      disabled: false,
    },
  ]);
  getAdminBackendConnections.mockResolvedValue([
    {
      id: "backend-1",
      type: "navidrome",
      name: "Navidrome",
      enabled: true,
    },
  ]);
  getServerSettings.mockResolvedValue([
    { key: "jobs.maxConcurrency", value: "2" },
  ]);
  getAdminSearchProviders.mockResolvedValue([
    { id: "library", name: "Your Library", kind: "library", enabled: true, status: "enabled", config: {} },
    { id: "itunes", name: "External Catalog", kind: "external", enabled: false, status: "disabled", config: {} },
  ]);
  getAdminSourceProviders.mockResolvedValue([
    { id: "library", name: "Library", enabled: true },
    { id: "itunes-preview", name: "External preview", enabled: false },
  ]);
  getAdminAcquisitions.mockResolvedValue({
    activeJobs: 0,
    queuedJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    totalJobs: 0,
    storageUsedBytes: 0,
    tempStorageUsedBytes: 0,
    musicRoot: "./data/music",
    downloadDirectory: "./data/music",
    maxConcurrentDownloads: 1,
    autoScanLibrary: true,
    cleanupPolicy: "on_completion",
    recentJobs: [],
  });
  getAdminPlugins.mockResolvedValue([
    {
      id: "example-plugin",
      name: "Example Plugin",
      version: "1.0.0",
      status: "disabled",
      enabled: false,
      capabilities: ["recommendation"],
      permissions: ["history.read"],
      approvedPermissions: [],
      config: { endpoint: "https://example.test", apiKey: true },
      configFields: [
        { key: "endpoint", label: "Endpoint", required: true, secret: false, configured: true },
        { key: "apiKey", label: "API key", required: true, secret: true, configured: true },
      ],
    },
  ]);
}

function renderAdmin(user = { id: "admin-1", username: "admin", role: "admin" }) {
  useAuth.mockReturnValue({ session: user });

  return render(
    <MemoryRouter>
      <Admin />
    </MemoryRouter>
  );
}


beforeEach(() => {
  jest.clearAllMocks();
  window.confirm = jest.fn(() => true);
});


test("admin users can load the dashboard", async () => {
  mockAdminApi();

  renderAdmin();

  expect(await screen.findByRole("heading", { name: /admin dashboard/i })).toBeInTheDocument();
  expect(screen.getByText(/online/i)).toBeInTheDocument();
  expect(screen.getAllByText(/navidrome/i).length).toBeGreaterThan(0);
  expect(getAdminHealth).toHaveBeenCalledTimes(1);
});


test("normal users cannot access the admin dashboard", () => {
  mockAdminApi();

  renderAdmin({ id: "user-1", username: "listener", role: "user" });

  expect(screen.queryByRole("heading", { name: /admin dashboard/i })).not.toBeInTheDocument();
  expect(getAdminHealth).not.toHaveBeenCalled();
});


test("admin users can create, update, and delete users", async () => {
  mockAdminApi();
  createUser.mockResolvedValue({
    id: "user-2",
    username: "newuser",
    displayName: "New User",
    role: "user",
    disabled: false,
  });
  updateUser.mockResolvedValue({
    id: "user-1",
    username: "listener",
    displayName: "Listener",
    role: "admin",
    disabled: false,
  });
  deleteUser.mockResolvedValue(undefined);

  renderAdmin();

  fireEvent.change(await screen.findByLabelText(/^username$/i), {
    target: { value: "newuser" },
  });
  fireEvent.change(screen.getByLabelText(/^display name$/i), {
    target: { value: "New User" },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create user/i }));

  await waitFor(() => {
    expect(createUser).toHaveBeenCalledWith({
      username: "newuser",
      password: "password123",
      displayName: "New User",
      role: "user",
    });
  });

  fireEvent.change(screen.getByLabelText(/role for listener/i), {
    target: { value: "admin" },
  });

  await waitFor(() => {
    expect(updateUser).toHaveBeenCalledWith("user-1", { role: "admin" });
  });

  fireEvent.click(screen.getAllByRole("button", { name: /delete/i })[1]);

  await waitFor(() => {
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });
});


test("loads and saves backend/server settings and handles unauthorized errors", async () => {
  mockAdminApi();
  updateServerSettings.mockResolvedValue([
    { key: "jobs.maxConcurrency", value: "3" },
  ]);

  renderAdmin();

  expect((await screen.findAllByText(/Navidrome/i)).length).toBeGreaterThan(0);

  fireEvent.change(screen.getByLabelText(/job concurrency/i), {
    target: { value: "3" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save server settings/i }));

  await waitFor(() => {
    expect(updateServerSettings).toHaveBeenCalledWith({
      "library.scanSchedule": "",
      "jobs.maxConcurrency": 3,
    });
  });

  getAdminHealth.mockRejectedValueOnce(new Error("Admin access required"));
  getUsers.mockResolvedValueOnce([]);
  getAdminBackendConnections.mockResolvedValueOnce([]);
  getAdminSearchProviders.mockResolvedValueOnce([]);
  getAdminSourceProviders.mockResolvedValueOnce([]);
  getAdminPlugins.mockResolvedValueOnce([]);
  getServerSettings.mockResolvedValueOnce([]);
  getAdminAcquisitions.mockResolvedValueOnce(null);

  renderAdmin();

  expect(await screen.findByText(/admin access required/i)).toBeInTheDocument();
});

test("admin can view and enable a plugin without exposing secrets", async () => {
  mockAdminApi();
  updateAdminPlugin.mockResolvedValue({
    id: "example-plugin",
    name: "Example Plugin",
    version: "1.0.0",
    status: "enabled",
    enabled: true,
    capabilities: ["recommendation"],
    permissions: ["history.read"],
    approvedPermissions: [],
  });

  renderAdmin();

  expect(await screen.findByRole("heading", { name: /^plugins$/i })).toBeInTheDocument();
  expect(screen.getByText("Example Plugin")).toBeInTheDocument();
  expect(screen.getByText(/recommendation/)).toBeInTheDocument();
  expect(screen.queryByText(/secret|api key/i)).toBeNull();

  const pluginsTable = screen.getByRole("table", { name: /^plugins$/i });
  fireEvent.click(within(pluginsTable).getByRole("checkbox", { name: /enabled/i }));

  await waitFor(() => {
    expect(updateAdminPlugin).toHaveBeenCalledWith("example-plugin", {
      enabled: true,
      permissions: ["history.read"],
    });
  });
});

test("admin can configure plugin settings and test the connection", async () => {
  mockAdminApi();
  updateAdminPlugin.mockResolvedValue({
    id: "example-plugin",
    name: "Example Plugin",
    enabled: true,
    status: "enabled",
    capabilities: ["recommendation"],
    permissions: ["history.read"],
    approvedPermissions: ["history.read"],
    config: { endpoint: "https://example.test", apiKey: true },
    configFields: [],
  });
  testAdminPlugin.mockResolvedValue({ ok: true, message: "Connection successful" });

  renderAdmin();

  fireEvent.click(await screen.findByRole("button", { name: /example plugin settings/i }));

  const endpoint = screen.getByLabelText(/^endpoint$/i);
  const apiKey = screen.getByLabelText(/api key/i);
  expect(endpoint).toHaveValue("https://example.test");
  expect(apiKey).toHaveValue("");
  expect(apiKey).toHaveAttribute("type", "password");

  fireEvent.change(apiKey, { target: { value: "new-secret" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /history\.read/i }));
  fireEvent.click(screen.getByRole("button", { name: /save plugin settings/i }));

  await waitFor(() => {
    expect(updateAdminPlugin).toHaveBeenCalledWith("example-plugin", expect.objectContaining({
      config: { endpoint: "https://example.test", apiKey: "new-secret" },
      permissions: ["history.read"],
    }));
  });

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

  await waitFor(() => {
    expect(testAdminPlugin).toHaveBeenCalledWith("example-plugin");
  });
  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent(/connection successful/i);
  });
});

test("admin can install a custom plugin from a manifest and it stays disabled", async () => {
  mockAdminApi();
  installAdminPlugin.mockResolvedValue({
    id: "com.example.music-plugin",
    name: "Example Music Plugin",
    version: "1.0.0",
    status: "disabled",
    enabled: false,
    origin: "third-party",
    capabilities: ["search"],
    permissions: ["network.request"],
    approvedPermissions: [],
  });

  renderAdmin();

  fireEvent.click(await screen.findByRole("button", { name: /\+ add plugin/i }));

  const manifest = {
    manifestVersion: 1,
    id: "com.example.music-plugin",
    name: "Example Music Plugin",
    version: "1.0.0",
    capabilities: ["search"],
    permissions: ["network.request"],
  };

  fireEvent.change(screen.getByLabelText(/manifest\.json/i), {
    target: { value: JSON.stringify(manifest) },
  });

  expect(await screen.findByText("network.request")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));

  await waitFor(() => {
    expect(installAdminPlugin).toHaveBeenCalledWith(manifest);
  });

  await waitFor(() => {
    expect(screen.getAllByText("Example Music Plugin").length).toBeGreaterThan(0);
  });
  expect(screen.getByText(/third-party/i)).toBeInTheDocument();
});

test("admin sees a validation error for malformed manifest JSON", async () => {
  mockAdminApi();
  renderAdmin();

  fireEvent.click(await screen.findByRole("button", { name: /\+ add plugin/i }));
  fireEvent.change(screen.getByLabelText(/manifest\.json/i), {
    target: { value: "{not valid json" },
  });

  expect(await screen.findByText(/not valid json syntax/i)).toBeInTheDocument();
  expect(installAdminPlugin).not.toHaveBeenCalled();
});

test("admin can uninstall a third-party plugin", async () => {
  mockAdminApi();
  getAdminPlugins.mockResolvedValue([
    {
      id: "com.example.music-plugin",
      name: "Example Music Plugin",
      version: "1.0.0",
      status: "disabled",
      enabled: false,
      origin: "third-party",
      capabilities: ["search"],
      permissions: ["network.request"],
      approvedPermissions: [],
    },
  ]);
  uninstallAdminPlugin.mockResolvedValue(undefined);

  renderAdmin();

  fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));

  await waitFor(() => {
    expect(uninstallAdminPlugin).toHaveBeenCalledWith("com.example.music-plugin");
  });

  await waitFor(() => {
    expect(screen.queryByText("Example Music Plugin")).not.toBeInTheDocument();
  });
});


test("admin can view and enable a search provider without exposing private config", async () => {
  mockAdminApi();
  updateAdminSearchProvider.mockResolvedValue({
    id: "itunes",
    name: "External Catalog",
    kind: "external",
    enabled: true,
    status: "enabled",
    config: {},
  });

  renderAdmin();

  expect(await screen.findByRole("heading", { name: /search providers/i })).toBeInTheDocument();
  expect(screen.getByText("External Catalog")).toBeInTheDocument();
  expect(screen.queryByText(/api key|token|secret/i)).toBeNull();

  fireEvent.click(screen.getAllByRole("checkbox", { name: /enabled/i, exact: true })[3]);

  await waitFor(() => {
    expect(updateAdminSearchProvider).toHaveBeenCalledWith("itunes", { enabled: true });
  });
});
