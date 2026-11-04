import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AdminPlugins from "../../pages/admin/AdminPlugins";
import AdminPluginDetail from "../../pages/admin/AdminPluginDetail";
import {
  getAdminPlugins,
  installAdminPlugin,
  testAdminPlugin,
  uninstallAdminPlugin,
  updateAdminPlugin,
} from "../../api/musicdeck";

jest.mock("../../api/extensions", () => ({
  getExtensions: jest.fn(async () => ({ extensions: [], issues: [] })),
  discoverExtensions: jest.fn(async () => ({ extensions: [], issues: [] })),
  setExtensionEnabled: jest.fn(),
}));

jest.mock("../../api/musicdeck", () => ({
  getAdminPlugins: jest.fn(),
  installAdminPlugin: jest.fn(),
  testAdminPlugin: jest.fn(),
  uninstallAdminPlugin: jest.fn(),
  updateAdminPlugin: jest.fn(),
}));

jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ session: { id: "a1", username: "admin", role: "admin" } }),
}));


const PLUGINS = [
  {
    id: "listenbrainz",
    name: "ListenBrainz",
    version: "1.0.0",
    status: "success",
    enabled: true,
    capabilities: ["scrobbling"],
    permissions: [],
    approvedPermissions: [],
    config: {},
    configFields: [],
    origin: "first-party",
  },
  {
    id: "spotify-importer",
    name: "Spotify Playlist Importer",
    version: "1.2.0",
    status: "disabled",
    enabled: false,
    capabilities: ["playlist-import"],
    permissions: ["playlists.read"],
    approvedPermissions: [],
    config: {},
    configFields: [],
    origin: "first-party",
  },
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
      { key: "endpoint", label: "Endpoint", required: true, secret: false },
      { key: "apiKey", label: "API key", required: true, secret: true },
    ],
    origin: "third-party",
  },
];


function renderPlugins() {
  return render(
    <MemoryRouter initialEntries={["/admin/plugins"]}>
      <Routes>
        <Route path="/admin/plugins" element={<AdminPlugins />} />
        <Route path="/admin/plugins/:pluginId" element={<AdminPluginDetail />} />
      </Routes>
    </MemoryRouter>
  );
}


beforeEach(() => {
  jest.clearAllMocks();
  getAdminPlugins.mockResolvedValue(PLUGINS);
  window.confirm = jest.fn(() => true);
});


describe("Plugins page", () => {
  test("spotDL format defaults are saved even without changing the selector, and a new format can be selected", async () => {
    const plugin = { ...PLUGINS[0], id: "spotdl-downloader", name: "SpotDL Downloader", config: {},
      configFields: [{ key: "outputFormat", label: "Audio format", type: "select", default: "best",
        description: "Best preserves the source bitrate; FLAC cannot improve a lossy source.",
        options: [{ value: "best", label: "Best source quality (M4A)" }, { value: "opus", label: "Opus" }, { value: "mp3", label: "MP3" }] },
        { key: "autoScan", label: "Scan after import", default: false }] };
    getAdminPlugins.mockResolvedValue([plugin]);
    updateAdminPlugin.mockImplementation(async (_id, settings) => ({ ...plugin, config: settings.config }));
    renderPlugins();
    fireEvent.click(await screen.findByRole("button", { name: /open spotdl downloader/i }));
    const format = await screen.findByRole("combobox", { name: /Audio format/ });
    expect(format).toHaveValue("best");
    expect(screen.getByRole("checkbox", { name: "Scan after import" })).not.toBeChecked();
    expect(format).toHaveAccessibleDescription("Best preserves the source bitrate; FLAC cannot improve a lossy source.");
    fireEvent.click(screen.getByRole("button", { name: "Save plugin settings" }));
    await waitFor(() => expect(updateAdminPlugin).toHaveBeenCalledWith(plugin.id, expect.objectContaining({ config: { outputFormat: "best", autoScan: false } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save plugin settings" })).toBeEnabled());
    fireEvent.change(format, { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plugin settings" }));
    await waitFor(() => expect(updateAdminPlugin).toHaveBeenLastCalledWith(plugin.id, expect.objectContaining({ config: { outputFormat: "opus", autoScan: false } })));
  });
  test("lists plugins with name, version and status", async () => {
    renderPlugins();

    expect(await screen.findByText("ListenBrainz")).toBeInTheDocument();
    expect(screen.getByText("Spotify Playlist Importer")).toBeInTheDocument();
    expect(screen.getByText("Example Plugin")).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(screen.getAllByText(/● Enabled/).length).toBe(1);
    expect(screen.getAllByText(/○ Disabled/).length).toBe(2);
  });

  test("renders exactly one Add Plugin action and one page title", async () => {
    renderPlugins();

    await screen.findByText("ListenBrainz");

    expect(
      screen.getAllByRole("button", { name: /\+ add plugin/i })
    ).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Plugins" })).toHaveLength(1);
    expect(screen.getAllByLabelText(/search plugins/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/filter plugins/i)).toHaveLength(1);
    expect(screen.getAllByRole("row", { name: /plugin\s+version\s+description\s+status/i })).toHaveLength(1);
  });

  test("renders each plugin row exactly once", async () => {
    renderPlugins();

    expect(await screen.findAllByText("ListenBrainz")).toHaveLength(1);
    expect(screen.getAllByText("Spotify Playlist Importer")).toHaveLength(1);
    expect(screen.getAllByText("Example Plugin")).toHaveLength(1);
  });

  test("filters plugins by status", async () => {
    renderPlugins();

    await screen.findByText("ListenBrainz");

    fireEvent.change(screen.getByLabelText(/filter plugins/i), {
      target: { value: "enabled" },
    });

    expect(screen.getByText("ListenBrainz")).toBeInTheDocument();
    expect(screen.queryByText("Example Plugin")).not.toBeInTheDocument();
  });

  test("searches plugins by name", async () => {
    renderPlugins();

    await screen.findByText("ListenBrainz");

    fireEvent.change(screen.getByLabelText(/search plugins/i), {
      target: { value: "spotify" },
    });

    expect(screen.getByText("Spotify Playlist Importer")).toBeInTheDocument();
    expect(screen.queryByText("ListenBrainz")).not.toBeInTheDocument();
  });

  test("toggles a plugin enabled state", async () => {
    updateAdminPlugin.mockResolvedValue({
      ...PLUGINS[0],
      enabled: false,
    });

    renderPlugins();

    await screen.findByText("ListenBrainz");

    fireEvent.click(
      screen.getByRole("checkbox", { name: /enable listenbrainz/i })
    );

    await waitFor(() =>
      expect(updateAdminPlugin).toHaveBeenCalledWith("listenbrainz", {
        enabled: false,
        permissions: [],
      })
    );
  });

  test("clicking a plugin opens its detail page", async () => {
    renderPlugins();

    await screen.findByText("Example Plugin");

    fireEvent.click(
      screen.getByRole("button", { name: /open example plugin/i })
    );

    expect(
      await screen.findByRole("heading", { name: "Example Plugin" })
    ).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint")).toBeInTheDocument();
  });
});


describe("Plugin detail page", () => {
  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={["/admin/plugins/example-plugin"]}>
        <Routes>
          <Route path="/admin/plugins/:pluginId" element={<AdminPluginDetail />} />
        </Routes>
      </MemoryRouter>
    );
  }

  test("shows status, capabilities, permissions and redacted secrets", async () => {
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Example Plugin" })
    ).toBeInTheDocument();
    expect(screen.getByText("recommendation")).toBeInTheDocument();
    expect(screen.getByText("history.read")).toBeInTheDocument();

    // Secret field renders as a password input with a "keep" hint.
    const apiKeyInput = screen.getByLabelText(/API key/i);
    expect(apiKeyInput).toHaveAttribute("type", "password");
    expect(screen.getByText(/configured — enter to replace/i)).toBeInTheDocument();
  });

  test("runs a connection test", async () => {
    testAdminPlugin.mockResolvedValue({ ok: true, message: "Connection successful" });

    renderDetail();

    await screen.findByRole("heading", { name: "Example Plugin" });

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connection successful"
    );
  });

  test("removes a third-party plugin after confirmation", async () => {
    uninstallAdminPlugin.mockResolvedValue(undefined);

    renderDetail();

    await screen.findByRole("heading", { name: "Example Plugin" });

    fireEvent.click(screen.getByRole("button", { name: /remove plugin/i }));

    await waitFor(() =>
      expect(uninstallAdminPlugin).toHaveBeenCalledWith("example-plugin")
    );
  });
});
