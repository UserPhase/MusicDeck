import { loadConfig, validateConfig } from "./config.js";
import { createPrivacyManager, setRuntimePrivacyManager } from "./services/PrivacyManager.js";
import { createProviderRegistry } from "./backends/factory.js";
import { type MusicBackend } from "./backends/music-backend.js";
import { withLocalUserDataSync } from "./backends/local-user-data-sync.js";
import { openDatabase } from "./db/database.js";
import { buildServer } from "./server.js";
import { CatalogService } from "./domain/catalog.js";
import { PlaylistService } from "./domain/playlist-service.js";
import { SpotifyPlaylistImportService } from "./domain/spotify-playlist-import.js";
import { LibraryService } from "./domain/library.js";
import { SourceResolver } from "./domain/source-resolver.js";
import { SourcePipelineRegistry } from "./domain/source-discovery.js";
import { SearchProviderRegistry } from "./domain/search-provider-registry.js";
import { SourceProviderRegistry } from "./domain/source-provider-registry.js";
import { ExternalCatalogRegistry } from "./domain/external-catalog.js";
import { RecommendationRegistry, RecommendationService } from "./domain/recommendations.js";
import { LibraryInsightsService } from "./domain/library-insights.js";
import { AcquisitionProviderRegistry, AcquisitionService } from "./domain/acquisition.js";
import { SilenceAnalysisService } from "./domain/silence-analysis.js";
import { DownloaderAdapterRegistry } from "./domain/downloader-adapter.js";
import { SpotDLDownloaderAdapter } from "./domain/spotdl-downloader-adapter.js";
import { AudioTaggerService } from "./services/media/audioTaggerService.js";
import path from "node:path";
import { LoudnessService } from "./services/media/loudnessService.js";
import { LoudnessScanService } from "./services/media/loudnessScanService.js";
import { SilenceScanService } from "./services/media/silenceScanService.js";
import { SqliteImportJobRepository } from "./infrastructure/persistence/sqliteImportJobRepository.js";
import { SqliteImportedArtworkRepository } from "./infrastructure/persistence/sqliteImportedArtworkRepository.js";
import { PluginRegistry } from "./plugins/plugin-registry.js";
import {
  createExternalArtworkPlugin,
  createLastFmPlugin,
  createListenBrainzPlugin,
  createMusicBrainzPlugin,
  createSpotDLDownloaderPlugin,
} from "./plugins/first-party.js";
import { installLogCapture, registerLogSecret, serverLogs } from "./utils/logger.js";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/database.js";
import { recoverInterruptedRestore } from "./services/BackupRestoreService.js";
import { applySystemConfiguration } from "./services/systemConfiguration.js";

// Capture console output and process-level failures for the Admin log viewer
// before anything else can log.
installLogCapture();

let currentApp: FastifyInstance | null = null;
let currentDb: Db | null = null;
async function quiesceRuntime() {
  const app = currentApp;
  if (!app) return;
  const force = setTimeout(() => app.server.closeAllConnections(), 2000); force.unref();
  try { await app.close(); currentApp = null; } finally { clearTimeout(force); }
}
function closeRuntimeDatabase() {
  if (!currentDb?.open) { currentDb = null; return; }
  const checkpoint = currentDb.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if (checkpoint.some((row) => row.busy)) throw new Error("Another SQLite connection prevented the recovery checkpoint. Stop other MusicDeck instances before restoring.");
  currentDb.close(); currentDb = null;
}
async function start(options: { skipRecovery?: boolean } = {}) {
  const deployment = loadConfig();
  if (!options.skipRecovery) recoverInterruptedRestore(deployment);
  const config = applySystemConfiguration(deployment);
  for (const secret of [config.sessionSecret, config.navidrome.password, config.jellyfin.apiKey, config.firstAdmin.password]) {
    registerLogSecret(secret);
  }
  let setupRequired = false;
  try { validateConfig(config); }
  catch {
    validateConfig({ ...config, navidrome: { url: "http://navidrome:4533", username: "setup", password: "setup" }, jellyfin: { url: "http://jellyfin:8096", apiKey: "setup" } });
    setupRequired = true;
  }
  const db = await openDatabase(config);
  currentDb = db;
  try {
  if (!(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get() as { count: number }).count) throw new Error("Set MUSICDECK_ADMIN_PASSWORD to bootstrap the first administrator before opening the setup wizard.");
  const privacy = createPrivacyManager(db, config);
  setRuntimePrivacyManager(privacy);
  const registry = createProviderRegistry(db, config);
  const primaryProvider = registry.getPrimary().provider;

  // Backends that support provider-side user-data sync (Navidrome) are used
  // directly. Backends that do not (Jellyfin) are wrapped so favorites and
  // playlists stay in MusicDeck's own database instead of blocking startup.
  const backend: MusicBackend = withLocalUserDataSync(primaryProvider);

  const library = new LibraryService(db, { musicRoot: config.musicRoot });
  const spotdlAdapter = new SpotDLDownloaderAdapter({});
  const loudness = new LoudnessService(db, {
    cacheDir: path.join(path.dirname(path.resolve(config.databasePath)), "playback-cache"),
    getFFmpegPath: () => spotdlAdapter.getMediaToolPaths().ffmpegPath,
    refreshContentRevision: trackId => library.refreshContentRevision(trackId),
  });
  const catalog = new CatalogService(registry, library, serverLogs, track => loudness.trackLoudness(track));
  const sourceResolver = new SourceResolver(registry, library);
  const loudnessScan = new LoudnessScanService(db, catalog, sourceResolver, loudness);
  const silenceAnalysis = new SilenceAnalysisService(db, sourceResolver, {
    getFFmpegPath: () => spotdlAdapter.getMediaToolPaths().ffmpegPath,
  });
  const silenceScan = new SilenceScanService(db, catalog, silenceAnalysis);
  const playlists = new PlaylistService(db, backend, catalog, library, sourceResolver);
  const externalCatalog = new ExternalCatalogRegistry(undefined, db);
  const searchProviders = new SearchProviderRegistry(db, catalog, playlists, undefined, externalCatalog.artwork);
  const sourcePipeline = new SourcePipelineRegistry(db);
  const sourceProviders = new SourceProviderRegistry(db, library, registry, sourceResolver, undefined, sourcePipeline);
  const spotifyConfig = searchProviders.rawConfig("spotify");
  const spotifySecret = (spotifyConfig?.config as Record<string, unknown> | undefined)?.clientSecret;
  if (typeof spotifySecret === "string") registerLogSecret(spotifySecret);
  externalCatalog.configure(Boolean(spotifyConfig?.enabled), spotifyConfig?.config);
  const recommendations = new RecommendationRegistry(new RecommendationService(db, catalog));
  const libraryInsights = new LibraryInsightsService(db, catalog);
  const acquisitionProviders = new AcquisitionProviderRegistry();
  const plugins = new PluginRegistry(db, {
    catalog,
    libraryInsights,
    sources: sourceProviders,
    sourcePipeline,
    acquisition: acquisitionProviders,
    recommendations,
    playlists: {
      create: async (name, userId) => playlists.create(name, { id: userId, role: "user" } as any),
      addTrack: (playlistId, trackId) => playlists.addTrack(playlistId, trackId),
    },
  });
  const downloaderRegistry = new DownloaderAdapterRegistry();
  downloaderRegistry.register(spotdlAdapter);
  const acquisition = new AcquisitionService(
    db,
    acquisitionProviders,
    library,
    catalog,
    plugins,
    {
      musicRoot: config.musicRoot,
      tmpDir: config.acquisitionTmpDir,
      limits: config.acquisitionLimits,
      maxConcurrentDownloads: 1,
      autoScan: true,
      sourcePipeline,
      downloaderRegistry,
      analyzeImportedFile: file => loudness.analyzeImportedFile(file.path, config.musicRoot, {
        title: file.title || "", artist: file.artist || "", album: file.album || "", durationSeconds: file.durationSeconds,
      }),
    }
  );
  // Active, supported first-party plugins. In-progress plugins live under
  // plugins/in-progress/ and are deliberately NOT auto-registered here so they
  // do not appear in the normal Admin Plugins page or affect the runtime.
  await plugins.register(createListenBrainzPlugin());
  await plugins.register(createLastFmPlugin());
  await plugins.register(createMusicBrainzPlugin());
  await plugins.register(createExternalArtworkPlugin());
  await plugins.register(createSpotDLDownloaderPlugin(spotdlAdapter));
  const spotifyPlaylistImport = new SpotifyPlaylistImportService(
    backend, playlists, spotdlAdapter, config.musicRoot, undefined, config.spotifyImportSubdir,
    new AudioTaggerService({ getTools: () => spotdlAdapter.getMediaToolPaths() }),
    new SqliteImportJobRepository(db),
    new SqliteImportedArtworkRepository(db),
    undefined,
    (filePath, metadata) => loudness.analyzeImportedFile(filePath, config.musicRoot, metadata),
  );
  for (const manifest of plugins.loadInstalledCustomPlugins()) {
    try {
      await plugins.register({ manifest }, "third-party");
    } catch (error) {
      console.error(`Failed to rehydrate custom plugin ${manifest.id}`, error);
    }
  }
  const app = await buildServer({ config, db, privacy, backend, catalog, playlists, spotifyPlaylistImport, library, sourceResolver, searchProviders, sourceProviders, externalCatalog, recommendations, libraryInsights, plugins, acquisition, loudness, loudnessScan, silenceAnalysis, silenceScan, setupRequired,
    recoveryLifecycle: { quiesce: quiesceRuntime, closeDatabase: closeRuntimeDatabase, restart: () => start({ skipRecovery: true }) },
  });
  currentApp = app;

  await app.listen({
    host: config.host,
    port: config.port,
  });
  loudnessScan.resume();
  silenceScan.resume();
  } catch (error) {
    await quiesceRuntime();
    if (db.open) db.close();
    currentDb = null;
    throw error;
  }
}

try {
  await start();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`MusicDeck Server failed to start: ${message}`);
  process.exit(1);
}
