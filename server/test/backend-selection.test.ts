import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, validateConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { createProviderRegistry } from "../src/backends/factory.js";
import { withLocalUserDataSync } from "../src/backends/local-user-data-sync.js";
import { hasUserDataSync } from "../src/backends/user-data-sync.js";
import { JellyfinBackend } from "../src/backends/jellyfin/jellyfin-backend.js";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function baseOverrides(databasePath: string): Partial<AppConfig> {
  return {
    databasePath,
    sessionSecret: "test-session-secret",
    firstAdmin: { username: "admin", password: "admin-password" },
  };
}

async function setupDb(overrides: Partial<AppConfig>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-backend-select-"));
  const config = loadConfig({
    ...baseOverrides(path.join(directory, "musicdeck.sqlite")),
    ...overrides,
  });
  const db = await openDatabase(config);

  return { db, config };
}

describe("MUSIC_BACKEND selection", () => {
  test("defaults to navidrome when MUSIC_BACKEND is unset", () => {
    delete process.env.MUSIC_BACKEND;

    expect(loadConfig().backend).toBe("navidrome");
  });

  test("accepts navidrome and jellyfin, case-insensitively", () => {
    process.env.MUSIC_BACKEND = "jellyfin";
    expect(loadConfig().backend).toBe("jellyfin");

    process.env.MUSIC_BACKEND = "Navidrome";
    expect(loadConfig().backend).toBe("navidrome");
  });

  test("rejects an unknown backend instead of silently falling back", () => {
    process.env.MUSIC_BACKEND = "plex";

    expect(() => loadConfig()).toThrow("MUSIC_BACKEND");
  });

  test("a jellyfin deployment does not require Navidrome credentials", () => {
    const config = loadConfig({
      backend: "jellyfin",
      sessionSecret: "test-session-secret",
      navidrome: { url: "", username: "", password: "" },
      jellyfin: { url: "http://jellyfin:8096", apiKey: "jellyfin-api-key" },
    });

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("a jellyfin deployment requires a Jellyfin API key and valid URL", () => {
    const missingKey = loadConfig({
      backend: "jellyfin",
      sessionSecret: "test-session-secret",
      jellyfin: { url: "http://jellyfin:8096", apiKey: "" },
    });
    expect(() => validateConfig(missingKey)).toThrow("JELLYFIN_API_KEY");

    const badUrl = loadConfig({
      backend: "jellyfin",
      sessionSecret: "test-session-secret",
      jellyfin: { url: "not-a-url", apiKey: "jellyfin-api-key" },
    });
    expect(() => validateConfig(badUrl)).toThrow("JELLYFIN_URL");
  });

  test("a navidrome deployment still requires Navidrome credentials", () => {
    const config = loadConfig({
      backend: "navidrome",
      sessionSecret: "test-session-secret",
      navidrome: { url: "http://navidrome:4533", username: "", password: "" },
    });

    expect(() => validateConfig(config)).toThrow("NAVIDROME_USERNAME");
  });

  test("seeds and selects a Jellyfin primary provider when MUSIC_BACKEND=jellyfin", async () => {
    const { db, config } = await setupDb({
      backend: "jellyfin",
      jellyfin: { url: "http://jellyfin:8096", apiKey: "jellyfin-api-key" },
    });

    const rows = db.prepare("SELECT type FROM backend_connections").all() as Array<{ type: string }>;
    expect(rows.map((row) => row.type)).toEqual(["jellyfin"]);

    const primary = createProviderRegistry(db, config).getPrimary();
    expect(primary.type).toBe("jellyfin");
    expect(primary.provider).toBeInstanceOf(JellyfinBackend);
  });

  test("seeds and selects a Navidrome primary provider by default", async () => {
    const { db, config } = await setupDb({
      backend: "navidrome",
      navidrome: {
        url: "http://navidrome:4533",
        username: "navidrome-user",
        password: "navidrome-password",
      },
    });

    const rows = db.prepare("SELECT type FROM backend_connections").all() as Array<{ type: string }>;
    expect(rows.map((row) => row.type)).toEqual(["navidrome"]);

    const primary = createProviderRegistry(db, config).getPrimary();
    expect(primary.type).toBe("navidrome");
    expect(primary.provider).toBeInstanceOf(NavidromeBackend);
  });

  test("builds the Jellyfin provider from config rather than raw process.env", async () => {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;

    const { db, config } = await setupDb({
      backend: "jellyfin",
      jellyfin: { url: "http://jellyfin.test:8096", apiKey: "configured-key" },
    });

    const primary = createProviderRegistry(db, config).getPrimary();
    expect(primary.provider).toBeInstanceOf(JellyfinBackend);
  });
});

describe("withLocalUserDataSync", () => {
  test("returns a Navidrome provider unchanged (it already syncs user data)", () => {
    const navidrome = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "user",
      password: "password",
    });

    expect(withLocalUserDataSync(navidrome)).toBe(navidrome);
  });

  test("lets a Jellyfin primary start by supplying local-only user-data methods", async () => {
    const jellyfin = new JellyfinBackend({ url: "http://jellyfin.test", apiKey: "key" });

    expect(hasUserDataSync(jellyfin)).toBe(false);

    const backend = withLocalUserDataSync(jellyfin);

    expect(hasUserDataSync(backend)).toBe(true);
    await expect(backend.listPlaylists()).resolves.toEqual([]);
    await expect(backend.listFavoriteTracks()).resolves.toEqual([]);
    await expect(backend.createPlaylist("New")).resolves.toBeNull();
    await expect(backend.addTrackToPlaylist("p", "t")).resolves.toEqual({ added: false });
    await expect(backend.setTrackFavorite("t", true)).resolves.toBeUndefined();
  });

  test("preserves the wrapped provider's own catalog/stream behavior", () => {
    const jellyfin = new JellyfinBackend({ url: "http://jellyfin.test", apiKey: "key" });
    const backend = withLocalUserDataSync(jellyfin);

    expect(typeof backend.search).toBe("function");
    expect(typeof backend.getTrack).toBe("function");
    expect(typeof backend.fetchStream).toBe("function");
    expect(typeof backend.fetchArtwork).toBe("function");
  });
});
