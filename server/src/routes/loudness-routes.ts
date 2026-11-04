import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { requireUser } from "../auth/authorization.js";
import { sendError } from "../utils/http.js";
import type { LibraryService } from "../domain/library.js";
import type { SourceResolver } from "../domain/source-resolver.js";
import type { SourceProviderRegistry } from "../domain/source-provider-registry.js";
import type { LoudnessService } from "../services/media/loudnessService.js";
import { measuredPlaybackGain, playbackIdentity } from "../services/media/loudnessService.js";
import type { LoudnessScanService } from "../services/media/loudnessScanService.js";
import { ScanParametersConflict } from "../services/media/libraryAnalysisScanService.js";
import type { CatalogService } from "../domain/catalog.js";
import type { TaskManager } from "../services/TaskManager.js";
import { getNormalizationTarget } from "../domain/settings.js";
import { privacyFetch as fetch } from "../services/PrivacyManager.js";

const requestSchema = z.object({
  trackId: z.string().min(1).max(256),
  source: z.string().max(256).optional(),
  playableSource: z.string().max(256).optional(),
  previewUrl: z.string().url().max(2048).optional(),
  bitRate: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320)]).optional(),
  background: z.boolean().optional(),
  targetLufs: z.union([z.literal(-18), z.literal(-16), z.literal(-14)]).optional(),
}).strict();

export function isAllowedPreview(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      (url.hostname === "dzcdn.net" || url.hostname.endsWith(".dzcdn.net") || url.hostname === "itunes.apple.com" || url.hostname.endsWith(".itunes.apple.com"));
  } catch { return false; }
}

// Validate every redirect as well; FFmpeg only ever reads the resulting local file.
async function fetchPreview(url: string, range?: string, signal?: AbortSignal) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedPreview(url)) throw new Error("Untrusted preview URL");
    const response = await fetch(url, { redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), ...(range ? { headers: { Range: range } } : {}) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Preview redirect missing");
      url = new URL(location, url).href;
      continue;
    }
    return { body: response.body, status: response.status, headers: response.headers };
  }
  throw new Error("Too many preview redirects");
}

export async function registerLoudnessRoutes(app: FastifyInstance, db: Db, library: LibraryService, resolver: SourceResolver, providers: SourceProviderRegistry, service?: LoudnessService, options: { scan?: LoudnessScanService; catalog?: CatalogService; taskManager?: TaskManager } = {}) {
  app.get("/api/playback/loudness-scan", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    return { scan: options.scan?.status(user.id) ?? null };
  });
  app.post("/api/playback/loudness-scan", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    if (!z.object({}).strict().safeParse(request.body ?? {}).success) return sendError(reply, 400, "Invalid scan request");
    if (!options.scan) return sendError(reply, 503, "Library analysis is unavailable");
    try { return reply.code(202).send({ scan: options.scan.start(user.id) }); }
    catch (error) {
      if (error instanceof ScanParametersConflict) return sendError(reply, 409, error.message);
      throw error;
    }
  });
  // Keep public previews on the same origin so Web Audio can adjust their gain
  // without CORS silencing. This streams directly; no analysis gates playback.
  app.get<{ Querystring: { url?: string } }>("/api/playback/preview", async (request, reply) => {
    if (!requireUser(db, request, reply)) return;
    const url = request.query.url;
    if (typeof url !== "string" || url.length > 2048 || !isAllowedPreview(url)) return sendError(reply, 400, "Untrusted preview URL");
    const controller = new AbortController();
    const releaseMedia = options.taskManager?.acquireMediaStream();
    if (releaseMedia) {
      reply.raw.once("finish", releaseMedia);
      reply.raw.once("close", releaseMedia);
      reply.raw.once("error", releaseMedia);
    }
    reply.raw.once("close", () => controller.abort());
    try {
      const result = await fetchPreview(url, request.headers.range, controller.signal);
      if (!result.body || ![200, 206, 416].includes(result.status)) {
        await result.body?.cancel();
        releaseMedia?.();
        return sendError(reply, 502, "Preview unavailable");
      }
      const type = result.headers.get("content-type")?.split(";")[0].trim() ?? "";
      reply.code(result.status).header("Cache-Control", "private, no-store")
        .header("Content-Type", /^audio\/[\w.+-]+$/i.test(type) ? type : "application/octet-stream")
        .header("X-Content-Type-Options", "nosniff");
      for (const name of ["content-length", "content-range", "accept-ranges"]) {
        const value = result.headers.get(name);
        if (value) reply.header(name, value);
      }
      let bytes = 0;
      const bounded = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 32 * 1024 * 1024 ? new Error("Preview exceeds size limit") : null, chunk);
      } });
      void pipeline(Readable.fromWeb(result.body as any), bounded, { signal: controller.signal }).catch(error => bounded.destroy(error));
      return reply.send(bounded);
    } catch {
      releaseMedia?.();
      if (!reply.sent) return sendError(reply, 502, "Preview unavailable");
    }
  });

  app.post("/api/playback/normalize", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid playback request");
    const { trackId, source, playableSource, previewUrl, bitRate, background } = parsed.data;
    const target = parsed.data.targetLufs ?? getNormalizationTarget(db, user.id);
    if ((previewUrl && (source || playableSource)) || (source && playableSource)) return sendError(reply, 400, "Choose one audio source");
    const external = Boolean(playableSource && providers.isExternalSource(trackId, playableSource));
    if (external && user.role !== "admin" && !user.externalPlaybackEnabled) return sendError(reply, 403, "External playback is disabled");
    if (previewUrl && !isAllowedPreview(previewUrl)) return sendError(reply, 400, "Untrusted preview URL");
    if (!previewUrl && !playableSource && !library.exists(trackId)) return sendError(reply, 404, "Track not found");
    if (!service) return { status: "unavailable" };
    if (!previewUrl && !external) await library.refreshContentRevision(trackId);
    if (!source && !playableSource && !previewUrl && options.catalog) {
      const track = await options.catalog.getTrack(trackId);
      if (track?.loudness) {
        const { integratedLufs, truePeakDb } = track.loudness;
        return { status: "measured", integratedLufs, truePeakDb,
          gainDb: measuredPlaybackGain({ input_i: integratedLufs, input_tp: truePeakDb }, target) };
      }
    }
    const identity = playbackIdentity(trackId, library.getContentRevision(trackId), source ?? null, playableSource ?? null, previewUrl ?? null);
    // Public CDN previews are already playable directly by every signed-in user.
    // Keep full external streams behind their existing permission, and cap
    // prepared public previews at 30 seconds.
    const load = () => previewUrl ? fetchPreview(previewUrl) : playableSource ? providers.fetchStream(trackId, playableSource) : resolver.fetchStream(trackId, undefined, source);
    return background
      ? service.prepareInBackground(identity, previewUrl ? "preview" : external, load, bitRate, target)
      : service.prepare(identity, previewUrl ? "preview" : external, load, bitRate, target);
  });

  app.get<{ Params: { key: string } }>("/api/playback/normalized/:key", async (request, reply) => {
    const user = requireUser(db, request, reply);
    if (!user) return;
    const cached = await service?.getFile(request.params.key);
    if (!cached) return sendError(reply, 404, "Prepared playback expired");
    if (cached.external && user.role !== "admin" && !user.externalPlaybackEnabled) return sendError(reply, 403, "External playback is disabled");
    reply.header("Content-Type", cached.format === "mp3" ? "audio/mpeg" : "audio/flac").header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-store");
    let start = 0;
    let end = cached.bytes - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) return reply.code(416).header("Content-Range", `bytes */${cached.bytes}`).send();
      if (!match[1]) start = Math.max(0, cached.bytes - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= cached.bytes) return reply.code(416).header("Content-Range", `bytes */${cached.bytes}`).send();
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${cached.bytes}`);
    }
    reply.header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(cached.file, { start, end }));
  });
  app.addHook("onClose", async () => { await Promise.all([options.scan?.close(), service?.close()]); });
}
