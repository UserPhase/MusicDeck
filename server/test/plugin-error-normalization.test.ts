import { describe, expect, test, vi } from "vitest";

import { classifyPluginError, ClassifiedPluginError, httpStatusForPluginError } from "../src/plugins/plugin-errors.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

describe("plugin error classification", () => {
  test("classifies known failure shapes into normalized statuses", () => {
    expect(classifyPluginError(new Error("Plugin is misconfigured")).status).toBe("not_configured");
    expect(classifyPluginError(new Error("missing required field")).status).toBe("not_configured");
    expect(classifyPluginError(new Error("Plugin event permission denied")).status).toBe("permission_denied");
    expect(classifyPluginError(new Error("authentication failed: 401")).status).toBe("authentication_failed");
    expect(classifyPluginError(new Error("Unauthorized")).status).toBe("authentication_failed");
    expect(classifyPluginError(new Error("request timed out")).status).toBe("timeout");
    expect(classifyPluginError(new Error("fetch failed: ECONNREFUSED")).status).toBe("provider_unavailable");
    expect(classifyPluginError(new Error("totally unexpected failure")).status).toBe("plugin_error");
  });

  test("never leaks the original message for unknown errors", () => {
    const result = classifyPluginError(new Error("stack trace with secret-token-abc123"));
    expect(result.message).not.toContain("secret-token-abc123");
  });

  test("respects explicit classification via ClassifiedPluginError", () => {
    const result = classifyPluginError(new ClassifiedPluginError("authentication_failed", "custom message"));
    expect(result).toEqual({ status: "authentication_failed", message: "custom message" });
  });

  test("maps normalized statuses to sensible HTTP codes", () => {
    expect(httpStatusForPluginError("not_configured")).toBe(400);
    expect(httpStatusForPluginError("authentication_failed")).toBe(401);
    expect(httpStatusForPluginError("permission_denied")).toBe(403);
    expect(httpStatusForPluginError("provider_unavailable")).toBe(502);
    expect(httpStatusForPluginError("timeout")).toBe(502);
    expect(httpStatusForPluginError("plugin_error")).toBe(500);
    expect(httpStatusForPluginError("success")).toBe(200);
  });
});

describe("plugin test endpoint never returns an opaque 500", () => {
  test("returns a normalized not_configured result instead of throwing when required fields are missing", async () => {
    const current = await createTestServer();
    const { app, plugins } = current;
    await plugins.register({
      manifest: {
        id: "needs-config",
        name: "Needs Config",
        version: "1.0.0",
        capabilities: ["metadata"],
        permissions: [],
        config: { fields: [{ key: "apiKey", required: true, secret: true }] },
      },
      async test() {
        return { ok: true };
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/plugins/needs-config/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "not_configured" });
    await closeTestServer(app, current.db);
  });

  test("returns a normalized plugin_error result when the plugin throws, without leaking the raw message", async () => {
    const current = await createTestServer();
    const { app, plugins } = current;
    await plugins.register({
      manifest: {
        id: "throws-plugin",
        name: "Throws Plugin",
        version: "1.0.0",
        capabilities: ["metadata"],
        permissions: [],
      },
      async test() {
        throw new Error("raw upstream secret-header-xyz");
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/plugins/throws-plugin/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "plugin_error" });
    expect(JSON.stringify(response.json())).not.toContain("secret-header-xyz");
    await closeTestServer(app, current.db);
  });

  test("classifies an authentication failure test result without a 500", async () => {
    const current = await createTestServer();
    const { app, plugins } = current;
    await plugins.register({
      manifest: {
        id: "auth-fail-plugin",
        name: "Auth Fail Plugin",
        version: "1.0.0",
        capabilities: ["metadata"],
        permissions: [],
      },
      async test() {
        return { ok: false, message: "authentication failed" };
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/plugins/auth-fail-plugin/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "authentication_failed", message: "authentication failed" });
    await closeTestServer(app, current.db);
  });

  test("enabling a misconfigured plugin returns a normalized 400 instead of a generic error", async () => {
    const current = await createTestServer();
    const { app, plugins } = current;
    await plugins.register({
      manifest: {
        id: "needs-config-2",
        name: "Needs Config 2",
        version: "1.0.0",
        capabilities: ["metadata"],
        permissions: [],
        config: { fields: [{ key: "apiKey", required: true, secret: true }] },
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/needs-config-2",
      headers: { cookie },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NOT_CONFIGURED");
    await closeTestServer(app, current.db);
  });

  test("a plugin throwing during enable is classified and logged, not surfaced as a generic 500", async () => {
    const current = await createTestServer();
    const { app, plugins } = current;
    await plugins.register({
      manifest: {
        id: "enable-throws",
        name: "Enable Throws",
        version: "1.0.0",
        capabilities: ["metadata"],
        permissions: [],
      },
      register() {
        throw new Error("provider unavailable: ECONNREFUSED");
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/plugins/enable-throws",
      headers: { cookie },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PROVIDER_UNAVAILABLE");
    await closeTestServer(app, current.db);
  });
});

describe("source provider test endpoint returns normalized results", () => {
  test("classifies a thrown provider error instead of a raw failure", async () => {
    const current = await createTestServer();
    const { app, sourceProviders } = current;
    sourceProviders.register({
      id: "flaky-provider",
      name: "Flaky Provider",
      capabilities: { tracks: true, albums: false, quality: false, multipleSources: false, caching: false },
      canResolve: () => true,
      async getSources() {
        return [];
      },
      async test() {
        throw new Error("timeout while connecting");
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/source-providers/flaky-provider/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "timeout" });
    await closeTestServer(app, current.db);
  });

  test("identifies the failing provider by name instead of a generic 'Provider is unavailable' message", async () => {
    const current = await createTestServer();
    const { app, sourceProviders } = current;
    sourceProviders.register({
      id: "unavailable-provider",
      name: "Unavailable Provider",
      capabilities: { tracks: true, albums: false, quality: false, multipleSources: false, caching: false },
      canResolve: () => true,
      async getSources() {
        return [];
      },
      async test() {
        return { ok: false };
      },
    });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/source-providers/unavailable-provider/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "plugin_error" });
    expect(response.json().test.message).toBe("Unavailable Provider is unavailable");
    expect(response.json().test.message).not.toBe("Provider is unavailable");
    await closeTestServer(app, current.db);
  });
});

describe("search provider test endpoint", () => {
  test("returns a not_configured status with a specific message when Spotify credentials are missing", async () => {
    const current = await createTestServer();
    const { app, searchProviders } = current;
    searchProviders.configure("spotify", { enabled: true, config: {} });
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/search-providers/spotify/test", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().test).toMatchObject({ ok: false, status: "not_configured" });
    expect(response.json().test.message).toContain("Spotify search is not configured");
    await closeTestServer(app, current.db);
  });

  test("returns 404 with a clear message for an unknown search provider", async () => {
    const current = await createTestServer();
    const { app } = current;
    const { cookie } = await login(app);

    const response = await app.inject({ method: "POST", url: "/api/admin/search-providers/does-not-exist/test", headers: { cookie } });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await closeTestServer(app, current.db);
  });
});
