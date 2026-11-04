import { afterEach, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import type { Db } from "../src/db/database.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

type Status = {
  state: string;
  phase: string | null;
  processed: number;
  total: number;
  error: string | null;
  warnings: string[];
  staleReason: string | null;
  report: null | {
    degraded: boolean;
    summary: Record<string, number>;
    issues: Array<{ type: string; itemId: string }>;
    issueTotal: number;
    prune: null | { prunedTracks: number; keptInPlaylists: number; removedFavorites: number; removedRatings: number; skippedReason: string | null };
  };
};

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(overrides: Parameters<typeof createFakeBackend>[0] = {}) {
  const base = createFakeBackend();
  const albums = await base.listAlbums();
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  const backend = createFakeBackend({ listAllAlbums: async () => albums, scanLibrary, ...overrides });
  const server = await createTestServer(backend);
  cleanup.push(() => closeTestServer(server.app, server.db));
  const admin = await login(server.app);
  return { ...server, cookie: admin.cookie, scanLibrary };
}

async function waitForScan(app: FastifyInstance, cookie: string | undefined): Promise<Status> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const { status } = response.json() as { status: Status };
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Health scan did not finish");
}

function seedOrphan(db: Db, id: string, connectionId = "test-connection") {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO library_items (id, type, created_at, updated_at) VALUES (?, 'track', ?, ?)").run(id, now, now);
  db.prepare(`INSERT INTO library_item_sources (library_item_id, item_type, connection_id, provider_item_id, created_at)
    VALUES (?, 'track', ?, ?, ?)`).run(id, connectionId, `gone-${id}`, now);
}

function userId(db: Db) {
  return (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }).id;
}

describe("admin library health scan", () => {
  test("runs in the background, reports progress, and never starts a second scan", async () => {
    const { app, cookie } = await setup();

    const idle = await app.inject({ method: "GET", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect(idle.json().status).toMatchObject({ state: "idle", report: null });

    const first = await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ started: true, alreadyRunning: false, status: { state: "running" } });

    const second = await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ started: false, alreadyRunning: true });
    expect(second.json().status.id).toBe(first.json().status.id);

    const done = await waitForScan(app, cookie);
    expect(done.state).toBe("completed");
    expect(done.processed).toBe(done.total);
    expect(done.report?.degraded).toBe(false);
    expect(done.report?.summary).toMatchObject({ tracks: 1, albums: 1, artists: 1, orphanedTracks: 0, syncMismatches: 0 });
  });

  test("is limited to admins", async () => {
    const { app, cookie } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: { username: "listener", password: "listener-password" },
    });
    const listener = await login(app, "listener", "listener-password");

    for (const [method, url] of [
      ["GET", "/api/admin/library/health/scan"],
      ["POST", "/api/admin/library/health/scan"],
      ["POST", "/api/admin/library/health/repair/artwork"],
      ["POST", "/api/admin/library/health/repair/prune-orphans"],
    ] as const) {
      const denied = await app.inject({ method, url, headers: { cookie: listener.cookie } });
      expect(denied.statusCode).toBe(403);
    }
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/library/health/scan" });
    expect(anonymous.statusCode).toBe(401);
  });

  test("flags orphaned records and album sync mismatches", async () => {
    const base = createFakeBackend();
    const [track] = await base.listTracks();
    const { app, db, cookie } = await setup({
      listTracks: async () => [track, { ...track, id: "track-2", providerId: "track-2", title: "Lost Album Track", albumId: "album-gone", albumName: "Gone" }],
    });
    // Track records must exist before orphans are judged against the listing.
    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    await waitForScan(app, cookie);
    seedOrphan(db, "orphan-1");
    seedOrphan(db, "elsewhere-1", "other-connection");

    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    const done = await waitForScan(app, cookie);

    expect(done.report?.summary.orphanedTracks).toBe(1);
    expect(done.report?.summary.syncMismatches).toBe(1);
    const types = done.report?.issues.map((issue) => `${issue.type}:${issue.itemId}`) ?? [];
    expect(types).toContain("orphaned-track:orphan-1");
    expect(types.some((entry) => entry.startsWith("album-not-listed:"))).toBe(true);
    // Records from a connection that did not list are never judged.
    expect(types).not.toContain("orphaned-track:elsewhere-1");
  });

  test("prune removes orphaned records and their favorites but keeps playlist references", async () => {
    const { app, db, cookie } = await setup();
    seedOrphan(db, "orphan-1");
    seedOrphan(db, "orphan-in-playlist");
    const owner = userId(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO favorites (user_id, track_id, created_at) VALUES (?, 'orphan-1', ?)").run(owner, now);
    db.prepare("INSERT INTO media_ratings (user_id, item_type, item_id, rating, created_at, updated_at) VALUES (?, 'track', 'orphan-1', 4, ?, ?)").run(owner, now, now);
    db.prepare("INSERT INTO playlists (id, owner_user_id, name, created_at, updated_at) VALUES ('pl-1', ?, 'Keep', ?, ?)").run(owner, now, now);
    db.prepare(`INSERT INTO playlist_items (id, playlist_id, position, connection_id, provider_track_id, library_track_id, created_at)
      VALUES ('pi-1', 'pl-1', 0, 'test-connection', 'gone-orphan-in-playlist', 'orphan-in-playlist', ?)`).run(now);

    const rejected = await app.inject({ method: "POST", url: "/api/admin/library/health/repair/prune-orphans", headers: { cookie } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.message).toMatch(/run a health check/i);

    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    const scanned = await waitForScan(app, cookie);
    expect(scanned.report?.summary.orphanedTracks).toBe(2);
    expect(scanned.report?.summary.danglingReferences).toBe(0);

    const prune = await app.inject({ method: "POST", url: "/api/admin/library/health/repair/prune-orphans", headers: { cookie } });
    expect(prune.statusCode).toBe(202);
    const pruned = await waitForScan(app, cookie);

    expect(pruned.state).toBe("completed");
    expect(pruned.report?.prune).toEqual({ prunedTracks: 1, keptInPlaylists: 1, removedFavorites: 1, removedRatings: 1, skippedReason: null });
    expect(pruned.report?.summary.orphanedTracks).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE id = 'orphan-1'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM library_item_sources WHERE library_item_id = 'orphan-1'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM favorites WHERE track_id = 'orphan-1'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM playlist_items WHERE id = 'pi-1'").get()).toEqual({ count: 1 });
  });

  test("prune is skipped when a media server cannot be listed", async () => {
    let failing = false;
    const base = createFakeBackend();
    const { app, db, cookie } = await setup({
      listTracks: async () => {
        if (failing) throw new Error("Navidrome unreachable");
        return base.listTracks();
      },
    });
    seedOrphan(db, "orphan-1");
    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect((await waitForScan(app, cookie)).report?.summary.orphanedTracks).toBe(1);

    failing = true;
    await app.inject({ method: "POST", url: "/api/admin/library/health/repair/prune-orphans", headers: { cookie } });
    const failed = await waitForScan(app, cookie);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/could not finish/i);
    expect(failed.report?.summary.orphanedTracks).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE id = 'orphan-1'").get()).toEqual({ count: 1 });
  });

  test("re-scan artwork triggers a media server scan and marks the report stale", async () => {
    const { app, cookie, scanLibrary } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    await waitForScan(app, cookie);

    const response = await app.inject({ method: "POST", url: "/api/admin/library/health/repair/artwork", headers: { cookie } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ started: true, alreadyRunning: false });
    expect(response.json().status.staleReason).toMatch(/run the health check again/i);
    await vi.waitFor(() => expect(scanLibrary).toHaveBeenCalledTimes(1));

    await app.inject({ method: "POST", url: "/api/admin/library/health/scan", headers: { cookie } });
    expect((await waitForScan(app, cookie)).staleReason).toBeNull();
  });
});
