import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/database.js";
import type { MusicBackend } from "./backends/music-backend.js";
import { CatalogService } from "./domain/catalog.js";
import type { PlaylistService } from "./domain/playlist-service.js";
import type { LibraryService } from "./domain/library.js";
import type { SourceResolver } from "./domain/source-resolver.js";
import type { SearchProviderRegistry } from "./domain/search-provider-registry.js";
import type { SourceProviderRegistry } from "./domain/source-provider-registry.js";
import type { ExternalCatalogRegistry } from "./domain/external-catalog.js";
import type { RecommendationRegistry } from "./domain/recommendations.js";
import type { LibraryInsightsService } from "./domain/library-insights.js";
import type { PluginRegistry } from "./plugins/plugin-registry.js";
import type { AcquisitionService } from "./domain/acquisition.js";
import { classifyPluginError, httpStatusForPluginError } from "./plugins/plugin-errors.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerMusicRoutes } from "./routes/music-routes.js";
import { registerPlaylistRoutes } from "./routes/playlist-routes.js";
import { registerSettingsRoutes } from "./routes/settings-routes.js";
import { registerUserRoutes } from "./routes/user-routes.js";

export async function buildServer(options: {
  config: AppConfig;
  db: Db;
  backend: MusicBackend;
  catalog: CatalogService;
  playlists: PlaylistService;
  library: LibraryService;
  sourceResolver: SourceResolver;
  searchProviders: SearchProviderRegistry;
  sourceProviders: SourceProviderRegistry;
  externalCatalog: ExternalCatalogRegistry;
  recommendations: RecommendationRegistry;
  libraryInsights: LibraryInsightsService;
  plugins: PluginRegistry;
  acquisition?: AcquisitionService;
  logger?: boolean;
}) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: process.env.LOG_LEVEL || "info",
      redact: [
        "req.headers.cookie",
        "request.headers.cookie",
        "password",
        "*.password",
        "sessionSecret",
      ],
    },
  });

  await app.register(cors, {
    origin: options.config.corsOrigin,
    credentials: true,
  });

  await app.register(cookie, {
    secret: options.config.sessionSecret,
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
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
  await registerAuthRoutes(app, options.db, options.config);
  await registerUserRoutes(app, options.db);
  await registerSettingsRoutes(app, options.db);
  await registerMusicRoutes(app, options.db, options.backend, options.catalog, options.library, options.sourceResolver, options.playlists, options.searchProviders, options.sourceProviders, options.externalCatalog, options.recommendations, options.libraryInsights, options.acquisition);
  await registerPlaylistRoutes(app, options.db, options.playlists);

  return app;
}
