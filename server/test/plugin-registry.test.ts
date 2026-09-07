import { afterEach, describe, expect, test } from "vitest";

import type { MusicDeckPlugin } from "../src/plugins/plugin-registry.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;

function plugin(overrides: Partial<MusicDeckPlugin["manifest"]> = {}, register?: MusicDeckPlugin["register"]): MusicDeckPlugin {
  return {
    manifest: {
      id: "example-plugin",
      name: "Example Plugin",
      version: "1.0.0",
      capabilities: ["recommendation", "ui"],
      permissions: ["history.read", "ui.register"],
      config: {
        fields: [
          { key: "endpoint", required: true },
          { key: "apiKey", secret: true, required: true },
        ],
      },
      ...overrides,
    },
    register,
  };
}

async function setup() {
  current = await createTestServer();
  return current;
}

afterEach(async () => {
  if (current) {
    await closeTestServer(current.app, current.db);
    current = null;
  }
});

describe("PluginRegistry", () => {
  test("validates manifests and rejects duplicate or unsupported plugins", async () => {
    const { plugins } = await setup();
    await plugins.register(plugin());

    await expect(plugins.register(plugin())).rejects.toThrow("already registered");
    await expect(plugins.register(plugin({ id: "bad plugin!" }))).rejects.toThrow("Invalid plugin ID");
    await expect(plugins.register(plugin({ id: "bad-capability", capabilities: ["unknown"] }))).rejects.toThrow("Unsupported plugin capability");
    await expect(plugins.register(plugin({ id: "bad-permission", permissions: ["everything"] }))).rejects.toThrow("Unsupported plugin permission");
  });

  test("requires declared configuration before enabling and redacts secrets", async () => {
    const { plugins } = await setup();
    await plugins.register(plugin());

    await expect(plugins.enable("example-plugin")).rejects.toThrow("misconfigured");
    expect(plugins.get("example-plugin", true)).toMatchObject({ status: "error", error: "not_configured" });

    plugins.configure("example-plugin", {
      enabled: true,
      config: { endpoint: "https://example.test", apiKey: "secret-key" },
      permissions: ["history.read", "ui.register"],
    });
    await plugins.enable("example-plugin");

    const admin = plugins.get("example-plugin", true);
    const user = plugins.get("example-plugin", false);
    expect(admin.config).toEqual({ endpoint: "https://example.test", apiKey: true });
    expect(JSON.stringify(admin)).not.toContain("secret-key");
    expect(user.config).toEqual({});
  });

  test("enforces event and UI permissions and isolates failing handlers", async () => {
    const { plugins } = await setup();
    const seen: string[] = [];
    await plugins.register(plugin({}, (context) => {
      context.events.subscribe("track.started", () => {
        seen.push("started");
        throw new Error("broken handler");
      });
      context.ui?.register({ location: "home", id: "example-section", title: "Example" });
    }));

    plugins.configure("example-plugin", {
      enabled: true,
      config: { endpoint: "https://example.test", apiKey: "secret" },
      permissions: ["history.read"],
    });
    await plugins.enable("example-plugin");

    plugins.emit("track.started", { trackId: "track-1" });

    expect(seen).toEqual(["started"]);
    expect(plugins.get("example-plugin", true).logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", message: "plugin event handler failed" }),
    ]));
    expect(plugins.get("example-plugin", true).uiExtensions).toEqual([]);
  });

  test("bridges plugin recommendation providers into the existing registry", async () => {
    const { plugins, recommendations } = await setup();
    await plugins.register(plugin({ capabilities: ["recommendation"] }, (context) => {
      context.recommendations?.register({
        id: "example-recommendations",
        name: "Example recommendations",
        async recommend() {
          return [];
        },
      });
    }));
    plugins.configure("example-plugin", { enabled: true, config: { endpoint: "https://example.test", apiKey: "secret" } });
    await plugins.enable("example-plugin");

    expect(recommendations.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example-recommendations" }),
    ]));
  });

  test("serves safe plugin metadata to users and admin state to admins", async () => {
    const { app, plugins } = await setup();
    await plugins.register(plugin());
    const { cookie } = await login(app);

    const userList = await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } });
    const adminList = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: { cookie } });

    expect(userList.statusCode).toBe(200);
    expect(userList.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example-plugin", config: {} }),
    ]));
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example-plugin", status: "disabled" }),
    ]));
  });

  test("admin can configure, approve permissions, and test a plugin", async () => {
    const { app, plugins } = await setup();
    await plugins.register(plugin());
    const { cookie } = await login(app);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/example-plugin",
      headers: { cookie },
      payload: {
        enabled: true,
        config: { endpoint: "https://example.test", apiKey: "secret-key" },
        permissions: ["history.read"],
      },
    });
    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/example-plugin/test",
      headers: { cookie },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().plugin).toMatchObject({ status: "enabled", approvedPermissions: ["history.read"] });
    expect(JSON.stringify(updated.json())).not.toContain("secret-key");
    expect(tested.statusCode).toBe(200);
    expect(tested.json().test).toMatchObject({ ok: true });
    expect(plugins.get("example-plugin", true).status).toBe("enabled");
  });
});
