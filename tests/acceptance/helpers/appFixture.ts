import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import type { FastifyInstance } from "../../../server/node_modules/fastify/fastify.js";
import { loadConfig, type AppConfig } from "../../../server/src/config.js";
import { openDatabase, type Db } from "../../../server/src/db/database.js";
import { createProviderRegistry } from "../../../server/src/backends/factory.js";
import { withLocalUserDataSync } from "../../../server/src/backends/local-user-data-sync.js";
import { buildServer } from "../../../server/src/server.js";
import { LibraryService } from "../../../server/src/domain/library.js";
import { CatalogService } from "../../../server/src/domain/catalog.js";
import { PlaylistService } from "../../../server/src/domain/playlist-service.js";
import { SourceResolver } from "../../../server/src/domain/source-resolver.js";
import { SearchProviderRegistry } from "../../../server/src/domain/search-provider-registry.js";
import { SourceProviderRegistry } from "../../../server/src/domain/source-provider-registry.js";
import { SourcePipelineRegistry } from "../../../server/src/domain/source-discovery.js";
import { ExternalCatalogRegistry } from "../../../server/src/domain/external-catalog.js";
import { RecommendationRegistry, RecommendationService } from "../../../server/src/domain/recommendations.js";
import { LibraryInsightsService } from "../../../server/src/domain/library-insights.js";
import { AcquisitionProviderRegistry, AcquisitionService } from "../../../server/src/domain/acquisition.js";
import { PluginRegistry } from "../../../server/src/plugins/plugin-registry.js";
import { createPrivacyManager, setRuntimePrivacyManager } from "../../../server/src/services/PrivacyManager.js";
import { SpotifyPlaylistImportService } from "../../../server/src/domain/spotify-playlist-import.js";
import type { DownloaderAdapter } from "../../../server/src/domain/downloader-adapter.js";
import { SqliteImportJobRepository } from "../../../server/src/infrastructure/persistence/sqliteImportJobRepository.js";
import type { MockBackend } from "./mockBackends.js";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(path.join(root, "server/package.json"));
const esbuild: typeof import("../../../server/node_modules/esbuild/lib/main.js") = require("esbuild");

/** Build current source, never a possibly stale webapp/build directory. */
export async function buildAcceptanceBrowser(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(root, "tests/acceptance/helpers/browserProbe.tsx");
  await esbuild.build({
    entryPoints: [path.join(root, "webapp/src/index.js")],
    outfile: path.join(directory, "app.js"), bundle: true, platform: "browser",
    jsx: "automatic", loader: { ".js": "jsx", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".woff2": "dataurl" },
    nodePaths: [path.join(root, "webapp/node_modules")],
    define: { "process.env.NODE_ENV": '"production"', "process.env.PUBLIC_URL": '""', "process.env": "{}" },
    plugins: [{ name: "acceptance-observation", setup(build) {
      build.onLoad({ filter: /[\\/]App\.js$/ }, async args => ({ loader: "jsx", resolveDir: path.dirname(args.path),
        contents: `import { AcceptanceProbeComponent } from ${JSON.stringify(probe)};\n` +
          (await fs.readFile(args.path, "utf8")).replace("<AppContent />", "<AcceptanceProbeComponent /><AppContent />") }));
      build.onLoad({ filter: /[\\/]PlayerContext\.tsx$/ }, async args => ({ loader: "tsx", resolveDir: path.dirname(args.path),
        contents: (await fs.readFile(args.path, "utf8")).replace("engineRef.current = engine;", "engineRef.current = engine; if (window.__acceptance) window.__acceptance.engine = engine;") }));
    } }],
  });
  await esbuild.build({ entryPoints: [path.join(root, "webapp/src/service-worker.ts")], outfile: path.join(directory, "service-worker.js"), bundle: true, platform: "browser", define: { "process.env.PUBLIC_URL": '""', "self.__WB_MANIFEST": JSON.stringify(["index.html", "app.js", "app.css"].map(url => ({ url, revision: "acceptance" }))) } });
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MusicDeck Acceptance</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script defer src="/app.js"></script></body></html>');
  await fs.writeFile(path.join(directory, "asset-manifest.json"), JSON.stringify({ files: { main: "/app.js", css: "/app.css" }, entrypoints: ["app.js", "app.css"] }));
}

export function fixtureConfig(directory: string, nav: MockBackend, jelly: MockBackend, overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig({
    databasePath: path.join(directory, "data/musicdeck.sqlite"), musicRoot: path.join(directory, "music"),
    acquisitionTmpDir: path.join(directory, "staging"), extensionsDir: path.join(directory, "extensions"),
    sessionSecret: "acceptance-session-secret-at-least-32-characters", firstAdmin: { username: "admin", password: "acceptance-admin-password" },
    host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1", corsOrigin: "http://127.0.0.1",
    backend: "navidrome", navidrome: { url: nav.url, username: nav.credentials.username, password: nav.credentials.password },
    jellyfin: { url: jelly.url, apiKey: jelly.credentials.apiKey }, localOnlyMode: true,
    isProduction: false, secureCookies: false, trustedProxies: [], ...overrides,
  });
}

export async function startApplication(config: AppConfig, browserDirectory: string, options: { dual?: boolean; downloader?: DownloaderAdapter; metadataFetch?: typeof fetch } = {}) {
  let app: FastifyInstance | undefined;
  let db: Db | undefined;
  // Refuse all non-loopback outbound traffic, including accidental metadata calls.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`Acceptance blocked non-loopback network: ${url.origin}`));
    return nativeFetch(input, init);
  }) as typeof fetch;
  const shutdown = async () => {
    try {
      if (app) {
        const closing = app.close();
        app.server.closeAllConnections();
        await closing;
      }
    } finally {
      if (db?.open) db.close();
      globalThis.fetch = nativeFetch;
    }
  };
  try {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate an application port");
    config.port = address.port;
    config.publicUrl = config.corsOrigin = `http://127.0.0.1:${config.port}`;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    db = await openDatabase(config);
    // File-backed WAL is representative of a live SQLite deployment. NORMAL
    // keeps thousands of fixture catalog writes from measuring host fsync speed.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    // Exercise factory loading of durable connection records, including native-ID collisions.
    db.prepare("UPDATE backend_connections SET enabled=0").run();
    const insert = db.prepare("INSERT OR REPLACE INTO backend_connections(id,type,name,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)");
    insert.run("acceptance-nav", "navidrome", "Acceptance Navidrome", JSON.stringify({ url: config.navidrome.url }), "2024-01-01", "2024-01-01");
    if (options.dual) insert.run("acceptance-jelly", "jellyfin", "Acceptance Jellyfin", JSON.stringify({ url: config.jellyfin.url }), "2024-01-02", "2024-01-02");
    const privacy = createPrivacyManager(db, config);
    setRuntimePrivacyManager(privacy);
    const registry = createProviderRegistry(db, config);
    const backend = withLocalUserDataSync(registry.getPrimary().provider);
    const library = new LibraryService(db, { musicRoot: config.musicRoot });
    const catalog = new CatalogService(registry, library);
    const sourceResolver = new SourceResolver(registry, library);
    const playlists = new PlaylistService(db, backend, catalog, library, sourceResolver);
    const externalCatalog = new ExternalCatalogRegistry(options.metadataFetch, db);
    const searchProviders = new SearchProviderRegistry(db, catalog, playlists, undefined, externalCatalog.artwork);
    const sourcePipeline = new SourcePipelineRegistry(db);
    const sourceProviders = new SourceProviderRegistry(db, library, registry, sourceResolver, undefined, sourcePipeline);
    const recommendations = new RecommendationRegistry(new RecommendationService(db, catalog));
    const libraryInsights = new LibraryInsightsService(db, catalog);
    const acquisitionProviders = new AcquisitionProviderRegistry();
    const plugins = new PluginRegistry(db, { catalog, libraryInsights, sources: sourceProviders, sourcePipeline,
      acquisition: acquisitionProviders, recommendations,
      playlists: { create: async (name, userId) => playlists.create(name, { id: userId, role: "user" } as never), addTrack: (id, track) => playlists.addTrack(id, track) } });
    const acquisition = new AcquisitionService(db, acquisitionProviders, library, catalog, plugins, {
      musicRoot: config.musicRoot, tmpDir: config.acquisitionTmpDir, limits: config.acquisitionLimits,
      maxConcurrentDownloads: 1, autoScan: true, sourcePipeline,
    });
    const importRepository = new SqliteImportJobRepository(db);
    const importer = options.downloader ? new SpotifyPlaylistImportService(backend, playlists, options.downloader, config.musicRoot,
      async () => new Response(JSON.stringify({ title: "Acceptance import" }), { headers: { "content-type": "application/json" } }),
      config.spotifyImportSubdir, undefined, importRepository) : undefined;
    app = await buildServer({ config, db, privacy, backend, catalog, playlists, library, sourceResolver, searchProviders, sourceProviders,
      externalCatalog, recommendations, libraryInsights, plugins, acquisition, spotifyPlaylistImport: importer, logger: false });
    const mime: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" };
    app.get("/*", async (request, reply) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname.startsWith("/api/")) return reply.code(404).send({ error: "Unknown API route" });
      const name = ["/app.js", "/app.css", "/service-worker.js", "/asset-manifest.json"].includes(pathname) ? pathname.slice(1) : "index.html";
      return reply.type(mime[path.extname(name)]).header("Cache-Control", "no-cache").send(await fs.readFile(path.join(browserDirectory, name)));
    });
    const url = await app.listen({ port: config.port, host: "127.0.0.1" });
    return { url, app, db, config, registry, catalog, library, importer, importRepository, close: shutdown };
  } catch (error) {
    await shutdown(); throw error;
  }
}
export type Application = Awaited<ReturnType<typeof startApplication>>;
