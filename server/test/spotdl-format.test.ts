import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SPOTDL_FORMATS, parseSpotDLOutputFormat, spotDLFormatArgs } from "../src/domain/spotdl-format.js";
import { SpotDLDownloaderAdapter } from "../src/domain/spotdl-downloader-adapter.js";
import { createSpotDLDownloaderPlugin } from "../src/plugins/first-party.js";
import { PluginRegistry } from "../src/plugins/plugin-registry.js";
import { createUser } from "../src/users/users.js";
import { closeTestServer, createTestServer, login } from "./helpers.js";

let env: Awaited<ReturnType<typeof createTestServer>> | undefined;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (env) {
    await closeTestServer(env.app, env.db);
    fs.rmSync(env.directory, { recursive: true, force: true });
    env = undefined;
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test.each([
  ["best", "m4a", "disable"], ["m4a", "m4a", "disable"], ["opus", "opus", "disable"],
  ["mp3", "mp3", "320k"], ["flac", "flac", "disable"], ["ogg", "ogg", "auto"], ["wav", "wav", "disable"],
] as const)("%s is applied to individual downloads and Spotify playlist metadata commands", async (setting, format, bitrate) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musicdeck-format-")); directories.push(directory);
  const run = vi.fn(() => ({ pid: 1, kill: () => {}, promise: Promise.resolve({ exitCode: 1, stdout: "", stderr: "Fixture: no network download" }) }));
  const adapter = new SpotDLDownloaderAdapter({ runner: { run }, spotdlPath: "spotdl" });
  adapter.configure({ outputFormat: setting });
  const context = { jobId: "format-test", tmpDir: directory, signal: new AbortController().signal };
  await adapter.download({ spotifyTrackUrl: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv", outputDirectory: directory }, context);
  await adapter.fetchPlaylistTracks("https://open.spotify.com/playlist/abc123", context);
  const calls = run.mock.calls as unknown as Array<[string, string[]]>;
  expect(calls).toHaveLength(2);
  for (const [, args] of calls) {
    expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 4)).toEqual(["--format", format, "--bitrate", bitrate]);
    expect(args).not.toContain("best");
  }
  const args = calls[0][1];
  expect(args.slice(args.indexOf("--detect-formats") + 1, args.indexOf("--detect-formats") + 1 + SPOTDL_FORMATS.length)).toEqual(SPOTDL_FORMATS);
});

test("default uses source-quality M4A; invalid settings are rejected before reaching a process", () => {
  expect(parseSpotDLOutputFormat(undefined)).toBe("best");
  expect(spotDLFormatArgs("best")).toEqual(["--format", "m4a", "--bitrate", "disable"]);
  for (const value of [null, "", "aac", "best --exec", 42, {}, "MP3"]) {
    expect(() => parseSpotDLOutputFormat(value)).toThrow("supported spotDL audio format");
  }
});

test("admin format settings persist, apply immediately, survive registry restart, and reject unsupported values without overwriting configuration", async () => {
  env = await createTestServer();
  const adapter = new SpotDLDownloaderAdapter();
  const configure = vi.spyOn(adapter, "configure");
  await env.plugins.register(createSpotDLDownloaderPlugin(adapter));
  const cookie = (await login(env.app)).cookie!;
  const patch = (config: Record<string, unknown>, session = cookie) => env!.app.inject({
    method: "PATCH", url: "/api/admin/plugins/spotdl-downloader", headers: { cookie: session },
    payload: { enabled: true, config, permissions: ["library.acquire", "network.request"] },
  });
  const defaults = env.plugins.get("spotdl-downloader", true);
  expect(defaults.configFields.find((field) => field.key === "outputFormat")).toMatchObject({ type: "select", default: "best" });
  expect((await patch({})).statusCode).toBe(200);
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: "best" }));
  expect((await patch({ outputFormat: "opus" })).statusCode).toBe(200);
  expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: "opus" }));
  expect((await patch({ outputFormat: "unsupported" })).statusCode).toBe(400);
  expect(env.plugins.get("spotdl-downloader", true).config).toMatchObject({ outputFormat: "opus" });
  const restarted = new PluginRegistry(env.db, {});
  const nextAdapter = new SpotDLDownloaderAdapter();
  const nextConfigure = vi.spyOn(nextAdapter, "configure");
  await restarted.register(createSpotDLDownloaderPlugin(nextAdapter));
  expect(nextConfigure).toHaveBeenCalledWith(expect.objectContaining({ outputFormat: "opus" }));
  await createUser(env.db, { username: "listener", password: "listener-password" });
  const listener = (await login(env.app, "listener", "listener-password")).cookie!;
  expect((await patch({ outputFormat: "mp3" }, listener)).statusCode).toBe(403);
  expect(env.plugins.get("spotdl-downloader", true).config).toMatchObject({ outputFormat: "opus" });
});
