import { loadConfig, validateConfig } from "./config.js";
import { createProviderRegistry } from "./backends/factory.js";
import { type MusicBackend } from "./backends/music-backend.js";
import { withLocalUserDataSync } from "./backends/local-user-data-sync.js";
import { openDatabase } from "./db/database.js";
import { buildServer } from "./server.js";
import { CatalogService } from "./domain/catalog.js";
import { PlaylistService } from "./domain/playlist-service.js";
import { LibraryService } from "./domain/library.js";
import { SourceResolver } from "./domain/source-resolver.js";
import { SourcePipelineRegistry } from "./domain/source-discovery.js";
import { SearchProviderRegistry } from "./domain/search-provider-registry.js";
import { SourceProviderRegistry } from "./domain/source-provider-registry.js";
import { ExternalCatalogRegistry } from "./domain/external-catalog.js";
import { RecommendationRegistry, RecommendationService } from "./domain/recommendations.js";
import { LibraryInsightsService } from "./domain/library-insights.js";
import { AcquisitionProviderRegistry, AcquisitionService } from "./domain/acquisition.js";
import { DownloaderAdapterRegistry } from "./domain/downloader-adapter.js";
import { SpotDLDownloaderAdapter } from "./domain/spotdl-downloader-adapter.js";
import { PluginRegistry } from "./plugins/plugin-registry.js";
import {
  createExternalArtworkPlugin,
  createLastFmPlugin,
  createListenBrainzPlugin,
  createMusicBrainzPlugin,
  createSpotDLDownloaderPlugin,
} from "./plugins/first-party.js";

async function start() {
  const config = loadConfig();
  validateConfig(config);
  const db = await openDatabase(config);
  const registry = createProviderRegistry(db, config);
  const primaryProvider = registry.getPrimary().provider;

  // Backends that support provider-side user-data sync (Navidrome) are used
  // directly. Backends that do not (Jellyfin) are wrapped so favorites and
  // playlists stay in MusicDeck's own database instead of blocking startup.
  const backend: MusicBackend = withLocalUserDataSync(primaryProvider);

  const library = new LibraryService(db);
  const catalog = new CatalogService(registry, library);
  const playlists = new PlaylistService(db, backend, catalog, library);
  const sourceResolver = new SourceResolver(registry, library);
  const searchProviders = new SearchProviderRegistry(db, catalog, playlists);
  const sourcePipeline = new SourcePipelineRegistry(db);
  const sourceProviders = new SourceProviderRegistry(db, library, registry, sourceResolver, undefined, sourcePipeline);
  const externalCatalog = new ExternalCatalogRegistry();
  externalCatalog.configure(searchProviders.list().some((provider) => provider.id === "itunes" && provider.enabled));
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
  const spotdlAdapter = new SpotDLDownloaderAdapter({});
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
      maxConcurrentDownloads: 1,
      autoScan: true,
      sourcePipeline,
      downloaderRegistry,
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
  for (const manifest of plugins.loadInstalledCustomPlugins()) {
    try {
      await plugins.register({ manifest }, "third-party");
    } catch (error) {
      console.error(`Failed to rehydrate custom plugin ${manifest.id}`, error);
    }
  }
  const app = await buildServer({ config, db, backend, catalog, playlists, library, sourceResolver, searchProviders, sourceProviders, externalCatalog, recommendations, libraryInsights, plugins, acquisition });

  await app.listen({
    host: config.host,
    port: config.port,
  });
}

try {
  await start();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`MusicDeck Server failed to start: ${message}`);
  process.exit(1);
}
