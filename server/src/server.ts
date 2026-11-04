import cookie from "@fastify/cookie";
import { RemoteControlHub } from "./services/RemoteControlHub.js";
import { createPrivacyManager, PrivacyBlockedError, type PrivacyManager } from "./services/PrivacyManager.js";
import { installPrivacyRequestScope, registerPrivacySettingsRoutes } from "./routes/privacy-settings.js";
import cors from "@fastify/cors";
import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/database.js";
import type { MusicBackend } from "./backends/music-backend.js";
import { CatalogService } from "./domain/catalog.js";
import { registerSavedDiscoveryRoutes } from "./routes/saved-discoveries.js";
import { registerTasteProfileRoutes } from "./routes/taste-profile.js";
import { registerSimilarMixRoutes } from "./routes/similar-mixes.js";
import { registerPlaylistOrganizationRoutes } from "./routes/playlist-organization.js";
import { registerPlaylistCollaborationRoutes } from "./routes/playlist-collaboration.js";
import { registerQueueSessionRoutes, QueueSyncError } from "./routes/queue-session.js";
import { PlaylistPermissionError } from "./services/PlaylistCollaborationService.js";
import { PlaylistOrganizationError } from "./domain/playlist-organization.js";
import { registerSmartPlaylistRoutes } from "./routes/smart-playlists.js";
import { SmartPlaylistEvaluator } from "./services/SmartPlaylistEvaluator.js";
import type { PlaylistService } from "./domain/playlist-service.js";
import type { SpotifyPlaylistImportService } from "./domain/spotify-playlist-import.js";
import type { LibraryService } from "./domain/library.js";
import type { SourceResolver } from "./domain/source-resolver.js";
import type { SearchProviderRegistry } from "./domain/search-provider-registry.js";
import type { SourceProviderRegistry } from "./domain/source-provider-registry.js";
import type { ExternalCatalogRegistry } from "./domain/external-catalog.js";
import type { RecommendationRegistry } from "./domain/recommendations.js";
import type { LibraryInsightsService } from "./domain/library-insights.js";
import type { PluginRegistry } from "./plugins/plugin-registry.js";
import type { AcquisitionService } from "./domain/acquisition.js";
import type { SilenceAnalysisService } from "./domain/silence-analysis.js";
import type { LoudnessService } from "./services/media/loudnessService.js";
import type { LoudnessScanService } from "./services/media/loudnessScanService.js";
import type { SilenceScanService } from "./services/media/silenceScanService.js";
import { registerSilenceScanRoutes } from "./routes/silence-scan-routes.js";
import { registerLoudnessRoutes } from "./routes/loudness-routes.js";
import { classifyPluginError, httpStatusForPluginError } from "./plugins/plugin-errors.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerAdminMediaRoutes } from "./routes/admin-media-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerMusicRoutes } from "./routes/music-routes.js";
import { registerPlaylistRoutes } from "./routes/playlist-routes.js";
import { registerUserExportRoutes } from "./routes/user-export.js";
import { DataExportService } from "./services/DataExportService.js";
import { registerMediaSessionRoutes } from "./routes/media-session.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerAdminHealthRoutes } from "./routes/admin/health.js";
import { LibraryHealthScanService } from "./services/library/libraryHealthScanService.js";
import { registerConfigRoutes } from "./routes/config-routes.js";
import { registerAdminLogsRoutes } from "./routes/admin-logs-routes.js";
import { createLogCaptureStream, type LogBuffer, serverLogs } from "./utils/logger.js";
import { registerUserRoutes } from "./routes/user-routes.js";
import { ScannerScheduler } from "./services/scannerScheduler.js";
import { registerListeningActivityRoutes } from "./routes/listening-activity-routes.js";
import { registerAdminTaskRoutes } from "./routes/admin/tasks.js";
import { TaskManager, type TaskDefinition, type TaskType } from "./services/TaskManager.js";
import { createSpotdlRunner } from "./tasks/runners/spotdlRunner.js";
import { createLibraryScanRunner } from "./tasks/runners/libraryScanRunner.js";
import { ArtistFollowService } from "./services/ArtistFollowService.js";
import { createNewReleaseScannerRunner, scheduleReleaseScans } from "./tasks/runners/newReleaseScannerRunner.js";
import { createSonicAnalysisRunner } from "./tasks/runners/sonicAnalysisRunner.js";
import { SonicRecommendationService } from "./services/SonicRecommendationService.js";
import { registerSonicRoutes } from "./routes/admin/sonic.js";
import { registerArtistFollowRoutes } from "./routes/artist-follows.js";
import { getUserById } from "./users/users.js";
import { ExtensionManager } from "./services/ExtensionManager.js";
import { registerExtensionRoutes } from "./routes/admin/extensions.js";
import { registerCastRoutes } from "./routes/cast.js";
import { registerSetupRecoveryRoutes } from "./routes/admin/setup-recovery.js";
import { registerScrobbleRoutes } from "./routes/scrobble-routes.js";
import { ScrobbleQueueService } from "./services/scrobble/ScrobbleQueueService.js";
import type { RecoveryLifecycle } from "./services/BackupRestoreService.js";

export async function buildServer(options: {
  config: AppConfig;
  privacy?: PrivacyManager;
  db: Db;
  backend: MusicBackend;
  catalog: CatalogService;
  playlists: PlaylistService;
  spotifyPlaylistImport?: SpotifyPlaylistImportService;
  library: LibraryService;
  sourceResolver: SourceResolver;
  searchProviders: SearchProviderRegistry;
  sourceProviders: SourceProviderRegistry;
  externalCatalog: ExternalCatalogRegistry;
  recommendations: RecommendationRegistry;
  libraryInsights: LibraryInsightsService;
  plugins: PluginRegistry;
  acquisition?: AcquisitionService;
  silenceAnalysis?: SilenceAnalysisService;
  loudness?: LoudnessService;
  loudnessScan?: LoudnessScanService;
  silenceScan?: SilenceScanService;
  logger?: boolean;
  logBuffer?: LogBuffer;
  scanScheduler?: ScannerScheduler;
  libraryHealth?: LibraryHealthScanService;
  taskManager?: TaskManager;
  taskDefinitions?: Partial<Record<TaskType, TaskDefinition<unknown>>>;
  recoveryLifecycle?: RecoveryLifecycle;
  setupRequired?: boolean;
  scrobbleFetch?: typeof fetch;
}) {
  const logBuffer = options.logBuffer ?? serverLogs;
  const app = Fastify({
    trustProxy: options.config.trustedProxies.length ? options.config.trustedProxies : false,
    logger: options.logger === false ? false : {
      level: process.env.LOG_LEVEL || "info",
      serializers: {
        req: (request) => ({ method: request.method,
          url: request.url?.replace(/([?&](?:token|state)=)[^&]*/g, "$1[REDACTED]"),
          hostname: request.hostname, remoteAddress: request.ip }),
      },
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "request.headers.cookie",
        "password",
        "*.password",
        "sessionSecret",
      ],
      stream: createLogCaptureStream(logBuffer),
    },
  });
  const privacy = options.privacy ?? createPrivacyManager(options.db, options.config);
  const scrobbleQueue = new ScrobbleQueueService(options.db, privacy, {
    fetchImpl: options.scrobbleFetch, onError: () => app.log.error("Scrobble queue processing failed; pending listens remain in SQLite"),
  });
  app.addHook("preClose", async () => scrobbleQueue.close());
  app.addHook("preClose", async () => options.playlists.close());
  app.addHook("onReady", async () => scrobbleQueue.start());
  installPrivacyRequestScope(app, privacy);
  await registerPrivacySettingsRoutes(app, options.db, privacy);

  await app.register(cors, {
    origin: options.config.corsOrigin,
    credentials: true,
  });

  await app.register(cookie, {
    secret: options.config.sessionSecret,
  });
  new RemoteControlHub(app, options.db, [options.config.publicUrl, options.config.corsOrigin]);

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    if (!reply.hasHeader("Referrer-Policy")) reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof QueueSyncError) { reply.code(error.statusCode).send({ error: { code: "QUEUE_SYNC_ERROR", message: error.message } }); return; }
    if (error instanceof PlaylistPermissionError || error instanceof PlaylistOrganizationError) {
      reply.code(error.statusCode).send({ error: { code: "PLAYLIST_ACCESS_ERROR", message: error.message } }); return;
    }
    app.log.error(error);
    if (error instanceof PrivacyBlockedError) {
      reply.code(403).send({ error: { code: error.code, message: error.message } });
      return;
    }

    // Fastify's own request-payload failures (body too large, malformed JSON,
    // unsupported content type) are client errors that already describe
    // themselves accurately. Classifying them as plugin failures would report
    // a misleading 500 for what is really a bad request.
    const { code, statusCode, message } = error as {
      code?: string;
      statusCode?: number;
      message?: string;
    };

    if (
      typeof code === "string" &&
      code.startsWith("FST_ERR_CTP_") &&
      typeof statusCode === "number" &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      reply.code(statusCode).send({
        error: {
          code,
          message: message ?? "Request could not be processed",
        },
      });
      return;
    }

    // Even an unexpected throw should surface as a normalized plugin error
    // instead of an opaque 500 when the failure is classifiable.
    const classified = classifyPluginError(error);
    reply.code(httpStatusForPluginError(classified.status)).send({
      error: {
        code: classified.status.toUpperCase(),
        message: classified.message,
      },
    });
  });

  await registerAdminRoutes(app, options.db, options.config, options.searchProviders, options.sourceProviders, options.externalCatalog, options.plugins, options.acquisition);
  await registerAdminMediaRoutes(app, options.db, options.config.musicRoot, options.catalog);
  await registerAuthRoutes(app, options.db, options.config);
  await registerUserRoutes(app, options.db);
  const taskManager = options.taskManager ?? new TaskManager(options.db);
  const sonic = new SonicRecommendationService(options.db);
  options.recommendations.local.engine.bindSonic(sonic);
  const artistFollows = new ArtistFollowService(options.db, {
    fetchImpl: (input, init) => privacy.fetch(input, init, options.externalCatalog.fetchImpl, "metadata"),
    artwork: options.externalCatalog.artwork,
  });
  options.spotifyPlaylistImport?.bindUserResolver((userId) => getUserById(options.db, userId));
  const builtins: Partial<Record<TaskType, TaskDefinition<unknown>>> = {
    SPOTDL_IMPORT: createSpotdlRunner(options.acquisition, options.spotifyPlaylistImport),
    SPOTDL_DOWNLOAD: createSpotdlRunner(options.acquisition, options.spotifyPlaylistImport),
    LIBRARY_SCAN: createLibraryScanRunner(options.catalog),
    NEW_RELEASES_SCAN: createNewReleaseScannerRunner(artistFollows),
    SONIC_AUDIO_ANALYSIS: createSonicAnalysisRunner(sonic, options.catalog, options.config.musicRoot),
  };
  for (const [type, definition] of Object.entries({ ...builtins, ...options.taskDefinitions })) {
    if (definition) taskManager.register(type as TaskType, definition);
  }
  registerArtistFollowRoutes(app, options.db, artistFollows, taskManager, privacy, options.catalog);
  app.addHook("onReady", async () => scheduleReleaseScans(taskManager, artistFollows.hasFollowers()));
  const extensions = new ExtensionManager(options.db, options.config.extensionsDir, taskManager, app.log, privacy);
  registerExtensionRoutes(app, options.db, extensions);
  app.addHook("preClose", async () => extensions.close());
  await extensions.start();
  options.catalog.bindTaskManager(taskManager);
  options.acquisition?.bindTaskManager(taskManager);
  options.spotifyPlaylistImport?.bindTaskManager(taskManager);
  options.spotifyPlaylistImport?.resumeInterrupted((userId) => getUserById(options.db, userId));
  options.recommendations.local.start();
  await registerAdminTaskRoutes(app, options.db, taskManager);
  registerSonicRoutes(app, options.db, sonic, taskManager);
  const scanScheduler = options.scanScheduler ?? new ScannerScheduler(
    options.db,
    () => options.catalog.scanLibrary(),
    { logger: app.log },
  );
  scanScheduler.start();
  app.addHook("onClose", async () => {
    scanScheduler.stop();
    await Promise.all([options.loudness?.close(), options.silenceAnalysis?.close(), options.loudnessScan?.close(), options.silenceScan?.close()]);
    await options.acquisition?.shutdown();
    await taskManager.close();
    await scanScheduler.waitForIdle();
    await options.recommendations.local.close();
  });
  await registerSettingsRoutes(app, options.db, scanScheduler);
  const libraryHealth = options.libraryHealth ?? new LibraryHealthScanService(options.db, options.catalog, {
    requestRescan: () => scanScheduler.runNow("manual"),
    logger: app.log,
  });
  app.addHook("onClose", async () => {
    await libraryHealth.close();
  });
  await registerAdminHealthRoutes(app, options.db, libraryHealth);
  await registerConfigRoutes(app, options.db);
  await registerAdminLogsRoutes(app, options.db, logBuffer);
  await registerListeningActivityRoutes(app, options.db, options.catalog);
  await registerMediaSessionRoutes(app, options.db);
  await registerSavedDiscoveryRoutes(app, options.db, options.catalog);
  registerTasteProfileRoutes(app, options.db, options.recommendations.local);
  const smartPlaylists = new SmartPlaylistEvaluator(options.db);
  smartPlaylists.connect(options.catalog, (error) => app.log.warn({ err: error }, "Could not refresh smart playlist catalog"));
  app.addHook("onClose", () => smartPlaylists.close());
  await registerSmartPlaylistRoutes(app, options.db, smartPlaylists, options.playlists);
  registerSimilarMixRoutes(app, options.db, options.playlists, options.externalCatalog.fetchImpl, query => options.externalCatalog.deezerProvider.searchTracks(query, 10));
  registerScrobbleRoutes(app, options.db, options.config, scrobbleQueue);
  await registerMusicRoutes(app, options.db, options.backend, options.catalog, options.library, options.sourceResolver, options.playlists, options.searchProviders, options.sourceProviders, options.externalCatalog, options.recommendations, options.libraryInsights, options.acquisition, options.silenceAnalysis, options.config.acquisitionLimits, taskManager, scrobbleQueue);
  registerCastRoutes(app, options.db, options.config, options.library, options.sourceResolver, taskManager, privacy);
  await registerPlaylistRoutes(app, options.db, options.playlists, options.spotifyPlaylistImport);
  await registerPlaylistOrganizationRoutes(app, options.db, options.library, options.playlists);
  registerPlaylistCollaborationRoutes(app, options.db, options.playlists, options.catalog, options.library);
  registerQueueSessionRoutes(app, options.db, options.library);
  await registerSetupRecoveryRoutes(app, options.db, options.config, { lifecycle: options.recoveryLifecycle, setupRequired: options.setupRequired });
  await registerUserExportRoutes(app, options.db, new DataExportService(options.db, options.catalog, {
    publicUrl: options.config.publicUrl, musicRoot: options.config.musicRoot,
    log: (error, message) => app.log.warn({ err: error }, message),
  }));
  await registerLoudnessRoutes(app, options.db, options.library, options.sourceResolver, options.sourceProviders, options.loudness, { scan: options.loudnessScan, catalog: options.catalog, taskManager });
  await registerSilenceScanRoutes(app, options.db, options.silenceScan, options.silenceAnalysis);

  return app;
}
