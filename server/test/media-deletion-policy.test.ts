import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, test, vi } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { createSession } from "../src/auth/sessions.js";
import { LibraryService } from "../src/domain/library.js";
import { CatalogService } from "../src/domain/catalog.js";
import { ProviderRegistry } from "../src/backends/registry.js";
import { registerAdminMediaRoutes } from "../src/routes/admin-media-routes.js";
import { SUPPORTED_AUDIO_CONTAINERS, isSupportedAudioFile } from "../src/domain/audio-containers.js";
import { SPOTDL_FORMATS } from "../src/domain/spotdl-format.js";
import { createFakeBackend } from "./helpers.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(formats: readonly string[], mergedTrack = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-media-policy-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new Database(":memory:"); runMigrations(db); cleanups.push(() => db.close());
  db.prepare("INSERT INTO roles(name,description) VALUES ('admin','Admin')").run();
  db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,created_at,updated_at)
    VALUES ('admin','admin','unused','Admin','admin','','')`).run();
  const session = createSession(db, "admin");
  const library = new LibraryService(db, { musicRoot: root });
  const sample = (await createFakeBackend().getTrack("track-1"))!;
  const tracks = formats.map((format, index) => ({ ...sample, id: `track-${index + 1}`, providerId: `track-${index + 1}`, title: `Song ${index + 1}` }));
  const files = (source: string) => formats.map((format, index) => path.join(root, source, "Album", `song-${index + 1}.${format}`));
  const primaryFiles = files("Primary"), secondaryFiles = files("Secondary");
  for (const file of [...primaryFiles, ...secondaryFiles]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture audio"); }
  const primary = createFakeBackend({ requestLibraryRescan: vi.fn(async () => {}), getTrackFilePath: vi.fn(async id => primaryFiles[tracks.findIndex(track => track.id === id)] ?? null) });
  const secondary = createFakeBackend({
    getTrack: vi.fn(async id => tracks.find(track => track.id === id) ?? null),
    getAlbumTracks: vi.fn(async () => tracks),
    getTrackFilePath: vi.fn(async id => secondaryFiles[tracks.findIndex(track => track.id === id)] ?? null),
    requestLibraryRescan: vi.fn(async () => {}),
    scanLibrary: vi.fn(async () => ({ scanning: false })),
  });
  const registry = new ProviderRegistry([
    { connectionId: "primary", type: "navidrome", name: "Primary", enabled: true, provider: primary },
    { connectionId: "secondary", type: "jellyfin", name: "Secondary", enabled: true, provider: secondary },
  ]);
  const catalog = new CatalogService(registry, library);
  const primaryId = library.ensureId("track", { connectionId: "primary", providerItemId: tracks[0].id });
  if (mergedTrack) library.addSource(primaryId, { connectionId: "secondary", providerItemId: tracks[0].id });
  const trackId = library.ensureId("track", { connectionId: "secondary", providerItemId: tracks[0].id });
  const albumId = library.ensureId("album", { connectionId: "secondary", providerItemId: "album-1" });
  const app = Fastify(); cleanups.push(() => app.close()); await app.register(cookie);
  await registerAdminMediaRoutes(app, db, root, catalog);
  return { root, db, library, catalog, app, primary, secondary, primaryFiles, secondaryFiles, trackId, albumId, primaryId,
    headers: { cookie: `musicdeck_session=${session.id}` } };
}

test.each(SUPPORTED_AUDIO_CONTAINERS)("admin deletion accepts %s and rescans only its owning secondary server", async format => {
  const env = await fixture([format]);
  const primaryRevision = env.library.getContentRevision(env.primaryId);
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${env.trackId}`, headers: env.headers });
  expect(response.statusCode).toBe(200); expect(response.json().warning).toBeUndefined();
  expect(fs.existsSync(env.secondaryFiles[0])).toBe(false); expect(fs.existsSync(env.primaryFiles[0])).toBe(true);
  expect(env.secondary.requestLibraryRescan).toHaveBeenCalledOnce();
  expect(env.secondary.scanLibrary).not.toHaveBeenCalled();
  expect(env.primary.requestLibraryRescan).not.toHaveBeenCalled(); expect(env.primary.getTrackFilePath).not.toHaveBeenCalled();
  expect(env.library.getContentRevision(env.primaryId)).toBe(primaryRevision);
});

test("mixed-format album deletion uses its own server for merged track identities", async () => {
  const env = await fixture(SUPPORTED_AUDIO_CONTAINERS, true);
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/albums/${env.albumId}`, headers: env.headers });
  expect(response.statusCode).toBe(200); expect(response.json().trackIds).toHaveLength(6);
  expect(env.secondaryFiles.every(file => !fs.existsSync(file))).toBe(true);
  expect(env.primaryFiles.every(file => fs.existsSync(file))).toBe(true);
  expect(env.secondary.requestLibraryRescan).toHaveBeenCalledOnce(); expect(env.primary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("a secondary scan rejection returns a warning without falling back to the primary", async () => {
  const env = await fixture(["m4a"]);
  vi.mocked(env.secondary.requestLibraryRescan!).mockRejectedValue(new Error("Disconnected"));
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${env.trackId}`, headers: env.headers });
  expect(response.statusCode).toBe(200); expect(response.json().warning).toContain("could not be started");
  expect(fs.existsSync(env.secondaryFiles[0])).toBe(false); expect(env.primary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("providers without a nonblocking trigger use their own scanLibrary method", async () => {
  const env = await fixture(["m4a"]);
  env.secondary.requestLibraryRescan = undefined;
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${env.trackId}`, headers: env.headers });
  expect(response.statusCode).toBe(200); expect(response.json().warning).toBeUndefined();
  expect(env.secondary.scanLibrary).toHaveBeenCalledOnce(); expect(env.primary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("an unsupported file is retained and no source is rescanned", async () => {
  const env = await fixture(["aac"]);
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${env.trackId}`, headers: env.headers });
  expect(response.statusCode).toBe(400); expect(fs.existsSync(env.secondaryFiles[0])).toBe(true);
  expect(env.secondary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("a symlink escaping the music root cannot authorize deletion", async () => {
  const env = await fixture(["opus"]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-media-outside-"));
  cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, "song.opus"); fs.writeFileSync(outsideFile, "keep");
  const link = path.join(env.root, "escape"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  vi.mocked(env.secondary.getTrackFilePath!).mockResolvedValue(path.join(link, "song.opus"));
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${env.trackId}`, headers: env.headers });
  expect(response.statusCode).toBe(400); expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
  expect(env.secondary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("a partial album filesystem failure still rescans files already deleted", async () => {
  const env = await fixture(["m4a", "opus"]);
  const unlink = fsp.unlink.bind(fsp);
  vi.spyOn(fsp, "unlink").mockImplementation(async file => {
    if (String(file) === env.secondaryFiles[1]) throw Object.assign(new Error("Locked fixture"), { code: "EPERM" });
    return unlink(file);
  });
  const response = await env.app.inject({ method: "DELETE", url: `/api/v1/admin/albums/${env.albumId}`, headers: env.headers });
  expect(response.statusCode).toBe(500);
  expect(fs.existsSync(env.secondaryFiles[0])).toBe(false); expect(fs.existsSync(env.secondaryFiles[1])).toBe(true);
  expect(env.secondary.requestLibraryRescan).toHaveBeenCalledOnce(); expect(env.primary.requestLibraryRescan).not.toHaveBeenCalled();
});

test("container policy is shared and extension checks are case insensitive", () => {
  expect(SPOTDL_FORMATS).toBe(SUPPORTED_AUDIO_CONTAINERS);
  for (const format of SUPPORTED_AUDIO_CONTAINERS) expect(isSupportedAudioFile(`Artist - Track.${format.toUpperCase()}`)).toBe(true);
  expect(isSupportedAudioFile("song.mp3.exe")).toBe(false);
});
