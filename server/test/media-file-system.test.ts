import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { saveAlbumArtworkToFolder } from "../src/utils/mediaFileSystem.js";

const directories: string[] = [];
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
const url = "https://i.scdn.co/image/test";
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-folder-art-"));
  directories.push(root);
  const album = path.join(root, "Artist", "Album");
  fs.mkdirSync(album, { recursive: true });
  return { root, album };
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function image() { return new Response(jpeg, { headers: { "content-type": "image/jpeg" } }); }

test("publishes cover.jpg and folder.jpg atomically, readable by other processes", async () => {
  const { root, album } = directory();
  const fetchImpl = vi.fn<typeof fetch>(async () => image());
  expect(await saveAlbumArtworkToFolder(album, url, root, fetchImpl)).toBe(true);
  for (const name of ["cover.jpg", "folder.jpg"]) {
    const file = path.join(album, name);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(jpeg));
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  }
  expect(fs.readdirSync(album).sort()).toEqual(["cover.jpg", "folder.jpg"]);
  expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error" }));
  expect(await saveAlbumArtworkToFolder(album, url, root, fetchImpl)).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("preserves an existing operator cover while filling the missing folder image", async () => {
  const { root, album } = directory();
  fs.writeFileSync(path.join(album, "cover.jpg"), "operator cover");
  await saveAlbumArtworkToFolder(album, url, root, async () => image());
  expect(fs.readFileSync(path.join(album, "cover.jpg"), "utf8")).toBe("operator cover");
  expect(fs.readFileSync(path.join(album, "folder.jpg"))).toEqual(Buffer.from(jpeg));
});

test("rejects traversal, escaped symlink directories, and non-Spotify CDN URLs before fetching", async () => {
  const { root, album } = directory();
  const other = directory();
  const fetchImpl = vi.fn<typeof fetch>(async () => image());
  await expect(saveAlbumArtworkToFolder(path.join(root, "..", "escape"), url, root, fetchImpl)).rejects.toThrow("outside");
  const link = path.join(root, "escaped");
  fs.symlinkSync(other.album, link, process.platform === "win32" ? "junction" : "dir");
  await expect(saveAlbumArtworkToFolder(link, url, root, fetchImpl)).rejects.toThrow("escapes");
  await expect(saveAlbumArtworkToFolder(album, "https://i.scdn.co.evil.test/image/x", root, fetchImpl)).rejects.toThrow("CDN");
  await expect(saveAlbumArtworkToFolder(album, "https://i.scdn.co:123/image/x", root, fetchImpl)).rejects.toThrow("CDN");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(["network", "mime", "truncated", "oversize"])("a %s failure leaves no published or temporary files", async (failure) => {
  const { root, album } = directory();
  const fetchImpl: typeof fetch = async () => {
    if (failure === "network") throw new Error("offline");
    if (failure === "mime") return new Response("error", { headers: { "content-type": "text/html" } });
    if (failure === "truncated") return new Response(jpeg.slice(0, -2), { headers: { "content-type": "image/jpeg" } });
    return new Response(jpeg, { headers: { "content-type": "image/jpeg", "content-length": String(6 * 1024 * 1024) } });
  };
  await expect(saveAlbumArtworkToFolder(album, url, root, fetchImpl)).rejects.toThrow();
  expect(fs.readdirSync(album)).toEqual([]);
});

test("concurrent writers cannot overwrite a competing complete cover", async () => {
  const { root, album } = directory();
  await Promise.all([
    saveAlbumArtworkToFolder(album, url, root, async () => image()),
    saveAlbumArtworkToFolder(album, url, root, async () => image()),
  ]);
  expect(fs.readFileSync(path.join(album, "cover.jpg"))).toEqual(Buffer.from(jpeg));
  expect(fs.readdirSync(album).sort()).toEqual(["cover.jpg", "folder.jpg"]);
});
