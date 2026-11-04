import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { createSession } from "../src/auth/sessions.js";
import { registerPlaylistRoutes } from "../src/routes/playlist-routes.js";
import { SpotifyPlaylistImportService, PlaylistImportForbiddenError } from "../src/domain/spotify-playlist-import.js";
import { SqliteImportJobRepository } from "../src/infrastructure/persistence/sqliteImportJobRepository.js";
import type { SessionUser } from "../src/types.js";
import type { DownloaderAdapter, DownloadResult } from "../src/domain/downloader-adapter.js";
import type { MusicBackend } from "../src/backends/music-backend.js";
import type { PlaylistService } from "../src/domain/playlist-service.js";

const url = "https://open.spotify.com/playlist/permissionTest";
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function database() {
  const db = new Database(":memory:"); runMigrations(db);
  cleanups.push(() => db.close()); return db;
}
function user(id = "listener", allowed = true, role: "user" | "admin" = "user") {
  return { id, role, externalPlaybackEnabled: allowed, disabled: false } as SessionUser;
}
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-permission-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test.each([
  ["user", false, 403], ["user", true, 202], ["admin", false, 202],
] as const)("playlist import enforces %s download permission %s", async (role, allowed, status) => {
  const db = database();
  db.prepare("INSERT INTO roles(name, description) VALUES (?, 'Role')").run(role);
  db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at,external_playback_enabled)
    VALUES ('listener','listener','unused','Listener',?,'','',?)`).run(role, Number(allowed));
  const session = createSession(db, "listener");
  const app = Fastify(); cleanups.push(() => app.close()); await app.register(cookie);
  const start = vi.fn(() => ({ id: "job", status: "queued" }));
  const create = vi.fn(async () => ({ id: "local-playlist" }));
  await registerPlaylistRoutes(app, db, { create } as unknown as PlaylistService,
    { start } as unknown as SpotifyPlaylistImportService);
  expect((await app.inject({ method: "POST", url: "/api/v1/playlists/import-spotify", payload: { playlistUrl: url } })).statusCode).toBe(401);
  const headers = { cookie: `musicdeck_session=${session.id}` };
  const response = await app.inject({ method: "POST", url: "/api/v1/playlists/import-spotify", headers, payload: { playlistUrl: url } });
  expect(response.statusCode).toBe(status);
  expect(start).toHaveBeenCalledTimes(status === 202 ? 1 : 0);
  // Download permission does not restrict ordinary playlist creation.
  expect((await app.inject({ method: "POST", url: "/api/playlists", headers, payload: { name: "My songs" } })).statusCode).toBe(201);
});

test("the service rejects unauthorized, disabled and deleted users before persisting a job", () => {
  const db = database(); const repository = new SqliteImportJobRepository(db);
  const service = new SpotifyPlaylistImportService({} as MusicBackend, {} as PlaylistService, {} as DownloaderAdapter,
    directory(), undefined, undefined, undefined, repository);
  for (const denied of [user("listener", false), { ...user(), disabled: true }]) {
    expect(() => service.start(url, denied)).toThrow(PlaylistImportForbiddenError);
  }
  service.bindUserResolver(() => null);
  expect(() => service.start(url, user())).toThrow(PlaylistImportForbiddenError);
  expect(db.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 0 });
});

test("a queued user's revoked permission is checked before metadata fetching or downloading", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const fetchPlaylistTracks = vi.fn(async (): Promise<DownloadResult> => {
    await blocked; return { status: "failed", files: [], error: { code: "general", message: "Fixture finished" } };
  });
  const download = vi.fn();
  const service = new SpotifyPlaylistImportService({ search: vi.fn() } as unknown as MusicBackend, {} as PlaylistService,
    { fetchPlaylistTracks, download } as unknown as DownloaderAdapter, directory(), async () => new Response("{}"));
  let allowed = true;
  service.bindUserResolver(id => user(id, id === "first" || allowed));
  const first = service.start(url, user("first"));
  await vi.waitFor(() => expect(fetchPlaylistTracks).toHaveBeenCalledOnce());
  const queued = service.start(url, user("second"));
  allowed = false; release();
  await vi.waitFor(() => expect(service.get(queued.id, "second")).toMatchObject({ status: "failed", error: "Downloads are not enabled for this user" }));
  expect(fetchPlaylistTracks).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
  expect(service.get(first.id, "first")?.status).toBe("failed");
});

test("restart recovery checks current permissions rather than the persisted user snapshot", async () => {
  const db = database(); const repository = new SqliteImportJobRepository(db);
  const owner = user();
  repository.save({ user: owner, playlistUrl: url, job: { id: "restored", userId: owner.id, status: "running", stage: "fetching" } });
  const fetchPlaylistTracks = vi.fn();
  const service = new SpotifyPlaylistImportService({} as MusicBackend, {} as PlaylistService,
    { fetchPlaylistTracks } as unknown as DownloaderAdapter, directory(), undefined, undefined, undefined, repository);
  service.resumeInterrupted(id => user(id, false));
  await vi.waitFor(() => expect(repository.get("restored", owner.id)?.job).toMatchObject({ status: "failed" }));
  expect(fetchPlaylistTracks).not.toHaveBeenCalled();
});
