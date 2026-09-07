import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, validateConfig } from "../src/config.js";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

afterEach(() => {
  resetEnv();
});

describe("configuration", () => {
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
