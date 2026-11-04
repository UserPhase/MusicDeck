import { describe, expect, test } from "vitest";
import { redactConfig } from "../src/utils/config-redaction.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

describe("nested credential redaction", () => {
  test("omit and presence policies redact nested objects, arrays, URLs, and declared secret fields", () => {
    const config = {
      label: "Visible",
      auth: { password: "nested-password-value", token: "nested-token-value", username: "name" },
      endpoints: [{ apiKey: "nested-api-key-value", url: "https://user:pass@provider.test?token=nested-token-value" }],
      opaque: { content: "manifest-declared-secret" },
    };
    for (const mode of ["omit", "presence"] as const) {
      const output = redactConfig(config, mode, new Set(["opaque"]));
      const json = JSON.stringify(output);
      for (const secret of ["nested-password-value", "nested-token-value", "nested-api-key-value", "manifest-declared-secret", "user:pass@"]) {
        expect(json).not.toContain(secret);
      }
      expect(output.label).toBe("Visible");
      expect(output.auth).toEqual(mode === "presence" ? { password: true, token: true, username: "name" } : { username: "name" });
    }
    expect(config.auth.password).toBe("nested-password-value");
  });

  test("admin APIs redact nested search, source, and plugin credentials without altering stored configuration", async () => {
    const env = await createTestServer();
    try {
      const nested = { label: "Keep", options: { password: "deep-password-fixture", headers: { Authorization: "Bearer fixture-api-secret" } } };
      env.searchProviders.configure("spotify", { config: nested, enabled: false });
      env.sourceProviders.configure("itunes-preview", false, nested);
      await env.plugins.register({
        manifest: {
          id: "nested-credentials", name: "Nested credentials", version: "1.0.0", capabilities: ["metadata"], permissions: [],
          config: { fields: [{ key: "opaque", secret: true }] },
        },
      });
      env.plugins.configure("nested-credentials", { config: { ...nested, opaque: "custom-secret-fixture" } });
      const { cookie } = await login(env.app);
      for (const url of ["/api/admin/search-providers", "/api/admin/source-providers", "/api/admin/plugins"]) {
        const response = await env.app.inject({ url, headers: { cookie } });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain("deep-password-fixture");
        expect(response.body).not.toContain("fixture-api-secret");
        expect(response.body).not.toContain("custom-secret-fixture");
        expect(response.body).toContain("Keep");
      }
      expect(env.searchProviders.rawConfig("spotify")?.config).toMatchObject(nested);
      const row = env.db.prepare("SELECT config_json FROM plugin_configs WHERE plugin_id = ?").get("nested-credentials") as { config_json: string };
      expect(JSON.parse(row.config_json)).toMatchObject({ opaque: "custom-secret-fixture", ...nested });
    } finally { await closeTestServer(env.app, env.db); }
  });
});
