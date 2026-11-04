import fs from "node:fs";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/database.js";
import { requireAdmin } from "../../auth/authorization.js";
import { sendError } from "../../utils/http.js";
import { registerLogSecret } from "../../utils/logger.js";
import { BackupRestoreService, MAX_BACKUP_UPLOAD, RecoveryError, type PreparedRestore, type RecoveryLifecycle } from "../../services/BackupRestoreService.js";
import { SystemHealthWizard } from "../../services/SystemHealthWizard.js";
import { configurationSnapshot, systemConfigurationSchema } from "../../services/systemConfiguration.js";

export async function registerSetupRecoveryRoutes(app: FastifyInstance, db: Db, config: AppConfig,
  options: { lifecycle?: RecoveryLifecycle; wizard?: SystemHealthWizard; recovery?: BackupRestoreService; setupRequired?: boolean } = {}) {
  const wizard = options.wizard || new SystemHealthWizard(db, config);
  const recovery = options.recovery || new BackupRestoreService(db, config, { lifecycle: options.lifecycle });
  const authorize = (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(db, request, reply)) return false;
    const origin = request.headers.origin;
    if (origin && ![config.publicUrl, config.corsOrigin].some((allowed) => { try { return new URL(allowed).origin === origin; } catch { return false; } })) { sendError(reply, 403, "Recovery requests must originate from the MusicDeck application."); return false; }
    reply.header("Cache-Control", "no-store"); return true;
  };
  const publicConfiguration = () => {
    const snapshot = configurationSnapshot(config);
    return { ...snapshot, navidrome: { url: snapshot.navidrome.url, username: snapshot.navidrome.username, passwordSet: Boolean(snapshot.navidrome.password) }, jellyfin: { url: snapshot.jellyfin.url, apiKeySet: Boolean(snapshot.jellyfin.apiKey) } };
  };
  const candidateSchema = systemConfigurationSchema.extend({ navidrome: systemConfigurationSchema.shape.navidrome.extend({ password: z.string().max(4096).optional() }), jellyfin: systemConfigurationSchema.shape.jellyfin.extend({ apiKey: z.string().max(4096).optional() }) });
  function candidate(body: unknown) {
    const input = candidateSchema.parse(body);
    const result = systemConfigurationSchema.parse({ ...input, navidrome: { ...input.navidrome, password: input.navidrome.password ?? config.navidrome.password }, jellyfin: { ...input.jellyfin, apiKey: input.jellyfin.apiKey ?? config.jellyfin.apiKey } });
    registerLogSecret(result.navidrome.password); registerLogSecret(result.jellyfin.apiKey);
    return result;
  }
  function errorResponse(error: unknown, reply: FastifyReply) {
    if (error instanceof z.ZodError) return sendError(reply, 400, "Invalid setup configuration or backup manifest. Check the selected server URL and required fields.", "VALIDATION_ERROR");
    if (error instanceof RecoveryError) return sendError(reply, error.statusCode, error.message, "RECOVERY_ERROR");
    app.log.error({ err: error }, "System recovery request failed");
    return sendError(reply, 500, "System recovery could not complete this operation. Check storage permissions, free space, and the server logs.", "RECOVERY_ERROR");
  }
  function accepted(plan: PreparedRestore, reply: FastifyReply) {
    // Wait for the response to finish before closing the HTTP server. app.close()
    // would otherwise wait for this very request and deadlock the restore.
    if (reply.raw.destroyed) { recovery.discardPrepared(plan); return reply; }
    let started = false;
    reply.raw.once("close", () => { if (!started) { try { recovery.discardPrepared(plan); } catch (error) { app.log.error({ err: error }, "Could not clean up cancelled recovery staging files"); } } });
    reply.raw.once("finish", () => { started = true; setImmediate(() => { void recovery.restore(plan).catch((error) => app.log.error({ err: error }, "System restore failed; inspect recovery status and the safety backup")); }); });
    return reply.code(202).send({ accepted: true, operationId: plan.id, message: "Validation passed. The server will restart; restoring a backup requires signing in again." });
  }
  app.get("/api/v1/admin/system/status", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    try {
      const completed = Boolean(db.prepare("SELECT value FROM server_settings WHERE key='setup.completedAt'").get());
      const daily = db.prepare("SELECT value FROM server_settings WHERE key='recovery.backupDaily'").get() as { value: string } | undefined;
      return { configuration: publicConfiguration(), firstRun: !completed || Boolean(options.setupRequired), restartSupported: Boolean(options.lifecycle), backupDaily: daily?.value === "true", operation: recovery.status(), backups: await recovery.listBackups(), limits: { uploadBytes: MAX_BACKUP_UPLOAD, expandedBytes: 1024 ** 3 }, mediaIncluded: false };
    } catch (error) { return errorResponse(error, reply); }
  });
  app.post("/api/v1/admin/system/diagnostics", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    try { return { report: request.body ? await wizard.run(candidate(request.body)) : await wizard.runConfigured() }; }
    catch (error) { return errorResponse(error, reply); }
  });
  app.post("/api/v1/admin/system/setup/complete", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const report = await wizard.runConfigured();
    if (!report.ready) return sendError(reply, 409, "Resolve failed connection, storage, and database checks before completing setup.", "SETUP_INCOMPLETE");
    db.prepare("INSERT INTO server_settings (key,value,updated_at) VALUES ('setup.completedAt',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(new Date().toISOString()), new Date().toISOString());
    return { completed: true, report };
  });
  app.post("/api/v1/admin/system/configuration", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    if (!options.lifecycle) return sendError(reply, 409, "Controlled restart is unavailable in this server instance.");
    try { return accepted(await recovery.prepareConfiguration(candidate(request.body)), reply); }
    catch (error) { return errorResponse(error, reply); }
  });
  app.patch("/api/v1/admin/system/backup-policy", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const parsed = z.object({ daily: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "A daily backup boolean is required.");
    db.prepare("INSERT INTO server_settings (key,value,updated_at) VALUES ('recovery.backupDaily',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(parsed.data.daily), new Date().toISOString());
    return { daily: parsed.data.daily };
  });
  app.post("/api/v1/admin/system/backups", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    try { return reply.code(201).send({ backup: await recovery.createBackup() }); }
    catch (error) { return errorResponse(error, reply); }
  });
  app.get("/api/v1/admin/system/backups/:id", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    try {
      const file = await recovery.backupPath((request.params as { id: string }).id);
      reply.header("Content-Disposition", `attachment; filename="${file.split(/[\\/]/).pop()}"`).type("application/gzip");
      return reply.send(fs.createReadStream(file));
    } catch (error) { return errorResponse(error, reply); }
  });
  // A stream parser keeps uploads off the heap; receiveUpload enforces the byte limit.
  app.addContentTypeParser(["application/gzip", "application/x-gzip"], (_request, stream, done) => done(null, stream));
  app.post("/api/v1/admin/system/restore", { bodyLimit: MAX_BACKUP_UPLOAD }, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    if (!options.lifecycle) return sendError(reply, 409, "Controlled restart is unavailable in this server instance.");
    const confirmation = request.headers["x-musicdeck-confirm-restore"];
    if (confirmation !== "replace-system-data") return sendError(reply, 400, "Confirm replacement of the database, configuration, and artwork cache before restoring.");
    if (!request.body || typeof (request.body as Readable).pipe !== "function") return sendError(reply, 400, "Upload a MusicDeck .tar.gz backup as application/gzip.");
    try { return accepted(await recovery.prepareRestore(await recovery.receiveUpload(request.body as Readable)), reply); }
    catch (error) { return errorResponse(error, reply); }
  });
  recovery.startScheduler(); app.addHook("onClose", async () => recovery.close());
  return { wizard, recovery };
}
