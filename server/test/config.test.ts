import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, validateConfig } from "../src/config.js";
import { DEFAULT_ACQUISITION_LIMITS } from "../src/domain/acquisition-limits.js";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

afterEach(() => {
  resetEnv();
});

describe("configuration", () => {
  test("every acquisition bound is configurable and rejects disabling or invalid values", () => {
    for (const [key, defaultValue] of Object.entries(DEFAULT_ACQUISITION_LIMITS)) {
      const name = `MUSICDECK_ACQUISITION_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
      delete process.env[name];
      expect(loadConfig().acquisitionLimits).toHaveProperty(key, defaultValue);
      process.env[name] = "7";
      expect(loadConfig().acquisitionLimits).toHaveProperty(key, 7);
      for (const value of ["0", "-1", "NaN", "1.5"]) {
        process.env[name] = value;
        expect(() => loadConfig()).toThrow(name);
      }
      delete process.env[name];
    }
  });
  test("login limits are configurable and forwarding trust requires explicit IPs or CIDRs", () => {
    process.env.MUSICDECK_LOGIN_IP_MAX = "7";
    process.env.MUSICDECK_TRUSTED_PROXIES = "127.0.0.1, 10.20.0.0/24, ::1";
    const config = loadConfig();
    expect(config.loginRateLimit.ipMax).toBe(7);
    expect(config.trustedProxies).toEqual(["127.0.0.1", "10.20.0.0/24", "::1"]);
    process.env.MUSICDECK_TRUSTED_PROXIES = "";
    expect(loadConfig().trustedProxies).toEqual([]);
  });

  test.each(["true", "*", "0.0.0.0/0", "::/0", "10.0.0.1/33", "localhost", "127.0.0.1/"])(
    "rejects unsafe proxy trust setting %s", (value) => {
      process.env.MUSICDECK_TRUSTED_PROXIES = value;
      expect(() => loadConfig()).toThrow("MUSICDECK_TRUSTED_PROXIES");
    },
  );

  test.each(["0", "-1", "1.5", "NaN"])("rejects invalid login limits %s", (value) => {
    process.env.MUSICDECK_LOGIN_IP_MAX = value;
    expect(() => loadConfig()).toThrow("MUSICDECK_LOGIN_IP_MAX");
  });
  test("supports MUSICDECK_DB_PATH and validates required deployment settings", () => {
    process.env.MUSICDECK_DB_PATH = "/data/musicdeck.sqlite";
    process.env.MUSICDECK_SESSION_SECRET = "local-secret";
    process.env.NAVIDROME_URL = "http://navidrome:4533";
    process.env.NAVIDROME_USERNAME = "service-user";
    process.env.NAVIDROME_PASSWORD = "service-password";

    const config = loadConfig();

    expect(config.databasePath).toBe("/data/musicdeck.sqlite");
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("reads supported secrets from Docker-style secret files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-secrets-"));
    const sessionSecretPath = path.join(directory, "session-secret");
    const navidromePasswordPath = path.join(directory, "navidrome-password");

    fs.writeFileSync(sessionSecretPath, "file-session-secret\n");
    fs.writeFileSync(navidromePasswordPath, "file-navidrome-password\n");

    process.env.MUSICDECK_SESSION_SECRET_FILE = sessionSecretPath;
    process.env.NAVIDROME_PASSWORD_FILE = navidromePasswordPath;
    process.env.NAVIDROME_URL = "http://navidrome:4533";
    process.env.NAVIDROME_USERNAME = "service-user";

    const config = loadConfig();

    expect(config.sessionSecret).toBe("file-session-secret");
    expect(config.navidrome.password).toBe("file-navidrome-password");
  });

  test("rejects unsafe or incomplete production-style configuration", () => {
    const config = loadConfig({
      sessionSecret: "change-this-in-development",
      navidrome: {
        url: "not-a-url",
        username: "",
        password: "",
      },
    });

    expect(() => validateConfig(config)).toThrow("MUSICDECK_SESSION_SECRET");
  });
});
