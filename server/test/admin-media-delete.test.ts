import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createUser } from "../src/users/users.js";
import { isPathWithinRoot } from "../src/routes/admin-media-routes.js";
import { closeTestServer, createFakeBackend, createTestServer, login } from "./helpers.js";

let current: Awaited<ReturnType<typeof createTestServer>> | null = null;
const directories: string[] = [];

afterEach(async () => {
  if (current) { await closeTestServer(current.app, current.db); current = null; }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function musicRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-delete-"));
  directories.push(root);
  return root;
}

test("path guard rejects traversal, sibling roots, and the root itself", () => {
  const root = path.resolve("music");
  expect(isPathWithinRoot(path.join(root, "Artist", "song.mp3"), root)).toBe(true);
  expect(isPathWithinRoot(root, root)).toBe(false);
  expect(isPathWithinRoot(path.resolve(root, "..", "music-backup", "song.mp3"), root)).toBe(false);
  expect(isPathWithinRoot(path.resolve(root, "..", "secret.mp3"), root)).toBe(false);
});

test("only admins can delete a track; deletion removes the file and starts a scan", async () => {
  const root = musicRoot();
  const filePath = path.join(root, "Artist", "Album", "song.mp3");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "audio");
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  const backend = createFakeBackend({ getTrackFilePath: vi.fn(async () => path.relative(root, filePath)), scanLibrary });
  current = await createTestServer(backend, { musicRoot: root });
  const trackId = (await current.catalog.listTracks()).items[0].id;
  await createUser(current.db, { username: "listener", password: "listener-password", role: "user" });
  const { cookie: userCookie } = await login(current.app, "listener", "listener-password");
  const denied = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${trackId}`, headers: { cookie: userCookie } });
  expect(denied.statusCode).toBe(403);
  expect(fs.existsSync(filePath)).toBe(true);
  expect(backend.getTrackFilePath).not.toHaveBeenCalled();

  const { cookie: adminCookie } = await login(current.app);
  const deleted = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${trackId}`, headers: { cookie: adminCookie } });
  expect(deleted.statusCode).toBe(200);
  expect(deleted.json()).toMatchObject({ success: true, message: "Track deleted from disk" });
  expect(fs.existsSync(filePath)).toBe(false);
  expect(scanLibrary).toHaveBeenCalledOnce();
});

test("a provider path outside the music root returns 400 without deleting anything", async () => {
  const root = musicRoot();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-backup.mp3`);
  directories.push(outside);
  fs.writeFileSync(outside, "keep");
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  current = await createTestServer(createFakeBackend({ getTrackFilePath: vi.fn(async () => outside), scanLibrary }), { musicRoot: root });
  const trackId = (await current.catalog.listTracks()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${trackId}`, headers: { cookie } });
  expect(response.statusCode).toBe(400);
  expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  expect(scanLibrary).not.toHaveBeenCalled();
});

test("a provider without a real file path cannot delete a matching disk file", async () => {
  const root = musicRoot();
  const filePath = path.join(root, "Artist", "Album", "01 - Song.mp3");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "keep");
  current = await createTestServer(createFakeBackend({ getTrackFilePath: vi.fn(async () => null) }), { musicRoot: root });
  const trackId = (await current.catalog.listTracks()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${trackId}`, headers: { cookie } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.message).toMatch(/Report Real Path/);
  expect(fs.readFileSync(filePath, "utf8")).toBe("keep");
});

test("album deletion removes its track files and empty folder, then rescans", async () => {
  const root = musicRoot();
  const filePath = path.join(root, "Artist", "Album", "song.flac");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "audio");
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  current = await createTestServer(createFakeBackend({ getTrackFilePath: vi.fn(async () => filePath), scanLibrary }), { musicRoot: root });
  const albumId = (await current.catalog.listAlbums()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/albums/${albumId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.json().trackIds).toHaveLength(1);
  expect(fs.existsSync(filePath)).toBe(false);
  expect(fs.existsSync(path.dirname(filePath))).toBe(false);
  expect(scanLibrary).toHaveBeenCalledOnce();
});

test("album deletion removes cover art with a dedicated album folder", async () => {
  const root = musicRoot();
  const albumDir = path.join(root, "Artist", "Album");
  const filePath = path.join(albumDir, "song.flac");
  fs.mkdirSync(albumDir, { recursive: true });
  fs.writeFileSync(filePath, "audio");
  fs.writeFileSync(path.join(albumDir, "cover.jpg"), "art");
  current = await createTestServer(createFakeBackend({ getTrackFilePath: vi.fn(async () => filePath) }), { musicRoot: root });
  const albumId = (await current.catalog.listAlbums()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/albums/${albumId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(fs.existsSync(albumDir)).toBe(false);
});

test("album deletion validates every file before unlinking any track", async () => {
  const root = musicRoot();
  const inside = path.join(root, "Album", "one.mp3");
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.flac`);
  directories.push(outside);
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, "keep-inside");
  fs.writeFileSync(outside, "keep-outside");
  const base = await createFakeBackend().getTrack("track-1");
  const tracks = [{ ...base!, id: "track-1" }, { ...base!, id: "track-2" }];
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  const backend = createFakeBackend({
    getAlbumTracks: vi.fn(async () => tracks),
    getTrackFilePath: vi.fn(async (id) => id === "track-1" ? inside : outside),
    scanLibrary,
  });
  current = await createTestServer(backend, { musicRoot: root });
  const albumId = (await current.catalog.listAlbums()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/albums/${albumId}`, headers: { cookie } });
  expect(response.statusCode).toBe(400);
  expect(fs.readFileSync(inside, "utf8")).toBe("keep-inside");
  expect(fs.readFileSync(outside, "utf8")).toBe("keep-outside");
  expect(scanLibrary).not.toHaveBeenCalled();
});

test("deletion reports a rescan warning when the provider rejects the scan", async () => {
  const root = musicRoot();
  const filePath = path.join(root, "song.mp3");
  fs.writeFileSync(filePath, "audio");
  const requestLibraryRescan = vi.fn(async () => { throw new Error("provider unavailable"); });
  const scanLibrary = vi.fn(async () => ({ scanning: false }));
  current = await createTestServer(createFakeBackend({ getTrackFilePath: vi.fn(async () => filePath), requestLibraryRescan, scanLibrary }), { musicRoot: root });
  const trackId = (await current.catalog.listTracks()).items[0].id;
  const { cookie } = await login(current.app);
  const response = await current.app.inject({ method: "DELETE", url: `/api/v1/admin/tracks/${trackId}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.json().warning).toMatch(/rescan/);
  expect(fs.existsSync(filePath)).toBe(false);
  expect(requestLibraryRescan).toHaveBeenCalledOnce();
  expect(scanLibrary).not.toHaveBeenCalled();
});
