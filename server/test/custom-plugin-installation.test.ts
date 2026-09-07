import { afterEach, describe, expect, test } from "vitest";

import { CURRENT_MANIFEST_VERSION, ManifestValidationError, parseCustomManifest } from "../src/plugins/plugin-manifest.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: CURRENT_MANIFEST_VERSION,
    id: "com.example.music-plugin",
    name: "Example Music Plugin",
    version: "1.0.0",
    description: "Example MusicDeck plugin",
    author: "Example",
    capabilities: ["search", "metadata"],
    permissions: ["network.request", "library.read"],
    configuration: {
      apiKey: { type: "secret", required: true },
    },
    ...overrides,
  };
}

describe("parseCustomManifest", () => {
  test("accepts a valid manifest and normalizes it", () => {
    const manifest = parseCustomManifest(validManifest());
    expect(manifest.id).toBe("com.example.music-plugin");
    expect(manifest.capabilities).toEqual(["search", "metadata"]);
    expect(manifest.permissions).toEqual(["network.request", "library.read"]);
    expect(manifest.config?.fields).toEqual([
      { key: "apiKey", label: "apiKey", secret: true, required: true, default: undefined },
    ]);
  });

  test("rejects malformed manifests", () => {
    expect(() => parseCustomManifest(null)).toThrow(ManifestValidationError);
    expect(() => parseCustomManifest("not an object")).toThrow(ManifestValidationError);
    expect(() => parseCustomManifest([])).toThrow(ManifestValidationError);
  });

  test("rejects unsupported manifest versions", () => {
    expect(() => parseCustomManifest(validManifest({ manifestVersion: 999 }))).toThrow(/Unsupported manifest version/);
  });

  test("rejects invalid plugin IDs", () => {
    expect(() => parseCustomManifest(validManifest({ id: "bad id!" }))).toThrow(/Invalid plugin ID/);
  });

  test("rejects unknown capabilities", () => {
    expect(() => parseCustomManifest(validManifest({ capabilities: ["time-travel"] }))).toThrow(/Unknown plugin capability/);
  });

  test("rejects unknown permissions", () => {
    expect(() => parseCustomManifest(validManifest({ permissions: ["root.access"] }))).toThrow(/Unknown plugin permission/);
  });

  test("rejects malformed configuration schema", () => {
    expect(() => parseCustomManifest(validManifest({ configuration: { apiKey: { type: "nonsense" } } }))).toThrow(/Unknown configuration field type/);
  });

  test("requires name and version", () => {
    expect(() => parseCustomManifest(validManifest({ name: "" }))).toThrow(/name is required/);
    expect(() => parseCustomManifest(validManifest({ version: "" }))).toThrow(/version is required/);
  });
});

describe("custom plugin installation API", () => {
  test("installs a valid plugin disabled by default and requires explicit admin enable", async () => {
    current = await createTestServer();
    const { app, plugins } = current;
    const { cookie } = await login(app);

    const install = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    expect(install.statusCode).toBe(201);
    const body = install.json();
    expect(body.plugin.id).toBe("com.example.music-plugin");
    expect(body.plugin.origin).toBe("third-party");
    expect(body.plugin.status).toBe("disabled");
    expect(body.plugin.enabled).toBe(false);

    // Disabled after install: it must not appear active until an admin approves and enables it.
    const listed = plugins.list(true).find((p: any) => p.id === "com.example.music-plugin");
    expect(listed?.status).toBe("disabled");
    expect(listed?.enabled).toBe(false);
  });

  test("rejects malformed manifest with a normalized 400", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const install = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: { manifestVersion: 1 } },
    });

    expect(install.statusCode).toBe(400);
    expect(install.json().error.code).toBe("INVALID_MANIFEST");
  });

  test("rejects duplicate plugin IDs", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ALREADY_INSTALLED");
  });

  test("rejects installing a plugin whose ID collides with a first-party plugin", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const install = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest({ id: "listenbrainz" }) },
    });

    expect(install.statusCode).toBe(409);
  });

  test("requires admin authentication", async () => {
    current = await createTestServer();
    const { app } = current;

    const install = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      payload: { manifest: validManifest() },
    });

    expect(install.statusCode).toBe(401);
  });

  test("supports enabling an installed custom plugin only after explicit approval", async () => {
    current = await createTestServer();
    const { app, plugins } = current;
    const { cookie } = await login(app);

    await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    const beforeApproval = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/com.example.music-plugin",
      headers: { cookie },
      payload: { enabled: true, config: { apiKey: "secret-value" } },
    });

    expect(beforeApproval.statusCode).toBe(200);
    const enabled = plugins.get("com.example.music-plugin", true);
    expect(enabled.status).toBe("enabled");
  });

  test("uninstalls a custom plugin and removes its configuration", async () => {
    current = await createTestServer();
    const { app, plugins } = current;
    const { cookie } = await login(app);

    await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    const uninstall = await app.inject({
      method: "DELETE",
      url: "/api/admin/plugins/com.example.music-plugin",
      headers: { cookie },
    });

    expect(uninstall.statusCode).toBe(204);
    expect(() => plugins.get("com.example.music-plugin", true)).toThrow();
  });

  test("prevents uninstalling first-party plugins through the custom-plugin uninstall route", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const uninstall = await app.inject({
      method: "DELETE",
      url: "/api/admin/plugins/listenbrainz",
      headers: { cookie },
    });

    expect(uninstall.statusCode).toBe(400);
    expect(uninstall.json().error.code).toBe("NOT_UNINSTALLABLE");
  });

  test("returns 404 uninstalling an unknown plugin", async () => {
    current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const uninstall = await app.inject({
      method: "DELETE",
      url: "/api/admin/plugins/does-not-exist",
      headers: { cookie },
    });

    expect(uninstall.statusCode).toBe(404);
  });

  test("persists custom plugin installs across registry restarts", async () => {
    current = await createTestServer();
    const { app, plugins } = current;
    const { cookie } = await login(app);

    await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: { cookie },
      payload: { manifest: validManifest() },
    });

    const manifests = plugins.loadInstalledCustomPlugins();
    expect(manifests.some((m) => m.id === "com.example.music-plugin")).toBe(true);
  });
});
