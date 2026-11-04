import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeTestServer, createTestServer, login } from "./helpers.js";
import { createUser } from "../src/users/users.js";
import { createPrivacyManager } from "../src/services/PrivacyManager.js";
import { loadConfig } from "../src/config.js";

const defaults = { localOnly: false, allowMetadata: true, allowImports: true, allowArtwork: true };
let current: Awaited<ReturnType<typeof createTestServer>>;
let admin: string;
let listener: string;
let track: string;
beforeAll(async () => {
  current = await createTestServer();
  admin = (await login(current.app)).cookie!;
  await createUser(current.db, { username: "privacy-listener", password: "listener-password" });
  listener = (await login(current.app, "privacy-listener", "listener-password")).cookie!;
  track = (await current.app.inject({ url: "/api/tracks", headers: { cookie: admin } })).json().tracks[0].id;
});
afterAll(async () => { await closeTestServer(current.app, current.db); });
const save = (settings = defaults) => current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: admin }, payload: settings });

describe("authenticated global privacy policy", () => {
  test("is readable by listeners, writable only by administrators and strictly validated", async () => {
    expect((await current.app.inject({ url: "/api/v1/privacy" })).statusCode).toBe(401);
    expect((await current.app.inject({ url: "/api/v1/privacy", headers: { cookie: listener } })).statusCode).toBe(200);
    expect((await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: listener }, payload: defaults })).statusCode).toBe(403);
    for (const settings of [{ ...defaults, localOnly: "true" }, { ...defaults, userId: "other" }, { localOnly: true }]) {
      expect((await current.app.inject({ method: "PATCH", url: "/api/v1/privacy", headers: { cookie: admin }, payload: settings })).statusCode).toBe(400);
    }
    const saved = await save({ ...defaults, localOnly: true, allowArtwork: false });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers["cache-control"]).toBe("private, no-store");
    const synchronized = await current.app.inject({ url: "/api/v1/privacy", headers: { cookie: listener } });
    expect(synchronized.json()).toEqual(saved.json());
    expect(createPrivacyManager(current.db, loadConfig()).snapshot()).toEqual(saved.json());
  });
  test.each([
    ["GET", "/api/discovery/external"],
    ["POST", "/api/discovery/external/previews"],
    ["GET", "/api/discovery/itunes-preview?term=artist&entity=song&limit=1"],
    ["GET", "/api/artwork/external/extart_unknown"],
    ["GET", "/api/metadata/album-artwork?artist=Artist&album=Album"],
    ["GET", "/api/metadata/artist-biography?artist=Artist"],
    ["GET", "/api/search?q=Artist&mode=external"],
    ["GET", "/api/search?q=Artist&phase=external"],
    ["GET", "/api/albums/external_deezer_album_1"],
    ["GET", "/api/albums/extdetail_deezer_album_1"],
    ["GET", "/api/artists/deezer_artist_1"],
    ["GET", "/api/tracks/external_deezer_track_1/stream"],
    ["GET", "/api/playback/preview?url=https%3A%2F%2Fa.dzcdn.net%2Fpreview.mp3"],
    ["POST", "/api/playback/normalize"],
    ["POST", "/api/acquisitions"],
    ["POST", "/api/v1/playlists/import-spotify"],
    ["GET", "/api/admin/downloader/diagnostics"],
  ] as const)("blocks %s %s with standard 403 before provider work", async (method, url) => {
    await save({ ...defaults, localOnly: true });
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const response = await current.app.inject({ method, url, headers: { cookie: admin },
        ...(method === "POST" ? { payload: { previewUrl: "https://a.dzcdn.net/p.mp3" } } : {}) });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "LOCAL_ONLY_MODE_ACTIVE", message: "Local Only Mode Active" } });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  test("preserves local catalog, hybrid search, native streaming and playlist creation", async () => {
    await save({ ...defaults, localOnly: true });
    const network = vi.spyOn(globalThis, "fetch");
    try {
      for (const url of ["/api/tracks", "/api/albums", "/api/artists", "/api/search?q=Track&mode=library", "/api/search?q=Track", `/api/tracks/${track}/stream`, "/api/playlists"]) {
        const response = await current.app.inject({ url, headers: { cookie: admin } });
        expect(response.statusCode, url).toBe(url.endsWith("/stream") ? 206 : 200);
      }
      const playlist = await current.app.inject({ method: "POST", url: "/api/playlists", headers: { cookie: admin }, payload: { name: "Local playlist" } });
      expect(playlist.statusCode).toBe(201);
      const artists = (await current.app.inject({ url: "/api/artists", headers: { cookie: admin } })).json().artists;
      const topTracks = await current.app.inject({ url: `/api/artists/${artists[0].id}/top-tracks`, headers: { cookie: listener } });
      expect(topTracks.statusCode).toBe(200);
      expect(topTracks.json().tracks.length).toBeGreaterThan(0);
      expect(topTracks.json().tracks.every((item: { source: { kind: string } }) => item.source.kind === "library")).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  test("granular denials use their own 403 code without switching off local features", async () => {
    await save({ ...defaults, allowImports: false });
    const response = await current.app.inject({ method: "POST", url: "/api/v1/playlists/import-spotify", headers: { cookie: admin }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("EXTERNAL_INTEGRATION_DISABLED");
    expect((await current.app.inject({ url: "/api/tracks", headers: { cookie: listener } })).statusCode).toBe(200);
    await save();
  });
});
