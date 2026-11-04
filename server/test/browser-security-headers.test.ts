import { describe, expect, test } from "vitest";
import { closeTestServer, createTestServer } from "./helpers.js";

describe("browser security headers", () => {
  test("API responses include baseline browser hardening headers", async () => {
    const env = await createTestServer();
    try {
      const response = await env.app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    } finally {
      await closeTestServer(env.app, env.db);
    }
  });
});
