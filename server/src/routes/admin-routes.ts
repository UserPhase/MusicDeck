import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { requireAdmin, requireUser } from "../auth/authorization.js";
import type { SearchProviderRegistry } from "../domain/search-provider-registry.js";
import type { SourceProviderRegistry } from "../domain/source-provider-registry.js";
import type { ExternalCatalogRegistry } from "../domain/external-catalog.js";
import type { PluginRegistry } from "../plugins/plugin-registry.js";
import type { AcquisitionService } from "../domain/acquisition.js";
import { classifyPluginError, httpStatusForPluginError } from "../plugins/plugin-errors.js";
import { ManifestValidationError, parseCustomManifest } from "../plugins/plugin-manifest.js";

const searchProviderSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
  searchProviders: SearchProviderRegistry,
  sourceProviders: SourceProviderRegistry,
  externalCatalog: ExternalCatalogRegistry,
  plugins: PluginRegistry,
  acquisition?: AcquisitionService
) {
  app.get("/api/health", async () => ({
    ok: true,
    service: "musicdeck-server",
  }));

  app.get("/api/admin/health", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const counts = {
      users: (db.prepare("SELECT COUNT(*) AS count FROM users").get() as any).count,
      sessions: (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as any).count,
      backendConnections: (db.prepare("SELECT COUNT(*) AS count FROM backend_connections").get() as any).count,
    };

    return {
      ok: true,
      service: "musicdeck-server",
      backend: config.backend,
      database: "sqlite",
      counts,
    };
  });

  app.get("/api/admin/backend-connections", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const connections = db.prepare(
      "SELECT id, type, name, enabled, created_at, updated_at FROM backend_connections ORDER BY created_at ASC"
    ).all();

    return { backendConnections: connections };
  });

  app.get("/api/admin/search-providers", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    return { searchProviders: searchProviders.list() };
  });

  app.patch("/api/admin/search-providers/:providerId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);

    if (!user) {
      return reply;
    }

    const parsed = searchProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid search provider settings" } });
    }

    try {
      const { providerId } = request.params as { providerId: string };
      searchProviders.configure(providerId, parsed.data);
      if (providerId === "itunes") {
        externalCatalog.configure(Boolean(parsed.data.enabled));
      }
      const provider = searchProviders.list().find((item) => item.id === providerId);
      return { searchProvider: provider };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Search provider not found" } });
    }
  });

  app.get("/api/admin/source-providers", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    return user ? { sourceProviders: sourceProviders.list() } : reply;
  });

  app.patch("/api/admin/source-providers/:providerId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      enabled: z.boolean(),
      config: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid source provider settings" } });
    }

    try {
      const { providerId } = request.params as { providerId: string };
      sourceProviders.configure(providerId, parsed.data.enabled, parsed.data.config);
      const provider = sourceProviders.list().find((item) => item.id === providerId);
      return { sourceProvider: provider };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Source provider not found" } });
    }
  });

  app.post("/api/admin/source-providers/:providerId/test", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    try {
      const { providerId } = request.params as { providerId: string };
      return { test: await sourceProviders.test(providerId) };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Source provider not found" } });
    }
  });

  app.get("/api/plugins", async (request, reply) => {
    const user = requireUser(db, request, reply);
    return user ? { plugins: plugins.list(false) } : reply;
  });

  app.get("/api/admin/plugins", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    return user ? { plugins: plugins.list(true) } : reply;
  });

  app.get("/api/admin/plugins/:pluginId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    try {
      const { pluginId } = request.params as { pluginId: string };
      return { plugin: plugins.get(pluginId, true) };
    } catch {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Plugin not found" } });
    }
  });

  app.post("/api/admin/plugins/install", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({ manifest: z.unknown() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A plugin manifest is required" } });
    }

    try {
      const manifest = parseCustomManifest(parsed.data.manifest);
      const plugin = await plugins.installCustomPlugin(manifest);
      return reply.code(201).send({ plugin });
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        return reply.code(400).send({ error: { code: "INVALID_MANIFEST", message: error.message } });
      }
      if (error instanceof Error && error.message === "Plugin is already registered") {
        return reply.code(409).send({ error: { code: "ALREADY_INSTALLED", message: "A plugin with this ID is already installed" } });
      }
      app.log.error(error);
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Could not install plugin" } });
    }
  });

  app.delete("/api/admin/plugins/:pluginId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    try {
      const { pluginId } = request.params as { pluginId: string };
      plugins.uninstallPlugin(pluginId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown plugin") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Plugin not found" } });
      }
      if (error instanceof Error && error.message === "Only custom plugins can be uninstalled") {
        return reply.code(400).send({ error: { code: "NOT_UNINSTALLABLE", message: error.message } });
      }
      app.log.error(error);
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Could not uninstall plugin" } });
    }
  });

  app.patch("/api/admin/plugins/:pluginId", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    const parsed = z.object({
      enabled: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      permissions: z.array(z.string()).optional(),
    }).safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid plugin settings" } });
    }

    try {
      const { pluginId } = request.params as { pluginId: string };
      plugins.configure(pluginId, { ...parsed.data, enabled: false });
      if (parsed.data.enabled === true) {
        await plugins.enable(pluginId);
      } else if (parsed.data.enabled === false) {
        plugins.disable(pluginId);
      }
      return { plugin: plugins.get(pluginId, true) };
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown plugin") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Plugin not found" } });
      }
      const classified = classifyPluginError(error);
      return reply.code(httpStatusForPluginError(classified.status)).send({
        error: { code: classified.status.toUpperCase(), message: classified.message },
      });
    }
  });

  app.post("/api/admin/plugins/:pluginId/test", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    try {
      const { pluginId } = request.params as { pluginId: string };
      return { test: await plugins.test(pluginId) };
    } catch (error) {
      if (error instanceof Error && error.message === "Unknown plugin") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Plugin not found" } });
      }
      const classified = classifyPluginError(error);
      return reply.code(httpStatusForPluginError(classified.status)).send({
        error: { code: classified.status.toUpperCase(), message: classified.message },
      });
    }
  });

  app.get("/api/admin/acquisitions", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return {
        activeJobs: 0,
        queuedJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        totalJobs: 0,
        storageUsedBytes: 0,
        tempStorageUsedBytes: 0,
        musicRoot: config.musicRoot,
        downloadDirectory: config.musicRoot,
        maxConcurrentDownloads: 1,
        autoScanLibrary: true,
        cleanupPolicy: "on_completion",
        recentJobs: [],
      };
    }

    return await acquisition.getAdminSummary();
  });

  app.post("/api/admin/acquisitions/cleanup", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return { filesRemoved: 0, bytesFreed: 0 };
    }

    return await acquisition.cleanupTempStorage();
  });

  app.post("/api/admin/acquisitions/scan", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return { scanned: false };
    }

    await acquisition.triggerLibraryScan();
    return { scanned: true };
  });

  app.get("/api/admin/downloader/diagnostics", async (request, reply) => {
    const user = requireAdmin(db, request, reply);
    if (!user) return reply;

    if (!acquisition) {
      return { downloaders: [] };
    }

    const downloaders = await acquisition.getDownloaderDiagnostics();
    return { downloaders };
  });
}

