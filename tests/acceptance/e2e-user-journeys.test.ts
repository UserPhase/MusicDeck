import { test as base, expect, type Page, type TestInfo, type Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildAcceptanceBrowser, fixtureConfig, root, startApplication, type Application } from "./helpers/appFixture.js";
import { catalogTracks, createWav, startMockBackend, type MockBackend, type MockTrack } from "./helpers/mockBackends.js";
import { openDatabase, type Db } from "../../server/src/db/database.js";
import { prepareDatabasePath } from "../../server/src/db/file-permissions.js";
import { runMigrations, seedInitialData } from "../../server/src/db/migrations.js";
import type { DownloaderAdapter, SpotifyImportTrackMetadata } from "../../server/src/domain/downloader-adapter.js";
import type { SpotifyImportJob } from "../../server/src/domain/spotify-playlist-import.js";
import type { Track } from "../../server/src/types.js";
import type {} from "./helpers/browserProbe.js";
import { launchLifecycleBrowser } from "./helpers/nativeBrowser.js";
import { normalizeMusicText, versionSignature } from "../../server/src/domain/music-identity.js";

interface Options { dual: boolean; trackCount: number; partialImport: boolean; legacy: boolean; externalMetadata: boolean; releaseMetadata: boolean }
interface System {
  app: Application; nav: MockBackend; jelly: MockBackend; directory: string;
  importAttempts: Map<number, number>; importFiles: string[];
}
const tempBase = path.resolve(root, ".tmp");
async function temporaryDirectory() {
  await fs.mkdir(tempBase, { recursive: true });
  return fs.mkdtemp(path.join(tempBase, "acceptance-"));
}
async function removeFixture(directory: string) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith("acceptance-")) throw new Error(`Unsafe fixture cleanup: ${resolved}`);
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/** Materialize the actual pre-39 inline-payload shape, not just an old migration number. */
async function seedLegacyDatabase(config: ReturnType<typeof fixtureConfig>) {
  const require = createRequire(path.join(root, "server/package.json"));
  const Database = require("better-sqlite3") as new (filename: string) => Db;
  prepareDatabasePath(config.databasePath);
  const db = new Database(config.databasePath);
  try {
    db.pragma("foreign_keys = ON");
    runMigrations(db, 38);
    await seedInitialData(db, config);
    const user = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
    db.transaction(() => {
      db.exec(`ALTER TABLE smart_playlist_tracks ADD COLUMN track_json TEXT NOT NULL DEFAULT '{}';
        DROP TABLE smart_playlist_track_payloads;
        DROP TABLE smart_playlist_genres;`);
      db.prepare("INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?)").run(user.id, "acceptance.preference", '"keep-me"', "2024-01-01");
      db.prepare("INSERT INTO playlists(id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run("mdpl_legacy", user.id, "Legacy road trip", "2024-01-01", "2024-01-01");
      const item = db.prepare("INSERT INTO playlist_items(id,playlist_id,position,connection_id,provider_track_id,created_at) VALUES(?,?,?,?,?,?)");
      const projection = db.prepare("INSERT INTO smart_playlist_tracks(id,title,artist,album,genre,year,revision,track_json) VALUES(?,?,?,?,?,?,?,?)");
      for (let i = 0; i < 1000; i++) {
        item.run(`legacy-item-${i}`, "mdpl_legacy", i, "acceptance-nav", `track-${i % 80 + 1}`, "2024-01-01");
        const payload = { id: `legacy-track-${i}`, title: `Legacy ${i}`, genres: ["Rock", "Ambient"], year: 2000 + i % 20 };
        projection.run(payload.id, payload.title, "Legacy artist", "Legacy album", "Rock", payload.year, "legacy", JSON.stringify(payload));
      }
    })();
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { db.close(); }
}

const test = base.extend<Options & { system: System }, { browserDirectory: string }>({
  dual: [false, { option: true }], trackCount: [80, { option: true }],
  partialImport: [false, { option: true }], legacy: [false, { option: true }],
  externalMetadata: [false, { option: true }],
  releaseMetadata: [false, { option: true }],
  browserDirectory: [async ({}, use) => {
    const directory = await temporaryDirectory();
    try { await buildAcceptanceBrowser(directory); await use(directory); }
    finally { await removeFixture(directory); }
  }, { scope: "worker", timeout: 90_000 }],
  system: async ({ browserDirectory, dual, trackCount, partialImport, legacy, externalMetadata, releaseMetadata }, use, info) => {
    const directory = await temporaryDirectory();
    let nav: MockBackend | undefined, jelly: MockBackend | undefined, app: Application | undefined;
    const successes: MockTrack[] = [], importFiles: string[] = [];
    const importAttempts = new Map<number, number>();
    try {
      nav = await startMockBackend({ kind: "navidrome", tracks: partialImport ? [] : catalogTracks("navidrome", trackCount), onScan: () => { if (partialImport) nav!.setTracks([...successes]); } });
      jelly = await startMockBackend({ kind: "jellyfin" });
      const config = fixtureConfig(directory, nav, jelly, { localOnlyMode: !partialImport && !externalMetadata });
      if (legacy) await seedLegacyDatabase(config);
      const sources: SpotifyImportTrackMetadata[] = Array.from({ length: 20 }, (_, i) => ({ position: i + 1,
        url: `https://open.spotify.com/track/acceptance${i + 1}`, title: `Import song ${i + 1}`, artist: "Import Artist", album: "Import Album", duration: 90 }));
      const failed = new Set([4, 11, 17]);
      const downloader: DownloaderAdapter = {
        id: "acceptance-spotdl", name: "Isolated spotDL process boundary",
        capabilities: { spotifyTrack: true, textSearch: true, directUrl: false, album: false, playlist: true, metadata: true },
        canHandle: () => true,
        async fetchPlaylistTracks() { return { status: "completed", files: [], playlistTracks: sources, playlistLength: sources.length }; },
        async download(request, context) {
          const source = sources.find(track => track.url === request.spotifyTrackUrl || track.url === request.sourceUrl || track.url === request.query || track.title === request.canonicalMetadata?.title);
          if (!source) throw new Error(`Unexpected spotDL request: ${JSON.stringify(request)}`);
          const position = source.position;
          importAttempts.set(position, (importAttempts.get(position) ?? 0) + 1);
          if (failed.has(position)) {
            context.onLog?.("stderr", `Fixture audio provider refused track ${position}`);
            return { status: "failed", files: [], error: { code: "non-retryable", message: `Fixture track ${position} unavailable` },
              diagnostics: { strategy: "cached-metadata", output: `Track ${position}: simulated provider failure` } };
          }
          const file = path.join(request.libraryRoot ?? request.outputDirectory, "Import Artist", "Import Album", `${source.title}.wav`);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, createWav(90)); importFiles.push(file);
          if (!successes.some(track => track.id === `import-${position}`)) successes.push({ id: `import-${position}`, title: source.title, artist: source.artist, album: source.album!, duration: 90 });
          return { status: "completed", files: [{ path: file, title: source.title, artist: source.artist, album: source.album, durationSeconds: 90 }] };
        },
      };
      const releaseFetch: typeof fetch = async input => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const artist = { wrapperType: "artist", artistId: 99, artistName: "Release Artist" };
        const albums = ["Night Drive", "First Light - EP", "After Hours - Single"].map((name, index) => ({ wrapperType: "collection",
          collectionId: 901 + index, collectionName: name, artistId: 99, artistName: "Release Artist", releaseDate: new Date(Date.now() - index * 86400_000).toISOString(),
          trackCount: 3, collectionViewUrl: `https://music.apple.com/us/album/${901 + index}` }));
        const albumId = Number(url.searchParams.get("id"));
        const songs = Array.from({ length: 3 }, (_, index) => ({ kind: "song", trackId: 9001 + index, trackName: `Release Preview ${index + 1}`,
          artistId: 99, artistName: "Release Artist", collectionId: albumId >= 901 ? albumId : 901, collectionName: "Night Drive", trackTimeMillis: 180000,
          previewUrl: `https://audio-ssl.itunes.apple.com/preview-${index}.m4a` }));
        const results = url.hostname === "itunes.apple.com" ? url.pathname === "/search" ? [artist] :
          url.searchParams.get("entity") === "song" ? [...albums, ...songs] : [artist, ...albums] : [];
        return new Response(JSON.stringify({ results, data: [] }), { headers: { "content-type": "application/json" } });
      };
      app = await startApplication(config, browserDirectory, { dual, downloader: partialImport ? downloader : undefined,
        metadataFetch: releaseMetadata ? releaseFetch : undefined });
      await use({ app, nav, jelly, directory, importAttempts, importFiles });
    } finally {
      try {
        if (nav) await info.attach("navidrome-requests", { body: JSON.stringify(nav.requests, null, 2), contentType: "application/json" });
        if (jelly) await info.attach("jellyfin-requests", { body: JSON.stringify(jelly.requests, null, 2), contentType: "application/json" });
      } finally {
        try { await app?.close(); }
        finally {
          const results = await Promise.allSettled([nav?.close(), jelly?.close()]);
          await removeFixture(directory);
          for (const result of results) if (result.status === "rejected") throw result.reason;
        }
      }
      expect(nav?.activeConnections ?? 0, "Navidrome sockets closed").toBe(0);
      expect(jelly?.activeConnections ?? 0, "Jellyfin sockets closed").toBe(0);
      expect(app?.db.open ?? false, "SQLite connection closed").toBe(false);
      expect(nav?.unexpected ?? [], "Unsupported Navidrome calls must not silently succeed").toEqual([]);
      expect(jelly?.unexpected ?? [], "Unsupported Jellyfin calls must not silently succeed").toEqual([]);
    }
  },
});

async function login(page: Page, app: Application) {
  const url = `${app.url}/login`;
  try {
    await page.goto(url, { waitUntil: "commit" });
  } catch (error) {
    // A newly attached Chromium startup tab can abort its first navigation.
    if (!(error instanceof Error) || !error.message.includes("net::ERR_ABORTED") || page.url() !== "about:blank") throw error;
    await page.goto(url, { waitUntil: "commit" });
  }
  await page.getByPlaceholder("Username").fill("admin");
  await page.getByPlaceholder("Password").fill("acceptance-admin-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/playlists$/);
  await page.waitForFunction(() => Boolean(window.__acceptance?.player && window.__acceptance.engine && window.__acceptance.downloads.getOwner()));
}
async function api<T>(page: Page, app: Application, route: string, method = "GET", data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${app.url}${route}`, { method, data });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function allTracks(page: Page, app: Application) { return (await api<{ tracks: Track[] }>(page, app, "/api/tracks")).tracks; }
async function openTracks(page: Page, app: Application, count: number) {
  await page.goto(`${app.url}/library/tracks`);
  await expect(page.getByRole("table", { name: "Tracks", exact: true })).toHaveAttribute("aria-rowcount", String(count + 1));
  await expect(page.locator('.track[role="row"]').first()).toBeVisible();
}
async function attachJson(info: TestInfo, name: string, value: unknown) {
  const file = info.outputPath(`${name}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  await info.attach(name, { path: file, contentType: "application/json" });
}

test.describe("MusicDeck acceptance: complete user journeys", () => {
  test("Scenario 1: Clean Installation & Guided Setup", async ({ page, system }) => {
    const { app, nav } = system;
    await test.step("Bootstrap an empty SQLite database and sign in through the UI", async () => {
      expect(app.db.pragma("integrity_check", { simple: true })).toBe("ok");
      await login(page, app);
      expect((await api<{ firstRun: boolean }>(page, app, "/api/v1/admin/system/status")).firstRun).toBe(true);
    });
    await test.step("Connect the provider, create required directories and finish setup", async () => {
      await page.goto(`${app.url}/admin/setup-recovery`);
      await expect(page.getByRole("heading", { name: "Setup & recovery" })).toBeVisible();
      await page.getByRole("button", { name: "Continue to health checks" }).click();
      await page.getByRole("button", { name: "Run health diagnostics", exact: true }).click();
      await expect(page.getByText("Core checks passed", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Complete setup & continue" }).click();
      await expect(page.getByText("Setup checks completed. Create your first system backup.", { exact: true })).toBeVisible();
      expect((await api<{ firstRun: boolean }>(page, app, "/api/v1/admin/system/status")).firstRun).toBe(false);
      for (const directory of [app.config.musicRoot, app.config.acquisitionTmpDir, path.dirname(app.config.databasePath)]) expect((await fs.stat(directory)).isDirectory()).toBe(true);
      expect(nav.requests.some(request => request.endpoint === "ping" && request.status === 200)).toBe(true);
    });
    await test.step("Retain first-run completion across a new database connection", async () => {
      const db = await openDatabase(app.config);
      try { expect(db.prepare("SELECT value FROM server_settings WHERE key='setup.completedAt'").get()).toBeTruthy(); }
      finally { db.close(); }
    });
  });

  test.describe("legacy schema", () => {
    test.use({ legacy: true });
    test("Scenario 2: Legacy Schema Migration", async ({ page, system }) => {
      const { app } = system;
      expect(app.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(app.db.pragma("foreign_key_check")).toEqual([]);
      expect(app.db.prepare("SELECT id FROM schema_migrations WHERE id IN (39,40) ORDER BY id").all()).toEqual([{ id: 39 }, { id: 40 }]);
      expect(app.db.prepare("PRAGMA table_info(smart_playlist_tracks)").all().some((column: any) => column.name === "track_json")).toBe(false);
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM smart_playlist_track_payloads").get()).toEqual({ n: 1000 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM smart_playlist_genres WHERE genre='Ambient'").get()).toEqual({ n: 1000 });
      const payloads = app.db.prepare("SELECT track_json FROM smart_playlist_track_payloads ORDER BY track_id").all() as { track_json: string }[];
      expect(new Set(payloads.map(row => JSON.parse(row.track_json).id)).size).toBe(1000);
      expect(app.db.prepare("SELECT value FROM user_settings WHERE key='acceptance.preference'").get()).toEqual({ value: '"keep-me"' });
      // Check migration idempotence before live catalog reads legitimately refresh
      // the disposable smart-playlist projection with current provider metadata.
      const before = createHash("sha256").update(JSON.stringify(payloads)).digest("hex");
      const reopened = await openDatabase(app.config);
      try {
        expect(createHash("sha256").update(JSON.stringify(reopened.prepare("SELECT track_json FROM smart_playlist_track_payloads ORDER BY track_id").all())).digest("hex")).toBe(before);
        expect(reopened.pragma("foreign_key_check")).toEqual([]);
      } finally { reopened.close(); }
      await login(page, app);
      const playlist = await api<{ playlist: { tracks: Track[] } }>(page, app, "/api/playlists/mdpl_legacy");
      expect(playlist.playlist.tracks).toHaveLength(1000);
      const order = app.db.prepare("SELECT id,position FROM playlist_items WHERE playlist_id='mdpl_legacy' ORDER BY position").all();
      expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => ({ id: `legacy-item-${i}`, position: i })));
      await page.goto(`${app.url}/playlist/mdpl_legacy`);
      await expect(page.getByRole("heading", { name: "Legacy road trip" })).toBeVisible();
      expect(await page.locator('.track[role="row"]').count()).toBeLessThan(60);
    });
  });

  test.describe("two simultaneous providers", () => {
    test.use({ dual: true });
    test("Scenario 3: Dual Backend Coexistence", async ({ page, system }) => {
      const { app, nav, jelly } = system;
      await login(page, app);
      const tracks = await allTracks(page, app);
      expect(tracks).toHaveLength(160);
      expect(new Set(tracks.map(track => track.id)).size).toBe(160);
      expect(tracks.filter(track => track.title === "Shared Song")).toHaveLength(2);
      const artists = await api<{ artists: Array<{ availability: { connectionId: string } }> }>(page, app, "/api/artists");
      const albums = await api<{ albums: Array<{ name: string; availability: { connectionId: string } }> }>(page, app, "/api/albums");
      for (const items of [artists.artists, albums.albums]) {
        expect(items).toHaveLength(2);
        expect(items.map(item => item.availability.connectionId).sort()).toEqual(["acceptance-jelly", "acceptance-nav"]);
      }
      const search = await api<{ tracks: Track[]; degraded: boolean }>(page, app, "/api/search?q=Song&types=tracks&mode=library");
      expect(search.degraded).toBe(false);
      expect(search.tracks.some(track => track.title.startsWith("Navidrome"))).toBe(true);
      expect(search.tracks.some(track => track.title.startsWith("Jellyfin"))).toBe(true);
      for (const prefix of ["Navidrome", "Jellyfin"]) {
        const track = tracks.find(track => track.title.startsWith(prefix))!;
        const stream = await page.request.get(`${app.url}/api/tracks/${encodeURIComponent(track.id)}/stream`, { headers: { Range: "bytes=0-43" } });
        expect(stream.status()).toBe(206);
        expect(stream.headers()["content-range"]).toBe(`bytes 0-43/${nav.audio.length}`);
        expect((await stream.body()).subarray(0, 4).toString()).toBe("RIFF");
      }
      await openTracks(page, app, 160);
      const table = page.getByRole("table", { name: "Tracks", exact: true });
      await expect(table.locator(".collector-editions").getByText("Navidrome", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Search this library" }).click();
      await page.getByRole("searchbox", { name: "Search this library" }).fill("Navidrome");
      await expect(table.locator(".track-title-text mark").first()).toHaveText("Navidrome");
      await page.getByRole("searchbox", { name: "Search this library" }).press("Escape");
      await expect(table).toHaveAttribute("aria-rowcount", "161");
      const titleSort = table.getByRole("button", { name: "Title", exact: true });
      const titleColumn = table.getByRole("columnheader", { name: "Title", exact: true });
      await titleSort.click();
      await expect(titleColumn).toHaveAttribute("aria-sort", "ascending");
      await titleSort.click();
      await expect(titleColumn).toHaveAttribute("aria-sort", "descending");
      const names = await table.locator(".track-title-text").allTextContents();
      expect(names.length).toBeGreaterThan(1);
      expect(names).toEqual([...names].sort(new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare).reverse());
      await table.getByRole("button", { name: "Duration", exact: true }).click();
      await expect(table.getByRole("columnheader", { name: "Duration" })).toHaveAttribute("aria-sort", "ascending");
      await page.getByRole("button", { name: "Sort tracks" }).click();
      const trackOrder = page.getByRole("menu", { name: "Sort tracks" });
      await expect(trackOrder.getByRole("combobox")).toHaveCount(0);
      await expect(trackOrder.getByRole("menuitemradio", { name: "Shortest first" })).toHaveAttribute("aria-checked", "true");
      await trackOrder.getByRole("menuitemradio", { name: "Longest first" }).click();
      await expect(table.getByRole("columnheader", { name: "Duration" })).toHaveAttribute("aria-sort", "descending");
      await table.getByRole("button", { name: "Track number" }).click();
      await expect(table.getByRole("columnheader", { name: "Duration" })).not.toHaveAttribute("aria-sort");
      await page.goto(`${app.url}/library/albums`);
      const sortAlbums = page.getByRole("button", { name: "Sort albums" });
      const albumSort = page.getByRole("menu", { name: "Sort albums" });
      await sortAlbums.click();
      const albumGrid = page.getByRole("list", { name: "Albums", exact: true });
      const albumTitles = albumGrid.locator(".album-title");
      const alphabeticTitles = albums.albums.map(album => album.name).sort((a, b) => a.localeCompare(b));
      await albumSort.getByRole("menuitemradio", { name: "A–Z", exact: true }).click();
      await expect(albumTitles).toHaveText(alphabeticTitles);
      await sortAlbums.click();
      await albumSort.getByRole("menuitemradio", { name: "Z–A", exact: true }).click();
      await expect(albumTitles).toHaveText([...alphabeticTitles].reverse());
      await expect(albumGrid.locator(".collector-editions .audio-quality-badge").filter({ hasNotText: /^Remaster$/ })).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await sortAlbums.click();
      await expect(albumSort.getByRole("menuitemradio", { name: "Z–A", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(albumSort.getByRole("combobox")).toHaveCount(0);
      expect(await albumSort.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.goto(`${app.url}/library/artists`);
      const sortArtists = page.getByRole("button", { name: "Sort artists" });
      const artistNames = page.locator(".artist-grid .artist-name");
      await expect(artistNames).toHaveCount(2);
      const orderedArtists = await artistNames.allTextContents();
      await sortArtists.click();
      await expect(page.getByRole("menuitemradio", { name: "All artists" })).toHaveCount(0);
      await page.getByRole("menuitemradio", { name: "Z–A", exact: true }).click();
      await expect(artistNames).toHaveText([...orderedArtists].reverse());
      await page.getByRole("button", { name: "Search artists" }).click();
      await page.getByRole("searchbox", { name: "Search artists" }).fill("unmatched artist");
      await expect(page.getByText("No artists match your search.")).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      const sidebar = page.getByRole("complementary", { name: "Main navigation" });
      await expect(sidebar.getByRole("link", { name: /^(Downloads|Listening Activity)$/ })).toHaveCount(0);
      await page.getByRole("link", { name: "Listening Activity", exact: true }).click();
      await expect(page).toHaveURL(/\/listening-activity$/);
      await page.getByRole("link", { name: "Downloads", exact: true }).click();
      await expect(page).toHaveURL(/\/downloads$/);
      expect(nav.requests.some(request => request.endpoint === "stream" && request.range === "bytes=0-43")).toBe(true);
      expect(jelly.requests.some(request => /\/Audio\/.*\/stream/.test(request.path) && request.range === "bytes=0-43")).toBe(true);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.route("**/api/v1/privacy", route => route.fulfill({ json: {
        localOnly: false, allowMetadata: true, allowImports: false, allowArtwork: false, enforcedByEnvironment: false,
        effective: { metadata: true, imports: false, artwork: false, external: true },
      } }));
      await page.route("**/api/discovery/external", route => route.fulfill({ json: {
        albums: [{ id: "external_deezer_album_201", title: "Chart Album", artist: "Chart Artist", external: true }],
        artists: [], tracks: [],
      } }));
      const columns = (selector: string) => page.locator(selector).evaluate(element =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length);
      await page.goto(`${app.url}/`);
      const homeShelf = "#recent-albums-title";
      await expect(page.locator(`section:has(> .home-section-header > ${homeShelf}) .explore-album-row a`).first()).toBeVisible();
      const homeColumns = await columns(`section:has(> .home-section-header > ${homeShelf}) .explore-album-row`);
      await page.goto(`${app.url}/explore`);
      const discoverShelf = 'section[aria-labelledby="explore-popular-albums"] .explore-album-row';
      await expect(page.locator(`${discoverShelf} a`).first()).toBeVisible();
      expect(await columns(discoverShelf)).toBe(7);
      expect(homeColumns).toBe(7);
    });

    test("Scenario 4: Secondary Provider Failure & Graceful Degradation", async ({ page, system }) => {
      const { app, jelly } = system;
      await login(page, app);
      const before = await allTracks(page, app);
      const primary = before.find(track => track.title.startsWith("Navidrome"))!;
      jelly.setUnavailable(true);
      const degraded = await api<{ tracks: Track[]; degraded: boolean }>(page, app, "/api/tracks");
      expect(degraded.degraded).toBe(true);
      expect(degraded.tracks).toHaveLength(80);
      expect(degraded.tracks.some(track => track.id === primary.id)).toBe(true);
      await openTracks(page, app, 80);
      await page.getByRole("row", { name: `${primary.title} by Acceptance Artist`, exact: true }).locator(".track-title-text").click();
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(0.5);
      expect(jelly.requests.some(request => request.status === 503)).toBe(true);
      expect(await page.locator('.track[role="row"]').count()).toBeGreaterThan(0);
      expect(await page.getByText("All catalog providers are unavailable", { exact: true }).count()).toBe(0);
      jelly.setUnavailable(false);
      expect(await allTracks(page, app)).toHaveLength(160);
    });
  });

  test.describe("durable partial import", () => {
    test.use({ partialImport: true });
    test("Scenario 5: Partial SpotDL Import Failure", async ({ page, system }, info) => {
      const { app, importAttempts, importFiles } = system;
      await login(page, app);
      const started = await api<{ job: SpotifyImportJob }>(page, app, "/api/v1/playlists/import-spotify", "POST", { playlistUrl: "https://open.spotify.com/playlist/acceptance20" });
      let finished: SpotifyImportJob | undefined;
      await expect.poll(async () => {
        const response = await api<{ job: SpotifyImportJob }>(page, app, `/api/v1/playlists/import-spotify/${started.job.id}`);
        finished = response.job; return finished.status;
      }, { timeout: 45_000, intervals: [100, 200, 500] }).toBe("partial");
      expect(finished).toMatchObject({ expectedCount: 20, completedCount: 17, failedCount: 3, importedCount: 17, stage: "completed" });
      expect(importAttempts.size).toBe(20);
      const failures = finished!.manifest!.filter(entry => entry.status.startsWith("FAILED_"));
      expect(failures.map(entry => entry.position)).toEqual([4, 11, 17]);
      for (const entry of failures) {
        expect(entry.error).toContain("unavailable");
        expect(entry.downloadAttempts?.some(attempt => attempt.diagnostics?.output.includes("simulated provider failure"))).toBe(true);
      }
      expect(importFiles).toHaveLength(17);
      for (const file of importFiles) expect((await fs.stat(file)).size).toBeGreaterThan(44);
      const playlist = await api<{ playlist: { tracks: Track[] } }>(page, app, `/api/playlists/${finished!.playlistId}`);
      expect(playlist.playlist.tracks.map(track => track.title)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1).filter(i => ![4, 11, 17].includes(i)).map(i => `Import song ${i}`));
      const persisted = app.importRepository.get(started.job.id, finished!.userId);
      expect(persisted?.job).toMatchObject({ status: "partial", completedCount: 17, failedCount: 3 });
      expect(app.importRepository.unfinished()).toEqual([]);
      await attachJson(info, "partial-import-manifest", finished);
      await page.goto(`${app.url}/playlist/${finished!.playlistId}`);
      await expect(page.getByRole("heading", { name: "Acceptance import" })).toBeVisible();
    });
  });

  test("Scenario 6: Server Disconnect & Offline Recovery", async ({ page, context, system }, info) => {
    const { app, nav } = system;
    await login(page, app);
    const track = (await allTracks(page, app))[0];
    // Begin an incomplete HTTP response before the download is available.
    nav.setStreamMode("stall");
    await page.evaluate(track => window.__acceptance.player.playQueue([{ ...track, artist: track.artistName, album: track.albumName, duration: track.durationSeconds }]), track);
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(0.25);
    nav.setStreamMode("normal");
    await page.evaluate(async track => {
      await window.__acceptance.downloads.enqueueDownload({ ...track, artist: track.artistName, album: track.albumName }, "lossless");
    }, track);
    await expect.poll(() => page.evaluate(() => window.__acceptance.downloads.getSnapshot().tracks.filter(track => track.status === "verified").length)).toBe(1);
    const integrity = await page.evaluate(() => window.__acceptance.downloads.verifyIntegrity());
    expect(integrity).toEqual({ verified: 1, damaged: 0 });
    await page.evaluate(() => {
      const events: unknown[] = [];
      (window as any).__recoveryEvents = events;
      window.__acceptance.engine!.on("bufferStall", event => events.push({ type: "stall", ...event }));
      window.__acceptance.engine!.on("streamRecovered", event => events.push({ type: "recovered", ...event }));
    });
    await context.setOffline(true);
    nav.disconnectStreams();
    // Seek beyond the received 10 s buffer to make the loss observable immediately.
    await page.evaluate(() => window.__acceptance.engine!.seek(30));
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLAudioElement>("[data-audio-decks] audio[src^='blob:']")?.src ?? ""), { timeout: 30_000 }).toMatch(/^blob:/);
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime), { timeout: 30_000 }).toBeGreaterThan(30.25);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const events = await page.evaluate(() => (window as any).__recoveryEvents as Array<{ type: string; attempts?: number; position: number; restartedFromBeginning?: boolean }>);
    expect(events.some(event => event.type === "stall")).toBe(true);
    expect(events.find(event => event.type === "recovered")).toMatchObject({ attempts: 1, restartedFromBeginning: false });
    expect(events.find(event => event.type === "recovered")!.position).toBeGreaterThanOrEqual(30);
    expect(nav.requests.filter(request => request.endpoint === "stream").length).toBeGreaterThanOrEqual(2);
    await attachJson(info, "offline-recovery-events", events);
    await context.setOffline(false);
    nav.setStreamMode("normal");
    await page.goto(`${app.url}/downloads`);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect(page.getByRole("heading", { name: "Downloads", exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Downloads", exact: true })).toBeVisible();
    await expect(page.getByText(track.title, { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.__acceptance.downloads.verifyIntegrity())).toEqual({ verified: 1, damaged: 0 });
    await page.getByRole("button", { name: /^Play / }).first().click();
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(0.25);
    await context.setOffline(false);
  });

  test("Scenario 17: Sonic analysis admin opt-in", async ({ page, system }) => {
    const { app } = system;
    const route = "/api/v1/admin/sonic";
    const anonymous = await page.request.get(`${app.url}${route}`);
    expect(anonymous.status()).toBe(401);
    await login(page, app);
    await page.goto(`${app.url}/admin/sonic`);
    await expect(page.getByRole("heading", { name: "Sonic recommendations" })).toBeVisible();
    const enabled = page.getByRole("checkbox", { name: "Enable Sonic Audio Analysis" });
    const start = page.getByRole("button", { name: "Start analysis" });
    await expect(enabled).not.toBeChecked();
    await expect(start).toBeDisabled();
    await enabled.check();
    await page.getByLabel("Schedule").selectOption("nightly");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(start).toBeEnabled();
    await page.reload();
    await expect(enabled).toBeChecked();
    await expect(page.getByLabel("Schedule")).toHaveValue("nightly");
    await expect(page.getByRole("progressbar", { name: "Indexed tracks" })).toBeVisible();
  });

  test("Scenario 15: Local Sleep Timer and Equalizer", async ({ page, system }, info) => {
    const { app } = system;
    await login(page, app);
    const measurements = await page.evaluate(() => window.__acceptance.renderEqualizer());
    await attachJson(info, "equalizer-sample-peaks", measurements);
    expect(measurements.peak).toBeGreaterThan(0.5);
    expect(measurements.peak).toBeLessThan(0.95);
    expect(measurements.analyzerPeak).toBeGreaterThan(0.5);
    expect(measurements.analyzerPeak).toBeLessThan(1);
    expect(measurements.overloadPeak).toBeLessThan(1);
    expect(measurements.maxBoostPeak).toBeLessThan(1);
    expect(measurements.bypassPeak).toBeCloseTo(0.5, 4);
    expect(measurements.bellCenter).toBeCloseTo(0.126, 2);
    expect(measurements.bellAway).toBeGreaterThan(0.48);
    const fade = await page.evaluate(() => window.__acceptance.renderSleepFade());
    [0.5, 0.4, 0.25, 0.1, 0].forEach((level, index) => expect(fade[index]).toBeCloseTo(level, 3));
    await page.goto(`${app.url}/settings`);
    const equalizer = page.getByRole("region", { name: "Equalizer" });
    const enableEq = equalizer.getByRole("switch", { name: "Enable equalizer" });
    await expect(enableEq).not.toBeChecked();
    expect(await page.evaluate(() => window.__acceptance.engine!.getEqualizerAnalyser())).toBeNull();
    await enableEq.check();
    const mode = equalizer.getByRole("combobox", { name: "Equalizer mode" });
    const bandCount = equalizer.getByRole("combobox", { name: "Equalizer bands" });
    await equalizer.getByRole("combobox", { name: "Equalizer preset" }).selectOption("Bass Boost");
    await expect(equalizer.getByRole("slider", { name: "60 Hz", exact: true })).toHaveValue("6");
    await bandCount.selectOption("3");
    await expect(equalizer.getByRole("slider")).toHaveCount(3);
    await bandCount.selectOption("10");
    await expect(equalizer.getByRole("slider")).toHaveCount(10);
    await expect(equalizer.getByRole("slider", { name: "31.25 Hz", exact: true })).toHaveValue("6");
    const tracks = (await allTracks(page, app)).slice(0, 2);
    await page.evaluate(tracks => window.__acceptance.player.playQueue(tracks.map(track =>
      ({ ...track, artist: track.artistName, album: track.albumName, duration: track.durationSeconds }))), tracks);
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(0);
    await mode.selectOption("parametric");
    await expect.poll(() => equalizer.locator("canvas.eq-spectrum").evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await mode.selectOption("graphic");
    const launch = page.getByRole("button", { name: /^Sleep timer/ });
    await launch.click();
    const controls = page.getByRole("dialog", { name: "Sleep timer" });
    await controls.getByRole("button", { name: "End of current track" }).click();
    await controls.getByRole("button", { name: "Close sleep timer" }).click();
    await page.evaluate(() => {
      const engine = window.__acceptance.engine!;
      engine.seek(engine.getSnapshot().duration - 2);
    });
    await expect.poll(() => page.evaluate(() => window.__acceptance.engine!.sleepTimer.getSnapshot().status)).toBe("stopped");
    expect(await page.evaluate(() => ({
      playing: window.__acceptance.player.isPlaying,
      index: window.__acceptance.player.queueIndex,
    }))).toEqual({ playing: false, index: 0 });
    await mode.selectOption("parametric");
    const frequency = equalizer.getByRole("spinbutton", { name: "Band 1 Frequency (Hz)" });
    await frequency.fill("3200");
    await frequency.press("Enter");
    const gain = equalizer.getByRole("spinbutton", { name: "Band 1 Gain (dB)" });
    await gain.fill("-6");
    await gain.press("Enter");
    await page.reload();
    await expect(mode).toHaveValue("parametric");
    await expect(frequency).toHaveValue("3200");
    await expect(gain).toHaveValue("-6");
    const response = equalizer.getByRole("group", { name: "Parametric EQ response" });
    const point = response.getByRole("button", { name: "Select EQ band 1" });
    const curve = response.locator(".eq-response-total");
    const initialCurve = await curve.getAttribute("d");
    await point.scrollIntoViewIfNeeded();
    const bounds = (await point.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 22, bounds.y + bounds.height / 2 - 30, { steps: 4 });
    await expect(curve).not.toHaveAttribute("d", initialCurve!);
    await page.mouse.up();
    expect(Number(await frequency.inputValue())).toBeGreaterThan(3200);
    expect(Number(await gain.inputValue())).toBeGreaterThan(-6);
    await equalizer.getByRole("button", { name: "Band 2", exact: true }).click();
    const bandTwoQ = equalizer.getByRole("spinbutton", { name: "Band 2 Q" });
    const bandTwoGain = equalizer.getByRole("spinbutton", { name: "Band 2 Gain (dB)" });
    const bandTwoFilter = equalizer.getByRole("combobox", { name: "Band 2 filter" });
    const bellCurve = await curve.getAttribute("d");
    for (const type of ["lowpass", "highpass", "notch"]) {
      await bandTwoFilter.selectOption(type);
      await expect(curve).not.toHaveAttribute("d", bellCurve!);
      await expect(bandTwoQ).toBeEnabled();
      await expect(bandTwoGain).toBeDisabled();
    }
    const addBand = equalizer.getByRole("button", { name: "Add band", exact: true });
    for (let index = 0; index < 5; index++) await addBand.click();
    await expect(addBand).toBeDisabled();
    await expect(response.getByRole("button")).toHaveCount(10);
    await expect(equalizer.getByRole("spinbutton", { name: "Band 10 Frequency (Hz)" })).toHaveValue("1000");
    await equalizer.getByRole("button", { name: "Remove band 10", exact: true }).click();
    await expect(addBand).toBeEnabled();
    await page.reload();
    await expect(response.getByRole("button")).toHaveCount(9);
    await equalizer.getByRole("button", { name: "Band 2", exact: true }).click();
    await expect(bandTwoFilter).toHaveValue("notch");
    const presetName = equalizer.getByRole("textbox", { name: "Preset name" });
    await presetName.fill("Headphones");
    await equalizer.getByRole("button", { name: "Save new" }).click();
    await presetName.fill("Studio headphones");
    await equalizer.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(equalizer.getByRole("combobox", { name: "Saved preset" })).toHaveValue("Studio headphones");
    await equalizer.getByRole("combobox", { name: "Factory preset" }).selectOption("Rock");
    await expect(response.getByRole("button")).toHaveCount(5);
    await page.reload();
    await equalizer.getByRole("combobox", { name: "Saved preset" }).selectOption("Studio headphones");
    await expect(response.getByRole("button")).toHaveCount(9);
    await equalizer.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(equalizer.getByRole("option", { name: "Studio headphones" })).toHaveCount(0);
    await mode.selectOption("graphic");
    await expect(bandCount).toHaveValue("10");
    await expect(equalizer.getByRole("combobox", { name: "Equalizer preset" })).toHaveValue("Bass Boost");
    await page.setViewportSize({ width: 390, height: 844 });
    const bassSlider = equalizer.getByRole("slider", { name: "31.25 Hz", exact: true });
    await expect(bassSlider).toHaveAttribute("aria-orientation", "vertical");
    expect(await bassSlider.evaluate(slider => slider.clientHeight > slider.clientWidth)).toBe(true);
    await bassSlider.press("ArrowUp");
    await expect(bassSlider).toHaveValue("6.5");
    await equalizer.getByRole("button", { name: "Reset EQ" }).click();
    await expect(bassSlider).toHaveValue("0");
    expect(await equalizer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await launch.click();
    await expect(controls).toBeVisible();
    expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(launch).toBeFocused();
    await bandCount.selectOption("custom");
    const addGraphicBand = equalizer.getByRole("button", { name: "Add band", exact: true });
    for (let index = 0; index < 5; index++) await addGraphicBand.click();
    await expect(addGraphicBand).toBeDisabled();
    const customFrequency = equalizer.getByRole("spinbutton", { name: "Graphic band 10 frequency (Hz)" });
    await customFrequency.fill("3200");
    await customFrequency.press("Enter");
    await equalizer.getByRole("slider", { name: "Graphic band 10 gain" }).press("ArrowUp");
    await page.reload();
    await expect(bandCount).toHaveValue("custom");
    await expect(customFrequency).toHaveValue("3200");
    await expect(equalizer.getByRole("slider", { name: "Graphic band 10 gain" })).toHaveValue("0.5");
    await equalizer.getByRole("button", { name: "Remove graphic band 10", exact: true }).click();
    await expect(addGraphicBand).toBeEnabled();
    await enableEq.uncheck();
    await expect(bandCount).toHaveCount(0);
    expect(await page.evaluate(() => window.__acceptance.engine!.getEqualizerAnalyser())).toBeNull();
    await page.reload();
    await expect(enableEq).not.toBeChecked();
    await enableEq.check();
    await expect(bandCount).toHaveValue("custom");
  });

  test("Scenario 16: Timed Lyrics Seeking and Reader", async ({ page, system }) => {
    const { app } = system;
    await page.route(/\/lyrics(?:\?|$)/, route => route.fulfill({ json: {
      isSynced: true, syncedLyrics: "[00:01.110] Fast one\n[00:01.220] Fast two\n[00:01.330] Fast three",
    } }));
    await login(page, app);
    const [track] = await allTracks(page, app);
    await page.evaluate(track => window.__acceptance.player.playQueue([{
      ...track, artist: track.artistName, album: track.albumName, duration: track.durationSeconds,
    }]), track);
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(0);
    await page.evaluate(() => {
      window.__acceptance.engine!.pause();
      window.__acceptance.player.setActiveSidebar("now-playing");
    });
    const lyrics = page.getByRole("region", { name: "Lyrics", exact: true });
    await expect(lyrics.getByLabel("Timing offset", { exact: true })).toHaveCount(0);
    await lyrics.getByRole("button", { name: "Fast two", exact: true }).click();
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.__acceptance.engine!.getPosition()) - 1.22)).toBeLessThan(0.015);
    await lyrics.getByRole("button", { name: "Full screen" }).click();
    const reader = page.getByRole("dialog", { name: track.title, exact: true });
    await expect(reader.getByRole("button", { name: "Fast two", exact: true })).toHaveAttribute("aria-current", "true");
    await expect.poll(() => reader.getByRole("button", { name: "Fast two", exact: true }).evaluate(line => {
      const viewport = line.closest(".lyrics-scroll")!.getBoundingClientRect();
      const bounds = line.getBoundingClientRect();
      return Math.abs((viewport.top + viewport.bottom - bounds.top - bounds.bottom) / 2);
    })).toBeLessThan(5);
    await page.keyboard.press("Escape");
    await expect(lyrics.getByRole("button", { name: "Full screen" })).toBeFocused();
    await page.evaluate(() => window.__acceptance.player.flushQueuePersistence());
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__acceptance?.player.currentSong));
    await page.evaluate(() => window.__acceptance.player.setActiveSidebar("now-playing"));
    await expect(lyrics.getByRole("button", { name: "Fast two", exact: true })).toBeVisible();
    await expect(lyrics.getByLabel("Timing offset", { exact: true })).toHaveCount(0);
  });

  test.describe("large library and queue", () => {
    test.use({ trackCount: 5000 });
    test("Scenario 7: Large Queue Stress Test", async ({ page, context, system }, info) => {
      const { app } = system;
      await login(page, app);
      await openTracks(page, app, 5000);
      expect(await page.locator('.track[role="row"]').count()).toBeLessThan(60);
      // The browser enumerates the real paged library and starts the full queue.
      await page.locator('.track[role="row"]').first().locator(".track-title-text").click();
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue.length), { timeout: 30_000 }).toBe(5000);
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(true);
      const original = await page.evaluate(() => ({ id: window.__acceptance.player.queue[4999].id, current: window.__acceptance.player.currentSong?.id }));
      await page.evaluate(() => window.__acceptance.player.moveQueueItem(4999, 1));
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue[1].id)).toBe(original.id);
      expect(await page.evaluate(() => window.__acceptance.player.currentSong?.id)).toBe(original.current);
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Performance.enable");
        const heap = async () => {
          await cdp.send("HeapProfiler.collectGarbage");
          const metrics = await cdp.send("Performance.getMetrics");
          const size = metrics.metrics.find(metric => metric.name === "JSHeapUsedSize")?.value;
          if (size === undefined) throw new Error("Chromium did not expose JSHeapUsedSize");
          return size;
        };
        const baseline = await heap();
        for (let i = 0; i < 40; i++) {
          await page.evaluate(() => window.__acceptance.player.moveQueueItem(4999, 1));
          await page.waitForFunction(() => window.__acceptance.player.queue.length === 5000);
        }
        const after = await heap();
        const benchmark = await page.evaluate(() => window.__acceptance.benchmarkQueue());
        await attachJson(info, "queue-performance", { baselineHeapBytes: baseline, finalHeapBytes: after, growthBytes: after - baseline, ...benchmark });
        expect(benchmark.count).toBe(5000);
        expect(benchmark.violations).toEqual([]);
        expect(benchmark.orderCorrect && benchmark.currentUnchanged).toBe(true);
        expect(Math.max(...benchmark.timings), "Every warmed reducer reorder must finish in <15 ms").toBeLessThan(15);
        expect(after - baseline, "Retained heap after 40 queue reorders").toBeLessThan(24 * 1024 * 1024);
        expect(await page.locator('.track[role="row"]').count()).toBeLessThan(60);
      } finally { await cdp.detach(); }
    });
  });

  test("Scenario 14: Large Queue Persistence, Named Queues & Device Handoff", async ({ browser, system }, info) => {
    const { app, directory } = system;
    let desktop = await launchLifecycleBrowser(directory);
    const other = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      let page = desktop.page; await page.setViewportSize({ width: 1280, height: 900 }); await login(page, app);
      const tracks = await allTracks(page, app);
      await page.evaluate(tracks => window.__acceptance.player.playQueue(Array.from({ length: 5000 }, (_, i) => {
        const track = tracks[i % tracks.length]; return { ...track, artist: track.artistName, album: track.albumName, duration: track.durationSeconds };
      }), 1234), tracks);
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue.length)).toBe(5000);
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(true);
      await page.evaluate(() => { window.__acceptance.engine!.seek(12.875); window.__acceptance.player.togglePlay(); });
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(false);
      await page.evaluate(async () => { await window.__acceptance.player.flushQueuePersistence(); await window.__acceptance.syncQueue(); });
      const expected = await page.evaluate(() => ({ ids: window.__acceptance.player.queue.map(track => track.id), index: window.__acceptance.player.queueIndex, position: window.__acceptance.player.currentTime }));
      expect(expected.index).toBe(1234); expect(expected.position).toBeCloseTo(12.875, 1);
      const benchmark = await page.evaluate(() => window.__acceptance.benchmarkHydration());
      const distinctBenchmark = await page.evaluate(() => window.__acceptance.benchmarkHydration(true));
      await attachJson(info, "queue-hydration-10000", { repeatedTracks: benchmark, distinctTracks: distinctBenchmark });
      expect(benchmark.count).toBe(10_000);
      expect(Math.max(...benchmark.runs.map(run => run.applyMs)), "Applying 10,000 decoded occurrences stays below 10 ms").toBeLessThan(10);
      expect(Math.max(...distinctBenchmark.runs.map(run => run.applyMs)), "Applying 10,000 distinct tracks stays below 10 ms").toBeLessThan(10);
      await desktop.close(); desktop = await launchLifecycleBrowser(directory);
      page = desktop.page; await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(`${app.url}/library/playlists`);
      await page.waitForFunction(() => window.__acceptance?.player.queue.length === 5000);
      expect(await page.evaluate(() => ({ ids: window.__acceptance.player.queue.map(track => track.id), index: window.__acceptance.player.queueIndex, position: window.__acceptance.player.currentTime }))).toEqual(expected);
      expect(await page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(false);
      await page.evaluate(() => window.__acceptance.player.setActiveSidebar("queue"));
      await page.getByText("Save & restore queues", { exact: true }).click();
      await page.getByLabel("Queue name", { exact: true }).fill("Late Night Chill Queue");
      await page.getByRole("button", { name: "Save named queue", exact: true }).click();
      await expect(page.getByText("Named queue saved.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Save Queue as Playlist", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open saved playlist" })).toBeVisible();
      const session = await api<{ sessions: { trackCount: number }[]; namedQueues: { id: string; trackCount: number }[] }>(page, app, "/api/v1/user/queue-session");
      expect(session.sessions[0].trackCount).toBe(5000); expect(session.namedQueues[0].trackCount).toBe(5000);
      const playlistId = (await page.getByRole("link", { name: "Open saved playlist" }).getAttribute("href"))!.split("/").pop()!;
      expect((app.db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?").get(playlistId) as { n: number }).n).toBe(5000);
      await page.getByRole("button", { name: "Load Late Night Chill Queue", exact: true }).click();
      await expect(page.getByText("Queue restored, ready to play.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /Show full queue/ }).click();
      expect(await page.locator('.queue-sidebar-track[role="listitem"]').count()).toBeLessThan(60);
      await page.screenshot({ path: info.outputPath("queue-manager-desktop.png") });
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await desktop.context.setOffline(true); await page.reload();
      await page.waitForFunction(() => window.__acceptance?.player.queue.length === 5000);
      expect(await page.evaluate(() => ({ index: window.__acceptance.player.queueIndex, position: window.__acceptance.player.currentTime, playing: window.__acceptance.player.isPlaying }))).toEqual({ index: expected.index, position: expected.position, playing: false });
      await desktop.context.setOffline(false); await page.reload();
      await page.waitForFunction(() => window.__acceptance?.player.queue.length === 5000);
      const mobile = await other.newPage(); await login(mobile, app);
      const prompt = mobile.getByRole("complementary", { name: "Resume queue on this device" });
      await expect(prompt.getByText("Resume playback queue from Desktop?", { exact: true })).toBeVisible();
      await mobile.screenshot({ path: info.outputPath("queue-resume-mobile.png") });
      await prompt.getByRole("button", { name: "Restore queue", exact: true }).click();
      await expect.poll(() => mobile.evaluate(() => window.__acceptance.player.queue.length)).toBe(5000);
      expect(await mobile.evaluate(() => ({ ids: window.__acceptance.player.queue.map(track => track.id), index: window.__acceptance.player.queueIndex, position: window.__acceptance.player.currentTime }))).toEqual(expected);
      expect(await mobile.evaluate(() => window.__acceptance.player.isPlaying)).toBe(false);
    } finally { await other.close(); await desktop.close(); }
  });

  test("Scenario 9: Playlist Folders, Trash & Undo/Redo", async ({ page, system }, info) => {
    const { app } = system;
    await login(page, app);
    const tracks = (await allTracks(page, app)).slice(0, 3);
    const created = await api<{ playlist: { id: string } }>(page, app, "/api/playlists", "POST", { name: "Daily Rotation" });
    const id = created.playlist.id;
    await api(page, app, `/api/v1/playlists/${id}/tracks/batch`, "POST", { action: "add", trackIds: tracks.map(track => track.id) });
    const entries = app.db.prepare("SELECT id FROM playlist_items WHERE playlist_id=? ORDER BY position").all(id) as { id: string }[];
    const dateEntry = app.db.prepare("UPDATE playlist_items SET created_at=? WHERE id=?");
    entries.forEach((entry, index) => dateEntry.run(`2026-01-0${index + 1}T12:00:00.000Z`, entry.id));
    await page.goto(`${app.url}/playlist/${id}`);
    await expect(page.getByRole("heading", { name: "Daily Rotation", exact: true })).toBeVisible();
    const grid = page.getByRole("grid", { name: "Playlist tracks" });
    await expect(grid.locator('.track[role="row"]')).toHaveCount(3);

    await test.step("The edit cover aligns with the name and description fields", async () => {
      await page.getByRole("button", { name: "Daily Rotation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit details" });
      const cover = dialog.getByRole("button", { name: "Choose playlist cover" });
      const artwork = await cover.boundingBox();
      const name = await dialog.getByRole("textbox", { name: "Name", exact: true }).boundingBox();
      const description = await dialog.getByRole("textbox", { name: "Description", exact: true }).boundingBox();
      expect(artwork!.width).toBeCloseTo(230);
      expect(artwork!.height).toBeCloseTo(artwork!.width);
      expect(artwork!.y).toBeCloseTo(name!.y);
      expect(artwork!.y + artwork!.height).toBeCloseTo(description!.y + description!.height);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    });

    await test.step("Sort by the actual playlist entry dates", async () => {
      const rows = grid.locator('.track[role="row"]');
      await grid.getByRole("button", { name: "Date added" }).click();
      await expect(grid.getByRole("columnheader", { name: "Date added" })).toHaveAttribute("aria-sort", "ascending");
      await expect(rows.first().locator("time")).toHaveAttribute("datetime", "2026-01-01T12:00:00.000Z");
      await grid.getByRole("button", { name: "Date added" }).click();
      await expect(grid.getByRole("columnheader", { name: "Date added" })).toHaveAttribute("aria-sort", "descending");
      await expect(rows.first().locator("time")).toHaveAttribute("datetime", "2026-01-03T12:00:00.000Z");
      await expect(rows.first().locator(".collector-editions").getByText("Navidrome", { exact: true })).toHaveCount(0);
      for (const name of ["Title", "Album", "Duration"]) {
        await grid.getByRole("button", { name, exact: true }).click();
        await expect(grid.getByRole("columnheader", { name, exact: true })).toHaveAttribute("aria-sort", "ascending");
        await grid.getByRole("button", { name, exact: true }).click();
        await expect(grid.getByRole("columnheader", { name, exact: true })).toHaveAttribute("aria-sort", "descending");
      }
      await page.getByRole("button", { name: "Sort tracks: Duration" }).click();
      await expect(page.getByRole("menuitemradio", { name: "Duration" })).toHaveText(/↓/);
      await page.keyboard.press("Escape");
      await grid.getByRole("button", { name: "Track number", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sort tracks: Custom order" })).toBeVisible();
      await expect(rows.first().locator("time")).toHaveAttribute("datetime", "2026-01-01T12:00:00.000Z");
    });

    await test.step("Inline search matches genres and track names without changing playlist contents", async () => {
      await expect(page.getByRole("searchbox", { name: "Search this playlist" })).toHaveCount(0);
      await page.getByRole("button", { name: "Search this playlist", exact: true }).click();
      await expect(page.getByRole("searchbox", { name: "Search this playlist" })).toBeFocused();
      await expect(page.locator(".playlist-track-search").getByRole("button", { name: "Close playlist search" })).toBeVisible();
      await page.getByRole("searchbox", { name: "Search this playlist" }).fill("ambient");
      await expect(grid.locator('.track[role="row"]')).toHaveCount(3);
      await page.getByRole("searchbox", { name: "Search this playlist" }).fill(tracks[1].title);
      await expect(grid.locator('.track[role="row"]')).toHaveCount(1);
      await expect(grid.locator(".track-title-text mark").first()).toBeVisible();
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(grid.locator('.track[role="row"]')).toHaveCount(3);
      await page.getByRole("searchbox", { name: "Search this playlist" }).press("Escape");
      await expect(page.getByRole("searchbox", { name: "Search this playlist" })).toHaveCount(0);
      await page.getByRole("button", { name: "Search this playlist", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search this playlist" }).fill(tracks[1].title);
      await page.getByRole("heading", { name: "Daily Rotation", exact: true }).locator("..").getByText("PLAYLIST", { exact: true }).click();
      await expect(page.getByRole("searchbox", { name: "Search this playlist" })).toHaveCount(0);
      await expect(grid.locator('.track[role="row"]')).toHaveCount(3);
    });
    await test.step("A removed occurrence can be undone, redone and undone again", async () => {
      const row = grid.getByRole("row", { name: `${tracks[0].title} by Acceptance Artist`, exact: true });
      await row.scrollIntoViewIfNeeded(); await row.hover();
      await row.getByRole("button", { name: `More options for ${tracks[0].title}` }).click();
      await page.getByRole("menuitem", { name: "Remove from Playlist", exact: true }).click();
      await expect(grid.locator('.track[role="row"]')).toHaveCount(2);
      await expect(page.getByRole("complementary", { name: "Playlist edit history" })).toHaveCount(0);
      await page.getByRole("button", { name: "More options", exact: true }).click();
      const history = page.getByRole("group", { name: "Playlist history" });
      await history.getByRole("menuitem", { name: "Undo", exact: true }).click();
      await expect(grid.locator('.track[role="row"]')).toHaveCount(3);
      await history.getByRole("menuitem", { name: "Redo", exact: true }).click();
      await expect(grid.locator('.track[role="row"]')).toHaveCount(2);
      await history.getByRole("menuitem", { name: "Undo", exact: true }).click();
      await expect(grid.locator('.track[role="row"]')).toHaveCount(3);
      await page.keyboard.press("Escape");
    });
    await test.step("Create nested folders and drag a playlist into the hierarchy", async () => {
      await page.getByRole("button", { name: "Playlist collection options" }).click();
      await page.getByRole("menuitem", { name: "Add folder", exact: true }).click();
      await page.getByRole("textbox", { name: "Folder name" }).fill("Listening room");
      await page.getByRole("button", { name: "Save folder", exact: true }).click();
      await expect(page.getByRole("button", { name: "Expand Listening room" })).toBeVisible();
      await page.getByRole("button", { name: "Expand Listening room", exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "New subfolder", exact: true }).click();
      await page.getByRole("textbox", { name: "Folder name" }).fill("Late nights");
      await page.getByRole("button", { name: "Save folder", exact: true }).click();
      const folder = page.getByRole("button", { name: "Expand Late nights", exact: true });
      await expect(folder).toBeVisible();
      const source = page.locator(`[data-tree-key="playlist:${id}"] > .folder-tree-row`);
      await source.dragTo(folder);
      await expect(page.getByRole("button", { name: "Collapse Late nights", exact: true })).toBeVisible();
      const tree = await api<{ folders: { id: string; name: string }[]; playlists: { id: string; folderId: string }[] }>(page, app, "/api/v1/playlist-organization");
      expect(tree.playlists.find(item => item.id === id)?.folderId).toBe(tree.folders.find(item => item.name === "Late nights")?.id);
    });
    await test.step("Trash retains entries and artwork, and recovery restores the saved folder", async () => {
      await page.getByRole("tree", { name: "Playlist folders" }).getByRole("link", { name: "Daily Rotation", exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
      await expect(page).toHaveURL(/\/library\/playlists$/);
      await expect(page.getByRole("link", { name: "Daily Rotation", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Playlist collection options" }).click();
      await page.getByRole("menuitem", { name: "Trash", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Playlist Trash" });
      await expect(dialog.getByRole("button", { name: "Restore Daily Rotation" })).toBeVisible();
      await dialog.getByRole("button", { name: "Restore Daily Rotation" }).click();
      await expect(dialog.getByText("Trash is empty.", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close Trash" }).click();
      await expect(page.locator(`[data-tree-key="playlist:${id}"] a`)).toBeVisible();
      const restored = await api<{ playlist: { tracks: Track[] } }>(page, app, `/api/playlists/${id}`);
      expect(restored.playlist.tracks.map(track => track.id)).toEqual(tracks.map(track => track.id));
      await page.screenshot({ path: info.outputPath("playlist-folders-and-undo.png") });
    });
  });

  test("Scenario 11: Private Listening & Taste Feedback Recovery", async ({ page, context, system }, info) => {
    const { app, nav } = system;
    app.db.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES('listening.thresholdSeconds','1',?) ON CONFLICT(key) DO UPDATE SET value='1'").run(new Date().toISOString());
    await login(page, app); const tracks = await allTracks(page, app), owner = (app.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
    await page.getByRole("button", { name: "Open Now Playing sidebar" }).click();
    const badge = page.getByRole("complementary", { name: "Now Playing", exact: true }).getByRole("switch", { name: "Private listening", exact: true });
    await expect(badge).toHaveAttribute("aria-checked", "false"); await badge.click();
    await expect.poll(async () => (await api<{ privateListening: boolean }>(page, app, "/api/v1/taste-profile/state")).privateListening).toBe(true);
    await page.evaluate(track => window.__acceptance.player.playQueue([{ ...track, artist: track.artistName, album: track.albumName, duration: track.durationSeconds }]), tracks[0]);
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(2);
    await expect.poll(() => (app.db.prepare("SELECT COUNT(*) AS n FROM listening_events WHERE user_id=? AND counted=1").get(owner) as { n: number }).n).toBeGreaterThan(0);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM taste_listening_events WHERE user_id=?").get(owner) as { n: number }).n).toBe(0);
    await page.evaluate(() => { if (window.__acceptance.player.isPlaying) window.__acceptance.player.togglePlay(); });
    const report = (id: string, track: Track, extra: Record<string, unknown> = {}) => api<{ counted: boolean; tasteExcluded: boolean; scrobbleDue: boolean }>(page, app, "/api/listening-events", "POST", {
      ownerUserId: owner, playbackSessionId: id, trackId: track.id, startedAt: new Date(Date.now() - 40_000).toISOString(), reportedAt: new Date().toISOString(), listenedSeconds: 35,
      durationSeconds: 180, finished: true, track: { title: track.title, artist: track.artistName, album: track.albumName }, ...extra,
    });
    const privateReport = await report("private-offline-report", tracks[0], { privateListening: true });
    expect(privateReport).toMatchObject({ counted: true, tasteExcluded: true, scrobbleDue: true });
    await expect.poll(() => nav.requests.some(request => request.path.includes("scrobble"))).toBe(true);
    const blockedAutoplay = await api<{ tracks: unknown[] }>(page, app, "/api/recommendations/autoplay", "POST", { seedId: tracks[0].id }); expect(blockedAutoplay.tracks).toEqual([]);

    await context.setOffline(true); await badge.click();
    await expect(badge).toHaveAttribute("aria-checked", "true"); await expect(badge).toContainText("Syncing");
    await context.setOffline(false); await expect(badge).toHaveAttribute("aria-checked", "false");
    const publicSessionStarted = Date.now();
    const created = await api<{ playlist: { id: string } }>(page, app, "/api/playlists", "POST", { name: "Party without the profile" });
    const playlistId = created.playlist.id; await api(page, app, `/api/v1/playlists/${playlistId}/tracks/batch`, "POST", { action: "add", trackIds: tracks.slice(0, 3).map(track => track.id) });
    await page.goto(`${app.url}/playlist/${playlistId}`); await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Exclude from taste profile" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Exclude from taste profile" })).toHaveAttribute("aria-checked", "true");
    expect((await report("excluded-playlist-report", tracks[1], { playlistId, privateListening: false })).tasteExcluded).toBe(true);
    const longArtistCredit = "AcceptanceArtist".repeat(8);
    await api(page, app, "/api/v1/taste-profile/track", "POST", { ownerId: owner, trackId: tracks[4].id, title: tracks[4].title, artist: longArtistCredit, excluded: true });
    await api(page, app, "/api/recommendations/feedback", "POST", { action: "block-artist", itemType: "artist", artist: "Distant Artist" });
    await api(page, app, "/api/recommendations/feedback", "POST", { action: "hide", itemType: "track", itemId: "external_deezer_track_hidden", title: tracks[2].title, artist: tracks[2].artistName });
    await api(page, app, "/api/recommendations/feedback", "POST", { action: "block-album", itemType: "album", itemId: "external_album_hidden", title: "Hidden Release", album: "Hidden Release", artist: "Other Artist" });
    await expect.poll(() => Date.now() - publicSessionStarted).toBeGreaterThan(1600);
    expect((await report("eligible-public-report", tracks[3], { privateListening: false, startedAt: new Date(publicSessionStarted).toISOString(), listenedSeconds: 1.5 })).tasteExcluded).toBe(false);
    app.db.prepare("INSERT OR IGNORE INTO favorites(user_id,track_id,created_at) VALUES(?,?,?)").run(owner, tracks[0].id, new Date().toISOString());
    await page.goto(`${app.url}/settings/taste`); await expect(page.getByRole("heading", { name: "Taste & feedback" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore Distant Artist", exact: true })).toBeVisible();
    const before = await api<{ hidden: unknown[]; eligibleListens: number; revision: number }>(page, app, "/api/v1/taste-profile"); expect(before.hidden).toHaveLength(3); expect(before.eligibleListens).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Restore Distant Artist", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore Distant Artist", exact: true })).toHaveCount(0);
    const candidates = await api<{ tracks: { id: string }[] }>(page, app, "/api/recommendations/autoplay", "POST", { seedId: tracks[0].id, limit: 50 });
    expect(candidates.tracks.some(track => track.id === tracks[2].id)).toBe(false);
    await page.locator("main").evaluate(element => element.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath("taste-profile-desktop.png"), animations: "disabled" });
    const tasteView = page.getByRole("region", { name: "Taste and feedback manager" });
    const horizontalOverflow = () => tasteView.evaluate(element => element.scrollWidth - element.clientWidth);
    await expect(tasteView.getByText(longArtistCredit, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // The shell switches to its mobile layout through a JS media query, so wait
    // for that re-render before measuring; otherwise a slow runner measures the
    // desktop shell squeezed into the narrow viewport.
    await expect(page.locator("html")).toHaveAttribute("data-layout-shell", "mobile");
    await expect(page.getByRole("switch", { name: "Private listening mode", exact: true })).toBeVisible();
    expect(await horizontalOverflow(), "Taste profile overflow at 390px").toBeLessThanOrEqual(0);
    await page.locator("main").evaluate(element => element.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath("taste-profile-mobile.png"), animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await horizontalOverflow(), "Taste profile overflow at 320px").toBeLessThanOrEqual(0);
    const historyCount = (app.db.prepare("SELECT COUNT(*) AS n FROM listening_events WHERE user_id=?").get(owner) as { n: number }).n;
    const favoritesCount = (app.db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=?").get(owner) as { n: number }).n;
    await page.getByRole("button", { name: "Reset listening influence", exact: true }).click();
    await expect(page.getByLabel("Confirm taste reset")).toBeVisible();
    expect(await horizontalOverflow(), "Taste reset form overflow at 320px").toBeLessThanOrEqual(0);
    await page.getByLabel("Confirm taste reset").fill("RESET");
    await page.getByRole("button", { name: "Confirm reset", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "Past listening influence has been reset" })).toBeVisible();
    const after = await api<{ eligibleListens: number; hidden: unknown[] }>(page, app, "/api/v1/taste-profile"); expect(after.eligibleListens).toBe(0); expect(after.hidden).toHaveLength(2);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM listening_events WHERE user_id=?").get(owner) as { n: number }).n).toBe(historyCount);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=?").get(owner) as { n: number }).n).toBe(favoritesCount);
    expect(app.db.prepare("SELECT id FROM playlists WHERE id=?").get(playlistId)).toBeTruthy();
    const otherAccount = await page.request.post(`${app.url}/api/v1/taste-profile/reset`, { data: { ownerId: "other-user", revision: 0, confirmation: "RESET" } }); expect(otherAccount.status()).toBe(409);
    expect(app.db.pragma("foreign_key_check")).toEqual([]);
  });

  test.describe("Similar mix journey", () => {
  test.use({ externalMetadata: true });
  test("Scenario 10: Multi-Seed Similar Mix Builder", async ({ page, system }, info) => {
    const { app } = system;
    await login(page, app);
    const tracks = await allTracks(page, app), seed = tracks[0], now = Date.now();
    const recordingKey = (title: string, artist: string) => JSON.stringify([normalizeMusicText(artist), normalizeMusicText(title), versionSignature(title)]);
    const discoveries = Array.from({ length: 50 }, (_, index) => {
      const title = `Distant Signal ${index}`, artist = `Discovery Artist ${index}`;
      return { id: `external_lastfm_track_${createHash("sha256").update(recordingKey(title, artist)).digest("hex").slice(0, 32)}`, title, artist, match: 0.85 - index / 120 };
    });
    const neighbors = [...tracks.slice(1, 50).map((track, index) => ({ id: `cached-${index}`, title: track.title, artist: track.artistName, match: 0.99 - index / 100 })), ...discoveries];
    app.db.transaction(() => {
      app.db.prepare("INSERT INTO similar_mix_vectors(seed_key,payload_json,expires_at,touched_at) VALUES(?,?,?,?)")
        .run(recordingKey(seed.title, seed.artistName), JSON.stringify(neighbors), now + 86_400_000, now);
      const insert = app.db.prepare("INSERT INTO similar_mix_external_tracks(id,title,artist,touched_at,preview_checked_at) VALUES(?,?,?,?,?)");
      discoveries.forEach(track => insert.run(track.id, track.title, track.artist, now, now));
    })();
    const owner = (app.db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
    await expect(page.getByRole("button", { name: /Build a similar-song mix/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Filter playlists" }).click();
    await page.getByRole("menuitemradio", { name: "Regular playlists" }).click();
    await page.getByRole("button", { name: "Search playlists", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search playlists", exact: true }).fill("unmatched playlist");
    await expect(page.getByText("No playlists match these filters.")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search playlists", exact: true }).press("Escape");
    await page.getByRole("button", { name: "Add playlist", exact: true }).click();
    await page.getByRole("button", { name: /Make a mix/ }).click();
    await page.getByRole("button", { name: "Advanced mix", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Follow the sound." });
    await dialog.getByRole("searchbox").fill(seed.title);
    await dialog.getByRole("button", { name: new RegExp(seed.title) }).click();
    const build = async (label: string) => {
      const pending = page.waitForResponse(response => response.url().endsWith("/api/v1/similar-mixes/preview") && response.request().method() === "POST");
      await dialog.getByRole("button", { name: label, exact: true }).click();
      const response = await pending; expect(response.ok()).toBe(true);
      return response.json() as Promise<{ previewId: string; tracks: { id: string; title: string; artist: string; inLibrary: boolean }[] }>;
    };
    let result = await build("Build my mix");
    await expect(dialog.locator(".mix-candidates li")).toHaveCount(25);
    expect(result.tracks.some(track => track.inLibrary)).toBe(true); expect(result.tracks.some(track => !track.inLibrary)).toBe(true);
    expect(result.tracks.filter(track => !track.inLibrary)).toHaveLength(10);
    const localPreview = result.tracks.find(track => track.inLibrary)!;
    await dialog.getByRole("button", { name: `Preview ${localPreview.title}`, exact: true }).click();
    await expect.poll(() => dialog.locator("audio").evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0.1);
    await dialog.locator("audio").evaluate(element => (element as HTMLAudioElement).pause());
    const first = result.tracks[0]; await dialog.getByRole("button", { name: `Lock ${first.title}`, exact: true }).click();
    result = await build("Refresh mix");
    await expect(dialog.locator(".mix-candidates li").first()).toContainText(first.title);
    const beforeSwap = await dialog.locator(".mix-track-copy strong").allTextContents(), swapTitle = beforeSwap[1];
    result = await build(`Swap ${swapTitle}`);
    await expect.poll(async () => (await dialog.locator(".mix-track-copy strong").allTextContents())[1]).not.toBe(swapTitle);
    const afterSwap = await dialog.locator(".mix-track-copy strong").allTextContents();
    expect(afterSwap.filter((_, index) => index !== 1)).toEqual(beforeSwap.filter((_, index) => index !== 1));
    await dialog.getByLabel("Playlist name").fill("Signals across the library");
    await dialog.getByRole("button", { name: "Save as playlist", exact: true }).click();
    const saved = dialog.getByRole("link", { name: /Open saved playlist/ }); await expect(saved).toBeVisible();
    const playlistId = (await saved.getAttribute("href"))!.split("/").at(-1)!;
    const saveAgain = await api<{ playlist: { id: string }; alreadySaved: boolean }>(page, app, "/api/v1/similar-mixes/save", "POST", {
      ownerId: owner, previewId: result.previewId, trackIds: result.tracks.map(track => track.id), name: "Signals across the library",
    });
    expect(saveAgain.playlist.id).toBe(playlistId); expect(saveAgain.alreadySaved).toBe(true);
    const stored = await api<{ playlist: { tracks: Track[] } }>(page, app, `/api/playlists/${playlistId}`);
    expect(stored.playlist.tracks).toHaveLength(25); expect(stored.playlist.tracks.filter(track => track.external).length).toBeGreaterThan(0);
    expect(stored.playlist.tracks.filter(track => track.external).every(track => track.streamUrl === "" && track.source?.kind === "external")).toBe(true);
    const initialQueue = await page.evaluate(() => window.__acceptance.player.queue.length);
    await dialog.getByRole("button", { name: "Add to queue", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue.length)).toBe(initialQueue + 25);
    await expect(dialog.getByText(/songs added to your queue/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("similar-mix-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Add to queue", exact: true }).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("similar-mix-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    // New negative feedback is enforced before queueing, even with an existing preview token.
    const hidden = result.tracks.find(track => !track.inLibrary && track.id !== first.id)!;
    await api(page, app, "/api/recommendations/feedback", "POST", { action: "block-artist", itemType: "artist", itemId: "other-provider-artist", artist: hidden.artist });
    await dialog.getByRole("button", { name: "Add to queue", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("hidden");
    expect(await page.evaluate(() => window.__acceptance.player.queue.length)).toBe(initialQueue + 25);
    const badActor = await page.request.post(`${app.url}/api/v1/similar-mixes/selection`, { data: { ownerId: "wrong-account", previewId: result.previewId, trackIds: [result.tracks[0].id] } });
    expect(badActor.status()).toBe(409);

    // Removing/undoing an external occurrence restores its metadata, not an invalid provider ID.
    const items = app.db.prepare("SELECT id FROM playlist_items WHERE playlist_id=? AND external_track_json IS NOT NULL ORDER BY position LIMIT 1").get(playlistId) as { id: string };
    const editState = await api<{ revision: number }>(page, app, `/api/v1/playlists/${playlistId}/edit-state`);
    const removed = await api<{ command: { id: string }; revision: number }>(page, app, `/api/v1/playlists/${playlistId}/commands`, "POST", { ownerId: owner, revision: editState.revision, edit: { kind: "remove", itemIds: [items.id] } });
    await api(page, app, `/api/v1/playlist-commands/${removed.command.id}/undo`, "POST", { ownerId: owner, revision: removed.revision });
    expect((await api<{ playlist: { tracks: Track[] } }>(page, app, `/api/playlists/${playlistId}`)).playlist.tracks.map(track => track.id)).toEqual(stored.playlist.tracks.map(track => track.id));
    await dialog.getByRole("button", { name: "Close mix builder" }).click();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  });
  });

  test.describe("Followed artist release feed", () => {
    test.use({ externalMetadata: true, releaseMetadata: true });
    test("Scenario 12: Explicit Artist Follows & Cached Release Feed", async ({ page, system }, info) => {
      const { app } = system;
      await login(page, app);
      const initial = await api<{ artists: unknown[]; releases: unknown[] }>(page, app, "/api/v1/new-releases");
      expect(initial.artists).toEqual([]); expect(initial.releases).toEqual([]);
      await page.goto(`${app.url}/artist/external_itunes_artist_99`);
      const follow = page.getByRole("button", { name: "Follow artist", exact: true });
      await expect(follow).toBeEnabled(); await follow.click();
      await expect(page.getByRole("button", { name: "Following", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await api<{ releases: unknown[] }>(page, app, "/api/v1/new-releases")).releases.length).toBe(3);
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM acquisition_jobs").get()).toEqual({ n: 0 });
      const checked = app.db.prepare("SELECT checked_at,next_scan_at FROM followed_artist_catalog").get();
      await page.goto(`${app.url}/admin/activity`);
      await page.getByRole("button", { name: "Check releases", exact: true }).click();
      await expect(page.getByText("Release check queued.", { exact: true })).toBeVisible();
      await page.goto(`${app.url}/new-releases`);
      await expect(page.getByRole("heading", { name: "New Releases from Artists You Follow", exact: true })).toBeVisible();
      const card = page.getByRole("article", { name: "Night Drive by Release Artist" });
      await expect(card).toBeVisible(); await expect(page.locator(".release-card")).toHaveCount(3);
      expect(app.db.prepare("SELECT checked_at,next_scan_at FROM followed_artist_catalog").get()).toEqual(checked);
      await card.getByRole("button", { name: "Preview tracks", exact: true }).click();
      await expect(card.getByRole("button", { name: /Release Preview 1/ })).toBeVisible();
      await card.getByRole("button", { name: "Save to wishlist", exact: true }).click();
      await expect(card.getByRole("button", { name: "In wishlist", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(app.db.prepare("SELECT provider,external_id,title FROM saved_discoveries").all()).toEqual([{ provider: "itunes", external_id: "901", title: "Night Drive" }]);
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM acquisition_jobs").get()).toEqual({ n: 0 });
      // Verify delegation to the existing import API; scenario 5 exercises the worker pipeline.
      let imports = 0;
      await page.route("**/api/acquisitions", async route => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        imports++;
        expect(route.request().postDataJSON()).toMatchObject({ sourceProvider: "spotdl", albumId: "external_itunes_album_901",
          result: { type: "album", artist: "Release Artist", title: "Night Drive" } });
        await route.fulfill({ status: 202, json: { jobId: "release-import", status: "queued" } });
      });
      await card.getByRole("button", { name: "Import via spotDL", exact: true }).click();
      await expect(card.getByRole("button", { name: "Import queued", exact: true })).toBeDisabled(); expect(imports).toBe(1);
      await page.locator("main").first().evaluate(element => element.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath("new-releases-desktop.png"), animations: "disabled" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("main").first().evaluate(element => element.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("new-releases-mobile.png"), animations: "disabled" });
      const following = page.locator(".release-following"); await following.locator("summary").click();
      await following.getByRole("button", { name: "Unfollow Release Artist" }).click();
      await expect(page.getByText("Your next favorite starts with a follow")).toBeVisible();
      expect((await api<{ artists: unknown[] }>(page, app, "/api/v1/artist-follows")).artists).toEqual([]);
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM saved_discoveries").get()).toEqual({ n: 1 });
      expect(app.db.pragma("foreign_key_check")).toEqual([]);
    });
  });

  test("Scenario 13: Household Playlist Collaboration & Party Requests", async ({ page, browser, system }, info) => {
    const { app } = system;
    await login(page, app); const tracks = await allTracks(page, app);
    const editor = (await api<{ user: { id: string } }>(page, app, "/api/users", "POST", { username: "household-editor", password: "editor-password", displayName: "Household Editor", role: "user" })).user;
    const viewer = (await api<{ user: { id: string } }>(page, app, "/api/users", "POST", { username: "household-viewer", password: "viewer-password", displayName: "Household Viewer", role: "user" })).user;
    const created = await api<{ playlist: { id: string } }>(page, app, "/api/playlists", "POST", { name: "Kitchen sessions" }); const id = created.playlist.id;
    await api(page, app, `/api/playlists/${id}/tracks`, "POST", { trackId: tracks[0].id });
    await page.goto(`${app.url}/playlist/${id}`);
    await page.getByRole("button", { name: "Share playlist", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share Kitchen sessions" });
    await dialog.getByRole("radio", { name: /^Collaborative/ }).check();
    const choices = dialog.locator(".playlist-share-user-results");
    await choices.getByRole("button").filter({ hasText: "Household Editor" }).click();
    await dialog.getByRole("combobox", { name: "Role for Household Editor" }).selectOption("COLLABORATOR");
    await choices.getByRole("button").filter({ hasText: "Household Viewer" }).click();
    await dialog.getByRole("button", { name: "Save sharing", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Sharing updated");
    await dialog.getByRole("combobox", { name: "Invitation recipient" }).selectOption(viewer.id);
    await dialog.getByRole("button", { name: "Create invitation", exact: true }).click();
    const invitation = await dialog.getByRole("textbox", { name: "Invitation link" }).inputValue(); expect(invitation).toContain("/playlist-share#token=");
    await dialog.evaluate(el => el.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath("playlist-sharing-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible(); expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.evaluate(el => el.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath("playlist-sharing-mobile.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Close playlist sharing" }).click(); await page.setViewportSize({ width: 1280, height: 900 });
    const editorContext = await browser.newContext(), viewerContext = await browser.newContext();
    try {
      const editorPage = await editorContext.newPage(), viewerPage = await viewerContext.newPage();
      await viewerPage.goto(invitation); await viewerPage.getByPlaceholder("Username").fill("household-viewer");
      await viewerPage.getByPlaceholder("Password").fill("viewer-password"); await viewerPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(viewerPage).toHaveURL(new RegExp(`/playlist/${id}$`));
      await expect(viewerPage.getByRole("heading", { name: "Kitchen sessions", exact: true })).toBeVisible();
      expect(await viewerPage.getByRole("button", { name: "Share playlist", exact: true }).count()).toBe(0);
      const denied = await viewerPage.request.put(`${app.url}/api/v1/playlists/${id}/tracks`, { data: { ownerId: viewer.id, revision: 0, edit: { kind: "add", trackIds: [tracks[1].id] } } });
      expect(denied.status()).toBe(403);
      await editorPage.request.post(`${app.url}/api/auth/login`, { data: { username: "household-editor", password: "editor-password" } });
      const editState = await api<{ revision: number }>(editorPage, app, `/api/v1/playlists/${id}/edit-state`);
      await api(editorPage, app, `/api/v1/playlists/${id}/tracks`, "PUT", { ownerId: editor.id, revision: editState.revision, edit: { kind: "add", trackIds: [tracks[1].id] } });
      await editorPage.goto(`${app.url}/playlist/${id}`);
      await expect(editorPage.getByLabel("Added by Household Editor", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Added by Household Editor", { exact: true })).toBeVisible();
      await page.locator(".playlist-play").click();
      const hostPanel = page.locator(".playlist-party-panel"); await hostPanel.locator("summary").click();
      await hostPanel.getByRole("button", { name: "Open party requests on this player", exact: true }).click();
      await expect(hostPanel.getByRole("button", { name: "Close party requests", exact: true })).toBeVisible();
      const editorPanel = editorPage.locator(".playlist-party-panel"); await editorPanel.locator("summary").click();
      await expect(editorPanel.getByRole("button", { name: "Request selected tracks (0)", exact: true })).toBeVisible();
      const addedTrack = editorPage.locator('.track[role="row"]').filter({ has: editorPage.getByLabel("Added by Household Editor", { exact: true }) });
      await addedTrack.locator(".track-title-text").click({ modifiers: ["Control"] });
      await editorPanel.getByRole("button", { name: "Request selected tracks (1)", exact: true }).click();
      await expect(editorPanel.getByRole("status")).toContainText("Selected tracks sent");
      await expect(hostPanel.getByRole("button", { name: "Add to queue", exact: true })).toBeVisible();
      const before = await page.evaluate(() => window.__acceptance.player.queue.length);
      await hostPanel.getByRole("button", { name: "Add to queue", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue.length)).toBe(before + 1);
      await expect(hostPanel.getByRole("button", { name: "Add to queue", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Share playlist", exact: true }).click();
      await dialog.getByRole("button", { name: "Remove Household Editor", exact: true }).click();
      await dialog.getByRole("button", { name: "Save sharing", exact: true }).click(); await expect(dialog.getByRole("status")).toContainText("Sharing updated");
      expect((await editorPage.request.post(`${app.url}/api/v1/playlists/${id}/party/requests`, { data: { ownerId: editor.id, trackId: tracks[0].id, idempotencyKey: "47cb0b86-a590-49ed-94fa-95bf42b50011" } })).status()).toBe(403);
      expect((await editorPage.request.get(`${app.url}/api/playlists/${id}`)).status()).toBe(404);
      expect((await viewerPage.request.get(`${app.url}/api/playlists/${id}`)).status()).toBe(200);
      const token = new URL(invitation).hash.slice("#token=".length);
      expect((await viewerPage.request.post(`${app.url}/api/v1/playlist-shares/resolve`, { data: { token } })).status()).toBe(403);
      expect(app.db.prepare("SELECT added_by_user_id FROM playlist_items WHERE playlist_id=? AND library_track_id=?").get(id, tracks[1].id)).toEqual({ added_by_user_id: editor.id });
      expect(app.db.pragma("foreign_key_check")).toEqual([]);
    } finally { await editorContext.close(); await viewerContext.close(); }
  });

  test("Scenario 8: Mobile Gesture & Background Playback", async ({ system }, info) => {
    const { app } = system;
    const lifecycle = await launchLifecycleBrowser(system.directory);
    const { context, page } = lifecycle;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await login(page, app); await openTracks(page, app, 80);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
      const tap = async (target: Locator) => {
        await expect(target).toBeVisible();
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        if (!bounds) throw new Error("The touch target has no viewport bounds");
        await touch("touchStart", bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await touch("touchEnd");
      };
      try {
        const title = page.locator('.track[role="row"] .track-title-text').first();
        await title.scrollIntoViewIfNeeded();
        const bounds = await title.boundingBox();
        if (!bounds) throw new Error("The first mobile track title has no visible bounds");
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
        await touch("touchStart", x, y);
        // Wait for the long-press to actually enter selection mode (the 500ms hold
        // timer can fire late on a loaded CI runner), keeping the touch held until
        // the gesture is recognized rather than releasing after a fixed duration.
        await expect(page.getByRole("checkbox", { name: /^Select / }).first()).toBeChecked();
        // Engaging selection mode must not reflow the list under the held finger:
        // if it did, the release would land on whatever moved into place (on a
        // narrow viewport, the selection controls), not on the pressed row.
        const held = await title.boundingBox();
        expect(held, "The held title keeps its on-screen position").toBeTruthy();
        expect(Math.abs((held!.y + held!.height / 2) - y), "Vertical shift of the held row while entering selection mode").toBeLessThan(4);
        expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('.track[role="row"]')?.getAttribute("aria-rowindex") ?? null, [x, y])).toBe("2");
        await touch("touchEnd");
        expect(await page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(false);
        // Entering selection mode must not shift the list under the held finger, so
        // releasing keeps the long-pressed row selected and selection mode active.
        const rows = page.locator('.track[role="row"]');
        await expect(rows.first()).toHaveAttribute("aria-selected", "true");
        const secondRow = rows.nth(1);
        await expect(secondRow).toHaveClass(/track-selection-mode/);
        await tap(secondRow);
        await expect(secondRow).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('.track[role="row"][aria-selected="true"]')).toHaveCount(2);
        await tap(page.getByRole("button", { name: "Actions for selected tracks" }));
        await tap(page.getByRole("menuitem", { name: /^Play Next/ }));
        await expect.poll(() => page.evaluate(() => window.__acceptance.player.queue.length)).toBe(2);
        await tap(page.getByRole("button", { name: /Cancel selection|Exit selection|Clear selection/i }).first());
        // A pan exceeding the movement threshold scrolls instead of selecting.
        await touch("touchStart", 200, 640);
        for (let i = 1; i <= 8; i++) { await touch("touchMove", 200, 640 - i * 40); await page.waitForTimeout(20); }
        await touch("touchEnd");
        await expect.poll(() => page.evaluate(() => Math.max(document.scrollingElement?.scrollTop ?? 0, ...Array.from(document.querySelectorAll<HTMLElement>("*")).map(el => el.scrollTop)))).toBeGreaterThan(100);
        expect(await page.getByRole("checkbox", { name: /^Select / }).count()).toBe(0);
        // Let native kinetic scrolling settle; tapping during a fling stops it.
        await page.evaluate(() => new Promise<void>((resolve, reject) => {
          const scroller = document.querySelector<HTMLElement>("main.main");
          if (!scroller) { reject(new Error("The app scroll container is missing")); return; }
          let previous = scroller.scrollTop, stable = 0;
          const deadline = performance.now() + 5000;
          const check = () => {
            const position = scroller.scrollTop;
            stable = Math.abs(position - previous) < 0.5 ? stable + 1 : 0;
            previous = position;
            if (stable >= 8) resolve();
            else if (performance.now() > deadline) reject(new Error("Touch scrolling did not settle"));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }));
        const scrollBefore = await page.evaluate(() => ({ window: window.scrollY, containers: [...document.querySelectorAll<HTMLElement>(".app-main,.main-content,main")].map(el => el.scrollTop) }));
        const links = page.locator('.track[role="row"] a.track-artist-link');
        const visibleLink = await links.evaluateAll(elements => elements.findIndex(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.top > 160 && bounds.bottom < Math.min(550, innerHeight - 160);
        }));
        expect(visibleLink, "An inline artist link is inside the mobile viewport").toBeGreaterThanOrEqual(0);
        const link = links.nth(visibleLink);
        await tap(link);
        await expect(page).toHaveURL(/\/artist\//);
        expect(await page.evaluate(() => window.__acceptance.player.queue.length)).toBe(2);
        await page.goBack();
        await expect(page.getByRole("table", { name: "Tracks", exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => ({ window: window.scrollY, containers: [...document.querySelectorAll<HTMLElement>(".app-main,.main-content,main")].map(el => el.scrollTop) }))).toEqual(scrollBefore);
        const titles = page.locator('.track[role="row"] .track-title-text');
        const visibleTitle = await titles.evaluateAll(elements => elements.findIndex(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.top > 160 && bounds.bottom < Math.min(550, innerHeight - 160);
        }));
        expect(visibleTitle).toBeGreaterThanOrEqual(0);
        await tap(titles.nth(visibleTitle));
        await expect.poll(() => page.evaluate(() => window.__acceptance.player.isPlaying)).toBe(true);
        const before = await page.evaluate(() => window.__acceptance.player.currentTime);
        // Browser tab backgrounding exercises visibility/media-session integration;
        // it cannot certify iOS/Android OS process suspension or lock-screen hardware.
        const foreground = await context.newPage();
        await foreground.goto("about:blank");
        // This browser never installed Playwright's forced-focus override,
        // so switching tabs must produce a real hidden-document state.
        await foreground.bringToFront();
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
        await expect.poll(() => page.evaluate(() => window.__acceptance.player.currentTime)).toBeGreaterThan(before + 0.5);
        expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("playing");
        expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBeTruthy();
        await attachJson(info, "background-media-session", await page.evaluate(() => ({ visibility: document.visibilityState, playbackState: navigator.mediaSession.playbackState, title: navigator.mediaSession.metadata?.title, position: window.__acceptance.player.currentTime })));
        await foreground.close(); await page.bringToFront();
        await page.screenshot({ path: info.outputPath("mobile-selection-390.png") });
      } catch (error) {
        const screenshot = info.outputPath("mobile-failure.png");
        try {
          await page.screenshot({ path: screenshot, timeout: 5000 });
          await info.attach("mobile-failure", { path: screenshot, contentType: "image/png" });
        } catch { /* Preserve the original failure if the browser already exited. */ }
        throw error;
      } finally { await cdp.detach(); }
    } finally { await lifecycle.close(); }
  });
});
