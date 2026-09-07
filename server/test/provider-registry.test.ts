import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { createProvider, createProviderRegistry } from "../src/backends/factory.js";
import type { CatalogProvider } from "../src/backends/catalog-provider.js";
import type { StreamProvider } from "../src/backends/stream-provider.js";
import { hasUserDataSync, type UserDataSync } from "../src/backends/user-data-sync.js";
import { NavidromeBackend } from "../src/backends/navidrome/navidrome-backend.js";

function testConfig(databasePath: string): AppConfig {
  return loadConfig({
    databasePath,
    sessionSecret: "test-session-secret",
    firstAdmin: { username: "admin", password: "admin-password" },
    navidrome: {
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    },
  });
}

async function setupDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-registry-test-"));
  const config = testConfig(path.join(directory, "musicdeck.sqlite"));
  const db = await openDatabase(config);

  return { db, config };
}

function insertConnection(
  db: Db,
  overrides: Partial<{ id: string; type: string; name: string; enabled: number; createdAt: string }> = {}
) {
  const id = overrides.id || `conn-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO backend_connections
      (id, type, name, config_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.type || "navidrome",
    overrides.name || "Navidrome",
    JSON.stringify({ url: "http://navidrome.test", credentials: "environment" }),
    overrides.enabled ?? 1,
    overrides.createdAt || now,
    overrides.createdAt || now
  );

  return id;
}

function close(db: Db) {
  db.close();
}

describe("provider interfaces", () => {
  test("NavidromeBackend satisfies CatalogProvider, StreamProvider, and UserDataSync", () => {
    const backend = new NavidromeBackend({
      url: "http://navidrome.test",
      username: "navidrome-user",
      password: "navidrome-password",
    });

    // Compile-time assertions that the backend satisfies each capability.
    const catalog: CatalogProvider = backend;
    const stream: StreamProvider = backend;
    const userDataSync: UserDataSync = backend;

    expect(typeof catalog.listAlbums).toBe("function");
    expect(typeof catalog.search).toBe("function");
    expect(typeof stream.fetchStream).toBe("function");
    expect(typeof stream.fetchArtwork).toBe("function");
    expect(typeof userDataSync.setTrackFavorite).toBe("function");
    expect(hasUserDataSync(backend)).toBe(true);
  });

  test("hasUserDataSync is a simple opt-in capability check", () => {
    expect(hasUserDataSync(null)).toBe(false);
    expect(hasUserDataSync({})).toBe(false);
    expect(hasUserDataSync({ listAlbums: async () => [] })).toBe(false);
  });

  test("unknown provider types fail clearly", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-registry-test-"));
    const config = testConfig(path.join(directory, "musicdeck.sqlite"));

    expect(() => createProvider("plex", {}, config)).toThrow(/Unknown backend provider type/);
  });
});

describe("ProviderRegistry", () => {
  test("loads all enabled connections in creation order", async () => {
    const { db, config } = await setupDb();

    const seeded = db.prepare(
      "SELECT id FROM backend_connections WHERE enabled = 1"
    ).get() as { id: string };
    const second = insertConnection(db, {
      name: "Second Navidrome",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const registry = createProviderRegistry(db, config);
    const providers = registry.list();

    expect(providers.map((entry) => entry.connectionId)).toEqual([seeded.id, second]);
    expect(providers[0]).toMatchObject({ type: "navidrome", name: "Navidrome", enabled: true });
    expect(providers[1]).toMatchObject({ type: "navidrome", name: "Second Navidrome", enabled: true });
    expect(providers[0].provider).toBeInstanceOf(NavidromeBackend);
    expect(registry.getByConnectionId(second)?.connectionId).toBe(second);

    close(db);
  });

  test("ignores disabled connections", async () => {
    const { db, config } = await setupDb();

    const disabled = insertConnection(db, { enabled: 0, name: "Disabled Navidrome" });

    const registry = createProviderRegistry(db, config);

    expect(registry.list()).toHaveLength(1);
    expect(registry.getByConnectionId(disabled)).toBeUndefined();

    close(db);
  });

  test("primary provider is the oldest enabled connection, matching the previous factory", async () => {
    const { db, config } = await setupDb();

    const seeded = db.prepare(
      "SELECT id FROM backend_connections WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string };

    insertConnection(db, { createdAt: new Date(Date.now() + 60_000).toISOString() });

    const registry = createProviderRegistry(db, config);

    expect(registry.getPrimary().connectionId).toBe(seeded.id);
    expect(registry.getPrimary().provider).toBeInstanceOf(NavidromeBackend);

    close(db);
  });

  test("registry creation fails clearly when an enabled connection has an unknown type", async () => {
    const { db, config } = await setupDb();

    insertConnection(db, { type: "plex", name: "Future Plex" });

    expect(() => createProviderRegistry(db, config)).toThrow(/Unknown backend provider type: plex/);

    close(db);
  });

  test("falls back to an environment-configured Navidrome provider when no rows exist", async () => {
    const { db, config } = await setupDb();

    db.prepare("DELETE FROM backend_connections").run();

    const registry = createProviderRegistry(db, config);

    expect(registry.list()).toHaveLength(1);
    expect(registry.getPrimary()).toMatchObject({
      connectionId: "env-navidrome",
      type: "navidrome",
      enabled: true,
    });
    expect(registry.getPrimary().provider).toBeInstanceOf(NavidromeBackend);

    close(db);
  });
});
